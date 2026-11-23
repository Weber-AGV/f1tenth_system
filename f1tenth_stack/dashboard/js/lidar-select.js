"use strict";

/* ==========================================================
   LIDAR INDEX SELECTOR

   Sprint 3: test-specific presets and a way to pick exactly
   which /scan indices a student's own test code should read.
   "Select beams" (in the LiDAR toolbar and the full screen LiDAR
   pane) opens one panel, which moves into the full screen while
   that shows the LiDAR. Dragging the map always pans; clicking picks: one
   click for the start beam, a second for the end, with the
   selection following the mouse in between. Esc cancels.
========================================================== */

let beamSelecting = false;
let pickStart = null;     // first click of a pick, until the second

function renderBeamSelect() {

  const inPane =
    typeof cockpitPaneShown === "function" && cockpitPaneShown("lidar");

  $(inPane ? "paneSelectSlot" : "beamSelectHome")
    .appendChild($("beamSelect"));

  $("beamSelect").hidden = !beamSelecting;

  document.querySelectorAll("[data-beam-select]").forEach(button =>
    button.setAttribute("aria-pressed", String(beamSelecting))
  );
}

function toggleBeamSelect() {
  beamSelecting = !beamSelecting;
  pickStart = null;
  renderBeamSelect();
  renderSelectionReadout();
}

/* ---- selection geometry ----
   Pure, so tests/verify_testing.mjs checks it with no DOM/websocket —
   same reasoning as the radar geometry in connection.js. */

// Inverse of polarToCanvas's angle term: a cursor offset from the
// origin maps back to a beam angle regardless of distance from the
// origin, since atan2(sin, cos) is scale-invariant.
function canvasOffsetToAngle(dx, dy) {
  return Math.atan2(-dx, -dy);
}

function angleToIndex(angle, angleMin, angleInc, len) {
  const idx = Math.round((angle - angleMin) / angleInc);
  return Math.max(0, Math.min(len - 1, idx));
}

function presetIndexRange(centerRad, halfWidthRad, angleMin, angleInc, len) {
  const lo = angleToIndex(centerRad - halfWidthRad, angleMin, angleInc, len);
  const hi = angleToIndex(centerRad + halfWidthRad, angleMin, angleInc, len);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

function selectionStats(ranges, rangeMin, rangeMax, loIdx, hiIdx) {
  let count = 0, min = Infinity, max = -Infinity, sum = 0;
  for (let i = loIdx; i <= hiIdx && i < ranges.length; i++) {
    const v = ranges[i];
    if (!isValidRange(v, rangeMin, rangeMax)) continue;
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    count,
    min: count ? min : null,
    max: count ? max : null,
    avg: count ? sum / count : null
  };
}

/* ---- selection state + UI ----
   Drawn onto the same #radarCanvas as the always-on status view
   (renderRadar() in metrics.js passes selLo/selHi through to
   drawScanCanvas) — one canvas, one scale, the highlight just
   layers on top when a selection exists. */

const PRESET_HALF_WIDTH_DEG = 7; // narrow cone; widen in your own code
                                  // if a test needs more beams averaged

let selLo = null;
let selHi = null;

function setSelection(lo, hi) {

  if (!lastScan) return;

  const len = (lastScan.ranges || []).length;
  if (!len) return;

  selLo = Math.max(0, Math.min(len - 1, Math.min(lo, hi)));
  selHi = Math.max(0, Math.min(len - 1, Math.max(lo, hi)));

  $("rangeStart").value = selLo;
  $("rangeEnd").value = selHi;
}

function clearSelection() {
  selLo = null;
  selHi = null;
  pickStart = null;
  $("rangeStart").value = "";
  $("rangeEnd").value = "";
  renderSelectionReadout();
}

/* The beam in the direction of a point on a plot (canvas pixels),
   measured from wherever that plot has the car - it may be panned. */
function beamIndexAt(state, at) {

  if (!lastScan || !Number.isFinite(state.originX)) return null;

  const angle = canvasOffsetToAngle(at.x - state.originX, at.y - state.originY);

  return angleToIndex(
    angle,
    Number(lastScan.angle_min),
    Number(lastScan.angle_increment),
    (lastScan.ranges || []).length);
}

/* Click handlers for a plot: the first click starts a pick, the
   mouse drags the far end around, the second click ends it. A
   double-click (which recenters the map) undoes its first click's
   pick, so recentering never leaves a stray one-beam selection. */
function beamPicker(state) {

  let undo = null;

  return {
    onPick: (at, clicks) => {

      if (!beamSelecting) return;

      if (clicks >= 2) {
        if (undo) [selLo, selHi, pickStart] = undo;
        undo = null;
        if (selLo === null) clearSelection();
        else setSelection(selLo, selHi);
        renderSelectionReadout();
        return;
      }

      const idx = beamIndexAt(state, at);
      if (idx === null) return;

      undo = [selLo, selHi, pickStart];

      if (pickStart === null) {
        pickStart = idx;
        setSelection(idx, idx);
      } else {
        setSelection(pickStart, idx);
        pickStart = null;
      }

      renderSelectionReadout();
    },

    onHover: at => {

      if (!beamSelecting || pickStart === null) return;

      const idx = beamIndexAt(state, at);
      if (idx === null) return;

      setSelection(pickStart, idx);
      renderSelectionReadout();
    },

    cursor: () => (beamSelecting ? "crosshair" : "grab")
  };
}

function presetCentered(centerDeg) {

  if (!lastScan) return;

  const angleMin = Number(lastScan.angle_min);
  const angleInc = Number(lastScan.angle_increment);
  const len = (lastScan.ranges || []).length;
  if (!len) return;

  const [lo, hi] = presetIndexRange(
    centerDeg * Math.PI / 180,
    PRESET_HALF_WIDTH_DEG * Math.PI / 180,
    angleMin, angleInc, len);

  setSelection(lo, hi);
}

function renderSelectionReadout() {

  const picked = Boolean(lastScan) && selLo !== null && selHi !== null;

  $("beamHint").textContent =
    pickStart !== null
      ? `Start: index ${pickStart}. Click the beam to end at (Esc to cancel).`
      : picked
      ? "Click two beams on the map to pick new indexes. Drag to look around."
      : "Click the beam to start at, then the beam to end at, and their ranges[] indexes show here. Drag to look around.";

  $("beamReadout").hidden = !picked;

  if (!picked) return;

  const angleMin = Number(lastScan.angle_min);
  const angleInc = Number(lastScan.angle_increment);
  const rangeMin = Number(lastScan.range_min);
  const rangeMax = Number(lastScan.range_max);
  const ranges = lastScan.ranges || [];

  const startDeg = (angleMin + selLo * angleInc) * 180 / Math.PI;
  const endDeg = (angleMin + selHi * angleInc) * 180 / Math.PI;

  $("selIdxRange").textContent = `${selLo} → ${selHi}`;
  /* Directions in words, measured from straight ahead. The note
     repeats them in radians, as /scan has them (angle_min +
     i * angle_increment; REP-103: + is to the left). */
  const side = deg =>
    Math.abs(deg) < 0.05
      ? "straight ahead"
      : `${Math.abs(deg).toFixed(1)}° ${deg > 0 ? "left" : "right"}`;

  const rad = i => {
    const a = angleMin + i * angleInc;
    return (Math.abs(a) < 5e-4 ? 0 : a).toFixed(3);
  };

  $("selAngleRange").textContent =
    selLo === selHi ? side(startDeg) : `${side(startDeg)} → ${side(endDeg)}`;
  $("selAngleWidth").textContent =
    `${(endDeg - startDeg).toFixed(1)}° wide · ` +
    `/scan angle ${rad(selLo)} → ${rad(selHi)} rad`;

  const stats = selectionStats(ranges, rangeMin, rangeMax, selLo, selHi);

  const beams = selHi - selLo + 1;

  $("selCount").textContent =
    `${beams} beam${beams === 1 ? "" : "s"}, ${stats.count} with a return`;
  $("selMin").textContent = stats.min === null ? "no return" : stats.min.toFixed(2) + " m";
  $("selMax").textContent = stats.max === null ? "no return" : stats.max.toFixed(2) + " m";
  $("selAvg").textContent = stats.avg === null ? "no return" : stats.avg.toFixed(2) + " m";
}

/* Esc abandons a half-made pick. Not stopPropagation: Esc is also
   the Drive tab's stop key. */
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && pickStart !== null) clearSelection();
});
