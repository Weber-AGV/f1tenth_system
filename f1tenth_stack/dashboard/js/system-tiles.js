"use strict";

/* Robot system (OS-level) list. */

/* ==========================================================
   ROBOT SYSTEM LIST

   These values come from system_diagnostics.py, which reads the
   OS-level things ROS does not publish (temperatures, disk,
   network, USB devices) and republishes them as a standard
   DiagnosticArray. No extra transport, no second port, and
   rqt_robot_monitor sees exactly the same data.

   Overview already shows the headline numbers (CPU, RAM, GPU,
   temperature), so this is the detail behind them: one row per
   probe, its verdict, and every key/value it reported.
========================================================== */

const SYS_LEVEL_DOT = {
  0: "ok",
  1: "warn",
  2: "bad"
};

const SYS_LEVEL_CLASS = {
  0: "lvl-ok",
  1: "lvl-warn",
  2: "lvl-bad",
  3: "lvl-unk"
};

function systemShortNames() {

  const byShort = {};

  Object.keys(diag)
    .filter(
      name => name.indexOf(SYS_PREFIX) === 0
    )
    .forEach(name => {
      byShort[name.slice(SYS_PREFIX.length)] = diag[name];
    });

  /* problems first (error, warn), then the usual order; STALE
     (3) is "not probed yet" and sorts with the healthy ones */
  const severity = short =>
    byShort[short].level === 2 ? 2 : byShort[short].level === 1 ? 1 : 0;

  const shorts =
    SYS_ORDER.filter(short => byShort[short])
      .concat(
        Object.keys(byShort)
          .filter(
            short => SYS_ORDER.indexOf(short) < 0
          )
          .sort()
      )
      .sort((a, b) => severity(b) - severity(a));

  return { byShort, shorts };
}

/* Friendly name for a network interface. "main" ones (Wi-Fi, wired)
   are worth reporting when down; the rest (docker, CAN bus, USB
   bridges) are normally idle and would only be noise. */
function describeInterface(name) {

  if (/^(wl|wlan)/.test(name)) return { label: "Wi-Fi", main: true };
  if (/^(eth|en)/.test(name)) return { label: "Wired Ethernet", main: true };
  if (/^can/.test(name)) return { label: "CAN bus", main: false };
  if (/^docker|^br-|^veth/.test(name)) return { label: "Docker (internal)", main: false };
  if (/^l4tbr/.test(name)) return { label: "Jetson USB bridge", main: false };
  if (/^(usb|sub|rndis)/.test(name)) return { label: "USB network", main: false };

  return { label: name, main: false };
}

/* Plain-English reading of the Network check. "2 links up" and
   "eth0 carrier=1 up" mean little to someone who is not a network
   person, so spell out what each interface is and whether it works. */
function networkDetail(values) {

  const lines = [];

  Object.keys(values).forEach(key => {

    const value = String(values[key]);

    if (key.indexOf("lidar ") === 0) {

      const ip = key.slice(6);

      lines.push(
        /NO REPLY/.test(value)
          ? `Lidar (${ip}): not answering. Check its cable and power.`
          : `Lidar (${ip}): answering (${value}).`
      );

      return;
    }

    if (key === "wifi signal") return;

    if (!/carrier=/.test(value)) return;

    const { label, main } = describeInterface(key);
    const up = /carrier=1/.test(value);

    if (up) {
      lines.push(`${label} (${key}): connected.`);
    } else if (main) {
      lines.push(`${label} (${key}): not connected. Nothing is plugged in or the signal is lost.`);
    }
  });

  return lines.length
    ? `<div class="sys-explain">
         A "link" is one network connection (wired or Wi-Fi) that is
         physically connected.<br>${lines.map(escapeHtml).join("<br>")}
       </div>`
    : "";
}

function renderSystemList() {

  const { byShort, shorts } = systemShortNames();

  $("sysHint").style.display =
    shorts.length ? "none" : "block";

  if (!shorts.length) {

    $("sysList").innerHTML = "";

    $("sysSummary").textContent = "not reporting";
    $("sysSummary").style.color = "#777";

    return;
  }

  /* STALE (3) means "not probed yet", which is the fourth state
     — unknown. It must not be allowed to masquerade as the
     worst level. */
  let worst = 0;

  $("sysList").innerHTML =
    shorts.map(short => {

      const item = byShort[short];
      const values = item.values || {};

      if (item.level > worst && item.level !== 3) {
        worst = item.level;
      }

      return `
        <li class="sys-row">

          <span class="dot ${SYS_LEVEL_DOT[item.level] || ""}"></span>

          <span class="sys-name">${escapeHtml(short)}</span>

          <span class="sys-msg">
            <span class="${SYS_LEVEL_CLASS[item.level] || "lvl-unk"}">${
              diagnosticLabel(item.level)
            }</span>
            · ${escapeHtml(item.message || "")}
          </span>

          <div class="sys-values">${
            Object.keys(values).map(key =>
              `<span><b>${escapeHtml(key)}</b> ${
                escapeHtml(String(values[key]))
              }</span>`
            ).join("")
          }</div>

          ${short === "Network" ? networkDetail(values) : ""}

        </li>
      `;
    }).join("");

  $("sysSummary").textContent =
    worst === 2
      ? "ERROR"
      : worst === 1
      ? "WARN"
      : shorts.length + " checks OK";

  $("sysSummary").style.color =
    worst === 2
      ? "var(--bad-ink)"
      : worst === 1
      ? "var(--warn-ink)"
      : "#777";
}
