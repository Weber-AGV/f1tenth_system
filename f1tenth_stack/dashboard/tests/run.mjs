// Every check that needs no robot, in one go:   node tests/run.mjs
// (from dashboard/; it also works from anywhere else). Exits non-zero if
// any check fails, so it can gate a pull request.
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

const checks = [
  ['LiDAR plot geometry', 'node', [here('verify_radar.mjs')]],
  ['Select beams index and angle math', 'node', [here('verify_testing.mjs')]],
  ['LiDAR steer-away for autonomous runs', 'node', [here('verify_avoid.mjs')]],
  ['System list, joystick check, connection banners', 'node', [here('verify_system.mjs')]],
  ['Camera proxy: newest-frame relay', 'python3', [here('../../f1tenth_stack/camera_http.py'), '--self-test']],
  ['Robot side: e-stop, joystick, parsers, disconnect', 'python3', [here('../../f1tenth_stack/system_diagnostics.py'), '--self-test']],
  ['Restart: reading the run or the bringup, refusing a second one', 'python3', [here('../../f1tenth_stack/restart_stack.py'), '--self-test']],
];

let failed = 0;

for (const [name, cmd, args] of checks) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('      ' + out.slice(-8).join('\n      '));
}

console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
