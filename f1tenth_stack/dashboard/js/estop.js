"use strict";

/* Emergency stop: the one button that stops the car for everyone. */

/* ==========================================================
   EMERGENCY STOP

   The page's own STOP only stops THIS page — the physical
   controller has priority in ackermann_mux and would carry on.
   E-STOP instead asks system_diagnostics.py on the robot to
   freeze ackermann_to_vesc_node, the single node every input
   (controller, web, autonomous) passes through to reach the
   motor, and to hold the motor at speed 0 itself. Nothing can
   move the car until someone presses Release.

   No confirmation on the way in — it is for emergencies. The
   way out asks, and is refused while anyone is holding the
   controller's deadman, so the car never resumes into a live
   command.

   The robot reports the state as "system: E-stop" on
   /diagnostics, so every open dashboard shows the same banner.
========================================================== */

const ESTOP_SERVICE = "/system_diagnostics/emergency_stop";
const ESTOP_RELEASE = "/system_diagnostics/emergency_release";

/* what we believe until the robot's diagnostics confirm it */
let estopLocal = false;
let estopError = "";
let estopBusy = false;

/* Deadman state, read straight from /joy. NOT the mux's
   "unmasked": joy_teleop keeps /teleop alive whenever a pad is
   connected, so the mux reads "joystick unmasked" with nobody
   touching it (spike notes, S-22) and Release would never unlock.
   L1 = buttons[4] (manual), R1 = buttons[5] (autonomous), from
   joy_teleop.yaml. A silent /joy means no pad, so nothing held. */
const JOY_L1 = 4;
const JOY_R1 = 5;
const JOY_FRESH_MS = 1000;

let joyButtons = [];
let joyAt = 0;

function onJoy(message) {

  joyButtons = message.buttons || [];
  joyAt = Date.now();
}

/* a controller is connected to the car: /joy is coming in */
function padOnCar() {
  return Date.now() - joyAt <= JOY_FRESH_MS;
}

function deadmanHeld() {

  if (Date.now() - joyAt > JOY_FRESH_MS) return false;

  return joyButtons[JOY_L1] === 1 || joyButtons[JOY_R1] === 1;
}

function estopDiag() {

  const item = diag["system: E-stop"];

  return item && Date.now() - item.receivedAt < 5000 ? item : null;
}

function estopActive() {

  const item = estopDiag();

  return item ? item.level === 2 : estopLocal;
}

/* what tripped it, when the robot's obstacle stop did: "obstacle stop:
   something 0.62 m ahead at 2.40 m/s (needs 1.40 m to stop)", or "" */
function estopObstacle() {
  const item = estopDiag();
  const action = estopActive() && item && item.values ? item.values["action"] || "" : "";
  return /^obstacle stop:/.test(action) ? action.split(" - ")[0] : "";
}

function estopFailureText(error) {

  if (/not connected/i.test(error.message)) {
    return "E-STOP could not reach the robot — not connected. " +
      "Use the controller or the car's power switch.";
  }

  if (/does not exist|unavailable|not available/i.test(error.message)) {
    return "E-STOP is not available on this robot: system_diagnostics.py " +
      "is an older copy or not running. Use the controller or the power switch.";
  }

  return "E-STOP failed: " + error.message +
    ". Use the controller or the car's power switch.";
}

async function triggerEstop() {

  /* stop this page first, without waiting for the robot */
  if (typeof driveArmed !== "undefined" && driveArmed) {
    disarmDrive("emergency stop");
  }

  estopLocal = true;
  estopError = "";
  estopBusy = true;
  renderEstop();

  try {

    const result = await call(ESTOP_SERVICE);

    /* success:false still means "holding speed 0", just weaker */
    if (!result.success) estopError = result.message;

  } catch (error) {

    estopLocal = false;
    estopError = estopFailureText(error);

  } finally {

    estopBusy = false;
    renderEstop();
  }
}

async function releaseEstop() {

  if (deadmanHeld()) return;

  const ok = confirm(
    "Allow driving again?\n\n" +
    "The car will accept driving commands again. Make sure the area " +
    "is clear and nobody is about to drive.");

  if (!ok) return;

  estopBusy = true;
  renderEstop();

  try {

    const result = await call(ESTOP_RELEASE);

    estopLocal = false;
    estopError = result.success ? "" : result.message;

  } catch (error) {

    estopError = "Release failed: " + error.message;

  } finally {

    estopBusy = false;
    renderEstop();
  }
}

function renderEstop() {

  const active = estopActive();
  const item = estopDiag();
  const bar = $("estopBar");

  bar.hidden = !active && !estopError;
  bar.classList.toggle("error-only", !active && Boolean(estopError));

  const obstacle = estopObstacle();

  $("estopText").innerHTML =
    active && obstacle
      ? "<strong>Obstacle stop.</strong> The car stopped itself: " +
        escapeHtml(obstacle.replace(/^obstacle stop:\s*/, "")) +
        ". Clear the way, then allow driving again."
      : active
      ? "<strong>Emergency stop is on.</strong> " +
        "The car will not move for anyone — controller, this page or autonomous code."
      : escapeHtml(estopError);

  /* what the robot actually did, e.g. "locked the mux (/emergency_stop)" */
  const action =
    active && item && item.values ? item.values["action"] || "" : "";

  $("estopDetail").textContent =
    active
      ? estopBusy && !item
        ? "Sending to the robot…"
        : (action ? "Robot: " + action + "." : "") +
          (estopError ? " " + estopError : "")
      : "";

  const release = $("estopRelease");
  const deadman = deadmanHeld();

  release.hidden = !active;
  release.disabled = estopBusy || deadman;
  release.title =
    deadman
      ? "Someone is holding the controller's deadman — they must let go first"
      : "Let the car be driven again";
  release.textContent =
    deadman ? "Allow driving again (controller in use)" : "Allow driving again";

  const button = $("estopBtn");

  button.classList.toggle("active", active);
  /* the full name where there is room, "E-stop" on phones (CSS) */
  button.innerHTML =
    icon("stopSign") +
    `<span class="estop-long">Emergency stop${active ? " on" : ""}</span>` +
    `<span class="estop-short">E-stop${active ? " on" : ""}</span>`;
}

$("estopBtn").onclick = triggerEstop;
$("estopRelease").onclick = releaseEstop;
