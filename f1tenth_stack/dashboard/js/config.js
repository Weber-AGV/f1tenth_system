"use strict";

const $ = id => document.getElementById(id);

/* ==========================================================
   CONFIG
========================================================== */

const UI_MS = 500;
const GRAPH_POLL_MS = 5000;

const STALE_MS = 2000;
const CONNECTION_STALE_MS = 4000;

/* NEVER subscribe unthrottled — /scan is ~780 KB/s and will
   wedge rosbridge for every other client. */
const LIVENESS_THROTTLE = 200;

/* An expanded row resubscribes faster so the values move. */
const DETAIL_THROTTLE = 100;

/* rosbridge serves exactly this many clients at once
   (measured 2026-09-16: 5/5, 10/10, 10 of 15, 10 of 25).
   Number 11 connects, is counted, and is fed nothing. */
const CLIENT_LIMIT = 10;

/* No topic data for this long, while rosbridge is still
   answering service calls, is the signature of being one of
   the starved clients. It is NOT the robot going quiet, and it
   needs a different fix, so it gets its own banner. */
const PUBLISH_STALE_MS = 8000;

/* Battery lines signed off with the professor (the
   "Ranges" table in dashboard/README.md). Yellow below 11.6 V is a buffer: the
   pack still runs fine, get a replacement ready. Red below 11.1 V (3.7 V
   per cell) means replace the pack soon - a run-down test showed the
   pack falls off a cliff below about 10 V. The % estimate runs from
   BATT_ERR (0%, replace the pack) to BATT_FULL (100%). */
const BATT_WARN = 11.6;
const BATT_ERR = 11.1;
const BATT_FULL = 12.6;

/* The voltage sags 0.1 to 0.2 V within a second under throttle, so it
   is judged (and shown) as the median of this window, not per sample;
   per sample, a pack near a line flickers between colours. */
const BATT_WINDOW_MS = 5000;

/* VESC FET temperature. Measured idle 31.4 °C; the controller's
   own OVER_TEMP_FET fault trips near 85 °C. */
const FET_WARN = 65;
const FET_ERR = 80;

/* temp_motor has no thermistor fitted on this car and reads
   about -74 °C, the open-circuit value. Anything below this is
   "no sensor", never a temperature. */
const MOTOR_ABSENT = -20;

/* Wi-Fi ranges signed off in #6 (conventions; measured -41 to -43 dBm,
   0% loss, 1.4 to 3.2 ms round trip to the gateway). */
const WIFI_SIGNAL_WARN = -67;   // dBm: yellow below, red below WIFI_SIGNAL_ERR
const WIFI_SIGNAL_ERR = -75;
const WIFI_LOSS_WARN = 1;       // % packet loss to the gateway
const WIFI_LOSS_ERR = 5;
const WIFI_RTT_WARN = 30;       // ms round trip to the gateway
const WIFI_RTT_ERR = 100;

/* The camera stream runs at 30 fps; under half of that is yellow, and no
   frame for CAMERA_NO_FRAME_S seconds is red (#6). From camera_http /stats. */
const CAMERA_MIN_FPS = 15;
const CAMERA_NO_FRAME_S = 3;

/* header.frame_id on the robot's drive watchdog zeros */
const DRIVE_WATCHDOG_FRAME = "drive_watchdog";

const SYS_PREFIX = "system: ";

const SYS_ORDER = [
  "E-stop",
  "Drive watchdog",
  "Thermal",
  "Power",
  "CPU",
  "GPU",
  "Memory",
  "Storage",
  "Network",
  "VESC device",
  "Camera",
  "Gamepad",
  "Clock"
];

const JOY_SERVICE = "/system_diagnostics/joystick_check";

const EXPECTED_NODES = [
  "/joy",
  "/joy_teleop",
  "/ackermann_to_vesc_node",
  "/vesc_to_odom_node",
  "/vesc_driver_node",
  "/urg_node",
  "/ackermann_mux",
  "/static_baselink_to_laser",
  /* As of the f1tenth_stack integration (2026-10-05) these four come up
     with every bringup too, not just when start_diagnostics.sh was run
     separately - and the dashboard itself is useless without them, so
     they're as "expected" as the drive-stack nodes above. */
  "/system_diagnostics",
  "/rosbridge_websocket",
  "/rosapi",
  "/rosapi_params"
];

/* Topic classes. A single liveness rule flags ~16 of 23 topics
   as broken on a healthy car; these four classes take that to
   zero.
     continuous — publishes on a clock. Silence is a fault.
     event      — publishes only on operator/nav input.
                  Silence at rest is NORMAL.
     latched    — transient-local, sent once. Age is meaningless.
     input      — the stack SUBSCRIBES to it. Zero publishers is
                  correct. */
const CONTINUOUS = "continuous";
const EVENT = "event";
const LATCHED = "latched";
const INPUT = "input";

const TOPICS = {
  "/scan": {
    cls: CONTINUOUS,
    owner: "/urg_node",
    sub: "S-12"
  },

  "/odom": {
    cls: CONTINUOUS,
    owner: "/vesc_to_odom_node",
    sub: "S-15",
    waitsForSteer: true
  },

  "/sensors/core": {
    cls: CONTINUOUS,
    owner: "/vesc_driver_node",
    sub: "S-01/09/10"
  },

  "/sensors/imu": {
    cls: CONTINUOUS,
    owner: "/vesc_driver_node",
    sub: "S-13"
  },

  "/sensors/imu/raw": {
    cls: CONTINUOUS,
    owner: "/vesc_driver_node",
    sub: "S-13"
  },

  "/tf": {
    cls: CONTINUOUS,
    owner: "/vesc_to_odom_node",
    sub: "S-20",
    waitsForSteer: true
  },

  "/diagnostics": {
    cls: CONTINUOUS,
    owner: "/urg_node",
    node: "urg_node, ackermann_mux"
  },

  "/tf_static": {
    cls: LATCHED,
    owner: "/static_baselink_to_laser",
    sub: "S-20"
  },

  /* NOTE: the real mux output is /ackermann_cmd. The remap to
     /ackermann_drive in bringup_launch.py appears to be a
     no-op — that topic does not exist. */
  "/ackermann_cmd": {
    cls: EVENT,
    owner: "/ackermann_mux",
    sub: "S-22"
  },

  "/joy": {
    cls: EVENT,
    owner: "/joy",
    sub: "S-18"
  },

  "/teleop": {
    cls: EVENT,
    owner: "/joy_teleop",
    sub: "S-03"
  },

  "/commands/motor/speed": {
    cls: EVENT,
    owner: "/ackermann_to_vesc_node"
  },

  "/commands/servo/position": {
    cls: EVENT,
    owner: "/ackermann_to_vesc_node"
  },

  "/sensors/servo_position_command": {
    cls: EVENT,
    owner: "/vesc_driver_node"
  },

  "/laser_status": {
    cls: EVENT,
    owner: "/urg_node",
    sub: "S-12"
  },

  "/drive": {
    cls: INPUT,
    node: "nav stack, not running",
    sub: "S-23"
  },

  "/commands/motor/brake": {
    cls: INPUT,
    node: "vesc_driver subscribes"
  },

  "/commands/motor/current": {
    cls: INPUT,
    node: "vesc_driver subscribes"
  },

  "/commands/motor/duty_cycle": {
    cls: INPUT,
    node: "vesc_driver subscribes"
  },

  "/commands/motor/position": {
    cls: INPUT,
    node: "vesc_driver subscribes"
  },

  "/joy/set_feedback": {
    cls: INPUT,
    node: "joy subscribes"
  }
};

const BAD_TOPIC_STATES = new Set([
  "SILENT",
  "STALE",
  "SLOW",
  "NODE_DOWN",
  "MISSING",
  "NOT_ADVERTISED"
]);

const FAULTS = {
  0: "NONE",
  1: "OVER_VOLTAGE",
  2: "UNDER_VOLTAGE",
  3: "DRV8302",
  4: "ABS_OVER_CURRENT",
  5: "OVER_TEMP_FET",
  6: "OVER_TEMP_MOTOR"
};

/* ==========================================================
   STATE
========================================================== */

let ws = null;
let sequence = 0;

const pending = new Map();
const topics = new Map();
const subscribed = new Set();

let runningNodes = new Set();
let diag = {};
let vesc = null;
let mux = null;
let scanStats = null;

/* The raw message behind scanStats, kept for the radar plot. Safe
   to hold a reference — it's replaced wholesale every callback,
   never mutated, and arrives at the 200ms liveness throttle, not
   the sensor's real 40 Hz. */
let lastScan = null;

/* The last ~1.5 s of scans ({at, ranges}), so the plot can draw
   where things were a second ago and the readouts can say whether
   something is getting closer. Same throttled 5 Hz feed, so this
   is a handful of arrays, never more. */
const scanHistory = [];
const SCAN_HISTORY_MS = 1500;
const SCAN_GHOST_MS = 1000;

let lastAnything = 0;

/* When the robot's drive watchdog last sent zeros on /drive, so the page
   does not mistake them for someone else driving. */
let lastWatchdogStop = -Infinity;

/* Tracked apart from lastAnything, which service responses also
   refresh — see PUBLISH_STALE_MS. */
let lastPublish = 0;
let connectedAt = 0;
let clients = null;

let totalGraphTopics = 0;

let logStarted = false;

const expanded = new Set();     // topics whose row is open
const latestMsg = new Map();    // topic -> newest msg, only while open
const rowEls = new Map();       // topic -> the row's live elements

let tableKey = "";              // rebuild the table only when the
                                // topic set itself changes

/* ==========================================================
   ROBOTS - the connect dropdown in the top bar
   Each car's rosbridge. Change a name or address here; the
   address box beside the dropdown also takes any other one.
========================================================== */

const ROBOTS = Array.from({ length: 12 }, (_, i) => ({
  name: `F1-WSU-${i + 1}`,
  url: `ws://192.168.1.${201 + i}:9090`
}));
