// Exercise the dashboard's REAL system list, joystick check and connection
// banners (js/system-tiles.js, js/checks.js) against the exact shapes
// system_diagnostics.py and rosbridge send. No robot, no browser.
import fs from 'fs';

// The page's own files, loaded the way dashboard.html loads them.
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const src = ['js/config.js', 'js/helpers.js', 'js/system-tiles.js', 'js/checks.js'].map(read).join('\n');

// A minimal DOM: every element the code touches is a plain object.
const els = {};
const el = id => els[id] || (els[id] = {
  id, textContent: '', innerHTML: '', className: '', disabled: false, style: {},
  classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
               toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } }
});
const document = { getElementById: el };

let callImpl = async () => ({});
const env = new Function('document', 'getCall', `
  ${src}
  var call = (...a) => getCall()(...a);
  return {
    renderSystemList, runJoyCheck, bannerState, clientsLabel,
    setDiag: d => { diag = d; }
  };
`)(document, () => callImpl);

const fail = [];
const D = (level, message, values) => ({ level, message, values });

// ---------------------------------------------------------------------------
// The Robot System list (Advanced tab): one row per OS-level check.
// ---------------------------------------------------------------------------
env.setDiag({
  'system: Thermal': D(0, 'junction 51.0 C', { 'cpu-thermal': '51.0 C', 'tj-thermal': '51.0 C', 'gpu-thermal': '50.0 C' }),
  'system: CPU':     D(0, 'load 1.95 over 6 cores', { cores: '6', 'load 1m': '1.95' }),
  'system: Memory':  D(0, '63% available', { 'available %': '63.0', available: '4.95 GB' }),
  'system: Storage': D(0, '4% of / used', { 'used %': '4.0', free: '883 GB' }),
  'system: Power':   D(2, 'REBOOTED - uptime went backwards (brownout?)', { uptime: '12 s' }),
  'system: Camera':  D(0, 'USB3 at 5000 M', { 'link speed': '5000 M', product: 'Intel(R) RealSense(TM) Depth Camera 435i' }),
  'system: Gamepad': D(1, 'not connected', { 'js devices': 'none', bluetooth: 'paired' }),
  'system: Network': D(0, '2 links up', { wlan0: 'carrier=1 up', eth0: 'carrier=0 down', 'lidar 192.168.0.10': 'reachable, 0.187 ms' }),
  'system: Clock':   D(3, 'not probed yet', {}),
  'urg_node: Hardware Status': D(0, 'Streaming', {}),   // must NOT appear here
});
env.renderSystemList();

const list = els.sysList.innerHTML;
const names = [...list.matchAll(/class="sys-name">([^<]*)</g)].map(m => m[1]);
['Thermal', 'Power', 'CPU', 'Memory', 'Storage', 'Network', 'Camera', 'Gamepad', 'Clock']
  .forEach(w => names.includes(w) || fail.push('missing row: ' + w));
list.includes('urg_node') && fail.push('urg_node leaked into the system list');
names[0] === 'Power' || fail.push('the error (Power) should be listed first, got: ' + names[0]);
names[1] === 'Gamepad' || fail.push('the warning (Gamepad) should come next, got: ' + names[1]);
list.includes('5000 M') || fail.push('every reading should be shown (camera link speed missing)');
list.includes('Wired Ethernet (eth0): not connected') || fail.push('a main link that is down should be explained');
list.includes('Lidar (192.168.0.10): answering') || fail.push('the lidar ping should be explained');
els.sysSummary.textContent === 'ERROR' || fail.push('summary should be ERROR (brownout), got: ' + els.sysSummary.textContent);
els.sysHint.style.display === 'none' || fail.push('hint should be hidden once data arrives');
/</.test(names.join('')) && fail.push('a row name was not escaped');

// STALE (not probed yet) must not read as the worst level
env.setDiag({ 'system: Clock': D(3, 'not probed yet', {}) });
env.renderSystemList();
els.sysSummary.textContent === '1 checks OK' || fail.push('STALE alone should not read as ERROR/WARN, got: ' + els.sysSummary.textContent);

// A probe that raised must say so, with the detail
env.setDiag({ 'system: Thermal': D(2, "TypeError at line 19: can't concat NoneType to bytes", { probe: 'thermal', exception: 'TypeError' }) });
env.renderSystemList();
els.sysList.innerHTML.includes('TypeError at line 19') || fail.push('the exception detail should appear in the row');

// empty state
env.setDiag({});
env.renderSystemList();
els.sysHint.style.display === 'block' || fail.push('hint should return when nothing is reporting');
els.sysSummary.textContent === 'not reporting' || fail.push('summary should reset');

// ---------------------------------------------------------------------------
// The on-demand joystick check. All three outcomes are worth pinning: a
// verdict, a refused call, and the specific "service isn't there" case that
// means system_diagnostics.py is not running rather than the joystick being
// broken.
// ---------------------------------------------------------------------------
const joyCase = async impl => {
  callImpl = impl;
  delete els.joyResult;
  delete els.joyBtn;
  await env.runJoyCheck();
  return { out: el('joyResult'), btn: el('joyBtn') };
};

let r = await joyCase(async () => ({ success: true, message: 'joy_enumerate_devices: 1 device(s)' }));
r.out.textContent.includes('1 device(s)') || fail.push('joy: verdict message not shown');
r.out.style.color === 'var(--ok-ink)' || fail.push('joy: a passing check should read OK, got ' + r.out.style.color);
r.out.classList.contains('show') || fail.push('joy: result pane should be revealed');
r.btn.disabled === false || fail.push('joy: button must be re-enabled after a successful run');

r = await joyCase(async () => ({ success: false, message: 'CONTRADICTION: the pad is paired' }));
r.out.style.color === 'var(--warn-ink)' || fail.push('joy: a failed verdict is a WARN, not an error');
r.out.textContent.includes('CONTRADICTION') || fail.push('joy: the contradiction text must survive');

// A rejected call is a different thing from a check that ran and said no.
r = await joyCase(async () => { throw new Error('service /system_diagnostics/joystick_check does not exist'); });
r.out.style.color === 'var(--bad-ink)' || fail.push('joy: a refused call should read as an error');
r.out.textContent.includes('bringup_launch.py')
  || fail.push('joy: a missing service should point at restarting bringup, not blame the joystick');
r.btn.disabled === false || fail.push('joy: button must be re-enabled after a failed run');

r = await joyCase(async () => { throw new Error('timeout x'); });
r.out.textContent.includes('check failed') || fail.push('joy: a non-missing failure should report plainly');
r.out.textContent.includes('bringup_launch.py') && fail.push('joy: a timeout is not a missing service');

// ---------------------------------------------------------------------------
// Connection health. The starved-client case is the one that matters:
// rosbridge answers service calls normally while sending no topic data, so the
// page looks like a dead robot.
// ---------------------------------------------------------------------------
const { bannerState, clientsLabel } = env;

clientsLabel(null, 10).cls === '' || fail.push('an unknown count is not worth colouring');
clientsLabel(0, 10).text === clientsLabel(null, 10).text
  || fail.push('a count of 0 is impossible for a connected page and must read as unknown');
clientsLabel(3, 10).cls === '' || fail.push('3 of 10 is not worth colouring');
clientsLabel(8, 10).cls === 'near' || fail.push('approaching the limit should warn');
clientsLabel(14, 10).cls === 'over' || fail.push('past the limit should be red');

const ST = o => Object.assign({
  wsOpen: true, lastAnything: 1000, lastPublish: 1000, connectedAt: 0,
  clients: null, limit: 10, connStaleMs: 4000, publishStaleMs: 8000 }, o);

bannerState(1100, ST({})) === null || fail.push('healthy connection should show no banner');
bannerState(1100, ST({ wsOpen: false })) === null || fail.push("a closed socket is the dot's job, not a banner");

let b = bannerState(9000, ST({ lastAnything: 1000, lastPublish: 1000 }));
(b && b.kind === 'stale') || fail.push('nothing at all from rosbridge should raise the stale banner');

b = bannerState(20000, ST({ lastAnything: 19900, lastPublish: 1000 }));
(b && b.kind === 'starved') || fail.push('no topic data while services answer should read as starved, got: ' + JSON.stringify(b));
(b && /client limit \(10\)/.test(b.text)) || fail.push('the starved banner should name the limit');

// A client that has NEVER received a publish must still be caught.
b = bannerState(20000, ST({ lastAnything: 19900, lastPublish: 0, connectedAt: 1000 }));
(b && b.kind === 'starved') || fail.push('a client that never received any publish should read as starved');
b = bannerState(3000, ST({ lastAnything: 2900, lastPublish: 0, connectedAt: 1000 }));
b === null || fail.push('do not cry starvation before a publish is even due, got: ' + JSON.stringify(b));

// Over the limit while still being served ourselves: warn, do not claim starvation.
b = bannerState(1100, ST({ clients: 14 }));
(b && b.kind === 'crowded') || fail.push('more clients than the limit should warn');
(b && /14 clients/.test(b.text)) || fail.push('the crowded banner should name the count');
bannerState(1100, ST({ clients: 10 })) === null || fail.push('exactly at the limit is still served, no banner');

console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'all system-list, joystick-check and connection-health checks passed');
process.exit(fail.length ? 1 : 0);
