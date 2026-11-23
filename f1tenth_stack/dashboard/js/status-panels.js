"use strict";

/* Diagnostic counts, battery, uptime, footer and the ROS graph panel. */

/* ==========================================================
   DIAGNOSTIC COUNTS
========================================================== */

function renderDiagnosticCounts() {

  let ok = 0;
  let warn = 0;
  let error = 0;
  let stale = 0;

  Object.values(diag)
    .forEach(item => {

      if (item.level === 0) ok++;

      else if (item.level === 1) warn++;

      else if (item.level === 2) error++;

      else stale++;
    });

  $("diagOk").textContent = ok;
  $("diagWarn").textContent = warn;
  $("diagError").textContent = error;
  $("diagStale").textContent = stale;
}

/* ==========================================================
   BATTERY
========================================================== */

function renderBattery() {

  if (!vesc) {

    $("batteryVoltage").textContent =
      "--.- V";

    $("batteryNote").textContent =
      "Waiting for /sensors/core";

    $("batteryPercent").textContent =
      "--";

    $("batteryNeedle").style.transform =
      "rotate(-90deg)";

    $("batteryBar").style.width = "0";

    return;
  }

  const voltage =
    vesc.voltage;

  const estimate =
    batteryEstimate(voltage);

  $("batteryVoltage").textContent =
    voltage.toFixed(1) + " V";

  if (voltage < BATT_ERR) {

    $("batteryVoltage").style.color =
      "var(--failed)";

    $("batteryNote").textContent =
      "Replace the pack soon";
  }

  else if (
    voltage < BATT_WARN
  ) {

    $("batteryVoltage").style.color =
      "var(--warn-ink)";

    $("batteryNote").textContent =
      "Low - get a spare pack ready";
  }

  else {

    $("batteryVoltage").style.color =
      "var(--healthy)";

    $("batteryNote").textContent =
      "3S LiPo voltage";
  }

  if (estimate !== null) {

    $("batteryPercent").textContent =
      "~" +
      Math.round(estimate) +
      "% estimated";

    const angle =
      -90 + estimate * 1.8;

    $("batteryNeedle").style.transform =
      `rotate(${angle}deg)`;

    $("batteryBar").style.width =
      estimate + "%";

    $("batteryBar").style.background =
      voltage < BATT_ERR
        ? "var(--failed)"
        : voltage < BATT_WARN
        ? "var(--degraded)"
        : "var(--healthy)";
  }
}

/* ==========================================================
   UPTIME
========================================================== */

function renderUptime() {

  const power =
    diag["system: Power"];

  if (
    !power ||
    !power.values ||
    !power.values["uptime"]
  ) {

    $("uptime").textContent =
      "--:--:--";

    $("uptimeNote").textContent =
      "Waiting for system diagnostics";

    return;
  }

  const raw =
    String(
      power.values["uptime"]
    );

  const seconds =
    parseFloat(raw);

  $("uptime").textContent =
    formatUptime(seconds);

  $("uptimeNote").textContent =
    "Robot system uptime";
}

/* ==========================================================
   NETWORK FOOTER
========================================================== */

function renderNetwork() {

  const network =
    diag["system: Network"];

  if (!network) {

    $("networkFooter").textContent =
      "unknown";

    return;
  }

  /* Same rows as the Network tile, not the node's "N links up", which
     counted interfaces rather than saying which ones. */
  const rows =
    networkRows(network.values || {});

  $("networkFooter").textContent =
    rows.length
      ? rows.map(row => row.label + " " + row.value).join(" · ")
      : network.message || "connected";
}

/* ==========================================================
   ROBOT LABEL FOOTER
   Pulled from system_diagnostics' Clock status, which stamps the OS
   username (e.g. f1-wsu-6) onto every /diagnostics tick - not hardcoded,
   so copying this dashboard onto another robot doesn't silently keep
   showing the wrong one (it did, for a while - see git history).
========================================================== */

function renderRobotLabel() {

  const clock =
    diag["system: Clock"];

  const robot =
    clock && clock.values && clock.values["Robot"];

  $("robotLabel").textContent =
    robot || "unknown";
}

/* ==========================================================
   ROS GRAPH PANEL

   The useful version of "how many nodes": WHICH expected nodes
   are missing, and whether the handful of topics the car cannot
   drive without are actually flowing.
========================================================== */

const KEY_TOPICS = [
  "/scan",
  "/odom",
  "/sensors/core",
  "/diagnostics",
  "/tf",
  "/joy",
  "/ackermann_cmd"
];

function topicTone(state) {

  if (state === "OK" || state === "DRIVEN") return "ok";

  if (
    state === "MISSING" ||
    state === "NODE_DOWN" ||
    state === "SILENT" ||
    state === "STALE" ||
    state === "NOT_ADVERTISED"
  ) return "bad";

  if (BAD_TOPIC_STATES.has(state)) return "warn";

  return "";
}

function renderGraph() {

  const connected =
    Boolean(ws && ws.readyState === WebSocket.OPEN);

  const up =
    EXPECTED_NODES.filter(name => runningNodes.has(name)).length;

  $("graphSummary").textContent =
    !connected
      ? "not connected"
      : `${up} / ${EXPECTED_NODES.length} expected nodes up`;

  $("graphNodes").innerHTML =
    EXPECTED_NODES.map(name => {

      const running = runningNodes.has(name);

      return `
        <li class="${running ? "" : "down"}"
            title="${escapeHtml(name)} — ${running ? "running" : "not running"}">
          <span class="dot ${running ? "ok" : "bad"}"></span>
          <span class="name">${escapeHtml(name.replace(/^\//, ""))}</span>
        </li>
      `;
    }).join("");

  const now = performance.now();

  $("graphTopics").innerHTML =
    KEY_TOPICS.map(name => {

      const topic = topics.get(name);

      const state =
        topic ? classifyTopic(topic) : "UNKNOWN";

      const age =
        topic && topic.last !== null
          ? ((now - topic.last) / 1000).toFixed(1) + "s ago"
          : "";

      const reason =
        topic ? topicReason(topic, state) : "waiting for rosapi";

      return `
        <li title="${escapeHtml(reason)}">
          <span class="dot ${topicTone(state)}"></span>
          <span class="name">${escapeHtml(name)}</span>
          <span class="why">
            <span class="state-pill s-${state}">${state}</span>
            ${age ? " · " + age : ""}
          </span>
        </li>
      `;
    }).join("");
}
