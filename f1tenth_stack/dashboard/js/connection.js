"use strict";

/* rosbridge connection, service calls and subscriptions. */

/* ==========================================================
   ROS SERVICE CALL
========================================================== */

function call(service, args = {}) {

  return new Promise((resolve, reject) => {

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected"));
      return;
    }

    const id = "call_" + (++sequence);

    pending.set(id, { resolve, reject });

    /* 12s, not 8: the joystick check shells out to `ros2 run`
       on the robot and is allowed 8s there, so a shorter
       deadline would time out a call that is about to answer.
       rosapi calls are unaffected — scan() retries every 5s. */
    setTimeout(() => {

      if (pending.delete(id)) {
        reject(new Error("timeout " + service));
      }

    }, 12000);

    send({
      op: "call_service",
      service,
      args,
      id
    });
  });
}

/* ==========================================================
   CONNECTION
========================================================== */

function setConnectionState(text, connected) {

  $("connLabel").textContent =
    text.toUpperCase();

  $("connDot").className =
    "connection-dot " +
    (connected ? "connected" : "disconnected");

  /* the pill around it, coloured to match */
  $("connDot").parentElement.dataset.state =
    connected ? "connected" : /connecting/i.test(text) ? "connecting" : "disconnected";
}

function setConnectionHint(text) {

  $("connHint").textContent = text;
  $("connHint").hidden = !text;
}

function connect(url) {

  if (ws) {

    try {
      ws.onclose = null;
      ws.close();
    } catch (error) {}
  }

  topics.clear();
  subscribed.clear();

  runningNodes = new Set();

  diag = {};
  vesc = null;
  mux = null;
  scanStats = null;
  lastScan = null;
  scanHistory.length = 0;

  expanded.clear();
  latestMsg.clear();

  lastAnything = 0;
  lastPublish = 0;
  connectedAt = 0;
  clients = null;

  totalGraphTopics = 0;

  setConnectionState("connecting", false);

  try {

    ws = new WebSocket(url);

  } catch (error) {

    setConnectionState("bad url", false);
    return;
  }

  ws.onopen = () => {

    connectedAt = performance.now();

    setConnectionState("connected", true);

    setConnectionHint("");

    subscribeFixed();

    scan();

    /* the camera follows the robot (camera.js) */
    cameraOnRobotConnected(url);
  };

  ws.onclose = () => {

    setConnectionState("disconnected", false);

    cameraOnRobotDisconnected();
  };

  ws.onerror = () => {

    setConnectionState("connection failed", false);

    setConnectionHint(
      "Cannot reach rosbridge at " + url + ". On the robot: " +
      "ros2 launch rosbridge_server rosbridge_websocket_launch.xml");
  };

  ws.onmessage = event => {

    lastAnything = performance.now();

    let message;

    try {

      message = JSON.parse(event.data);

    } catch (error) {

      return;
    }

    /* Never let one bad message kill the loop. */
    try {

      handleMessage(message);

    } catch (error) {

      console.error("handler", error);
    }
  };
}

/* ==========================================================
   ROS MESSAGE HANDLER
========================================================== */

function handleMessage(message) {

  if (message.op === "service_response") {

    const callback =
      pending.get(message.id);

    if (callback) {

      pending.delete(message.id);

      /* rosbridge answers a failed call with result:false and an
         error STRING in values. Resolving that like a normal
         reply hands the caller an object whose every field is
         undefined — a missing service then renders as an empty
         result instead of an error. */
      if (message.result === false) {

        callback.reject(
          new Error(
            String(
              message.values || "service call failed"
            )
          )
        );

      } else {

        callback.resolve(message.values);
      }
    }

    return;
  }

  if (message.op !== "publish") return;

  const topicName = message.topic;
  const now = performance.now();

  lastPublish = now;

  if (topicName === "/client_count") {

    clients = message.msg.data;
    return;
  }

  const topic = topics.get(topicName);

  if (
    topicName === "/drive" &&
    message.msg && message.msg.header &&
    message.msg.header.frame_id === DRIVE_WATCHDOG_FRAME
  ) {
    lastWatchdogStop = now;
  }

  if (topic) {

    topic.count++;
    topic.last = now;

    if (topic.first === null) {
      topic.first = now;
    }
  }

  if (expanded.has(topicName)) {
    latestMsg.set(topicName, message.msg);
  }

  if (topicName === "/diagnostics") {

    onDiagnostics(message.msg);

  }

  else if (topicName === "/rosout") {

    onLog(message.msg);

  }

  else if (topicName === "/sensors/core") {

    onVesc(message.msg);

  }

  else if (topicName === "/scan") {

    onScan(message.msg);

  }

  else if (topicName === "/odom") {

    onOdom(message.msg);
  }

  else if (topicName === "/joy") {

    onJoy(message.msg);

    /* the Controller tab's live drawing (controller.js) */
    if (typeof onControllerJoy === "function") onControllerJoy(message.msg);
  }
}

/* ==========================================================
   ODOMETRY / SPEED
========================================================== */

/*
   /odom is the preferred source for dashboard speed.

   nav_msgs/msg/Odometry:
       msg.twist.twist.linear.x

   The F1TENTH vesc_to_odom node converts VESC ERPM into
   physical linear velocity in meters/second.

   Therefore:
       positive = forward
       negative = reverse
       zero     = stopped
*/

function onOdom(message) {

  if (
    !message ||
    !message.twist ||
    !message.twist.twist ||
    !message.twist.twist.linear
  ) {
    return;
  }

  const speedMps =
    Number(message.twist.twist.linear.x);

  if (!Number.isFinite(speedMps)) {
    return;
  }

  updateSpeed(speedMps);
}

/* ==========================================================
   LIDAR
========================================================== */

/* "Is the LiDAR connected" is a much weaker question than "what
   is it seeing". These are the cheap summary statistics of the
   scan we already receive — a full radar plot draws from the
   same message. ~1081 ranges at the 5 Hz liveness throttle is
   nothing, but never do this work unthrottled. */

function onScan(message) {

  const ranges = message.ranges || [];
  const rangeMin = Number(message.range_min);
  const rangeMax = Number(message.range_max);

  let min = Infinity;
  let max = -Infinity;
  let finite = 0;

  for (const value of ranges) {

    if (isValidRange(value, rangeMin, rangeMax)) {

      finite++;

      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  const span =
    Number(message.angle_max) - Number(message.angle_min);

  scanStats = {
    points: ranges.length,
    finite,
    min: finite ? min : null,
    max: finite ? max : null,
    fov: Number.isFinite(span)
      ? span * 180 / Math.PI
      : null,
    at: performance.now()
  };

  lastScan = message;

  scanHistory.push({ at: scanStats.at, ranges });

  while (
    scanHistory.length &&
    scanStats.at - scanHistory[0].at > SCAN_HISTORY_MS
  ) {
    scanHistory.shift();
  }
}

/* ---- radar geometry ----
   Pure, so tests/verify_radar.mjs can check it with no DOM/websocket.

   A "no return" beam does NOT come back as inf/NaN on this
   Hokuyo — measured on the robot, it reports ~65.5 m (the raw
   SCIP sentinel 65535 mm passed straight through), well above
   range_max (30 m). Anything at or past range_max is that
   sentinel, not a real wall. */

function isValidRange(value, rangeMin, rangeMax) {

  return typeof value === "number" &&
    isFinite(value) &&
    value > rangeMin &&
    value < rangeMax;
}

/* angle 0 = straight ahead (REP-103: x forward, y left, angle
   grows counter-clockwise). Mapped so the canvas reads like a
   chase-cam behind the robot: forward is up, left is left. */

function polarToCanvas(
  angle,
  range,
  pxPerMeter,
  originX,
  originY
) {

  return {
    x: originX -
      range * pxPerMeter * Math.sin(angle),

    y: originY -
      range * pxPerMeter * Math.cos(angle)
  };
}

/* Closest valid return between two bearings (radians, REP-103:
   0 ahead, positive left). Returns { range, index } or null when
   every beam in the sector is a no-return. */

function sectorMin(
  ranges,
  angleMin,
  angleInc,
  rangeMin,
  rangeMax,
  fromAngle,
  toAngle
) {

  const lo = Math.min(fromAngle, toAngle);
  const hi = Math.max(fromAngle, toAngle);

  let best = null;

  for (let i = 0; i < ranges.length; i++) {

    const angle = angleMin + i * angleInc;

    if (angle < lo || angle > hi) continue;

    const value = ranges[i];

    if (!isValidRange(value, rangeMin, rangeMax)) continue;

    if (!best || value < best.range) {
      best = { range: value, index: i };
    }
  }

  return best;
}

/* "Closer", "farther" or "steady" between two readings, with a
   dead band so sensor noise (~3 cm on this Hokuyo) does not make
   the arrow flicker. */

function rangeTrend(now, before, deadBand = 0.1) {

  if (!Number.isFinite(now) || !Number.isFinite(before)) return "steady";

  if (now < before - deadBand) return "closer";
  if (now > before + deadBand) return "farther";

  return "steady";
}

/* ==========================================================
   SUBSCRIPTIONS
========================================================== */

/* /diagnostics interleaves one array per publisher (system_diagnostics,
   ackermann_mux, urg_node), each at 1 Hz. Throttled with queue_length 1,
   rosbridge keeps only the newest message in each window, and because the
   publishers' timers hold a fixed phase the same one can lose every time
   for a whole run - on #6 it was system_diagnostics, so every system tile
   sat at "waiting". It is a few small messages a second: take them all. */
function subscribeTopic(name, throttle) {

  const all = name === "/diagnostics";

  send({
    op: "subscribe",
    topic: name,
    throttle_rate: all ? 0 : throttle,
    queue_length: all ? 10 : 1
  });
}

function subscribeFixed() {

  send({
    op: "subscribe",
    topic: "/rosout",
    throttle_rate: 0,
    queue_length: 10
  });

  /* rosbridge's own count of connected clients. It publishes on
     change only, so this reads "—" until someone connects or
     disconnects — including, usually, our own arrival, which
     lands before this subscription is registered. */

  send({
    op: "subscribe",
    topic: "/client_count",
    throttle_rate: 0,
    queue_length: 1
  });

  /*
     Robot physical speed.

     We use /odom instead of /sensors/core because /odom gives
     linear velocity in meters/second while VESC speed is ERPM.
  */

  send({
    op: "subscribe",
    topic: "/odom",
    throttle_rate: 100,
    queue_length: 1
  });
}

/* Expanding a row makes it resubscribe faster, so the values
   actually move while you are watching them. */

function toggleTopic(name) {

  if (expanded.has(name)) {

    expanded.delete(name);
    latestMsg.delete(name);

    send({
      op: "unsubscribe",
      topic: name
    });

    subscribeTopic(name, LIVENESS_THROTTLE);

  } else {

    expanded.add(name);

    send({
      op: "unsubscribe",
      topic: name
    });

    subscribeTopic(name, DETAIL_THROTTLE);
  }

  const row = rowEls.get(name);

  if (!row) return;

  const open = expanded.has(name);

  row.tr.classList.toggle("open", open);

  row.detail.style.display =
    open ? "" : "none";

  if (open) {
    row.pre.textContent =
      "waiting for a message…";
  }
}

/* Big arrays (LaserScan has 1081 ranges) are summarised, not
   dumped. */

function summarize(value) {

  if (Array.isArray(value)) {

    if (value.length > 12) {

      const numbers =
        value.filter(
          item =>
            typeof item === "number" &&
            isFinite(item)
        );

      const head =
        value.slice(0, 6).map(
          item =>
            typeof item === "number"
              ? +item.toFixed(3)
              : item
        );

      let stat = "";

      if (numbers.length) {

        stat =
          `, finite ${numbers.length}` +
          `, min ${Math.min(...numbers).toFixed(2)}` +
          `, max ${Math.max(...numbers).toFixed(2)}`;
      }

      return (
        `[${value.length} items${stat}] ` +
        `first 6: ${JSON.stringify(head)}`
      );
    }

    return value.map(summarize);
  }

  if (value && typeof value === "object") {

    const out = {};

    for (const key of Object.keys(value)) {
      out[key] = summarize(value[key]);
    }

    return out;
  }

  return value;
}