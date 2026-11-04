"use strict";

/* Connection health and on-demand checks. */

/* ==========================================================
   CONNECTION HEALTH

   Three states the page must tell apart, because the fixes
   differ:
     nothing at all from rosbridge  -> the robot went away
     services answer, no topic data -> WE are a starved client
                                       past the limit
     more clients than rosbridge serves -> somebody is starved,
                                       maybe not us
   The middle one is the dangerous one: every topic reads SILENT
   and the page looks exactly like a dead robot, which is what
   sent a session chasing the wrong thing.
========================================================== */

/* /client_count is published on CHANGE only, so a tab that
   connects after the last change never hears one and keeps
   whatever it had — observed on the car as one tab reading 2
   and another reading 0 with both connected. A page is itself a
   client, so any count below 1 is provably stale. Say unknown
   rather than something false; the starved-client detection
   below does not depend on this number at all. */
function clientsLabel(count, limit) {

  const known = count !== null && count >= 1;

  if (!known) {
    return { text: "—", cls: "" };
  }

  return {
    text: `${count} / ${limit}`,
    cls:
      count > limit
        ? "over"
        : count >= limit - 2
        ? "near"
        : ""
  };
}

function bannerState(now, state) {

  if (!state.wsOpen) return null;

  const quiet =
    state.lastAnything
      ? now - state.lastAnything
      : Infinity;

  if (quiet > state.connStaleMs) {
    return { kind: "stale" };
  }

  /* A starved client never receives a single publish, so "no
     publish yet" has to count once we have been connected long
     enough to expect one. */
  const since =
    state.lastPublish
      ? now - state.lastPublish
      : state.connectedAt
      ? now - state.connectedAt
      : 0;

  if (since > state.publishStaleMs) {

    return {
      kind: "starved",
      text:
        "rosbridge is answering but sending no topic data — " +
        "this page is probably past its client limit (" +
        state.limit +
        "). Close another dashboard tab."
    };
  }

  if (
    state.clients !== null &&
    state.clients > state.limit
  ) {

    return {
      kind: "crowded",
      text:
        state.clients +
        " clients connected, rosbridge serves " +
        state.limit +
        " — some dashboards are receiving nothing."
    };
  }

  return null;
}

function renderConnectionHealth(now) {

  const banner = bannerState(now, {
    wsOpen:
      Boolean(ws && ws.readyState === WebSocket.OPEN),
    lastAnything,
    lastPublish,
    connectedAt,
    clients,
    limit: CLIENT_LIMIT,
    connStaleMs: CONNECTION_STALE_MS,
    publishStaleMs: PUBLISH_STALE_MS
  });

  $("staleBar").classList.toggle(
    "show",
    Boolean(banner && banner.kind === "stale")
  );

  const limitBar = $("limitBar");

  limitBar.classList.toggle(
    "show",
    Boolean(banner && banner.kind !== "stale")
  );

  if (banner && banner.text) {
    limitBar.textContent = banner.text;
  }

  const label =
    clientsLabel(clients, CLIENT_LIMIT);

  /* people, not "clients": "Just you", "3 people" */
  $("clientsValue").textContent =
    label.text === "—"
      ? "—"
      : clients === 1
      ? "Just you"
      : clients + " people";

  $("clientsFooter").className = label.cls;
}

/* ==========================================================
   ON-DEMAND CHECKS

   The rest of this page only watches. This is the one control
   that makes the robot run something, over the same websocket,
   as a std_srvs/Trigger on system_diagnostics.py — no second
   port, no HTTP endpoint, no custom .srv. The result is
   deliberately verbose: it is read once, when something is
   wrong.
========================================================== */

async function runJoyCheck() {

  const button = $("joyBtn");
  const out = $("joyResult");

  out.classList.add("show");

  out.style.color = "var(--ink-2)";

  out.textContent =
    "running " + JOY_SERVICE + " on the robot… " +
    "(a few seconds)";

  button.disabled = true;

  try {

    const result = await call(JOY_SERVICE);

    out.textContent =
      result.message ||
      "(the service returned no message)";

    out.style.color =
      result.success
        ? "var(--ok-ink)"
        : "var(--warn-ink)";

  } catch (error) {

    /* Distinguish the two ways this fails, because the fixes
       are different. */
    const missing =
      /does not exist|unavailable|not available/i
        .test(error.message);

    out.style.color = "var(--bad-ink)";

    out.textContent =
      missing
        ? error.message +
          "\n\nsystem_diagnostics.py is not running, or is an " +
          "older copy without the service.\n" +
          "On the robot, restart bringup:  ros2 launch f1tenth_stack bringup_launch.py"
        : "check failed: " + error.message;

  } finally {

    button.disabled = false;
  }
}


/* ==========================================================
   RESTART THE DASHBOARD ON THE CAR

   Stops and starts again every node on the car (bringup, rosbridge, the
   camera, the page's server), from the page - for when it lags or stops
   updating: the bringup launch is stopped and started again with the same
   arguments (restart_stack.py). By hand on the car, the same is Ctrl+C on
   bringup, then bringup again. Two
   routes, because the thing that has hung is usually rosbridge itself:

   1. system_diagnostics' ~/restart_stack, over rosbridge. It refuses
      while the car could be moving or the emergency stop is on, and that
      refusal is final: the page does not go round it.
   2. camera_http's POST /restart on :8082, plain HTTP, when rosbridge does
      not answer at all. It cannot see ROS, so the page disarms first and
      the confirmation says the car must be stopped.

   Then it waits for the car to come back (rosbridge answering, this page
   served again) and reloads, which also clears whatever made the page lag.
========================================================== */

const RESTART_ASK_MS = 6000;       // rosbridge must answer in this long
const RESTART_PROBE_EVERY_MS = 2000;
const RESTART_FIRST_PROBE_MS = 8000;   // nothing is back before this
const RESTART_GIVE_UP_MS = 180000;

let restartStarted = 0;
let restartTimer = null;
let restartProbing = false;

function restartHost() {
  try {
    return new URL($("wsUrl").value.trim()).hostname;
  } catch (error) {
    return "";
  }
}

function restartCarName() {
  const robot = (typeof ROBOTS !== "undefined" ? ROBOTS : [])
    .find(r => r.url === $("wsUrl").value.trim());
  return robot ? robot.name : restartHost() || "the car";
}

function showRestart(title, text, steps, state) {

  $("restartOverlay").hidden = false;
  $("restartOverlay").dataset.state = state;       // asking, waiting, failed
  $("restartTitle").textContent = title;
  $("restartText").textContent = text;
  $("restartSteps").innerHTML = steps.map(([label, done]) =>
    `<li class="${done === true ? "done" : done === "now" ? "now" : ""}">${escapeHtml(label)}</li>`).join("");
  $("restartWait").hidden = state !== "late";
  $("restartClose").hidden = state === "asking" || state === "waiting";
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function runRestart() {

  const car = restartCarName();
  const host = restartHost();

  if (!host) {
    alert("Pick the car in the top bar first.");
    return;
  }

  if (!confirm(
    `Restart the dashboard on ${car}?\n\n` +
    "This stops and starts again everything bringup runs on the car: " +
    "bringup (the drive stack), rosbridge, the camera and this page's server.\n\n" +
    "• The car must be stopped. Driving from this page is disarmed now.\n" +
    "• Every dashboard on this car loses its connection for about a minute.\n" +
    "• This page reloads by itself when the car is back.")) return;

  if (typeof driveArmed !== "undefined" && driveArmed) disarmDrive("restarting the dashboard on the car");

  showRestart(`Restarting the dashboard on ${car}`, "Asking the car…",
    [["Ask the car to restart", "now"], ["Wait for it to come back", false], ["Reload this page", false]], "asking");

  let answer = null;

  /* 1. over rosbridge, which checks the car is safe to restart */
  if (socketOpen()) {
    try {
      const result = await withTimeout(call(RESTART_SERVICE), RESTART_ASK_MS);
      answer = { ok: Boolean(result.success), message: result.message || "", via: "rosbridge" };
    } catch (error) {
      answer = null;              // no such service, or rosbridge is stuck: try 2
    }
  }

  /* 2. plain HTTP to the camera server, apart from rosbridge */
  if (!answer) {
    try {
      const response = await withTimeout(fetch(`http://${host}:8082/restart`, {
        method: "POST", body: "restart", cache: "no-store"
      }), RESTART_ASK_MS);
      const body = await response.json();
      answer = { ok: Boolean(body.ok), message: body.message || "", via: "the camera server" };
    } catch (error) {
      answer = null;
    }
  }

  if (!answer) {
    showRestart("Could not reach the car",
      "Neither rosbridge nor the camera server answered, so nothing was restarted. " +
      `On the car: stop bringup (Ctrl+C) and start it again.`,
      [["Ask the car to restart", false]], "failed");
    return;
  }

  if (!answer.ok) {
    showRestart("The car did not restart", answer.message,
      [["Ask the car to restart", false]], "failed");
    return;
  }

  restartStarted = performance.now();
  restartWaitLoop(car, answer.via);
}

/* Is the car back? rosbridge takes a connection, and this page is served
   again (when the car serves it). A function on its own so a test can
   stand in for the network. */
function restartProbe() {

  return new Promise(resolve => {

    let socket;
    const done = ok => {
      clearTimeout(timer);
      try { socket.onopen = socket.onerror = null; socket.close(); } catch (error) {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 2500);

    try {
      socket = new WebSocket($("wsUrl").value.trim());
    } catch (error) {
      done(false);
      return;
    }

    socket.onopen = () => done(true);
    socket.onerror = () => done(false);

  }).then(async rosbridge => {

    if (!rosbridge) return false;
    if (location.protocol === "file:") return true;

    try {
      const page = await fetch(location.href, { cache: "no-store" });
      return page.ok;
    } catch (error) {
      return false;
    }
  });
}

function restartWaitLoop(car, via) {

  clearInterval(restartTimer);

  const tick = async () => {

    const elapsed = performance.now() - restartStarted;
    const s = Math.floor(elapsed / 1000);

    $("restartTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

    if (elapsed > RESTART_GIVE_UP_MS) {
      clearInterval(restartTimer);
      showRestart(`${car} has not come back yet`,
        "It has been three minutes. On the car, `ros2 node list` says what is " +
        "running, and /tmp/f1tenth-diag/restart.log what the restart printed.",
        [["Asked the car to restart", true], ["Wait for it to come back", false]], "late");
      return;
    }

    if ($("restartOverlay").dataset.state !== "waiting") {
      showRestart(`Restarting the dashboard on ${car}`,
        `The car is restarting (asked through ${via}). Bringup, rosbridge and the camera ` +
        "come back one after another; this usually takes 30 to 60 seconds.",
        [["Asked the car to restart", true], ["Wait for it to come back", "now"], ["Reload this page", false]], "waiting");
    }

    if (elapsed < RESTART_FIRST_PROBE_MS || restartProbing) return;

    restartProbing = true;
    const back = await restartProbe();
    restartProbing = false;

    if (back) {
      clearInterval(restartTimer);
      showRestart(`${car} is back`, "Reloading this page…",
        [["Asked the car to restart", true], ["Wait for it to come back", true], ["Reload this page", "now"]], "waiting");
      setTimeout(() => location.reload(), 600);
    }
  };

  tick();
  restartTimer = setInterval(tick, RESTART_PROBE_EVERY_MS);
}

document.querySelectorAll("[data-restart]").forEach(button => {
  button.onclick = runRestart;
});

$("restartClose").onclick = () => {
  clearInterval(restartTimer);
  $("restartOverlay").hidden = true;
};

$("restartWait").onclick = () => {
  restartStarted = performance.now() - RESTART_FIRST_PROBE_MS;
  restartWaitLoop(restartCarName(), "the car");
};
