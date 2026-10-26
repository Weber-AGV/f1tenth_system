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

let driveArmed = false;
let driveSocket = null;
let padHeld = false;
let padVec = { x: 0, y: 0 };
let cmdSpeed = 0;
let cmdSteer = 0;
let stopBurst = 0;
let lastDriveTick = performance.now();

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
        frame_id: "base_link"
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

  setDriveNote("Armed. Hold the pad or a drive key to move.");
  renderDriveControls();
}

function disarmDrive(reason) {

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

function driveTick() {

  const now = performance.now();
  const dt = Math.min(0.2, (now - lastDriveTick) / 1000);

  lastDriveTick = now;

  if (driveArmed && (!socketOpen() || ws !== driveSocket)) {
    disarmDrive("connection lost or replaced");
  }

  if (driveArmed && estopActive()) {
    disarmDrive("the emergency stop is on");
  }

  let targetSpeed = 0;
  let targetSteer = 0;

  if (padHeld) {

    /* screen y grows downward; forward is up. Left of centre is
       a positive (left) steering angle, per REP-103. */
    targetSpeed = -padVec.y * limitSpeed();
    targetSteer = -padVec.x * limitSteer();

  } else if (driveKeys.size) {

    targetSpeed = keyAxis(KEY_FWD, KEY_BACK) * limitSpeed();
    targetSteer = keyAxis(KEY_LEFT, KEY_RIGHT) * limitSteer();
  }

  const active =
    driveArmed && (padHeld || driveKeys.size > 0);

  if (active) {

    const accel = padHeld ? PAD_ACCEL : KEY_ACCEL;
    const steerRate = padHeld ? PAD_STEER_RATE : KEY_STEER_RATE;

    cmdSpeed = towards(cmdSpeed, targetSpeed, accel * dt);
    cmdSteer = towards(cmdSteer, targetSteer, steerRate * dt);

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

  $("cmdSpeed").textContent = cmdSpeed.toFixed(2) + " m/s";
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
    fresh ? robotSpeedMps.toFixed(2) + " m/s" : "—";

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
  const names = (topic && topic.publishers) || [];

  return {
    /* every web dashboard publishes through the rosbridge node */
    web: names.some(name => /rosbridge/.test(name)),
    /* system_diagnostics publishes /drive only for the watchdog's zeros */
    autonomous: names.filter(name => !/rosbridge|system_diagnostics/.test(name))
  };
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
  const active = driveArmed && (padHeld || driveKeys.size > 0);

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

  } else if (active) {

    hero = { tone: "you", icon: "joystick", title: "You are driving",
             sub: "Let go to stop. STOP, Space or Esc disarms." };

  } else if (driveArmed) {

    hero = { tone: "you", icon: "joystick", title: "You're armed",
             sub: "Hold the pad or a drive key to move." };

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
    padDisconnectBusy ? "Disconnecting…" : icon("gamepad") + " Disconnect controller";
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

function setHighSpeed(on) {

  highSpeed = on;

  const slider = $("maxSpeed");

  slider.max = on ? HIGH_MAX_SPEED : NORMAL_MAX_SPEED;

  if (!on && parseFloat(slider.value) > NORMAL_MAX_SPEED) {
    slider.value = NORMAL_MAX_SPEED;
  }

  $("speedUnlockBtn").innerHTML =
    on ? "Lock back to 3 m/s" : icon("alert") + " Unlock high speed (up to 5 m/s)";

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
    limitSpeed().toFixed(1) + " m/s";

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
