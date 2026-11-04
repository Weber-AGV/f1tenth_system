"use strict";

/* Subsystem health, overall health and alerts. */

/* ==========================================================
   SUBSYSTEM HEALTH
========================================================== */

/* vesc_to_odom publishes nothing until it has seen one steering command
   (vesc_to_odom.cpp: vescStateCallback returns early with no servo
   command yet), so after every bringup /odom is silent on a healthy car
   until someone steers. True while that is the likely reason: the node
   is up, the VESC is reporting, and neither odometry nor a steering
   command has arrived since this page loaded. */
function odomWaitingForSteer() {

  const odom = topics.get("/odom");
  const steer = topics.get("/sensors/servo_position_command");
  const core = topics.get("/sensors/core");

  return runningNodes.has("/vesc_to_odom_node") &&
    Boolean(odom) && odom.count === 0 &&
    !(steer && steer.count > 0) &&
    Boolean(core) && classifyTopic(core) === "OK";
}

function subsystemData() {

  const systemGamepad =
    diag["system: Gamepad"];

  const systemCamera =
    diag["system: Camera"];

  const scanTopic =
    topics.get("/scan");

  const odomTopic =
    topics.get("/odom");

  const coreTopic =
    topics.get("/sensors/core");

  /* CONTROLLER */

  let controllerHealth = "unknown";
  let controllerDetail =
    "Waiting for controller diagnostics";

  if (systemGamepad) {

    controllerHealth =
      healthFromDiagnostic(
        systemGamepad.level
      );

    controllerDetail =
      systemGamepad.message ||
      "Controller diagnostic received";
  }

  else if (runningNodes.has("/joy")) {

    controllerHealth = "healthy";
    controllerDetail =
      "Joystick node running";
  }

  /* VESC */

  let vescHealth = "unknown";
  let vescDetail =
    "Waiting for VESC data";

  if (!runningNodes.has("/vesc_driver_node")) {

    vescHealth = "failed";
    vescDetail =
      "/vesc_driver_node is not running";
  }

  else if (vesc) {

    if (vesc.fault !== 0) {

      vescHealth = "failed";

      vescDetail =
        "Fault: " +
        (FAULTS[vesc.fault] ||
         vesc.fault);
    }

    else {

      vescHealth = "healthy";

      /* A driver fix made temp_fet real; before it, this field
         was an unassigned 0.0 that would have rendered as a
         perfectly healthy 0 °C forever. */
      if (
        Number.isFinite(vesc.tempFet) &&
        vesc.tempFet > MOTOR_ABSENT
      ) {

        vescDetail =
          "FET temperature: " +
          vesc.tempFet.toFixed(1) +
          " °C";

        if (vesc.tempFet >= FET_ERR) {

          vescHealth = "failed";

          vescDetail += " — over temperature";
        }

        else if (vesc.tempFet >= FET_WARN) {

          vescHealth = "degraded";

          vescDetail += " — running hot";
        }
      }

      else {

        vescDetail =
          vesc.fetMissing
            ? "VESC responding normally (no FET temperature: this car's vesc_driver needs the temperature patch)"
            : "VESC responding normally";
      }
    }
  }

  /* CONTROL MODE */

  let controlHealth = "unknown";
  let controlDetail =
    "Waiting for ackermann_mux diagnostics";

  if (mux === "teleop") {

    controlHealth = "healthy";
    controlDetail =
      "Teleop input unmasked — joystick has the car";
  }

  else if (mux === "autonomous") {

    controlHealth = "healthy";
    controlDetail =
      "Navigation input unmasked — autonomous control";
  }

  /* Idle is not a fault: at rest, with no deadman held, this is
     exactly what a healthy car reports. Same reasoning as the
     EVENT topic class. */
  else if (mux === "idle") {

    controlHealth = "healthy";
    controlDetail =
      "Idle — no deadman held, normal at rest";
  }

  else if (
    !runningNodes.has("/ackermann_mux")
  ) {

    controlHealth = "failed";
    controlDetail =
      "/ackermann_mux is not running";
  }

  /* LIDAR */

  let lidarHealth = "unknown";
  let lidarDetail =
    "Waiting for LiDAR";

  if (!runningNodes.has("/urg_node")) {

    lidarHealth = "failed";
    lidarDetail =
      "/urg_node is not running";
  }

  /* The lidar takes one network connection at a time. A urg_node left
     over from an earlier run keeps it, so the new driver gets nothing
     while the lidar still answers ping (spike notes, 2026-09-21). */
  else if (scanTopic && scanTopic.pubs > 1) {

    lidarHealth = "failed";
    lidarDetail =
      `${scanTopic.pubs} lidar drivers are publishing /scan - one is left over ` +
      "from an earlier run. Stop bringup, run pkill -f urg_node_driver, then " +
      "start bringup again";
  }

  else if (scanTopic) {

    const state =
      classifyTopic(scanTopic);

    /* urg_node grades its own rate against sensors.yaml (40 Hz within
       5%) and reports it on /diagnostics */
    const rate = diag["urg_node: Laser Scan topic status"];
    const rateFresh = rate && Date.now() - rate.receivedAt < 5000;
    const hz = rateFresh ? numberOr(rate.values["Actual frequency (Hz)"]) : NaN;
    const lo = rateFresh ? numberOr(rate.values["Minimum acceptable frequency (Hz)"]) : NaN;
    const hi = rateFresh ? numberOr(rate.values["Maximum acceptable frequency (Hz)"]) : NaN;

    const network = diag["system: Network"];
    const pingKey = network &&
      Object.keys(network.values).find(key => key.indexOf("lidar ") === 0);
    const answersPing = pingKey && !/NO REPLY/.test(network.values[pingKey]);

    if (state === "OK" && Number.isFinite(hz) && (hz < lo || hz > hi)) {

      lidarHealth = "degraded";
      lidarDetail =
        `Scanning at ${hz.toFixed(1)} Hz, expected ${lo.toFixed(0)} to ${hi.toFixed(0)} Hz`;
    }

    else if (state === "OK") {

      lidarHealth = "healthy";
      lidarDetail =
        Number.isFinite(hz)
          ? `Laser scan publishing at ${hz.toFixed(1)} Hz`
          : "Laser scan data publishing";
    }

    /* #6: a sensor whose data stopped is red, not yellow - the car
       is driving blind */
    else {

      lidarHealth = "failed";
      lidarDetail =
        state === "SILENT"
          ? "LiDAR is running but has sent no scans"
          : state === "STALE"
          ? "LiDAR stopped sending scans"
          : "LiDAR topic unavailable";

      if (answersPing) {
        lidarDetail +=
          ". The lidar answers ping, so the driver cannot connect to it - an " +
          "old urg_node may hold its only connection. Stop bringup, run " +
          "pkill -f urg_node_driver, then start bringup again";
      }
    }
  }

  /* ODOMETRY */

  let odomHealth = "unknown";
  let odomDetail =
    "Waiting for odometry";

  if (
    !runningNodes.has(
      "/vesc_to_odom_node"
    )
  ) {

    odomHealth = "failed";

    odomDetail =
      "/vesc_to_odom_node not running";
  }

  else if (odomWaitingForSteer()) {

    /* normal at rest, like no controller connected */
    odomHealth = "healthy";
    odomDetail =
      "Idle - odometry starts after the first steering command";
  }

  else if (odomTopic) {

    const state =
      classifyTopic(odomTopic);

    if (state === "OK") {

      odomHealth = "healthy";
      odomDetail =
        "Odometry data publishing";
    }

    else if (
      state === "STALE" ||
      state === "SILENT"
    ) {

      odomHealth = "failed";
      odomDetail =
        state === "SILENT"
          ? "Odometry is running but has sent nothing"
          : "Odometry stopped sending";
    }

    else if (
      state === "MISSING" ||
      state === "NODE_DOWN"
    ) {

      odomHealth = "failed";
      odomDetail =
        "Odometry topic unavailable";
    }
  }

  /* CAMERA */

  let cameraHealth = "unknown";
  let cameraDetail =
    "Waiting for camera diagnostics";

  if (systemCamera) {

    cameraHealth =
      healthFromDiagnostic(
        systemCamera.level
      );

    cameraDetail =
      systemCamera.message ||
      "Camera diagnostic received";
  }

  /* frame rate from camera_http, while the stream is showing (#6) */
  if (cameraStats && Date.now() - cameraStats.at < 5000) {

    const { fps, last_frame_s: age } = cameraStats;

    if (age !== null && age > CAMERA_NO_FRAME_S) {
      cameraHealth = "failed";
      cameraDetail = `No frames for ${Math.round(age)} s`;
    } else if (fps !== null && fps < CAMERA_MIN_FPS &&
               healthRank("degraded") > healthRank(cameraHealth)) {
      cameraHealth = "degraded";
      cameraDetail = `Streaming at ${fps.toFixed(0)} fps, expected about 30`;
    } else if (fps !== null && cameraHealth === "healthy") {
      cameraDetail += ` · ${fps.toFixed(0)} fps`;
    }
  }

  /* BATTERY */

  let batteryHealth = "unknown";
  let batteryDetail =
    "Waiting for battery voltage";

  if (vesc) {

    if (vesc.voltage < BATT_ERR) {

      batteryHealth = "failed";

      batteryDetail =
        `${vesc.voltage.toFixed(1)} V - replace the pack soon`;
    }

    else if (
      vesc.voltage < BATT_WARN
    ) {

      batteryHealth = "degraded";

      batteryDetail =
        `${vesc.voltage.toFixed(1)} V - low, get a spare pack ready`;
    }

    else {

      batteryHealth = "healthy";

      batteryDetail =
        `${vesc.voltage.toFixed(1)} V`;
    }
  }

  else if (
    coreTopic &&
    classifyTopic(coreTopic) === "MISSING"
  ) {

    batteryHealth = "failed";

    batteryDetail =
      "/sensors/core unavailable";
  }

  return [
    {
      id: "controller",
      icon: "gamepad",
      name: "Controller",
      subtitle: "Input",
      source: "/joy",
      health: controllerHealth,
      details: controllerDetail
    },

    {
      id: "vesc",
      icon: "zap",
      name: "VESC",
      subtitle: "Motor Controller",
      source: "/vesc_driver_node",
      health: vescHealth,
      details: vescDetail
    },

    {
      id: "lidar",
      icon: "radar",
      name: "LiDAR",
      subtitle: "Hokuyo URG",
      source: "/urg_node + /scan",
      health: lidarHealth,
      details: lidarDetail
    },

    {
      id: "odometry",
      icon: "gauge",
      name: "Odometry",
      subtitle: "Wheel Encoder",
      source: "/vesc_to_odom_node",
      health: odomHealth,
      details: odomDetail
    },

    {
      id: "camera",
      icon: "camera",
      name: "Camera",
      subtitle: "Intel RealSense",
      source: "system: Camera",
      health: cameraHealth,
      details: cameraDetail
    },

    {
      id: "battery",
      icon: "battery",
      name: "Battery",
      subtitle: "Vehicle Power",
      source: "/sensors/core",
      health: batteryHealth,
      details: batteryDetail
    },

    {
      id: "control",
      icon: "swap",
      name: "Control Mode",
      subtitle: mux ? mux : "Command Mux",
      source: "/ackermann_mux",
      health: controlHealth,
      details: controlDetail
    }
  ];
}

/* ==========================================================
   RENDER SUBSYSTEMS
========================================================== */

function renderSubsystems(all) {

  /* Battery has its own card right above; it still feeds the
     overall verdict (renderOverall gets the full list), but a
     table row would only repeat it. */
  /* problems first: failed, then degraded, then unconfirmed; the
     order among equals stays the usual one */
  const data =
    all
      .filter(item => item.id !== "battery")
      .map((item, index) => ({ item, index }))
      .sort((a, b) =>
        healthRank(b.item.health) - healthRank(a.item.health) || a.index - b.index)
      .map(entry => entry.item);

  $("subsystemRows").innerHTML =
    data.map(item => {

      return `
        <tr>

          <td>
            <div class="subsystem-name">

              <div class="subsystem-icon">
                ${icon(item.icon)}
              </div>

              <div>
                <div class="subsystem-title">
                  ${escapeHtml(item.name)}
                </div>

                <span class="subsystem-subtitle">
                  ${escapeHtml(item.subtitle)}
                </span>
              </div>

            </div>
          </td>

          <td class="source">
            ${escapeHtml(item.source)}
          </td>

          <td>
            <span class="health ${item.health}">
              <span class="health-dot"></span>
              ${healthLabel(item.health)}
            </span>
          </td>

          <td class="details">
            ${escapeHtml(item.details)}
          </td>

        </tr>
      `;
    }).join("");

  /* phones: one card per subsystem, in the metric tiles' style. The
     node is usually named in the details already ("/urg_node is not
     running"), so it only gets its own line when it is not. */
  $("subsystemCards").innerHTML =
    data.map(item => {

      const sourceSaid =
        item.source.split(/\s*\+\s*/).every(part => item.details.includes(part));

      return `
        <article class="sub-card ${item.health}">
          <div class="sub-head">
            <div class="subsystem-icon">${icon(item.icon)}</div>
            <div class="sub-name">
              <div class="subsystem-title">${escapeHtml(item.name)}</div>
              <span class="subsystem-subtitle">${escapeHtml(item.subtitle)}</span>
            </div>
            <span class="health ${item.health}">
              <span class="health-dot"></span>
              ${healthLabel(item.health)}
            </span>
          </div>
          <p class="sub-detail">${escapeHtml(item.details)}</p>
          ${sourceSaid ? "" : `<p class="sub-source">${escapeHtml(item.source)}</p>`}
        </article>
      `;
    }).join("");

  const count = health => data.filter(item => item.health === health).length;

  $("subsystemSummary").textContent =
    [[count("failed"), "failed"], [count("degraded"), "degraded"],
     [count("unknown"), "unconfirmed"], [count("healthy"), "healthy"]]
      .filter(([n]) => n)
      .map(([n, word]) => `${n} ${word}`)
      .join(" · ");
}

/* ==========================================================
   OVERALL HEALTH
========================================================== */

function renderOverall(data) {

  /* No rosbridge: nothing below is a verdict on the robot, so do
     not call it FAILED. Say what is actually wrong, and the fix
     (the hint that used to sit in a separate red strip). */
  if (!ws || ws.readyState !== WebSocket.OPEN) {

    const connecting = ws && ws.readyState === WebSocket.CONNECTING;

    $("statusBanner").dataset.health = "offline";
    $("overallStatus").textContent = connecting ? "CONNECTING…" : "NOT CONNECTED";
    $("overallStatus").style.color = "var(--text)";
    $("overallIcon").style.background = "var(--unknown)";
    $("overallIcon").innerHTML = connecting ? "…" : window.icon("power");
    $("overallNote").textContent =
      $("connHint").textContent ||
      (connecting
        ? "Reaching the robot at " + $("wsUrl").value.trim()
        : "Not talking to the robot — check the address in the top bar and press Connect.");
    return;
  }

  let worst = "healthy";

  for (const item of data) {

    if (
      healthRank(item.health) >
      healthRank(worst)
    ) {

      worst = item.health;
    }
  }

  $("statusBanner").dataset.health = worst;

  const status =
    $("overallStatus");

  const icon =
    $("overallIcon");

  const note =
    $("overallNote");

  status.textContent =
    healthLabel(worst);

  status.style.color =
    worst === "healthy"
      ? "var(--healthy)"
      : worst === "degraded"
      ? "var(--warn-ink)"
      : worst === "failed"
      ? "var(--failed)"
      : "var(--unknown)";

  icon.style.background =
    worst === "healthy"
      ? "var(--healthy)"
      : worst === "degraded"
      ? "var(--degraded)"
      : worst === "failed"
      ? "var(--failed)"
      : "var(--unknown)";

  icon.innerHTML =
    worst === "healthy"
      ? window.icon("check")
      : worst === "failed"
      ? "!"
      : worst === "degraded"
      ? "!"
      : "?";

  const failed =
    data.filter(
      item =>
        item.health === "failed"
    ).length;

  const degraded =
    data.filter(
      item =>
        item.health === "degraded"
    ).length;

  const unknown =
    data.filter(
      item =>
        item.health === "unknown"
    ).length;

  /* name what is wrong, not just how many */
  const names = health =>
    data
      .filter(item => item.health === health)
      .map(item => item.name)
      .join(", ");

  if (failed) {

    note.textContent =
      `${failed} critical subsystem` +
      (failed === 1 ? "" : "s") +
      " — " + names("failed");
  }

  else if (degraded) {

    note.textContent =
      `${degraded} subsystem` +
      (degraded === 1 ? "" : "s") +
      " degraded — " + names("degraded");
  }

  else if (unknown) {

    note.textContent =
      `${unknown} subsystem` +
      (unknown === 1 ? "" : "s") +
      " not yet confirmed - " + names("unknown");
  }

  else {

    note.textContent =
      "All monitored systems operational";
  }
}

/* ==========================================================
   STATUS BANNER FACTS
========================================================== */

function renderStatusFacts(data) {

  const healthy =
    data.filter(item => item.health === "healthy").length;

  /* no robot, no count: "0 / 7 healthy" read like seven failures */
  $("factSubsystems").textContent =
    ws && ws.readyState === WebSocket.OPEN
      ? `${healthy} / ${data.length} healthy`
      : "—";

  $("factControl").textContent =
    mux === "teleop"
      ? "Joystick"
      : mux === "autonomous"
      ? "Navigation / web"
      : mux === "idle"
      ? "Idle"
      : "—";

  /* autonomous driving: off, standby, or driving (drive.js) */
  if (typeof autonomousState === "function") {
    const auto = autonomousState();
    $("factAuto").textContent = auto.text;
    $("factAutoBox").dataset.state = auto.state;
    $("factAutoBox").title = auto.detail || "";
    $("factAutoStop").hidden = !["on", "standby"].includes(auto.state);
  }

  const up =
    EXPECTED_NODES.filter(name => runningNodes.has(name)).length;

  $("factNodes").textContent =
    ws && ws.readyState === WebSocket.OPEN
      ? `${up} / ${EXPECTED_NODES.length} up`
      : "—";
}
