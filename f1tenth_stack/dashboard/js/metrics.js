"use strict";

/* Advanced diagnostics, priority metrics and lidar readout. */

/* ==========================================================
   ADVANCED DIAGNOSTICS
========================================================== */

function renderAdvancedDiagnostics() {

  const ros =
    Object.entries(diag)
      .filter(
        ([name]) =>
          !name.startsWith("system: ")
      );

  const rows = entries =>
    entries.map(([name, item]) => {

      const cls =
        item.level === 0
          ? "lvl-ok"
          : item.level === 1
          ? "lvl-warn"
          : item.level === 2
          ? "lvl-bad"
          : "lvl-unk";

      return `
        <tr>
          <td class="mono">
            ${escapeHtml(name)}
          </td>

          <td class="${cls}">
            ${diagnosticLabel(item.level)}
          </td>

          <td>
            ${escapeHtml(item.message)}
          </td>
        </tr>
      `;
    }).join("");

  $("rosDiagRows").innerHTML =
    rows(ros);
}

/* ==========================================================
   NODE / TOPIC COUNTS
========================================================== */

function renderCounts() {

  let runningExpected = 0;

  EXPECTED_NODES.forEach(name => {

    if (runningNodes.has(name)) {
      runningExpected++;
    }
  });

  $("onlineNodes").textContent =
    runningNodes.size;

  $("nodeExpected").textContent =
    `${runningExpected} of ${EXPECTED_NODES.length} expected`;

  $("activeTopics").textContent =
    totalGraphTopics;

  $("topicExpected").textContent =
    totalGraphTopics
      ? "ROS topics discovered"
      : "waiting for ROS graph";
}

/* ==========================================================
   PRIORITY METRICS
========================================================== */

/* Returns a grade from a value and two thresholds. */
function gradeValue(
  value,
  warn,
  bad,
  higherIsBad = true
) {

  if (!Number.isFinite(value)) {
    return "unknown";
  }

  if (higherIsBad) {
    return value >= bad
      ? "bad"
      : value >= warn
      ? "warn"
      : "ok";
  }

  return value <= bad
    ? "bad"
    : value <= warn
    ? "warn"
    : "ok";
  }

function gradeFromLevel(level) {

  if (level === 0) return "ok";
  if (level === 1) return "warn";
  if (level === 2) return "bad";

  return "unknown";
}

/* Shared by the Network tile and the footer, so they always agree.
   Wi-Fi, the lidar, and Bluetooth. The other interfaces the probe
   reports (can0, docker0, l4tbr0, usb0/1) are switched off on these
   cars by design, so showing them only ever painted a healthy car red.
   The System tab still lists every interface. */
function networkRows(values) {

  const signal =
    numberOr(values["wifi signal"]);

  const linkUp = pattern => {
    const key = Object.keys(values)
      .find(k => pattern.test(k) && /carrier=/.test(values[k]));
    return key ? /carrier=1/.test(values[key]) : null;
  };

  const wifiUp = linkUp(/^(wl|wlan)/);
  const lidarCable = linkUp(/^(en|eth)/);
  const lidarKey =
    Object.keys(values).find(key => key.indexOf("lidar ") === 0);
  const bluetooth = values["bluetooth"];

  const rows = [];

  if (wifiUp !== null) {

    /* signal, loss and round trip to the gateway, each graded on its own
       (#6), the row takes the worst; a value not measured yet is left out */
    const loss = numberOr(values["wifi loss %"]);
    const rtt = numberOr(values["wifi rtt ms"]);

    const grades = [
      Number.isFinite(signal)
        ? signal < WIFI_SIGNAL_ERR ? "bad" : signal < WIFI_SIGNAL_WARN ? "warn" : "ok"
        : null,
      Number.isFinite(loss) ? gradeValue(loss, WIFI_LOSS_WARN, WIFI_LOSS_ERR) : null,
      Number.isFinite(rtt) ? gradeValue(rtt, WIFI_RTT_WARN, WIFI_RTT_ERR) : null
    ].filter(Boolean);

    const parts = [
      Number.isFinite(signal) ? signal + " dBm" : "",
      Number.isFinite(loss) ? loss + "% loss" : "",
      Number.isFinite(rtt) ? Math.round(rtt) + " ms" : ""
    ].filter(Boolean);

    rows.push({
      label: "Wi-Fi",
      value: !wifiUp ? "down" : parts.length ? parts.join(" · ") : "up",
      pct:
        !wifiUp ? 0 : Number.isFinite(signal) ? (signal + 90) / 60 * 100 : 100,
      grade: !wifiUp
        ? "bad"
        : grades.includes("bad") ? "bad" : grades.includes("warn") ? "warn" : "ok",
      hint:
        "The robot's Wi-Fi link, which carries this page. Signal: " +
        `${WIFI_SIGNAL_WARN} dBm or better is good, below ${WIFI_SIGNAL_ERR} is bad. ` +
        `Packet loss and round trip are to the router: under ${WIFI_LOSS_WARN}% and ` +
        `${WIFI_RTT_WARN} ms is good, ${WIFI_LOSS_ERR}% or more, or over ` +
        `${WIFI_RTT_ERR} ms, is bad.`
    });
  }

  if (lidarCable !== null || lidarKey) {
    const answering = lidarKey && !/NO REPLY/.test(values[lidarKey]);
    rows.push({
      label: "Lidar",
      value:
        lidarCable === false ? "unplugged"
        : answering ? "answering"
        : lidarKey ? "no reply"
        : "cable in",
      pct: answering ? 100 : 0,
      grade:
        lidarCable === false || (lidarKey && !answering) ? "bad"
        : answering ? "ok"
        : "unknown",
      hint:
        "The Hokuyo lidar, on its own Ethernet cable" +
        (lidarKey ? " at " + lidarKey.slice(6) : "") + ". " +
        "Unplugged: no cable link. No reply: the cable is in but the " +
        "lidar does not answer a ping (check its power)."
    });
  }

  if (bluetooth) {
    rows.push({
      label: "Bluetooth",
      value: bluetooth,
      pct: bluetooth === "on" ? 100 : 0,
      grade:
        bluetooth === "on" ? "ok" : bluetooth === "unknown" ? "unknown" : "warn",
      hint:
        "The Jetson's Bluetooth radio. It has to be on for the PS4 " +
        "controller to connect."
    });
  }

  return rows;
}

/* Shared by the single big bar and each multi-row tile's mini bar. */
function clampPct(pct) {

  return pct === null || !Number.isFinite(pct)
    ? 0
    : Math.max(0, Math.min(100, pct));
}

const numberOr = (
  raw,
  fallback = NaN
) => {

  const n = parseFloat(raw);

  return Number.isFinite(n)
    ? n
    : fallback;
};

/* ==========================================================
   SPEED
========================================================== */

/*
   REAL ROBOT SPEED

   Speed comes from the ROS2 /odom topic:

       /odom
          -> twist
             -> twist
                -> linear
                   -> x

   /odom gives physical linear velocity in meters/second.

   Positive value = forward
   Negative value = reverse
   Near zero       = stopped

   connection.js receives /odom and calls:

       updateSpeed(speedMps)
*/

let robotSpeedMps = null;
let robotSpeedAt = 0;

function updateSpeed(speedMps) {

  const value =
    Number(speedMps);

  if (
    !Number.isFinite(value)
  ) {
    return;
  }

  robotSpeedMps =
    value;

  robotSpeedAt =
    performance.now();
}

function getSpeedMetric() {

  const now =
    performance.now();

  /* --------------------------------------------------------
     No /odom message has been received yet.
  -------------------------------------------------------- */

  if (
    robotSpeedMps === null
  ) {

    return {

      id: "speed",

      label: "Speed",

      sub: "UNKNOWN",

      value: "—",

      pct: null,

      note:
        odomWaitingForSteer()
          ? "starts after the first steering command"
          : "waiting for /odom",

      grade: "unknown"
    };
  }

  /* --------------------------------------------------------
     /odom stopped arriving.

     Two seconds gives us a little tolerance while still
     making a dead/stale speed reading visible quickly.
  -------------------------------------------------------- */

  const age =
    (
      now -
      robotSpeedAt
    ) / 1000;

  if (
    age > 2
  ) {

    return {

      id: "speed",

      label: "Speed",

      sub: "STALE",

      value: "—",

      pct: null,

      note:
        "/odom last received " +
        age.toFixed(1) +
        "s ago",

      grade: "bad"
    };
  }

  /* --------------------------------------------------------
     Convert meters/second to MPH.
  -------------------------------------------------------- */

  const speedMps =
    robotSpeedMps;

  /* --------------------------------------------------------
     Determine direction.
  -------------------------------------------------------- */

  let direction;

  if (
    speedMps > 0.05
  ) {

    direction =
      "FORWARD";

  } else if (
    speedMps < -0.05
  ) {

    direction =
      "REVERSE";

  } else {

    direction =
      "STOPPED";
  }

  /*
     Visual gauge only.

     This does NOT determine the robot's actual speed.
  */

  const pct =
    Math.min(
      100,
      Math.abs(speedMps) /
      3 *
      100
    );

  return {

    id: "speed",

    label: "Speed",

    sub: direction,

    value:
      speedText(speedMps),

    pct,

    note:
      "/odom",

    grade: "ok"
  };
}

/* ==========================================================
   METRIC TILES
========================================================== */

function metricTiles() {

  const cpu =
    diag[
      SYS_PREFIX + "CPU"
    ];

  const memory =
    diag[
      SYS_PREFIX + "Memory"
    ];

  const gpu =
    diag[
      SYS_PREFIX + "GPU"
    ];

  const thermal =
    diag[
      SYS_PREFIX + "Thermal"
    ];

  const network =
    diag[
      SYS_PREFIX + "Network"
    ];

  const tiles = [];

  /* ========================================================
     SPEED
  ======================================================== */

  tiles.push(
    getSpeedMetric()
  );

  /* ========================================================
     CPU
  ======================================================== */

  {

    const values =
      (cpu && cpu.values) || {};

    const usage =
      numberOr(
        values["usage %"]
      );

    const load =
      numberOr(
        values["load 1m"]
      );

    const cores =
      numberOr(
        values["cores"],
        0
      );

    if (
      Number.isFinite(
        usage
      )
    ) {

      tiles.push({

        id: "cpu",

        label: "CPU",

        sub:
          cores
            ? cores + " cores"
            : "",

        value:
          Math.round(
            usage
          ) + "%",

        pct: usage,

        note:
          Number.isFinite(
            load
          )
            ? "avg load " +
              load.toFixed(2) +
              " (1 min)"
            : "",

        /* graded on the robot by load average (signed off in #6),
           so the numbers live in one place: cpu() in
           system_diagnostics.py */
        grade:
          gradeFromLevel(cpu.level)
      });

    } else if (
      Number.isFinite(load) &&
      cores
    ) {

      const ratio =
        100 *
        load /
        cores;

      tiles.push({

        id: "cpu",

        label: "CPU",

        sub:
          cores +
          " cores",

        value:
          load.toFixed(2),

        pct:
          ratio,

        note:
          "load average · " +
          Math.round(
            ratio
          ) +
          "% of cores",

        grade:
          gradeFromLevel(cpu.level)
      });

    } else {

      tiles.push({

        id: "cpu",

        label: "CPU",

        value: "—",

        note:
          cpu
            ? cpu.message
            : "waiting for system_diagnostics",

        grade: "unknown"
      });
    }
  }

  /* ========================================================
     MEMORY
  ======================================================== */

  {

    const values =
      (memory && memory.values) || {};

    const available =
      numberOr(
        values["available %"]
      );

    tiles.push({

      id: "ram",

      label: "RAM",

      sub:
        values["total"] ||
        "",

      value:
        Number.isFinite(
          available
        )
          ? Math.round(
              100 -
              available
            ) + "%"
          : "—",

      pct:
        Number.isFinite(
          available
        )
          ? 100 -
            available
          : null,

      note:
        Number.isFinite(
          available
        )
          ? (
              values["available"] ||
              Math.round(
                available
              ) + "%"
            ) +
            " free"
          : (
              memory
                ? memory.message
                : "waiting for system_diagnostics"
            ),

      /* graded on the robot: MEM_WARN / MEM_ERR */
      grade: memory ? gradeFromLevel(memory.level) : "unknown"
    });
  }

  /* ========================================================
     GPU
  ======================================================== */

  {

    const values =
      (gpu && gpu.values) || {};

    const usage =
      numberOr(
        values["usage %"]
      );

    tiles.push({

      id: "gpu",

      label: "GPU",

      sub: "",

      value:
        Number.isFinite(
          usage
        )
          ? Math.round(
              usage
            ) + "%"
          : "—",

      pct:
        Number.isFinite(
          usage
        )
          ? usage
          : null,

      note:
        !gpu
          ? "no data — restart system_diagnostics.py on the robot"
          : Number.isFinite(usage)
          ? [values["freq"], values["source"] === "tegrastats"
              ? "via tegrastats" : "via sysfs"]
              .filter(Boolean).join(" · ")
          : gpu.message,

      /* graded on the robot: GPU_WARN, sustained (#6) */
      grade:
        gpu
          ? gradeFromLevel(gpu.level)
          : "unknown"
    });
  }

  /* ========================================================
     TEMPERATURE
  ======================================================== */

  {

    const values =
      (thermal && thermal.values) || {};

    /* Junction (tj-thermal) is the hottest of the Jetson chip's sensors,
       and its fan and slowdown follow it. CPU and GPU get their own rows so
       you can see which part is working; the SoC zones only go in the
       junction row's hover text. The VESC's FETs are separate hardware on
       the motor side. */
    const zone = key => numberOr(values[key]);
    const fmt = t => (Number.isFinite(t) ? t.toFixed(1) + " °C" : "n/a");

    const jetsonRow = (key, label, hint) => {
      const t = zone(key);
      return Number.isFinite(t)
        ? {
            label,
            value: fmt(t),
            pct: clampPct((t - 40) / (85 - 40) * 100),
            grade: gradeValue(t, 70, 85),
            hint
          }
        : null;
    };

    const fet = vesc && Number.isFinite(vesc.tempFet) ? vesc.tempFet : NaN;

    const rows = [
      jetsonRow("tj-thermal", "Junction",
        "Hottest point on the Jetson chip (the robot's computer). The fan " +
        "and the chip's own slowdown follow this number.\n" +
        "SoC " + ["soc0", "soc1", "soc2"]
          .map(z => fmt(zone(z + "-thermal")))
          .join(" / ")),
      jetsonRow("cpu-thermal", "CPU",
        "The Jetson's processor cores, which run ROS and every node."),
      jetsonRow("gpu-thermal", "GPU",
        "The Jetson's graphics processor, used by vision and machine " +
        "learning code."),
      Number.isFinite(fet)
        ? {
            label: "FET (VESC)",
            value: fmt(fet),
            pct: clampPct((fet - 20) / (90 - 20) * 100),
            grade: gradeValue(fet, FET_WARN, FET_ERR),
            hint:
              "Power transistors in the motor controller (VESC) - the parts " +
              "that switch battery current into the motor. They heat up " +
              "under hard driving, and the VESC cuts motor power if they " +
              "overheat."
          }
        : vesc && vesc.fetMissing
        ? {
            label: "FET (VESC)",
            value: "no reading",
            pct: 0,
            grade: "unknown",
            hint:
              "This car's VESC driver does not report the FET temperature; it " +
              "needs the two-line temperature patch in vesc_driver.cpp."
          }
        : null
    ].filter(Boolean);
    const GRADE_RANK = { bad: 3, warn: 2, ok: 1, unknown: 0 };
    const worst =
      rows.reduce(
        (w, r) => (GRADE_RANK[r.grade] > GRADE_RANK[w] ? r.grade : w),
        "unknown"
      );

    tiles.push({

      id: "temp",

      label: "Temperature",

      sub: rows.length ? TILE_TIP_HINT : "",

      rows:
        rows.length
          ? rows
          : null,

      note:
        rows.length
          ? null
          : (thermal ? thermal.message : "waiting for system_diagnostics"),

      grade:
        rows.length ? worst : thermal ? gradeFromLevel(thermal.level) : "unknown"
    });
  }

  /* ========================================================
     NETWORK
  ======================================================== */

  {

    const values =
      (network && network.values) || {};

    const rows = networkRows(values);

    const GRADE_RANK = { bad: 3, warn: 2, ok: 1, unknown: 0 };
    const worst =
      rows.reduce(
        (w, r) => (GRADE_RANK[r.grade] > GRADE_RANK[w] ? r.grade : w),
        "unknown"
      );

    tiles.push({

      id: "wifi",

      label: "Network",

      sub: rows.length ? TILE_TIP_HINT : "",

      rows:
        rows.length
          ? rows
          : null,

      note:
        rows.length
          ? null
          : (network ? network.message : "waiting for system_diagnostics"),

      grade:
        rows.length
          ? worst
          : network
            ? gradeFromLevel(network.level)
            : "unknown"
    });
  }

  return tiles;
}

/* ==========================================================
   RENDER METRICS — each tile also carries a 60 s trend line
========================================================== */

const SPARK_POINTS = 60;
const SPARK_EVERY_MS = 1000;

const metricHistory = {};
const metricSampledAt = {};

function sampleMetric(id, pct, now) {

  if (now - (metricSampledAt[id] || 0) < SPARK_EVERY_MS) return;

  metricSampledAt[id] = now;

  const series =
    metricHistory[id] || (metricHistory[id] = []);

  series.push(Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null);

  if (series.length > SPARK_POINTS) series.shift();
}

/* Fixed 0–100 domain on every tile, so a flat line near the top
   means the same thing on CPU as on RAM. Gaps (no data) break
   the line instead of being drawn as zero. */
function sparkline(id) {

  const series = metricHistory[id] || [];

  if (series.filter(v => v !== null).length < 2) {
    return '<svg class="spark empty" viewBox="0 0 100 30"></svg>';
  }

  const x = i => (i / (SPARK_POINTS - 1)) * 100;
  const offset = SPARK_POINTS - series.length;
  const y = v => 28 - (v / 100) * 26;

  let line = "";
  let area = "";
  let runStart = null;
  let prevX = 0;

  series.forEach((v, i) => {

    const px = x(i + offset).toFixed(2);

    if (v === null) {

      if (runStart !== null) area += `L${prevX},30 L${runStart},30 Z `;
      runStart = null;
      return;
    }

    const py = y(v).toFixed(2);

    if (runStart === null) {
      line += `M${px},${py} `;
      area += `M${px},30 L${px},${py} `;
      runStart = px;
    } else {
      line += `L${px},${py} `;
      area += `L${px},${py} `;
    }

    prevX = px;
  });

  if (runStart !== null) area += `L${prevX},30 L${runStart},30 Z`;

  return `
    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <title>last ${SPARK_POINTS} s</title>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
    </svg>
  `;
}

/* A tile with tile.rows set (Temperature, Network) renders as a vertical
   list of small graded rows instead of one big number + bar. No
   sparkline/history for these - there's no single value to trend. */
function rowsBody(tile) {

  /* every cell of a row carries where its details live: the row itself
     is display: contents, so it has no box of its own to point at */
  const tip = (row, i) =>
    row.hint ? ` data-tip-tile="${escapeHtml(tile.id)}" data-tip-row="${i}"` : "";

  return `
    <div class="metric-rows">
      ${tile.rows
        .map(
          (row, i) => `
            <div class="metric-row${row.hint ? " has-tip" : ""}">
              <span class="row-label"${tip(row, i)}>${escapeHtml(row.label)}</span>
              <div class="row-bar"${tip(row, i)}>
                <i class="g-${row.grade}" style="width:${clampPct(row.pct)}%"></i>
              </div>
              <span class="row-value g-${row.grade}"${tip(row, i)}>${escapeHtml(row.value)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

/* ==========================================================
   TILE DETAILS - the card for a Temperature / Network row
   Point at a row (or tap it on a touch screen): its name, its live
   value and what it means. Looked up fresh from metricTiles() on
   every refresh, so it never shows a stale number while open.
========================================================== */

const TILE_TIP_TOUCH = window.matchMedia("(hover: none)").matches;
const TILE_TIP_HINT = TILE_TIP_TOUCH ? "tap a row for details" : "point at a row for details";

let tileTipAt = null;             // { tile, row, x, y } while a card shows

function tileTipEl() {

  let el = document.getElementById("tileTip");

  if (!el) {
    el = document.createElement("div");
    el.id = "tileTip";
    el.className = "tile-tip";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    document.body.appendChild(el);
  }

  return el;
}

function renderTileTip() {

  const el = tileTipEl();

  if (!tileTipAt) {
    el.hidden = true;
    return;
  }

  const tile = metricTiles().find(t => t.id === tileTipAt.tile);
  const row = tile && tile.rows && tile.rows[tileTipAt.row];

  if (!row || !row.hint) {
    tileTipAt = null;
    el.hidden = true;
    return;
  }

  el.innerHTML = `
    <div class="tt-head">
      <span class="tt-name">${escapeHtml(tile.label)} · ${escapeHtml(row.label)}</span>
      <span class="tt-value g-${row.grade}">${escapeHtml(row.value)}</span>
    </div>
    <div class="tt-text">${escapeHtml(row.hint).replace(/\n/g, "<br>")}</div>`;
  el.hidden = false;

  /* beside the pointer, kept on screen */
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = tileTipAt.x + pad;
  let y = tileTipAt.y + pad;

  if (x + r.width > innerWidth - 8) x = Math.max(8, tileTipAt.x - r.width - pad);
  if (y + r.height > innerHeight - 8) y = Math.max(8, tileTipAt.y - r.height - pad);

  el.style.left = x + "px";
  el.style.top = y + "px";
}

function tileTipTarget(event) {
  const cell = event.target.closest && event.target.closest("[data-tip-row]");
  return cell ? { tile: cell.dataset.tipTile, row: Number(cell.dataset.tipRow) } : null;
}

if (!TILE_TIP_TOUCH) {

  $("metricTiles").addEventListener("mousemove", event => {
    const hit = tileTipTarget(event);
    tileTipAt = hit ? { ...hit, x: event.clientX, y: event.clientY } : null;
    renderTileTip();
  });

  $("metricTiles").addEventListener("mouseleave", () => {
    tileTipAt = null;
    renderTileTip();
  });

} else {

  /* touch: tap a row to open its card, tap it again (or anywhere) to close */
  document.addEventListener("click", event => {
    const hit = tileTipTarget(event);
    const same = hit && tileTipAt && hit.tile === tileTipAt.tile && hit.row === tileTipAt.row;
    tileTipAt = hit && !same ? { ...hit, x: event.clientX, y: event.clientY } : null;
    renderTileTip();
  });
}

/* the page scrolled under a pointer-placed card: drop it */
window.addEventListener("scroll", () => {
  if (tileTipAt) {
    tileTipAt = null;
    renderTileTip();
  }
}, { passive: true });

function singleBody(tile, now) {

  sampleMetric(tile.id, tile.pct, now);

  const value =
    String(
      tile.value ?? ""
    );

  return `
    <div class="value${
      value.length > 7
        ? " small"
        : ""
    }">

      ${escapeHtml(
        value
      )}

    </div>

    ${sparkline(tile.id)}

    <div class="bar">
      <i style="width:${clampPct(tile.pct)}%"></i>
    </div>

    <div class="note">
      ${
        Array.isArray(tile.note)
          ? tile.note
              .map(
                item =>
                  `<span class="note-item g-${item.grade}">${escapeHtml(item.text)}</span>`
              )
              .join(" · ")
          : escapeHtml(tile.note || "")
      }
    </div>
  `;
}

function renderMetrics() {

  const now = performance.now();

  $("metricTiles").innerHTML =
    metricTiles()
      .map(tile => `
          <div class="metric g-${tile.grade}${
            Array.isArray(tile.rows) ? " metric-multi" : ""
          }">

            <div class="label">

              <span>
                ${escapeHtml(
                  tile.label
                )}
              </span>

              <span class="sub">
                ${escapeHtml(
                  tile.sub || ""
                )}
              </span>

            </div>

            ${
              Array.isArray(tile.rows)
                ? rowsBody(tile)
                : singleBody(tile, now)
            }

          </div>
        `)
      .join("");

  if (tileTipAt) renderTileTip();
}

/* ==========================================================
   LIDAR — shared constants

   One colour per distance band, used by the plot AND the sector
   readouts, so "amber" means the same thing in both places.
========================================================== */

const LIDAR_NEAR = 0.5;     // m — red
const LIDAR_CLOSE = 1.0;    // m — amber

const LIDAR_COLOR = {
  near: "#ff5a52",
  close: "#ffc400",
  far: "#39ff88",
  ghost: "rgba(170, 182, 200, 0.45)",
  select: "#4cc9f0",
  ring: "rgba(255, 255, 255, 0.10)",
  ringStrong: "rgba(255, 255, 255, 0.22)",
  label: "rgba(255, 255, 255, 0.62)",
  free: "rgba(57, 255, 136, 0.09)",
  blind: "rgba(255, 255, 255, 0.04)"
};

function bandOf(range) {
  return range < LIDAR_NEAR ? "near" : range < LIDAR_CLOSE ? "close" : "far";
}

/* Sector windows, REP-103 radians (0 ahead, + left). */
const LIDAR_SECTORS = [
  { id: "Front", from: -20, to: 20 },
  { id: "Left", from: 60, to: 120 },
  { id: "Right", from: -120, to: -60 }
].map(s => ({ ...s, from: s.from * Math.PI / 180, to: s.to * Math.PI / 180 }));

/* The scan from ~1 s ago, or null until there is one. */
function ghostScan() {

  if (!scanStats || scanHistory.length < 2) return null;

  const target = scanStats.at - SCAN_GHOST_MS;

  let best = null;

  for (const entry of scanHistory) {
    if (entry.at <= target + 150) best = entry;
  }

  return best;
}

function scanGeometry(scan) {
  return {
    angleMin: Number(scan.angle_min),
    angleMax: Number(scan.angle_max),
    angleInc: Number(scan.angle_increment),
    rangeMin: Number(scan.range_min),
    rangeMax: Number(scan.range_max)
  };
}

/* Direction in words, for people who do not think in degrees.
   REP-103: positive angles are to the LEFT. */
function bearingText(angle) {

  const deg = angle * 180 / Math.PI;
  const side = deg > 0 ? "left" : "right";
  const abs = Math.abs(deg);

  if (abs <= 20) return "ahead";
  if (abs <= 70) return "ahead-" + side;
  if (abs <= 110) return "to the " + side;

  return "behind-" + side;
}

/* ==========================================================
   LIVE LIDAR READOUT

   Not point counts — distances that change when something moves:
   the closest thing ahead, to each side, and overall, each with
   an arrow saying whether it got closer in the last second.
========================================================== */

const TREND_TEXT = {
  closer: "▼ getting closer",
  farther: "▲ moving away",
  steady: "not moving"
};

/* ---------- plain-language status line ---------- */

const SECTOR_WORDS = { Front: "ahead", Left: "to the left", Right: "to the right" };

const STATUS_TEXT = {
  near: "Very close",
  close: "Close",
  far: "All clear"
};

function setLidarStatus(tone, html) {

  ["lidarStatus", "driveLidarStatus"].forEach(id => {

    const el = $(id);

    if (!el) return;

    el.className = "lidar-status tone-" + tone;
    el.innerHTML = html;
  });
}

/* The same readouts appear on the Overview card ("lidar…") and
   under the Drive tab's plot ("drive…"). */
const SECTOR_PREFIXES = ["lidar", "drive"];
const SECTOR_IDS = ["Front", "Left", "Right", "Nearest"];

function fillSector(id, value, valueClass, trendText, trendClass) {

  SECTOR_PREFIXES.forEach(prefix => {

    const cell = $(prefix + "Sector" + id);
    const trend = $(prefix + "Trend" + id);

    if (!cell) return;

    cell.textContent = value;
    cell.className = "sector-v " + valueClass;
    trend.textContent = trendText;
    trend.className = "sector-trend " + trendClass;
  });
}

function renderLidar() {

  const topic =
    topics.get(
      "/scan"
    );

  const age =
    scanStats
      ? (
          performance.now() -
          scanStats.at
        ) / 1000
      : null;

  const live =
    age !== null &&
    age < 2;

  $("lidarTag").textContent =
    !scanStats
      ? "waiting"
      : live
      ? "live"
      : "stale";

  $("lidarTag").style.color =
    !scanStats
      ? "var(--muted)"
      : live
      ? "var(--ok-ink)"
      : "var(--bad-ink)";

  if (!lastScan || !live) {

    SECTOR_IDS.forEach(id => fillSector(id, "—", "", "", ""));

    setLidarStatus(
      "none",
      !scanStats
        ? "<strong>No LiDAR data yet.</strong> Waiting for the sensor."
        : `<strong>LiDAR has stopped updating.</strong> Last picture was ${age.toFixed(0)} s ago.`
    );

    $("lidarHint").innerHTML =
      !scanStats
        ? topic && topic.present
          ? 'Subscribed to <span class="mono">/scan</span>, no message yet.'
          : '<span class="mono">/scan</span> is not in the graph — ' +
            'is <span class="mono">urg_node</span> running?'
        : `No scan for ${age.toFixed(1)} s — the plot shows the last one, dimmed.`;

    return;
  }

  const g = scanGeometry(lastScan);
  const ranges = lastScan.ranges || [];
  const ghost = ghostScan();

  const pick = (list, from, to) =>
    sectorMin(list, g.angleMin, g.angleInc, g.rangeMin, g.rangeMax, from, to);

  const show = (id, now, before, where) => {

    if (!now) {
      fillSector(id, "clear", "band-clear", "nothing in range", "");
      return;
    }

    const trend =
      ghost ? rangeTrend(now.range, before ? before.range : NaN) : "steady";

    fillSector(
      id,
      now.range.toFixed(2) + " m",
      "band-" + bandOf(now.range),
      (where ? where + " · " : "") + TREND_TEXT[trend],
      "trend-" + trend
    );
  };

  /* sectors where something came closer in the last second */
  const closing = [];

  LIDAR_SECTORS.forEach(sector => {

    const now = pick(ranges, sector.from, sector.to);
    const before = ghost ? pick(ghost.ranges, sector.from, sector.to) : null;

    show(sector.id, now, before);

    if (
      now && before &&
      now.range < 2 &&
      rangeTrend(now.range, before.range) === "closer"
    ) {
      closing.push({ where: SECTOR_WORDS[sector.id], range: now.range });
    }
  });

  const nearest = pick(ranges, -Math.PI, Math.PI);
  const nearestBefore = ghost ? pick(ghost.ranges, -Math.PI, Math.PI) : null;

  const nearestWhere =
    nearest ? bearingText(g.angleMin + nearest.index * g.angleInc) : "";

  show("Nearest", nearest, nearestBefore, nearestWhere);

  /* one sentence a non-technical person can act on */
  if (!nearest) {

    setLidarStatus("far", "<strong>All clear.</strong> Nothing nearby.");

  } else {

    const band = bandOf(nearest.range);
    const closingNearest =
      ghost && rangeTrend(nearest.range, nearestBefore ? nearestBefore.range : NaN) === "closer";

    const where =
      nearestWhere === "ahead" ? "ahead" : nearestWhere;

    /* anything ELSE approaching is the more urgent news, so say it */
    const approaching =
      closing
        .filter(item => Math.abs(item.range - nearest.range) > 0.05)
        .sort((a, b) => a.range - b.range)[0];

    const extra =
      approaching
        ? ` Something ${approaching.where} is <strong>getting closer</strong> (${approaching.range.toFixed(2)} m).`
        : "";

    setLidarStatus(
      approaching && band === "far" ? "close" : band,
      (band === "far"
        ? `<strong>All clear.</strong> Closest thing is ${nearest.range.toFixed(1)} m away, ${where}.`
        : `<strong>${STATUS_TEXT[band]}:</strong> something ${nearest.range.toFixed(2)} m ${where}` +
          (closingNearest ? " and <strong>getting closer</strong>." : ".")) +
      extra
    );
  }

  $("lidarHint").innerHTML =
    `${scanStats.finite} of ${scanStats.points} beams returned · ` +
    `${Math.round(scanStats.fov)}° field of view · ` +
    `farthest ${scanStats.max === null ? "—" : scanStats.max.toFixed(1) + " m"} · ` +
    `updated ${age.toFixed(1)} s ago`;
}


/* ==========================================================
   RADAR PLOT

   Chase-cam view: forward is up, left is left, the laser at the
   centre. Read from the outside in:

     shaded wedge at the back   blind spot (the Hokuyo sees 270°)
     soft green area            free space — where the car can go
     dots                       returns, coloured by distance
     faint grey dots            the same scan 1 s ago; a gap
                                between grey and colour is movement
     ringed dots                returns that came 15 cm+ closer
     dashed line + label        the nearest return

   The scale moves in fixed steps (2 / 4 / 8 / 15 m) instead of
   re-fitting every frame, so a ring always means the same
   distance and a change in the picture is a change in the world.

   drawScanCanvas() also draws the wedge picked with the index
   selector (lidar-select.js) when selLo/selHi are set.
========================================================== */

const LIDAR_RANGES = [0.5, 1, 2, 4, 8, 15];

/* ring spacing per range step */
const RING_STEP = { 0.5: 0.1, 1: 0.2, 2: 0.5, 4: 1, 8: 2, 15: 5 };

/* Auto never picks the close-up steps: they are for looking at
   something on purpose, not for a car parked near a wall. */
const AUTO_MIN_RANGE = 2;

/* Auto range: zoom OUT quickly (so walls are never cut off), zoom
   IN only once the smaller step has fitted for a while. */
const ZOOM_OUT_MS = 500;
const ZOOM_IN_MS = 2500;

/* F1TENTH footprint, metres, relative to the laser (at the origin):
   about 0.30 wide, 0.10 in front of the laser and 0.40 behind it. */
const CAR_SHAPE = { halfWidth: 0.15, front: 0.10, back: 0.40 };

const MOVED_CLOSER = 0.15;   // m in ~1 s

/* ---------- view: "lines" (the original radar, default) or
   "detailed" (dots, open space, movement trail) ---------- */

/* New storage key: Lines became the default, so an older saved
   choice of the other view does not carry over. */
const LIDAR_VIEW_KEY = "lidarViewMode";

let lidarView = "lines";

try {
  lidarView = localStorage.getItem(LIDAR_VIEW_KEY) === "detailed" ? "detailed" : "lines";
} catch (error) {}

function setLidarView(view) {

  lidarView = view === "detailed" ? "detailed" : "lines";

  try {
    localStorage.setItem(LIDAR_VIEW_KEY, lidarView);
  } catch (error) {}

  document.querySelectorAll("[data-lidar-view]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.lidarView === lidarView))
  );

  document.querySelectorAll(".lidar-legend, .lidar-card, .viewer-radar").forEach(el => {
    el.dataset.view = lidarView;
  });
}

function newRadarScale() {
  return { mode: "auto", range: 4, want: 4, wantSince: 0 };
}

const radarScaleState = newRadarScale();

function renderRadar() {
  drawScanCanvas($("radarCanvas"), radarScaleState, selLo, selHi);
  renderRangeButtons("overview", radarScaleState);
}

/* Each group of range buttons drives the plot its data-range-for names
   (the Overview card or the full screen viewer). */
function renderRangeButtons(plot, state) {

  document.querySelectorAll(
    `[data-range-for="${plot}"] [data-lidar-range]`
  ).forEach(button => {

    const value = button.dataset.lidarRange;

    const active =
      value === "auto"
        ? state.mode === "auto"
        : state.mode === "fixed" &&
          state.range === Number(value);

    button.setAttribute("aria-pressed", String(active));

    if (value === "auto") {
      button.textContent =
        state.mode === "auto" && lidarView !== "lines"
          ? `Auto (${state.range} m)`
          : "Auto";
    }
  });
}

/* ---------- zoom (both plots) ---------- */

/* Step one preset in (-1) or out (+1). Pins the range. */
function zoomRadar(state, direction) {

  const index = LIDAR_RANGES.indexOf(state.range);
  const from = index < 0 ? LIDAR_RANGES.indexOf(4) : index;
  const next = Math.max(0, Math.min(LIDAR_RANGES.length - 1, from + direction));

  state.mode = "fixed";
  state.range = LIDAR_RANGES[next];
}

function radarRangeLabel(state) {

  if (state.mode !== "auto") return `${state.range} m`;

  return lidarView === "lines" ? "Auto" : `Auto · ${state.range} m`;
}

/* Scroll on the plot to zoom, double-click to go back to Auto.
   A trackpad sends dozens of small wheel events per gesture, so
   they are summed and one step is taken per ~80 px of scroll. */
function attachRadarZoom(canvas, state, onChange) {

  let pending = 0;

  canvas.addEventListener("wheel", event => {

    event.preventDefault();

    pending += event.deltaY;

    if (Math.abs(pending) < 80) return;

    zoomRadar(state, pending < 0 ? -1 : 1);
    pending = 0;
    zoomTowardCursor(canvas, state, event);
    onChange();
  }, { passive: false });

  canvas.addEventListener("dblclick", () => {
    state.mode = "auto";
    state.panX = 0;
    state.panY = 0;
    onChange();
  });
}

/* Keep the spot under the mouse under the mouse through a zoom step,
   like a map, so scrolling over something zooms in on it. */
function zoomTowardCursor(canvas, state, event) {

  if (!state.ppm || !state.plotRadius) return;

  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;

  /* the spot, in metres from the car along the screen axes */
  const spotX = (x - state.originX) / state.ppm;
  const spotY = (y - state.originY) / state.ppm;

  const ppm = state.plotRadius / state.range;

  state.panX = (x - canvas.width / 2) / ppm - spotX;
  state.panY = (y - canvas.height / 2) / ppm - spotY;
}

/* Drag to look around; hover shows the beam under the mouse (both
   views). A press that barely moves is a click, handed to onPick (the
   beam picker) with its click count, so picking and panning never need
   a mode switch. onHover sees every hover move; cursor() picks the
   idle cursor. */
function attachRadarPointer(canvas, state, onChange, options = {}) {

  const { onPick, onHover, cursor = () => "grab" } = options;
  const CLICK_SLOP = 5;     // CSS px a click may wander

  let press = null;
  let last = null;
  let panning = false;
  let wasPan = false;

  const toCanvas = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
      cssPerPx: rect.width / canvas.width
    };
  };

  canvas.addEventListener("pointerdown", event => {

    if (event.button !== 0) return;

    press = last = toCanvas(event);
    panning = false;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", event => {

    const at = toCanvas(event);

    if (press) {

      if (!panning &&
          Math.hypot(at.x - press.x, at.y - press.y) * at.cssPerPx > CLICK_SLOP) {
        panning = true;
        canvas.style.cursor = "grabbing";
      }

      if (panning && state.ppm) {
        state.panX = (state.panX || 0) + (at.x - last.x) / state.ppm;
        state.panY = (state.panY || 0) + (at.y - last.y) / state.ppm;
        state.hover = null;
      }

      last = at;

    } else {

      state.hover = event.pointerType === "mouse" ? at : null;
      canvas.style.cursor = cursor();

      if (onHover) onHover(at);
    }

    onChange();
  });

  canvas.addEventListener("pointerup", () => {
    wasPan = panning;
    press = null;
    panning = false;
    canvas.style.cursor = cursor();
  });

  /* click, not pointerup: only click carries the click count */
  canvas.addEventListener("click", event => {
    if (wasPan || !onPick) return;
    onPick(toCanvas(event), event.detail);
    onChange();
  });

  canvas.addEventListener("pointercancel", () => {
    press = null;
    panning = false;
  });

  canvas.addEventListener("pointerleave", () => {
    if (press) return;
    state.hover = null;
    onChange();
  });
}

/* A plot's Center button: the car back in the middle, zoom kept.
   panOrigin greys it out while the car already is. */
function attachRadarCenter(button, state, onChange) {

  state.centerButton = button;

  button.onclick = () => {
    state.panX = 0;
    state.panY = 0;
    onChange();
  };
}

/* The farthest real return in the scan. */
function farthestReturn(ranges, g) {

  let far = 0;

  for (const value of ranges) {
    if (isValidRange(value, g.rangeMin, g.rangeMax) && value > far) far = value;
  }

  return far;
}

/* Where the car sits on the plot. The pan is clamped to the farthest
   return (never less than the range), so anything the LiDAR sees can be
   dragged to the middle but the view cannot wander off into nothing.
   The result is kept on the state for the pointer code, the zoom and
   the index selector, which map the mouse back to a beam. */
function panOrigin(state, w, h, pxPerMeter, scale, farthest = 0) {

  const limit = Math.max(scale, farthest);

  state.panX = Math.max(-limit, Math.min(limit, state.panX || 0));
  state.panY = Math.max(-limit, Math.min(limit, state.panY || 0));

  if (state.centerButton) {
    state.centerButton.disabled = !state.panX && !state.panY;
  }

  state.ppm = pxPerMeter;
  state.plotRadius = pxPerMeter * scale;   // px to the outer ring, at any range
  state.originX = w / 2 + state.panX * pxPerMeter;
  state.originY = h / 2 + state.panY * pxPerMeter;

  return { originX: state.originX, originY: state.originY };
}

/* 95th percentile, not the maximum: one stray long return should
   not zoom the whole plot out. */
function wantedRange(ranges, g) {

  const valid = [];

  for (const value of ranges) {
    if (isValidRange(value, g.rangeMin, g.rangeMax)) valid.push(value);
  }

  if (!valid.length) return 4;

  valid.sort((a, b) => a - b);

  const p95 = valid[Math.floor(valid.length * 0.95)];

  return LIDAR_RANGES.find(step => step >= AUTO_MIN_RANGE && step >= p95 * 1.1) ||
    LIDAR_RANGES[LIDAR_RANGES.length - 1];
}

function updateScale(state, ranges, g, now) {

  if (state.mode !== "auto") return;

  const want = wantedRange(ranges, g);

  if (want === state.range) {
    state.want = want;
    return;
  }

  if (want !== state.want) {
    state.want = want;
    state.wantSince = now;
  }

  const wait = want > state.range ? ZOOM_OUT_MS : ZOOM_IN_MS;

  if (now - state.wantSince >= wait) {
    state.range = want;
  }
}

/* Device pixels per CSS pixel for the plot being drawn. Every size
   in the layers below is written in CSS pixels and multiplied by
   this, so text and dots look the same at any size, on any screen. */
let RU = 1;

/* Match the canvas's backing store to its on-screen size × the
   screen's pixel density, so it is drawn sharp instead of a
   480 px image stretched (blurry) or squashed (tiny). */
function fitCanvas(canvas) {

  const cssWidth = canvas.clientWidth;

  if (!cssWidth) return false;     // hidden tab: nothing to draw

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(cssWidth * dpr);

  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }

  RU = px / cssWidth;

  return true;
}

function drawScanCanvas(canvas, scaleState, selLo, selHi) {

  if (!fitCanvas(canvas)) return;

  if (lidarView === "lines") {
    drawClassicScan(canvas, scaleState, selLo, selHi);
    return;
  }

  /* Detailed is the radar (radar.js) */
  if (typeof drawRadarScan === "function") {
    drawRadarScan(canvas, scaleState, selLo, selHi);
    return;
  }

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  /* plot text size in CSS px: bigger on a big plot, never tiny */
  const cssSize = w / RU;
  const font = Math.round(Math.max(13, Math.min(17, cssSize / 30)) * RU);

  ctx.fillStyle = "#0b0d10";
  ctx.fillRect(0, 0, w, h);

  if (!lastScan) {
    drawCentreText(ctx, w, h, "NO SCAN", font);
    return;
  }

  const now = performance.now();
  const age = (now - scanStats.at) / 1000;
  const live = age < 2;

  const g = scanGeometry(lastScan);
  const ranges = lastScan.ranges || [];

  updateScale(scaleState, ranges, g, now);

  const scale = scaleState.range;
  const margin = font * 2.4;
  const pxPerMeter = (Math.min(w, h) / 2 - margin) / scale;
  const { originX, originY } =
    panOrigin(scaleState, w, h, pxPerMeter, scale, farthestReturn(ranges, g));
  const P = (angle, range) =>
    polarToCanvas(angle, range, pxPerMeter, originX, originY);

  /* How far out to draw: the zoom range, plus however far the view has
     been dragged - so dragging toward something far away brings it
     into view instead of an empty plot. Undragged, it is the range. */
  const reach = scale + Math.hypot(scaleState.panX, scaleState.panY);

  /* stale: keep the last picture, dimmed, so you can still see
     what it last saw */
  ctx.globalAlpha = live ? 1 : 0.35;

  drawBlindSpot(ctx, g, reach, P);
  drawDangerZones(ctx, originX, originY, pxPerMeter);
  drawRings(ctx, g, scale, P, originX, originY, pxPerMeter, font, reach);
  drawFreeSpace(ctx, ranges, g, reach, P, originX, originY);

  const hasSelection =
    selLo !== null &&
    selHi !== null &&
    selLo <= selHi &&
    selLo < ranges.length;

  if (hasSelection) {
    drawSelectionWedge(ctx, ranges, g, reach, P, originX, originY, selLo, selHi);
  }

  const ghost = live ? ghostScan() : null;

  if (ghost) {
    drawDots(ctx, ghost.ranges, g, reach, P, () => LIDAR_COLOR.ghost, 2.4 * RU);
  }

  drawDots(
    ctx, ranges, g, reach, P,
    value => LIDAR_COLOR[bandOf(value)],
    3.4 * RU
  );

  if (ghost) {
    drawMovedCloser(ctx, ranges, ghost.ranges, g, reach, P);
  }

  if (hasSelection) {
    drawSelectedBeams(ctx, ranges, g, reach, P, selLo, selHi);
  }

  drawRingLabels(ctx, scale, P, font, reach);
  drawZoneLabels(ctx, P, Math.round(font * 0.9));
  drawNearest(ctx, ranges, g, reach, P, originX, originY, font * 1.15);
  drawCar(ctx, originX, originY, pxPerMeter);
  drawDirections(ctx, originX, originY, scale, pxPerMeter, font, w, h);

  ctx.globalAlpha = 1;

  drawHoverReadout(ctx, ranges, g, reach, P, scaleState.hover, font);

  if (!live) {
    drawBanner(ctx, w, `SCAN STALE · last ${age.toFixed(1)} s ago`, font);
  }
}

/* Labels for the danger circles, each just OUTSIDE its own circle
   and at its own angle (1 m front-left, 0.5 m to the left), so the
   two never sit on each other or on the car, however far out the
   plot is zoomed. Clear of the ring labels (ahead / front-right). */
function drawZoneLabels(ctx, P, font) {

  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const origin = P(0, 0);

  [
    [LIDAR_CLOSE, Math.PI * 0.25, "1 m", "#ffc400"],
    [LIDAR_NEAR, Math.PI * 0.62, "0.5 m", "#ff5a52"]
  ].forEach(([radius, angle, text, color]) => {

    const edge = P(angle, radius);
    const dx = edge.x - origin.x;
    const dy = edge.y - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const tw = ctx.measureText(text).width;

    /* push the label outward until it clears the circle */
    const push = Math.hypot(tw / 2, font * 0.7) + 3 * RU;
    const x = edge.x + dx / len * push;
    const y = edge.y + dy / len * push;

    ctx.fillStyle = "rgba(11, 13, 16, 0.85)";
    ctx.fillRect(x - tw / 2 - 4 * RU, y - font * 0.7, tw + 8 * RU, font * 1.4);

    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  });
}

/* ---------- Lines view: the original radar, as first built ----------

   Kept as it was: black screen, three green range rings across the
   field of view, one continuous green outline, yellow selection,
   and the scale easing smoothly to fit what it sees (2–12 m).
   Added on top: the red / amber "too close" circles with their
   distances, and the to-scale blue car from the Detailed view. Every size is the original one, scaled by
   k so it looks the same however large the canvas is drawn. A
   range picked with the buttons / zoom still applies. */

function drawClassicScan(canvas, scaleState, selLo, selHi) {

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const k = w / 480;    // the original canvas was 480 px

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  const age = lastScan ? (performance.now() - scanStats.at) / 1000 : null;
  const live = age !== null && age < 2;

  if (!lastScan || !live) {

    ctx.fillStyle = "#555";
    ctx.font = `${13 * k}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(lastScan ? "SCAN STALE" : "NO SCAN", w / 2, h / 2);
    return;
  }

  const angleMin = Number(lastScan.angle_min);
  const angleMax = Number(lastScan.angle_max);
  const angleInc = Number(lastScan.angle_increment);
  const rangeMin = Number(lastScan.range_min);
  const rangeMax = Number(lastScan.range_max);
  const ranges = lastScan.ranges || [];

  let scale;

  if (scaleState.mode === "fixed") {

    scale = scaleState.range;

  } else {

    let seenMax = 0;

    for (const v of ranges) {
      if (isValidRange(v, rangeMin, rangeMax) && v > seenMax) seenMax = v;
    }

    const target = Math.min(12, Math.max(2, seenMax || 2));

    if (!Number.isFinite(scaleState.classic)) scaleState.classic = 6;

    scaleState.classic += (target - scaleState.classic) * 0.2;

    scale = scaleState.classic;
  }

  const margin = 28 * k;
  const pxPerMeter = (Math.min(w, h) / 2 - margin) / scale;
  const g = scanGeometry(lastScan);
  const { originX, originY } =
    panOrigin(scaleState, w, h, pxPerMeter, scale, farthestReturn(ranges, g));
  const P = (angle, range) =>
    polarToCanvas(angle, range, pxPerMeter, originX, originY);

  /* RANGE RINGS */

  ctx.strokeStyle = "rgba(57,255,136,0.25)";
  ctx.lineWidth = 1 * k;
  ctx.font = `${10 * k}px monospace`;
  ctx.fillStyle = "rgba(57,255,136,0.55)";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const ringCount = 3;

  for (let ring = 1; ring <= ringCount; ring++) {

    const ringRange = scale * ring / ringCount;
    const steps = 48;

    ctx.beginPath();

    for (let st = 0; st <= steps; st++) {

      const p = P(angleMin + (angleMax - angleMin) * st / steps, ringRange);

      if (st === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }

    ctx.stroke();

    const top = P(0, ringRange);
    /* whole metres as before, but decimals on small ranges so two
       rings never read the same (rings are a third of the range) */
    const ringText =
      scale < 1.5
        ? ringRange.toFixed(2)
        : scale < 4.5 && Math.abs(ringRange - Math.round(ringRange)) > 0.05
        ? ringRange.toFixed(1)
        : ringRange.toFixed(0);

    ctx.fillText(ringText + "m", top.x + 3 * k, top.y - 2 * k);
  }

  /* FOV BOUNDARY */

  ctx.strokeStyle = "rgba(57,255,136,0.25)";
  ctx.beginPath();

  const edgeMin = P(angleMin, scale);
  const edgeMax = P(angleMax, scale);

  ctx.moveTo(originX, originY);
  ctx.lineTo(edgeMin.x, edgeMin.y);
  ctx.moveTo(originX, originY);
  ctx.lineTo(edgeMax.x, edgeMax.y);
  ctx.stroke();

  /* DANGER CIRCLES — red under 0.5 m, amber under 1 m */

  drawDangerZones(ctx, originX, originY, pxPerMeter);

  /* the robot's obstacle stop zone (radar.js) */
  if (typeof drawObstacleZone === "function") drawObstacleZone(ctx, P, k, Math.round(11 * k));

  /* SELECTED WEDGE — behind the returns */

  const hasSelection =
    selLo !== null && selHi !== null && selLo <= selHi && selLo < ranges.length;

  if (hasSelection) {

    ctx.fillStyle = "rgba(255,196,0,0.18)";
    ctx.beginPath();
    ctx.moveTo(originX, originY);

    for (let i = selLo; i <= selHi && i < ranges.length; i++) {
      const p = P(angleMin + i * angleInc, scale);
      ctx.lineTo(p.x, p.y);
    }

    ctx.closePath();
    ctx.fill();
  }

  /* LIDAR RETURNS — one continuous outline */

  const outline = (from, to) => {

    ctx.beginPath();

    let drawing = false;

    for (let i = from; i <= to && i < ranges.length; i++) {

      const v = ranges[i];

      if (!isValidRange(v, rangeMin, rangeMax)) {
        drawing = false;
        continue;
      }

      const p = P(angleMin + i * angleInc, v);

      if (drawing) {
        ctx.lineTo(p.x, p.y);
      } else {
        ctx.moveTo(p.x, p.y);
        drawing = true;
      }
    }

    ctx.stroke();
  };

  ctx.strokeStyle = "#39ff88";
  ctx.lineWidth = 1.5 * k;
  outline(0, ranges.length - 1);

  /* SELECTED BEAMS — on top */

  if (hasSelection) {
    ctx.strokeStyle = "#ffc400";
    ctx.lineWidth = 2.5 * k;
    outline(selLo, selHi);
  }

  /* THE CAR, to scale, and the circle distances on top */

  drawCar(ctx, originX, originY, pxPerMeter);

  const labelFont = Math.round(Math.max(12, Math.min(15, w / RU / 32)) * RU);

  drawZoneLabels(ctx, P, labelFont);

  /* the outline is drawn to its full length, so every point on it can
     be pointed at */
  drawHoverReadout(ctx, ranges, g, Infinity, P, scaleState.hover, labelFont);
}

/* ---------- plot layers ---------- */

/* The beam under the mouse: its /scan index and distance, the two
   numbers a student's own code reads. Only beams drawn on the plot
   count, and only within ~14 px of the pointer. */
function drawHoverReadout(ctx, ranges, g, scale, P, hover, font) {

  if (!hover) return;

  let best = -1;
  let bestDist = (14 * RU) ** 2;

  for (let i = 0; i < ranges.length; i++) {

    const value = ranges[i];

    if (!isValidRange(value, g.rangeMin, g.rangeMax) || value > scale) continue;

    const p = P(g.angleMin + i * g.angleInc, value);
    const dist = (p.x - hover.x) ** 2 + (p.y - hover.y) ** 2;

    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }

  /* empty space: say where that spot is, from the car */
  if (best < 0) {
    const o = P(0, 0);
    const ppm = Math.hypot(P(0, 1).x - o.x, P(0, 1).y - o.y);
    const forward = (o.y - hover.y) / ppm;
    const left = (o.x - hover.x) / ppm;
    const at = Math.atan2(left, forward);
    const d = Math.round(at * 180 / Math.PI);
    const blind = at > g.angleMax || at < g.angleMin;
    const words =
      `${Math.hypot(forward, left).toFixed(2)} m · ` +
      (d === 0 ? "ahead" : `${Math.abs(d)}° ${d > 0 ? "left" : "right"}`) +
      (blind ? " · blind area" : " · nothing here");

    ctx.font = `bold ${font}px sans-serif`;
    const pad = 7 * RU;
    const boxW = ctx.measureText(words).width + pad * 2;
    const boxH = font * 1.7;
    const x = Math.max(4 * RU, Math.min(hover.x + 12 * RU, ctx.canvas.width - boxW - 4 * RU));
    const y = Math.max(4 * RU, hover.y - boxH - 10 * RU);

    ctx.fillStyle = "rgba(11, 13, 16, 0.92)";
    ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1 * RU;
    ctx.strokeRect(x, y, boxW, boxH);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(words, x + pad, y + boxH / 2);
    return;
  }

  const angle = g.angleMin + best * g.angleInc;
  const p = P(angle, ranges[best]);
  const deg = Math.round(angle * 180 / Math.PI);   // REP-103: + is left

  const text =
    `index ${best} · ${ranges[best].toFixed(2)} m · ` +
    (deg === 0 ? "ahead" : `${Math.abs(deg)}° ${deg > 0 ? "left" : "right"}`);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2 * RU;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7 * RU, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const pad = 7 * RU;
  const boxW = ctx.measureText(text).width + pad * 2;
  const boxH = font * 1.7;

  /* above-right of the point, kept inside the plot */
  const x = Math.max(4 * RU, Math.min(p.x + 12 * RU, ctx.canvas.width - boxW - 4 * RU));
  const y = Math.max(4 * RU, p.y - boxH - 10 * RU);

  ctx.fillStyle = "rgba(11, 13, 16, 0.92)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 1 * RU;
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + pad, y + boxH / 2);
}

function drawCentreText(ctx, w, h, text, font) {
  ctx.fillStyle = "#8a93a1";
  ctx.font = `${font}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
}

function drawBanner(ctx, w, text, font) {
  ctx.fillStyle = "rgba(239, 56, 43, 0.85)";
  ctx.fillRect(0, 0, w, font * 2.2);
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, font * 1.1);
}

/* the arc behind the car the laser cannot see */
function drawBlindSpot(ctx, g, scale, P) {

  const steps = 24;
  const start = g.angleMax;
  const end = g.angleMin + 2 * Math.PI;

  if (end - start < 0.05) return;

  ctx.fillStyle = LIDAR_COLOR.blind;
  ctx.beginPath();

  const o = P(0, 0);
  ctx.moveTo(o.x, o.y);

  for (let s = 0; s <= steps; s++) {
    const p = P(start + (end - start) * s / steps, scale);
    ctx.lineTo(p.x, p.y);
  }

  ctx.closePath();
  ctx.fill();
}

function drawRings(ctx, g, scale, P, originX, originY, pxPerMeter, font, reach = scale) {

  const step = RING_STEP[scale] || scale / 4;

  ctx.lineWidth = RU;

  for (let r = step; r <= reach + 1e-6; r += step) {

    const whole = Math.abs(r - Math.round(r)) < 1e-6;

    ctx.strokeStyle = whole ? LIDAR_COLOR.ringStrong : LIDAR_COLOR.ring;
    ctx.beginPath();
    ctx.arc(originX, originY, r * pxPerMeter, 0, 2 * Math.PI);
    ctx.stroke();
  }

  /* crosshair: ahead / sides */
  ctx.strokeStyle = LIDAR_COLOR.ring;
  ctx.beginPath();
  const ahead = P(0, reach);
  const left = P(Math.PI / 2, reach);
  const right = P(-Math.PI / 2, reach);
  ctx.moveTo(originX, originY);
  ctx.lineTo(ahead.x, ahead.y);
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.stroke();

  /* edges of the field of view */
  ctx.strokeStyle = LIDAR_COLOR.ringStrong;
  ctx.setLineDash([4 * RU, 4 * RU]);
  ctx.beginPath();
  [g.angleMin, g.angleMax].forEach(angle => {
    const p = P(angle, reach);
    ctx.moveTo(originX, originY);
    ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/* Ring distances on the front-right diagonal, clear of the FRONT
   label, each on a dark backing. Drawn after the points so a wall
   never covers its own distance. */
function drawRingLabels(ctx, scale, P, font, reach = scale) {

  const step = RING_STEP[scale] || scale / 4;

  ctx.font = `600 ${Math.round(font * 0.92)}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  for (let r = step; r <= reach + 1e-6; r += step) {

    const whole = Math.abs(r - Math.round(r)) < 1e-6;
    const at = P(-Math.PI / 5, r);
    const text = (whole ? r.toFixed(0) : r.toFixed(1)) + " m";
    const tw = ctx.measureText(text).width;

    ctx.fillStyle = "rgba(11, 13, 16, 0.8)";
    ctx.fillRect(at.x + 2 * RU, at.y - font * 1.05, tw + 6 * RU, font * 1.1);

    ctx.fillStyle = LIDAR_COLOR.label;
    ctx.fillText(text, at.x + 5 * RU, at.y - 2 * RU);
  }
}

/* Simple view: a red bubble (under 0.5 m) and an amber one (under
   1 m) around the car, so "too close" is a place on the picture,
   not a number to remember. */
function drawDangerZones(ctx, originX, originY, pxPerMeter) {

  ctx.fillStyle = "rgba(255, 196, 0, 0.07)";
  ctx.beginPath();
  ctx.arc(originX, originY, LIDAR_CLOSE * pxPerMeter, 0, 2 * Math.PI);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 90, 82, 0.10)";
  ctx.beginPath();
  ctx.arc(originX, originY, LIDAR_NEAR * pxPerMeter, 0, 2 * Math.PI);
  ctx.fill();

  ctx.setLineDash([3 * RU, 4 * RU]);
  ctx.lineWidth = RU;

  ctx.strokeStyle = "rgba(255, 196, 0, 0.45)";
  ctx.beginPath();
  ctx.arc(originX, originY, LIDAR_CLOSE * pxPerMeter, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 90, 82, 0.55)";
  ctx.beginPath();
  ctx.arc(originX, originY, LIDAR_NEAR * pxPerMeter, 0, 2 * Math.PI);
  ctx.stroke();

  ctx.setLineDash([]);
}

/* Everything between the car and the first return. A no-return
   beam is open at least to the edge of the plot. */
function drawFreeSpace(ctx, ranges, g, scale, P, originX, originY) {

  ctx.fillStyle = LIDAR_COLOR.free;
  ctx.beginPath();
  ctx.moveTo(originX, originY);

  for (let i = 0; i < ranges.length; i++) {

    const value = ranges[i];
    const r = isValidRange(value, g.rangeMin, g.rangeMax)
      ? Math.min(value, scale)
      : scale;

    const p = P(g.angleMin + i * g.angleInc, r);
    ctx.lineTo(p.x, p.y);
  }

  ctx.closePath();
  ctx.fill();
}

function drawDots(ctx, ranges, g, scale, P, colorOf, radius) {

  for (let i = 0; i < ranges.length; i++) {

    const value = ranges[i];

    if (!isValidRange(value, g.rangeMin, g.rangeMax) || value > scale) continue;

    const p = P(g.angleMin + i * g.angleInc, value);

    ctx.fillStyle = colorOf(value);
    ctx.fillRect(p.x - radius / 2, p.y - radius / 2, radius, radius);
  }
}

/* returns that came MOVED_CLOSER or more closer in ~1 s get a ring */
function drawMovedCloser(ctx, ranges, before, g, scale, P) {

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2 * RU;

  for (let i = 0; i < ranges.length; i += 2) {

    const now = ranges[i];
    const then = before[i];

    if (
      !isValidRange(now, g.rangeMin, g.rangeMax) ||
      !isValidRange(then, g.rangeMin, g.rangeMax) ||
      now > scale ||
      then - now < MOVED_CLOSER
    ) continue;

    const p = P(g.angleMin + i * g.angleInc, now);

    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 * RU, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

function drawNearest(ctx, ranges, g, scale, P, originX, originY, font) {

  const nearest =
    sectorMin(ranges, g.angleMin, g.angleInc, g.rangeMin, g.rangeMax, -Math.PI, Math.PI);

  if (!nearest || nearest.range > scale) return;

  const angle = g.angleMin + nearest.index * g.angleInc;
  const p = P(angle, nearest.range);
  const color = LIDAR_COLOR[bandOf(nearest.range)];

  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * RU;
  ctx.setLineDash([6 * RU, 5 * RU]);
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(p.x, p.y, 8 * RU, 0, 2 * Math.PI);
  ctx.stroke();

  /* label on the far side of the dot from the car, with a backing
     so it stays legible over the points */
  const text = nearest.range.toFixed(2) + " m";
  ctx.font = `bold ${font}px sans-serif`;

  const dx = p.x - originX;
  const dy = p.y - originY;
  const len = Math.hypot(dx, dy) || 1;
  const lx = p.x + dx / len * font * 1.6;
  const ly = p.y + dy / len * font * 1.6;
  const tw = ctx.measureText(text).width;

  ctx.fillStyle = "rgba(11, 13, 16, 0.85)";
  ctx.strokeStyle = color;
  ctx.lineWidth = RU;
  ctx.beginPath();
  ctx.rect(lx - tw / 2 - 6 * RU, ly - font * 0.8, tw + 12 * RU, font * 1.6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, lx, ly);
}

/* the car, to scale, so distances read against something real;
   never smaller than a visible marker */
function drawCar(ctx, originX, originY, pxPerMeter) {

  const halfW = Math.max(7 * RU, CAR_SHAPE.halfWidth * pxPerMeter);
  const front = Math.max(3 * RU, CAR_SHAPE.front * pxPerMeter);
  const back = Math.max(16 * RU, CAR_SHAPE.back * pxPerMeter);

  ctx.fillStyle = "rgba(138, 180, 255, 0.25)";
  ctx.strokeStyle = "#8ab4ff";
  ctx.lineWidth = 2 * RU;
  ctx.beginPath();
  ctx.rect(originX - halfW, originY - front, halfW * 2, front + back);
  ctx.fill();
  ctx.stroke();

  /* nose */
  ctx.fillStyle = "#8ab4ff";
  ctx.beginPath();
  ctx.moveTo(originX, originY - front - 9 * RU);
  ctx.lineTo(originX - 6 * RU, originY - front - RU);
  ctx.lineTo(originX + 6 * RU, originY - front - RU);
  ctx.closePath();
  ctx.fill();
}

function drawDirections(ctx, originX, originY, scale, pxPerMeter, font, w, h) {

  const r = scale * pxPerMeter;

  const pill = (text, x, y, align) => {

    ctx.font = `bold ${font}px sans-serif`;

    const tw = ctx.measureText(text).width;
    const pad = 6 * RU;
    const left =
      align === "left" ? x : align === "right" ? x - tw - pad * 2 : x - tw / 2 - pad;

    ctx.fillStyle = "rgba(11, 13, 16, 0.75)";
    ctx.fillRect(left, y - font * 0.75, tw + pad * 2, font * 1.5);

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + pad, y);
  };

  pill("FRONT", originX, Math.max(font, originY - r - font * 1.2), "center");
  pill("LEFT", 6 * RU, originY - font * 1.3, "left");
  pill("RIGHT", w - 6 * RU, originY - font * 1.3, "right");

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(font * 0.9)}px sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.fillText("blind spot (can't see behind)", originX, Math.min(h - font, originY + r * 0.72));
}

/* ---------- index selector overlay (lidar-select.js) ---------- */

function drawSelectionWedge(ctx, ranges, g, scale, P, originX, originY, selLo, selHi) {

  ctx.fillStyle = "rgba(76, 201, 240, 0.16)";
  ctx.beginPath();
  ctx.moveTo(originX, originY);

  for (let i = selLo; i <= selHi && i < ranges.length; i++) {
    const p = P(g.angleMin + i * g.angleInc, scale);
    ctx.lineTo(p.x, p.y);
  }

  ctx.closePath();
  ctx.fill();
}

function drawSelectedBeams(ctx, ranges, g, scale, P, selLo, selHi) {

  for (let i = selLo; i <= selHi && i < ranges.length; i++) {

    const value = ranges[i];

    if (!isValidRange(value, g.rangeMin, g.rangeMax) || value > scale) continue;

    const p = P(g.angleMin + i * g.angleInc, value);

    ctx.fillStyle = LIDAR_COLOR.select;
    ctx.fillRect(p.x - 2.5 * RU, p.y - 2.5 * RU, 5 * RU, 5 * RU);
  }
}
