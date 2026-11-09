"use strict";

/* Render loop, buttons, connection form and startup. Must load last. */

/* ==========================================================
   MAIN RENDER LOOP
========================================================== */

function render() {

  const now =
    performance.now();

  /* last update */

  if (lastAnything) {

    $("lastUpdated").textContent =
      "last updated " +
      formatTime();

  } else {

    $("lastUpdated").textContent =
      "last updated: never";
  }

  /* stale robot, starved client, crowded rosbridge */

  renderConnectionHealth(now);
  renderEstop();

  /* main dashboard */

  const subsystems =
    subsystemData();

  /* priority band first — it is what the page is for */

  renderMetrics();
  renderLidar();
  renderRadar();
  renderSelectionReadout();

  renderSubsystems(subsystems);
  renderOverall(subsystems);
  renderStatusFacts(subsystems);
  renderAdvancedBadge();

  renderDiagnosticCounts();

  renderBattery();
  renderUptime();
  renderNetwork();
  renderRobotLabel();
  renderSystemList();

  renderCounts();
  renderGraph();

  /* advanced */

  renderTopicTable();
  renderNodeTable();
  renderAdvancedDiagnostics();
  renderAttention();

  /* drive */

  renderDrive();
  renderCockpit();
}

/* ==========================================================
   REFRESH BUTTON
========================================================== */

$("refreshBtn").onclick = async () => {

  const button = $("refreshBtn");

  button.disabled = true;
  $("refreshLabel").textContent = "Refreshing...";

  try {

    /* Reconnect to rosbridge */
    connect($("wsUrl").value.trim());

    /* Give the WebSocket a moment to reconnect */
    await new Promise(resolve => {
      setTimeout(resolve, 1000);
    });

    /* Rediscover topics and nodes */
    if (
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {
      await scan();
    }

    /* Immediately update the dashboard */
    render();

  } finally {

    button.disabled = false;
    $("refreshLabel").textContent = "Refresh";
  }
};

/* ==========================================================
   TABS

   The choice lives in the URL hash so a link to #advanced opens
   straight onto it, and a reload keeps you where you were.
========================================================== */

const TABS = ["overview", "drive", "advanced", "controller"];

function showTab(name) {

  if (!TABS.includes(name)) name = "overview";

  /* the controller must never keep driving from a tab you
     cannot see */
  if (name !== "drive" && typeof driveArmed !== "undefined" && driveArmed) {
    disarmDrive("left the Drive tab");
  }

  /* high speed and full steering never survive leaving the tab */
  if (name !== "drive" && typeof highSpeed !== "undefined" && highSpeed) {
    setHighSpeed(false);
  }

  if (name !== "drive" && typeof fullSteer !== "undefined" && fullSteer) {
    setFullSteer(false);
  }

  /* the single camera stream follows you: Drive gets the big
     view, everywhere else it lives on the Overview card */
  $(name === "drive" ? "driveCamSlot" : "cameraHome")
    .appendChild($("cameraBox"));

  TABS.forEach(tab => {

    const id = tab[0].toUpperCase() + tab.slice(1);

    $("panel" + id).hidden = tab !== name;
    $("tab" + id).setAttribute("aria-selected", String(tab === name));
  });

  /* the Controller tab takes /joy at full rate while it shows */
  if (typeof jpSubscribe === "function") jpSubscribe();

  /* the Drive tab is the driving view (cockpit.js), embedded */
  if (typeof embedCockpit === "function") {
    if (name === "drive") embedCockpit();
    else unembedCockpit();
  }

  history.replaceState(
    null,
    "",
    name === "overview"
      ? location.pathname + location.search
      : "#" + name
  );
}

document.querySelectorAll("[data-tab]").forEach(button => {
  button.onclick = () => showTab(button.dataset.tab);
});

showTab(location.hash.slice(1) || "overview");

/* Count of things the Overview is not showing in detail, so a
   problem that only the Advanced tab explains is not missed. */
function renderAdvancedBadge() {

  const problems =
    Object.values(diag)
      .filter(item => item.level === 1 || item.level === 2)
      .length;

  const badge = $("advancedBadge");

  badge.hidden = !problems;
  badge.textContent = problems;
  badge.title = problems + " diagnostic warning(s) or error(s)";
}

/* ==========================================================
   THEME

   Light / Dark in the top bar. The choice is kept per browser;
   with none stored the page follows the OS, and the <head>
   script applies a stored one before first paint.
========================================================== */

function currentTheme() {

  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function renderThemeSwitch() {

  document.querySelectorAll("[data-theme-choice]").forEach(button => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.themeChoice === currentTheme())
    );
  });
}

document.querySelectorAll("[data-theme-choice]").forEach(button => {

  button.onclick = () => {

    document.documentElement.dataset.theme = button.dataset.themeChoice;

    try {
      localStorage.setItem("theme", button.dataset.themeChoice);
    } catch (error) {}

    renderThemeSwitch();
  };
});

renderThemeSwitch();

/* ==========================================================
   TOPIC FILTER
========================================================== */

$("topicFilter").addEventListener("input", renderTopicTable);
$("topicProblems").addEventListener("change", renderTopicTable);

/* ==========================================================
   PANEL CONTROLS
========================================================== */

$("joyBtn").onclick = runJoyCheck;

document.querySelectorAll("[data-beam-select]").forEach(button => {
  button.onclick = toggleBeamSelect;
});

renderBeamSelect();
renderSelectionReadout();

attachRadarZoom($("radarCanvas"), radarScaleState, renderRadar);
attachRadarPointer($("radarCanvas"), radarScaleState, renderRadar, beamPicker(radarScaleState));
attachRadarCenter($("radarCenterBtn"), radarScaleState, renderRadar);

/* Simple / Lines: one choice for both plots, kept per browser */
document.querySelectorAll("[data-lidar-view]").forEach(button => {

  button.onclick = () => {

    setLidarView(button.dataset.lidarView);

    renderRadar();
    redrawDriveRadar();
    redrawPaneRadar();
  };
});

setLidarView(lidarView);

/* LiDAR plot range: Auto steps on its own, a number pins it. Each
   group drives its own plot; the pan is kept in metres, so a step
   zooms around whatever is in the middle of the view. */
const RANGE_PLOTS = {
  overview: [radarScaleState, renderRadar],
  pane: [paneRadarScale, redrawPaneRadar]
};

document.querySelectorAll("[data-range-for]").forEach(group => {

  const [state, redraw] = RANGE_PLOTS[group.dataset.rangeFor];

  group.querySelectorAll("[data-lidar-range]").forEach(button => {

    button.onclick = () => {

      const value = button.dataset.lidarRange;

      if (value === "auto") {
        state.mode = "auto";
      } else {
        state.mode = "fixed";
        state.range = Number(value);
      }

      redraw();
    };
  });
});

$("presetAbsBtn").onclick = () => presetCentered(0);
$("presetLeftBtn").onclick = () => presetCentered(90);   // REP-103: +90 = left
$("presetRightBtn").onclick = () => presetCentered(-90); // -90 = right
$("presetClearBtn").onclick = clearSelection;

$("rangeApplyBtn").onclick = () => {

  const start = parseInt($("rangeStart").value, 10);
  const end = parseInt($("rangeEnd").value, 10);

  if (Number.isFinite(start) && Number.isFinite(end)) {
    setSelection(start, end);
  }
};

/* typing an address takes the camera off automatic */
$("cameraConnectBtn").onclick =
  () => useManualCamera($("cameraUrl").value.trim());

$("cameraUrl").addEventListener("keydown", event => {

  if (event.key === "Enter") {
    useManualCamera($("cameraUrl").value.trim());
  }
});

$("cameraAutoBtn").onclick = () => {
  useAutomaticCamera();
  $("cameraEdit").open = false;
};

$("cameraSnapBtn").onclick = takePicture;

$("snapshotClose").onclick =
  () => { $("snapshot").hidden = true; };

/* ==========================================================
   CONNECTION FORM
========================================================== */

const queryUrl =
  new URLSearchParams(
    location.search
  ).get("url");

$("wsUrl").value =
  queryUrl
    ? queryUrl
    : location.protocol.startsWith("http") &&
      location.hostname
    ? `ws://${location.hostname}:9090`
    : "ws://localhost:9090";

$("robotIp").textContent =
  location.hostname || "unknown";

/* Robot dropdown: a car by name fills its address and connects. The
   address box stays editable; an address that is not one of the
   cars shows as "Custom address". */
$("robotPick").innerHTML =
  ROBOTS.map((robot, i) =>
    `<option value="${i}">${escapeHtml(robot.name)}</option>`).join("") +
  '<option value="custom">Other…</option>';

function syncRobotPick() {
  const url = $("wsUrl").value.trim().replace(/\/+$/, "");
  const i = ROBOTS.findIndex(robot => robot.url === url);
  $("robotPick").value = i >= 0 ? String(i) : "custom";
  $("robotPick").parentElement.title =
    i >= 0 ? `${ROBOTS[i].name} · ${ROBOTS[i].url}` : "Pick a robot to connect to";
}

$("robotPick").addEventListener("change", () => {

  if ($("robotPick").value === "custom") {
    $("wsUrl").focus();
    $("wsUrl").select();
    return;
  }

  $("wsUrl").value = ROBOTS[Number($("robotPick").value)].url;
  $("connForm").requestSubmit();
});

$("wsUrl").addEventListener("input", syncRobotPick);

syncRobotPick();

/* Same reasoning as $("wsUrl") above, and the same bug fixed the
   same way: this used to be a hardcoded robot #2 IP
   (192.168.1.202) baked into the HTML, so the camera card was
   broken on every other robot by construction - confirmed on
   robot #6 (192.168.1.206), 2026-09-23. The browser already
   knows which robot it's talking to; it's whatever host served
   this page. ?video=<url> still overrides it, the same way
   ?url= overrides rosbridge, for a different robot or port.

   Now the camera follows rosbridge instead (camera.js): it opens on
   whichever robot the top bar connects to, so it is right even when
   the page is served from somewhere else. Until then, one try on the
   robot the address box points at. */
const queryVideo =
  new URLSearchParams(location.search).get("video");

if (queryVideo) {

  $("cameraUrl").value = queryVideo;
  useManualCamera(queryVideo);

} else {

  $("cameraUrl").value = cameraUrlFor($("wsUrl").value.trim());
  connectCamera($("cameraUrl").value, true);
}

/* Steam Deck: open_dashboard.sh opens the page with ?deck=1. Kiosk mode
   has no tabs, address bar or close button, so on the Deck the page
   gets Close buttons ([data-quit], hidden everywhere else).

   window.close() only works on a window Firefox is allowed to let a
   page close; the Deck needs dom.allow_scripts_to_close_windows set to
   true once (docs/guides/steam-deck-setup.md). Without it nothing
   happens, so say how to leave instead of doing nothing. */
const isDeck = new URLSearchParams(location.search).get("deck") === "1";

function quitDashboard() {

  if (!confirm("Close the dashboard?")) return;

  /* the page-hide handlers would stop the car anyway; do it first */
  if (typeof driveArmed !== "undefined" && driveArmed) {
    disarmDrive("closing the dashboard");
  }

  window.close();

  setTimeout(() => {
    setDriveNote("Firefox would not close the page. Press the Steam button, then Exit Game.");
  }, 500);
}

document.querySelectorAll("[data-quit]").forEach(button => {
  button.hidden = !isDeck;
  button.onclick = quitDashboard;
});

/* A form, so Enter in the address box and the button do the
   same thing. Lives in the top bar: switching robots is one
   edit away from any tab. */
$("connForm").addEventListener("submit", event => {

  event.preventDefault();

  connect(
    $("wsUrl").value.trim()
  );
});

/* ==========================================================
   START
========================================================== */

setInterval(
  render,
  UI_MS
);

setInterval(
  () => {

    if (
      ws &&
      ws.readyState === WebSocket.OPEN
    ) {

      scan();
    }

  },
  GRAPH_POLL_MS
);

connect(
  $("wsUrl").value.trim()
);

