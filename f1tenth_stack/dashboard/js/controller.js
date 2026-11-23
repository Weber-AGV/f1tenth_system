"use strict";

/* Controller tab: a controller drawn live, what is pressed lit up, the
   sticks moving, the triggers filling, the raw numbers beside it. Two
   controllers:

   - PS4 on the car: what the car hears, from /joy. /joy comes in at 5 Hz
     for the rest of the page (LIVENESS_THROTTLE); while this tab shows it
     is resubscribed at full rate (~48 Hz) and put back when you leave.
   - Steam Deck (this browser): the controller of the device this page is
     open on, through the browser's Gamepad API. It can also drive the
     car (deckDriveInput, read by drive.js): hold L1, as with the car's
     own controller.

   Both are read the same way: a message of buttons[] and axes[] in ROS
   joy's convention (left and up positive, a trigger resting at +1), read
   through a mapping. Each controller has a default mapping and can be
   re-mapped with Map buttons; mappings are saved per browser. */

/* ---------- the two controllers ---------- */

const JP_DEVICES = {

  ps4: {
    title: "PS4 controller",
    svg: "jpSvg",
    sticks: { l: ["jpStickL", 310, 306], r: ["jpStickR", 530, 306] },
    triggers: { l2: ["jpFillL2", 24, 50], r2: ["jpFillR2", 24, 50] },   // [id, top, height]
    names: {
      cross: "✕ Cross", circle: "○ Circle", triangle: "△ Triangle", square: "□ Square",
      l1: "L1", r1: "R1", l2: "L2", r2: "R2", l3: "L3 (left stick press)",
      r3: "R3 (right stick press)", share: "Share", options: "Options", ps: "PS",
      touchpad: "Touchpad click", up: "D-pad up", down: "D-pad down",
      left: "D-pad left", right: "D-pad right"
    },
    /* what /joy carries on the cars, measured on F1-WSU-2: the Jetson
       kernel has no Sony driver, so the pad is a generic HID device
       (not the hid-playstation layout a laptop shows: Cross at 0, L2 on
       axis 2, right stick on 3 / 4). L1 at buttons[4], R1 at [5], the
       right stick's X on axes[2], as joy_teleop.yaml expects. */
    map: {
      buttons: {
        square: 0, cross: 1, circle: 2, triangle: 3,
        l1: 4, r1: 5, l2: 6, r2: 7,
        share: 8, options: 9, l3: 10, r3: 11, ps: 12, touchpad: 13
      },
      axes: {
        lx: { i: 0, s: 1 }, ly: { i: 1, s: 1 },
        rx: { i: 2, s: 1 }, ry: { i: 5, s: 1 },
        l2: { i: 3, s: 1 }, r2: { i: 4, s: 1 }
      },
      dpad: { kind: "axes", x: { i: 6, s: 1 }, y: { i: 7, s: 1 } }
    },
    steps: [
      ["button", "cross"], ["button", "circle"], ["button", "triangle"], ["button", "square"],
      ["button", "l1"], ["button", "r1"], ["trigger", "l2"], ["trigger", "r2"],
      ["button", "share"], ["button", "options"], ["button", "ps"],
      ["button", "l3"], ["button", "r3"],
      ["stick", "lx", "Push the LEFT stick to the left"], ["stick", "ly", "Push the LEFT stick up"],
      ["stick", "rx", "Push the RIGHT stick to the left"], ["stick", "ry", "Push the RIGHT stick up"],
      ["dpad", "up"], ["dpad", "left"], ["dpad", "down"], ["dpad", "right"],
      ["button", "touchpad"]
    ]
  },

  deck: {
    title: "Steam Deck",
    svg: "jpDeckSvg",
    sticks: { l: ["jpDeckStickL", 215, 170], r: ["jpDeckStickR", 785, 170] },
    triggers: { l2: ["jpDeckFillL2", 12, 44], r2: ["jpDeckFillR2", 12, 44] },
    names: {
      a: "A", b: "B", x: "X", y: "Y",
      l1: "L1", r1: "R1", l2: "L2", r2: "R2", l3: "L3 (left stick press)",
      r3: "R3 (right stick press)", view: "View", menu: "Menu", steam: "Steam",
      quick: "Quick access (• • •)", l4: "L4", l5: "L5", r4: "R4", r5: "R5",
      up: "D-pad up", down: "D-pad down", left: "D-pad left", right: "D-pad right"
    },
    /* the browser's "standard" gamepad layout, which Steam gives a game
       or a browser it launches; the back grips have no standard place */
    map: {
      buttons: {
        a: 0, b: 1, x: 2, y: 3, l1: 4, r1: 5, l2: 6, r2: 7,
        view: 8, menu: 9, l3: 10, r3: 11, steam: 16,
        quick: null, l4: null, l5: null, r4: null, r5: null
      },
      axes: {
        lx: { i: 0, s: 1 }, ly: { i: 1, s: 1 },
        rx: { i: 2, s: 1 }, ry: { i: 3, s: 1 },
        l2: { i: 4, s: 1 }, r2: { i: 5, s: 1 }
      },
      dpad: { kind: "buttons", up: 12, down: 13, left: 14, right: 15 }
    },
    steps: [
      ["button", "a"], ["button", "b"], ["button", "x"], ["button", "y"],
      ["button", "l1"], ["button", "r1"], ["trigger", "l2"], ["trigger", "r2"],
      ["button", "view"], ["button", "menu"], ["button", "steam"], ["button", "quick"],
      ["button", "l3"], ["button", "r3"],
      ["stick", "lx", "Push the LEFT stick to the left"], ["stick", "ly", "Push the LEFT stick up"],
      ["stick", "rx", "Push the RIGHT stick to the left"], ["stick", "ry", "Push the RIGHT stick up"],
      ["dpad", "up"], ["dpad", "left"], ["dpad", "down"], ["dpad", "right"],
      ["button", "l4"], ["button", "l5"], ["button", "r4"], ["button", "r5"]
    ]
  }
};

/* what the car's joy_teleop.yaml reads (estop.js JOY_L1 / JOY_R1) */
const JP_DEADMAN = { l1: "manual-drive deadman", r1: "autonomous deadman" };

const JP_PRESS = 0.5;           // an axis past this counts as pressed (D-pad, Map buttons)
const JP_FRESH_MS = 1000;       // /joy runs at ~48 Hz while a pad is connected
const JP_STICK_TRAVEL = { ps4: 18, deck: 15 };
const JP_DEVICE_KEY = "controllerDevice";
const JP_MAP_KEY = "controllerMap";      // + "." + device for the Deck

let jpDevice = "ps4";
try {
  if (localStorage.getItem(JP_DEVICE_KEY) === "deck") jpDevice = "deck";
} catch (error) {}

/* ---------- mappings, per controller ---------- */

function jpMapKey(device) {
  return device === "ps4" ? JP_MAP_KEY : JP_MAP_KEY + "." + device;
}

const jpMaps = {};
const jpCustom = {};

Object.keys(JP_DEVICES).forEach(device => {
  jpMaps[device] = JP_DEVICES[device].map;
  jpCustom[device] = false;
  try {
    const saved = JSON.parse(localStorage.getItem(jpMapKey(device)) || "null");
    if (saved && saved.buttons && saved.axes && saved.dpad) {
      jpMaps[device] = saved;
      jpCustom[device] = true;
    }
  } catch (error) {}
});

function jpSaveMap(map, device = jpDevice) {
  const custom = map !== JP_DEVICES[device].map;
  jpMaps[device] = map;
  jpCustom[device] = custom;
  jpTriggerRest[device] = {};
  try {
    if (custom) localStorage.setItem(jpMapKey(device), JSON.stringify(map));
    else localStorage.removeItem(jpMapKey(device));
  } catch (error) {}
  jpRender();
}

/* ---------- reading a message through a mapping ---------- */

function jpAxis(axes, a) {
  if (!a || a.i === null || a.i === undefined) return 0;
  const v = Number(axes[a.i]);
  return Number.isFinite(v) ? v * (a.s || 1) : 0;
}

/* A trigger rests at +1 and reads -1 fully squeezed; ROS joy reports 0
   until it is first touched. Read through the map as it is: an axis seen
   near +1 is NOT proof of a trigger (a stick pushed fully left or up
   reads +1 too, and its drift at centre then lit L2 or R2 by itself), so
   jpTriggerRest only feeds the "does not read like a trigger" hint. */
const jpTriggerRest = { ps4: {}, deck: {} };

function jpTrigger(device, axes, buttons, which) {
  const map = jpMaps[device];
  const a = map.axes[which];
  const pressed = buttons[map.buttons[which]] === 1;
  if (!a || a.i === null || axes[a.i] === undefined) return pressed ? 1 : 0;
  const v = jpAxis(axes, a);
  if (v >= 0.9) jpTriggerRest[device][a.i] = true;
  if (v === 0 && !pressed) return 0;
  return Math.max(0, Math.min(1, (1 - v) / 2));
}

function jpState(device, msg) {

  const map = jpMaps[device];
  const buttons = msg.buttons || [];
  const axes = msg.axes || [];
  const on = {};

  Object.entries(map.buttons).forEach(([name, i]) => {
    on[name] = i !== null && i !== undefined && buttons[i] === 1;
  });

  const d = map.dpad;
  if (d.kind === "buttons") {
    ["up", "down", "left", "right"].forEach(dir => { on[dir] = buttons[d[dir]] === 1; });
  } else {
    const x = jpAxis(axes, d.x);
    const y = jpAxis(axes, d.y);
    on.left = x > JP_PRESS;
    on.right = x < -JP_PRESS;
    on.up = y > JP_PRESS;
    on.down = y < -JP_PRESS;
  }

  const l2 = jpTrigger(device, axes, buttons, "l2");
  const r2 = jpTrigger(device, axes, buttons, "r2");
  on.l2 = on.l2 || l2 > 0.1;
  on.r2 = on.r2 || r2 > 0.1;

  return {
    on, l2, r2,
    lx: jpAxis(axes, map.axes.lx), ly: jpAxis(axes, map.axes.ly),
    rx: jpAxis(axes, map.axes.rx), ry: jpAxis(axes, map.axes.ry),
    buttons, axes
  };
}

/* ---------- the PS4 on the car: /joy ---------- */

let jpMsg = null;               // the newest /joy message
let jpAt = 0;                   // when it came (performance.now)
let jpLiveSince = 0;            // for "this does not look like a trigger"
const jpArrivals = [];          // for messages per second
let jpFastOn = null;            // the socket /joy is fast on, while the tab shows

function controllerTabVisible() {
  return !$("panelController").hidden;
}

/* connection.js, every /joy message */
function onControllerJoy(msg) {

  if (!jpMsg || performance.now() - jpAt > JP_FRESH_MS) jpLiveSince = performance.now();

  jpMsg = msg;
  jpAt = performance.now();
  jpArrivals.push(jpAt);
  while (jpArrivals.length && jpAt - jpArrivals[0] > 2000) jpArrivals.shift();

  jpTrackFlicker("ps4", msg);

  if (jpWizard && jpWizard.device === "ps4") jpWizardStepInput(msg);

  /* R1 let go stops an R1 run: act on it now, not at the next tick */
  if (typeof autoRun !== "undefined" && autoRun.byR1) driveNow();
}

/* full rate while the tab shows the PS4; back to the page's usual rate
   otherwise. An open /joy row on the Advanced tab keeps its own rate. */
function jpSubscribe() {

  /* and while Hold R1 to run can start or stop the car (drive.js) */
  const fast = controllerTabVisible() && jpDevice === "ps4" ||
    typeof r1WantsJoy === "function" && r1WantsJoy();
  const want = fast && socketOpen() ? ws : null;

  if (want === jpFastOn) return;

  if (socketOpen()) {
    send({ op: "unsubscribe", topic: "/joy" });
    subscribeTopic("/joy", want ? 0 : expanded.has("/joy") ? DETAIL_THROTTLE : LIVENESS_THROTTLE);
  }

  jpFastOn = want;
}

/* ---------- the Steam Deck: this browser's Gamepad API ---------- */

/* The browser lists a controller only after one of its buttons has been
   pressed while the page is open (a privacy rule), so "none" can mean
   "not pressed yet". The Deck's controls reach a browser as a gamepad
   when Steam launches the browser with a gamepad layout (see the guide);
   on its own desktop they drive the mouse instead. */
let jpDeckPad = null;           // { id, msg } of the newest reading
let jpDeckAt = 0;
let jpBatteryHere = null;       // navigator.getBattery(), where there is one

function jpGamepad() {
  if (!navigator.getGamepads) return null;
  const pads = [...navigator.getGamepads()].filter(p => p && p.connected);
  return pads.find(p => p.mapping === "standard") || pads[0] || null;
}

/* the gamepad as a joy-like message: buttons 0 / 1, axes with left and up
   positive, the two analogue triggers (buttons 6 and 7 in the standard
   layout) as axes 4 and 5 resting at +1 */
function jpReadDeck() {

  const pad = jpGamepad();

  if (!pad) {
    jpDeckPad = null;
    return null;
  }

  const buttons = pad.buttons.map(b => (b.pressed || b.value > 0.5 ? 1 : 0));
  const axes = [
    -(pad.axes[0] || 0), -(pad.axes[1] || 0), -(pad.axes[2] || 0), -(pad.axes[3] || 0),
    1 - 2 * ((pad.buttons[6] && pad.buttons[6].value) || 0),
    1 - 2 * ((pad.buttons[7] && pad.buttons[7].value) || 0)
  ];

  /* a little stick drift is not a push */
  for (let i = 0; i < 4; i++) if (Math.abs(axes[i]) < 0.04) axes[i] = 0;

  const msg = { buttons, axes };

  jpDeckPad = { id: pad.id, msg };
  jpDeckAt = performance.now();

  jpTrackFlicker("deck", msg);

  if (jpWizard && jpWizard.device === "deck") jpWizardStepInput(msg);

  return msg;
}

/* drive.js asks every tick (its readSticks() drives a standard pad without
   L1; this is the mapped fallback, and R1): hold L1 to drive, left stick for speed, right
   stick to steer, B to stop and disarm - the car's own controller's
   layout, read through the Deck's mapping */
let jpDeckStopWas = false;

function deckDriveInput() {

  const msg = jpReadDeck();

  if (!msg) {
    jpDeckStopWas = false;
    return null;
  }

  const st = jpState("deck", msg);
  const stop = st.on.b && !jpDeckStopWas;

  jpDeckStopWas = st.on.b;

  const r1At = jpMaps.deck.buttons.r1;

  return { held: st.on.l1, x: st.rx, y: st.ly, stop, id: jpDeckPad.id,
           r1: st.on.r1, r1Flicker: r1At !== null && r1At !== undefined && jpUnsettled("deck", r1At) };
}

function jpDeckConnected() {
  return Boolean(jpDeckPad) && performance.now() - jpDeckAt < JP_FRESH_MS;
}

if (navigator.getBattery) {
  navigator.getBattery().then(battery => {
    jpBatteryHere = battery;
  }).catch(() => {});
}

/* ---------- drawing ---------- */

/* The drawing redraws ~30 times a second. Writing an unchanged value
   still makes the browser repaint (the glow and the shadow are costly),
   which starved the /joy feed itself, so only what changed is written. */
function jpSet(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function jpHTML(el, html) {
  if (el.jpHtml !== html) {
    el.jpHtml = html;
    el.innerHTML = html;
  }
}

function jpText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function jpRender() {

  if (!controllerTabVisible()) return;

  const dev = JP_DEVICES[jpDevice];
  const now = performance.now();
  const deck = jpDevice === "deck";

  if (deck) jpReadDeck();

  const live = deck ? jpDeckConnected()
    : Boolean(jpMsg) && now - jpAt < JP_FRESH_MS && socketOpen();
  const msg = live ? (deck ? jpDeckPad.msg : jpMsg) : { buttons: [], axes: [] };

  jpText($("jpTitle"), dev.title);
  /* an <svg> has no .hidden property: set the attribute itself */
  $("jpSvg").toggleAttribute("hidden", deck);
  $("jpDeckSvg").toggleAttribute("hidden", !deck);
  document.querySelectorAll("[data-jp-device]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.jpDevice === jpDevice)));

  jpSet($("jpStage"), "data-live", String(live));
  if ($("jpIdle").hidden !== live) $("jpIdle").hidden = live;

  if (!live) {
    $("jpIdleTitle").textContent = deck ? "No controller on this device yet" : "No controller input";
    $("jpIdleText").textContent = deck
      ? (!navigator.getGamepads
          ? "This browser cannot read controllers."
          : "Press any button on the Deck: browsers show a controller only after a button is pressed. On the Steam Deck, open this page in a browser launched through Steam with a gamepad layout - on the desktop the controls drive the mouse instead.")
      : "Nothing is arriving on /joy. Is the PS4 controller on and connected? The Gamepad row on the Advanced tab says what the car sees.";
  }

  const rate = jpArrivals.filter(t => now - t <= 1000).length;

  jpText($("jpStatus"), deck
    ? (live ? jpDeckPad.id.replace(/\s*\(.*$/, "") : "this browser")
    : !socketOpen() ? "not connected"
    : live ? "live from /joy" : jpMsg ? "/joy went quiet" : "waiting for /joy");
  jpText($("jpRate"), !deck && live ? `${rate} msgs/s` : "");
  jpText($("jpRawTitle"), deck ? "Raw, as the browser reads it" : "Raw /joy");

  jpRenderBattery(deck);

  const st = jpState(jpDevice, msg);

  document.querySelectorAll(`#${dev.svg} [data-ctl]`).forEach(g => {
    g.classList.toggle("on", Boolean(st.on[g.dataset.ctl]));
  });

  /* triggers fill from the bottom */
  [["l2", st.l2], ["r2", st.r2]].forEach(([which, f]) => {
    const [id, top, height] = dev.triggers[which];
    jpSet($(id), "height", (height * f).toFixed(1));
    jpSet($(id), "y", (top + height * (1 - f)).toFixed(1));
  });

  /* sticks: left and up are positive, so the knob goes the other way on
     screen's x and y */
  const travel = JP_STICK_TRAVEL[jpDevice];
  [[dev.sticks.l, st.lx, st.ly], [dev.sticks.r, st.rx, st.ry]].forEach(([[id, cx, cy], x, y]) => {
    const px = (cx - x * travel).toFixed(1);
    const py = (cy - y * travel).toFixed(1);
    [id, id + "Ring"].forEach(part => {
      jpSet($(part), "cx", px);
      jpSet($(part), "cy", py);
    });
  });

  /* the light bar: lit while the controller talks, orange while a
     deadman is held - the colour the car "sees" it in */
  jpSet($("jpStage"), "data-held", String(live && !deck && (st.on.l1 || st.on.r1)));

  jpRenderSide(st, live);
}

/* The Deck's own battery, where the browser says. (The PS4's cannot be
   read on these cars: their generic Bluetooth driver keeps it in a basic
   report with no battery byte, so there is no chip for it at all.) */
function jpRenderBattery(deck) {

  const chip = $("jpBattery");
  let text = "", tone = "";

  if (deck && jpBatteryHere) {
    const pct = Math.round(jpBatteryHere.level * 100);
    text = `${pct}%${jpBatteryHere.charging ? " ⚡" : ""}`;
    tone = pct <= 15 && !jpBatteryHere.charging ? "bad" : pct <= 30 ? "warn" : "";
  }

  chip.hidden = !text;
  chip.innerHTML = text ? icon("battery") + " " + escapeHtml(text) : "";
  chip.title = text ? "This device's battery" : "";
  chip.dataset.tone = tone;
}

function jpRenderSide(st, live) {

  const dev = JP_DEVICES[jpDevice];
  const map = jpMaps[jpDevice];
  const deck = jpDevice === "deck";

  /* what is held, in plain words */
  const held = Object.keys(dev.names).filter(name => st.on[name]);

  jpHTML($("jpHeld"), !live
    ? `<li class="jp-none">—</li>`
    : held.length
      ? held.map(name => {
          const i = map.buttons[name];
          const where = i !== null && i !== undefined && name in map.buttons ? ` <span class="jp-idx">buttons[${i}]</span>` : "";
          const role = deck
            ? (name === "l1" ? ` <span class="jp-role">hold to drive</span>` : name === "b" ? ` <span class="jp-role">stop</span>` : "")
            : JP_DEADMAN[name] ? ` <span class="jp-role">${JP_DEADMAN[name]}</span>` : "";
          return `<li>${escapeHtml(dev.names[name])}${where}${role}</li>`;
        }).join("")
      : `<li class="jp-none">Nothing pressed</li>`);

  jpRenderDeadman(st, live);

  /* sticks and triggers in words: left and up read positive */
  const dir = (v, pos, neg) => Math.abs(v) < 0.05 ? null
    : `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? pos : neg}`;
  const stick = (x, y) => [dir(x, "left", "right"), dir(y, "up", "down")]
    .filter(Boolean).join(" · ") || "centre";

  /* each stick as a little map with a dot, each trigger as a bar */
  const map2 = (name, x, y) => `
    <figure class="jp-mini">
      <svg viewBox="-50 -50 100 100" aria-hidden="true">
        <circle class="jp-mini-ring" r="44"/><circle class="jp-mini-ring" r="22"/>
        <path class="jp-mini-axis" d="M-44 0 H44 M0 -44 V44"/>
        ${live ? `<circle class="jp-mini-dot" cx="${(-x * 40).toFixed(1)}" cy="${(-y * 40).toFixed(1)}" r="7"/>` : ""}
      </svg>
      <figcaption><span>${name}</span><b>${live ? stick(x, y) : "—"}</b></figcaption>
    </figure>`;
  const bar = (name, f) => `
    <div class="jp-bar"><span>${name}</span>
      <i><b style="width:${live ? Math.round(f * 100) : 0}%"></b></i>
      <em>${live ? Math.round(f * 100) + "%" : "—"}</em></div>`;

  jpHTML($("jpAxes"),
    `<div class="jp-minis">${map2("Left stick", st.lx, st.ly)}${map2("Right stick", st.rx, st.ry)}</div>` +
    bar("L2", st.l2) + bar("R2", st.r2));

  /* a button switching on and off by itself: say so, plainly */
  const flicker = live ? jpFlickerList(jpDevice) : [];
  const flickerNames = flicker.map(i => {
    const name = jpControlFor(jpDevice, i);
    return `buttons[${i}]` + (name ? ` (${dev.names[name]})` : "");
  });
  const carSees = !deck && flicker.some(i => i === JOY_L1 || i === JOY_R1);

  $("jpFlicker").hidden = !flicker.length;
  jpHTML($("jpFlicker"), flicker.length
    ? `<strong>${escapeHtml(flickerNames.join(" and "))} ${flicker.length > 1 ? "are" : "is"} switching on and off by itself.</strong> ` +
      "If nobody is tapping it, the controller or its connection is glitching. " +
      (deck ? "Map buttons ignores it. "
        : "This is what the car hears too, so it is not just the drawing. ") +
      (carSees ? "<strong>L1 and R1 are the car's deadman buttons</strong>: do not drive with this controller until it stops (try re-pairing it, or another controller). " : "") +
      "Click it on the drawing and choose Ignore to stop it lighting here."
    : "");

  /* the raw arrays, a chip per index, lit when not at rest; a flickering
     button striped */
  const chips = (values, rest, flick = []) => values.length
    ? values.map((v, i) => {
        const n = Number(v);
        const text = Number.isInteger(n) ? n : n.toFixed(2);
        return `<span class="jp-chip${rest(n, i) ? " on" : ""}${flick.includes(i) ? " flicker" : ""}"><i>${i}</i>${text}</span>`;
      }).join("")
    : "—";

  const triggerAxes = [map.axes.l2, map.axes.r2].filter(Boolean).map(a => a.i);

  jpHTML($("jpRawButtons"), live ? chips(st.buttons, n => n === 1, flicker) : "—");
  jpHTML($("jpRawAxes"), live
    ? chips(st.axes, (n, i) => triggerAxes.includes(i)
        ? n < 0.9 && n !== 0 : Math.abs(n) > 0.1)
    : "—");

  /* the mapping, and a nudge when the numbering looks wrong */
  const oddTriggers = !deck && live && performance.now() - jpLiveSince > 4000
    ? ["l2", "r2"].filter(t => map.axes[t] && !jpTriggerRest.ps4[map.axes[t].i])
    : [];

  const justDone = performance.now() < jpMapNoteUntil ? jpMapNoteOnce : "";

  jpText($("jpMapNote"), justDone || (oddTriggers.length
    ? `${oddTriggers.map(t => t.toUpperCase()).join(" and ")} ${oddTriggers.length > 1 ? "do" : "does"} not read like a trigger here, so this controller probably numbers its buttons differently. Use Map buttons.`
    : jpCustom[jpDevice]
      ? "Using your mapping, saved in this browser."
      : deck
        ? "Using the browser's standard layout. If the wrong button lights up, use Map buttons."
        : "Using the cars' PS4 mapping. If the wrong button lights up, use Map buttons."));
  $("jpMapNote").classList.toggle("warn", !justDone && oddTriggers.length > 0);
  $("jpMapNote").classList.toggle("done", Boolean(justDone));
  $("jpMapReset").hidden = !jpCustom[jpDevice] || Boolean(jpWizard);
  $("jpMapBtn").hidden = Boolean(jpWizard);
  $("jpOneRow").hidden = Boolean(jpWizard);
  jpFillOnePicker();
}

function jpRenderDeadman(st, live) {

  const box = $("jpDeadman");
  const map = jpMaps[jpDevice];

  if (jpDevice === "deck") {
    const armed = typeof driveArmed !== "undefined" && driveArmed;
    jpSet(box, "class", "jp-deadman" + (live && st.on.l1 ? " held" : ""));
    jpHTML(box, !live
      ? "Driving from this device: connect the controller first."
      : `<strong>Driving from here</strong>: arm on the Drive tab, then hold <strong>L1</strong> to drive, ` +
        `left stick for speed, right stick to steer. <strong>B</strong> stops and disarms. ` +
        (st.on.l1 ? (armed ? "<strong>L1 held: driving.</strong>" : "L1 held, but the car is not armed.") : ""));
    return;
  }

  const l1 = st.on.l1, r1 = st.on.r1;
  const misplaced = ["l1", "r1"].filter(name => map.buttons[name] !== { l1: JOY_L1, r1: JOY_R1 }[name]);

  jpSet(box, "class", "jp-deadman" + (live && (l1 || r1) ? " held" : "") + (misplaced.length ? " wrong" : ""));
  jpHTML(box, misplaced.length
    ? `<strong>Deadman mismatch.</strong> On this mapping ${misplaced.map(n => n.toUpperCase() + (map.buttons[n] === null || map.buttons[n] === undefined ? " is ignored" : " is buttons[" + map.buttons[n] + "]")).join(" and ")}, but the car's joy_teleop.yaml expects L1 at buttons[${JOY_L1}] and R1 at buttons[${JOY_R1}]. Holding them would not drive or hand over the car.`
    : !live ? "Deadman: no controller input."
    : l1 ? "<strong>L1 held</strong>: manual driving is allowed."
    : r1 ? "<strong>R1 held</strong>: the car is handed to autonomous code."
    : "Deadman: neither held. Hold <strong>L1</strong> to drive by hand, <strong>R1</strong> to hand over to autonomous code.");
}

/* ---------- Map buttons: press what it asks for ---------- */

/* Two ways: all of a controller, one control after another (Map buttons),
   or just one (click it on the drawing, or Remap one) when only that one
   is wrong - the rest of the mapping is kept.

   A step finds the one button or axis that changed from where it was when
   the step began, and takes it only once it has stayed that way for
   JP_HOLD_MS: a button that flickers on and off by itself (seen on R1)
   would otherwise be taken as the answer the instant it blinked. Before
   the next step it waits for exactly that control to come back (its
   button up, its axis back where it started) - not for some guess at "at
   rest": a stick pushed fully left reads +1, which is also where a trigger
   rests. One long press is never taken twice. */
const JP_HOLD_MS = 150;

let jpWizard = null;   // { device, steps, step, map, base, release, single, candidate }

function jpLive(device) {
  return device === "deck" ? jpDeckConnected() : jpMsg && performance.now() - jpAt <= JP_FRESH_MS;
}

/* the steps that map one control (a stick is two: across, then up) */
function jpStepsFor(device, name) {
  const steps = JP_DEVICES[device].steps;
  if (name === "lstick") return steps.filter(s => ["lx", "ly"].includes(s[1]));
  if (name === "rstick") return steps.filter(s => ["rx", "ry"].includes(s[1]));
  return steps.filter(s => s[1] === name);
}

function jpStartWizard(single = null) {

  const device = jpDevice;
  const deck = device === "deck";

  if (!jpLive(device)) {
    jpText($("jpMapNote"), deck
      ? "Press a button on the Deck first, so the browser shows it."
      : "Connect the controller first: nothing is arriving on /joy.");
    return;
  }

  const steps = single ? jpStepsFor(device, single) : JP_DEVICES[device].steps;
  if (!steps.length) return;

  const base = single ? jpMaps[device] : JP_DEVICES[device].map;

  jpWizard = {
    device,
    steps,
    single,
    step: 0,
    map: single
      ? JSON.parse(JSON.stringify(jpMaps[device]))
      : { buttons: { ...base.buttons }, axes: {}, dpad: { kind: "axes" } },
    base: null,
    release: { kind: "start" },      // first, just no button held
    candidate: null,
    moved: []                        // what a single remap took from another control
  };

  $("jpWizard").hidden = false;
  jpWizardShow();
  jpRender();
}

function jpWizardShow() {

  const w = jpWizard;
  const dev = JP_DEVICES[w.device];
  const [kind, name, prompt] = w.steps[w.step];
  const what = prompt || (kind === "trigger" ? `Squeeze ${dev.names[name]} all the way`
    : `Press ${dev.names[name]}`);
  const count = w.steps.length > 1 ? `${w.step + 1} of ${w.steps.length}: ` : "";

  $("jpWizardStep").textContent = (w.single ? "Remap: " : "") + count + what;
  /* the button being asked for is the one flickering: it cannot be
     mapped until it stops (or the press would be the glitch) */
  const askedFlicker = kind === "button" &&
    jpFlickerList(w.device).find(i => i === JP_DEVICES[w.device].map.buttons[name]);

  $("jpWizardHint").textContent = w.release
    ? "Let go first…"
    : askedFlicker !== undefined
      ? `buttons[${askedFlicker}] is switching on and off by itself, so it is not taken. Wait until it stops (a couple of seconds), then press and hold, or Skip.`
    : w.candidate
      ? "Hold it…"
      : ["touchpad", "quick", "l4", "l5", "r4", "r5"].includes(name)
        ? "Press it, or Skip if this one does not reach the page."
        : "Waiting for it…";
  $("jpWizardIgnore").hidden = !w.single;
  $("jpWizardSkip").hidden = Boolean(w.single);

  /* light up the one being asked for */
  const ctl = kind === "stick" ? { lx: "l3", ly: "l3", rx: "r3", ry: "r3" }[name] : name;
  document.querySelectorAll(`#${dev.svg} [data-ctl]`).forEach(g =>
    g.classList.toggle("ask", g.dataset.ctl === ctl));
}

/* the control the last step found is back where it was */
function jpReleased(release, msg) {

  const buttons = msg.buttons || [];
  const axes = msg.axes || [];
  const held = buttons.some((b, i) => b === 1 && !jpFlickering(jpWizard.device, i));

  if (held && release.kind !== "axis") return false;
  if (release.kind === "button") return buttons[release.i] !== 1;
  if (release.kind === "axis") {
    return Math.abs((axes[release.i] || 0) - release.from) < 0.3 && !held;
  }
  return true;                      // "start": no (steady) button held
}

/* which button or axis this step's press is, if any: [kind, index, delta] */
function jpWizardCandidate(w, msg) {

  const [kind] = w.steps[w.step];
  const buttons = msg.buttons || [];
  const axes = msg.axes || [];

  /* a flickering button is never an answer */
  const newButton = buttons.findIndex((b, i) =>
    b === 1 && w.base.buttons[i] !== 1 && !jpFlickering(w.device, i));

  let axis = -1, delta = 0;
  axes.forEach((v, i) => {
    const d = v - (w.base.axes[i] || 0);
    if (Math.abs(d) > JP_PRESS && Math.abs(d) > Math.abs(delta)) { axis = i; delta = d; }
  });

  if (kind === "button") return newButton >= 0 ? ["button", newButton, 0] : null;
  if (kind === "stick") return axis >= 0 ? ["axis", axis, delta] : null;
  if (axis >= 0) return ["axis", axis, delta, newButton];        // trigger, D-pad
  if (newButton >= 0) return ["button", newButton, 0];
  return null;
}

function jpWizardStepInput(msg) {

  const w = jpWizard;

  if (w.release) {
    if (!jpReleased(w.release, msg)) return;
    w.release = null;
    w.candidate = null;
    w.base = { buttons: [...(msg.buttons || [])], axes: [...(msg.axes || [])] };
    jpWizardShow();
    return;
  }

  const found = jpWizardCandidate(w, msg);
  const now = performance.now();

  /* the same press, held: take it once it has lasted JP_HOLD_MS */
  if (!found) {
    if (w.candidate) { w.candidate = null; jpWizardShow(); }
    return;
  }
  if (!w.candidate || w.candidate.kind !== found[0] || w.candidate.i !== found[1]) {
    w.candidate = { kind: found[0], i: found[1], since: now };
    jpWizardShow();
    return;
  }
  if (now - w.candidate.since < JP_HOLD_MS) return;

  jpWizardTake(w, found);
}

function jpWizardTake(w, [kind, i, delta, alsoButton]) {

  const [stepKind, name] = w.steps[w.step];
  const map = w.map;

  /* a single remap that takes a button another control had: that one
     loses it (two controls on one button would both light) */
  const claimButton = (control, index) => {
    if (w.single) {
      Object.keys(map.buttons).forEach(other => {
        if (other !== control && map.buttons[other] === index) {
          map.buttons[other] = null;
          w.moved.push(other);
        }
      });
    }
    map.buttons[control] = index;
  };

  if (stepKind === "button") {
    claimButton(name, i);
  } else if (stepKind === "trigger") {
    if (kind === "axis") {
      /* squeezing moves its axis down (rest +1, in -1); keep the button
         it usually presses with it too */
      map.axes[name] = { i, s: delta < 0 ? 1 : -1 };
      if (alsoButton >= 0) claimButton(name, alsoButton);
    } else {
      claimButton(name, i);              // a trigger that is only a button
      map.axes[name] = null;
    }
  } else if (stepKind === "stick") {
    map.axes[name] = { i, s: delta > 0 ? 1 : -1 };     // asked for left / up
  } else if (stepKind === "dpad") {
    if (kind === "button") {
      map.dpad = map.dpad.kind === "buttons" ? { ...map.dpad, [name]: i }
        : { kind: "buttons", up: null, down: null, left: null, right: null, [name]: i };
    } else {
      /* on axes: up and left read positive; down and right are the same
         axes the other way */
      if (map.dpad.kind !== "axes") map.dpad = { kind: "axes", x: null, y: null };
      const s = delta > 0 ? 1 : -1;
      if (name === "up") map.dpad.y = { i, s };
      if (name === "down") map.dpad.y = { i, s: -s };
      if (name === "left") map.dpad.x = { i, s };
      if (name === "right") map.dpad.x = { i, s: -s };
    }
  }

  jpWizardNext(kind === "axis" ? { kind: "axis", i, from: w.base.axes[i] || 0 } : { kind: "button", i });
}

function jpWizardNext(release = { kind: "start" }) {

  const w = jpWizard;

  w.step++;
  w.candidate = null;

  /* a D-pad on axes needs only up and left in a full mapping: down and
     right are the same axes the other way */
  while (!w.single && w.step < w.steps.length && w.steps[w.step][0] === "dpad" &&
         w.map.dpad.kind === "axes" && ["down", "right"].includes(w.steps[w.step][1])) {
    w.step++;
  }

  if (w.step >= w.steps.length) {
    jpFinishWizard(true);
    return;
  }

  w.release = release;
  jpWizardShow();
}

/* Ignore (one control only): it lights for nothing, and nothing reads it */
function jpWizardIgnore() {

  const w = jpWizard;
  if (!w || !w.single) return;

  w.steps.forEach(([kind, name]) => {
    if (kind === "stick") w.map.axes[name] = null;
    else if (kind === "dpad") {
      if (w.map.dpad.kind === "buttons") w.map.dpad[name] = null;
      else if (name === "up" || name === "down") w.map.dpad.y = null;
      else w.map.dpad.x = null;
    } else {
      w.map.buttons[name] = null;
      if (kind === "trigger") w.map.axes[name] = null;
    }
  });

  w.ignored = true;
  jpFinishWizard(true);
}

function jpFinishWizard(save) {

  const w = jpWizard;
  const dev = w ? JP_DEVICES[w.device] : null;

  jpWizard = null;
  $("jpWizard").hidden = true;
  document.querySelectorAll(".jp-svg .ask").forEach(g => g.classList.remove("ask"));

  if (!save || !w) {
    jpRender();
    return;
  }

  const map = w.map;

  if (!w.single) {
    /* anything skipped keeps its default */
    const base = dev.map;
    map.axes = { ...base.axes, ...Object.fromEntries(Object.entries(map.axes).filter(([, a]) => a !== undefined)) };
    if (map.dpad.kind === "axes") {
      map.dpad = { kind: "axes", x: map.dpad.x || base.dpad.x || { i: 6, s: 1 }, y: map.dpad.y || base.dpad.y || { i: 7, s: 1 } };
    }
  }

  jpSaveMap(map, w.device);

  if (w.single) {
    const label = { lstick: "Left stick", rstick: "Right stick" }[w.single] || dev.names[w.single];
    jpMapNoteOnce = w.ignored
      ? `${label} is now ignored. Remap it to bring it back.`
      : `${label} remapped.` + (w.moved.length
        ? ` ${w.moved.map(n => dev.names[n]).join(" and ")} had that button, so ${w.moved.length > 1 ? "they are" : "it is"} unassigned now: remap ${w.moved.length > 1 ? "them" : "it"} if needed.`
        : "");
    jpMapNoteUntil = performance.now() + 8000;
  }
}

/* a remap's result, shown in the mapping note for a few seconds */
let jpMapNoteOnce = "";
let jpMapNoteUntil = 0;

/* ---------- a button that switches on and off by itself ----------

   Counted from every message: how often each button changed in the last
   JP_FLICKER_WINDOW_MS. A thumb tapping as fast as it can manages a
   handful of presses a second; a glitching button or driver goes much
   faster, and goes on while nobody touches it. The tab says which, the raw
   readout marks it, and Map buttons never takes it as an answer. */
const JP_FLICKER_WINDOW_MS = 2000;
const JP_FLICKER_CHANGES = 12;       // changes in the window: 3 taps a second, held up

const jpFlips = { ps4: {}, deck: {} };       // index -> [times it changed]
const jpLastButtons = { ps4: [], deck: [] };

function jpTrackFlicker(device, msg) {

  const now = performance.now();
  const buttons = msg.buttons || [];
  const last = jpLastButtons[device];

  buttons.forEach((b, i) => {
    if (last[i] !== undefined && last[i] !== b) {
      (jpFlips[device][i] = jpFlips[device][i] || []).push(now);
    }
  });

  Object.values(jpFlips[device]).forEach(list => {
    while (list.length && now - list[0] > JP_FLICKER_WINDOW_MS) list.shift();
  });

  jpLastButtons[device] = [...buttons];
}

function jpFlickering(device, i) {
  const list = jpFlips[device][i];
  return Boolean(list) && list.length >= JP_FLICKER_CHANGES &&
    performance.now() - list[list.length - 1] < 500;
}

/* Stricter, for a button that can start the car (drive.js, Hold R1 to
   run): changed this often in the last window at all, even if it has just
   gone still - a flicker that pauses is still not a hold. */
const JP_UNSETTLED_CHANGES = 6;

function jpUnsettled(device, i) {
  const list = jpFlips[device][i] || [];
  const since = performance.now() - JP_FLICKER_WINDOW_MS;
  return list.filter(t => t >= since).length >= JP_UNSETTLED_CHANGES;
}

function jpFlickerList(device) {
  return Object.keys(jpFlips[device]).map(Number).filter(i => jpFlickering(device, i));
}

/* the control a button index is mapped to, for saying "buttons[5] (R1)" */
function jpControlFor(device, i) {
  const map = jpMaps[device];
  return Object.keys(map.buttons).find(name => map.buttons[name] === i) || null;
}

/* ---------- wiring ---------- */

function setControllerDevice(device) {

  if (!JP_DEVICES[device] || device === jpDevice) return;
  if (jpWizard) jpFinishWizard(false);

  jpDevice = device;
  try {
    localStorage.setItem(JP_DEVICE_KEY, device);
  } catch (error) {}

  jpSubscribe();
  jpRender();
}

document.querySelectorAll("[data-jp-device]").forEach(button => {
  button.onclick = () => setControllerDevice(button.dataset.jpDevice);
});

$("jpMapBtn").onclick = () => jpStartWizard();
$("jpWizardIgnore").onclick = jpWizardIgnore;
$("jpOneBtn").onclick = () => { if ($("jpOneSelect").value) jpStartWizard($("jpOneSelect").value); };

/* click a control on the drawing to remap just that one */
document.querySelectorAll(".jp-svg").forEach(svg => {
  svg.addEventListener("click", event => {
    const g = event.target.closest("[data-ctl]");
    if (!g || jpWizard) return;
    const name = { l3: "l3", r3: "r3" }[g.dataset.ctl] || g.dataset.ctl;
    if (jpStepsFor(jpDevice, name).length) jpStartWizard(name);
  });
});

/* the picker: every control of the controller showing, sticks as one each */
function jpFillOnePicker() {
  const dev = JP_DEVICES[jpDevice];
  const options = [["", "Pick one…"],
    ...Object.keys(dev.names).filter(n => jpStepsFor(jpDevice, n).length).map(n => [n, dev.names[n]]),
    ["lstick", "Left stick (move)"], ["rstick", "Right stick (move)"]];
  const html = options.map(([v, t]) => `<option value="${v}">${escapeHtml(t)}</option>`).join("");
  if ($("jpOneSelect").jpHtml !== html) { $("jpOneSelect").jpHtml = html; $("jpOneSelect").innerHTML = html; }
}
$("jpMapReset").onclick = () => jpSaveMap(JP_DEVICES[jpDevice].map);
$("jpWizardSkip").onclick = () => { if (jpWizard) jpWizardNext(); };
$("jpWizardCancel").onclick = () => jpFinishWizard(false);

/* the drawing at ~30 fps while the tab shows; the subscription follows
   the tab and the connection every half second */
(function jpLoop() {
  requestAnimationFrame(jpLoop);
  if (controllerTabVisible() && !document.hidden) {
    const now = performance.now();
    if (now - (jpLoop.at || 0) >= 33) { jpLoop.at = now; jpRender(); }
  }
})();

setInterval(jpSubscribe, 500);
