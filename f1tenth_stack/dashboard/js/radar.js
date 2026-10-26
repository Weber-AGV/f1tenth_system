"use strict";

/* LiDAR radar: the "Detailed" LiDAR view. The robot's /scan drawn as
   a dark sonar screen - rings, scan rays, every return as a dot,
   obstacles as bigger amber / red dots, the blind area behind - in
   every LiDAR plot (Overview card, Drive tab, full screen). On the
   Overview card a panel reports the closest thing in each direction
   and the nearest objects.

   It draws through the same plotting helpers as the Lines view
   (metrics.js), so zoom, drag, Center, hover and beam selection all
   work the same. It reads the scan the rest of the page uses
   (lastScan, set by connection.js): no extra rosbridge traffic. */

/* ==========================================================
   CONFIG - thresholds, colours, sectors
========================================================== */

const RADAR = {

  /* distances, metres */
  danger: 0.30,               // closer: DANGER (red)
  warn: 1.00,                 // closer: WARN (amber); farther: CLEAR
  hysteresis: 0.05,           // a status changes only 5 cm past its line

  /* single-point noise: keep a point only if a neighbour agrees */
  neighbourAgree: 0.05,       // m, plus neighbourAgreeRel of the distance
  neighbourAgreeRel: 0.05,

  /* objects: split two neighbouring points when their gap is wider */
  clusterGap: 0.10,           // m, plus clusterGapRel of the distance
  clusterGapRel: 0.03,
  clusterMinPoints: 2,

  nearestShown: 5,            // objects listed in the panel, and numbered on the plot

  /* an object counts as approaching when it is this much closer than
     in the scan a second ago (the robot's own motion included) */
  approachMin: 0.08,          // m

  /* sectors, degrees, REP-103: 0 straight ahead, positive to the LEFT */
  sectors: [
    { id: "left",        label: "Left",        from: 60,  to: 120 },
    { id: "frontLeft",   label: "Front-left",  from: 20,  to: 60 },
    { id: "front",       label: "Front",       from: -20, to: 20 },
    { id: "frontRight",  label: "Front-right", from: -60, to: -20 },
    { id: "right",       label: "Right",       from: -120, to: -60 }
  ],

  /* the screen (the range is each plot's own zoom) */
  rays: 10,                   // a scan ray every 10 degrees
  rings: 3,
  sweepSeconds: 4,            // one turn of the sweep line

  colors: {
    background: "#0B1220",
    ring: "#263548",
    ringLabel: "#64748B",
    robot: "#E5E7EB",
    robotEdge: "#94A3B8",
    lidar: "#38BDF8",
    ray: "rgba(34, 197, 94, 0.45)",
    hit: "#4ADE80",
    warn: "#F59E0B",
    danger: "#EF4444",
    blind: "rgba(239, 68, 68, 0.07)",
    blindLabel: "#EF4444",
    front: "#9CA3AF",
    sweep: "rgba(74, 222, 128, 0.35)"
  }
};

/* ==========================================================
   STATE
========================================================== */

const radarState = {
  masks: [],                  // [from, to] degrees to ignore (own robot)
  sweep: true,
  scanAt: 0,                  // which scan was last analysed
  arrivals: [],               // scan times, for scans/s
  result: null,               // the last analysis
  sectorStatus: {}            // status per sector, with hysteresis
};

const DEG = Math.PI / 180;

/* ==========================================================
   ANALYSIS - pure, from one LaserScan message
========================================================== */

function radarMasked(angle, masks) {
  const deg = angle / DEG;
  return masks.some(([from, to]) =>
    from <= to ? deg >= from && deg <= to : deg >= from || deg <= to);
}

/* The returns worth drawing: valid, outside the masks, and backed up
   by a neighbour (one lone reading is noise). */
function radarPoints(scan, masks) {

  const g = scanGeometry(scan);
  const ranges = scan.ranges || [];
  const raw = [];

  for (let i = 0; i < ranges.length; i++) {

    const r = Number(ranges[i]);
    const angle = g.angleMin + i * g.angleInc;

    if (!isValidRange(r, g.rangeMin, g.rangeMax) || radarMasked(angle, masks)) {
      raw.push(null);
      continue;
    }

    raw.push({ index: i, r, angle, x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }

  const agree = (a, b) =>
    b && Math.abs(a.r - b.r) <= RADAR.neighbourAgree + RADAR.neighbourAgreeRel * a.r;

  return raw.filter((p, i) => p && (agree(p, raw[i - 1]) || agree(p, raw[i + 1])));
}

/* Neighbouring points into objects: a gap wider than
   clusterGap + clusterGapRel x distance starts a new one. */
function radarClusters(points) {

  const clusters = [];
  let current = [];

  points.forEach((p, k) => {

    const prev = points[k - 1];
    const split = !prev || p.index - prev.index > 2 ||
      Math.hypot(p.x - prev.x, p.y - prev.y) > RADAR.clusterGap + RADAR.clusterGapRel * p.r;

    if (split && current.length) {
      clusters.push(current);
      current = [];
    }

    current.push(p);
  });

  if (current.length) clusters.push(current);

  return clusters
    .filter(c => c.length >= RADAR.clusterMinPoints)
    .map(c => {
      const nearest = c.reduce((a, b) => (b.r < a.r ? b : a));
      const first = c[0];
      const last = c[c.length - 1];
      return {
        points: c,
        distance: nearest.r,
        angle: nearest.angle,
        from: Math.min(first.angle, last.angle),
        to: Math.max(first.angle, last.angle),
        width: Math.hypot(last.x - first.x, last.y - first.y)
      };
    });
}

function radarStatusOf(distance, before) {

  if (distance === null) return "clear";

  /* step in at the line, step back out only past it plus hysteresis */
  const h = RADAR.hysteresis;
  const dangerLine = before === "danger" ? RADAR.danger + h : RADAR.danger;
  const warnLine = before === "danger" || before === "warn" ? RADAR.warn + h : RADAR.warn;

  return distance < dangerLine ? "danger" : distance < warnLine ? "warn" : "clear";
}

function radarAnalyse(scan) {

  const g = scanGeometry(scan);
  const points = radarPoints(scan, radarState.masks);
  const clusters = radarClusters(points);

  const sectors = RADAR.sectors.map(sector => {

    let nearest = null;

    points.forEach(p => {
      const deg = p.angle / DEG;
      if (deg >= sector.from && deg <= sector.to && (!nearest || p.r < nearest.r)) nearest = p;
    });

    const distance = nearest ? nearest.r : null;
    const status = radarStatusOf(distance, radarState.sectorStatus[sector.id]);

    radarState.sectorStatus[sector.id] = status;

    return { ...sector, distance, status };
  });

  const objects = clusters
    .slice()
    .sort((a, b) => a.distance - b.distance);

  /* numbers match the panel's list; the nearest few are numbered */
  objects.forEach((o, i) => { o.number = i < RADAR.nearestShown ? i + 1 : null; });

  /* approaching: compare with the same angles a second ago */
  const ghost = typeof ghostScan === "function" ? ghostScan() : null;

  if (ghost && scanStats) {
    const dt = (scanStats.at - ghost.at) / 1000;
    objects.forEach(o => {
      const before = sectorMin(ghost.ranges, g.angleMin, g.angleInc, g.rangeMin, g.rangeMax,
                               o.from - 2 * DEG, o.to + 2 * DEG);
      const closer = before ? before.range - o.distance : 0;
      o.approach = dt > 0.3 && closer >= RADAR.approachMin ? closer / dt : 0;
    });
  }

  const nearest = objects[0] || null;

  return { g, points, clusters, sectors, objects, nearest };
}

/* "30° left", "straight ahead" */
function radarBearing(angle) {
  const deg = Math.round(angle / DEG);
  if (Math.abs(deg) <= 3) return "straight ahead";
  if (Math.abs(deg) >= 177) return "straight behind";
  return `${Math.abs(deg)}° ${deg > 0 ? "left" : "right"}`;
}

/* The analysis of the newest scan, worked out once however many
   plots draw it. */
function radarCurrent() {
  if (lastScan && scanStats && scanStats.at !== radarState.scanAt) {
    radarState.scanAt = scanStats.at;
    radarState.result = radarAnalyse(lastScan);
  }
  return lastScan ? radarState.result : null;
}

/* ==========================================================
   DRAWING - one LiDAR plot in the radar style
   Called by drawScanCanvas (metrics.js) when the view is Detailed.
========================================================== */

function drawRadarScan(canvas, scaleState, selLo, selHi) {

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const c = RADAR.colors;
  const px = RU;                                 // device px per CSS px
  const font = Math.round(Math.max(11, Math.min(14, w / RU / 36)) * RU);

  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, w, h);

  if (!lastScan) {
    ctx.fillStyle = c.front;
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No scan yet", w / 2, h / 2);
    return;
  }

  const now = performance.now();
  const age = (now - scanStats.at) / 1000;
  const live = age < 2;

  const g = scanGeometry(lastScan);
  const ranges = lastScan.ranges || [];

  updateScale(scaleState, ranges, g, now);

  const scale = scaleState.range;
  const margin = font * 2.2;
  const ppm = (Math.min(w, h) / 2 - margin) / scale;
  const { originX: ox, originY: oy } =
    panOrigin(scaleState, w, h, ppm, scale, farthestReturn(ranges, g));
  const P = (angle, range) => polarToCanvas(angle, range, ppm, ox, oy);
  const reach = scale + Math.hypot(scaleState.panX || 0, scaleState.panY || 0);
  const outer = scale * ppm;

  const result = radarCurrent();

  /* stale: the last picture, dimmed */
  ctx.globalAlpha = live ? 1 : 0.4;

  /* the area the sensor cannot see, behind it */
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  for (let a = g.angleMax; a <= g.angleMin + Math.PI * 2 + 1e-6; a += 2 * DEG) {
    const p = P(a, reach * 1.5);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = c.blind;
  ctx.fill();

  /* range rings, a crosshair, and their distances */
  ctx.lineWidth = 1 * px;
  ctx.strokeStyle = c.ring;
  for (let i = 1; i <= RADAR.rings; i++) {
    ctx.beginPath();
    ctx.arc(ox, oy, outer * i / RADAR.rings, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(ox - outer, oy);
  ctx.lineTo(ox + outer, oy);
  ctx.moveTo(ox, oy - outer);
  ctx.lineTo(ox, oy + outer);
  ctx.stroke();

  /* scan rays across the field of view */
  ctx.strokeStyle = c.ray;
  ctx.beginPath();
  for (let a = Math.ceil(g.angleMin / DEG / RADAR.rays) * RADAR.rays; a <= g.angleMax / DEG; a += RADAR.rays) {
    const p = P(a * DEG, scale);
    ctx.moveTo(ox, oy);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  /* the sweep, for the radar feel */
  if (radarState.sweep && live) {
    const turn = (now / 1000 / RADAR.sweepSeconds) % 1;
    const p = P(g.angleMin + (g.angleMax - g.angleMin) * turn, scale);
    const grad = ctx.createLinearGradient(ox, oy, p.x, p.y);
    grad.addColorStop(0, "rgba(74, 222, 128, 0)");
    grad.addColorStop(1, c.sweep);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  const hasSelection =
    selLo !== null && selHi !== null && selLo <= selHi && selLo < ranges.length;

  if (hasSelection) {
    drawSelectionWedge(ctx, ranges, g, reach, P, ox, oy, selLo, selHi);
  }

  /* the warn and danger distances, as dashed circles */
  [[RADAR.warn, c.warn], [RADAR.danger, c.danger]].forEach(([r, color]) => {
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = (live ? 1 : 0.4) * 0.55;
    ctx.lineWidth = 1 * px;
    ctx.beginPath();
    ctx.arc(ox, oy, r * ppm, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.globalAlpha = live ? 1 : 0.4;

  if (result) {

    /* walls and objects as outlines: a faint line through each run of
       returns, so a wall reads as a wall */
    ctx.strokeStyle = "rgba(74, 222, 128, 0.55)";
    ctx.lineWidth = 1.4 * px;
    ctx.lineJoin = "round";
    result.clusters.forEach(cl => {
      ctx.beginPath();
      cl.points.forEach((p, k) => {
        const q = P(p.angle, p.r);
        if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
    });

    /* every return: a small green dot */
    ctx.fillStyle = c.hit;
    result.points.forEach(p => {
      if (p.r > reach) return;
      const q = P(p.angle, p.r);
      ctx.fillRect(q.x - 1.2 * px, q.y - 1.2 * px, 2.4 * px, 2.4 * px);
    });

    /* obstacles (closer than the warning distance): a thick outline in
       their status colour, bigger dots */
    result.objects.forEach(o => {
      if (o.distance >= RADAR.warn) return;
      const color = o.distance < RADAR.danger ? c.danger : c.warn;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * px;
      ctx.lineCap = "round";
      ctx.globalAlpha = (live ? 1 : 0.4) * 0.45;
      ctx.beginPath();
      o.points.forEach((p, k) => {
        const q = P(p.angle, p.r);
        if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      ctx.globalAlpha = live ? 1 : 0.4;
      ctx.fillStyle = color;
      o.points.forEach(p => {
        const q = P(p.angle, p.r);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.6 * px, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    /* the nearest thing: a dashed line from the car, with its distance */
    if (result.nearest && result.nearest.distance <= reach) {
      const n = result.nearest;
      const q = P(n.angle, n.distance);
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (hasSelection) {
    drawSelectedBeams(ctx, ranges, g, reach, P, selLo, selHi);
  }

  /* ring distances, on the right-hand crosshair */
  ctx.fillStyle = c.ringLabel;
  ctx.font = `${Math.round(font * 0.85)}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  for (let i = 1; i <= RADAR.rings; i++) {
    const metres = scale * i / RADAR.rings;
    ctx.fillText((metres % 1 ? metres.toFixed(1) : metres) + " m",
      ox + outer * i / RADAR.rings + 3 * px, oy - 3 * px);
  }

  /* the robot: an arrowhead pointing forward, the lidar a cyan dot */
  const s = Math.max(8 * px, Math.min(16 * px, outer / 20));
  ctx.beginPath();
  ctx.moveTo(ox, oy - s * 1.3);
  ctx.lineTo(ox + s * 0.85, oy + s * 0.9);
  ctx.lineTo(ox, oy + s * 0.45);
  ctx.lineTo(ox - s * 0.85, oy + s * 0.9);
  ctx.closePath();
  ctx.fillStyle = c.robot;
  ctx.fill();
  ctx.strokeStyle = c.robotEdge;
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(ox, oy, Math.max(2.5 * px, s * 0.22), 0, Math.PI * 2);
  ctx.fillStyle = c.lidar;
  ctx.fill();

  /* proximity ring: each direction's status as an arc around the car */
  if (result && live) {
    const ring = s * 2.1;
    const tone = { danger: c.danger, warn: c.warn, clear: "rgba(34, 197, 94, 0.55)" };
    result.sectors.forEach(sec => {
      /* canvas angles: screen up is -90 deg; REP-103 + is left */
      const a1 = -Math.PI / 2 - sec.to * DEG;
      const a2 = -Math.PI / 2 - sec.from * DEG;
      ctx.strokeStyle = tone[sec.status];
      ctx.lineWidth = (sec.status === "clear" ? 2 : 3.5) * px;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.arc(ox, oy, ring, a1 + 2 * DEG, a2 - 2 * DEG);
      ctx.stroke();
    });
  }

  /* object tags: number and distance, approaching ones with an arrow;
     drawn last so nothing covers them */
  if (result) {
    const placed = [];                      // tags already drawn, to step around
    const hits = (x, y, bw, bh) => placed.some(r =>
      x < r.x + r.w + 3 * px && x + bw + 3 * px > r.x && y < r.y + r.h + 2 * px && y + bh + 2 * px > r.y);

    result.objects.forEach(o => {
      if (!o.number || o.distance > reach) return;
      const q = P(o.angle, o.distance);
      const status = o.distance < RADAR.danger ? "danger" : o.distance < RADAR.warn ? "warn" : "clear";
      const fill = { danger: c.danger, warn: c.warn, clear: "#1f2a3c" }[status];
      const ink = status === "warn" ? "#1a1400" : "#fff";
      const text = `${o.number}  ${o.distance.toFixed(2)} m` + (o.approach ? `  \u25BC ${o.approach.toFixed(1)} m/s` : "");
      ctx.font = `700 ${Math.round(font * 0.82)}px system-ui, sans-serif`;
      const tw = ctx.measureText(text).width;
      const bw = tw + 12 * px;
      const bh = font * 1.45;
      /* outward from the car, so the tag never sits on the robot */
      const ux = (q.x - ox) / (Math.hypot(q.x - ox, q.y - oy) || 1);
      const uy = (q.y - oy) / (Math.hypot(q.x - ox, q.y - oy) || 1);
      let bx = q.x + ux * 14 * px - (ux < 0 ? bw : 0);
      let by = q.y + uy * 14 * px - bh / 2;
      bx = Math.max(2 * px, Math.min(w - bw - 2 * px, bx));
      by = Math.max(2 * px, Math.min(h - bh - 2 * px, by));

      /* another tag there: step down (or up) until clear */
      for (let step = 1; hits(bx, by, bw, bh) && step < 12; step++) {
        const dy = Math.ceil(step / 2) * (bh + 3 * px) * (step % 2 ? 1 : -1);
        by = Math.max(2 * px, Math.min(h - bh - 2 * px, q.y + uy * 14 * px - bh / 2 + dy));
      }
      placed.push({ x: bx, y: by, w: bw, h: bh });

      /* a thin leader from the tag back to its object */
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1 * px;
      ctx.globalAlpha = live ? 0.8 : 0.4;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(Math.max(bx, Math.min(bx + bw, q.x)), Math.max(by, Math.min(by + bh, q.y)));
      ctx.stroke();
      ctx.fillStyle = fill;
      ctx.globalAlpha = live ? 0.95 : 0.5;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5 * px);
      ctx.fill();
      if (status === "clear") {
        ctx.strokeStyle = "rgba(148, 163, 184, 0.6)";
        ctx.lineWidth = 1 * px;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, bx + 6 * px, by + bh / 2 + 0.5 * px);
    });
  }

  /* labels, fixed to the frame */
  ctx.textAlign = "center";
  ctx.font = `700 ${font}px system-ui, sans-serif`;
  ctx.fillStyle = c.front;
  ctx.textBaseline = "top";
  ctx.fillText("FRONT", w / 2, 6 * px);
  ctx.fillStyle = c.blindLabel;
  ctx.textBaseline = "bottom";
  ctx.fillText("REAR BLIND AREA", w / 2, h - 6 * px);

  ctx.globalAlpha = 1;

  radarHover(ctx, result, ranges, g, reach, P, ox, oy, ppm, scaleState.hover, font);

  if (!live) {
    drawBanner(ctx, w, `SCAN STALE · last ${age.toFixed(1)} s ago`, font);
  }
}

/* Pointing at the plot always says something: the obstacle under the
   pointer, else the nearest return, else where that spot is. */
function radarHover(ctx, result, ranges, g, reach, P, ox, oy, ppm, hover, font) {

  if (!hover) return;

  const px = RU;
  const near = (q, limit) => (q.x - hover.x) ** 2 + (q.y - hover.y) ** 2 < (limit * px) ** 2;

  /* an object: any of its points within 22 px */
  const object = result && result.objects.find(o =>
    o.points.some(p => near(P(p.angle, p.r), 22)));

  if (object) {
    const status = radarStatusOf(object.distance);
    const lines = [
      (object.number ? `Object ${object.number}` : "Object") + ` · ${RADAR_WORD[status]}`,
      `${object.distance.toFixed(2)} m · ${radarBearing(object.angle)}`,
      `width ${object.width.toFixed(2)} m · ${object.points.length} points`,
      object.approach ? `approaching at ${object.approach.toFixed(1)} m/s` : "not approaching"
    ];
    const q = P(object.angle, object.distance);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(q.x, q.y, 8 * px, 0, Math.PI * 2);
    ctx.stroke();
    radarCard(ctx, hover, lines, font, status);
    return;
  }

  /* a single return close by: the beam, as in the Lines view */
  let best = -1;
  let bestDist = (14 * px) ** 2;
  for (let i = 0; i < ranges.length; i++) {
    const v = ranges[i];
    if (!isValidRange(v, g.rangeMin, g.rangeMax) || v > reach) continue;
    const q = P(g.angleMin + i * g.angleInc, v);
    const d = (q.x - hover.x) ** 2 + (q.y - hover.y) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }

  if (best >= 0) {
    const angle = g.angleMin + best * g.angleInc;
    const q = P(angle, ranges[best]);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(q.x, q.y, 7 * px, 0, Math.PI * 2);
    ctx.stroke();
    radarCard(ctx, hover, [`${ranges[best].toFixed(2)} m · ${radarBearing(angle)}`, `beam index ${best}`], font, "none");
    return;
  }

  /* empty space: where that spot is, from the car */
  const forward = (oy - hover.y) / ppm;
  const left = (ox - hover.x) / ppm;
  const dist = Math.hypot(forward, left);
  const angle = Math.atan2(left, forward);
  const blind = angle > g.angleMax || angle < g.angleMin;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  ctx.moveTo(hover.x - 6 * px, hover.y);
  ctx.lineTo(hover.x + 6 * px, hover.y);
  ctx.moveTo(hover.x, hover.y - 6 * px);
  ctx.lineTo(hover.x, hover.y + 6 * px);
  ctx.stroke();

  radarCard(ctx, hover, [
    `${dist.toFixed(2)} m · ${radarBearing(angle)}`,
    blind ? "in the blind area: the LiDAR cannot see here" : "nothing detected here"
  ], font, "none");
}

/* a small card beside the pointer, kept inside the plot */
function radarCard(ctx, at, lines, font, status) {

  const px = RU;
  const size = Math.round(font * 0.85);
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const pad = 8 * px;
  const lh = size * 1.35;
  const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;
  const bh = lines.length * lh + pad * 1.4;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const x = at.x + 16 * px + bw > W ? at.x - 16 * px - bw : at.x + 16 * px;
  const y = Math.max(4 * px, Math.min(H - bh - 4 * px, at.y - bh / 2));

  ctx.fillStyle = "rgba(11, 18, 32, 0.94)";
  ctx.strokeStyle = { danger: RADAR.colors.danger, warn: RADAR.colors.warn }[status] || "rgba(148, 163, 184, 0.55)";
  ctx.lineWidth = 1.2 * px;
  ctx.beginPath();
  ctx.roundRect(Math.max(4 * px, x), y, bw, bh, 7 * px);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? "#ffffff" : "#cbd5e1";
    ctx.font = `${i === 0 ? 700 : 500} ${size}px system-ui, sans-serif`;
    ctx.fillText(line, Math.max(4 * px, x) + pad, y + pad * 0.7 + lh * (i + 0.5));
  });
}

/* ==========================================================
   PANEL
========================================================== */

const RADAR_WORD = { danger: "DANGER", warn: "WARN", clear: "CLEAR" };

function renderRadarPanel(now) {

  const result = radarCurrent();
  const fresh = result && scanStats && now - scanStats.at < 2000;

  /* banner: the worst sector, or all clear */
  const banner = $("radarBanner");

  if (!fresh) {
    banner.className = "radar-banner none";
    banner.textContent = result ? "LIDAR HAS STOPPED UPDATING" : "WAITING FOR /scan";
  } else {
    const order = { danger: 0, warn: 1, clear: 2 };
    const worst = result.sectors
      .filter(s => s.distance !== null)
      .sort((a, b) => order[a.status] - order[b.status] || a.distance - b.distance)[0];

    if (!worst || worst.status === "clear") {
      banner.className = "radar-banner clear";
      banner.textContent = "ALL CLEAR";
    } else {
      banner.className = "radar-banner " + worst.status;
      banner.textContent =
        `${RADAR_WORD[worst.status]}: ${worst.distance.toFixed(2)} m ${worst.label.toLowerCase()}`;
    }
  }

  /* sectors, left to right as you would see them */
  $("radarSectors").innerHTML = (result ? result.sectors : RADAR.sectors).map(s => `
    <li class="radar-sector ${fresh ? s.status : "none"}">
      <span class="rs-name">${escapeHtml(s.label)}</span>
      <span class="rs-dist">${fresh && s.distance !== null ? s.distance.toFixed(2) + " m" : "—"}</span>
      <span class="rs-status">${fresh ? RADAR_WORD[s.status] : ""}</span>
    </li>`).join("");

  /* the nearest objects */
  const objects = fresh ? result.objects.slice(0, RADAR.nearestShown) : [];

  $("radarObjects").innerHTML = objects.length
    ? objects.map(o => `
      <li class="${radarStatusOf(o.distance)}">
        <span class="ro-num">${o.number}</span>
        <span><b>${o.distance.toFixed(2)} m</b>, ${radarBearing(o.angle)}, width ${o.width.toFixed(2)} m${
          o.approach ? ` <em class="ro-approach">▼ approaching ${o.approach.toFixed(1)} m/s</em>` : ""}</span>
      </li>`).join("")
    : `<li class="none">${fresh ? "Nothing detected" : "—"}</li>`;

  /* scans per second, over the last 3 s */
  const recent = radarState.arrivals.filter(t => now - t < 3000);
  radarState.arrivals = recent;
  $("radarRate").textContent = recent.length > 1
    ? ((recent.length - 1) / ((recent.at(-1) - recent[0]) / 1000)).toFixed(1) + " scans/s"
    : "—";

}

/* ==========================================================
   LOOP - the panel, and the sweep's animation
========================================================== */

/* scans per second: counted on a timer of its own, so a slow or
   paused drawing loop cannot under-count them */
let radarLastSeen = 0;

setInterval(() => {
  if (scanStats && scanStats.at !== radarLastSeen) {
    radarLastSeen = scanStats.at;
    radarState.arrivals.push(scanStats.at);
    if (radarState.arrivals.length > 200) radarState.arrivals.shift();
  }
}, 20);

/* The panel on the Overview card, while it shows (5 Hz). */
setInterval(() => {
  if (lidarView === "detailed" && !$("panelOverview").hidden) {
    renderRadarPanel(performance.now());
  }
}, 200);

/* The sweep moves between scans: redraw the plots that show, ~30 fps,
   only while Detailed is on and the sweep is wanted. */
let radarAnimAt = 0;

function radarAnimate(now) {

  requestAnimationFrame(radarAnimate);

  if (lidarView !== "detailed" || !radarState.sweep || document.hidden) return;
  if (now - radarAnimAt < 33) return;

  radarAnimAt = now;

  if (!$("panelOverview").hidden) renderRadar();
  if (typeof cockpitPaneShown === "function" && cockpitPaneShown("lidar")) redrawPaneRadar();
}

requestAnimationFrame(radarAnimate);

/* ==========================================================
   OPTIONS - sweep, masks (kept per browser)
========================================================== */

function parseMasks(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(part => part.match(/^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/))
    .filter(Boolean)
    .map(m => [Number(m[1]), Number(m[2])]);
}

/* One setting, three places: the Sweep button in each LiDAR toolbar
   (the Overview card's and the driving view's) and the driving view's
   Settings. Off takes the line away at once, not on the next scan. */
function setRadarSweep(on) {

  radarState.sweep = on;
  $("cockpitSweepToggle").checked = on;
  document.querySelectorAll("[data-sweep-toggle]").forEach(button =>
    button.setAttribute("aria-pressed", String(on)));

  try { localStorage.setItem("radarSweep", on ? "on" : "off"); } catch (error) {}

  if (!$("panelOverview").hidden) renderRadar();
  if (typeof cockpitPaneShown === "function" && cockpitPaneShown("lidar")) redrawPaneRadar();
}

$("cockpitSweepToggle").addEventListener("change", () =>
  setRadarSweep($("cockpitSweepToggle").checked));

document.querySelectorAll("[data-sweep-toggle]").forEach(button => {
  button.onclick = () => setRadarSweep(!radarState.sweep);
});

$("radarMask").addEventListener("change", () => {
  radarState.masks = parseMasks($("radarMask").value);
  $("radarMask").value = radarState.masks.map(([a, b]) => `${a}:${b}`).join(", ");
  radarState.scanAt = 0;                     // re-analyse with the masks
  renderRadar();
  try { localStorage.setItem("radarMask", $("radarMask").value); } catch (error) {}
});

try {
  radarState.sweep = localStorage.getItem("radarSweep") !== "off";
  $("radarMask").value = localStorage.getItem("radarMask") || "";
  radarState.masks = parseMasks($("radarMask").value);
} catch (error) {}

$("cockpitSweepToggle").checked = radarState.sweep;
document.querySelectorAll("[data-sweep-toggle]").forEach(button =>
  button.setAttribute("aria-pressed", String(radarState.sweep)));
