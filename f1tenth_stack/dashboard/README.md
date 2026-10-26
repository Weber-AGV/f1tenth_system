# Robot diagnostics dashboard

A web page that shows, at a glance, whether this F1TENTH car is OK to drive and, if it is not, what is wrong. It is served by the robot and opened in a browser on any laptop or phone on the same Wi-Fi. Nothing is installed on the laptop. It also streams the camera, draws the lidar, and can drive the car.

`bringup` starts it along with the drive stack. Paths below are relative to the `f1tenth_stack` package folder. This file is the full reference: how to run it, every check in depth (what it reads, how it is judged, why its lines are where they are, and what to change), and the dead ends we already ruled out. How to *use* each tab, with screenshots, is in the [guides](#guides).

## Contents

- [How it fits together](#how-it-fits-together)
- [Running it](#running-it)
- [Reading the page](#reading-the-page)
- [Guides](#guides)
- [Ranges: what is green, yellow and red](#ranges-what-is-green-yellow-and-red)
- [How each check works](#how-each-check-works)
- [Dead ends: things we tried that don't work](#dead-ends-things-we-tried-that-dont-work)
- [What it can do to the car](#what-it-can-do-to-the-car)
- [Changing things](#changing-things)
- [Troubleshooting](#troubleshooting)
- [Known gaps](#known-gaps)
- [Who built this](#who-built-this)

## How it fits together

```
 laptop or phone browser
   |-- http :8000 ----------> web server on the robot (sends the page: HTML, CSS, JS)
   |-- websocket :9090 -----> rosbridge ----> ROS topics and services
   |                                          |- drivers: /scan, /sensors/core, /odom, /joy, ...
   |                                          |- /diagnostics from urg_node, ackermann_mux
   |                                          |  and system_diagnostics
   |                                          '- rosapi: lists of nodes, topics and publishers
   '-- http :8082 ----------> camera_http --tcp :8081--> GStreamer --> camera (/dev/video4)
```

| Piece | What it does | Why it is built this way |
|---|---|---|
| **system_diagnostics** | ROS node. Reads what ROS does not report (thermal zones, CPU, memory, disk, GPU, Wi-Fi, lidar link, Bluetooth, controller, camera USB link, clock) and publishes it as `system: ...` statuses on `/diagnostics` once a second. Also runs the emergency stop, the drive watchdog, Disconnect controller and the joystick check | `/diagnostics` is ROS's standard health topic, which the lidar driver and the mux already use, so the page and `rqt_robot_monitor` read all of it the same way |
| **rosbridge** | Websocket server that relays ROS topics and services as JSON | Lets a plain web page read ROS with no ROS on the laptop. It has **no authentication** and serves at most **10 clients** (see [Known gaps](#known-gaps)) |
| **Web server** | `python3 -m http.server`, serving only `dashboard/` | The page is plain HTML, CSS and JavaScript with no build step and no outside libraries: no npm, no `node_modules`, no React or other framework versions to keep up with, and nothing loaded from the internet. `colcon build` just copies the files, edit a file and reload to see a change, and it keeps working on a robot with no internet |
| **Camera** | GStreamer reads the RealSense colour stream from `/dev/video4` (640x480, 30 fps), encodes JPEG and serves it on TCP :8081. `camera_http` re-serves it as HTTP MJPEG on :8082 (`/camera.mjpg`), plus frame-rate stats at `/stats` | Not through ROS on purpose: one raw colour frame is about 2.7 MB, far too much for Wi-Fi and rosbridge. A JPEG is about 50 KB |

## Running it

`bringup` (the alias for `ros2 launch f1tenth_stack bringup_launch.py`) starts the dashboard with the drive stack. Then open `http://<robot ip>:8000/dashboard.html` from a device on the robot's Wi-Fi, for example `http://192.168.1.206:8000/dashboard.html` for robot 6. On the robot, `hostname -I` shows its address: use the one starting `192.168.1.` (the `192.168.0.` one is the robot's own cable to the lidar). The page finds rosbridge and the camera on the machine it was loaded from, so nothing else needs an address. To look at another car from the same page, pick it in the top bar's robot list (or type its address beside the list) and the page connects to it.

| Launch argument | Default | What it does |
|---|---|---|
| `use_diagnostics` | `true` | Starts `system_diagnostics`, rosbridge and the web server |
| `use_camera` | `true` | Starts the GStreamer camera stream and `camera_http` |
| `use_lidar` | `true` | Starts the lidar driver (`urg_node`) |
| `camera_device` | `/dev/video4` | Video device GStreamer reads. Check with `v4l2-ctl --list-devices` if the camera stays dark |
| `dashboard_port` | `8000` | Port of the web server |

For example `ros2 launch f1tenth_stack bringup_launch.py use_camera:=false`. With `use_diagnostics:=false use_camera:=false`, bringup starts the same 8 nodes it always did; `use_lidar:=false` also leaves out `urg_node`.

| Port | What is on it |
|---|---|
| 8000 | The dashboard page |
| 9090 | rosbridge |
| 8081 | GStreamer's raw stream (only `camera_http` reads it) |
| 8082 | The camera as HTTP: `/camera.mjpg`, `/stats` |

### Setting up another car

Most of this is probably already done on the cars; each step says how to check before changing anything.

1. `git pull` and `git submodule update --init --recursive` in `~/f1tenth_ws/src/f1tenth_system`, then `colcon build --packages-select f1tenth_stack` and restart bringup.
2. rosbridge and GStreamer installed. Usually nothing to do: GStreamer comes with the Jetson's Ubuntu image, and rosbridge is already on robots 2 and 6. If either is missing, run `rosdep install --from-paths src --ignore-src -r -y` in `~/f1tenth_ws`; it installs both, since they are declared in `package.xml`. On a brand-new car, the `wsu-roboracer/robot-commissioning` setup script runs that for you.
3. The login user in the `input` group, or ROS cannot read the controller. Check with `id`: if `input` is listed, it's done (it is on robots 2 and 6). If not, `sudo usermod -aG input $USER`, then log out and back in.
4. A `ROS_DOMAIN_ID` no other car uses, or the page lists the other car's nodes as well. Check with `echo $ROS_DOMAIN_ID`. The cars so far use 200 plus the robot's number, set in `~/.bashrc` (`export ROS_DOMAIN_ID=206` on robot 6, 202 on robot 2).
5. The camera device. Bringup reads `/dev/video4` by default; check with `v4l2-ctl --list-devices`, and if the RealSense's colour stream is somewhere else, start bringup with `camera_device:=<device>`.
6. The VESC driver's temperature patch, or the FET temperature shows "no reading" (see [Known gaps](#known-gaps)).

### Working on the page from a laptop

Serve `dashboard/` from a laptop and point it at a running car:

```bash
python3 -m http.server 8000          # in f1tenth_stack/dashboard
```

Then open `http://localhost:8000/dashboard.html?url=ws://<robot ip>:9090`, or pick the car in the top bar's robot list. The list is `ROBOTS` in `dashboard/js/config.js` (`F1-WSU-1` to `F1-WSU-12` at `ws://192.168.1.201:9090` to `.212`); **Other…** and the address box beside it take any other address, and **Connect** (or Enter) connects. Served from the robot, the page fills the address in itself.

Checks that need no robot (the LiDAR geometry, Select beams, the Robot System list and joystick check, the camera proxy, and the robot side's parsers, emergency stop and joystick check) run with one command. They need Node.js and Python 3, and no ROS:

```bash
node dashboard/tests/run.mjs        # in f1tenth_stack; exits non-zero if any check fails
```

## Reading the page

| Colour | Means |
|---|---|
| Green | Fresh data, inside its range |
| Yellow | Working, but worth watching |
| Red | Broken or unsafe: a node not running, a fault code, a value in its red band, a sensor the car needs that stopped |
| Grey | No reading yet. Never shown as green |

The banner at the top shows the worst of seven subsystems (Controller, VESC, LiDAR, Odometry, Camera, Battery, Control Mode) and names the ones at fault. A red bar across the top means the page has heard nothing from the robot for 4 seconds, so what it shows may be old; an orange bar means this browser is one too many for rosbridge (see [Known gaps](#known-gaps)).

Topic states and why a quiet topic is not always a fault are under [Topics](#topics).

## Guides

Step-by-step guides to each tab, with a screenshot of everything they describe. They are for people using the page; this README is for people changing it.

- [Overview tab](docs/guides/overview-tab.md): connecting to a car, the 10-second check, battery and computer tiles, subsystems, the camera and the LiDAR card.
- [Drive tab](docs/guides/drive-tab.md): arming, driving with the keys, pad or a phone, full screen, arranging the view, recording the camera, and what stops the car.
- [Advanced tab](docs/guides/advanced-tab.md): the robot's own checks, nodes, topics, ROS diagnostics, and the joystick check.

## Ranges: what is green, yellow and red

The professor signed off on these ranges. They are starting values, not final ones: most come from hardware limits read off the robot or from common conventions, not from a class using the cars. Expect them to change once the class runs and they are measured against the tests students actually run. Rows marked *convention* have no measurement behind them, so they are the first to revisit. Each item links to how it is checked and where to change it.

| Item | Green | Yellow | Red | Basis |
|---|---|---|---|---|
| [Battery](#battery) (5 second median) | 11.6 V or more | 11.1 to 11.6 V | below 11.1 V | Run-down test, car sitting still: from 10.4 V the robot lost power about five minutes later at 8.8 V or below. Yellow is a *convention* |
| [VESC FET temperature](#motor-controller-vesc-temperature-and-faults) | below 65 C | 65 to 80 C | 80 C or more, or any fault code | The VESC's own over-temperature fault trips near 85 C. Provisional |
| [Board temperature](#board-temperatures) | below 70 C | 70 to 85 C | 85 C or more | The Jetson's trip points: slows down at 70 and 99 C, shuts off at 104.5 C |
| [CPU load](#cpu) (1 minute) | up to the core count (6) | above 6 | above 12 | Work queueing for a core. The CPU is capped at 1.51 GHz in 15 W mode |
| [RAM available](#memory-ram) | 20% or more | 10 to 20% | below 10% | Idle reads 63 to 80% |
| [GPU load](#gpu) | below 95% | 95% or more for 5 s | none | *Convention.* A busy GPU is a heavy job, not a fault |
| [Wi-Fi signal](#wi-fi) | -67 dBm or better | below -67 dBm | below -75 dBm, or no link | *Convention.* The lab reads -39 to -43 dBm |
| [Wi-Fi loss](#wi-fi) (to the router) | under 1% | 1% or more | 5% or more | *Convention* |
| [Wi-Fi round trip](#wi-fi) | under 30 ms | 30 ms or more | 100 ms or more | *Convention.* The lab reads 1.4 to 3.2 ms |
| [Lidar](#lidar) | 38 to 42 Hz | scanning, outside that rate | no scans, or not running | `urg_node`'s own accepted rate, 40 Hz within 5% |
| [Camera](#camera) | USB 3 (5000M), 15 fps or more | slower USB link, or under 15 fps | not on USB, or no frame for 3 s | Half the camera's 30 fps |
| [Controller](#controller) | readable by ROS, or none connected | - | connected but ROS cannot read it | No controller is normal when nobody drives |
| [Nodes](#nodes) | all expected running | - | any missing | A missing node is a failed bringup |

Not signed off: [disk](#disk), yellow above 85% used and red above 95%.

## How each check works

Every check follows the same pattern: a short summary, then the detail in the same order each time.

- **Where it comes from**: the file, command or ROS topic the value is read from.
- **How it is judged**: who decides the colour (the robot or the page) and the rule.
- **Why these lines**: where the green / yellow / red numbers came from.
- **What is sent**: what reaches the page, with the exact names.
- **On the page**: what you see, and where.
- **To change**: the file and setting to edit, with the current value.

"On the robot" means `system_diagnostics` decides the colour and sends it as a level on `/diagnostics`; "on the page" means the browser decides from the raw values. Each report on `/diagnostics` has a name (such as `system: CPU`), a level (0 OK, 1 warning, 2 error, 3 not measured yet), a one-line message, and key / value pairs; the values are text, such as `46.1 C`, and the page reads the number out of the text. Every report also appears, with all its keys, in the Advanced tab's Robot System list.

`system_diagnostics` builds its reports once a second. Cheap readings (files under `/proc` and `/sys`) are taken every second. Anything that runs another program (`ping`, `iw`, `bluetoothctl`, `tegrastats`, `timedatectl`, `joy_enumerate_devices`) runs on a separate thread every 10 seconds (`SLOW_PERIOD`), each with a timeout, and the report uses the latest result. Until that thread's first pass, those reports say "not probed yet" at level 3.

The names under "What is sent" are the agreement between the robot side and the page. If one side renames something, the other side does not fail with an error; that value just goes blank or grey "unknown". Change both sides together.

### Battery

Shows the main battery's voltage and an estimated charge, and warns before the pack runs too low.

**Where it comes from.** The motor controller (VESC) measures the battery voltage. `vesc_driver_node` publishes it on `/sensors/core` about 50 times a second, in the field `state.voltage_input`.

**How it is judged.** On the page. Under throttle the voltage swings about 0.2 V within a second, so the page keeps the last 5 seconds of readings and judges their median, not the latest reading. Green at 11.6 V or more, yellow from 11.1 to 11.6 V ("low, get a spare pack ready"), red below 11.1 V ("replace the pack soon"). The percentage is a straight line from 11.1 V (0%) to 12.6 V (100%).

**Why these lines.** A run-down test on robot 2, **with the car sitting still, not driving**, started at 10.4 V. The pack fell about 0.25 V a minute to about 9.3 V, then about 1 V a minute, and the robot lost power about five minutes after 10.4 V (last reading 8.8 V). Driving draws far more current, so on the track it goes faster than that, and red sits at 11.1 V (3.7 V per cell) to leave time to swap the pack. Nothing on the car stops the pack from running too low, and LiPo cells start to get damaged below about 3.3 V each (9.9 V for this 3-cell pack), so red is the only warning: **swap the pack when it turns red.** Yellow at 11.6 V is a convention: a buffer to get a spare ready. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** `/sensors/core`, field `state.voltage_input`.

**On the page.** The Battery card on the Overview (number, gauge and bar), the battery in the driving view's top bar, and the headline: the battery counts toward it even though it has no row in the Subsystems table. If no reading has arrived and `/sensors/core` does not exist, the battery is red ("/sensors/core unavailable").

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Yellow line | `dashboard/js/config.js` | `BATT_WARN = 11.6` (volts) |
| Red line, and 0% on the gauge | `dashboard/js/config.js` | `BATT_ERR = 11.1` |
| 100% on the gauge | `dashboard/js/config.js` | `BATT_FULL = 12.6` |
| Smoothing window | `dashboard/js/config.js` | `BATT_WINDOW_MS = 5000` (the median is taken in `onVesc()` in `dashboard/js/graph-data.js`) |
| Percentage formula | `dashboard/js/helpers.js` | `batteryEstimate()` |
| Card wording and colours | `dashboard/js/status-panels.js` | `renderBattery()` |
| Subsystem wording | `dashboard/js/health.js` | the battery part of `subsystemData()` |

### Motor controller (VESC): temperature and faults

Shows whether the motor controller is running, its power transistors' (FET) temperature, and any fault it reports.

**Where it comes from.** `/sensors/core` from `vesc_driver_node`: `state.temp_fet` (temperature, in C) and `state.fault_code` (0 is no fault). The temperature is only filled in on cars with the VESC driver patch (robots 2 and 6); without it the field is always exactly `0.0`.

**How it is judged.** On the page. The VESC row is red if `vesc_driver_node` is not running or `fault_code` is not 0. Otherwise the FET temperature decides: green below 65 C, yellow from 65 C, red from 80 C. A reading of exactly 0.0 is treated as "no reading" (the missing patch), not as 0 C.

**Why these lines.** The VESC shuts itself off with an over-temperature fault near 85 C, so red at 80 C comes before that. Idle reads about 31 C. The car has never been measured on a long drive, so these are provisional. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** `/sensors/core`, fields `state.temp_fet` and `state.fault_code`; the node list from rosapi.

**On the page.** The VESC row in Subsystems, and the FET (VESC) row in the Temperature tile.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Temperature lines | `dashboard/js/config.js` | `FET_WARN = 65`, `FET_ERR = 80` (C) |
| Fault code names | `dashboard/js/config.js` | `FAULTS` |
| "No motor sensor" cut-off | `dashboard/js/config.js` | `MOTOR_ABSENT = -20` (the motor has no sensor fitted and reads about -74 C) |
| Row wording | `dashboard/js/health.js` | the VESC part of `subsystemData()` |

### VESC USB device

Catches an unplugged motor controller before its topic even goes quiet.

**Where it comes from.** `system_diagnostics` checks that `/dev/sensors/vesc` exists. That name is a link the VESC's udev rule creates to the real serial device (for example `/dev/ttyACM0`).

**How it is judged.** On the robot: OK if it exists, error if not (the report then lists any `/dev/ttyACM*` devices it did find).

**What is sent.** Report `system: VESC device`, keys `path` and `resolves to`.

**On the page.** The Robot System list.

**To change.** The path is in `vesc_device()` in `f1tenth_stack/system_diagnostics.py`.

---

### Board temperatures

Shows how hot the Jetson's chip is. It slows itself down at 70 C and 99 C and shuts off at 104.5 C (measured on robot 2).

**Where it comes from.** `system_diagnostics` reads every Linux thermal zone, `/sys/devices/virtual/thermal/thermal_zone*/temp` (thousandths of a degree) with its name from `.../type`, once a second. On these Jetsons the zones are `tj-thermal` (junction, the hottest point), `cpu-thermal`, `gpu-thermal`, `soc0-thermal` to `soc2-thermal`, and `cv0` to `cv2`, which often fail to read; a zone that fails is skipped for that second and listed as "unreadable this pass".

**How it is judged.** Twice:

- The report's level, on the robot, from `tj-thermal` (or the hottest zone on a board without one): yellow from 70 C, red from 85 C.
- The Temperature tile's rows, on the page, each graded with the same 70 and 85 C; the tile takes the worst row, including the VESC's FET row.

**Why these lines.** They come from the Jetson's own trip points, read on robot
#2: it slows itself down at 70 C and 99 C, and shuts off at 104.5 C. Idle is about
50 C. Yellow marks the first slowdown; red leaves about 14 C before the second. Not measured on a long drive. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: Thermal`, one key per zone named as the zone (`tj-thermal`, `cpu-thermal`, `gpu-thermal`, `soc0-thermal`...), values like `46.1 C`.

**On the page.** The Temperature tile (Junction, CPU, GPU and FET (VESC) rows; the SoC zones are in the Junction row's hover text), and the driving view's bottom bar.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Report lines | `f1tenth_stack/system_diagnostics.py` | `TJ_WARN, TJ_ERR = 70.0, 85.0` (C) |
| Tile row lines | `dashboard/js/metrics.js` | `gradeValue(t, 70, 85)` in `jetsonRow`; keep it the same as the report |
| Which zones get a row | `dashboard/js/metrics.js` | the `jetsonRow(...)` calls in the Temperature part of `metricTiles()` |

### CPU

Shows how busy the processor is.

**Where it comes from.** `system_diagnostics` reads, once a second:

- `/proc/loadavg`: the load average over 1, 5 and 15 minutes (how many processes were running or waiting to run, on average).
- The number of cores, from Python's `os.cpu_count()` (6 on these Jetsons).
- `/proc/stat`: the CPU's time counters. Comparing them with the previous second gives the percent of that second the CPU was busy. Time spent waiting for the disk counts as idle, so writing a log file does not look like a busy CPU.

**How it is judged.** On the robot, by the 1 minute load average: yellow when it is above the number of cores, red above twice the number of cores. The busy percent is shown but not graded.

**Why these lines.** A load above the core count means work is waiting for a core. The CPU is capped at 1.51 GHz in the 15 W power mode, so the board can be slower than expected without being hot or broken. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: CPU`, keys `cores`, `load 1m`, `load 5m`, `load 15m`, `usage %`.

**On the page.** The CPU tile: the big number is `usage %`, the line under it is `load 1m`, and the colour is the report's level. So the tile can show a low percentage in yellow if the load average is high. If `usage %` is missing, the tile shows the load average instead.

**To change.**

| What | File | Setting |
|---|---|---|
| Lines | `f1tenth_stack/system_diagnostics.py` | inside `cpu()`: `ERROR if l1 > self.ncores * 2 else WARN if l1 > self.ncores` |
| How busy percent is worked out | `f1tenth_stack/system_diagnostics.py` | `cpu_busy_pct()` |
| Tile | `dashboard/js/metrics.js` | the CPU part of `metricTiles()` |

### Memory (RAM)

Shows how much memory is left.

**Where it comes from.** `system_diagnostics` reads `/proc/meminfo` once a second: `MemTotal`, `MemAvailable` (memory programs can still get, including what Linux would free from its cache) and swap.

**How it is judged.** On the robot, by the percent available: yellow below 20%, red below 10%.

**Why these lines.** Idle reads 63 to 80% available, so yellow and red mean something is using far more than usual. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: Memory`, keys `total`, `available`, `available %`, `swap used`.

**On the page.** The RAM tile shows the percent used (100 minus `available %`), with the free amount under it; the colour is the report's level.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Lines | `f1tenth_stack/system_diagnostics.py` | `MEM_WARN, MEM_ERR = 20.0, 10.0` (percent available) |
| Tile | `dashboard/js/metrics.js` | the MEMORY part of `metricTiles()` |

### Disk

Warns before the robot's disk fills up.

**Where it comes from.** `system_diagnostics` asks Python's `shutil.disk_usage("/")` for the root filesystem once a second (the NVMe drive, about 1 TB).

**How it is judged.** On the robot, by percent used: yellow above 85%, red above 95%.

**Why these lines.** Common defaults, not part of the professor's sign-off. The disk is about 1 TB and idle is under 5% used.

**What is sent.** Report `system: Storage`, keys `total`, `used`, `free`, `used %`.

**On the page.** The Robot System list. There is no tile.

**To change.** `DISK_WARN, DISK_ERR = 85.0, 95.0` in `f1tenth_stack/system_diagnostics.py`.

### GPU

Shows how busy the graphics processor is, which vision and machine learning code use.

**Where it comes from.** `system_diagnostics` reads the GPU driver's `load` file once a second. Its location differs between Jetson models, so the node searches the paths in `GPU_LOAD_GLOBS` at startup (on robot 6: `/sys/devices/platform/bus@0/17000000.gpu/load`). The file counts in tenths of a percent (0 to 1000). The clock speed comes from the GPU's `cur_freq` file under `/sys/class/devfreq/`. If the load file does not exist, the node falls back to the `GR3D_FREQ` field of `tegrastats`, read every 10 seconds.

**How it is judged.** On the robot. Yellow once the GPU has been at 95% or more for 5 seconds in a row (5 readings, one a second). There is no red: a busy GPU just means something is using it.

**Why these lines.** A convention: a busy GPU means a heavy job is running, which is normal. Heat from it shows up in the board temperature, so there is no red. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: GPU`, keys `usage %`, `freq`, `source` (the file or `tegrastats`).

**On the page.** The GPU tile: the percent, with the clock speed and source under it; the colour is the report's level.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Warning line | `f1tenth_stack/system_diagnostics.py` | `GPU_WARN = 95.0` (percent) |
| How long it must stay high | `f1tenth_stack/system_diagnostics.py` | `GPU_SUSTAIN_S = 5` (seconds) |
| Where to look for the load file | `f1tenth_stack/system_diagnostics.py` | `GPU_LOAD_GLOBS` |

### Power, uptime and reboots

Shows how long the robot has been on, and notices when it rebooted, which on these cars usually means the battery dipped too low.

**Where it comes from.** `system_diagnostics` reads `/proc/uptime` once a second. Every 10 seconds it also runs `tegrastats` and records the power rails (`VDD_IN`, `VDD_CPU_GPU_CV`, `VDD_SOC`, in milliwatts).

**How it is judged.** On the robot. The node compares each uptime reading with its own previous one, and if uptime went down it reports an error, "REBOOTED - uptime went backwards", then stays at least yellow with the time it happened. In practice this does not catch a real reboot: rebooting the board restarts the node too, so there is no previous reading to compare with. The useful sign is the uptime itself. An uptime of a few minutes that nobody expected means the robot restarted, and on these cars that usually means the battery dipped.

**What is sent.** Report `system: Power`, keys `uptime`, `last reboot detected`, and one key per power rail.

**On the page.** Uptime in the ROS Graph card; the rest in the Robot System list.

**To change.** `power()` in `f1tenth_stack/system_diagnostics.py`.

---

### Wi-Fi

Shows how good the robot's Wi-Fi link is. This link carries the page, so a bad one makes the page lag or freeze.

**Where it comes from.** `system_diagnostics`, every 10 seconds:

- Signal strength from `iw dev <wifi> link`, where `<wifi>` is the first network interface whose name starts with `wl` (`wlP1p1s0` on these Jetsons).
- Packet loss and round trip time from 5 pings, 0.2 s apart, to the default gateway (the router), found with `ip route show default`. It pings the router, not the internet, because the robot does not need the internet.
- Whether the interface has a link, from `/sys/class/net/<wifi>/carrier`.

**How it is judged.** On the page, each value on its own, and the row takes the worst:

| | Green | Yellow | Red |
|---|---|---|---|
| Signal | -67 dBm or better | below -67 dBm | below -75 dBm |
| Packet loss | under 1% | 1% or more | 5% or more |
| Round trip | under 30 ms | 30 ms or more | 100 ms or more |

No link at all is red ("down"). A value that has not been measured yet is left out.

**Why these lines.** Common Wi-Fi conventions, not measurements. In the lab the robots read -39 to -43 dBm, 0% loss and 1.4 to 3.2 ms; bad sessions in the past lost 90 to 100% of packets. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: Network`: keys `wifi signal` (dBm), `wifi loss %`, `wifi rtt ms`, `wifi gateway`, and a key named after the interface (`wlP1p1s0`) whose value contains `carrier=1` (link up) or `carrier=0`.

**On the page.** The Wi-Fi row of the Network tile, and the footer.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Signal lines | `dashboard/js/config.js` | `WIFI_SIGNAL_WARN = -67`, `WIFI_SIGNAL_ERR = -75` (dBm) |
| Loss lines | `dashboard/js/config.js` | `WIFI_LOSS_WARN = 1`, `WIFI_LOSS_ERR = 5` (percent) |
| Round trip lines | `dashboard/js/config.js` | `WIFI_RTT_WARN = 30`, `WIFI_RTT_ERR = 100` (ms) |
| How it is measured | `f1tenth_stack/system_diagnostics.py` | the Wi-Fi part of `_probe_slow()`, and `parse_wifi()` |
| The row | `dashboard/js/metrics.js` | `networkRows()`, shared by the tile and the footer |

### Bluetooth

Shows whether the Jetson's Bluetooth radio is on. It must be on for the controller to connect.

**Where it comes from.** `bluetoothctl show`, every 10 seconds: `Powered: yes` or `Powered: no`.

**How it is judged.** On the page: on is green; off, or no adapter, is yellow.

**What is sent.** Report `system: Network`, key `bluetooth`: `on`, `off`, `no adapter` or `unknown`.

**On the page.** The Bluetooth row of the Network tile, and the footer.

**To change.** `bt_power()` in `f1tenth_stack/system_diagnostics.py`; the row in `networkRows()` in `dashboard/js/metrics.js`.

---

### Lidar

Shows whether the lidar is connected and scanning properly, and draws what it sees.

The lidar is a Hokuyo UST-10LX on its own Ethernet cable at `192.168.0.10`. It accepts only one connection at a time. Its driver, `urg_node`, connects to it and publishes `/scan` 40 times a second: 1081 distances in a 270° fan in front of the car.

**Where it comes from.** Four separate pieces, because "is the lidar OK" has several different failures:

1. **The cable.** `system_diagnostics` reads `/sys/class/net/<if>/carrier` for each network interface every 10 seconds. The lidar's interface is the Ethernet one (name starting `en`, `enP8p1s0` on these Jetsons).
2. **The lidar answering.** `system_diagnostics` pings `192.168.0.10` twice every 10 seconds.
3. **The driver.** Whether `/urg_node` is in rosapi's node list, and how many publishers `/scan` has (rosapi).
4. **The scans.** The page subscribes to `/scan` and reads `ranges`, `angle_min`, `angle_max`, `angle_increment`, `range_min` and `range_max`. `urg_node` also measures its own scan rate and publishes it on `/diagnostics`, with the range it accepts (40 Hz plus or minus 5%, so 38 to 42 Hz, from `sensors.yaml`).

**How it is judged.** On the page, in this order:

| Situation | LiDAR row |
|---|---|
| `/urg_node` is not running | red: "/urg_node is not running" |
| `/scan` has more than one publisher | red: two lidar drivers; one is left over from an earlier run and holds the lidar's only connection. The message gives the fix |
| scans arriving, rate outside 38 to 42 Hz | yellow, with the rate |
| scans arriving, rate inside | green, with the rate |
| no scans (stale, silent or missing) | red; if the lidar still answers ping, the message adds that the driver cannot connect, and gives the fix |

The Network tile's Lidar row is judged separately: "unplugged" (no cable link) and "no reply" (cable in, no ping answer, usually no power) are red, "answering" is green.

**Why these lines.** The rate range is `urg_node`'s own, 40 Hz within 5%. No scans is red because the car cannot see. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** `/scan` (fields above); report `urg_node: Laser Scan topic status`, keys `Actual frequency (Hz)`, `Minimum acceptable frequency (Hz)`, `Maximum acceptable frequency (Hz)`; report `system: Network`, the key starting `lidar ` (`lidar 192.168.0.10`, value `reachable, 0.25 ms` or `NO REPLY`) and the Ethernet interface's key with `carrier=`. `urg_node` also sends `urg_node: Hardware Status` (device status, error counts, serial number), shown as is in the Robot System list.

**On the page.** The LiDAR row in Subsystems; the Lidar row of the Network tile and the footer; the LiDAR card; the driving view's LiDAR pane or floating LiDAR window; and the camera's edge lights and "Very close" warning. The plot has two views, one choice for every plot on the page, remembered per browser:

- **Lines** (the default): the scan as one green outline, with red (0.5 m) and amber (1 m) circles around a to-scale car, and the closest return ahead, left, right and overall underneath.
- **Detailed** (`dashboard/js/radar.js`): every return as a dot, walls as outlines, neighbouring returns grouped into objects with the nearest five numbered (amber under 1 m, red under 0.3 m, ▼ and a speed when one is getting closer), a status for each direction, and a **Sweep** button for the turning line. Point at the plot for an object's distance, direction and width. **Ignore angles** hides parts of your own car the lidar sees.

Both views zoom (scroll, or the range buttons), pan (drag), and **Select beams** reads back a range of `ranges[]` indexes.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Acceptable scan rate | `config/sensors.yaml` | `diagnostics_tolerance: 0.05`. Restart bringup |
| How the row is judged and worded | `dashboard/js/health.js` | the LiDAR part of `subsystemData()` |
| The lidar's address | `f1tenth_stack/system_diagnostics.py` | `LIDAR_IP = "192.168.0.10"` |
| "Close" and "very close" | `dashboard/js/metrics.js` | `LIDAR_CLOSE = 1.0`, `LIDAR_NEAR = 0.5` (metres); used by the card, the Drive tab and the edge lights |
| Plot range buttons, Auto range | `dashboard/js/metrics.js` | `LIDAR_RANGES`, `AUTO_MIN_RANGE = 2` |
| Detailed view: object lines, grouping, sectors, sweep | `dashboard/js/radar.js` | `RADAR` (`danger: 0.30`, `warn: 1.00`, `nearestShown: 5`, `sectors`, `sweepSeconds: 4`) |
| Edge light directions | `dashboard/js/cockpit.js` | `COCKPIT_GLOW_SECTORS` |

### Camera

Streams the front camera, and checks it is connected properly and delivering frames.

**Where it comes from.** Two separate things:

1. **The stream.** GStreamer opens the RealSense's colour camera at `/dev/video4` (640x480, 30 fps), compresses each frame to JPEG and sends the frames on TCP port 8081. `f1tenth_stack/camera_http.py` reads that as fast as it arrives and keeps only the newest whole frame. Each viewer at `http://<robot>:8082/camera.mjpg` is sent the newest frame whenever its connection can take one; frames it could not keep up with are skipped, so a slow link costs frame rate, never delay. It counts the frames actually delivered to each viewer and reports them at `http://<robot>:8082/stats` as JSON: `viewers`, `fps`, `last_frame_s` (seconds since the last frame). So `fps` is what you actually see, not what the camera produces.
2. **The USB link.** `system_diagnostics` looks through `/sys/bus/usb/devices/*/` every 10 seconds for a device with Intel's vendor ID (`idVendor` is `8086`) and reads its `speed`, `product` and `serial`.

**How it is judged.** The USB link on the robot: no Intel device is red, a link slower than 5000M (USB 3) is yellow. The frame rate on the page, every 2 seconds while the picture is showing: no frame for more than 3 seconds is red, under 15 fps is yellow. The Camera row takes the worse of the two.

**Why these lines.** 15 fps is half the camera's 30. The RealSense is a USB 3 camera, so a slower link means it is in the wrong port or on the wrong cable. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: Camera`, keys `product`, `usb serial`, `usb port`, `link speed`; and the `/stats` JSON, of which the page reads `fps` and `last_frame_s`.

**On the page.** The camera picture (Overview and the driving view), its status tag (`LIVE · 30 fps`), and the Camera row in Subsystems. The page finds the camera on port 8082 of the robot rosbridge is connected to, and retries every 3 to 15 seconds while the robot is up and the picture is not. Typing an address under "Change camera address" switches that off until "Use automatic" is pressed.

**Recording.** **Record** (the camera card, the driving view's top bar, the side rail) records the stream in the browser: each frame of the page's one camera `<img>` is drawn onto a canvas 30 times a second, and the browser's `MediaRecorder` encodes the canvas, as MP4 where the browser can (Safari, recent Chrome) and WebM otherwise. Nothing runs on the robot and nothing extra crosses the Wi-Fi. The same `Access-Control-Allow-Origin` header that lets Take Picture read the frame lets this read every frame. Stop downloads the file, named by when it started (`camera-2026-10-26-14-03-22.mp4`). It is held in memory until then, so a recording stops itself at 15 minutes (about 280 MB at 2.5 Mbit/s); the page asks before closing while one runs. A dropped stream records as black frames with "No camera signal", so the video keeps real time.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Low frame rate line | `dashboard/js/config.js` | `CAMERA_MIN_FPS = 15` |
| No-frame line | `dashboard/js/config.js` | `CAMERA_NO_FRAME_S = 3` (seconds) |
| USB check | `f1tenth_stack/system_diagnostics.py` | `camera()`, and the camera part of `_probe_slow()` |
| Picture size, frame rate, device | `launch/bringup_launch.py` | the `gst-launch-1.0` command; `camera_device` (default `/dev/video4`) |
| Ports | `f1tenth_stack/camera_http.py`, `dashboard/js/camera.js` | `GSTREAMER_PORT = 8081`, `HTTP_PORT = 8082`; `CAMERA_PORT = 8082` in the page |
| How much a slow viewer may queue | `f1tenth_stack/camera_http.py` | `SEND_BUFFER = 64 * 1024` (bytes, about two frames) |
| Retry timing | `dashboard/js/camera.js` | `CAMERA_RETRY_MIN_MS = 3000`, `CAMERA_RETRY_MAX_MS = 15000` |
| Recording | `dashboard/js/camera.js` | `RECORD_FPS = 30`, `RECORD_BITRATE = 2500000` (bits/s), `RECORD_MAX_MS` (15 minutes), `RECORD_TYPES` (formats tried, in order) |

### Speed and odometry

Shows how fast the car is going, and whether odometry is working.

**Where it comes from.** `vesc_to_odom_node` turns the motor's speed into a velocity and publishes `/odom` and `/tf`. The page reads `/odom`, field `twist.twist.linear.x`, in m/s (negative is reverse).

`vesc_to_odom_node` publishes nothing until it has seen one steering command. So after every bringup, `/odom` and `/tf` are silent on a healthy car until someone steers.

**How it is judged.** On the page. The Odometry row is red if the node is not running, or `/odom` is stale, silent or missing. Before the first steering command it is green, "Idle - odometry starts after the first steering command", and `/odom` and `/tf` show `IDLE`. The Speed tile goes stale if `/odom` stops for 2 seconds.

**What is sent.** `/odom`, field `twist.twist.linear.x`.

**On the page.** The Speed tile (MPH and m/s), the Odometry row, and the driving view's speed readout and speedometer, in the unit chosen in its Settings (m/s, km/h or mph; `SPEED_UNITS` in `dashboard/js/cockpit.js`).

**To change.** The Speed tile is `getSpeedMetric()` in `dashboard/js/metrics.js`; the row is the odometry part of `subsystemData()` in `dashboard/js/health.js`; the "waits for a steer" rule is `waitsForSteer` in `TOPICS` (`dashboard/js/config.js`) and `odomWaitingForSteer()` in `dashboard/js/health.js`.

---

### Controller

Shows whether the PS4 controller is connected and whether ROS can read it. The physical controller is the car's backup stop, so the page says plainly when there is none.

**Where it comes from.**

- `system_diagnostics` lists `/dev/input/js*` every second. That device exists only while a controller is attached, so a disconnect shows within a second.
- Every 10 seconds it runs `bluetoothctl devices` and `bluetoothctl info` to find a connected controller and its name.
- While a controller is attached, it also runs `joy_enumerate_devices` every 10 seconds. That lists the controllers ROS's `joy` driver can actually open. If the controller is attached but not listed, ROS cannot read it, which happens when the login user is not in the `input` group.
- The page reads `/joy`, fields `buttons[4]` (L1) and `buttons[5]` (R1), to know whether someone is holding a deadman button.

**How it is judged.** On the robot:

| Situation | Level |
|---|---|
| no controller | OK, "no controller connected" (idle is not a fault) |
| attached and connected over Bluetooth | OK, "connected" |
| attached, no Bluetooth link | yellow (also normal for a few seconds after connecting) |
| attached, but ROS cannot read it | red, "add the user to the input group" |

**Why these lines.** No controller is normal when nobody is driving. A controller ROS cannot read looks connected but can neither drive nor stop the car, so it is red. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**What is sent.** Report `system: Gamepad`, keys `js devices`, `bluetooth`, `device`, `battery %` (always "not exposed by this driver": the Jetson's kernel lacks the driver that reports a PS4 controller's charge); `/joy`, field `buttons`.

**On the page.** The Controller row in Subsystems, the controller chip in the driving view's top bar. **Run joystick check** (Advanced tab) runs the same `joy_enumerate_devices` check on demand and explains the result, usually in well under a second; the robot's log records how long each one took (`joystick_check: ... took 0.1s`). **Disconnect controller** (Drive tab) drops the Bluetooth link; the robot refuses while L1 or R1 is held, unless the emergency stop is on.

**To change.**

| What | File | Setting |
|---|---|---|
| How it is judged | `f1tenth_stack/system_diagnostics.py` | `gamepad()` |
| What is probed | `f1tenth_stack/system_diagnostics.py` | the gamepad part of `_probe_slow()` |
| Deadman buttons | `f1tenth_stack/system_diagnostics.py`, `dashboard/js/estop.js` | `JOY_DEADMEN = (4, 5)`; `JOY_L1 = 4`, `JOY_R1 = 5`. Both must match `config/joy_teleop.yaml` |
| Joystick check wording | `f1tenth_stack/system_diagnostics.py` | `joy_verdict()` |

The fix for "ROS cannot read it" is `sudo usermod -aG input <user>` on the robot, then log out and back in.

### Who is in control

Shows which input the car is listening to: nobody, the controller, or `/drive` (the page or an autonomous stack).

**Where it comes from.** `ackermann_mux` chooses between its inputs and publishes its own status on `/diagnostics`, including whether each input is `masked` (being ignored) or `unmasked`. An input that has been quiet for 0.2 s is masked (`config/mux.yaml`). Measured on robot 2: with the controller connected and nothing held, the mux already reports the joystick input as unmasked. So "Joystick" means the controller is connected and its input is live, not that a deadman is held.

**How it is judged.** On the page: joystick unmasked is "Joystick", otherwise navigation unmasked is "Navigation / web", otherwise "Idle". All three are green; only the mux not running is red.

**What is sent.** Report `ackermann_mux: Ackermann mux status`, keys `velocity topics.joystick` and `velocity topics.navigation`.

**On the page.** "Control" in the status banner, and the Control Mode row in Subsystems.

**To change.** `onDiagnostics()` in `dashboard/js/graph-data.js` reads the keys; the row is the control mode part of `subsystemData()` in `dashboard/js/health.js`.

### The driving view

The Drive tab and full screen are one view, built from panes: Camera, LiDAR and Controls. This entry is about how that view is laid out; the next one is about the driving itself.

**Where it lives.** On the Drive tab the view sits in the page, under the safety warning. Its **Full screen** button makes the same view cover the screen, and **Exit** (or Esc) puts it back. The Overview's camera buttons open it full screen directly: **Full screen** with the Camera layout, **Split** with the Watch layout. Opening it from the Overview does not change the Drive tab's own layout.

**Panes and layouts.** The pane buttons at the top turn Camera, LiDAR and Controls on or off. Panes sit side by side; drag the bar between two to resize them, and drag a pane's title over the left or right half of another to put it before or after that one (the half it will land in lights up; Esc cancels, and still stops the car). The layouts menu has Camera, Watch (camera and LiDAR), Drive (camera and controls), Drive + LiDAR, and LiDAR. Each layout keeps your own changes in the browser, and Reset puts it back.

**Desktop arrangement.** The controls float over the picture as a see-through card (drag its title to move it, the x to close it), or dock as a column beside the pictures (**Dock the controls**). The LiDAR can also float over the camera as a small window you can move and resize (**A small LiDAR window on the picture**), and has an x of its own; closing the only picture shows the camera instead, so there is always one. The "Very close" warning floats on the picture; drag it or hide it.

**The top bar.** Left: the driving state, health, battery, **Latency** (below), the controller, who is driving. Right: the pane buttons, **Record**, Settings, Full screen or Exit, hide, and Emergency stop last. Alerts get their own row only when there is one.

**The side rail.** Hiding the top bar (its hide button, or Settings) on a desktop moves the essentials into one column at the side, so the picture gets the whole height: state, health, battery, latency, the safety box, Arm, STOP, the speedometer, who is driving, the pane buttons, Rec, Settings, Full screen or Exit, Show bar, and E-stop at the bottom. Each rail button calls the same handler as the button it stands in for, so no driving rule is repeated. Settings → **Side rail** picks left or right. On phones, hiding the bar leaves a corner cluster instead: E-stop, Arm and Show.

**Latency.** Every 2 s while the view is open, the page calls rosapi's `get_time` and times the answer; the chip shows the median of the last five, green under 50 ms, amber from 50 ms, red from 120 ms. It is the round trip, so a command takes about half of it to reach the car. It hides when the service does not answer rather than show a guess.

**Settings** holds every "how it looks" option in one panel: the arrangement switches above, Hide the top bar, Side rail (left or right), Controls only (phones), the edge lights and the "Very close" warning, the LiDAR view, range and sweep line, speed units, keep the screen awake, buzz when something is very close (phones), thumb stick placement, reconnect camera, and **Reset all view settings**, which clears them all and reloads the page.

**Phones** (anything touch-first, or 900 px wide or less): one picture at a time, Camera and LiDAR taking turns (unless the LiDAR floats over the camera). Driving needs the phone sideways and full screen, so turning Controls on from the Drive tab opens full screen; the controls are then a steering stick, a throttle stick and STOP. Turning the phone upright disarms.

**Where it is saved.** All of these settings are kept per browser in `localStorage`, under the keys listed in `VIEW_KEYS` in `dashboard/js/cockpit.js`; another browser or device starts from the defaults.

**To change.**

| What | File | Setting |
|---|---|---|
| Ready-made layouts | `dashboard/js/cockpit.js` | `LAYOUTS` |
| What counts as a phone | `dashboard/js/cockpit.js` | `COCKPIT_TOUCH_QUERY` (touch-first, or 900 px wide or less) |
| Edge light directions | `dashboard/js/cockpit.js` | `COCKPIT_GLOW_SECTORS` |
| Speed units | `dashboard/js/cockpit.js` | `SPEED_UNITS` |
| Latency check and its colours | `dashboard/js/cockpit.js` | `LATENCY_EVERY_MS = 2000`, `LATENCY_WARN_MS = 50`, `LATENCY_BAD_MS = 120` |
| How far a title drag goes before it is a move | `dashboard/js/cockpit.js` | `PANE_DRAG_START_PX = 5` |
| Saved settings that Reset clears | `dashboard/js/cockpit.js` | `VIEW_KEYS` |
| The look (sizes, colours, the frosted style) | `dashboard/css/cockpit.css` | its contents list at the top |
| The markup (buttons, Settings panel) | `dashboard/dashboard.html` | the `cockpit` element |

### Driving from the page

Drives the car from a browser, through the same input an autonomous stack uses.

**Where it comes from.** The driving view's controls (the pad, the keys, or a phone's thumb sticks) set what the Drive tab's controller sends. It publishes `ackermann_msgs/AckermannDriveStamped` on `/drive`, the mux's navigation input, 50 times a second while armed and while the pad, a key or a stick is held, and at once whenever the input changes (a press, a drag, a release). The physical controller has a higher priority in the mux, so holding its deadman always overrides the page.

**The rules.**

- **Arming** needs a connection, the "area is clear" box ticked, no emergency stop, and nobody else sending on `/drive`.
- **Deadman.** Commands go out only while the pad, a key (W A S D or the arrows) or a stick is held. Letting go sends 5 zero-speed commands, which is what stops the car: the mux sends no zero of its own when an input goes quiet.
- **Ramping.** With the keys (all or nothing), speed rises at most 8 m/s per second (3 m/s in 0.38 s) and steering 8 rad per second. The pad and thumb sticks are proportional, so they ramp only lightly (20 m/s², 20 rad/s). Stopping is never ramped.
- **Bad values.** Any speed or steering that is not a number is sent as a stop.
- **Limits.** 3 m/s and 19° by default, always shown in the controls. Unlocking 5 m/s or 23.5° needs a warning dialog, and switches off again when you leave the Drive tab.
- **Closing the controls.** On a desktop it does not disarm: the keys keep driving (Space stops) as long as the Drive tab is underneath, and a note says so. On a phone the sticks and STOP go with the controls, so it disarms.
- **Disarming** happens on STOP, Space or Esc, leaving the Drive tab or the driving view, leaving full screen, the window losing focus or going to the background, the connection dropping, the emergency stop, arranging the sticks, resetting the view settings, and on a phone closing the controls or turning it upright.
- **Why the physical controller still feels quicker.** Its commands go over Bluetooth and never leave the car (about 20 ms from stick to motor, measured). The page's commands cross Wi-Fi and rosbridge first: usually 5 to 30 ms, with spikes of 100 ms or more when a packet is lost and resent. The page's own share is small (a key reaches a command in about 6 ms, measured in the browser); the **Latency** chip shows the rest.
- **Who is driving.** The page reads `/drive`'s publishers from rosapi and the messages' `header.frame_id`, so it can tell another page or an autonomous stack from itself, and ignore the watchdog's zeros (marked `"drive_watchdog"`).

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Default limits | `dashboard/js/drive.js` | `NORMAL_MAX_SPEED = 3.0` (m/s), `NORMAL_MAX_STEER = 0.34` (rad, 19°) |
| Unlocked limits | `dashboard/js/drive.js` | `HIGH_MAX_SPEED = 5.0`, `FULL_MAX_STEER = 0.41` (23.5°) |
| Ramping | `dashboard/js/drive.js` | `KEY_ACCEL = 8.0`, `KEY_STEER_RATE = 8.0` (keys); `PAD_ACCEL = 20.0`, `PAD_STEER_RATE = 20.0` (pad and sticks) |
| Command rate, stop burst | `dashboard/js/drive.js` | `DRIVE_HZ = 50`, `DRIVE_NOW_MIN_MS = 10`, `STOP_BURST = 5` |
| Keys | `dashboard/js/drive.js` | `KEY_FWD`, `KEY_BACK`, `KEY_LEFT`, `KEY_RIGHT` |
| When closing the controls disarms | `dashboard/js/cockpit.js` | the start of `applyPanes()` |

### Drive watchdog

Stops the car if the page loses its connection while driving.

**Where it comes from.** `system_diagnostics` subscribes to `/drive`. It notes the time and speed of every command that is not its own.

**How it works.** 20 times a second it checks: if the last command was moving and nothing has arrived for 0.3 s, it publishes 5 zero-speed commands on `/drive`, marked with `header.frame_id = "drive_watchdog"`. 0.3 s is longer than the mux's 0.2 s, so a publisher that is still working has already been switched away from before the watchdog would act. Measured on robot 6: zeros 0.31 to 0.51 s after the stream was cut.

**What is sent.** Zero-speed commands on `/drive`; report `system: Drive watchdog`, yellow for 60 seconds after it has stopped the car ("stopped the car at ...").

**On the page.** The Robot System list.

**To change.**

| What | File | Setting, current value |
|---|---|---|
| Delay | `f1tenth_stack/system_diagnostics.py` | `DRIVE_QUIET_S = 0.3` (keep it above the 0.2 s in `config/mux.yaml`) |
| Number of zeros | `f1tenth_stack/system_diagnostics.py` | `DRIVE_STOP_COUNT = 5` |
| Marker | `f1tenth_stack/system_diagnostics.py` and `dashboard/js/config.js` | `DRIVE_WATCHDOG_FRAME = "drive_watchdog"`, in both; they must match |

### Emergency stop

Stops the car for everyone (the controller, any page, autonomous code) until someone releases it.

**How it works.** The button calls the service `/system_diagnostics/emergency_stop`. On the robot, the node finds `ackermann_to_vesc_node` with `pgrep` and freezes it (`SIGSTOP`). Every input reaches the motor through that one node. The node then publishes speed 0 on `/commands/motor/speed` 50 times a second. Release calls `/system_diagnostics/emergency_release`, which unfreezes the node (`SIGCONT`); it is refused, on the page and on the robot, while anyone holds L1 or R1, so the car never resumes into a live command.

**What is sent.** Report `system: E-stop`: level 2 while on, with keys `since` and `action` (what the robot did, such as "froze ackermann_to_vesc_node (pid 1234)").

**On the page.** The red Emergency stop banner, on every open page, from that report.

**To change.** `emergency_stop()`, `emergency_release()` and `estop_hold()` in `f1tenth_stack/system_diagnostics.py`; `ESTOP_HZ = 50.0` for the hold rate; the page side is `dashboard/js/estop.js`.

---

### Nodes

Shows whether every node bringup should start is running.

**Where it comes from.** Every 5 seconds the page asks rosapi (`/rosapi/nodes`) for the running nodes. This is more reliable than `ros2 node list`. A node that was killed stays listed for 16 to 18 seconds, so a node's topics going quiet is the faster sign of trouble.

**How it is judged.** On the page, against `EXPECTED_NODES`: the 8 drive nodes plus `system_diagnostics`, `rosbridge_websocket`, `rosapi` and `rosapi_params`.

**Why these lines.** A missing node is a failed bringup, so there is no yellow. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**On the page.** "Nodes 12 / 12 up" in the banner, the ROS Graph card, and the Advanced tab's node table.

**To change.** `EXPECTED_NODES` in `dashboard/js/config.js`, whenever bringup gains or loses a node; `GRAPH_POLL_MS = 5000` for how often.

### Topics

Shows whether each topic is publishing as it should.

**Where it comes from.** Every 5 seconds the page asks rosapi which topics exist (`/rosapi/topics`) and who publishes each one (`/rosapi/publishers`). It subscribes to every topic in `TOPICS` at most 5 times a second, just to see messages arrive, and to `/diagnostics` on every message.

**How it is judged.** On the page. Each topic has a class, and the class decides what silence means:

| Class | Examples | Silence means |
|---|---|---|
| `continuous` | `/scan`, `/odom`, `/sensors/core`, `/tf`, `/diagnostics` | a fault |
| `event` | `/joy`, `/teleop`, `/ackermann_cmd`, `/commands/*` | nothing; they publish only when someone drives |
| `latched` | `/tf_static` | nothing; sent once at startup |
| `input` | `/drive`, `/commands/motor/brake` | nothing; the stack listens to these |

A continuous topic with no message for 2 seconds is `STALE`; one with a publisher that never sent anything is `SILENT`. Slow topics are yellow. `STALE`, `SILENT`, not-advertised (the node runs but never created the topic, usually because it could not open its device), `MISSING` (not in the graph) and no-publisher topics are red.

**Why these lines.** A single "silence is a fault" rule flagged 16 of 23 topics on a healthy car, so each topic has a class. With the classes, only topics that publish on a timer can be `STALE`: one that sends once is latched, and one that only sends while someone drives is an event, so neither is ever red for being quiet. That makes a stopped topic a real fault, so it is red. On a healthy car (robot 6), every listed topic is advertised by its node. Signed off by the professor as a starting value; see [Ranges](#ranges-what-is-green-yellow-and-red).

**On the page.** Key topics in the ROS Graph card, and the Advanced tab's topic table (click a row to see its live message).

**To change.** `TOPICS` in `dashboard/js/config.js` (add a topic, set its class); `STALE_MS = 2000`; `classifyTopic()` in `dashboard/js/graph-data.js` for the states.

### Subsystems and the headline

Sums everything up at the top of the page.

**How it is judged.** On the page. Seven subsystems (Controller, VESC, LiDAR, Odometry, Camera, Battery, Control Mode), each judged as described above. The headline shows the worst: Failed beats Degraded beats unconfirmed beats Healthy. The line under it names the subsystems at fault. With no rosbridge connection it says NOT CONNECTED instead, since nothing can be judged.

**On the page.** The status banner and the Subsystems table (problems first; the battery is in its own card rather than a row).

**To change.** `subsystemData()` and `renderOverall()` in `dashboard/js/health.js`.

### Connection warnings

Tells you when what you see may be out of date, and why.

**How it works.** On the page, from what arrives over the websocket:

- **Nothing at all for 4 seconds** (`CONNECTION_STALE_MS`): a red bar, the robot went quiet.
- **Services answer, but no topic data for 8 seconds** (`PUBLISH_STALE_MS`): an orange bar. rosbridge serves only 10 clients, and this page is one too many. Close another dashboard tab.
- **More than 10 clients** (`/client_count`, field `data`): an orange bar saying some dashboards receive nothing. `/client_count` is only sent when the number changes, so a page that joined later may show a dash instead of a number.

**On the page.** The bars at the top, and "Connected: N people" in the banner.

**To change.** `CONNECTION_STALE_MS`, `PUBLISH_STALE_MS` and `CLIENT_LIMIT` in `dashboard/js/config.js`; `dashboard/js/checks.js`.

### Robot name and clock

**Where it comes from.** `system_diagnostics` reports the robot's login name (for example `f1-wsu-6`), from Python's `getpass.getuser()`; every robot's hostname is `ubuntu`, so the login is what tells them apart. Every 10 seconds it runs `timedatectl show` to check the clock is synchronised.

**How it is judged.** On the robot: synchronised is OK, not synchronised is yellow.

**What is sent.** Report `system: Clock`, keys `Robot`, `NTPSynchronized`, `Timezone`, `NTP`.

**On the page.** "Robot: f1-wsu-6" in the footer; the rest in the Robot System list.

**To change.** `clock()` in `f1tenth_stack/system_diagnostics.py`.

### ROS warnings and errors

**Where it comes from.** Every ROS node logs to `/rosout`. The page reads `level`, `name` and `msg`, and keeps warnings, errors and fatal messages (level 30 and up).

**On the page.** The ROS Warnings / Errors list on the Advanced tab.

**To change.** `onLog()` in `dashboard/js/graph-data.js`.

---

## Dead ends: things we tried that don't work

Written down so nobody spends a session re-checking them. Each one was tried on the cars.

- **Reading the controller's battery.** Only the `hid_sony` kernel driver exposes a PS4 controller's charge, and NVIDIA's Jetson kernel does not include it (`modprobe hid_sony` fails). `upower` sees nothing, and over Bluetooth the controller advertises no battery service. The two ways that could work, building `hid_sony` for the Jetson kernel or reading `/dev/hidraw*` directly, both risk changing how the sticks and buttons are read, which steering depends on. Tools like `ds4drv` add a second joystick device, so `joy` may pick the wrong one. The page says "not exposed by this driver".
- **The controller's blinking light bar.** With this driver it blinks forever, whether or not the controller works. It says nothing about the connection.
- **VESC temperatures reading 0.0.** Not a dead sensor: `vesc_driver` never copied `temp_fet` and `temp_motor` into the message (the two-line patch fixes it). After the fix, `temp_motor` reads about -74 C because the motors have no sensor fitted, and `ntc_temp_mos1/2/3` stay 0.0 because this board has none. `temperature_pcb`, named in older notes, does not exist in the message. A value that never changes is not a reading: check that something writes a field before calling the sensor dead.
- **`/joy` silent while `jstest /dev/input/js0` works.** `joy` reads `/dev/input/event*`, not `js0`, and over NoMachine only the login screen gets permission to read it. The fix is the `input` group. `ros2 run joy joy_enumerate_devices` shows it in one command: zero rows while `jstest` works means this.
- **`ros2 node list`.** With and without the daemon (`--no-daemon`), it has listed too few nodes on a running car. The page asks rosapi instead, which has been right every time.
- **Raising rosbridge's 10-client limit.** There is no setting for it. Client 11 connects and gets nothing; close a tab instead, and it recovers within 30 seconds. Subscribing to `/scan` with no throttle once jammed rosbridge until it was restarted, so the page always throttles.
- **The camera through ROS.** `realsense2_camera` has no compressed topics, and a raw colour frame is about 2.7 MB (83 MB/s), far too much for Wi-Fi and rosbridge. Only one program can open the RealSense at a time, so the ROS camera node and the GStreamer stream cannot both run. That is why the camera skips ROS.
- **"Fixing" the `/ackermann_drive` remap in `bringup_launch.py`.** The remap (`ackermann_cmd_out` to `ackermann_drive`) does nothing, because the mux publishes on `ackermann_cmd`. Changing it to rename `ackermann_cmd` would move the mux's output away from `ackermann_to_vesc_node`, which listens on `ackermann_cmd`, and the car would silently stop driving. If anyone cleans it up, delete the line.
- **Treating `config/mux.yaml`'s 0.2 s timeout as a stop delay.** It only decides when a quiet input stops counting for priority. Commands pass through the mux in about 0.2 ms, and nothing sends a zero when an input goes quiet. That is why the page sends zeros when you let go, and why the drive watchdog exists.
- **One "has it published lately?" rule for every topic.** It flagged 16 of 23 topics on a healthy car. Topic classes fixed it (see [Topics](#topics)).
- **Measuring topic rates from a laptop.** Over Wi-Fi, the 40 and 50 Hz topics read about 30 Hz. Measure on the robot, or use the rate a node reports itself, as `urg_node` does on `/diagnostics`.
- **`ros2 topic echo /diagnostics --once`.** It prints one publisher's message, and three nodes publish there. Use `--times 10`, or the page.
- **Running a tool with `ros2 run` from inside a node.** `ros2 run` starts the whole `ros2` command-line tool first, which on the Jetson is slow the first time after a bringup. The joystick check used it, and its first click after a bringup took longer than the page's 12 seconds and showed "timeout" even though the robot answered. Run the program directly instead: `system_diagnostics` finds `joy_enumerate_devices` under `AMENT_PREFIX_PATH` at startup.
- **A launch argument named `port`.** Launch arguments are shared with included launch files, and rosbridge's already has `port`. Rosbridge took port 8000, lost it to the web server, and failed with "Address already in use" while nothing was on 9090. That is why the web server's is `dashboard_port`.

## What it can do to the car

Apart from these, the page only reads. Each links to its full entry above.

- **[Emergency stop](#emergency-stop)** stops the car for everyone, including whoever holds the physical controller. Every input reaches the motor through `ackermann_to_vesc_node`, so `system_diagnostics` freezes that node and commands speed 0 at 50 Hz. A red banner shows on every open page until someone presses **Release**, which is refused while L1 or R1 is held, so the car never resumes into a live command.
- **[Driving from the page](#driving-from-the-page)** (Drive tab, or full screen) publishes to `/drive`, the mux's navigation input, 50 times a second, only while armed ("area is clear" ticked) and while a key, the pad or a phone's thumb stick is held. Letting go sends 5 zero-speed commands. 3 m/s and 19 degrees by default; 5 m/s and 23.5 degrees need a warning dialog. The physical controller has a higher priority in the mux, so holding its deadman always wins. L1 is the deadman for manual driving, R1 for autonomous (`/drive`).
- **The [drive watchdog](#drive-watchdog)** stops the car if the page loses its connection mid-drive: if the last `/drive` command was moving and nothing arrives for 0.3 s, `system_diagnostics` sends 5 zeros, marked `header.frame_id = "drive_watchdog"`. Measured on robot 6: zeros 0.31 to 0.51 s after the link was cut. 0.3 s is longer than the mux's 0.2 s timeout, so it never cuts off a publisher that is still working.
- **Disconnect controller** ([Controller](#controller)) drops the controller's Bluetooth link. Refused while L1 or R1 is held.
- **Run joystick check** (Advanced tab, [Controller](#controller)) tells apart the three causes of a silent `/joy`: no controller, a working one, or one ROS has no permission to read.

## Changing things

| What | File |
|---|---|
| Page thresholds, timings, expected nodes, topic classes | `dashboard/js/config.js` |
| Tiles (CPU, RAM, GPU, Temperature, Network, Speed) and the lidar plot | `dashboard/js/metrics.js` |
| Subsystems and the banner | `dashboard/js/health.js` |
| Driving: limits, ramping, keys | `dashboard/js/drive.js` |
| The driving view's layout and settings | `dashboard/js/cockpit.js` |
| The robot list in the top bar | `ROBOTS` in `dashboard/js/config.js` |
| The look of each part of the page | `dashboard/css/` (one file per area; `dashboard/css/README.md` says what is where) |
| Checks that need no robot | `dashboard/tests/` (`node dashboard/tests/run.mjs`) |
| Robot-side checks, their thresholds, emergency stop and watchdog | `f1tenth_stack/system_diagnostics.py` |
| Camera proxy | `f1tenth_stack/camera_http.py` |
| What starts with bringup, launch arguments, ports | `launch/bringup_launch.py` |
| Which dashboard files get installed | `setup.py` (`data_files`) |

The scripts in `dashboard/js/` share one scope, so **the load order in `dashboard.html` matters**: `config.js` first, `main.js` last. `setup.py` installs `dashboard/*.html`, `dashboard/css/*.css` and `dashboard/js/*.js`, so a new folder or file type needs a line there.

**The robot runs `~/f1tenth_ws/install/`, not `src/`.** Edit in `~/f1tenth_ws/src/f1tenth_system/f1tenth_stack`, then:

| You changed | Run | Then |
|---|---|---|
| `dashboard/` (HTML, CSS, JS) | `cd ~/f1tenth_ws && colcon build --packages-select f1tenth_stack` | Hard-refresh the browser (Ctrl+Shift+R). No restart |
| `f1tenth_stack/system_diagnostics.py`, `camera_http.py` | the same build | Restart bringup |
| `launch/bringup_launch.py`, `config/*.yaml`, `maps/` | the same build | Restart bringup |
| `setup.py` (a new file type or program) | the same build | Restart bringup, from a new terminal |

To change it for every car, commit it to `f1tenth_system`; the other cars get it with `git pull` and the same build. Run `node dashboard/tests/run.mjs` first.

The package also has the three lint tests every new ROS 2 package gets from its template (`test/test_flake8.py`, `test_pep257.py`, `test_copyright.py`), run with `colcon test --packages-select f1tenth_stack`. Nothing runs them automatically. The dashboard's Python files (`system_diagnostics.py`, `camera_http.py`) pass flake8 and pep257; the copyright test fails on every Python file in the package, the original ones included, because none has a header it recognises.

**Changing a compiled driver, like `vesc_driver`** (C++, in the `vesc` submodule): edit it under `~/f1tenth_ws/src/f1tenth_system/vesc`, then

```bash
cd ~/f1tenth_ws && colcon build --packages-select vesc_driver --allow-overriding vesc_driver --parallel-workers 1
```

and restart bringup. `--allow-overriding` is needed because `.bashrc` sources this workspace's own `install/`, and `--parallel-workers 1` because the Jetson runs out of memory compiling in parallel. To change it for every car, the change goes to `Weber-AGV/vesc`, and `f1tenth_system` then points at the new commit.

## Troubleshooting

**Status dot stays red.** rosbridge is not reachable. On the robot, `ss -tlnp | grep 9090`. If nothing is listening, restart bringup and watch its output for rosbridge errors.

**The page connects but every topic reads SILENT, with an orange bar.** This browser is past rosbridge's 10-client limit. Close another dashboard tab; do not restart anything. It recovers on its own within 30 seconds.

**Nodes look missing that are definitely running.** `ros2 node list` is unreliable (the daemon caches a stale view, and `--no-daemon` misses slow nodes). The page asks rosapi, which has been right every time.

**The CPU, RAM, GPU, Temperature and Network tiles say "waiting for system_diagnostics".** The node is not running. Look for it in the Nodes table and in bringup's output.

**LiDAR is red with "2 lidar drivers are publishing /scan".** A `urg_node` left over from an earlier run holds the lidar's only connection. Stop bringup, `pkill -f urg_node_driver`, start bringup again.

**LiDAR is red and the Network tile's Lidar row says "unplugged" or "no reply".** Unplugged is the Ethernet cable; no reply with the cable in is usually the lidar's power.

**The controller is red with "add the user to the input group".** `sudo usermod -aG input $USER`, then log out and back in (shells already open, including one running bringup, keep their old groups).

**FET (VESC) shows "no reading".** This car's VESC driver lacks the temperature patch (see [Known gaps](#known-gaps)).

**The camera stays dark.** Check `camera_device` (`v4l2-ctl --list-devices`) and that nothing else, such as the `cam` alias, has the camera open.

**The page looks old after an update.** Hard-refresh with Ctrl+Shift+R.

## Known gaps

- **rosbridge has no authentication.** Anyone who can reach port 9090 can publish to the robot, including `/drive`.
- **rosbridge serves exactly 10 clients.** Number 11 connects and receives nothing, which looks like a dead robot; the page detects it and shows an orange bar. Every open dashboard tab is a client.
- **The FET temperature needs a two-line VESC driver patch** (`temp_fet` and `temp_motor` copied into `/sensors/core`). It is not in `Weber-AGV/vesc` yet. The motor has no temperature sensor fitted and reads about -74 C, which the page treats as "no sensor".
- **The controller's battery cannot be read.** The Jetson's kernel lacks the driver (`hid_sony`) that reports a PS4 controller's charge.
- **Reboot detection cannot fire on a real reboot**, because a reboot restarts `system_diagnostics` too. An uptime of a few minutes that nobody expected is the sign; on these cars it usually means the battery dipped.

## Who built this

The Weber State CS 4850 robot diagnostics team: Alex ([@AlexStapp](https://github.com/AlexStapp)), Darrin ([@dbrack13](https://github.com/dbrack13)), Luke ([@hqluke](https://github.com/hqluke)) and Saman ([@samanchapagain](https://github.com/samanchapagain)), under the direction of Professor Scott Hadzik ([@scotthadzik](https://github.com/scotthadzik)). It started as the team's own prototype; what that work measured and decided (the rates, the topic classes, the ranges and why, and the dead ends) is written into this README and the guides.
