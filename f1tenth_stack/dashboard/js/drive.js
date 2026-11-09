"use strict";

/* Virtual controller: drive the car from the browser. */

/* ==========================================================
   VIRTUAL CONTROLLER

   Publishes ackermann_msgs/AckermannDriveStamped on /drive, the
   ackermann_mux NAVIGATION input, over the same rosbridge socket
   the rest of the page uses. Three properties keep it safe:

   1. Dead-man. Commands go out only while the pad or a drive key
      is physically held. Let go and the page sends a short burst
      of zero-speed commands, then goes silent. That burst is what
      stops the car: ackermann_mux forwards message by message and
      sends no zero of its own when an input goes quiet (see
      tools/estop_capture.py). If the link dies mid-drive, no zero
      arrives from here; system_diagnostics.py's drive watchdog sends
      the zeros instead, 0.3 s after /drive goes quiet.
   2. Priority. The physical joystick is the mux's higher-priority
      input, so holding its deadman always overrides this page.
   3. Disarm on anything unexpected: STOP / Space / Esc, leaving
      the tab, the window losing focus, the page going to the
      background, the socket closing or being replaced.

   rosbridge has no authentication (see README) — anyone who can
   reach port 9090 can already publish /drive. This page does not
   change that; it just makes the button visible.
========================================================== */

const DRIVE_TOPIC = "/drive";
const DRIVE_TYPE = "ackermann_msgs/msg/AckermannDriveStamped";

/* 50 commands a second while held, about the physical controller's
   own rate (/joy measured at ~48 Hz). It was 20: up to 50 ms between
   a thumb moving and the car hearing it, and visibly coarser steps. */
const DRIVE_HZ = 50;

/* An input change (a key, a press, a drag) sends at once instead of
   waiting for the next tick - a release is a stop, and it should not
   wait. Pointer moves come faster than any useful rate, so at most one
   extra command per this many ms. */
const DRIVE_NOW_MIN_MS = 10;

/* Ramps. The keys are all or nothing, so their speed builds up rather
   than asking the VESC for a jump from 0 to full in one message. The
   pad and the thumb sticks are proportional, like the controller's
   stick: your thumb is the ramp, and the page follows it almost at
   once, only smoothing out jitter - the controller goes through no
   ramp at all. Releasing is never ramped: stop is always immediate.

   Was 5 m/s² and 2.5 rad/s for everything: 0.57 s to full speed and
   0.13 s to full steering even on the pad, which read as lag next to
   the controller. */
const KEY_ACCEL = 8.0;          // m/s per second: 3 m/s in 0.38 s
const KEY_STEER_RATE = 8.0;     // rad per second: full lock in about 40 ms
const PAD_ACCEL = 20.0;         // m/s per second: 3 m/s in 0.15 s
const PAD_STEER_RATE = 20.0;    // rad per second: full lock in about 17 ms

/* zero-speed commands sent after release, so the last thing the
   mux saw is "stop" rather than whatever was held */
const STOP_BURST = 5;

/* Gamepad sticks (Steam Deck, or any pad the browser maps as
   "standard"): left stick up/down is speed, right stick left/right is
   steering. Only standard-mapped pads are read, so the axis numbers
   below mean what they say; B stops. Like the on-screen pad, the stick
   is proportional and deflecting it is the dead-man: centre it and the
   car stops. */
const STICK_DEADZONE = 0.15;
const STICK_AXIS_SPEED = 1;     // left stick, vertical
const STICK_AXIS_STEER = 2;     // right stick, horizontal
const STICK_BTN_STOP = 1;       // B

let driveArmed = false;

/* An autonomous run from this page: drive at a set speed and steering with
   nothing held, until stopped or the time is up - what
   `ros2 topic pub /drive ... -r 10` does on the car, but from here, so it
   ends with the page (the robot's drive watchdog stops the car 0.3 s after
   /drive goes quiet). Every disarm ends it. */
const autoRun = { on: false, until: 0, startedAt: 0, byR1: false };

/* Hold R1 to run: R1 on the controller is the run's deadman. It has to
   stay down half a second before the car moves, so a tap - or an R1 that
   flickers by itself, as one of the pads does - cannot start it. Any
   reading of R1 up stops the car at once, and so does /joy going quiet.
   An R1 that has been flickering in the last 2 s cannot start it either. */
const R1_HOLD_MS = 500;
const R1_FRESH_MS = 250;        // /joy runs at ~48 Hz while this mode has it at full rate
let r1Since = 0;                // when R1 went down and stayed down; 0 while up
let r1Tried = false;            // this hold has already tried to start
let r1Last = null;              // the tick's last r1Input(), for the panel
let driveSocket = null;
let padHeld = false;
let stickHeld = false;
let stickKnobShown = false;
let stickStatus = "";
let padVec = { x: 0, y: 0 };
let cmdSpeed = 0;
let cmdSteer = 0;
let stopBurst = 0;
let lastDriveTick = performance.now();
let driveFrame = DASHBOARD_MANUAL_FRAME;   // what the next command is: by hand, or a run

/* When this page last sent a /drive command, and when it last stopped
   advertising — so commands and publishers that are NOT ours can be
   told apart from our own echo. */
let lastOwnSend = 0;
let lastOwnUnadvertise = -Infinity;   // never, until we disarm

/* Limits. Past the NORMAL values needs an unlock with a warning,
   which re-locks when you leave the tab or reload. */
const NORMAL_MAX_SPEED = 3.0;   // m/s — also the default
const HIGH_MAX_SPEED = 5.0;     // m/s
let highSpeed = false;

const NORMAL_MAX_STEER = 0.34;  // rad, 19° — stock joy_teleop limit, the default
const FULL_MAX_STEER = 0.41;    // rad, 23.5°
let fullSteer = false;

const driveKeys = new Set();
/* fixed 4 m: while driving, what matters is what is close */
const driveRadarScale = { ...newRadarScale(), mode: "fixed", range: 4 };

const KEY_FWD = new Set(["w", "arrowup"]);
const KEY_BACK = new Set(["s", "arrowdown"]);
const KEY_LEFT = new Set(["a", "arrowleft"]);
const KEY_RIGHT = new Set(["d", "arrowright"]);

function socketOpen() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function driveTabVisible() {
  return !$("panelDrive").hidden;
}

function limitSpeed() {
  return parseFloat($("maxSpeed").value);
}

function limitSteer() {
  return parseFloat($("maxSteer").value);
}

function publishDrive(speed, steer) {

  /* never send the car a number that is not one: anything odd is a stop */
  if (!Number.isFinite(speed) || !Number.isFinite(steer)) {
    speed = 0;
    steer = 0;
  }

  const now = Date.now();

  lastOwnSend = performance.now();

  send({
    op: "publish",
    topic: DRIVE_TOPIC,
    msg: {
      header: {
        stamp: {
          sec: Math.floor(now / 1000),
          nanosec: (now % 1000) * 1e6
        },
        frame_id: driveFrame
      },
      drive: {
        steering_angle: steer,
        steering_angle_velocity: 0,
        speed,
        acceleration: 0,
        jerk: 0
      }
    }
  });
}

/* ---------- arm / disarm ---------- */

function armDrive() {

  if (!socketOpen()) {
    setDriveNote("Connect to rosbridge first.");
    return;
  }

  if (!$("driveConfirm").checked) return;

  if (estopActive()) {
    setDriveNote("The emergency stop is on. Release it at the top of the page first.");
    return;
  }

  if (foreignDriveActive()) {
    setDriveNote(
      "Someone else is sending drive commands right now. " +
      "Wait until they stop, or ask them to disarm.");
    return;
  }

  send({
    op: "advertise",
    topic: DRIVE_TOPIC,
    type: DRIVE_TYPE
  });

  driveArmed = true;
  driveSocket = ws;

  setDriveNote("Armed. Hold the pad, a drive key or a stick to move.");
  renderDriveControls();
}

function disarmDrive(reason) {

  /* any disarm ends an autonomous run */
  const endedRun = autoRun.on;

  if (autoRun.on) {
    autoRun.on = false;
    autoRun.byR1 = false;
    autoRunNote = reason ? "Autonomous run ended - " + reason + "." : "Autonomous run ended.";
  }

  const wasLive =
    driveArmed || cmdSpeed !== 0 || cmdSteer !== 0;

  /* stop NOW, don't wait for the next tick */
  if (wasLive && socketOpen()) {
    for (let i = 0; i < 3; i++) publishDrive(0, 0);
  }

  if (driveArmed && socketOpen()) {
    send({ op: "unadvertise", topic: DRIVE_TOPIC });
    lastOwnUnadvertise = performance.now();
  }

  driveArmed = false;
  driveSocket = null;
  padHeld = false;
  stickHeld = false;
  padVec = { x: 0, y: 0 };
  driveKeys.clear();
  cmdSpeed = 0;
  cmdSteer = 0;
  stopBurst = 0;

  placeKnob(0, 0);

  if (wasLive && reason) {
    setDriveNote("Disarmed — " + reason + ".");
  }

  renderDriveControls();
  if (endedRun) renderAutoPanel();
}

function setDriveNote(text) {
  $("driveNote").textContent = text;
}

/* ---------- the 50 Hz loop ---------- */

function towards(current, target, maxStep) {

  if (Math.abs(target - current) <= maxStep) return target;

  return current + Math.sign(target - current) * maxStep;
}

function keyAxis(positive, negative) {

  const has = set => [...driveKeys].some(key => set.has(key));

  return (has(positive) ? 1 : 0) - (has(negative) ? 1 : 0);
}

/* Rescale so the stick starts from 0 at the edge of the dead zone
   rather than jumping to 0.15. */
function stickDeadzone(value) {

  if (!Number.isFinite(value) || Math.abs(value) < STICK_DEADZONE) return 0;

  return Math.sign(value) * (Math.abs(value) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
}

/* x and y follow the on-screen pad: y grows downward, so forward is
   negative. A pad that unplugs reads as centred, which is a stop. */
function readSticks() {

  const pads = navigator.getGamepads
    ? [...navigator.getGamepads()].filter(p => p && p.connected)
    : [];

  const pad = pads.find(p => p.mapping === "standard");

  /* what the page can see, shown in the drive note while armed: a
     pad Firefox cannot see or map is otherwise a silent failure */
  const status = pad
    ? "Gamepad ready: " + pad.id
    : pads.length
    ? "Gamepad found but not mapped as standard (" + pads[0].id + ") - sticks off"
    : "No gamepad detected - press a button on it. Sticks off";

  if (!pad) return { x: 0, y: 0, stop: false, status };

  const stop = pad.buttons[STICK_BTN_STOP];

  return {
    x: stickDeadzone(pad.axes[STICK_AXIS_STEER]),
    y: stickDeadzone(pad.axes[STICK_AXIS_SPEED]),
    stop: Boolean(stop && stop.pressed),
    status
  };
}

function driveTick() {

  const now = performance.now();
  const dt = Math.min(0.2, (now - lastDriveTick) / 1000);

  lastDriveTick = now;

  if (driveArmed && (!socketOpen() || ws !== driveSocket)) {
    disarmDrive("connection lost or replaced");
  }

  if (driveArmed && estopActive()) {
    disarmDrive(estopObstacle() || "the emergency stop is on");
  }

  /* gamepad sticks are only read while armed */
  const stick = driveArmed
    ? readSticks()
    : { x: 0, y: 0, stop: false, status: "" };

  if (stick.stop) disarmDrive("stop pressed on the controller");

  if (driveArmed && stick.status !== stickStatus) {
    setDriveNote("Armed. " + stick.status);
  }

  stickStatus = driveArmed ? stick.status : "";

  stickHeld = driveArmed && (stick.x !== 0 || stick.y !== 0);

  let targetSpeed = 0;
  let targetSteer = 0;

  /* a controller on this device (a Steam Deck), through the Controller
     tab's mapping: the car's own layout - hold L1, left stick speed, right
     stick steer, B stops and disarms (controller.js deckDriveInput). The
     sticks above drive a standard-mapped pad without L1; this also covers a
     pad that is not mapped as standard, and gives R1 to Hold R1 to run. */
  const deck = typeof deckDriveInput === "function" ? deckDriveInput() : null;
  let deckActive = false;
  let autoActive = false;

  /* the time is up */
  if (autoRun.on && autoRun.until && now >= autoRun.until) {
    autoRun.on = false;
    autoRunNote = "Autonomous run finished: the time was up.";
    disarmDrive("the autonomous run's time was up");
  }

  if (deck && deck.stop && driveArmed) {
    disarmDrive("stop pressed on the controller");
  }

  /* a controller on the car holds the mux until R1 is held (joy_teleop's
     default command sends zero speed with every /joy message), so a run
     that needs nothing held cannot drive: end it and say why */
  if (autoRun.on && !autoRun.byR1 && padOnCar()) {
    endR1Run("a controller connected to the car, so the run needs R1 held");
  }

  /* hold R1 to run, let go to stop */
  const r1 = r1Enabled() ? r1Input(deck) : null;
  r1Last = r1;

  if (!r1 || !r1.down) {
    r1Since = 0;
    r1Tried = false;
    $("autoStart").classList.remove("r1-hold");
    if (autoRun.on && autoRun.byR1) endR1Run(r1 ? "R1 let go" : "Hold R1 to run switched off");
  } else {
    if (!r1Since) {
      r1Since = now;
      $("autoStart").classList.toggle("r1-hold", !autoRun.on && !r1Tried);
    }
    if (!autoRun.on && !r1Tried && now - r1Since >= R1_HOLD_MS &&
        driveTabVisible() && !document.hidden) {
      r1Tried = true;
      $("autoStart").classList.remove("r1-hold");
      startAutoRun(true);
    }
  }

  if (padHeld) {

    /* screen y grows downward; forward is up. Left of centre is
       a positive (left) steering angle, per REP-103. */
    targetSpeed = -padVec.y * limitSpeed();
    targetSteer = -padVec.x * limitSteer();

  } else if (stickHeld) {

    targetSpeed = -stick.y * limitSpeed();
    targetSteer = -stick.x * limitSteer();

  } else if (driveKeys.size) {

    targetSpeed = keyAxis(KEY_FWD, KEY_BACK) * limitSpeed();
    targetSteer = keyAxis(KEY_LEFT, KEY_RIGHT) * limitSteer();

  } else if (deck && deck.held && driveArmed) {

    /* left and up read positive, as on the pad: up is forward, left is
       a positive (left) steering angle */
    targetSpeed = deckStick(deck.y) * limitSpeed();
    targetSteer = deckStick(deck.x) * limitSteer();
    deckActive = true;

  } else if (autoRun.on && driveArmed) {

    /* the set speed and steering, within the limits; the pad, the keys or
       a controller held take over while they are held */
    targetSpeed = autoSpeed();
    targetSteer = Math.max(-limitSteer(), Math.min(limitSteer(), parseFloat($("autoSteer").value) || 0));
    autoActive = true;

    /* something ahead on the LiDAR: turn away from it instead */
    avoidNow = null;
    if ($("autoAvoid").checked && scanStats && now - scanStats.at < AVOID_SCAN_MAX_AGE_MS) {
      const turn = lidarAvoid(lastScan, targetSpeed, limitSteer(), avoidState);
      if (turn.active) {
        targetSteer = turn.steer;
        avoidNow = turn;
      }
    } else {
      avoidState.dir = 0;
    }
  }

  /* mirror the sticks on the on-screen knob, unless a finger has it */
  if (stickHeld && !padHeld) {

    const length = Math.max(1, Math.hypot(stick.x, stick.y));

    placeKnob(stick.x / length, stick.y / length);
    stickKnobShown = true;

  } else if (stickKnobShown) {

    if (!padHeld) placeKnob(0, 0);
    stickKnobShown = false;
  }

  /* the pad, the sticks and a controller here are all proportional; an
     autonomous run starts gently, like the keys */
  const proportional = padHeld || stickHeld || deckActive;

  const active =
    driveArmed && (proportional || driveKeys.size > 0 || autoActive);

  if (active) {

    const accel = proportional ? PAD_ACCEL : KEY_ACCEL;
    const steerRate = proportional ? PAD_STEER_RATE : KEY_STEER_RATE;

    cmdSpeed = towards(cmdSpeed, targetSpeed, accel * dt);
    cmdSteer = towards(cmdSteer, targetSteer, steerRate * dt);

    driveFrame = autoActive ? DASHBOARD_AUTO_FRAME : DASHBOARD_MANUAL_FRAME;
    publishDrive(cmdSpeed, cmdSteer);

    stopBurst = STOP_BURST;

  } else {

    cmdSpeed = 0;
    cmdSteer = 0;

    if (stopBurst > 0 && socketOpen()) {
      publishDrive(0, 0);
      stopBurst--;
    }
  }

  renderDriveReadout(active);
}

/* A controller stick: a dead zone, so a stick resting a little off
   centre does not creep the car, then the full range after it. */
const DECK_DEAD_ZONE = 0.1;

function deckStick(v) {
  const a = Math.abs(v);
  return a < DECK_DEAD_ZONE ? 0 : Math.sign(v) * Math.min(1, (a - DECK_DEAD_ZONE) / (1 - DECK_DEAD_ZONE));
}

/* An input just changed: send now rather than at the next tick. */
function driveNow() {
  if (performance.now() - lastDriveTick >= DRIVE_NOW_MIN_MS) driveTick();
}

/* ---------- rendering ---------- */

function renderDriveControls() {

  const ready =
    $("driveConfirm").checked && socketOpen() &&
    !foreignDriveActive() && !estopActive();

  $("armBtn").disabled = !driveArmed && !ready;
  $("armBtn").textContent = driveArmed ? "Disarm" : "Arm";
  $("armBtn").classList.toggle("armed", driveArmed);

  $("drivePad").classList.toggle("ready", driveArmed);
  $("driveBadge").hidden = !driveArmed;

  if (!driveArmed && !socketOpen()) {
    setDriveNote("Not connected — connect to rosbridge in the top bar.");
  }
}

function renderDriveReadout(active) {

  const state = $("driveState");

  state.textContent =
    active ? "DRIVING" : driveArmed ? "ARMED" : "DISARMED";

  state.className =
    "drive-state" +
    (active ? " driving" : driveArmed ? " armed" : "");

  $("drivePad").classList.toggle("held", padHeld && driveArmed);

  $("cmdSpeed").textContent = speedText(cmdSpeed);
  $("cmdSteer").textContent =
    Math.round(cmdSteer * 180 / Math.PI) + "°" +
    (cmdSteer > 0.01 ? " left" : cmdSteer < -0.01 ? " right" : "");

  /* left is positive, and left is drawn on the left */
  const full = parseFloat($("maxSteer").max);

  $("steerMark").style.left =
    (50 - (cmdSteer / full) * 50) + "%";
}

/* ---------- vitals: what to watch while driving ---------- */

/* Obstacle distance uses the LiDAR card's bands (LIDAR_NEAR /
   LIDAR_CLOSE in metrics.js), so a colour means the same distance
   on the plot and here. */
const BAND_TONE = { near: "bad", close: "warn", far: "ok" };

const GRADE_TONE = { ok: "ok", warn: "warn", bad: "bad" };

function driveVitals() {

  const now = performance.now();
  const rows = [];

  /* battery */

  if (vesc) {

    const pct = batteryEstimate(vesc.voltage);

    rows.push({
      label: "Battery",
      value: vesc.voltage.toFixed(1) + " V",
      note: pct === null ? "" : "~" + Math.round(pct) + "%",
      tone:
        vesc.voltage < BATT_ERR ? "bad"
        : vesc.voltage < BATT_WARN ? "warn"
        : "ok"
    });

  } else {

    rows.push({
      label: "Battery",
      value: "—",
      note: "no /sensors/core",
      tone: ""
    });
  }

  /* link: a frozen page looks exactly like a healthy one. Shown only
     when it lags - a steady "0.0 s" row was noise, and a lag is the
     moment it matters, since a page driving the car would be sending
     into a dead connection. */

  const open = socketOpen();
  const quiet = lastAnything ? (now - lastAnything) / 1000 : null;

  if (!open || quiet === null || quiet > 1) {
    rows.push({
      label: "Link",
      value: !open ? "offline" : quiet === null ? "waiting" : quiet.toFixed(1) + " s",
      note: open ? "since the last message from the robot" : "not connected",
      tone: !open ? "bad" : "warn"
    });
  }

  /* nearest obstacle */

  const scanFresh =
    scanStats && now - scanStats.at < 2000;

  rows.push({
    label: "Nearest obstacle",
    value:
      scanFresh && scanStats.min !== null
        ? scanStats.min.toFixed(2) + " m"
        : "—",
    note: scanFresh ? "LiDAR, any direction" : "no LiDAR scan",
    tone:
      !scanFresh || scanStats.min === null
        ? "warn"
        : BAND_TONE[bandOf(scanStats.min)]
  });

  /* the compute metrics the Overview already grades */

  const tiles = {};

  metricTiles().forEach(tile => {
    tiles[tile.id] = tile;
  });

  [["speed", "Speed"], ["temp", "Temperature"], ["cpu", "CPU"], ["gpu", "GPU"]]
    .forEach(([id, label]) => {

      const tile = tiles[id];

      if (!tile) return;

      /* Multi-row tiles (Temperature) bring their bars along, the same
         mini bars as the Overview; the rows are the value. */
      const multi = Array.isArray(tile.rows);

      rows.push({
        label,
        value: multi ? "" : String(tile.value ?? ""),
        note: multi ? "" : (typeof tile.note === "string" ? tile.note : ""),
        rows: multi ? tile.rows : null,
        tone: GRADE_TONE[tile.grade] || ""
      });
    });

  return rows;
}

/* Slower bits, from the main 2 Hz render loop. */
function renderDrive() {

  renderDriveControls();
  renderControl();

  const fresh =
    robotSpeedMps !== null &&
    performance.now() - robotSpeedAt < 2000;

  $("measSpeed").textContent =
    fresh ? speedText(robotSpeedMps) : "—";

  $("hudBattery").innerHTML =
    icon("battery") + " " + (vesc ? vesc.voltage.toFixed(1) + " V" : "--.- V");

  const rows = driveVitals();

  $("vitals").innerHTML =
    rows.map(row => `
      <li class="vital ${row.tone}">
        <span class="dot ${row.tone}"></span>
        <span class="vital-label">${escapeHtml(row.label)}</span>
        <span class="vital-value">${escapeHtml(row.value)}</span>
        ${row.rows
          ? `<div class="vital-rows">${rowsBody(row)}</div>`
          : `<span class="vital-note">${escapeHtml(row.note)}</span>`}
      </li>
    `).join("");

  const bad = rows.filter(row => row.tone === "bad").length;
  const warn = rows.filter(row => row.tone === "warn").length;

  $("vitalsSummary").textContent =
    bad ? `${bad} problem${bad === 1 ? "" : "s"}`
    : warn ? `${warn} to watch`
    : "all good";

  $("vitalsSummary").style.color =
    bad ? "var(--bad-ink)" : warn ? "var(--warn-ink)" : "var(--ok-ink)";

  if (driveTabVisible()) {
    redrawDriveRadar();
  }
}

/* ---------- pad input ---------- */

function placeKnob(x, y) {

  /* knob is 26% wide, so its centre travels 37% either way */
  $("padKnob").style.left = (50 + x * 37) + "%";
  $("padKnob").style.top = (50 + y * 37) + "%";
}

function padVector(event) {

  const rect = $("drivePad").getBoundingClientRect();

  let x = (event.clientX - rect.left) / rect.width * 2 - 1;
  let y = (event.clientY - rect.top) / rect.height * 2 - 1;

  /* scale to the knob's travel, then clamp to the unit circle */
  x /= 0.74;
  y /= 0.74;

  const length = Math.hypot(x, y);

  if (length > 1) {
    x /= length;
    y /= length;
  }

  return { x, y };
}

$("drivePad").addEventListener("pointerdown", event => {

  if (!driveArmed) {
    setDriveNote("Tick the safety box and press Arm first.");
    return;
  }

  /* capture keeps the drag alive outside the circle; if the
     browser refuses, the pad still works inside it */
  try {
    $("drivePad").setPointerCapture(event.pointerId);
  } catch (error) {}

  padHeld = true;
  padVec = padVector(event);

  placeKnob(padVec.x, padVec.y);
  driveNow();
});

$("drivePad").addEventListener("pointermove", event => {

  if (!padHeld) return;

  padVec = padVector(event);

  placeKnob(padVec.x, padVec.y);
  driveNow();
});

["pointerup", "pointercancel", "lostpointercapture"].forEach(type =>
  $("drivePad").addEventListener(type, () => {

    const was = padHeld;

    padHeld = false;
    padVec = { x: 0, y: 0 };

    placeKnob(0, 0);
    if (was) driveNow();
  })
);

/* ---------- keyboard input ---------- */

const DRIVE_KEYS =
  new Set([...KEY_FWD, ...KEY_BACK, ...KEY_LEFT, ...KEY_RIGHT]);

window.addEventListener("keydown", event => {

  if (!driveTabVisible()) return;

  const key = event.key.toLowerCase();

  if (key === " " || key === "escape") {

    if (driveArmed) {
      event.preventDefault();
      disarmDrive("stop pressed");
    }

    return;
  }

  /* typing in a box is not driving */
  if (
    event.target instanceof Element &&
    event.target.closest("input, textarea, select")
  ) return;

  if (driveArmed && DRIVE_KEYS.has(key)) {
    event.preventDefault();

    /* the browser repeats a held key; only the first press is news */
    if (!driveKeys.has(key)) {
      driveKeys.add(key);
      driveNow();
    }
  }
});

window.addEventListener("keyup", event => {
  if (driveKeys.delete(event.key.toLowerCase())) driveNow();
});

/* ---------- everything that must stop the car ---------- */

window.addEventListener("blur", () => {
  if (driveArmed) disarmDrive("window lost focus");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && driveArmed) disarmDrive("page hidden");
});

window.addEventListener("pagehide", () => {
  if (driveArmed) disarmDrive("page closed");
});

$("stopBtn").onclick = () => disarmDrive("stop pressed");

$("driveCamConnect").onclick = reconnectCamera;

$("armBtn").onclick = () => {

  if (driveArmed) {
    disarmDrive("disarmed");
  } else {
    armDrive();
  }
};

$("driveConfirm").addEventListener("change", () => {

  if (!$("driveConfirm").checked && driveArmed) {
    disarmDrive("safety box unticked");
  }

  renderDriveControls();
});

/* ---------- who's driving ----------

   Everything that could be moving the car, in one place:
   the physical controller, this page, another dashboard, and
   autonomous code — plus which one the mux is actually following. */

/* /drive messages arrived that this page did not send. Our own
   commands echo back from rosbridge within a few tens of ms, so
   anything more than 400 ms after our last send is someone else. */
function foreignDriveActive() {

  const topic = topics.get(DRIVE_TOPIC);

  if (!topic || topic.last === null) return false;

  const now = performance.now();

  /* the robot's drive watchdog stopping the car is not someone driving */
  return now - topic.last < 1000 && topic.last - lastOwnSend > 400 &&
    topic.last - lastWatchdogStop > 50;
}

function drivePublishers() {

  const topic = topics.get(DRIVE_TOPIC);

  /* rosapi's list, plus the car's own (system_diagnostics reads the ROS
     graph directly, where a `ros2 topic pub` - a hidden node - counts) */
  const watchdog = diag["system: Drive watchdog"];
  const fromCar = String((watchdog && watchdog.values && watchdog.values.publishers) || "")
    .split(",").map(n => n.trim()).filter(n => n && n !== "none");
  const names = [...new Set([...((topic && topic.publishers) || []), ...fromCar])];

  return {
    /* every web dashboard publishes through the rosbridge node */
    web: names.some(name => /rosbridge/.test(name)),
    /* system_diagnostics publishes /drive only for the watchdog's zeros */
    autonomous: names.filter(name => !/rosbridge|system_diagnostics/.test(name))
  };
}

/* Is autonomous driving on? From who publishes /drive (rosapi, every
   5 s) and whether commands are arriving (this page's own subscription):

     on       a node that is neither a dashboard (they all publish through
              rosbridge) nor the robot's watchdog is sending commands now
     standby  such a node is up, ready to publish /drive, but quiet
     off      nothing autonomous is running

   The mux's own "navigation unmasked" is not enough on its own: every
   dashboard drives through that same input. */
function autonomousState() {

  if (!socketOpen()) return { state: "unknown", nodes: [], text: "—" };

  if (autoRun.on && driveArmed) {
    return { state: "on", mine: true, nodes: [], text: "Driving",
             detail: autoRun.byR1
               ? "This page's autonomous run is driving the car while R1 is held. Letting go of R1, or Stop, ends it."
               : "This page's autonomous run is driving the car. Stop ends it." };
  }

  const pubs = drivePublishers();
  const nodes = pubs.autonomous;

  if (!nodes.length) {
    return { state: "off", nodes, text: "Off",
             detail: "Nothing autonomous is publishing /drive." };
  }

  const list = nodes.join(", ");

  if (foreignDriveActive() && !(pubs.web && !driveArmed && performance.now() - lastOwnUnadvertise > 15000)) {
    return { state: "on", nodes, text: "Driving",
             detail: `${list} is driving the car through /drive. Holding L1 on the controller overrides it; Emergency stop stops it.` };
  }

  return { state: "standby", nodes, text: "Standby",
           detail: `${list} is running and can publish /drive, but is not sending commands now.` };
}

/* ---------- autonomous: run it from here, stop it from here ---------- */

let autoRunNote = "";

/* LiDAR steer-away for the run (js/avoid.js). A scan older than this is
   not trusted, so a dead LiDAR means no steering from it. */
const AVOID_SCAN_MAX_AGE_MS = 500;
const avoidState = { dir: 0 };
let avoidNow = null;          // the last tick's lidarAvoid() result while turning, else null

/* byR1: started by holding R1, which then runs it with no time limit -
   the hold is the limit */
function startAutoRun(byR1 = false) {

  if (!driveArmed) {
    if (!$("driveConfirm").checked) {
      const note = byR1 ? "Tick the safety box first, then hold R1 again."
                        : "Tick the safety box first, then start.";
      setDriveNote(note);
      autoRunNote = note;
      if (typeof setCockpitNote === "function") setCockpitNote(note);
      return;
    }
    armDrive();
    if (!driveArmed) {                 // armDrive said why
      if (byR1) autoRunNote = $("driveNote").textContent;
      return;
    }
  }

  const secs = byR1 ? 0 : parseInt($("autoFor").value, 10) || 0;

  autoRun.on = true;
  autoRun.byR1 = byR1;
  autoRun.startedAt = performance.now();
  autoRun.until = secs ? autoRun.startedAt + secs * 1000 : 0;
  autoRunNote = "";
  setDriveNote(byR1
    ? "Autonomous run: R1 held. Let go of R1 to stop."
    : "Autonomous run started. STOP, Space or Stop on the indicator ends it.");
  if (!byR1) driveNow();               // R1 starts it from inside the tick
  renderAutoPanel();                   // the button answers now, not at the next redraw
}

/* R1 let go: stop, but stay armed so holding R1 again runs again. The
   tick this is called from sends the zeros. */
function endR1Run(why) {
  autoRun.on = false;
  autoRun.byR1 = false;
  autoRunNote = "Stopped: " + why + ".";
  setDriveNote("Stopped - " + why + ". Still armed: hold R1 to run again.");
  renderAutoPanel();
}

/* the run's speed: Full speed is the Max speed limit, forward; otherwise
   the slider, within the limit */
function autoSpeed() {
  const max = limitSpeed();
  if ($("autoFull").checked) return max;
  return Math.max(-max, Math.min(max, parseFloat($("autoSpeed").value) || 0));
}

/* Hold R1 to run: what you chose, unless a controller is connected to the
   car - then it is on, whatever you chose. With a controller connected,
   joy_teleop's default command sends zero speed on /teleop with every /joy
   message, and the mux gives /teleop priority over /drive, so the car takes
   /drive only while R1 (the autonomous deadman) is held. */
let autoR1Choice = false;

function syncAutoR1() {
  const forced = padOnCar();
  const box = $("autoR1");
  const want = forced || autoR1Choice;
  if (box.checked !== want) box.checked = want;
  box.disabled = forced;
  $("autoR1Sub").textContent = forced
    ? "On while a controller is connected to the car: it holds the car still until R1 is held."
    : "Hold R1 on the controller for half a second to start; let go to stop.";
}

/* Hold R1 to run: on in the Autonomous run mode only */
function r1Enabled() {
  return $("autoR1").checked && driveMode === "auto";
}

/* for controller.js: /joy at full rate while R1 can start or stop a run */
function r1WantsJoy() {
  return r1Enabled() && driveTabVisible();
}

/* R1 now: from a controller on this device (the Steam Deck), or the car's
   pad through /joy, read with the Controller tab's mapping. A flickering
   R1 counts as up: it may stop a run but never start one. */
function r1Input(deck) {

  if (deck && deck.r1 !== undefined) {
    return { down: deck.r1 && !deck.r1Flicker, flicker: deck.r1Flicker, source: "deck" };
  }

  const fresh = typeof jpMsg !== "undefined" && jpMsg && performance.now() - jpAt <= R1_FRESH_MS;
  const i = typeof jpMaps !== "undefined" ? jpMaps.ps4.buttons.r1 : JOY_R1;

  if (!fresh || i === null || i === undefined) return { down: false, flicker: false, source: fresh ? "ps4" : null };

  const flicker = jpUnsettled("ps4", i);

  return { down: (jpMsg.buttons || [])[i] === 1 && !flicker, flicker, source: "ps4" };
}

function stopAutoRun(reason = "stopped") {
  if (!autoRun.on) return;
  disarmDrive(reason);
}

/* the Stop next to the Autonomous indicator: this page's run, or whatever
   is driving through /drive on the car (system_diagnostics stops a
   `ros2 topic pub` and sends zero speed) */
async function stopAutonomous() {

  if (autoRun.on) {
    stopAutoRun("Stop pressed");
    toast("Autonomous run stopped.");
    return;
  }

  try {
    const result = await call(STOP_AUTO_SERVICE);
    toast(result.message || "Stopped.", result.success ? "ok" : "warn");
  } catch (error) {
    toast("The car could not be asked to stop it (" + error.message + "). " +
          "Use Emergency stop.", "bad");
  }
}

let toastTimer = null;

function toast(text, tone = "ok") {
  const box = $("toast");
  box.textContent = text;
  box.dataset.tone = tone;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 7000);
}

/* the panel: limits follow Max speed / Max steering; the button and the
   status follow the run */
function renderAutoPanel() {

  const speed = $("autoSpeed");
  const steer = $("autoSteer");
  const maxV = limitSpeed();
  const maxS = limitSteer();

  if (+speed.max !== maxV) { speed.max = maxV; speed.min = -maxV; }
  if (+steer.max !== maxS) { steer.max = maxS; steer.min = -maxS; }

  const full = $("autoFull").checked;

  /* full speed: the slider sits at the limit and is not in charge */
  if (full && +speed.value !== maxV) speed.value = maxV;
  speed.disabled = full;
  $("autoSpeedRow").classList.toggle("locked", full);

  const v = full ? maxV : Math.max(-maxV, Math.min(maxV, parseFloat(speed.value) || 0));
  const a = Math.max(-maxS, Math.min(maxS, parseFloat(steer.value) || 0));
  const deg = Math.round(a * 180 / Math.PI);

  $("autoSpeedValue").textContent = speedText(v) + (full ? " full" : v < 0 ? " rev" : "");
  $("autoSteerValue").textContent = deg ? Math.abs(deg) + "° " + (deg > 0 ? "left" : "right") : "0°";

  const go = $("autoStart");
  const running = autoRun.on && driveArmed;

  /* with a controller on the car a run needs R1 held, so the button cannot
     start one: say what will, instead of starting and ending at once */
  const needsR1 = !running && padOnCar();

  const label = running ? "Stop autonomous run"
    : needsR1 ? "Hold R1 on the controller to start"
    : "Start autonomous run";
  if (go.textContent !== label) go.textContent = label;
  go.disabled = needsR1;               // never while running: this is a stop
  go.classList.toggle("running", running);

  let status = autoRunNote;
  if (running && avoidNow) {
    status = `Avoiding: obstacle ${avoidNow.front.toFixed(2)} m ahead, steering ` +
      (avoidNow.dir > 0 ? "left" : "right");
  } else if (running) {
    const left = autoRun.until ? Math.max(0, Math.ceil((autoRun.until - performance.now()) / 1000)) : null;
    status = `Driving at ${speedText(cmdSpeed)}` +
      (autoRun.byR1 ? " · let go of R1 to stop"
        : left !== null ? ` · ${left} s left` : " · until you stop it");
  } else if (r1Enabled()) {
    const r1 = r1Last || { down: false, flicker: false, source: null };
    const hint =
      r1.flicker ? "R1 is flickering by itself, so it cannot start a run. See the Controller tab."
      : !r1.source ? "No controller reading, so R1 cannot start a run."
      : r1Since && !r1Tried ? "Keep holding R1…"
      : "Hold R1 to run.";
    status = autoRunNote ? autoRunNote + " " + hint : hint;
  }
  if ($("autoStatus").textContent !== status) $("autoStatus").textContent = status;
  $("autoStatus").classList.toggle("running", running);

  renderObstacleGuard();
}

/* ---------- obstacle stop: on the robot, set from here ----------

   system_diagnostics.py watches the LiDAR straight ahead while /drive drives
   the car forward, and turns the emergency stop on when something is closer
   than the car needs to stop. This shows its state ("system: Obstacle stop"),
   switches it and sets its margin through the node's ROS parameters, and
   draws the space it needs clear on the LiDAR view. */

let guardPending = null;        // { on, margin, until } while a change is on its way

function guardDiag() {
  const item = diag[SYS_PREFIX + "Obstacle stop"];
  if (!item || !item.values) return null;
  const v = item.values;
  const num = key => parseFloat(v[key]);
  return {
    on: v.enabled === "yes",
    margin: num("margin m"),
    reaction: num("reaction s"),
    decel: num("decel m/s2"),
    corridor: num("corridor m"),
    ahead: v["ahead m"] === "none" ? null : num("ahead m"),
    level: item.level,
    message: item.message
  };
}

/* the same sum as the robot's stop_distance() */
function guardStopDistance(g, speed) {
  const v = Math.max(0, speed);
  return g.margin + v * g.reaction + v * v / (2 * g.decel);
}

/* the speed the stop zone is drawn for: the run's now, or what one would ask */
function guardSpeed() {
  return autoRun.on && driveArmed ? Math.max(cmdSpeed, autoSpeed()) : autoSpeed();
}

async function setObstacleGuard(on, margin) {

  guardPending = { on, margin, until: performance.now() + 3000 };
  renderObstacleGuard();

  try {
    const result = await call(SYSDIAG_PARAMS_SERVICE, { parameters: [
      { name: "obstacle_stop", value: { type: 1, bool_value: on } },
      { name: "obstacle_margin", value: { type: 3, double_value: margin } }
    ] });
    const bad = (result.results || []).find(r => !r.successful);
    if (bad) {
      guardPending = null;
      toast("The car refused: " + (bad.reason || "no reason given") + ".", "warn");
    } else {
      toast(on ? `Obstacle stop on: ${margin.toFixed(1)} m margin.` : "Obstacle stop off.", on ? "ok" : "warn");
    }
  } catch (error) {
    guardPending = null;
    toast("Could not set the obstacle stop (" + error.message + ").", "bad");
  }
  renderObstacleGuard();
}

function renderObstacleGuard() {

  const g = guardDiag();
  const sw = $("autoGuardOn");
  const pick = $("autoGuardMargin");

  if (guardPending && (performance.now() > guardPending.until ||
      (g && g.on === guardPending.on && Math.abs(g.margin - guardPending.margin) < 1e-6))) {
    guardPending = null;
  }

  sw.disabled = !g || !socketOpen();
  pick.disabled = sw.disabled;

  let text;

  if (!g) {
    sw.checked = false;
    text = "Needs the new system_diagnostics.py on the car.";
  } else {
    const on = guardPending ? guardPending.on : g.on;
    const margin = guardPending ? guardPending.margin : g.margin;
    sw.checked = on;
    if (document.activeElement !== pick) {
      const value = String(margin);
      if (![...pick.options].some(o => o.value === value)) pick.add(new Option(margin.toFixed(2) + " m", value));
      pick.value = value;
    }
    const need = guardStopDistance({ ...g, margin }, guardSpeed());
    text = !on
      ? "Off: nothing stops the car before an obstacle."
      : `Stops if anything is within ${need.toFixed(1)} m ahead at ${speedText(guardSpeed(), 1)}` +
        (g.ahead !== null ? ` · nearest ${g.ahead.toFixed(1)} m` : " · clear ahead");
  }

  if ($("autoGuardText").textContent !== text) $("autoGuardText").textContent = text;
  $("autoGuard").dataset.state = !g ? "none" : sw.checked ? "on" : "off";
}

/* for the LiDAR views: the stop zone, when it is worth showing */
function obstacleZone() {

  const g = guardDiag();

  if (!g || !g.on) return null;
  if (driveMode !== "auto" && autonomousState().state !== "on") return null;

  const length = guardStopDistance(g, guardSpeed());

  return { length, halfWidth: g.corridor / 2, hit: g.ahead !== null && g.ahead <= length };
}

/* hold to drive, or an autonomous run; kept per browser */
const DRIVE_MODE_KEY = "driveMode";
let driveMode = "hold";

try {
  if (localStorage.getItem(DRIVE_MODE_KEY) === "auto") driveMode = "auto";
} catch (error) {}

/* Full speed is kept per browser; Hold R1 to run is not - it starts off
   after a reload, like the speed unlocks */
const AUTO_FULL_KEY = "autoFullSpeed";

try {
  if (localStorage.getItem(AUTO_FULL_KEY) === "0") $("autoFull").checked = false;
} catch (error) {}

let autoSlowSpeed = parseFloat($("autoSpeed").value);   // the slider's own value, under Full speed

function setAutoFull(on) {
  if (on) autoSlowSpeed = parseFloat($("autoSpeed").value);
  else $("autoSpeed").value = autoSlowSpeed;
  try {
    localStorage.setItem(AUTO_FULL_KEY, on ? "1" : "0");
  } catch (error) {}
}

function setDriveMode(mode) {
  if (mode !== "auto" && autoRun.on) stopAutoRun("switched to hold to drive");
  r1Tried = true;                      // a hold already down does not start a run
  driveMode = mode === "auto" ? "auto" : "hold";
  try {
    localStorage.setItem(DRIVE_MODE_KEY, driveMode);
  } catch (error) {}
  $("cockpitPanel").dataset.mode = driveMode;
  document.querySelectorAll("[data-drive-mode]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.driveMode === driveMode)));
  if (typeof jpSubscribe === "function") jpSubscribe();
}

/* Is a controller attached? true / false, or null with no
   system_diagnostics. Read from /dev/input/js*, which the robot lists
   every second and which vanishes the moment the pad disconnects -
   not the Bluetooth link, which is probed every 10 s and kept saying
   "connected" for that long after a disconnect. */
function padLinkState() {

  const pad = diag["system: Gamepad"];

  if (!pad) return null;

  const js = (pad.values || {})["js devices"];

  return Boolean(js) && js !== "none";
}

/* One answer to "who has the car right now?", most urgent first,
   plus the extras that matter: whether there is a physical backup
   stop, and warnings only when something is actually going on. */
function controlState() {

  const connected = socketOpen();
  const pubs = drivePublishers();
  const foreign = foreignDriveActive();
  const active =
    driveArmed && (padHeld || stickHeld || driveKeys.size > 0);

  /* right after we disarm, rosbridge can still list us for a few
     seconds — do not call that "another dashboard" */
  const otherArmed =
    !driveArmed &&
    pubs.web &&
    performance.now() - lastOwnUnadvertise > 15000;

  /* ---- the headline ---- */

  let hero;

  if (estopActive()) {

    hero = { tone: "bad", icon: "octagonAlert", title: "Emergency stop is on",
             sub: "Nobody can drive the car until it is released at the top of the page." };

  } else if (!connected) {

    hero = { tone: "none", icon: "pause", title: "Not connected",
             sub: "Connect to the robot in the top bar." };

  } else if (foreign && pubs.autonomous.length && !pubs.web) {

    hero = { tone: "bad", icon: "bot", title: "Autonomous code is driving",
             sub: pubs.autonomous.join(", ") + " is sending drive commands." };

  } else if (foreign) {

    hero = { tone: "bad", icon: "monitor", title: "Someone else is driving",
             sub: "Another dashboard is sending drive commands. You can't arm until they stop." };

  } else if (mux === "teleop") {

    hero = { tone: "warn", icon: "gamepad", title: "The controller is driving",
             sub: "Someone is holding the controller's deadman. It overrides this page." };

  } else if (autoRun.on && driveArmed) {

    hero = { tone: "you", icon: "bot", title: "Autonomous run",
             sub: autoRun.byR1
               ? "R1 is held: this page is driving the car at a set speed. Let go of R1 to stop."
               : "This page is driving the car at a set speed. STOP, Space or Esc ends it." };

  } else if (active) {

    hero = { tone: "you", icon: "joystick", title: "You are driving",
             sub: "Let go to stop. STOP, Space or Esc disarms." };

  } else if (driveArmed) {

    hero = { tone: "you", icon: "joystick", title: "You're armed",
             sub: "Hold the pad, a drive key or a stick to move." };

  } else if (mux === "autonomous") {

    hero = { tone: "warn", icon: "bot", title: "The car is following /drive",
             sub: "Something is sending drive commands." };

  } else {

    hero = { tone: "ok", icon: "pause", title: "Nobody is driving",
             sub: "The car is idle. Arm the controls to drive." };
  }

  /* ---- the backup stop ---- */

  const padLinked = padLinkState();
  const pad = diag["system: Gamepad"];

  const chips = [
    padLinked && pad.level === 2
      ? { tone: "bad", text: "Controller can't be read - no backup stop",
          title: pad.message }
      : padLinked === null
      ? { tone: "", text: "Controller: unknown",
          title: "Needs system_diagnostics.py running on the robot" }
      : padLinked
      ? { tone: "ok", text: "Controller connected",
          title: "The physical controller is your backup stop" }
      : { tone: "warn", text: "No controller — no backup stop",
          title: "Pair the PS4 controller so someone can take over" }
  ];

  /* ---- warnings, only when true ---- */

  const alerts = [];

  /* the sticks' status stays up while armed, in the full-screen view too */
  if (driveArmed && stickStatus) {
    alerts.push({
      tone: stickStatus.startsWith("Gamepad ready") ? "" : "warn",
      text: stickStatus
    });
  }

  if (connected && otherArmed && !foreign) {
    alerts.push({ tone: "warn",
      text: "Another dashboard is armed and could start driving at any moment." });
  }

  if (connected && pubs.autonomous.length && !(foreign && !pubs.web)) {
    alerts.push({ tone: "warn",
      text: "Autonomous code is running: " + pubs.autonomous.join(", ") + "." });
  }

  if (clients !== null && clients > CLIENT_LIMIT) {
    alerts.push({ tone: "bad",
      text: `${clients} people connected — rosbridge serves ${CLIENT_LIMIT}, so some dashboards get no data.` });
  }

  return { hero, chips, alerts, padLinked: padLinked === true };
}

function renderControl() {

  const { hero, chips, alerts, padLinked } = controlState();

  $("controlHero").className = "control-hero tone-" + hero.tone;
  $("controlIcon").innerHTML = icon(hero.icon);
  $("controlTitle").textContent = hero.title;
  $("controlSub").textContent = hero.sub;

  $("controlChips").innerHTML =
    chips.map(chip =>
      `<span class="control-chip ${chip.tone}" title="${escapeHtml(chip.title)}">${icon("gamepad")}${escapeHtml(chip.text)}</span>`
    ).join("");

  $("controlAlerts").innerHTML =
    alerts.map(alert =>
      `<li class="${alert.tone}">${escapeHtml(alert.text)}</li>`
    ).join("");

  renderPadDisconnect(padLinked);
}

/* ---------- disconnect the controller ----------

   Drops the PS4 pad's Bluetooth link (bluetoothctl, on the robot's
   system_diagnostics.py). Refused while L1/R1 is held: the mux
   sends no zero when an input goes quiet, so cutting the link
   mid-drive would leave the motor on its last command. With the
   e-stop on nothing the pad sends can move the car, so it is
   allowed then. The robot checks the same thing. */

const PAD_DISCONNECT_SERVICE = "/system_diagnostics/controller_disconnect";

let padDisconnectBusy = false;
let padDisconnectNote = "";
let padDisconnectBad = false;
let padDisconnectTimer = null;

function setPadDisconnectNote(text, bad) {

  padDisconnectNote = text;
  padDisconnectBad = bad;

  clearTimeout(padDisconnectTimer);

  padDisconnectTimer = setTimeout(() => {
    padDisconnectNote = "";
    renderControl();
  }, 8000);
}

function renderPadDisconnect(padLinked) {

  const held = deadmanHeld() && !estopActive();
  const button = $("padDisconnectBtn");

  /* keep the row while a result is showing, even once the pad is gone */
  $("padDisconnectRow").hidden =
    !socketOpen() || (!padLinked && !padDisconnectNote);

  button.hidden = !padLinked;
  button.disabled = padDisconnectBusy || held;
  button.innerHTML =
    padDisconnectBusy ? "Disconnecting…" : icon("gamepad") +  ' Disconnect<span class="fold-word"> controller</span>';
  button.title =
    held
      ? "Someone is holding L1/R1 — they must let go first, or press E-STOP"
      : "Drop the controller's Bluetooth link. Press its PS button to reconnect.";

  const note = $("padDisconnectNote");

  note.textContent =
    held && !padDisconnectBusy && !padDisconnectNote
      ? "Let go of L1/R1 first."
      : padDisconnectNote;
  note.classList.toggle("bad", padDisconnectBad && Boolean(padDisconnectNote));
}

async function disconnectPad() {

  if (deadmanHeld() && !estopActive()) return;

  const ok = confirm(
    "Disconnect the controller?\n\n" +
    "Its Bluetooth link to the robot is dropped, so it can no longer " +
    "drive the car or act as a backup stop. Press the PS button on the " +
    "controller to reconnect.");

  if (!ok) return;

  padDisconnectBusy = true;
  padDisconnectNote = "";
  renderControl();

  try {

    const result = await call(PAD_DISCONNECT_SERVICE);

    setPadDisconnectNote(
      result.success
        ? "Disconnected. Press the PS button to reconnect."
        : "Not disconnected: " + result.message + ".",
      !result.success);

  } catch (error) {

    setPadDisconnectNote(
      /does not exist|unavailable|not available/i.test(error.message)
        ? "Not available: system_diagnostics.py on the robot is an older copy."
        : "Disconnect failed: " + error.message + ".",
      true);

  } finally {

    padDisconnectBusy = false;
    renderControl();
  }
}

$("padDisconnectBtn").onclick = disconnectPad;

/* ---------- limits and high speed ---------- */

function renderSpeedUnlock() {
  $("speedUnlockBtn").innerHTML = highSpeed
    ? `Lock back to ${speedLimitText(NORMAL_MAX_SPEED)}`
    : icon("alert") + ` Unlock high speed (up to ${speedLimitText(HIGH_MAX_SPEED)})`;
}

function setHighSpeed(on) {

  highSpeed = on;

  const slider = $("maxSpeed");

  slider.max = on ? HIGH_MAX_SPEED : NORMAL_MAX_SPEED;

  if (!on && parseFloat(slider.value) > NORMAL_MAX_SPEED) {
    slider.value = NORMAL_MAX_SPEED;
  }

  renderSpeedUnlock();

  $("speedUnlockBtn").classList.toggle("unlocked", on);
  $("speedMode").hidden = !on;
  $("hudSpeedMode").hidden = !on;

  renderLimits();
}

function setFullSteer(on) {

  fullSteer = on;

  const slider = $("maxSteer");

  slider.max = on ? FULL_MAX_STEER : NORMAL_MAX_STEER;

  if (!on && parseFloat(slider.value) > NORMAL_MAX_STEER) {
    slider.value = NORMAL_MAX_STEER;
  }

  $("steerUnlockBtn").innerHTML =
    on ? "Lock back to 19°" : icon("alert") + " Unlock full steering (up to 23°)";

  $("steerUnlockBtn").classList.toggle("unlocked", on);
  $("steerMode").hidden = !on;
  $("hudSteerMode").hidden = !on;

  renderLimits();
}

/* One pattern for both unlocks: opening disarms, the confirm button
   waits for every box, cancelling changes nothing. */
function wireUnlock(prefix, isOn, setOn) {

  const acks = [prefix + "Ack1", prefix + "Ack2"];

  $(prefix + "UnlockBtn").onclick = () => {

    if (isOn()) {
      setOn(false);
      return;
    }

    if (driveArmed) disarmDrive("changing the limits");

    acks.forEach(id => { $(id).checked = false; });
    $(prefix + "Confirm").disabled = true;
    $(prefix + "Dialog").showModal();
  };

  acks.forEach(id =>
    $(id).addEventListener("change", () => {
      $(prefix + "Confirm").disabled = !acks.every(a => $(a).checked);
    })
  );

  $(prefix + "Cancel").onclick = () => $(prefix + "Dialog").close();

  $(prefix + "Confirm").onclick = () => {
    $(prefix + "Dialog").close();
    setOn(true);
  };
}

function renderLimits() {

  $("maxSpeedValue").textContent =
    speedText(limitSpeed(), 1);

  $("maxSteerValue").textContent =
    Math.round(limitSteer() * 180 / Math.PI) + "°";
}

$("maxSpeed").addEventListener("input", renderLimits);

/* Each unlock is deliberate: a dialog that spells out the risk,
   and two confirmations. */
wireUnlock("speed", () => highSpeed, setHighSpeed);
wireUnlock("steer", () => fullSteer, setFullSteer);
$("maxSteer").addEventListener("input", renderLimits);

/* ---------- LiDAR: zoom and big view ---------- */

function renderDriveZoom() {
  $("driveZoomLabel").textContent = radarRangeLabel(driveRadarScale);
  $("driveZoomAuto").setAttribute("aria-pressed", String(driveRadarScale.mode === "auto"));
}

function redrawDriveRadar() {
  drawScanCanvas($("driveRadar"), driveRadarScale, null, null);
  renderDriveZoom();
}

$("driveZoomIn").onclick = () => { zoomRadar(driveRadarScale, -1); redrawDriveRadar(); };
$("driveZoomOut").onclick = () => { zoomRadar(driveRadarScale, 1); redrawDriveRadar(); };
$("driveZoomAuto").onclick = () => { driveRadarScale.mode = "auto"; redrawDriveRadar(); };

attachRadarZoom($("driveRadar"), driveRadarScale, redrawDriveRadar);
attachRadarPointer($("driveRadar"), driveRadarScale, redrawDriveRadar);
attachRadarCenter($("driveCenterBtn"), driveRadarScale, redrawDriveRadar);

/* Big view swaps the LiDAR into the camera's large slot and shrinks
   the camera; the controls never move. Kept per browser. */
function setLidarBig(big) {

  $("driveGrid").dataset.lidar = big ? "big" : "normal";

  $("lidarBigBtn").innerHTML =
    icon(big ? "minimize" : "maximize") + (big ? " Shrink" : " Enlarge");
  $("lidarBigBtn").setAttribute("aria-pressed", String(big));

  try {
    localStorage.setItem("driveLidar", big ? "big" : "normal");
  } catch (error) {}

  /* the canvas changed size; redraw now rather than at the next tick */
  requestAnimationFrame(redrawDriveRadar);
}

$("lidarBigBtn").onclick =
  () => setLidarBig($("driveGrid").dataset.lidar !== "big");

let savedLidar = "normal";

try {
  savedLidar = localStorage.getItem("driveLidar") || "normal";
} catch (error) {}

setLidarBig(savedLidar === "big");

/* ---------- camera size ---------- */

/* Small by default so the controls and vitals get the room; the
   choice is kept per browser. */
function setCamSize(size) {

  $("driveGrid").dataset.cam = size;

  document.querySelectorAll("[data-cam-size]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.camSize === size))
  );

  try {
    localStorage.setItem("driveCam", size);
  } catch (error) {}
}

document.querySelectorAll("[data-cam-size]").forEach(button => {
  button.onclick = () => setCamSize(button.dataset.camSize);
});

let savedCamSize = "small";

try {
  savedCamSize = localStorage.getItem("driveCam") || "small";
} catch (error) {}

setCamSize(savedCamSize === "large" ? "large" : "small");

setHighSpeed(false);
setFullSteer(false);
renderLimits();
placeKnob(0, 0);

setInterval(driveTick, 1000 / DRIVE_HZ);

/* ---------- autonomous run and Stop: wiring ---------- */

document.querySelectorAll("[data-drive-mode]").forEach(button => {
  button.onclick = () => setDriveMode(button.dataset.driveMode);
});
setDriveMode(driveMode);

$("autoStart").onclick = () => (autoRun.on ? stopAutoRun("Stop pressed") : startAutoRun());
$("autoZero").onclick = () => {
  $("autoFull").checked = false;
  setAutoFull(false);
  $("autoSpeed").value = 0;
  $("autoSteer").value = 0;
};
$("autoFull").addEventListener("change", e => setAutoFull(e.target.checked));
$("autoGuardOn").addEventListener("change", e =>
  setObstacleGuard(e.target.checked, parseFloat($("autoGuardMargin").value)));
$("autoGuardMargin").addEventListener("change", e =>
  setObstacleGuard($("autoGuardOn").checked, parseFloat(e.target.value)));
$("autoR1").addEventListener("change", e => {
  autoR1Choice = e.target.checked;
  r1Tried = true;                      // only a fresh hold starts a run
  if (typeof jpSubscribe === "function") jpSubscribe();
  if (!e.target.checked) driveNow();
});

document.querySelectorAll("[data-auto-stop]").forEach(button => {
  button.onclick = stopAutonomous;
});

setInterval(() => { syncAutoR1(); renderAutoPanel(); }, 100);

