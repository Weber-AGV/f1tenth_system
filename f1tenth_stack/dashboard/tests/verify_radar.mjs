// Pure geometry behind the radar plot on the LiDAR card — checked
// with no DOM, no websocket, no canvas. If this is wrong, the plot
// still draws something plausible-looking, just in the wrong place
// or with phantom walls at the sentinel range. Same failure mode as
// estop_capture.py: a confidently wrong number with nothing to catch it.
import fs from 'fs';

// The page's logic is split across js/*.js, loaded by dashboard.html in order.
// Read them the same way so this keeps working if a function moves files.
// Paths are from this file, so the check runs from any folder.
const page = f => new URL('../' + f, import.meta.url);
const html = fs.readFileSync(page('dashboard.html'), 'utf8');
const src = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => fs.readFileSync(page(m[1]), 'utf8'))
  .join('\n');

const geoStart = src.indexOf('function isValidRange');
const geo = src.slice(
  geoStart,
  src.indexOf('/* ==========', geoStart));

const env = new Function(`${geo}\nreturn { isValidRange, polarToCanvas, sectorMin, rangeTrend };`)();

const fail = [];
const RMIN = 0.02, RMAX = 30.0;

// Measured on the robot 2026-09-23: no-return beams read ~65.5 m,
// ABOVE range_max — not inf, not NaN, not clipped to range_max.
env.isValidRange(65.533, RMIN, RMAX) === false ||
  fail.push('sentinel return (65.533m, > range_max) accepted as valid');
env.isValidRange(RMAX, RMIN, RMAX) === false ||
  fail.push('exactly range_max accepted as valid');
env.isValidRange(RMIN, RMIN, RMAX) === false ||
  fail.push('exactly range_min accepted as valid');
env.isValidRange(5.0, RMIN, RMAX) === true ||
  fail.push('an ordinary in-range return rejected');
env.isValidRange(NaN, RMIN, RMAX) === false ||
  fail.push('NaN accepted as valid');
env.isValidRange(Infinity, RMIN, RMAX) === false ||
  fail.push('Infinity accepted as valid');

// Chase-cam convention: forward is up, left is screen-left.
const fwd = env.polarToCanvas(0, 5, 10, 100, 100);
(Math.abs(fwd.x - 100) < 1e-9 && Math.abs(fwd.y - 50) < 1e-9) ||
  fail.push('angle 0 (forward) did not plot straight up: ' + JSON.stringify(fwd));

const left = env.polarToCanvas(Math.PI / 2, 5, 10, 100, 100);
(Math.abs(left.x - 50) < 1e-9 && Math.abs(left.y - 100) < 1e-9) ||
  fail.push('angle +90 (left, REP-103) did not plot screen-left: ' + JSON.stringify(left));

const right = env.polarToCanvas(-Math.PI / 2, 5, 10, 100, 100);
(Math.abs(right.x - 150) < 1e-9 && Math.abs(right.y - 100) < 1e-9) ||
  fail.push('angle -90 (right) did not plot screen-right: ' + JSON.stringify(right));

// Sector minimum: only beams inside the bearing window count, and
// sentinel no-returns are never "the closest thing".
{
  // 5 beams at -90, -45, 0, +45, +90 degrees
  const inc = Math.PI / 4, amin = -Math.PI / 2;
  const ranges = [0.5, 3.0, 65.533, 1.2, 2.0];
  const front = env.sectorMin(ranges, amin, inc, RMIN, RMAX, -0.1, 0.1);
  front === null ||
    fail.push('sector holding only a sentinel beam should be null: ' + JSON.stringify(front));
  const leftHalf = env.sectorMin(ranges, amin, inc, RMIN, RMAX, 0.1, Math.PI);
  (leftHalf && leftHalf.range === 1.2 && leftHalf.index === 3) ||
    fail.push('left half should find 1.2 m at index 3: ' + JSON.stringify(leftHalf));
  const all = env.sectorMin(ranges, amin, inc, RMIN, RMAX, -Math.PI, Math.PI);
  (all && all.range === 0.5 && all.index === 0) ||
    fail.push('whole scan should find 0.5 m at index 0 (right): ' + JSON.stringify(all));
}

// Trend arrow has a dead band, so noise does not flicker it.
env.rangeTrend(1.00, 1.05) === 'steady' || fail.push('5 cm change should read steady');
env.rangeTrend(0.80, 1.00) === 'closer' || fail.push('20 cm closer should read closer');
env.rangeTrend(1.30, 1.00) === 'farther' || fail.push('30 cm farther should read farther');
env.rangeTrend(1.00, NaN) === 'steady' || fail.push('missing history should read steady');

// Drag-to-pan: the car moves with the drag but never leaves the plot,
// and a beam drawn at the panned origin maps back to its own angle -
// what the hover readout and the index selector both rely on.
{
  const fnSrc = name => {
    const at = src.indexOf(`function ${name}(`);
    return src.slice(at, src.indexOf('\n}\n', at) + 2);
  };
  const pan = new Function(
    `${fnSrc('panOrigin')}\n${fnSrc('canvasOffsetToAngle')}\n` +
    'return { panOrigin, canvasOffsetToAngle };')();

  const state = {};
  let o = pan.panOrigin(state, 400, 400, 50, 4);
  (o.originX === 200 && o.originY === 200) || fail.push('no pan should centre the car: ' + JSON.stringify(o));

  state.panX = 1;
  o = pan.panOrigin(state, 400, 400, 50, 4);
  o.originX === 250 || fail.push('1 m pan at 50 px/m should move the car 50 px: ' + o.originX);

  state.panX = 10; state.panY = -10;
  o = pan.panOrigin(state, 400, 400, 50, 4);
  (o.originX === 400 && o.originY === 0 && state.panX === 4) ||
    fail.push('pan past the range should stop with the car at the edge: ' + JSON.stringify(o));

  // a far return raises the limit, so a far object can be brought to the middle
  state.panX = 9;
  pan.panOrigin(state, 400, 400, 50, 4, 12);
  state.panX === 9 || fail.push('a 12 m return should let the view pan 9 m: ' + state.panX);

  // zooming keeps the spot under the mouse under the mouse
  const zoom = new Function(`${fnSrc('zoomTowardCursor')}\nreturn zoomTowardCursor;`)();
  const canvas = { width: 400, height: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) };
  const z = { panX: 0.5, panY: -1 };
  pan.panOrigin(z, 400, 400, 40, 4, 10);       // plot radius 160 px
  const mouse = { clientX: 310, clientY: 90 };
  const spot = [(310 - z.originX) / z.ppm, (90 - z.originY) / z.ppm];
  z.range = 2;                                   // one step in
  zoom(canvas, z, mouse);
  const after = pan.panOrigin(z, 400, 400, 80, 2, 10);
  (Math.abs(after.originX + spot[0] * 80 - 310) < 1e-9 &&
   Math.abs(after.originY + spot[1] * 80 - 90) < 1e-9) ||
    fail.push('zoom moved the spot under the mouse: ' + JSON.stringify(after));

  state.panX = 1.3; state.panY = -0.7;
  o = pan.panOrigin(state, 400, 400, 50, 4);
  for (const angle of [-2.0, -0.5, 0, 0.8, 2.2]) {
    const p = env.polarToCanvas(angle, 2.5, 50, o.originX, o.originY);
    const back = pan.canvasOffsetToAngle(p.x - o.originX, p.y - o.originY);
    Math.abs(back - angle) < 1e-9 ||
      fail.push(`beam at ${angle} rad maps back to ${back} after a pan`);
  }
}

if (fail.length) {
  console.error('FAIL:\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.log('OK: radar geometry checks passed');
