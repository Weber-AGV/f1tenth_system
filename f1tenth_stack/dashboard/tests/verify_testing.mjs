// Pure index/angle math behind the LiDAR card's index selector —
// checked with no DOM, no websocket, no canvas. If this is wrong,
// clicking the radar plot hands a student the wrong ranges[] window
// and they scan the wrong beams without ever finding out why.
import fs from 'fs';

// Same technique as verify_radar.mjs: concatenate the page's scripts
// in the order dashboard.html loads them.
// Paths are from this file, so the check runs from any folder.
const page = f => new URL('../' + f, import.meta.url);
const html = fs.readFileSync(page('dashboard.html'), 'utf8');
const src = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => fs.readFileSync(page(m[1]), 'utf8'))
  .join('\n');

// selectionStats calls isValidRange, defined back in connection.js —
// pull both slices in rather than redefine the sentinel rule twice.
const rangeStart = src.indexOf('function isValidRange');
const rangeGeo = src.slice(rangeStart, src.indexOf('/* ====', rangeStart));

const selStart = src.indexOf('function canvasOffsetToAngle');
const selGeo = src.slice(
  selStart,
  src.indexOf('/* ---- selection state', selStart));

const env = new Function(
  `${rangeGeo}\n${selGeo}\n` +
  `return { canvasOffsetToAngle, angleToIndex, presetIndexRange, selectionStats };`
)();

const fail = [];

// A Hokuyo-shaped scan: -135° to +135°, ~0.25° steps, matching the
// robot's measured 1081-point UST-10LX scan.
const angleMin = -135 * Math.PI / 180;
const angleMax = 135 * Math.PI / 180;
const len = 1081;
const angleInc = (angleMax - angleMin) / (len - 1);

// canvasOffsetToAngle: straight ahead is "up" on screen (dy < 0, dx = 0).
Math.abs(env.canvasOffsetToAngle(0, -10) - 0) < 1e-9 ||
  fail.push('straight ahead (dx=0, dy<0) did not read as angle 0');

// left is screen-left (dx < 0), which REP-103 calls +90°.
Math.abs(env.canvasOffsetToAngle(-10, 0) - Math.PI / 2) < 1e-9 ||
  fail.push('screen-left did not read as +90°');

// right is screen-right (dx > 0), REP-103 -90°.
Math.abs(env.canvasOffsetToAngle(10, 0) - (-Math.PI / 2)) < 1e-9 ||
  fail.push('screen-right did not read as -90°');

// angleToIndex: angle_min maps to index 0, angle_max to the last index.
env.angleToIndex(angleMin, angleMin, angleInc, len) === 0 ||
  fail.push('angle_min did not map to index 0');
env.angleToIndex(angleMax, angleMin, angleInc, len) === len - 1 ||
  fail.push('angle_max did not map to the last index');

// out-of-range angles clamp instead of indexing off the array.
env.angleToIndex(angleMin - 1, angleMin, angleInc, len) === 0 ||
  fail.push('an angle before angle_min was not clamped to index 0');
env.angleToIndex(angleMax + 1, angleMin, angleInc, len) === len - 1 ||
  fail.push('an angle past angle_max was not clamped to the last index');

// presetIndexRange: front (0°) preset is centered on the middle index.
const [absLo, absHi] = env.presetIndexRange(0, 7 * Math.PI / 180, angleMin, angleInc, len);
const mid = (len - 1) / 2;
Math.abs((absLo + absHi) / 2 - mid) < 2 ||
  fail.push(`ABS preset not centered on the front index: got [${absLo}, ${absHi}], expected middle ~${mid}`);
absLo <= absHi || fail.push('preset range came back inverted (lo > hi)');

// left/right wall presets land on opposite sides of center.
const [leftLo] = env.presetIndexRange(Math.PI / 2, 7 * Math.PI / 180, angleMin, angleInc, len);
const [rightLo] = env.presetIndexRange(-Math.PI / 2, 7 * Math.PI / 180, angleMin, angleInc, len);
leftLo > mid || fail.push('left-wall preset did not land past the midpoint index');
rightLo < mid || fail.push('right-wall preset did not land before the midpoint index');

// selectionStats: sentinel (no-return) values are excluded, same
// convention as isValidRange elsewhere on the page.
const RMIN = 0.02, RMAX = 30.0;
const ranges = [1.0, 2.0, 65.533, 3.0, NaN];
const stats = env.selectionStats(ranges, RMIN, RMAX, 0, 4);
stats.count === 3 || fail.push(`expected 3 valid returns, got ${stats.count}`);
stats.min === 1.0 || fail.push(`expected min 1.0, got ${stats.min}`);
stats.max === 3.0 || fail.push(`expected max 3.0, got ${stats.max}`);
Math.abs(stats.avg - 2.0) < 1e-9 || fail.push(`expected avg 2.0, got ${stats.avg}`);

// an all-sentinel window reports "no return", not a fabricated zero.
const empty = env.selectionStats([65.6, 65.6], RMIN, RMAX, 0, 1);
empty.count === 0 && empty.min === null && empty.max === null && empty.avg === null ||
  fail.push('an all-sentinel selection did not report null stats');

if (fail.length) {
  console.error('FAIL:\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.log('OK: lidar selector geometry checks passed');
