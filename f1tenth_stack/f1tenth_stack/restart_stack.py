#!/usr/bin/env python3
"""
Restart everything the dashboard runs on, on request from the dashboard.

What that means depends on how the car was started:

  - by start_diagnostics.sh (the robot-diagnostics copy, ~/diag): the same as
    typing `./start_diagnostics.sh --stop && ./start_diagnostics.sh`, with the
    options the run was started with;
  - by bringup (f1tenth_stack, where the dashboard is part of bringup): the
    bringup launch is stopped and started again with the same `name:=value`
    arguments, so every node - drive stack, lidar, camera, rosbridge,
    system_diagnostics, the page's server - comes back.

Used by the dashboard's Restart button through two routes, so it still works
when the thing that has hung is rosbridge itself:

  - system_diagnostics.py's ~/restart_stack service (over rosbridge), which
    first refuses while the car could be moving;
  - camera_http.py's POST /restart (plain HTTP on :8082), the fallback when
    rosbridge does not answer.

The restart runs as its own process in its own session, so it survives the
stop it starts: the stop ends system_diagnostics and camera_http, which asked
for it, along with everything else. It waits a second first, so whoever asked
gets their answer before rosbridge goes away, and its output goes to
restart.log in LOGDIR. A bringup restarted this way has no terminal; stop it
with `pkill -INT -f "ros2 launch f1tenth_stack bringup_launch.py"`.
"""

import os
import re
import subprocess
import time

SCRIPT_NAME = "start_diagnostics.sh"
LOGDIR = os.path.join(os.environ.get("TMPDIR") or "/tmp", "f1tenth-diag")
RESTART_LOG = os.path.join(LOGDIR, "restart.log")
RESTART_MARK = os.path.join(LOGDIR, "restart.started")
RESTART_GAP_S = 90          # a second request this soon is the same restart

# a bringup launch, as pgrep -af prints it:
# "<pid> /usr/bin/python3 /opt/ros/humble/bin/ros2 launch f1tenth_stack bringup_launch.py a:=b"
_BRINGUP = re.compile(r"^(\d+)\s+\S*python3?\S*\s+\S*ros2\s+launch\s+f1tenth_stack\s+"
                      r"bringup_launch\.py((?:\s+\S+)*)\s*$")
# what a stopped bringup can leave behind, matched by how it was launched
# (never by a bare file name, or an editor showing the file would match too)
BRINGUP_LEFTOVERS = (r"share/f1tenth_stack/config|__node:=static_baselink_to_laser|"
                     r"lib/rosbridge_server/rosbridge_websocket|lib/rosapi/rosapi_node|"
                     r"lib/f1tenth_stack/(system_diagnostics|camera_http)|"
                     r"gst-launch-1\.0 v4l2src|http\.server [0-9]+ --bind")
BRINGUP_STOP_S = 20         # how long the launch gets to stop its nodes

# a run of the script, as pgrep -af prints it: "<pid> bash ./start_diagnostics.sh ..."
_RUN = re.compile(r"^(\d+)\s+(?:/\S*/)?bash\s+(\S*start_diagnostics\.sh)((?:\s+\S+)*)\s*$")
# options a run is started with that are worth keeping; --stop, --status and
# --help are one-off commands, not part of a run
_KEEP = {"--no-bringup", "--no-sysdiag", "--no-bridge", "--no-server", "--no-camera"}
_KEEP_WITH_VALUE = {"--port", "--dir", "--camera-device"}


def script_path(here):
    """start_diagnostics.sh next to this file, or None (the bringup version)."""
    path = os.path.join(here, SCRIPT_NAME)
    return path if os.path.isfile(path) else None


def script_run(pgrep_out):
    r"""
    Return the options the running start_diagnostics.sh was started with.

    From `pgrep -af 'bash [^ ]*start_diagnostics\.sh'`; None when there is
    no run. Only real runs count: a --stop or --status in progress is not one.
    """
    for line in (pgrep_out or "").splitlines():
        m = _RUN.match(line.strip())
        if not m:
            continue
        words = m.group(3).split()
        if any(w in ("--stop", "--status", "-h", "--help") for w in words):
            continue
        keep, i = [], 0
        while i < len(words):
            if words[i] in _KEEP:
                keep.append(words[i])
            elif words[i] in _KEEP_WITH_VALUE and i + 1 < len(words):
                keep += [words[i], words[i + 1]]
                i += 1
            i += 1
        return keep
    return None


def run_options(pgrep_out):
    """Return script_run, with [] for no run."""
    return script_run(pgrep_out) or []


def bringup_run(pgrep_out):
    """
    Return (pid, its name:=value arguments) of the running bringup launch.

    From `pgrep -af 'ros2 launch f1tenth_stack bringup_launch'`; None if none.
    """
    for line in (pgrep_out or "").splitlines():
        m = _BRINGUP.match(line.strip())
        if m:
            return int(m.group(1)), [w for w in m.group(2).split() if ":=" in w]
    return None


def recently_started(now, mark_time):
    """Tell whether a restart started this recently is still going."""
    return mark_time is not None and 0 <= now - mark_time < RESTART_GAP_S


def _mark_time():
    try:
        return os.path.getmtime(RESTART_MARK)
    except OSError:
        return None


def _pgrep(pattern):
    try:
        return subprocess.run(["pgrep", "-af", pattern],
                              capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _start(argv, env, what):
    """Run argv in its own session, logging to RESTART_LOG."""
    os.makedirs(LOGDIR, exist_ok=True)
    with open(RESTART_MARK, "w") as f:
        f.write(f"{time.time()}\n")
    log = open(RESTART_LOG, "w")
    log.write(f"restart asked at {time.strftime('%H:%M:%S')}: {what}\n")
    log.flush()
    subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log,
                     stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    log.close()


def restart(here):
    """Start the restart. (started?, message for whoever asked)."""
    if recently_started(time.time(), _mark_time()):
        return True, "a restart is already under way"

    script = script_path(here)
    options = script_run(_pgrep(r"bash [^ ]*start_diagnostics\.sh")) if script else None
    if script and options is not None:
        return _restart_script(script, options)

    found = bringup_run(_pgrep(r"ros2 launch f1tenth_stack bringup_launch"))
    if found:
        return _restart_bringup(*found)

    return False, ("nothing to restart: neither start_diagnostics.sh nor a "
                   "`ros2 launch f1tenth_stack bringup_launch.py` is running")


def _restart_bringup(pid, args):
    """
    Stop the bringup launch, sweep what it left, start it again.

    Stopped with INT the way launch expects. `ros2 launch` started from a
    terminal (stdin a tty) assumes Ctrl+C reached its whole process group and
    passes nothing on to its nodes, so INT to launch alone left every node
    waiting out launch's 5 s before SIGTERM: such a launch gets INT to its
    group, if it leads one. A launch without a terminal (as this restart
    starts it) passes INT on itself, and a group INT there would reach each
    node twice, so it gets INT alone.
    Started again with the same arguments. The pattern goes in through the
    environment: in the shell's own command line, pkill -f would match the
    shell and kill it.
    """
    env = dict(os.environ, BRINGUP_PID=str(pid), BRINGUP_LEFTOVERS=BRINGUP_LEFTOVERS,
               BRINGUP_STOP_S=str(BRINGUP_STOP_S))
    shell = ('sleep 1; target="$BRINGUP_PID"; '
             'case "$(readlink /proc/"$BRINGUP_PID"/fd/0)" in /dev/pts/*|/dev/tty*) '
             '[ "$(ps -o pgid= -p "$BRINGUP_PID" | tr -d " ")" = "$BRINGUP_PID" ] && '
             'target="-$BRINGUP_PID";; esac; '
             'kill -INT -- "$target"; '
             'for _ in $(seq 1 "$BRINGUP_STOP_S"); do '
             'kill -0 "$BRINGUP_PID" 2>/dev/null || break; sleep 1; done; '
             'kill -KILL "$BRINGUP_PID" 2>/dev/null; '
             'pkill -TERM -f "$BRINGUP_LEFTOVERS"; sleep 2; '
             'pkill -KILL -f "$BRINGUP_LEFTOVERS"; sleep 1; '
             'exec ros2 launch f1tenth_stack bringup_launch.py "$@"')
    _start(["bash", "-c", shell, "restart-bringup", *args], env,
           f"stop bringup (pid {pid}), then ros2 launch f1tenth_stack bringup_launch.py "
           f"{' '.join(args)}")
    return True, ("restarting: stopping bringup and every node it started, then starting "
                  f"it again{' with ' + ' '.join(args) if args else ''}. About a minute. "
                  f"Log: {RESTART_LOG}")


def _restart_script(script, options):
    """start_diagnostics.sh --stop, then the script again with the same options."""
    what = f"{script} --stop, then {script} {' '.join(options)}"
    # "$0" is the script, "$@" the options: no quoting to get wrong
    argv = ["bash", "-c", 'sleep 1; cd "$(dirname "$0")"; "$0" --stop; exec "$0" "$@"',
            script, *options]
    _start(argv, None, what)
    return True, ("restarting: stopping everything start_diagnostics.sh runs, then "
                  f"starting it again{' with ' + ' '.join(options) if options else ''}. "
                  f"About a minute. Log: {RESTART_LOG}")


def self_test():
    """`python3 restart_stack.py --self-test`: no robot, nothing restarted."""
    import tempfile

    sample = ("4101 bash ./start_diagnostics.sh --no-camera --port 8080\n"
              "4500 bash /home/f1-wsu-2/diag/start_diagnostics.sh --status\n")
    assert run_options(sample) == ["--no-camera", "--port", "8080"], run_options(sample)
    assert run_options("4500 bash ./start_diagnostics.sh --stop\n") == [], "a --stop is not a run"
    assert run_options("77 /bin/bash ./start_diagnostics.sh\n") == []
    assert run_options("77 /usr/bin/bash /home/x/diag/start_diagnostics.sh --no-bringup\n") == \
        ["--no-bringup"]
    assert run_options("12 nvim start_diagnostics.sh\n") == [], "an editor is not a run"
    assert run_options("12 bash -c sleep 1; ./start_diagnostics.sh --stop\n") == [], \
        "the restart's own shell is not a run"
    assert run_options(None) == [] and run_options("") == []
    assert run_options("9 bash ./start_diagnostics.sh --camera-device /dev/video2 --oops\n") == \
        ["--camera-device", "/dev/video2"], "unknown options are dropped"

    assert recently_started(100.0, 50.0) and not recently_started(100.0, None)
    assert not recently_started(1000.0, 100.0), "an old restart does not block a new one"

    assert script_run("") is None and script_run("77 bash ./start_diagnostics.sh\n") == []

    line = ("3058 /usr/bin/python3 /opt/ros/humble/bin/ros2 launch f1tenth_stack "
            "bringup_launch.py use_camera:=false dashboard_port:=8000\n")
    assert bringup_run(line) == (3058, ["use_camera:=false", "dashboard_port:=8000"]), \
        bringup_run(line)
    assert bringup_run("3058 /usr/bin/python3 /opt/ros/humble/bin/ros2 launch f1tenth_stack "
                       "bringup_launch.py\n") == (3058, [])
    assert bringup_run("12 nvim bringup_launch.py\n") is None, "an editor is not a bringup"
    assert bringup_run("12 /usr/bin/python3 /opt/ros/humble/bin/ros2 launch "
                       "rosbridge_server rosbridge_websocket_launch.xml\n") is None
    assert bringup_run(None) is None

    with tempfile.TemporaryDirectory() as here:
        assert script_path(here) is None
    print("restart_stack self-test passed")


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        self_test()
