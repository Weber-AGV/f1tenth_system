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

