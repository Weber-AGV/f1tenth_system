"use strict";

/* Steam Deck navigation: scroll and switch tabs without a mouse. */

/* ==========================================================
   STEAM DECK NAVIGATION

   Only when the page was opened with ?deck=1 (open_dashboard.sh;
   isDeck is set in main.js). In Gaming Mode there is no mouse, and
   the page's scroll bar is a poor target for a thumb, so:

     swipe up / down   scrolls the page, like a phone
     D-pad up / down   scrolls
     left stick        scrolls, while the car is NOT armed (armed, it
                       is the speed stick - see drive.js)
     L1 / R1           previous / next tab, while the car is NOT armed
                       (a bumper bumped mid-drive must not leave the
                       Drive tab, which disarms)

   The gamepad needs the same secure-context allowance as the drive
   sticks (docs/guides/steam-deck-setup.md), and a standard-mapped pad.
========================================================== */

/* Overview, Drive, Controller, Advanced: the order of the tab bar */
const NAV_TABS = ["overview", "drive", "controller", "advanced"];

const NAV_DEADZONE = 0.25;
const NAV_STICK_SPEED = 1400;   // px per second at full stick
const NAV_DPAD_SPEED = 700;     // px per second while held

/* standard gamepad mapping */
const NAV_BTN_L1 = 4;
const NAV_BTN_R1 = 5;
const NAV_BTN_UP = 12;
const NAV_BTN_DOWN = 13;
const NAV_AXIS_STICK_Y = 1;

/* A finger that moves less than this is still a tap */
const SWIPE_START_PX = 10;

/* Things that use touch themselves: a drag on them is not a scroll */
const SWIPE_SKIP =
  "input, select, textarea, button, a, canvas, summary, " +
  "#drivePad, #cockpitPad, #stickSteer, #stickThrottle, [data-no-swipe]";

/* in the driving view only these scroll by dragging: the panes, sticks
   and pad have drags of their own */
const COCKPIT_SWIPE = ".cockpit-panel, .cockpit-settings";

function swipeSkips(target) {
  return target.closest(SWIPE_SKIP) ||
    (target.closest(".cockpit") && !target.closest(COCKPIT_SWIPE));
}

/* ---------- swipe to scroll ---------- */

let swipe = null;
let swallowClick = false;

/* the nearest thing that scrolls itself, else the page */
function scrollParent(node) {

  for (let el = node; el && el !== document.body; el = el.parentElement) {

    const overflow = getComputedStyle(el).overflowY;

    if ((overflow === "auto" || overflow === "scroll") &&
        el.scrollHeight > el.clientHeight + 1) {
      return el;
    }
  }

  return document.scrollingElement;
}

function swipeEnd() {

  if (swipe && swipe.scrolling) {

    /* the finger lifting after a drag is not a tap on whatever is under it */
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 50);
  }

  swipe = null;
}

/* ---------- gamepad: scroll and tabs ---------- */

let navLast = performance.now();
let navL1 = false;
let navR1 = false;

/* after disarming, a stick still held over would scroll the page at
   once; wait until it has been centred */
let navStickLocked = false;

function navPad() {

  return navigator.getGamepads &&
    [...navigator.getGamepads()].find(p =>
      p && p.connected && p.mapping === "standard");
}

function navPressed(pad, index) {
  return Boolean(pad.buttons[index] && pad.buttons[index].pressed);
}

function navArmed() {
  return typeof driveArmed !== "undefined" && driveArmed;
}

function navCockpitFull() {
  return Boolean(document.querySelector(".cockpit.full:not([hidden])"));
}

function navStepTab(direction) {

  const selected = document.querySelector('[role="tab"][aria-selected="true"]');
  const current = NAV_TABS.indexOf(selected && selected.dataset.tab);
  const next = (current + direction + NAV_TABS.length) % NAV_TABS.length;

  showTab(NAV_TABS[next]);
  window.scrollTo(0, 0);
}

function navTick(now) {

  requestAnimationFrame(navTick);

  const dt = Math.min(0.1, (now - navLast) / 1000);

  navLast = now;

  const pad = navPad();

  if (!pad) {
    navL1 = false;
    navR1 = false;
    return;
  }

  const armed = navArmed();
  const stick = pad.axes[NAV_AXIS_STICK_Y] || 0;

  if (armed) navStickLocked = true;
  else if (Math.abs(stick) < NAV_DEADZONE) navStickLocked = false;

  let delta = 0;

  delta +=
    ((navPressed(pad, NAV_BTN_DOWN) ? 1 : 0) -
     (navPressed(pad, NAV_BTN_UP) ? 1 : 0)) * NAV_DPAD_SPEED * dt;

  if (!armed && !navStickLocked && Math.abs(stick) >= NAV_DEADZONE) {

    delta += Math.sign(stick) *
      (Math.abs(stick) - NAV_DEADZONE) / (1 - NAV_DEADZONE) *
      NAV_STICK_SPEED * dt;
  }

  if (delta) window.scrollBy(0, delta);

  /* a press, not a hold; tracked while armed too, so a bumper already
     down when the car disarms does not count as a press */
  const l1 = navPressed(pad, NAV_BTN_L1);
  const r1 = navPressed(pad, NAV_BTN_R1);

  if (!armed && !navCockpitFull()) {
    if (r1 && !navR1) navStepTab(1);
    if (l1 && !navL1) navStepTab(-1);
  }

  navL1 = l1;
  navR1 = r1;
}

/* ---------- start ---------- */

function startDeckNavigation() {

  /* a drag scrolls, so it must not also select text */
  document.documentElement.classList.add("deck");

  window.addEventListener("pointerdown", event => {

    if (event.button > 0 || !(event.target instanceof Element) ||
        swipeSkips(event.target)) {
      return;
    }

    swipe = {
      id: event.pointerId,
      y: event.clientY,
      scroller: scrollParent(event.target),
      scrolling: false
    };
  }, true);

  window.addEventListener("pointermove", event => {

    if (!swipe || event.pointerId !== swipe.id) return;

    const delta = swipe.y - event.clientY;

    if (!swipe.scrolling && Math.abs(delta) < SWIPE_START_PX) return;

    swipe.scrolling = true;
    swipe.y = event.clientY;
    swipe.scroller.scrollBy(0, delta);
  }, true);

  /* if the browser scrolls natively it sends pointercancel and this
     handler stands down, so the two never both scroll */
  ["pointerup", "pointercancel"].forEach(type =>
    window.addEventListener(type, swipeEnd, true));

  window.addEventListener("click", event => {

    if (swallowClick) {
      event.stopPropagation();
      event.preventDefault();
      swallowClick = false;
    }
  }, true);

  /* press and hold on a touch screen opens the browser's menu, and a
     drag picks up the camera picture: neither belongs in a controller
     screen. Text boxes keep their menu (paste an address). */
  const keepNative = target =>
    target instanceof Element && target.closest("input, textarea, select");

  window.addEventListener("contextmenu", event => {
    if (!keepNative(event.target)) event.preventDefault();
  }, true);

  window.addEventListener("dragstart", event => {
    if (!keepNative(event.target)) event.preventDefault();
  }, true);

  /* the Deck's trackpad is a mouse, and a mouse drag selects text even
     with user-select: none in Firefox; stop it at the source */
  document.addEventListener("selectstart", event => {
    if (!keepNative(event.target)) event.preventDefault();
  }, true);

  requestAnimationFrame(navTick);
}

if (isDeck) startDeckNavigation();
