#!/usr/bin/env python3
# MIT License

# Copyright (c) 2026 WSU F1TENTH

"""
Publish OS-level robot health as ROS diagnostics.

The problem this solves: CPU load, temperatures, disk, network, and USB device
state are NOT in ROS. Nothing publishes them, so rosbridge cannot carry them and
the dashboard cannot see them. This node reads them from the same places
baseline_capture.sh does and republishes them as a standard DiagnosticArray on
/diagnostics, next to urg_node's and ackermann_mux's entries.

Everything downstream then works for free: the dashboard already accumulates
/diagnostics keyed by status[].name, rqt_robot_monitor renders it, and
diagnostic_aggregator can group it. No new transport, no second port, no
polling endpoint.

    ros2 run ...            # not installed as a package; run it directly:
    python3 system_diagnostics.py

Read-only. No sudo. Safe to run alongside bringup.
"""

import collections
import getpass
import glob
import grp
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

try:
    import rclpy
    from diagnostic_msgs.msg import DiagnosticArray, DiagnosticStatus, KeyValue
    from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
    from rclpy.executors import MultiThreadedExecutor
    from rclpy.node import Node
    from ackermann_msgs.msg import AckermannDriveStamped
    from sensor_msgs.msg import Joy
    from std_msgs.msg import Float64
    from std_srvs.srv import Trigger
except ImportError:
    # --self-test exercises the pure decision logic, which is the part worth
    # checking and the part that has no business needing a sourced ROS install.
    if "--self-test" not in sys.argv:
        raise
    Node = object

OK, WARN, ERROR, STALE = 0, 1, 2, 3

# Thresholds signed off with the professor; the basis for each is in
# dashboard/README.md ("Ranges: what is green, yellow and red"). Measured idle
# values are noted so a change can be checked against them. The VESC FET range is
# judged in the page (FET_WARN / FET_ERR in the page's config.js), the CPU range
# inside cpu().
# Board temperature, C. Idle about 50 C; the board throttles at 70 and 99 C and
# shuts down at 104.5 C.
TJ_WARN, TJ_ERR = 70.0, 85.0
MEM_WARN, MEM_ERR = 20.0, 10.0      # percent available. Idle: 63 to 80 %
DISK_WARN, DISK_ERR = 85.0, 95.0    # percent used. Measured: 4 % on a 915 GB NVMe
GPU_WARN = 95.0                     # percent busy, held for GPU_SUSTAIN_S seconds. No
GPU_SUSTAIN_S = 5                   # red from load alone: a busy GPU is a heavy job
LIDAR_IP = "192.168.0.10"

SLOW_PERIOD = 10.0                  # seconds between expensive probes


def read(path, default=None):
    """
    Read a sysfs file, or return `default`.

    `except OSError` is NOT enough. A sysfs file that returns EAGAIN (the Jetson's
    cv0/1/2 thermal zones do this, transiently, and the set that fails rotates)
    makes the raw layer hand TextIOWrapper a None, and the decoder then fails with
    `TypeError: can't concat NoneType to bytes` - which is not an OSError and
    escaped the handler. That is exactly the error this node reported on the car
    while working fine on a laptop with no such zones.
    """
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        return default


def run(cmd, timeout=4):
    """Never let a hung external command take the node with it."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return p.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


def probe(cmd, timeout=8):
    """
    Like run(), but the caller can tell "tool missing" from "printed nothing".

    joy_enumerate_devices printing zero rows is the whole signal we are after, so
    an absent `ros2` binary must never be allowed to look like zero joysticks.
    """
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode, (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return None, f"timed out after {timeout}s"
    except (FileNotFoundError, OSError) as e:
        return None, str(e)


# Where the Jetson GPU driver exposes its busy fraction, newest board first.
# The file reads 0-1000 (per mille). Orin moved it under bus@0; Nano/TX2/Xavier
# keep the older gpu.0 path. Globbed rather than hardcoded so one script covers
# every car in the fleet.
GPU_LOAD_GLOBS = (
    "/sys/devices/platform/bus@0/*.gpu/load",
    "/sys/devices/platform/*.gpu/load",
    "/sys/devices/platform/gpu.0/load",
    "/sys/devices/gpu.0/load",
    "/sys/devices/*.gpu/load",
)

# devfreq names the GPU after its chip on some boards (gv11b = Xavier,
# ga10b = Orin, gp10b = TX2, gm20b = Nano) and "<addr>.gpu" on others.
GPU_DEVFREQ = re.compile(r"gpu|gv11b|ga10b|gp10b|gm20b")


def find_gpu_files():
    """Return (load_path, cur_freq_path); either may be None off-Jetson."""
    load = next((p for g in GPU_LOAD_GLOBS for p in sorted(glob.glob(g))), None)
    freq = next((f"{d}/cur_freq" for d in sorted(glob.glob("/sys/class/devfreq/*"))
                 if GPU_DEVFREQ.search(os.path.basename(d))
                 and os.path.exists(f"{d}/cur_freq")), None)
    return load, freq


def parse_gr3d(line):
    """
    Parse tegrastats' GPU field into (busy %, MHz or None), or None if absent.

    Seen as `GR3D_FREQ 0%@305` (Nano), `GR3D_FREQ 0%@[305]` (Xavier) and
    `GR3D_FREQ 0%@[305,0]` or bare `GR3D_FREQ 0%` (Orin).
    """
    m = re.search(r"GR3D_FREQ (\d+)%(?:@\[?(\d+))?", line or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)) if m.group(2) else None


def cpu_busy_pct(prev, cur):
    """
    Return busy % between two /proc/stat `cpu` lines' counters, or None.

    iowait counts as idle: a core waiting on the NVMe is not doing work, and
    counting it as busy makes a log flush look like a CPU spike.
    """
    if not prev or not cur or len(prev) < 5 or len(cur) < 5:
        return None
    idle = (cur[3] + cur[4]) - (prev[3] + prev[4])
    total = sum(cur) - sum(prev)
    if total <= 0:
        return None
    return max(0.0, min(100.0, 100.0 * (total - idle) / total))


# ---------- emergency stop ----------
#
# The command mux gives the physical controller priority, so nothing a web
# page publishes can stop a car someone is driving with the pad. Every input
# - pad, web, autonomous - reaches the motor through ONE node, which turns
# the mux output into /commands/motor/* for the VESC. Freezing that node
# (SIGSTOP) cuts all of them at once; this node then holds the motor at 0
# ERPM itself, at 50 Hz, so the VESC actively brakes to a stop and keeps
# getting a command (no firmware timeout). SIGCONT releases it.
#
# Speed 0, not a brake current: the joystick's own release path already
# sends speed 0, and a brake value has units (A vs mA) that differ between
# vesc_driver versions - the wrong guess would be 1000x off.

DRIVE_CHAIN_NODE = "ackermann_to_vesc_node"
ESTOP_HZ = 50.0


def parse_pgrep(out, own_pid):
    """Return the PIDs in `pgrep -f` output, never our own (pgrep -f can match it)."""
    pids = []
    for token in (out or "").split():
        if token.isdigit() and int(token) != own_pid:
            pids.append(int(token))
    return pids


# ---------- disconnecting the controller (Drive tab) ----------
#
# Refused while a deadman is held: cutting /joy mid-drive leaves the motor on
# its last command, because the mux sends no zero when an input goes quiet.

JOY_DEADMEN = (4, 5)               # L1 manual, R1 autonomous - joy_teleop.yaml
JOY_FRESH_S = 1.0
PAD_NAME_RE = re.compile(r"controller|dualshock|dualsense|gamepad", re.IGNORECASE)


def bt_power(show_out):
    """
    Read the Bluetooth adapter state from `bluetoothctl show`.

    Empty output means the tool failed or timed out, which is not the same as
    the radio being off.
    """
    if "Powered: yes" in show_out:
        return "on"
    if "Powered: no" in show_out:
        return "off"
    return "no adapter" if "No default controller" in show_out else "unknown"


def parse_wifi(iw_link, ping_out):
    """
    Read Wi-Fi quality from `iw dev <wl> link` and a short ping to the gateway.

    Signal in dBm, packet loss in %, average round trip in ms. A value that
    could not be read is left out, never guessed.
    """
    out = {}
    m = re.search(r"signal:\s*(-?\d+)\s*dBm", iw_link or "")
    if m:
        out["signal"] = int(m.group(1))
    m = re.search(r"([\d.]+)% packet loss", ping_out or "")
    if m:
        out["loss"] = float(m.group(1))
    m = re.search(r"= [\d.]+/([\d.]+)/", ping_out or "")
    if m:
        out["rtt"] = float(m.group(1))
    return out


# ---------- drive watchdog ----------
#
# The page drives through /drive at 20 Hz. If its Wi-Fi drops mid-drive,
# nothing reaches the car, and ackermann_mux sends no zero of its own when an
# input goes quiet, so the motor would hold its last command until the VESC's
# own timeout. When /drive was commanding motion and then goes quiet, this sends
# zero speed on /drive. A live publisher can never be cut off by it: the mux
# already ignores an input that has been quiet for 0.2 s (mux.yaml).

DRIVE_QUIET_S = 0.3
DRIVE_STOP_COUNT = 5                # zeros sent, one per watchdog tick (20 Hz)
# header.frame_id, so the page and this node can tell the zeros apart
DRIVE_WATCHDOG_FRAME = "drive_watchdog"


def drive_went_quiet(moving, last_at, now, quiet_s=DRIVE_QUIET_S):
    """Return True when /drive was commanding motion and has been silent too long."""
    return moving and now - last_at > quiet_s


def deadman_held(buttons, age_s):
    """Return True if a fresh /joy message has L1 or R1 down; silent /joy = no pad."""
    if buttons is None or age_s > JOY_FRESH_S:
        return False
    return any(i < len(buttons) and buttons[i] == 1 for i in JOY_DEADMEN)


def connected_pads(devices_out, info_for):
    """[(mac, name)] of connected controllers from `bluetoothctl devices` + `info`."""
    return [(mac, name.strip())
            for mac, name in re.findall(r"Device (\S+) (.+)", devices_out or "")
            if PAD_NAME_RE.search(name) and "Connected: yes" in (info_for(mac) or "")]


def parse_joy_devices(out):
    """
    Pull "<id>: <name>" out of joy_enumerate_devices' table.

    Confirmed on robot #2, 2026-09-16 - colon-separated, one header row, one rule:

        ID : GUID                             : GamePad : Mapped : Joystick Device Name
        ---------------------------------------------------------------------------
         0 : 050000004c050000c405000000010000 :    true :   true : PS4 Controller

    Only rows whose first field is a number are devices, which drops the header
    and the rule without having to recognise either of them.
    """
    devices = []
    for line in out.splitlines():
        fields = [f.strip() for f in line.split(":")]
        if len(fields) >= 2 and fields[0].isdigit():
            devices.append(f"{fields[0]}: {fields[-1]}")
    return devices


def in_input_group():
    try:
        return grp.getgrnam("input").gr_gid in os.getgroups()
    except KeyError:
        return False


def joy_verdict(rc, out, devices, connected, in_group):
    """
    Turn the joystick evidence into (usable_by_ros, human-readable report).

    Pure so it can be asserted without a robot: `python3 system_diagnostics.py
    --self-test`. The interesting row is (0 devices, pad connected) - the seat-ACL
    trap, where everything else on the page says the controller is fine and only
    ROS cannot read it. Before this check that state was indistinguishable from
    "nobody plugged a controller in".
    """
    if rc is None:
        return False, "could not run joy_enumerate_devices: " + out

    grp_note = "yes" if in_group else "NO  <- this is almost certainly the problem"
    lines = [
        f"{'joy_enumerate_devices:':<30}{len(devices)} device(s)"
        + (" -> " + "; ".join(devices) if devices else ""),
        f"{'bluetooth connected:':<30}{'yes' if connected else 'no'}",
        f"{'`input` group (this process):':<30}{grp_note}",
    ]

    # The verdict always carries what the command actually printed. The table
    # format is confirmed (robot #2, 2026-09-16) but it is a human-facing CLI
    # table, not an API, and a future column would make the parser wrong silently.
    # Side by side, a parser miss reads as a disagreement instead of a verdict.
    raw = ["", "raw output:"] + ["  " + ln for ln in (out.splitlines() or ["(nothing printed)"])]

    if devices:
        if connected:
            return True, "\n".join(lines + [
                "", "OK - SDL can open the device, so /joy will publish as soon as",
                "the pad sends events."] + raw)
        return True, "\n".join(lines + [
            "", "A joystick is readable but no Bluetooth link is up - a wired pad,",
            "or some other device SDL counts as a joystick."] + raw)

    if connected:
        return False, "\n".join(lines + [
            "",
            "CONTRADICTION: the pad is paired and connected, but SDL cannot open it.",
            "`joy` on Humble reads /dev/input/event*, not js0, and that node is 0660",
            "root:input. Over NoMachine the logind uaccess ACL goes to gdm, never to",
            "you, so /joy stays silent on a working controller.",
            "",
            "Fix:  sudo usermod -aG input $USER    then log out and back in",
            "      (already-open shells keep the old groups, bringup included)",
        ] + raw)

    return False, "\n".join(lines + [
        "", "No controller is connected. Pair one, then run this again - a silent",
        "/joy is expected in this state and is not a fault.",
    ] + raw)


def status(name, level, message, values, hardware_id=""):
    s = DiagnosticStatus()
    s.name = name
    s.level = bytes([level])
    s.message = message
    s.hardware_id = hardware_id
    s.values = [KeyValue(key=str(k), value=str(v)) for k, v in values]
    return s


def worst(*levels):
    return max(levels) if levels else OK


class SystemDiagnostics(Node):
    def __init__(self):
        super().__init__("system_diagnostics")
        self.pub = self.create_publisher(DiagnosticArray, "/diagnostics", 10)
        self.ncores = os.cpu_count() or 1
        self.gpu_load_path, self.gpu_freq_path = find_gpu_files()
        self._cpu_prev = None
        self._gpu_recent = collections.deque(maxlen=GPU_SUSTAIN_S)
        self.joy_enum = next((p for p in (
            os.path.join(prefix, "lib", "joy", "joy_enumerate_devices")
            for prefix in os.environ.get("AMENT_PREFIX_PATH", "").split(":") if prefix)
            if os.access(p, os.X_OK)), None)

        # Filled by the background thread. Until it has run once these report
        # STALE rather than a fabricated OK - an unmeasured subsystem is
        # `unknown`, which is the fourth state the spike insists on.
        self.slow = {}
        self.slow_lock = threading.Lock()
        threading.Thread(target=self._slow_loop, daemon=True).start()

        self.create_timer(1.0, self.tick)

        # On-demand checks live behind a service, not the 1 Hz loop: this one
        # shells out to `ros2 run`, which is far too slow to run on a clock. Its
        # own callback group + a MultiThreadedExecutor keep the several seconds it
        # blocks for off the publish timer - otherwise the whole dashboard would
        # go stale while the check runs and look like a robot fault.
        self.create_service(Trigger, "~/joystick_check", self.joystick_check,
                            callback_group=MutuallyExclusiveCallbackGroup())

        # Emergency stop. Own callback group so a slow joystick check can never
        # delay it; the 50 Hz hold timer shares it so stop/release/hold never
        # interleave.
        self.estop_active = False
        self.estop_since = None
        self.estop_pids = []
        self.estop_note = ""
        estop_group = MutuallyExclusiveCallbackGroup()
        self.motor_pub = self.create_publisher(Float64, "/commands/motor/speed", 10)
        self.create_service(Trigger, "~/emergency_stop", self.emergency_stop,
                            callback_group=estop_group)
        self.create_service(Trigger, "~/emergency_release", self.emergency_release,
                            callback_group=estop_group)
        self.create_timer(1.0 / ESTOP_HZ, self.estop_hold, callback_group=estop_group)

        # Disconnecting the controller. Needs the deadman state, so watch /joy;
        # bluetoothctl can take seconds, so its own group.
        self.joy_buttons = None
        self.joy_at = 0.0
        self.create_subscription(Joy, "/joy", self.on_joy, 10)
        self.create_service(Trigger, "~/controller_disconnect", self.controller_disconnect,
                            callback_group=MutuallyExclusiveCallbackGroup())

        # Drive watchdog: zero speed when /drive goes quiet mid-drive.
        self.drive_moving = False
        self.drive_speed = 0.0
        self.drive_at = 0.0
        self.drive_zeros_left = 0
        self.drive_stopped = None       # (wall time, speed) of the last stop
        self.drive_pub = self.create_publisher(AckermannDriveStamped, "/drive", 10)
        self.create_subscription(AckermannDriveStamped, "/drive", self.on_drive, 10,
                                 callback_group=estop_group)
        self.create_timer(1.0 / 20, self.drive_watchdog, callback_group=estop_group)

        self.get_logger().info(
            f"publishing system diagnostics on /diagnostics ({self.ncores} cores); "
            "services ~/joystick_check, ~/emergency_stop, ~/emergency_release, "
            "~/controller_disconnect ready")

    # ---------- on-demand checks, called from the dashboard ----------

    def joystick_check(self, _request, response):
        """
        Answer "why is /joy silent?" - the one question /joy itself cannot.

        A silent /joy has three causes that look identical on the topic: no pad,
        a sleeping pad, and a pad that ROS has no permission to open. Only
        joy_enumerate_devices separates the third, and it is the expensive one to
        run, which is what makes it a button rather than a tile.
        """
        # Run the binary directly, as the slow loop does. `ros2 run` starts the
        # ros2 command-line tool first, which is slow on the Jetson the first time
        # after a bringup: the first click on 2026-10-14 ran past the page's 12s
        # and showed "timeout" although the robot answered. 8s: the page allows
        # 12s, so this must fail first and say so.
        cmd = [self.joy_enum] if self.joy_enum else ["ros2", "run", "joy", "joy_enumerate_devices"]
        started = time.time()
        rc, out = probe(cmd, timeout=8)
        devices = parse_joy_devices(out)
        pad = self._slow_get("pad") or {}
        response.success, response.message = joy_verdict(
            rc, out, devices, bool(pad.get("connected")), in_input_group())
        self.get_logger().info(f"joystick_check: {len(devices)} device(s), "
                               f"success={response.success}, took {time.time() - started:.1f}s")
        return response

    # ---------- disconnecting the controller ----------

    def on_joy(self, msg):
        self.joy_buttons = list(msg.buttons)
        self.joy_at = time.time()

    def controller_disconnect(self, _request, response):
        """
        Drop the pad's Bluetooth link.

        Refused while L1/R1 is held, unless the e-stop is on (then nothing the
        pad sends can move the car).
        """
        if not self.estop_active and deadman_held(self.joy_buttons,
                                                  time.time() - self.joy_at):
            response.success = False
            response.message = "someone is holding L1/R1 - let go first, or press E-STOP"
            return response
        _rc, devices = probe(["bluetoothctl", "devices"], timeout=5)
        pads = connected_pads(devices,
                              lambda m: probe(["bluetoothctl", "info", m], timeout=5)[1])
        if not pads:
            response.success, response.message = False, "no controller is connected"
            return response
        done, failed = [], []
        for mac, name in pads:
            rc, out = probe(["bluetoothctl", "disconnect", mac], timeout=8)
            if rc == 0 and "successful" in out.lower():
                done.append(name)
            else:
                failed.append(f"{name} ({out.splitlines()[-1] if out else rc})")
        parts = ([f"disconnected {', '.join(done)}"] if done else []) + \
                ([f"failed: {', '.join(failed)}"] if failed else [])
        response.success, response.message = bool(done) and not failed, "; ".join(parts)
        self.get_logger().warn(f"controller_disconnect: {response.message}")
        return response

    # ---------- emergency stop ----------

    def emergency_stop(self, _request, response):
        """Stop the car whoever is driving it, and keep it stopped."""
        rc, out = probe(["pgrep", "-f", DRIVE_CHAIN_NODE], timeout=3)
        pids = parse_pgrep(out if rc == 0 else "", os.getpid())
        frozen, failed = [], []
        for pid in pids:
            try:
                os.kill(pid, signal.SIGSTOP)
                frozen.append(pid)
            except OSError as e:
                failed.append(f"{pid} ({e.strerror})")

        # Even if nothing could be frozen, holding speed 0 at 50 Hz still wins
        # most of the time against a ~50 Hz driver - say so honestly.
        self.estop_active = True
        self.estop_since = self.estop_since or time.time()
        self.estop_pids = sorted(set(self.estop_pids) | set(frozen))
        if frozen:
            self.estop_note = f"froze {DRIVE_CHAIN_NODE} (pid {', '.join(map(str, frozen))})"
        else:
            self.estop_note = (f"could not find or freeze {DRIVE_CHAIN_NODE}"
                               + (f": {', '.join(failed)}" if failed else "")
                               + " - holding speed 0 only, the controller may still fight it")
        self.estop_hold()
        self.get_logger().warn(f"EMERGENCY STOP: {self.estop_note}")
        response.success = bool(frozen)
        response.message = self.estop_note
        return response

    def emergency_release(self, _request, response):
        """
        Let the drive chain run again.

        Refused while L1/R1 is held, here as well as on the page: a second tab
        or a direct service call skips the page's check, and the car would
        resume straight into a live command.
        """
        if not self.estop_active:
            response.success, response.message = True, "emergency stop was not active"
            return response
        if deadman_held(self.joy_buttons, time.time() - self.joy_at):
            response.success = False
            response.message = "someone is holding L1/R1 - let go first"
            return response
        resumed, gone = [], []
        for pid in self.estop_pids:
            try:
                os.kill(pid, signal.SIGCONT)
                resumed.append(pid)
            except OSError:
                gone.append(pid)
        self.estop_active = False
        self.estop_since = None
        self.estop_pids = []
        self.estop_note = ""
        msg = f"released; resumed pid {', '.join(map(str, resumed)) or 'none'}"
        if gone:
            msg += f" (gone: {', '.join(map(str, gone))} - restart bringup)"
        self.get_logger().warn(f"emergency stop {msg}")
        response.success, response.message = True, msg
        return response

    def estop_hold(self):
        if self.estop_active:
            m = Float64()
            m.data = 0.0
            self.motor_pub.publish(m)

    # ---------- drive watchdog ----------

    def on_drive(self, msg):
        if msg.header.frame_id == DRIVE_WATCHDOG_FRAME:
            return                      # our own zeros coming back
        self.drive_at = time.monotonic()
        self.drive_speed = msg.drive.speed
        self.drive_moving = abs(msg.drive.speed) > 1e-3
        self.drive_zeros_left = 0

    def drive_watchdog(self):
        if self.drive_zeros_left:
            self.drive_zeros_left -= 1
        elif drive_went_quiet(self.drive_moving, self.drive_at, time.monotonic()):
            self.drive_moving = False
            self.drive_zeros_left = DRIVE_STOP_COUNT - 1
            self.drive_stopped = (time.time(), self.drive_speed)
            self.get_logger().warn(
                f"drive watchdog: /drive went quiet at {self.drive_speed:.2f} m/s, "
                "sending zero speed")
        else:
            return
        zero = AckermannDriveStamped()
        zero.header.stamp = self.get_clock().now().to_msg()
        zero.header.frame_id = DRIVE_WATCHDOG_FRAME
        self.drive_pub.publish(zero)

    def drive_status(self):
        vals = [("stops after", f"{DRIVE_QUIET_S:.1f} s of silence while moving")]
        if self.drive_stopped and time.time() - self.drive_stopped[0] < 60:
            at = time.strftime("%H:%M:%S", time.localtime(self.drive_stopped[0]))
            return status("system: Drive watchdog", WARN,
                          f"stopped the car at {at}: /drive went quiet at "
                          f"{self.drive_stopped[1]:.2f} m/s", vals)
        return status("system: Drive watchdog", OK, "watching /drive", vals)

    def estop_status(self):
        if not self.estop_active:
            return status("system: E-stop", OK, "released", [("active", "no")])
        since = time.strftime("%H:%M:%S", time.localtime(self.estop_since))
        return status("system: E-stop", ERROR, f"EMERGENCY STOP ACTIVE since {since}",
                      [("active", "yes"), ("since", since), ("action", self.estop_note),
                       ("frozen pids", ", ".join(map(str, self.estop_pids)) or "none")])

    # ---------- fast probes: pure sysfs reads, safe at 1 Hz ----------

    def thermal(self):
        vals, temps, unreadable = [], {}, []
        base = "/sys/devices/virtual/thermal"
        for zone in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            if not zone.startswith("thermal_zone"):
                continue
            raw = read(f"{base}/{zone}/temp")
            kind = read(f"{base}/{zone}/type", zone)
            # Some Jetson zones (cv0/1/2) return EAGAIN transiently and the set
            # that fails rotates, so never blacklist them - just skip this pass.
            if raw is None or not re.fullmatch(r"-?\d+", raw or ""):
                unreadable.append(kind)
                continue
            c = int(raw) / 1000.0
            temps[kind] = c
            vals.append((kind, f"{c:.1f} C"))
        if unreadable:
            vals.append(("unreadable this pass", ", ".join(unreadable)))
        if not temps:
            return status("system: Thermal", STALE, "no readable thermal zones", vals)

        # tj-thermal is the Jetson's junction temperature and is the one #1's
        # S-05 asks for. On any other board it does not exist, and reporting the
        # hottest zone as "junction" would be a confident wrong label.
        if "tj-thermal" in temps:
            tj, label = temps["tj-thermal"], "junction"
        else:
            hottest = max(temps, key=temps.get)
            tj, label = temps[hottest], f"hottest zone ({hottest})"
        lvl = ERROR if tj >= TJ_ERR else WARN if tj >= TJ_WARN else OK
        return status("system: Thermal", lvl, f"{label} {tj:.1f} C", vals)

    def cpu(self):
        load = (read("/proc/loadavg") or "0 0 0").split()
        l1 = float(load[0]) if load else 0.0
        lvl = ERROR if l1 > self.ncores * 2 else WARN if l1 > self.ncores else OK
        vals = [("cores", self.ncores), ("load 1m", load[0]),
                ("load 5m", load[1] if len(load) > 1 else "?"),
                ("load 15m", load[2] if len(load) > 2 else "?")]
        # Utilisation over the last tick, from /proc/stat deltas. Load average
        # lags by a minute and counts blocked tasks; this is what "the CPU is
        # pegged" actually means right now.
        first = (read("/proc/stat") or "").split("\n", 1)[0].split()
        cur = [int(x) for x in first[1:] if x.isdigit()] if first[:1] == ["cpu"] else None
        busy = cpu_busy_pct(self._cpu_prev, cur)
        self._cpu_prev = cur
        if busy is not None:
            vals.append(("usage %", f"{busy:.1f}"))
        return status("system: CPU", lvl, f"load {l1:.2f} over {self.ncores} cores", vals)

    def gpu(self):
        """
        Report the Jetson GPU's busy %.

        sysfs first (1 Hz, no subprocess); tegrastats' GR3D_FREQ from the slow
        loop only if the driver file is not there.
        """
        vals, pct, source = [], None, None
        raw = read(self.gpu_load_path) if self.gpu_load_path else None
        if raw is not None and raw.isdigit():
            pct, source = int(raw) / 10.0, self.gpu_load_path
        else:
            gr3d = self._slow_get("gr3d")
            if gr3d:
                pct, source = float(gr3d[0]), "tegrastats"
                if gr3d[1]:
                    vals.append(("freq", f"{gr3d[1]} MHz"))
        if pct is None:
            return status("system: GPU", STALE,
                          "no GPU load source (not a Jetson, or tegrastats missing)",
                          [("searched", ", ".join(GPU_LOAD_GLOBS))])
        hz = read(self.gpu_freq_path) if self.gpu_freq_path else None
        if hz and hz.isdigit() and not any(k == "freq" for k, _ in vals):
            vals.append(("freq", f"{int(hz) / 1e6:.0f} MHz"))
        vals += [("usage %", f"{pct:.1f}"), ("source", source)]
        # one sample per tick (1 Hz): yellow only once it has stayed high
        self._gpu_recent.append(pct)
        held = (len(self._gpu_recent) == self._gpu_recent.maxlen
                and min(self._gpu_recent) >= GPU_WARN)
        return status("system: GPU", WARN if held else OK,
                      f"{pct:.0f}% busy" + (f" for {GPU_SUSTAIN_S} s" if held else ""), vals)

    def memory(self):
        info = {}
        for line in (read("/proc/meminfo") or "").splitlines():
            k, _, v = line.partition(":")
            info[k] = int(v.split()[0]) if v.split() and v.split()[0].isdigit() else 0
        total, avail = info.get("MemTotal", 0), info.get("MemAvailable", 0)
        if not total:
            return status("system: Memory", STALE, "/proc/meminfo unreadable", [])
        pct = 100.0 * avail / total
        lvl = ERROR if pct < MEM_ERR else WARN if pct < MEM_WARN else OK
        swap_t, swap_f = info.get("SwapTotal", 0), info.get("SwapFree", 0)
        return status("system: Memory", lvl, f"{pct:.0f}% available",
                      [("total", "%.2f GB" % (total / 1048576.0)),
                       ("available", "%.2f GB" % (avail / 1048576.0)),
                       ("available %", f"{pct:.1f}"),
                       ("swap used", "%.2f GB" % ((swap_t - swap_f) / 1048576.0))])

    def storage(self):
        try:
            u = shutil.disk_usage("/")
        except OSError:
            return status("system: Storage", STALE, "df failed", [])
        pct = 100.0 * u.used / u.total if u.total else 0.0
        lvl = ERROR if pct > DISK_ERR else WARN if pct > DISK_WARN else OK
        return status("system: Storage", lvl, f"{pct:.0f}% of / used",
                      [("total", "%.0f GB" % (u.total / 1e9)),
                       ("used", "%.0f GB" % (u.used / 1e9)),
                       ("free", "%.0f GB" % (u.free / 1e9)),
                       ("used %", f"{pct:.1f}")])

    def power(self):
        """
        Report uptime, the brownout detector (S-02).

        If it goes backwards between two samples the board rebooted, and on
        this car that means the pack.
        """
        up = float((read("/proc/uptime") or "0").split()[0])
        vals = [("uptime", f"{up:.0f} s")]
        lvl, msg = OK, f"up {up:.0f} s"
        prev = getattr(self, "_last_uptime", None)
        if prev is not None and up < prev:
            lvl, msg = ERROR, "REBOOTED - uptime went backwards (brownout?)"
            self._reboot_seen = time.time()
        self._last_uptime = up
        if getattr(self, "_reboot_seen", 0):
            vals.append(("last reboot detected",
                         time.strftime("%H:%M:%S", time.localtime(self._reboot_seen))))
            lvl = worst(lvl, WARN)
        with self.slow_lock:
            rails = self.slow.get("rails")
        if rails:
            vals += list(rails.items())
        return status("system: Power", lvl, msg, vals)

    def vesc_device(self):
        """
        Check the VESC's serial device node exists (S-09).

        That is separate from the topic flowing; this catches an unplugged VESC
        before the topic even goes silent.
        """
        path = "/dev/sensors/vesc"
        if os.path.exists(path):
            return status("system: VESC device", OK, "present",
                          [("path", path),
                           ("resolves to", os.path.realpath(path))])
        alt = sorted(p for p in os.listdir("/dev") if p.startswith("ttyACM"))
        return status("system: VESC device", ERROR,
                      "/dev/sensors/vesc missing",
                      [("ttyACM* present", ", ".join(alt) or "none")])

    # ---------- slow probes: subprocesses, once every SLOW_PERIOD ----------

    def _slow_loop(self):
        while True:
            try:
                self._probe_slow()
            # never let this thread die
            except Exception as e:  # noqa: BLE001
                self.get_logger().warn(f"slow probe failed: {e}")
            time.sleep(SLOW_PERIOD)

    def _probe_slow(self):
        out = {}

        # Power rails, S-02. tegrastats needs no sudo on this image.
        line = run(["timeout", "2", "tegrastats", "--interval", "500"], timeout=4)
        first = line.splitlines()[0] if line.splitlines() else ""
        rails = dict(re.findall(r"(VDD_\w+)\s+(\d+)mW", first))
        if rails:
            out["rails"] = {k: f"{v} mW" for k, v in rails.items()}
        # GPU fallback for boards where the sysfs load file is missing.
        gr3d = parse_gr3d(first)
        if gr3d:
            out["gr3d"] = gr3d

        # Lidar link, S-17.
        ping = run(["ping", "-c", "2", "-W", "2", LIDAR_IP], timeout=8)
        m = re.search(r"= [\d.]+/([\d.]+)/", ping)
        out["lidar"] = {"reachable": "1 received" in ping or "2 received" in ping,
                        "rtt_ms": m.group(1) if m else "?"}

        # Interfaces, S-17.
        nets = {}
        for n in sorted(os.listdir("/sys/class/net")):
            if n == "lo":
                continue
            nets[n] = {"carrier": read(f"/sys/class/net/{n}/carrier", "?"),
                       "operstate": read(f"/sys/class/net/{n}/operstate", "?")}
        out["nets"] = nets

        # Wi-Fi quality (#6). Ping the gateway, not the internet: the robot
        # needs no internet, so an outside outage must not read as a robot
        # fault. A short burst with a hard timeout, so it never stalls the loop.
        wl = next((n for n in nets if n.startswith("wl")), None)
        if wl:
            route = run(["ip", "route", "show", "default"], timeout=3)
            gw = re.search(r"default via (\S+)", route)
            ping_gw = run(["ping", "-c", "5", "-i", "0.2", "-W", "1", gw.group(1)],
                          timeout=5) if gw else ""
            out["wifi"] = parse_wifi(run(["iw", "dev", wl, "link"], timeout=3), ping_gw)
            if gw:
                out["wifi"]["gateway"] = gw.group(1)

        # Gamepad, S-03 / S-18.
        # glob, not listdir: no /dev/input (a container, a board with no USB
        # input) means no controller, not a failed probe that loses every
        # slow reading after it
        pad = {"js": sorted(os.path.basename(p) for p in glob.glob("/dev/input/js*"))}
        devices = run(["bluetoothctl", "devices"], timeout=5)
        for mac, name in re.findall(r"Device (\S+) (.+)", devices):
            info = run(["bluetoothctl", "info", mac], timeout=5)
            if "Connected: yes" in info:
                pad["mac"], pad["name"] = mac, name.strip()
                pad["connected"] = True
                b = re.search(r"Battery Percentage:.*\((\d+)\)", info)
                if b:
                    pad["battery"] = b.group(1)
                break
        else:
            pad["connected"] = False
        # Second path to the charge level, in case hid-sony ever binds. Match
        # the entry to THIS pad - a bare "first power_supply with a capacity"
        # happily reports an unrelated device (a wireless mouse, on the machine
        # this was tested on) as the controller's battery.
        mac_tag = pad.get("mac", "").lower().replace(":", "_")
        try:
            supplies = sorted(os.listdir("/sys/class/power_supply"))
        except OSError:
            supplies = []
        for entry in supplies:
            e = entry.lower()
            if not (e.startswith(("sony_controller_battery", "ps_controller_battery"))
                    or (mac_tag and mac_tag in e)):
                continue
            cap = read(f"/sys/class/power_supply/{entry}/capacity")
            if cap is not None:
                pad.setdefault("battery", cap)
                pad["battery_source"] = entry
                break
        # A pad that is attached but that ROS cannot open (#6: red). Same check
        # as the joystick check button, run directly rather than through
        # `ros2 run`, and only while a pad is attached.
        if pad["js"] and self.joy_enum:
            rc, enum = probe([self.joy_enum], timeout=5)
            if rc == 0 and enum.strip():
                pad["readable"] = bool(parse_joy_devices(enum))
        out["pad"] = pad
        # An adapter switched off is the one reason a pad cannot pair at all.
        out["bt_power"] = bt_power(run(["bluetoothctl", "show"], timeout=5))

        # Camera, S-14. Presence and link speed, independent of whether the ROS
        # node is running - which is the whole point, since it is not in bringup.
        cam = {"present": False}
        for dev in sorted(os.listdir("/sys/bus/usb/devices")):
            vid = read(f"/sys/bus/usb/devices/{dev}/idVendor")
            if vid != "8086":
                continue
            cam = {"present": True,
                   "speed": read(f"/sys/bus/usb/devices/{dev}/speed", "?"),
                   "product": read(f"/sys/bus/usb/devices/{dev}/product", "?"),
                   "serial": read(f"/sys/bus/usb/devices/{dev}/serial", "?"),
                   "port": dev}
            break
        out["camera"] = cam

        # Clock, S-08.
        td = run(["timedatectl", "show"], timeout=4)
        out["clock"] = dict(re.findall(r"^(\w+)=(.*)$", td, re.MULTILINE))

        with self.slow_lock:
            self.slow.update(out)

    # ---------- statuses built from the slow probe's results ----------

    def _slow_get(self, key):
        with self.slow_lock:
            return self.slow.get(key)

    def network(self):
        nets, lidar = self._slow_get("nets"), self._slow_get("lidar")
        if nets is None:
            return status("system: Network", STALE, "not probed yet", [])
        vals = [(n, f"carrier={d['carrier']} {d['operstate']}")
                for n, d in nets.items()]
        up = [n for n, d in nets.items() if d["carrier"] == "1"]
        lvl, msg = OK, f"{len(up)} link{'' if len(up) == 1 else 's'} up"
        if lidar:
            vals.append((f"lidar {LIDAR_IP}",
                         f"reachable, {lidar['rtt_ms']} ms" if lidar["reachable"]
                         else "NO REPLY"))
            if not lidar["reachable"]:
                lvl, msg = ERROR, f"lidar unreachable at {LIDAR_IP}"
        wifi = self._slow_get("wifi") or {}
        for key, label in (("signal", "wifi signal"), ("loss", "wifi loss %"),
                           ("rtt", "wifi rtt ms"), ("gateway", "wifi gateway")):
            if key in wifi:
                vals.append((label, str(wifi[key])))
        if self._slow_get("bt_power"):
            vals.append(("bluetooth", self._slow_get("bt_power")))
        if not up:
            lvl, msg = ERROR, "no interface has carrier"
        return status("system: Network", lvl, msg, vals)

    def gamepad(self):
        pad = self._slow_get("pad")
        if pad is None:
            return status("system: Gamepad", STALE, "not probed yet", [])
        # /dev/input/js* disappears the moment the pad disconnects, and listing a
        # directory is cheap enough to do here at 1 Hz. bluetoothctl, which names the
        # device, only runs every SLOW_PERIOD, so relying on it alone left this tile
        # reading `connected` for up to 10 s after the link had gone. Measured on the
        # car during the block D e-stop runs: /joy went IDLE instantly while this
        # tile lagged a full probe cycle. S-03 depends on this tile to tell "the
        # operator let go" from "the operator lost the car", so it has to be prompt.
        try:
            js = sorted(p for p in os.listdir("/dev/input") if p.startswith("js"))
        except OSError:
            js = []
        vals = [("js devices", ", ".join(js) or "none"),
                ("bluetooth", "connected" if pad["connected"] else "not connected")]
        if pad.get("name"):
            vals.append(("device", f"{pad['name']} ({pad.get('mac', '?')})"))
        if pad.get("battery"):
            vals.append(("battery %", pad["battery"]))
            vals.append(("battery source", pad.get("battery_source", "bluetoothctl")))
        else:
            # Measured twice: this kernel binds hid-generic, not hid-sony, so no
            # power_supply entry appears even with the pad connected. Say so
            # rather than showing a blank field that looks like a bug.
            vals.append(("battery %", "not exposed by this driver"))
        if js and pad.get("readable") is False:
            return status("system: Gamepad", ERROR,
                          "connected, but ROS cannot read it - add the user to the input group",
                          vals)
        if pad["connected"] and js:
            return status("system: Gamepad", OK, "connected", vals)
        if js:
            # Also the normal state for the first few seconds after connecting,
            # while the bluetoothctl probe catches up.
            return status("system: Gamepad", WARN, "js device but no BT link", vals)
        # #6: no controller is idle, not a fault. The Drive tab still warns
        # that there is no backup stop.
        return status("system: Gamepad", OK, "no controller connected", vals)

    def camera(self):
        cam = self._slow_get("camera")
        if cam is None:
            return status("system: Camera", STALE, "not probed yet", [])
        if not cam["present"]:
            return status("system: Camera", ERROR, "no Intel camera on USB",
                          [("vendor 8086", "not found")])
        speed = cam.get("speed", "?")
        # Deliberately labelled "usb serial": on this D435i the USB iSerial
        # (327743063048) does NOT match what librealsense reports as the device
        # serial (317622075395). Calling either one "the serial number" invites
        # someone to match them and conclude the wrong camera is plugged in.
        vals = [("product", cam.get("product", "?")),
                ("usb serial", cam.get("serial", "?")),
                ("usb port", cam.get("port", "?")),
                ("link speed", f"{speed} M")]
        # 480M is the silent degradation this check exists to catch: the camera
        # works, publishes, and quietly runs at a fraction of its bandwidth.
        if speed == "5000" or (speed.isdigit() and int(speed) >= 5000):
            return status("system: Camera", OK, f"USB3 at {speed} M", vals,
                          cam.get("serial", ""))
        return status("system: Camera", WARN,
                      f"enumerated at {speed} M - expected 5000", vals,
                      cam.get("serial", ""))

    def clock(self):
        # getpass.getuser() reads LOGNAME/USER first, falling back to the pwd
        # database - unlike os.getlogin() it works fine with no controlling
        # tty, which matters since this runs as a background ROS node.
        robot = getpass.getuser()
        c = self._slow_get("clock")
        if c is None:
            return status("system: Clock", STALE, "not probed yet",
                          [("Robot", robot)])
        synced = c.get("NTPSynchronized", "no") == "yes"
        return status("system: Clock", OK if synced else WARN,
                      "NTP synchronised" if synced else "clock NOT synchronised",
                      [("Robot", robot),
                       ("NTPSynchronized", c.get("NTPSynchronized", "?")),
                       ("Timezone", c.get("Timezone", "?")),
                       ("NTP", c.get("NTP", "?"))])

    # ---------- publish ----------

    def tick(self):
        msg = DiagnosticArray()
        msg.header.stamp = self.get_clock().now().to_msg()
        for build in (self.estop_status, self.drive_status, self.thermal, self.cpu, self.gpu,
                      self.memory, self.storage, self.power, self.vesc_device,
                      self.network, self.gamepad, self.camera, self.clock):
            try:
                msg.status.append(build())
            except Exception as e:  # noqa: BLE001
                line = getattr(getattr(e, "__traceback__", None), "tb_lineno", "?")
                msg.status.append(status(
                    f"system: {build.__name__.title()}", ERROR,
                    f"{type(e).__name__} at line {line}: {e}",
                    [("probe", build.__name__), ("exception", type(e).__name__),
                     ("line", line), ("detail", str(e))]))
        self.pub.publish(msg)


# Captured verbatim from robot #2 on 2026-09-16.
JOY_SAMPLE = """\
ID : GUID                             : GamePad : Mapped : Joystick Device Name
-------------------------------------------------------------------------------
 0 : 050000004c050000c405000000010000 :    true :   true : PS4 Controller"""


def self_test():
    """`python3 system_diagnostics.py --self-test` - no ROS, no robot, no hardware."""
    # The header and the rule are not devices, and the name is the last field,
    # not the whole row.
    assert parse_joy_devices(JOY_SAMPLE) == ["0: PS4 Controller"], parse_joy_devices(JOY_SAMPLE)
    header = JOY_SAMPLE.rsplit("\n", 1)[0]
    assert parse_joy_devices(header) == [], "the header alone must read as zero devices"
    assert parse_joy_devices("") == []

    devices = parse_joy_devices(JOY_SAMPLE)
    ok, msg = joy_verdict(0, JOY_SAMPLE, devices, True, True)
    assert ok and "OK -" in msg, msg
    assert "0: PS4 Controller" in msg and "050000004c05" not in msg.split("raw output:")[0], msg

    ok, msg = joy_verdict(0, "", [], True, False)
    assert not ok, msg
    assert "CONTRADICTION" in msg and "usermod -aG input" in msg, msg

    ok, msg = joy_verdict(0, "", [], False, True)
    assert not ok and "No controller is connected" in msg, msg
    assert "CONTRADICTION" not in msg, "a missing pad must not be reported as a permission fault"

    ok, msg = joy_verdict(None, "No such file or directory: 'ros2'", [], True, True)
    assert not ok and "could not run" in msg, msg

    # Every verdict has to carry what the command actually printed, so a parser
    # that misreads an unfamiliar output format shows up as a visible
    # disagreement instead of a confident wrong answer.
    for args in ((0, JOY_SAMPLE, devices, True, True), (0, header, [], True, False),
                 (0, header, [], False, True)):
        body = joy_verdict(*args)[1]
        assert "raw output:" in body, body
    assert "PS4 Controller" in joy_verdict(0, JOY_SAMPLE, [], False, True)[1], \
        "the raw table must survive even when the parser found nothing in it"

    print("joy_verdict self-test passed")

    # tegrastats GPU field, one sample per board generation's format.
    assert parse_gr3d("RAM 1/3 GR3D_FREQ 0%@305 EMC") == (0, 305)
    assert parse_gr3d("GR3D_FREQ 42%@[1377] VIC") == (42, 1377)
    assert parse_gr3d("GR3D_FREQ 7%@[305,0] APE") == (7, 305)
    assert parse_gr3d("GR3D_FREQ 13% cpu@50C") == (13, None)
    assert parse_gr3d("RAM 1/3 no gpu field") is None

    # /proc/stat: user nice system idle iowait irq softirq steal
    a = [100, 0, 100, 700, 100, 0, 0, 0]
    b = [150, 0, 150, 750, 150, 0, 0, 0]      # 100 busy of 200 -> 50 %
    assert cpu_busy_pct(a, b) == 50.0, cpu_busy_pct(a, b)
    assert cpu_busy_pct(None, b) is None and cpu_busy_pct(a, a) is None
    print("gpu/cpu parser self-test passed")

    # pgrep -f can match the diagnostics node itself; it must never be frozen
    assert parse_pgrep("1234\n5678\n", 5678) == [1234]
    assert parse_pgrep("", 1) == [] and parse_pgrep(None, 1) == []
    assert parse_pgrep("12 junk 34", 0) == [12, 34]
    print("e-stop pid self-test passed")

    # controller disconnect: only connected controllers, never while a fresh
    # /joy says a deadman is down
    devs = ("Device AA:BB:CC:DD:EE:FF Wireless Controller\n"
            "Device 11:22:33:44:55:66 Mouse\nDevice 22:33:44:55:66:77 Wireless Controller\n")
    info = {"AA:BB:CC:DD:EE:FF": "Connected: yes", "11:22:33:44:55:66": "Connected: yes",
            "22:33:44:55:66:77": "Connected: no"}
    assert connected_pads(devs, info.get) == [("AA:BB:CC:DD:EE:FF", "Wireless Controller")]
    assert connected_pads(None, info.get) == []
    held = [0, 0, 0, 0, 1, 0]
    assert deadman_held(held, 0.1) and deadman_held([0] * 5 + [1], 0.1)
    assert bt_power("Controller AA (public)\n\tPowered: yes\n") == "on"
    assert bt_power("\tPowered: no\n") == "off"
    assert bt_power("No default controller available\n") == "no adapter"
    assert bt_power("") == "unknown", "a failed bluetoothctl must not read as off"

    w = parse_wifi("Connected to aa:bb\n\tsignal: -42 dBm\n",
                   "5 packets transmitted, 4 received, 20% packet loss, time 801ms\n"
                   "rtt min/avg/max/mdev = 1.360/2.512/3.194/0.4 ms\n")
    assert w == {"signal": -42, "loss": 20.0, "rtt": 2.512}, w
    assert parse_wifi("Not connected.", "") == {}, "nothing read must stay empty"
    assert drive_went_quiet(True, 10.0, 10.4) and not drive_went_quiet(True, 10.0, 10.2)
    assert not drive_went_quiet(False, 10.0, 99.0), "stopped car: nothing to do"
    assert not deadman_held(held, 2.0), "stale /joy must not block"
    assert not deadman_held([0] * 13, 0.1) and not deadman_held(None, 0.0)
    assert not deadman_held([0, 0], 0.1), "short button arrays must not crash"
    print("controller disconnect self-test passed")


def main():
    if "--self-test" in sys.argv:
        return self_test()
    rclpy.init()
    node = SystemDiagnostics()
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        # Deliberately NOT releasing an active e-stop on exit: fail safe. Say how.
        if node.estop_active and node.estop_pids:
            print(f"e-stop still active: {DRIVE_CHAIN_NODE} is frozen. To resume: "
                  f"kill -CONT {' '.join(map(str, node.estop_pids))}  (or restart bringup)")
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
