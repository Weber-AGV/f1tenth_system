// LiDAR steer-away for the autonomous run (js/avoid.js): pure scan -> steering.
import fs from 'fs';

const page = f => new URL('../' + f, import.meta.url);
// connection.js has CRLF line endings; normalise so the slicing below works
const rangeStart = fs.readFileSync(page('js/connection.js'), 'utf8').replace(/\r\n/g, '\n');
const pick = (src, from) => { const i = src.indexOf(from); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
const env = new Function(
  pick(rangeStart, 'function isValidRange') + pick(rangeStart, 'function sectorMin') +
  fs.readFileSync(page('js/avoid.js'), 'utf8') +
  'return { lidarAvoid, avoidLookahead };')();

let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

// 360 beams, 1 degree apart, -180..179, everything clear at 10 m
const scan = (obstacles = []) => {
  const ranges = Array(360).fill(10);
  for (const [deg, range] of obstacles) ranges[Math.round(deg) + 180] = range;
  return { ranges, angle_min: -Math.PI, angle_increment: Math.PI / 180, range_min: 0.05, range_max: 30 };
};
const MAX = 0.34;

check('clear road: no steering override', env.lidarAvoid(scan(), 1, MAX, { dir: 0 }).steer === null);
check('obstacle far beyond lookahead: ignored', env.lidarAvoid(scan([[0, 5]]), 1, MAX, { dir: 0 }).steer === null);
check('obstacle behind the car: ignored', env.lidarAvoid(scan([[180, 0.3]]), 1, MAX, { dir: 0 }).steer === null);
check('reversing: ignored', env.lidarAvoid(scan([[0, 0.3]]), -1, MAX, { dir: 0 }).steer === null);
check('no scan: ignored', env.lidarAvoid(null, 1, MAX, { dir: 0 }).steer === null);

let r = env.lidarAvoid(scan([[0, 1], [40, 0.6]]), 1, MAX, { dir: 0 });
check('ahead + left side blocked: steer right (negative)', r.active && r.steer < 0);
r = env.lidarAvoid(scan([[0, 1], [-40, 0.6]]), 1, MAX, { dir: 0 });
check('ahead + right side blocked: steer left (positive)', r.active && r.steer > 0);

const near = env.lidarAvoid(scan([[0, 0.4], [40, 5]]), 1, MAX, { dir: 0 });
const far = env.lidarAvoid(scan([[0, 1.5], [40, 5]]), 1, MAX, { dir: 0 });
check('closer obstacle turns harder', Math.abs(near.steer) > Math.abs(far.steer));
check('hard stop distance: full lock', Math.abs(near.steer - -MAX) < 1e-9);
check('never past the steering limit', Math.abs(near.steer) <= MAX + 1e-9);

// commits to a side: obstacle then appears to shift, direction must hold
const st = { dir: 0 };
env.lidarAvoid(scan([[0, 1], [40, 0.6]]), 1, MAX, st);
const held = env.lidarAvoid(scan([[0, 1], [-40, 0.6]]), 1, MAX, st);
check('keeps its side while still blocked', held.steer < 0);

// releases only once clear by the margin
const trig = env.avoidLookahead(1);
check('still avoiding just inside release distance', env.lidarAvoid(scan([[0, trig * 1.1]]), 1, MAX, { dir: -1 }).active);
const cleared = { dir: -1 };
check('releases once clear', env.lidarAvoid(scan([[0, trig * 1.3]]), 1, MAX, cleared).steer === null && cleared.dir === 0);

check('faster = looks further ahead', env.avoidLookahead(3) > env.avoidLookahead(1));

process.exit(failed ? 1 : 0);
