"use strict";

/* Reading the ROS graph, diagnostics, VESC data and the log; topic classification. */

/* ==========================================================
   GRAPH SCAN
========================================================== */

/* One call at a time, never all at once. rosbridge answers a page's
   service calls in order and reads nothing else from that page while it
   waits, so firing the scan's 20-odd calls together held the Drive tab's
   /drive commands back for about 1.2 s every scan, and the robot's drive
   watchdog stopped the car mid-drive. One at a time, a command waits for
   at most one call (measured on robot 6: holes up to about 0.2 s).
   A slow scan is never overlapped by the next one, or the calls would
   pile up again. */
let scanRunning = false;

async function scan() {

  if (scanRunning) return;
  scanRunning = true;

  try {

    const topicList = await call("/rosapi/topics");
    const nodeList = await call("/rosapi/nodes");

    runningNodes =
      new Set(nodeList.nodes || []);

    totalGraphTopics =
      (topicList.topics || []).length;

    const present =
      new Set(topicList.topics || []);

    for (const name of Object.keys(TOPICS)) {

      if (!topics.has(name)) {

        topics.set(name, {
          name,
          type: "",
          pubs: 0,
          count: 0,
          last: null,
          first: null,
          present: false
        });
      }

      topics.get(name).present =
        present.has(name);
    }

    (topicList.topics || [])
      .forEach((name, index) => {

        if (!TOPICS[name]) return;

        const topic = topics.get(name);

        topic.type =
          (topicList.types || [])[index] || "";

        topic.present = true;

        if (!subscribed.has(name)) {

          subscribed.add(name);

          subscribeTopic(name, LIVENESS_THROTTLE);
        }
      });

    for (const name of [...topics.keys()]
      .filter(name => topics.get(name).present)) {

      try {

        const result =
          await call("/rosapi/publishers", {
            topic: name
          });

        topics.get(name).pubs =
          result.publishers.length;

        /* names too: the Drive tab tells a web dashboard
           (published via rosbridge) from autonomous code */
        topics.get(name).publishers =
          result.publishers;

      } catch (error) {}
    }

  } catch (error) {
  } finally {
    scanRunning = false;
  }
}

/* ==========================================================
   DIAGNOSTICS
========================================================== */

function onDiagnostics(message) {

  const now = Date.now();

  (message.status || []).forEach(status => {

    diag[status.name] = {
      level: levelNumber(status.level),
      message: status.message || "",
      values: Object.fromEntries(
        (status.values || []).map(value => [
          value.key,
          value.value
        ])
      ),
      receivedAt: now
    };

    /* ackermann_mux reports which input is unmasked, which is
       the only place the car says what is actually driving it. */
    if (status.name.indexOf("ackermann_mux") === 0) {

      const values = diag[status.name].values;

      const joystick =
        values["velocity topics.joystick"] || "";

      const navigation =
        values["velocity topics.navigation"] || "";

      mux =
        joystick.indexOf("unmasked") >= 0
          ? "teleop"
          : navigation.indexOf("unmasked") >= 0
          ? "autonomous"
          : "idle";
    }
  });
}

/* ==========================================================
   VESC
========================================================== */

/* Recent battery readings, for the median in onVesc (BATT_WINDOW_MS). */
const battSamples = [];

function onVesc(message) {

  const state = message.state;

  if (!state) return;

  const fault =
    Number(state.fault_code) || 0;

  const now = performance.now();
  const reading = Number(state.voltage_input);

  if (Number.isFinite(reading)) battSamples.push({ at: now, v: reading });

  while (battSamples.length && now - battSamples[0].at > BATT_WINDOW_MS) {
    battSamples.shift();
  }

  const sorted = battSamples.map(s => s.v).sort((a, b) => a - b);

  /* everything that shows or judges the battery reads this median */
  const voltage = sorted.length ? sorted[Math.floor(sorted.length / 2)] : reading;

  vesc = {
    voltage,
    voltageNow: reading,
    fault,
    /* Exactly 0.0 is the unassigned default on cars whose vesc_driver
       lacks the temperature patch, never a reading: a constant is not
       a reading. Treated as missing, with fetMissing saying why. */
    tempFet: Number(state.temp_fet) === 0 ? NaN : Number(state.temp_fet),
    fetMissing: Number(state.temp_fet) === 0,
    tempMotor: Number(state.temp_motor)
  };
}

/* ==========================================================
   LOG
========================================================== */

function onLog(message) {

  const level =
    Number(message.level) || 0;

  if (level < 30) return;

  const log = $("log");

  if (!logStarted) {

    log.innerHTML = "";
    logStarted = true;
  }

  const div =
    document.createElement("div");

  div.className =
    "log-entry " +
    (level >= 40 ? "error" : "warn");

  const severity =
    level >= 50
      ? "FATAL"
      : level >= 40
      ? "ERROR"
      : "WARN";

  div.textContent =
    `${formatTime()} ${severity} ` +
    `(${message.name || "?"}) ` +
    `${message.msg || ""}`;

  /* Only follow the tail if the reader is already at it —
     otherwise a burst of warnings yanks the line they were
     reading out from under them. */
  const atBottom =
    log.scrollHeight -
      log.scrollTop -
      log.clientHeight < 40;

  log.appendChild(div);

  while (log.children.length > 300) {
    log.removeChild(log.firstChild);
  }

  if (atBottom) {
    log.scrollTop = log.scrollHeight;
  }
}

/* ==========================================================
   TOPIC CLASSIFICATION
========================================================== */

function classifyTopic(topic) {

  const spec =
    TOPICS[topic.name] || {};

  const fresh =
    topic.last !== null &&
    performance.now() - topic.last <= STALE_MS;

  if (spec.cls && !topic.present) {

    if (spec.cls === INPUT) {
      return "ABSENT";
    }

    if (
      spec.owner &&
      runningNodes.has(spec.owner)
    ) {
      return "NOT_ADVERTISED";
    }

    return "MISSING";
  }

  if (spec.cls === INPUT) {

    return topic.pubs > 0
      ? fresh
        ? "DRIVEN"
        : "INPUT"
      : "INPUT";
  }

  if (spec.cls === LATCHED) {

    return topic.pubs === 0
      ? "NODE_DOWN"
      : topic.count > 0
      ? "OK"
      : "WAITING";
  }

  if (spec.cls === EVENT) {

    return topic.pubs === 0
      ? "NODE_DOWN"
      : fresh
      ? "OK"
      : "IDLE";
  }

  if (topic.pubs === 0) {

    return topic.present
      ? "NODE_DOWN"
      : "MISSING";
  }

  if (topic.last === null) {

    /* vesc_to_odom publishes /odom and /tf from one callback that
       returns early until the first servo command (health.js) */
    return spec.waitsForSteer && odomWaitingForSteer()
      ? "IDLE"
      : "SILENT";
  }

  if (!fresh) {
    return "STALE";
  }

  return "OK";
}

function ownerLabel(spec) {

  return (
    spec.node ||
    (spec.owner || "publisher").replace(/^\//, "")
  );
}

/* Every state gets a sentence saying what it means, because
   "IDLE" on its own reads like a fault when it is normal. */
function topicReason(topic, state) {

  const spec = TOPICS[topic.name] || {};

  switch (state) {

    case "OK":
      return spec.cls === EVENT
        ? "input arriving"
        : "publishing";

    case "IDLE":
      return spec.waitsForSteer
        ? "starts after the first steering command, normal at rest"
        : "no input right now, normal at rest";

    case "INPUT":
      return "subscribed by the stack, nothing publishes it";

    case "DRIVEN":
      return "something is publishing commands";

    case "WAITING":
      return "latched, no message yet";

    case "SILENT":
      return "publisher exists, zero messages ever";

    case "STALE":
      return (
        "last message " +
        (
          (performance.now() - topic.last) / 1000
        ).toFixed(1) +
        "s ago"
      );

    case "NODE_DOWN":
      return "topic exists but has no publisher";

    case "MISSING":
      return (
        "not in the graph — " +
        ownerLabel(spec) +
        " not running"
      );

    case "NOT_ADVERTISED":
      return (
        ownerLabel(spec) +
        " running but not publishing this"
      );

    default:
      return "";
  }
}

