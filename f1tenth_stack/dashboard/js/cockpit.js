"use strict";

/* The driving view: camera, LiDAR and controls as panes, any mix of
   them, side by side. It lives on the Drive tab, embedded in the page,
   and its Full screen button makes the same view cover the screen
   (the Overview's camera buttons open it full screen directly). Drag a divider to resize, drag a pane's title onto
   another to swap them; ready-made layouts each keep your own sizes.
   On desktops the controls float over the picture as a card you can
   drag anywhere. On phones one picture shows at a time and the
   controls are thumb sticks, held sideways like a game. The "Very
   close" warning floats on the picture: drag it, or hide it.

   The controls are only another way to hold the Drive tab's
   controller: they write the same padHeld / padVec that the Drive
   tab's pad does, so arming, the dead-man, ramping, limits and every
   disarm rule stay in drive.js and cannot drift apart. Leaving full
   screen always disarms. Hiding the controls disarms on phones; on
   desktops the keys keep driving while the Drive tab is underneath
   (applyPanes). */

/* the game layout: anything touch-first, or too narrow for a side panel */
const COCKPIT_TOUCH_QUERY = "(pointer: coarse), (max-width: 900px)";
const COCKPIT_PORTRAIT_QUERY =
  "(orientation: portrait) and (pointer: coarse), (orientation: portrait) and (max-width: 900px)";

/* wider than the sector readouts, so a glow starts before the
   thing is dead ahead or square to the side */
const COCKPIT_GLOW_SECTORS = {
  Front: [-35, 35],
  Left: [35, 135],
  Right: [-135, -35]
};

const paneRadarScale = newRadarScale();

let cockpitOpen = false;         // shown, on the Drive tab or full screen
let cockpitFull = false;         // covering the whole screen
let cockpitFullscreen = false;   // we put the page into fullscreen
let cockpitNearBefore = false;   // for the one-shot buzz on phones
let cockpitNoteText = "";
let cockpitNoteAt = 0;
let cockpitFrame = 0;
let cockpitLastDriveNote = "";
let cockpitArranging = false;
let cockpitHadControls = false;   // to say "still armed" once, when they close

/* each input remembers the finger (pointer) holding it, so two thumbs
   can steer and throttle at once */
const cockpitSteer = { pointer: null, value: 0 };
const cockpitThrottle = { pointer: null, value: 0 };
const cockpitPad = { pointer: null, x: 0, y: 0 };

function cockpitTouchLayout() {
  return window.matchMedia(COCKPIT_TOUCH_QUERY).matches;
}

function cockpitUpright() {
  return window.matchMedia(COCKPIT_PORTRAIT_QUERY).matches;
}

/* ---------- panes ----------

   A layout is which panes show, their order, and their widths (flex
   weights). Each ready-made layout keeps the user's own changes, per
   browser; Reset puts it back. */

const PANES = ["camera", "lidar", "controls"];

const LAYOUTS = {
  camera:     { order: ["camera", "lidar", "controls"], on: ["camera"],
                w: { camera: 100, lidar: 40, controls: 25 } },
  watch:      { order: ["camera", "lidar", "controls"], on: ["camera", "lidar"],
                w: { camera: 60, lidar: 40, controls: 25 } },
  drive:      { order: ["camera", "lidar", "controls"], on: ["camera", "controls"],
                w: { camera: 75, lidar: 30, controls: 25 } },
  drivelidar: { order: ["camera", "lidar", "controls"], on: ["camera", "lidar", "controls"],
                w: { camera: 50, lidar: 30, controls: 20 } },
  lidar:      { order: ["lidar", "camera", "controls"], on: ["lidar"],
                w: { camera: 60, lidar: 100, controls: 25 } }
};

const LAYOUT_KEY = "cockpitLayouts";

let layoutName = "drive";
let layout = null;               // the working copy of LAYOUTS[layoutName]

function loadLayouts() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function saveLayout() {
  try {
    const all = loadLayouts();
    all[layoutName] = layout;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
  } catch (error) {}
}

function useLayout(name, fresh = false) {

  layoutName = LAYOUTS[name] ? name : "drive";

  const saved = fresh ? null : loadLayouts()[layoutName];
  const base = LAYOUTS[layoutName];

  /* a saved copy from an older page could miss a pane; fill it in */
  layout = {
    order: saved && saved.order && PANES.every(id => saved.order.includes(id))
      ? saved.order : [...base.order],
    on: saved && Array.isArray(saved.on) && saved.on.length ? saved.on : [...base.on],
    w: { ...base.w, ...(saved && saved.w) },
    lidarFloat: Boolean(saved && saved.lidarFloat),
    controlsDock: Boolean(saved && saved.controlsDock)
  };

  if (fresh) saveLayout();
}

/* the Drive tab remembers its own layout; full screen from the
   Overview's camera buttons does not change it */
const TAB_LAYOUT_KEY = "cockpitTabLayout";

function tabLayoutName() {
  try {
    return localStorage.getItem(TAB_LAYOUT_KEY) || "drive";
  } catch (error) {
    return "drive";
  }
}

function rememberTabLayout() {
  try {
    if (driveTabVisible()) localStorage.setItem(TAB_LAYOUT_KEY, layoutName);
  } catch (error) {}
}

/* the LiDAR as a small window over the camera: needs both on */
function lidarFloats() {
  return Boolean(layout && layout.lidarFloat &&
    layout.on.includes("lidar") && layout.on.includes("camera"));
}

/* phones drive full screen only: the sticks need the phone sideways */
function controlsAllowed() {
  return !cockpitTouchLayout() || cockpitFull;
}

function cockpitPaneShown(id) {
  if (!cockpitOpen || !layout.on.includes(id)) return false;
  if (id === "controls") return controlsAllowed();
  if (id === "lidar" && lidarFloats()) return true;
  return !(cockpitTouchLayout() && touchPicture() !== id);
}

/* phones: one picture at a time, the first shown one in the order
   (a floating LiDAR rides on top of the camera instead) */
function touchPicture() {
  return layout.order.find(id => id !== "controls" && layout.on.includes(id) &&
    !(id === "lidar" && lidarFloats())) || "camera";
}

function setPane(id, on) {

  let shown = layout.on.filter(pane => pane !== id);

  if (on) {

    /* phones: Camera and LiDAR take turns (unless the LiDAR floats
       over the camera); the picked one goes first */
    if (cockpitTouchLayout() && id !== "controls" && !layout.lidarFloat) {
      shown = shown.filter(pane => pane === "controls");
      layout.order = [id, ...layout.order.filter(pane => pane !== id)];
    }

    shown.push(id);

  } else if (!shown.some(pane => pane !== "controls")) {
    return;                    // always a picture to look at
  }

  layout.on = shown;
  saveLayout();

  /* phones drive full screen, sideways: Controls on the Drive tab
     takes you there */
  if (on && id === "controls" && !controlsAllowed()) {
    openCockpit();
    return;
  }

  applyPanes();
}

function setControlsDock(on) {
  layout.controlsDock = on;
  saveLayout();
  applyPanes();
}

/* ---------- settings: every "how it looks" option, in one panel ----------

   Layout, arrangement, what shows on the picture, the thumb sticks
   and the camera. A panel under the bar on desktops, a drawer on
   phones (below the bar, which floats over the picture there). */

function settingsOpen() {
  return !$("cockpitSettings").hidden;
}

function setSettingsOpen(open) {

  $("cockpitSettings").hidden = !open;
  ["cockpitSettingsBtn", "railSettings"].forEach(id => {
    $(id).setAttribute("aria-expanded", String(open));
    $(id).classList.toggle("active", open);
  });

  if (open) {
    setCockpitPanel(false);          // one panel at a time
    placeSettings();
  }
}

/* phones: start under the bar (or the corner buttons) */
function placeSettings() {

  const view = document.querySelector(".cockpit-view").getBoundingClientRect();
  const bar = $("cockpit").classList.contains("bar-hidden")
    ? $("cockpitMinibar") : document.querySelector(".cockpit-top");
  const below = Math.max(0, bar.getBoundingClientRect().bottom - view.top);

  $("cockpitSettings").style.setProperty("--below-bar", below + "px");
}

/* ---------- hiding the top bar ----------

   More picture: the bar tucks away and a corner cluster keeps what
   must stay in reach - Emergency stop, the red alerts, Arm on phones,
   and Show. On phones this is "Controls only": the readout, the
   warning and a floating LiDAR go too, leaving the sticks and STOP.
   Kept per browser, separately for desktop and touch. */

const BAR_KEY = "cockpitBarHidden";

function barHidden() {
  try {
    return (JSON.parse(localStorage.getItem(BAR_KEY) || "{}"))[cockpitLayoutName()] === true;
  } catch (error) {
    return false;
  }
}

function setBarHidden(on) {

  try {
    const all = JSON.parse(localStorage.getItem(BAR_KEY) || "{}");
    all[cockpitLayoutName()] = on;
    localStorage.setItem(BAR_KEY, JSON.stringify(all));
  } catch (error) {}

  applyBarHidden();
}

/* Phones: Controls only - the sticks and STOP, nothing else on the
   picture. Implies the bar is hidden. */
const FOCUS_KEY = "cockpitControlsOnly";

function controlsOnly() {
  try {
    return cockpitTouchLayout() && localStorage.getItem(FOCUS_KEY) === "on";
  } catch (error) {
    return false;
  }
}

function setControlsOnly(on) {
  try {
    localStorage.setItem(FOCUS_KEY, on ? "on" : "off");
  } catch (error) {}
  applyBarHidden();
}

function applyBarHidden() {

  const focus = controlsOnly();

  $("cockpit").classList.toggle("bar-hidden", barHidden() || focus);
  $("cockpit").classList.toggle("focus", focus);
  $("barHiddenToggle").checked = barHidden();
  $("controlsOnlyToggle").checked = focus;

  applyRail();

  /* the picture changed size */
  requestAnimationFrame(() => {
    redrawPaneRadar();
    placeFloats();
  });
}

/* ---------- side rail ----------

   On a computer, hiding the top bar moves the top and bottom bars'
   essentials into one column at the left or right, so the picture
   gets the whole height - on the Drive tab and in full screen. The
   red alerts and notes still show, over the top of the picture.
   Settings picks the side; kept per browser. Phones keep their own
   corner buttons. */

const RAIL_KEY = "cockpitRail";

function railSide() {
  try {
    return localStorage.getItem(RAIL_KEY) === "left" ? "left" : "right";
  } catch (error) {
    return "right";
  }
}

function railActive() {
  return cockpitOpen && !cockpitTouchLayout() && barHidden();
}

function setRail(side) {
  try {
    localStorage.setItem(RAIL_KEY, side);
  } catch (error) {}
  applyRail();
}

/* Who is driving and the latency: the bottom bar's empty right end on a
   computer, the top bar on a phone, which has no bottom bar. */
function placeBottomChips() {
  const home = cockpitTouchLayout()
    ? document.querySelector(".cockpit-status")
    : $("cockpitBottomInfo");
  home.append($("cockpitLatency"), $("cockpitWho"));
}

placeBottomChips();
window.matchMedia(COCKPIT_TOUCH_QUERY).addEventListener("change", placeBottomChips);

function applyRail() {

  const side = railActive() ? railSide() : "off";
  const cockpit = $("cockpit");

  cockpit.classList.toggle("rail", side !== "off");
  cockpit.classList.toggle("rail-left", side === "left");
  cockpit.classList.toggle("rail-right", side === "right");

  /* one speedometer: in the rail, or in the bottom bar */
  if (side !== "off") $("railSpeedoSlot").appendChild($("cockpitSpeedo"));
  else document.querySelector(".cockpit-hud").prepend($("cockpitSpeedo"));

  document.querySelectorAll("[data-rail]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.rail === railSide())));

  /* the picture changed size */
  requestAnimationFrame(() => {
    redrawPaneRadar();
    placeFloats();
  });
}

$("railShow").onclick = () => setBarHidden(false);
$("railGoFull").onclick = () => openCockpit();

function setLidarFloat(on) {

  layout.lidarFloat = on;

  /* floating needs the camera to float over, and the LiDAR itself */
  if (on) {
    ["camera", "lidar"].forEach(id => {
      if (!layout.on.includes(id)) layout.on.push(id);
    });
  }

  saveLayout();
  applyPanes();
}

/* The page has one camera stream (one <img>); it is borrowed while a
   pane shows it, and handed back to whichever tab is showing - the
   same rule showTab uses. */
function returnCamera() {
  $(driveTabVisible() ? "driveCamSlot" : "cameraHome")
    .appendChild($("cameraBox"));
}

function applyPanes() {

  if (!cockpitOpen) return;

  const cockpit = $("cockpit");
  const box = $("cockpitPanes");
  const controls = layout.on.includes("controls") && controlsAllowed();
  const lidarFloating = lidarFloats();

  /* Controls closed: on phones the sticks and STOP go with them, so
     disarm. On desktops the keys still drive (W A S D / arrows, Space
     stops) as long as the Drive tab is underneath, so stay armed. */
  if (!controls) {
    releaseCockpitInputs();

    const keysDrive = !cockpitTouchLayout() && driveTabVisible();

    if (driveArmed && !keysDrive) {
      disarmDrive("controls hidden");
    } else if (driveArmed && cockpitHadControls) {
      setCockpitNote("Still armed: drive with W A S D or the arrow keys. Space stops.");
    }

    if (cockpitArranging) setArranging(false);
  }

  cockpitHadControls = controls;

  /* the controls are the Drive tab's: show that tab underneath, so its
     rules (keys, limits, leaving the tab disarms) all hold */
  if (controls && !driveTabVisible()) showTab("drive");

  cockpit.classList.toggle("has-controls", controls);
  cockpit.classList.toggle("lidar-float", lidarFloating);
  cockpit.dataset.picture = touchPicture();

  /* side by side in the saved order, a divider between neighbours.
     On desktops the controls float over the pictures instead of
     taking a column, so they get no divider. */
  box.querySelectorAll(".pane-divider").forEach(divider => divider.remove());

  const floating = !cockpitTouchLayout();
  let previous = null;

  layout.order.forEach(id => {

    const pane = box.querySelector(`[data-pane="${id}"]`);
    const on = layout.on.includes(id) && (id !== "controls" || controls);
    const floats = (floating && id === "controls" && !layout.controlsDock) ||
      (lidarFloating && id === "lidar");

    pane.hidden = !on;
    pane.classList.toggle("floating", floats);
    pane.style.flexGrow = layout.w[id];
    box.appendChild(pane);

    if (!on || floats) return;

    if (previous) {
      const divider = document.createElement("div");
      divider.className = "pane-divider";
      divider.title = "Drag to resize";
      box.insertBefore(divider, pane);
      attachDivider(divider, previous, pane);
    }

    previous = pane;
  });

  if (cockpitPaneShown("camera")) {
    $("cockpitCam").appendChild($("cameraBox"));
  } else {
    returnCamera();
  }

  document.querySelectorAll("[data-pane-toggle]").forEach(button =>
    button.setAttribute("aria-pressed", String(cockpitPaneShown(button.dataset.paneToggle))));

  if ($("cockpitLayout")) $("cockpitLayout").value = layoutName;

  $("lidarFloatBtn").innerHTML =
    icon(lidarFloating ? "maximize" : "split") + (lidarFloating ? " Dock" : " Float");
  $("lidarFloatBtn").title = lidarFloating
    ? "Put the LiDAR back beside the camera"
    : "Float the LiDAR over the camera (drag to move, corner to resize)";
  $("lidarFloatToggle").checked = Boolean(layout.lidarFloat);

  $("controlsDockToggle").checked = Boolean(layout.controlsDock);

  $("controlsDockBtn").innerHTML =
    icon(layout.controlsDock ? "maximize" : "split") + (layout.controlsDock ? " Float" : " Dock");
  $("controlsDockBtn").title = layout.controlsDock
    ? "Float the controls over the picture as a card you can move"
    : "Dock the controls beside the pictures";

  applyBarHidden();

  /* the beam select panel follows the LiDAR in and out */
  renderBeamSelect();

  lockLandscape();
  requestAnimationFrame(() => {
    redrawPaneRadar();
    applyCockpitLayout();
    placeFloats();
  });
}

/* Drag a divider: the two panes beside it share their room. */
function attachDivider(divider, left, right) {

  divider.addEventListener("pointerdown", event => {

    event.preventDefault();

    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    const idA = left.dataset.pane;
    const idB = right.dataset.pane;
    const weight = layout.w[idA] + layout.w[idB];
    const minA = parseFloat(getComputedStyle(left).minWidth) || 0;
    const minB = parseFloat(getComputedStyle(right).minWidth) || 0;

    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");

    const move = moveEvent => {

      const width = Math.max(minA,
        Math.min(a.width + b.width - minB, moveEvent.clientX - a.left));

      layout.w[idA] = weight * width / (a.width + b.width);
      layout.w[idB] = weight - layout.w[idA];

      left.style.flexGrow = layout.w[idA];
      right.style.flexGrow = layout.w[idB];
      redrawPaneRadar();
    };

    const done = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", move);
      saveLayout();
    };

    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", done, { once: true });
    divider.addEventListener("pointercancel", done, { once: true });
  });
}

/* Drag a pane's title onto another pane: they swap places. */
/* Drag a docked pane by its title to put it somewhere else: over the
   left half of another pane it goes before it, over the right half
   after it. The half it will take lights up with a bar at the edge,
   and a label follows the pointer. A click (under 5 px of movement)
   does nothing; Esc or letting go over nothing cancels. */
const PANE_DRAG_START_PX = 5;

function attachPaneMove(pane) {

  const head = pane.querySelector(".pane-head");

  head.addEventListener("pointerdown", event => {

    /* the title's own buttons, and the floating windows, which move
       freely instead (attachFloat) */
    if (event.target.closest("button")) return;
    if (pane.classList.contains("floating")) return;
    if (event.button !== 0) return;

    event.preventDefault();
    head.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let drop = null;            // { target, after }
    let ghost = null;

    const clearMark = () => {
      document.querySelectorAll(".drop-before, .drop-after").forEach(el =>
        el.classList.remove("drop-before", "drop-after"));
    };

    const begin = () => {
      dragging = true;
      pane.classList.add("moving");
      $("cockpit").classList.add("pane-dragging");
      ghost = document.createElement("div");
      ghost.className = "pane-ghost";
      ghost.innerHTML = icon("move") + " " + escapeHtml(head.textContent.trim().split(/\s+/)[0]);
      $("cockpit").appendChild(ghost);
    };

    const move = moveEvent => {

      if (!dragging) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < PANE_DRAG_START_PX) return;
        begin();
      }

      /* beside the pointer, never off the screen's edge */
      ghost.style.left =
        Math.min(moveEvent.clientX, innerWidth - ghost.offsetWidth - 16) + "px";
      ghost.style.top =
        Math.min(moveEvent.clientY, innerHeight - ghost.offsetHeight - 16) + "px";

      /* the docked pane under the pointer, by position: floating windows
         and the ghost itself never count */
      const target = [...$("cockpitPanes").querySelectorAll(".pane")].find(other => {
        if (other === pane || other.hidden || other.classList.contains("floating")) return false;
        const r = other.getBoundingClientRect();
        return moveEvent.clientX >= r.left && moveEvent.clientX <= r.right &&
               moveEvent.clientY >= r.top && moveEvent.clientY <= r.bottom;
      });

      clearMark();
      drop = null;

      if (target) {
        const r = target.getBoundingClientRect();
        const after = moveEvent.clientX > r.left + r.width / 2;
        target.classList.add(after ? "drop-after" : "drop-before");
        drop = { target, after };
      }
    };

    const finish = commit => {

      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key, true);

      clearMark();
      pane.classList.remove("moving");
      $("cockpit").classList.remove("pane-dragging");
      if (ghost) ghost.remove();

      if (!commit || !dragging || !drop) return;

      const id = pane.dataset.pane;
      const order = layout.order.filter(other => other !== id);
      const at = order.indexOf(drop.target.dataset.pane) + (drop.after ? 1 : 0);

      order.splice(at, 0, id);

      if (order.join() === layout.order.join()) return;

      layout.order = order;
      saveLayout();
      applyPanes();
    };

    const up = () => finish(true);
    const cancel = () => finish(false);
    /* Esc cancels the move, and still does what it always does (on the
       Drive tab it stops and disarms) - a drag never swallows a stop */
    const key = keyEvent => {
      if (keyEvent.key === "Escape") finish(false);
    };

    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key, true);
  });
}

/* phones, while the controls show: sideways like a game. Only allowed
   in fullscreen, and not at all on some browsers - the rotate prompt
   covers those. */
function lockLandscape() {

  if (!cockpitFullscreen || !cockpitTouchLayout() || !screen.orientation) return;

  if (layout.on.includes("controls")) {
    if (screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {});
  } else if (screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch (error) {}
  }
}

function redrawPaneRadar() {
  if (cockpitPaneShown("lidar")) {
    drawScanCanvas($("paneRadar"), paneRadarScale, selLo, selHi);
    renderRangeButtons("pane", paneRadarScale);
  }
}

/* ---------- where the view is: the Drive tab, or full screen ----------

   One #cockpit element. On the Drive tab it sits in the tab's slot,
   part of the page; Full screen moves it to the end of <body> and
   covers the screen. Leaving full screen puts it back on the Drive
   tab, or hides it when another tab is showing. */

function showCockpit() {

  if (cockpitOpen) return;

  cockpitOpen = true;
  $("cockpit").hidden = false;
  syncCockpitSettings();

  /* phones: the thumbs drive and the settings wait behind a button */
  setCockpitPanel(false);
}

function hideCockpit() {

  if (!cockpitOpen) return;

  releaseCockpitInputs();
  setArranging(false);

  if (driveArmed) disarmDrive("left the driving view");

  cockpitOpen = false;
  setSettingsOpen(false);
  $("cockpit").hidden = true;
  returnCamera();
  renderBeamSelect();
}

/* the Drive tab was shown (main.js showTab) */
function embedCockpit() {

  if (cockpitFull) return;         // full screen stays full screen

  $("driveCockpitSlot").appendChild($("cockpit"));
  $("cockpit").classList.remove("full");

  useLayout(tabLayoutName());
  showCockpit();

  applyPanes();
  renderCockpit();
  renderCockpitFast();
}

/* another tab was shown */
function unembedCockpit() {
  if (!cockpitFull) hideCockpit();
}

/* Full screen: from the Drive tab's button (same layout), or from the
   Overview's camera buttons (a named layout). */
function openCockpit(name) {

  if (name) useLayout(name);
  else if (!layout) useLayout(tabLayoutName());

  const cockpit = $("cockpit");

  if (!cockpitFull) {

    cockpitFull = true;
    document.body.appendChild(cockpit);
    cockpit.classList.add("full");
    showCockpit();

    if (!document.fullscreenElement && cockpit.requestFullscreen) {
      cockpit.requestFullscreen({ navigationUI: "hide" })
        .then(() => {
          cockpitFullscreen = true;
          lockLandscape();
        })
        .catch(() => {});
    }
  }

  applyPanes();
  renderCockpit();
  renderCockpitFast();
}

/* leave full screen: back to the Drive tab, or away */
function closeCockpit() {

  if (!cockpitFull) return;

  releaseCockpitInputs();
  setArranging(false);

  /* the controls you were using are about to change size or vanish */
  if (driveArmed) disarmDrive("left full screen");

  cockpitFull = false;
  $("cockpit").classList.remove("full");
  applyRail();

  if (screen.orientation && screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch (error) {}
  }

  if (cockpitFullscreen && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  cockpitFullscreen = false;

  if (driveTabVisible()) {
    $("driveCockpitSlot").appendChild($("cockpit"));
    useLayout(tabLayoutName());
    applyPanes();
  } else {
    hideCockpit();
  }
}

function setCockpitPanel(open) {

  if (open && settingsOpen()) setSettingsOpen(false);

  $("cockpit").classList.toggle("panel-open", open);
  $("cockpitPanelToggle").setAttribute("aria-expanded", String(open));

}

/* ---------- inputs -> the Drive tab's controller ---------- */

function applyCockpitInput() {

  if (!cockpitOpen) return;

  /* disarmed under a held thumb (STOP, E-STOP, link lost): drop the
     hold, so re-arming never drives off a press made before it */
  if (!driveArmed) {
    releaseCockpitInputs();
    return;
  }

  if (cockpitPad.pointer !== null) {

    padHeld = true;
    padVec = { x: cockpitPad.x, y: cockpitPad.y };
    driveNow();
    return;
  }

  const steering = cockpitSteer.pointer !== null;
  const throttle = cockpitThrottle.pointer !== null;

  /* either thumb down counts as holding: steering alone turns the
     wheels at zero speed, exactly like the pad held at its centre */
  padHeld = steering || throttle;
  padVec = {
    x: steering ? cockpitSteer.value : 0,
    y: throttle ? cockpitThrottle.value : 0
  };

  /* the thumbs just moved: send now, not at the next tick */
  driveNow();
}

function releaseCockpitInputs() {

  cockpitSteer.pointer = null;
  cockpitSteer.value = 0;
  cockpitThrottle.pointer = null;
  cockpitThrottle.value = 0;
  cockpitPad.pointer = null;
  cockpitPad.x = 0;
  cockpitPad.y = 0;

  padHeld = false;
  padVec = { x: 0, y: 0 };

  placeCockpitKnobs();
}

function cockpitNeedsArm() {

  if (driveArmed) return false;

  setCockpitNote(
    $("driveConfirm").checked
      ? "Press Arm first."
      : "Tick the safety box and press Arm first.");

  if (cockpitTouchLayout()) setCockpitPanel(true);

  return true;
}

/* A one-axis thumb stick: springs back to the middle when let go. */
function attachStick(element, state, axis) {

  const read = event => {

    const rect = element.getBoundingClientRect();

    /* a stick that is not on screen has nowhere to be pushed */
    if (!rect.width || !rect.height) return 0;

    const along = axis === "x"
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;

    /* the knob travels 40% either way; past that is full deflection */
    return Math.max(-1, Math.min(1, (along * 2 - 1) / 0.8));
  };

  element.addEventListener("pointerdown", event => {

    if (cockpitArranging) return;
    if (state.pointer !== null) return;
    if (cockpitNeedsArm()) return;

    try {
      element.setPointerCapture(event.pointerId);
    } catch (error) {}

    state.pointer = event.pointerId;
    state.value = read(event);

    applyCockpitInput();
  });

  element.addEventListener("pointermove", event => {

    if (event.pointerId !== state.pointer) return;

    state.value = read(event);
    applyCockpitInput();
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach(type =>
    element.addEventListener(type, event => {

      if (event.pointerId !== state.pointer) return;

      state.pointer = null;
      state.value = 0;
      applyCockpitInput();
    })
  );
}

/* The desktop panel's round pad: the Drive tab's pad, same feel. */
function attachCockpitPad() {

  const pad = $("cockpitPad");

  const read = event => {

    const rect = pad.getBoundingClientRect();

    let x = ((event.clientX - rect.left) / rect.width * 2 - 1) / 0.74;
    let y = ((event.clientY - rect.top) / rect.height * 2 - 1) / 0.74;

    const length = Math.hypot(x, y);

    if (length > 1) {
      x /= length;
      y /= length;
    }

    cockpitPad.x = x;
    cockpitPad.y = y;
  };

  pad.addEventListener("pointerdown", event => {

    if (cockpitArranging) return;
    if (cockpitNeedsArm()) return;

    try {
      pad.setPointerCapture(event.pointerId);
    } catch (error) {}

    cockpitPad.pointer = event.pointerId;
    read(event);
    applyCockpitInput();
  });

  pad.addEventListener("pointermove", event => {

    if (event.pointerId !== cockpitPad.pointer) return;

    read(event);
    applyCockpitInput();
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach(type =>
    pad.addEventListener(type, event => {

      if (event.pointerId !== cockpitPad.pointer) return;

      cockpitPad.pointer = null;
      cockpitPad.x = 0;
      cockpitPad.y = 0;
      applyCockpitInput();
    })
  );
}

function placeCockpitKnobs() {

  $("stickSteerKnob").style.left = (50 + cockpitSteer.value * 40) + "%";
  $("stickThrottleKnob").style.top = (50 + cockpitThrottle.value * 40) + "%";

  $("cockpitKnob").style.left = (50 + cockpitPad.x * 37) + "%";
  $("cockpitKnob").style.top = (50 + cockpitPad.y * 37) + "%";

  $("stickSteer").classList.toggle("held", cockpitSteer.pointer !== null);
  $("stickThrottle").classList.toggle("held", cockpitThrottle.pointer !== null);
  $("cockpitPad").classList.toggle("held", cockpitPad.pointer !== null && driveArmed);
}

/* ---------- settings mirrored from the Drive tab ---------- */

/* The Drive tab's controls stay the source of truth: the sliders and
   the safety box here only forward to them. */
function syncCockpitSettings() {

  [["maxSpeed", "cockpitMaxSpeed"], ["maxSteer", "cockpitMaxSteer"]]
    .forEach(([source, mine]) => {
      $(mine).min = $(source).min;
      $(mine).max = $(source).max;
      $(mine).step = $(source).step;
      $(mine).value = $(source).value;
    });

  $("cockpitMaxSpeedValue").textContent = $("maxSpeedValue").textContent;
  $("cockpitMaxSteerValue").textContent = $("maxSteerValue").textContent;

  /* the folded limits still say what they are */
  $("cockpitMoreSum").textContent =
    $("maxSpeedValue").textContent + " · " + $("maxSteerValue").textContent;

  $("cockpitConfirm").checked = $("driveConfirm").checked;
}

function forwardSlider(mine, source) {

  $(mine).addEventListener("input", () => {

    $(source).value = $(mine).value;
    $(source).dispatchEvent(new Event("input"));

    syncCockpitSettings();
  });
}

forwardSlider("cockpitMaxSpeed", "maxSpeed");
forwardSlider("cockpitMaxSteer", "maxSteer");

/* Edge warning lights on or off, kept per browser. Off hides only
   the glow: the warning line and the map still say what is close. */
function setCockpitGlow(on) {

  $("cockpitGlowToggle").checked = on;
  $("cockpit").classList.toggle("no-glow", !on);

  try {
    localStorage.setItem("cockpitGlow", on ? "on" : "off");
  } catch (error) {}
}

$("cockpitGlowToggle").addEventListener("change", () =>
  setCockpitGlow($("cockpitGlowToggle").checked));

let savedGlow = "on";

try {
  savedGlow = localStorage.getItem("cockpitGlow") || "on";
} catch (error) {}

setCockpitGlow(savedGlow !== "off");

$("cockpitConfirm").addEventListener("change", () => {

  $("driveConfirm").checked = $("cockpitConfirm").checked;
  $("driveConfirm").dispatchEvent(new Event("change"));

  renderCockpitArm();
});

/* ---------- notes ---------- */

function setCockpitNote(text) {
  cockpitNoteText = text;
  cockpitNoteAt = performance.now();
  renderCockpitNote();
}

function renderCockpitNote() {

  /* the Drive tab's own note ("Disarmed - window lost focus") wins
     when it is newer */
  const driveNote = $("driveNote").textContent;

  if (driveNote && driveNote !== cockpitLastDriveNote) {
    cockpitLastDriveNote = driveNote;
    cockpitNoteText = driveNote;
    cockpitNoteAt = performance.now();
  }

  /* "not connected" is already the red alert above */
  const fresh =
    socketOpen() && cockpitNoteText && performance.now() - cockpitNoteAt < 5000;

  $("cockpitNote").hidden = !fresh;
  $("cockpitNote").textContent = fresh ? cockpitNoteText : "";
}

/* ---------- LiDAR: glows and the warning line ---------- */

function cockpitProximity() {

  if (!lastScan || !scanStats || performance.now() - scanStats.at > 2000) {
    return null;
  }

  const g = scanGeometry(lastScan);
  const ranges = lastScan.ranges || [];
  const rad = deg => deg * Math.PI / 180;

  const out = {};

  Object.entries(COCKPIT_GLOW_SECTORS).forEach(([id, [from, to]]) => {
    out[id] = sectorMin(ranges, g.angleMin, g.angleInc, g.rangeMin, g.rangeMax,
                        rad(from), rad(to));
  });

  out.nearest = sectorMin(ranges, g.angleMin, g.angleInc, g.rangeMin, g.rangeMax,
                          -Math.PI, Math.PI);

  return out;
}

function renderCockpitLidar() {

  const near = cockpitProximity();

  Object.keys(COCKPIT_GLOW_SECTORS).forEach(id => {

    const hit = near && near[id];
    const band = hit ? bandOf(hit.range) : "far";

    $("glow" + id).className =
      "cockpit-glow glow-" + id.toLowerCase() +
      (band === "far" ? "" : " glow-" + band);
  });

  /* a short buzz the moment something gets very close, while armed */
  const veryClose =
    Boolean(near && near.nearest && bandOf(near.nearest.range) === "near");

  if (veryClose && !cockpitNearBefore && driveArmed && navigator.vibrate &&
      $("buzzToggle").checked) {
    navigator.vibrate(180);
  }

  cockpitNearBefore = veryClose;
}

/* the same plain-language sentence the Drive tab shows, only when it
   matters: something close, or no LiDAR at all */
function renderCockpitLidarLine() {

  const source = $("driveLidarStatus");
  const tone = (source.className.match(/tone-(\w+)/) || [])[1] || "none";
  const line = $("cockpitLidar");

  const wasHidden = line.hidden;

  line.hidden = tone === "far";
  line.className = "cockpit-lidar tone-" + tone;
  line.innerHTML = source.innerHTML;

  /* its size changed: keep it where it was put, and on the picture */
  if (wasHidden !== line.hidden || !line.hidden) placeFloat($("cockpitWarn"));
}

/* ---------- rendering ---------- */

function renderCockpitArm() {

  const button = $("armBtn");

  ["cockpitArm", "cockpitArmQuick", "cockpitMiniArm", "railArm"].forEach(id => {
    $(id).textContent = button.textContent;
    $(id).classList.toggle("armed", driveArmed);
  });

  $("cockpitArm").disabled = button.disabled;

  /* the quick buttons explain instead of greying out */
  $("cockpitArmQuick").disabled = !driveArmed && !socketOpen();
  $("cockpitMiniArm").disabled = $("cockpitArmQuick").disabled;
  $("railArm").disabled = $("cockpitArmQuick").disabled;

  $("cockpitPad").classList.toggle("ready", driveArmed);
  $("stickSteer").classList.toggle("ready", driveArmed);
  $("stickThrottle").classList.toggle("ready", driveArmed);

  $("cockpitConfirm").checked = $("driveConfirm").checked;
  $("railConfirm").checked = $("driveConfirm").checked;
}

/* Slower bits, from the main 2 Hz render loop. */
function renderCockpit() {

  if (!cockpitOpen) return;

  $("cockpitHealth").textContent = $("overallStatus").textContent;
  $("cockpitHealth").dataset.health = $("statusBanner").dataset.health || "unknown";

  $("cockpitBattery").innerHTML = $("hudBattery").innerHTML;

  $("railHealth").textContent = $("cockpitHealth").textContent;
  $("railHealth").dataset.health = $("cockpitHealth").dataset.health;
  $("railBattery").innerHTML = $("hudBattery").innerHTML;
  $("cockpitSpeedMode").hidden = $("hudSpeedMode").hidden;
  $("cockpitSteerMode").hidden = $("hudSteerMode").hidden;


  /* the physical controller is the backup stop; say plainly when
     there is none */
  const pad = padLinkState();
  const unreadable = pad && diag["system: Gamepad"].level === 2;

  $("cockpitPadChip").innerHTML = icon("gamepad") + " " + (
    pad === null ? "Controller unknown"
    : unreadable ? "Controller can't be read"
    : pad ? "Controller connected" : "No controller");
  $("cockpitPadChip").dataset.tone = unreadable ? "bad" : pad === false ? "warn" : "";

  renderCockpitSys();
  renderCockpitDriving();

  /* E-STOP mirrors the top bar's (label, busy, active) */
  const estop = $("estopBtn");
  const mine = $("cockpitEstop");

  mine.innerHTML = estop.innerHTML;
  mine.className = estop.className;
  mine.disabled = estop.disabled;

  ["cockpitMiniEstop", "railEstop"].forEach(id => {
    $(id).innerHTML = estop.innerHTML;
    $(id).className = estop.className + (id === "railEstop" ? " rail-estop" : "");
    $(id).disabled = estop.disabled;
  });

  const alerts = [];

  if (estopActive()) {
    alerts.push("EMERGENCY STOP IS ON - exit drive mode to release it");
  }

  if (!socketOpen()) {
    alerts.push("NOT CONNECTED TO THE ROBOT");
  } else if ($("staleBar").classList.contains("show")) {
    alerts.push("NO DATA FROM THE ROBOT - the picture and numbers may be stale");
  }

  $("cockpitAlert").hidden = !alerts.length;
  $("cockpitAlert").textContent = alerts.join(" · ");

  /* the red alerts stay in view while the bar is hidden */
  $("cockpitMiniAlert").hidden = !alerts.length;
  $("cockpitMiniAlert").textContent = alerts.join(" · ");

  renderCockpitLidarLine();
  renderCockpitArm();
  syncCockpitSettings();
  redrawPaneRadar();
}

/* Who is driving, the controller's disconnect, the vitals and the
   driving alerts, from the Drive tab's own panels (drive.js), and the
   two unlock buttons, which open the Drive tab's warning dialogs. */
let cockpitLastPadNote = "";

function renderCockpitDriving() {

  const tone = ($("controlHero").className.match(/tone-(\w+)/) || [])[1] || "none";

  $("cockpitWho").innerHTML = $("controlIcon").innerHTML + " " + escapeHtml($("controlTitle").textContent);
  $("cockpitWho").title = $("controlSub").textContent;
  $("cockpitWho").dataset.tone = tone;

  /* autonomous code: say so plainly whenever it is up */
  const auto = typeof autonomousState === "function" ? autonomousState() : { state: "off" };
  ["cockpitAuto", "railAuto"].forEach(id => {
    $(id).hidden = !["on", "standby"].includes(auto.state);
    $(id).dataset.state = auto.state;
    $(id).title = auto.detail || "";
    $(id).title = (auto.detail || "") + " Click to stop it.";
    $(id).innerHTML = icon("bot") + (id === "railAuto"
      ? `<span>${auto.state === "on" ? "Autonomous" : "Auto standby"}</span><span class="auto-stop-word">■ Stop</span>`
      : (auto.state === "on" ? (auto.mine ? " AUTONOMOUS RUN" : " AUTONOMOUS DRIVING") : " Autonomous standby") +
        `<span class="auto-stop-word">■ Stop</span>`);
  });

  $("railWho").innerHTML = $("controlIcon").innerHTML +
    "<span>" + escapeHtml($("controlTitle").textContent) + "</span>";
  $("railWho").title = $("controlSub").textContent;
  $("railWho").dataset.tone = tone;

  const source = $("padDisconnectBtn");
  const mine = $("cockpitPadDisconnect");

  mine.hidden = $("padDisconnectRow").hidden || source.hidden;

  /* "Disconnect controller" already says one is connected */
  $("cockpitPadChip").hidden = !mine.hidden;
  mine.disabled = source.disabled;
  mine.innerHTML = source.innerHTML;
  mine.title = source.title;

  /* the disconnect's result ("Disconnected. Press the PS button...") */
  const padNote = $("padDisconnectNote").textContent;

  if (padNote && padNote !== cockpitLastPadNote) setCockpitNote(padNote);
  cockpitLastPadNote = padNote;

  const alerts = [...$("controlAlerts").querySelectorAll("li")];

  $("cockpitCtrlAlert").hidden = !alerts.length;
  $("cockpitCtrlAlert").textContent = alerts.map(li => li.textContent).join(" · ");
  $("cockpitCtrlAlert").dataset.tone = alerts.some(li => li.classList.contains("bad")) ? "bad" : "warn";

  [["speedUnlockBtn", "cockpitSpeedUnlock"], ["steerUnlockBtn", "cockpitSteerUnlock"]]
    .forEach(([from, to]) => {
      $(to).innerHTML = $(from).innerHTML;
      $(to).disabled = $(from).disabled;
      $(to).classList.toggle("unlocked", $(from).classList.contains("unlocked"));
    });
}

/* CPU, GPU, RAM and temperatures, as the Overview tiles grade them */
function renderCockpitSys() {

  const tiles = {};

  metricTiles().forEach(tile => {
    tiles[tile.id] = tile;
  });

  const usage = [["cpu", "CPU"], ["gpu", "GPU"], ["ram", "RAM"]]
    .filter(([id]) => tiles[id])
    .map(([id, label]) => `
      <div class="viewer-small">
        <span class="hud-k">${label}</span>
        <span class="viewer-small-v" data-tone="${tiles[id].grade}">${escapeHtml(String(tiles[id].value ?? ""))}</span>
      </div>`);

  const temps = (tiles.temp && tiles.temp.rows) || [];

  $("cockpitSys").innerHTML = usage.join("") + (temps.length ? `
      <div class="viewer-small">
        <span class="hud-k">Temperature</span>
        <span class="viewer-temps">${temps.map(row => `
          <span title="${escapeHtml(row.hint || "")}">${escapeHtml(row.label)}
            <b data-tone="${row.grade}">${escapeHtml(row.value)}</b></span>`).join("")}
        </span>
      </div>` : "");
}

/* Settings > Readouts: the unit for every speed on the page (helpers.js) */
function setSpeedUnit(unit) {
  speedUnit = SPEED_UNITS[unit] ? unit : "mps";
  try {
    localStorage.setItem("cockpitUnits", speedUnit);
  } catch (error) {}
  document.querySelectorAll("[data-speed-unit]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.speedUnit === speedUnit)));

  /* text that is not redrawn on its own; the live readouts catch up by themselves */
  document.querySelectorAll("[data-mps]").forEach(element => {
    element.textContent = speedLimitText(Number(element.dataset.mps));
  });
  renderSpeedUnlock();
  renderLimits();
  renderAutoPanel();
  renderControllerSpeed();
  syncCockpitSettings();
}

/* The scale's tick marks, drawn once: the last ones red, near the limit. */
(function drawSpeedoTicks() {
  const line = (share, inner) => {
    const angle = Math.PI * (1 - share);
    const at = r => (60 + Math.cos(angle) * r).toFixed(1) + " " + (62 - Math.sin(angle) * r).toFixed(1);
    return `M ${at(inner)} L ${at(41)} `;
  };
  let calm = "", hot = "";
  for (let i = 0; i <= 20; i++) {
    const d = line(i / 20, i % 5 === 0 ? 34 : 38);
    if (i >= 17) hot += d; else calm += d;
  }
  $("speedoTicks").setAttribute("d", calm);
  $("speedoTicksRed").setAttribute("d", hot);
})();

/* Speedometer: measured speed as the arc (the command until /odom
   reports), the command as a tick, scaled to the max-speed limit. */
function renderSpeedo() {

  const fresh = robotSpeedMps !== null && performance.now() - robotSpeedAt < 2000;
  const shown = fresh ? robotSpeedMps : cmdSpeed;
  const max = Math.max(limitSpeed(), 0.1);
  const share = value => Math.min(1, Math.abs(value) / max);

  $("speedoFill").style.strokeDasharray = `${share(shown) * 100} 100`;

  /* the bright tip rides the end of the arc */
  const tip = Math.PI * (1 - share(shown));
  $("speedoHead").style.transform =
    `translate(${(60 + Math.cos(tip) * 50).toFixed(1)}px, ${(62 - Math.sin(tip) * 50).toFixed(1)}px)`;
  $("speedoHead").style.opacity = share(shown) > 0.01 ? 1 : 0;

  /* the tick sits on the arc: left end is 0, right end is the limit */
  const angle = Math.PI * (1 - share(cmdSpeed));
  const point = r => [60 + Math.cos(angle) * r, 62 - Math.sin(angle) * r];
  const [x1, y1] = point(43);
  const [x2, y2] = point(60);

  $("speedoCmd").setAttribute("x1", x1.toFixed(1));
  $("speedoCmd").setAttribute("y1", y1.toFixed(1));
  $("speedoCmd").setAttribute("x2", x2.toFixed(1));
  $("speedoCmd").setAttribute("y2", y2.toFixed(1));
  $("speedoCmd").style.opacity = Math.abs(cmdSpeed) > 0.01 ? 1 : 0;

  const unit = SPEED_UNITS[speedUnit];

  $("speedoValue").textContent = (Math.abs(shown) * unit.factor).toFixed(1);
  $("speedoUnit").textContent = unit.label + (shown < -0.05 ? " rev" : "");
  $("speedoMax").textContent = (fresh ? "" : "cmd · ") + "max " + (max * unit.factor).toFixed(1);

  /* the readout beside it, in the same units */
  $("cockpitCmd").textContent = speedText(cmdSpeed);
  $("cockpitMeas").textContent = fresh ? speedText(robotSpeedMps) : "—";

  $("cockpitSpeedo").classList.toggle("reverse", shown < -0.05);
  $("cockpitSpeedo").classList.toggle("fast", share(shown) > 0.85);
}

/* The live bits, 20 times a second while open. */
function renderCockpitFast() {

  if (!cockpitOpen) return;

  const state = $("driveState");

  $("cockpitState").textContent = state.textContent;
  $("cockpitState").className = state.className;
  $("railState").textContent = state.textContent;
  $("railState").className = state.className;

  $("cockpitSteer").textContent = $("cmdSteer").textContent;
  $("cockpitSteerMark").style.left = $("steerMark").style.left;

  if (!driveArmed && (cockpitSteer.pointer !== null ||
      cockpitThrottle.pointer !== null || cockpitPad.pointer !== null)) {
    releaseCockpitInputs();
  }

  placeCockpitKnobs();
  renderCockpitArm();
  renderCockpitNote();
  renderSpeedo();

  /* armed with the bar away, or the controls closed: say so */
  $("cockpitMiniState").hidden = !driveArmed;
  $("cockpitMiniState").textContent = state.textContent;
  $("cockpitMiniState").className = state.className;
  /* a controller on this device can drive: say how */
  $("cockpitDeckChip").hidden =
    !(typeof jpDeckConnected === "function" && jpDeckConnected());
  $("cockpitKeysChip").hidden =
    !(driveArmed && !cockpitPaneShown("controls") && !cockpitTouchLayout());

  /* the glows at 10 Hz */
  if (cockpitFrame++ % 2 === 0) {
    renderCockpitLidar();
  }
}

/* ---------- latency: the round trip to the car ----------

   A tiny rosapi call every 2 s while the view is open, timed there and
   back. Every command from this page pays about half of it on its way
   to the car (Wi-Fi, then rosbridge); the physical controller pays
   none of it - it goes over Bluetooth straight into the car. The
   median of the last five, so one slow packet does not flash red. */
const LATENCY_EVERY_MS = 2000;
const LATENCY_WARN_MS = 50;
const LATENCY_BAD_MS = 120;
const latencySamples = [];

async function measureLatency() {

  if (!cockpitOpen || !socketOpen() || document.hidden) return;

  const started = performance.now();

  try {
    await call("/rosapi/get_time");
  } catch (error) {
    latencySamples.length = 0;
    renderLatency();
    return;
  }

  latencySamples.push(performance.now() - started);
  if (latencySamples.length > 5) latencySamples.shift();

  renderLatency();
}

function renderLatency() {

  const sorted = [...latencySamples].sort((a, b) => a - b);
  const ms = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const tone = ms === null ? "" : ms >= LATENCY_BAD_MS ? "bad" : ms >= LATENCY_WARN_MS ? "warn" : "ok";
  const title =
    "Latency: the round trip from this page to the car and back. Each command takes about " +
    "half of it to arrive; the physical controller skips it (Bluetooth, " +
    `straight into the car). Under ${LATENCY_WARN_MS} ms is good; over ` +
    `${LATENCY_BAD_MS} ms, driving from here will feel late - move closer to ` +
    "the router, or close the camera to free up the Wi-Fi.";

  ["cockpitLatency", "railLatency"].forEach(id => {
    $(id).hidden = ms === null || !socketOpen();
    $(id).dataset.tone = tone;
    $(id).title = title;
    $(id).innerHTML = icon("link") + (id === "cockpitLatency" ? " Latency " : " ") +
      (ms === null ? "" : Math.round(ms) + " ms");
  });
}

setInterval(measureLatency, LATENCY_EVERY_MS);

/* ---------- arranging (phones): move the sticks and STOP ----------

   Positions are kept per browser, separately for the desktop and the
   touch layout, as fractions of the screen so they survive a resize
   or a rotation. While arranging, nothing drives: the car is
   disarmed and the sticks and pad ignore presses, so moving a stick
   can never move the car. */

const COCKPIT_LAYOUT_KEY = "cockpitLayout";

function cockpitLayoutName() {
  return cockpitTouchLayout() ? "touch" : "desk";
}

function loadCockpitLayout() {

  try {
    const all = JSON.parse(localStorage.getItem(COCKPIT_LAYOUT_KEY) || "{}");
    return all[cockpitLayoutName()] || {};
  } catch (error) {
    return {};
  }
}

function saveCockpitLayout(layout) {

  try {
    const all = JSON.parse(localStorage.getItem(COCKPIT_LAYOUT_KEY) || "{}");
    all[cockpitLayoutName()] = layout;
    localStorage.setItem(COCKPIT_LAYOUT_KEY, JSON.stringify(all));
  } catch (error) {}
}

/* the movable parts that this layout shows */
function cockpitMovables() {
  return [...$("cockpit").querySelectorAll("[data-movable]")]
    .filter(element => getComputedStyle(element).display !== "none");
}

/* put an element at (left, top), kept fully on screen */
function placeMovable(element, left, top) {

  const box = $("cockpit").getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;

  /* never over the top bar: Emergency stop and Exit stay reachable */
  const floor = $("cockpitClose").getBoundingClientRect().bottom - box.top + 8;

  left = Math.max(0, Math.min(box.width - width, left));
  top = Math.max(floor, Math.min(box.height - height, top));

  element.classList.add("moved");
  element.style.left = left + "px";
  element.style.top = top + "px";

  return { left, top };
}

function applyCockpitLayout() {

  if (!cockpitOpen) return;

  const layout = loadCockpitLayout();
  const box = $("cockpit").getBoundingClientRect();

  $("cockpit").querySelectorAll("[data-movable]").forEach(element => {

    const spot = layout[element.dataset.movable];

    if (spot && getComputedStyle(element).display !== "none") {
      placeMovable(element, spot.x * box.width, spot.y * box.height);
    } else {
      element.classList.remove("moved");
      element.style.left = "";
      element.style.top = "";
    }
  });
}

function setArranging(on) {

  if (on === cockpitArranging) return;

  cockpitArranging = on;

  if (on) {
    setSettingsOpen(false);
    releaseCockpitInputs();
    if (driveArmed) disarmDrive("arranging the screen");

    /* the drawer covers the screen */
    setCockpitPanel(false);
  }

  $("cockpit").classList.toggle("arranging", on);
  $("cockpitArrangeBar").hidden = !on;
}

function resetCockpitLayout() {
  saveCockpitLayout({});
  applyCockpitLayout();
}

function attachMovable(element) {

  let drag = null;

  element.addEventListener("pointerdown", event => {

    if (!cockpitArranging) return;

    event.preventDefault();

    const rect = element.getBoundingClientRect();
    const box = $("cockpit").getBoundingClientRect();

    drag = {
      pointer: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      box
    };

    try {
      element.setPointerCapture(event.pointerId);
    } catch (error) {}

    element.classList.add("dragging");
  });

  element.addEventListener("pointermove", event => {

    if (!drag || event.pointerId !== drag.pointer) return;

    placeMovable(element,
      event.clientX - drag.box.left - drag.dx,
      event.clientY - drag.box.top - drag.dy);
  });

  const drop = event => {

    if (!drag || event.pointerId !== drag.pointer) return;

    const box = drag.box;
    const layout = loadCockpitLayout();

    layout[element.dataset.movable] = {
      x: parseFloat(element.style.left) / box.width,
      y: parseFloat(element.style.top) / box.height
    };

    saveCockpitLayout(layout);

    drag = null;
    element.classList.remove("dragging");
  };

  element.addEventListener("pointerup", drop);
  element.addEventListener("pointercancel", drop);

  /* a button being moved is not a button being pressed */
  element.addEventListener("click", event => {
    if (cockpitArranging) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

$("cockpit").querySelectorAll("[data-movable]").forEach(attachMovable);

$("cockpitArrangeBtn").onclick = () => setArranging(true);
$("cockpitArrangeDone").onclick = () => setArranging(false);
$("cockpitArrangeReset").onclick = resetCockpitLayout;

/* a resize or a rotation: same places, as a share of the new screen */
window.addEventListener("resize", () => requestAnimationFrame(applyCockpitLayout));

/* ---------- floating parts: the controls card and the warning ----------

   Dragged anywhere on the picture and kept there, per browser, as a
   share of the picture area so they survive a resize. Separate spots
   for desktop and touch, like the sticks. Never over the top bar, so
   Emergency stop and Exit stay reachable. */

const FLOAT_KEY = "cockpitFloat";

function floatSpots() {
  try {
    const all = JSON.parse(localStorage.getItem(FLOAT_KEY) || "{}");
    return all[cockpitLayoutName()] || {};
  } catch (error) {
    return {};
  }
}

function saveFloatSpot(name, spot) {
  try {
    const all = JSON.parse(localStorage.getItem(FLOAT_KEY) || "{}");
    const mine = all[cockpitLayoutName()] || {};
    if (spot) mine[name] = spot;
    else delete mine[name];
    all[cockpitLayoutName()] = mine;
    localStorage.setItem(FLOAT_KEY, JSON.stringify(all));
  } catch (error) {}
}

/* the area a floating part may use: the picture, below the top bar
   (which floats over the picture on phones) */
function floatArea(element) {

  const parent = element.offsetParent || $("cockpit");
  const box = parent.getBoundingClientRect();

  /* below the buttons and the red alerts, which sit on their own row
     under the buttons on phones - or, with the bar hidden, below the
     corner buttons */
  const hidden = $("cockpit").classList.contains("bar-hidden");
  const bar = hidden
    ? $("cockpitMinibar").getBoundingClientRect().bottom
    : Math.max(
        $("cockpitClose").getBoundingClientRect().bottom,
        document.querySelector(".cockpit-msgs").getBoundingClientRect().bottom);

  return { box, floor: Math.max(0, bar - box.top + 8) };
}

function setFloatPosition(element, left, top) {

  const { box, floor } = floatArea(element);

  left = Math.max(0, Math.min(box.width - element.offsetWidth, left));
  top = Math.max(floor, Math.min(box.height - element.offsetHeight, top));

  element.classList.add("floated");
  element.style.left = left + "px";
  element.style.top = top + "px";
}

function placeFloat(element) {

  if (!cockpitOpen || element.hidden || !element.offsetParent) return;
  if (element.classList.contains("dragging")) return;     // being moved

  /* panes float only while floating: the controls card on desktops,
     the LiDAR when it is set to float over the camera */
  if (element.dataset.float !== "warning" && !element.classList.contains("floating")) {
    element.classList.remove("floated");
    element.style.left = element.style.top = "";
    element.style.width = element.style.height = "";
    return;
  }

  const spot = floatSpots()[element.dataset.float];
  const { box, floor } = floatArea(element);

  /* a resized LiDAR window keeps its size, within the picture */
  if (element.dataset.float === "lidar" && spot && spot.w && !cockpitTouchLayout()) {
    element.style.width = Math.min(spot.w, box.width - 24) + "px";
    element.style.height = Math.min(spot.h, box.height - floor - 24) + "px";
  }

  if (spot) {
    setFloatPosition(element, spot.x * box.width, spot.y * box.height);
  } else if (element.dataset.float === "warning") {
    /* default: top centre of the camera picture, under its title */
    const cam = document.querySelector('[data-pane="camera"]');
    const shown = cam && !cam.hidden && cam.offsetWidth ? cam.getBoundingClientRect() : box;
    const head = cam && cam.querySelector(".pane-head");
    const under = head && head.offsetHeight ? head.getBoundingClientRect().bottom - box.top + 10 : 0;

    setFloatPosition(element,
      shown.left - box.left + (shown.width - element.offsetWidth) / 2,
      Math.max(floor + 4, under));
  } else if (element.dataset.float === "lidar") {
    /* default: top right of the camera picture, under its title */
    const cam = document.querySelector('[data-pane="camera"]');
    const head = cam && cam.querySelector(".pane-head");
    const under = head && head.offsetHeight ? head.getBoundingClientRect().bottom - box.top + 10 : 0;

    setFloatPosition(element, box.width - element.offsetWidth - 12, Math.max(floor + 4, under));
  } else {
    /* default: the stylesheet's corner */
    element.classList.remove("floated");
    element.style.left = element.style.top = "";
  }
}

function placeFloats() {
  $("cockpit").querySelectorAll("[data-float]").forEach(placeFloat);
}

function attachFloat(element, handle) {

  let drag = null;

  handle.addEventListener("pointerdown", event => {

    if (event.target.closest("button")) return;
    if (element.dataset.float !== "warning" && !element.classList.contains("floating")) return;

    event.preventDefault();

    const rect = element.getBoundingClientRect();

    drag = { pointer: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch (error) {}

    element.classList.add("dragging");
  });

  handle.addEventListener("pointermove", event => {

    if (!drag || event.pointerId !== drag.pointer) return;

    const { box } = floatArea(element);

    setFloatPosition(element,
      event.clientX - box.left - drag.dx,
      event.clientY - box.top - drag.dy);
  });

  const drop = event => {

    if (!drag || event.pointerId !== drag.pointer) return;

    const { box } = floatArea(element);

    const spot = floatSpots()[element.dataset.float] || {};

    saveFloatSpot(element.dataset.float, {
      ...spot,
      x: parseFloat(element.style.left) / box.width,
      y: parseFloat(element.style.top) / box.height
    });

    drag = null;
    element.classList.remove("dragging");
  };

  handle.addEventListener("pointerup", drop);
  handle.addEventListener("pointercancel", drop);
}

attachFloat($("cockpitWarn"), $("cockpitWarn"));
attachFloat(document.querySelector('[data-pane="lidar"]'),
            document.querySelector('[data-pane="lidar"] .pane-head'));

/* the floating LiDAR is resized from its corner (CSS resize): redraw
   the plot at the new size, and keep the size */
new ResizeObserver(() => {

  const pane = document.querySelector('[data-pane="lidar"]');

  redrawPaneRadar();

  if (!cockpitOpen || !pane.classList.contains("floating") || cockpitTouchLayout()) return;
  if (!pane.style.width && !pane.style.height && !pane.dataset.resized) return;

  const spot = floatSpots().lidar || {};

  if (spot.w !== pane.offsetWidth || spot.h !== pane.offsetHeight) {
    saveFloatSpot("lidar", { ...spot, w: pane.offsetWidth, h: pane.offsetHeight });
  }
}).observe(document.querySelector('[data-pane="lidar"]'));

/* a drag on the resize corner sets an inline size; remember it */
document.querySelector('[data-pane="lidar"]').addEventListener("pointerup", () => {
  document.querySelector('[data-pane="lidar"]').dataset.resized = "1";
});

$("lidarFloatBtn").onclick = () => setLidarFloat(!lidarFloats());
$("lidarFloatToggle").addEventListener("change", () =>
  setLidarFloat($("lidarFloatToggle").checked));
attachFloat(document.querySelector('[data-pane="controls"]'),
            document.querySelector('[data-pane="controls"] .pane-head'));

window.addEventListener("resize", () => requestAnimationFrame(placeFloats));

$("controlsHide").onclick = () => setPane("controls", false);

/* the LiDAR's x, like the controls': with no camera on, the camera
   takes its place (there is always a picture) */
$("lidarHide").onclick = () => {
  if (!layout.on.includes("camera")) setPane("camera", true);
  setPane("lidar", false);
};

/* The close-object warning on or off, kept per browser. Off hides only
   the sentence: the edge lights, the LiDAR pane and the red alerts
   still show. */
function setCockpitWarn(on) {

  $("cockpitWarnToggle").checked = on;
  $("cockpit").classList.toggle("no-warn", !on);

  try {
    localStorage.setItem("cockpitWarn", on ? "on" : "off");
  } catch (error) {}

  if (on) requestAnimationFrame(() => placeFloat($("cockpitWarn")));
}

$("cockpitWarnToggle").addEventListener("change", () =>
  setCockpitWarn($("cockpitWarnToggle").checked));

$("cockpitWarnHide").onclick = () => {
  setCockpitWarn(false);
  setCockpitNote("Close-object warning hidden. Turn it back on in Settings.");
};

let savedWarn = "on";

try {
  savedWarn = localStorage.getItem("cockpitWarn") || "on";
} catch (error) {}

setCockpitWarn(savedWarn !== "off");

/* ---------- screen: keep it awake, buzz ----------

   A phone that dims and locks mid-drive drops the controls (and the
   page disarms). While the view is open, ask for a screen wake lock;
   the browser drops it whenever the page is hidden, so ask again on
   return. Browsers without it just carry on. */

let wakeLock = null;

async function updateWakeLock() {

  const want = cockpitOpen && $("wakeToggle").checked && !document.hidden;

  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (error) {
    wakeLock = null;
  }
}

function rememberSwitch(id, key) {

  try {
    const saved = localStorage.getItem(key);
    if (saved) $(id).checked = saved === "on";
  } catch (error) {}

  $(id).addEventListener("change", () => {
    try {
      localStorage.setItem(key, $(id).checked ? "on" : "off");
    } catch (error) {}
    updateWakeLock();
  });
}

rememberSwitch("wakeToggle", "cockpitWake");
rememberSwitch("buzzToggle", "cockpitBuzz");
/* on by default on the Steam Deck (?deck=1, see main.js isDeck); a
   saved choice still wins */
$("bigToggle").checked = new URLSearchParams(location.search).get("deck") === "1";
rememberSwitch("bigToggle", "cockpitBig");

/* Big controls: a slider is a poor target for a thumb (Speed is -3 to
   3 m/s in 0.05 steps), so each panel slider gets - / + buttons, shown
   only in this mode (css: html.big-controls). Hold one to keep stepping.
   They fire "input" like a drag does, so every listener follows. */
function applyBigControls() {
  document.documentElement.classList.toggle("big-controls", $("bigToggle").checked);
}

$("bigToggle").addEventListener("change", applyBigControls);
applyBigControls();

document.querySelectorAll(".cockpit-panel .slider-row input[type=range]").forEach(input => {

  const row = input.closest("label");

  /* the row is a <label>: point it at the slider, or a tap on its text
     would press the first button inside it (the -) */
  row.htmlFor = input.id;

  const step = dir => {
    if (input.disabled) return;
    if (dir > 0) input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  [-1, 1].forEach(dir => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slider-step";
    button.textContent = dir > 0 ? "+" : "−";
    button.setAttribute("aria-label", (dir > 0 ? "More " : "Less ") +
      row.querySelector("span").textContent.toLowerCase());

    let timer = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    const repeat = delay => {
      timer = setTimeout(() => { step(dir); repeat(80); }, delay);
    };

    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      step(dir);
      repeat(400);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(type =>
      button.addEventListener(type, stop));
    button.addEventListener("click", event => {
      if (event.detail === 0) step(dir);    // keyboard Enter / Space
    });

    if (dir < 0) input.before(button); else input.after(button);
  });
});
document.addEventListener("visibilitychange", updateWakeLock);
setInterval(updateWakeLock, 2000);    // follows open / close / tab changes

/* Every view setting back to its default: layouts, positions, the
   switches. Reloads the page, so it disarms first. */
const VIEW_KEYS = ["cockpitLayouts", "cockpitTabLayout", "cockpitBarHidden",
  "cockpitControlsOnly", "cockpitGlow", "cockpitWarn", "cockpitLayout",
  "cockpitFloat", "cockpitUnits", "cockpitWake", "cockpitBuzz", "cockpitRail",
  "cockpitBig", "radarSweep"];

$("cockpitResetAll").onclick = () => {

  if (!confirm("Reset all view settings?\n\nLayouts, positions and switches go back " +
               "to their defaults. The page reloads, so driving is disarmed.")) return;

  if (driveArmed) disarmDrive("resetting the view");

  try {
    VIEW_KEYS.forEach(key => localStorage.removeItem(key));
  } catch (error) {}

  location.reload();
};

document.querySelectorAll("[data-speed-unit]").forEach(button => {
  button.onclick = () => setSpeedUnit(button.dataset.speedUnit);
});
setSpeedUnit(speedUnit);

/* ---------- wiring ---------- */

attachStick($("stickSteer"), cockpitSteer, "x");
attachStick($("stickThrottle"), cockpitThrottle, "y");
attachCockpitPad();

document.querySelectorAll("[data-cockpit-open]").forEach(button => {
  button.onclick = () => openCockpit(button.dataset.cockpitOpen);
});

document.querySelectorAll("[data-pane-toggle]").forEach(button => {
  button.onclick = () =>
    setPane(button.dataset.paneToggle, button.getAttribute("aria-pressed") !== "true");
});

/* (the layout picker left Settings; the Camera / LiDAR / Controls
   switch and the Overview's camera buttons choose what shows) */



document.querySelectorAll("#cockpitPanes .pane").forEach(attachPaneMove);

attachRadarZoom($("paneRadar"), paneRadarScale, redrawPaneRadar);
attachRadarPointer($("paneRadar"), paneRadarScale, redrawPaneRadar, beamPicker(paneRadarScale));
attachRadarCenter($("paneCenterBtn"), paneRadarScale, redrawPaneRadar);

/* a resize or a rotation: phones and desktops lay out differently */
window.matchMedia(COCKPIT_TOUCH_QUERY).addEventListener("change", applyPanes);

$("cockpitClose").onclick = closeCockpit;
$("cockpitGoFull").onclick = () => openCockpit();
$("cockpitSettingsBtn").onclick = () => setSettingsOpen(!settingsOpen());
$("cockpitSettingsClose").onclick = () => setSettingsOpen(false);

/* a click anywhere else closes Settings */
document.addEventListener("pointerdown", event => {
  if (settingsOpen() &&
      !event.target.closest("#cockpitSettings, #cockpitSettingsBtn, #railSettings")) {
    setSettingsOpen(false);
  }
});
$("barHiddenToggle").addEventListener("change", () => {
  setBarHidden($("barHiddenToggle").checked);
  setSettingsOpen(false);            // show the result
});
$("controlsDockToggle").addEventListener("change", () =>
  setControlsDock($("controlsDockToggle").checked));
$("cockpitBarShow").onclick = () => {
  setBarHidden(false);
  if (controlsOnly()) setControlsOnly(false);
};
$("cockpitBarHideBtn").onclick = () => setBarHidden(true);
$("controlsOnlyToggle").addEventListener("change", () => {
  setControlsOnly($("controlsOnlyToggle").checked);
  setSettingsOpen(false);            // show the result
});
$("cockpitMiniEstop").onclick = triggerEstop;
$("cockpitMiniArm").onclick = () => $("cockpitArmQuick").onclick();
$("controlsDockBtn").onclick = () => setControlsDock(!layout.controlsDock);
$("cockpitPadDisconnect").onclick = () => disconnectPad();
$("cockpitSpeedUnlock").onclick = () => $("speedUnlockBtn").click();
$("cockpitSteerUnlock").onclick = () => $("steerUnlockBtn").click();
$("cockpitRotateClose").onclick = closeCockpit;
$("cockpitEstop").onclick = triggerEstop;

["cockpitStop", "cockpitStopTouch"].forEach(id => {
  $(id).onclick = () => {
    releaseCockpitInputs();
    disarmDrive("stop pressed");
  };
});

$("cockpitArm").onclick = () => $("armBtn").onclick();

$("cockpitArmQuick").onclick = () => {

  if (driveArmed) {
    disarmDrive("disarmed");
    return;
  }

  if (!$("driveConfirm").checked) {
    setCockpitNote("Tick the safety box, then press Arm.");
    setCockpitPanel(true);
    return;
  }

  armDrive();
};

$("cockpitPanelToggle").onclick = () =>
  setCockpitPanel(!$("cockpit").classList.contains("panel-open"));

$("cockpitPanelClose").onclick = () => setCockpitPanel(false);

$("cockpitCamConnect").onclick = reconnectCamera;

/* the side rail: each button does what the one it stands in for does */
document.querySelectorAll("[data-rail]").forEach(button => {
  button.onclick = () => setRail(button.dataset.rail);
});

$("railArm").onclick = () => $("cockpitArmQuick").onclick();
$("railStop").onclick = () => $("cockpitStop").onclick();
$("railEstop").onclick = triggerEstop;
$("railExit").onclick = closeCockpit;
$("railSettings").onclick = () => setSettingsOpen(!settingsOpen());

$("railConfirm").addEventListener("change", () => {

  $("driveConfirm").checked = $("railConfirm").checked;
  $("driveConfirm").dispatchEvent(new Event("change"));

  renderCockpitArm();
});

/* leaving browser fullscreen (Esc, the system back gesture) leaves
   drive mode with it */
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && cockpitFullscreen) {
    cockpitFullscreen = false;
    closeCockpit();
  }
});

document.addEventListener("keydown", event => {

  if (event.key !== "Escape" || !cockpitOpen) return;

  if (settingsOpen()) {
    setSettingsOpen(false);
    return;
  }

  if (cockpitArranging) {
    setArranging(false);
    return;
  }

  /* a half-made beam pick takes Esc first (lidar-select.js) */
  if (!document.fullscreenElement && pickStart === null) closeCockpit();
});

/* turned upright mid-drive: the sticks are gone, so stop */
window.matchMedia(COCKPIT_PORTRAIT_QUERY).addEventListener("change", event => {

  if (!cockpitOpen || !event.matches) return;

  releaseCockpitInputs();

  if (driveArmed) disarmDrive("phone turned upright");
});

/* the readouts at 20 Hz: plenty for the eye, and the commands (50 Hz,
   drive.js) are not held up by drawing */
setInterval(renderCockpitFast, 1000 / 20);
