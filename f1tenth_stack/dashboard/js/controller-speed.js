/* ---------- controller top speed: the PS4 on the car ----------
   How fast full stick drives. The robot keeps joy_teleop's speed scale on a
   saved value (system_diagnostics' controller_max_speed, saved on the car so
   it survives restarts) and reports it as "system: Controller speed"; this
   sets it. On the Drive tab it is always in view: - and + in the top bar (or
   a button in the side rail) with the slider in a popup. The footer's chip
   opens the same popup from the other tabs, and the full control is on the
   Controller tab and in the phone Limits drawer. A change takes effect on
   the controller at once. */

const CSPEED_FAST = 3;          // m/s: the on-screen controls' limit before unlocking
const CSPEED_STEP = 0.1;        // m/s, the slider's step and the - and + buttons'
const CSPEED_SETTLE_MS = 300;   // arrow keys and +/- taps send one change, not many

let cspeedPending = null;       // { value, until } while a change is on its way
let cspeedOpener = null;        // the chip the popup was opened from
let cspeedDraft = null;         // value being stepped with - and +, not sent yet
let cspeedDraftTimer = null;

function cspeedDiag() {
  const item = diag[SYS_PREFIX + "Controller speed"];
  if (!item || !item.values) return null;
  const v = item.values;
  const range = /([\d.]+) to ([\d.]+)/.exec(v["range m/s"] || "");
  return {
    max: v["max m/s"] === "unknown" ? null : parseFloat(v["max m/s"]),
    live: v.live === "yes",
    lo: range ? parseFloat(range[1]) : 0.2,
    hi: range ? parseFloat(range[2]) : 5.0
  };
}

async function setControllerSpeed(value) {

  cspeedPending = { value, until: performance.now() + 4000 };
  renderControllerSpeed();

  try {
    const result = await call(SYSDIAG_PARAMS_SERVICE, { parameters: [
      { name: "controller_max_speed", value: { type: 3, double_value: value } }
    ] });
    const bad = (result.results || []).find(r => !r.successful);
    if (bad) {
      cspeedPending = null;
      toast("The car refused: " + (bad.reason || "no reason given") + ".", "warn");
    } else {
      toast(`PS4 controller top speed: ${cspeedText(value)}.`, "ok");
    }
  } catch (error) {
    cspeedPending = null;
    toast("Could not set the controller speed (" + error.message + ").", "bad");
  }
  renderControllerSpeed();
}

function cspeedText(value) {
  return speedText(value, 1);
}

function cspeedSetText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/* what the note under the slider says, and how it is coloured */
function cspeedNote(s, shown) {
  if (!socketOpen()) return ["Not connected to the car.", "warn"];
  if (!s) return ["Needs the new system_diagnostics.py on the car.", "warn"];
  if (!s.live) return ["This car's joy_teleop needs the teleop_tools update before this can change.", "warn"];
  if (s.max === null) return ["joy_teleop is not answering. Is bringup running?", "warn"];
  if (cspeedPending || cspeedDraft !== null) return ["Saving to the car\u2026", ""];
  if (shown > CSPEED_FAST) return ["High speed at full stick. Keep the area clear.", "warn"];
  return ["The speed at full stick. Applies right away and stays saved on the car.", ""];
}

function cspeedShownValue(s) {
  return cspeedPending ? cspeedPending.value : s ? s.max : null;
}

/* - and +, wherever they are: several quick taps send one change */
function cspeedNudge(direction) {
  const s = cspeedDiag();
  const base = cspeedDraft !== null ? cspeedDraft : cspeedShownValue(s);
  if (!s || base === null) return;
  const next = Math.round((base + direction * CSPEED_STEP) * 10) / 10;
  cspeedDraft = Math.min(s.hi, Math.max(s.lo, next));
  clearTimeout(cspeedDraftTimer);
  cspeedDraftTimer = setTimeout(() => {
    const value = cspeedDraft;
    cspeedDraft = null;
    setControllerSpeed(value);
  }, CSPEED_SETTLE_MS);
  renderControllerSpeed();
}

function renderControllerSpeed() {

  const s = cspeedDiag();

  if (cspeedPending && (performance.now() > cspeedPending.until ||
      (s && s.max !== null && Math.abs(s.max - cspeedPending.value) < 0.005))) {
    cspeedPending = null;
  }

  const shown = cspeedDraft !== null ? cspeedDraft : cspeedShownValue(s);
  const text = shown === null ? "--" : cspeedText(shown);
  const [note, tone] = cspeedNote(s, shown);
  const usable = Boolean(s && s.live && s.max !== null && socketOpen());
  const lo = s ? s.lo : 0.2;
  const hi = s ? s.hi : 5.0;

  /* the Drive tab has its own, so the footer's chip is for the other tabs */
  $("cspeedChip").hidden = !s || cockpitOpen;
  document.querySelectorAll("[data-cspeed-chip]").forEach(chip =>
    cspeedSetText(chip.querySelector("[data-cspeed-value]"), text));
  if (cspeedOpener && !cspeedOpener.offsetParent) closeControllerSpeed();

  document.querySelectorAll("[data-cspeed-step]").forEach(b => b.disabled = !usable);
  document.querySelectorAll("[data-cspeed-bar]").forEach(bar =>
    bar.dataset.fast = String(shown !== null && shown > CSPEED_FAST));

  document.querySelectorAll("[data-cspeed]").forEach(box => {
    const range = box.querySelector("input");
    range.min = lo;
    range.max = hi;
    range.disabled = !usable;
    cspeedSetText(box.querySelector("[data-cspeed-lo]"), speedNumber(lo, 1));
    cspeedSetText(box.querySelector("[data-cspeed-hi]"), cspeedText(hi));
    if (!box.dataset.dragging) {
      if (shown !== null) range.value = shown;
      cspeedSetText(box.querySelector("[data-cspeed-shown]"), text);
      range.setAttribute("aria-valuetext", shown === null ? "unknown" : speedSpoken(shown));
    }
    cspeedSetText(box.querySelector(".cspeed-note"), note);
    box.querySelector(".cspeed-note").dataset.tone = tone;
    box.dataset.fast = String(shown !== null && shown > CSPEED_FAST);
  });
}

/* one control, built the same wherever it shows */
document.querySelectorAll("[data-cspeed]").forEach(box => {

  box.innerHTML = `
    <div class="cspeed-head">
      <span class="cspeed-title">PS4 controller top speed</span>
      <strong class="cspeed-value" data-cspeed-shown>--</strong>
    </div>
    <div class="cspeed-row">
      <button class="cspeed-step" type="button" data-cspeed-step="-1"
              aria-label="Lower the PS4 controller's top speed">&minus;</button>
      <input type="range" step="${CSPEED_STEP}" min="0.2" max="5" aria-label="PS4 controller top speed">
      <button class="cspeed-step" type="button" data-cspeed-step="1"
              aria-label="Raise the PS4 controller's top speed">+</button>
    </div>
    <div class="cspeed-scale" aria-hidden="true">
      <span data-cspeed-lo>0.2</span><span data-cspeed-hi>5.0 m/s</span>
    </div>
    <p class="cspeed-note" role="status"></p>`;

  const range = box.querySelector("input");
  let settle = null;

  const show = () => {
    const value = parseFloat(range.value);
    box.querySelector("[data-cspeed-shown]").textContent = cspeedText(value);
    range.setAttribute("aria-valuetext", speedSpoken(value));
  };

  const commitSoon = () => {
    box.dataset.dragging = "1";
    clearTimeout(settle);
    settle = setTimeout(() => {
      delete box.dataset.dragging;
      setControllerSpeed(parseFloat(range.value));
    }, CSPEED_SETTLE_MS);
  };

  range.addEventListener("input", () => {
    clearTimeout(settle);       // not while the thumb is still moving
    box.dataset.dragging = "1";
    show();
  });
  range.addEventListener("change", commitSoon);

  /* let go of the slider and WASD drives again (keyboard users keep focus) */
  range.addEventListener("pointerup", () => range.blur());
});

document.querySelectorAll("[data-cspeed-step]").forEach(button => {
  button.addEventListener("click", () => cspeedNudge(Number(button.dataset.cspeedStep)));
});

function closeControllerSpeed() {
  $("cspeedPop").hidden = true;
  if (cspeedOpener) cspeedOpener.setAttribute("aria-expanded", "false");
  cspeedOpener = null;
}

/* beside the chip: below it if it fits, else above. Full screen shows only
   the full-screen element, so the popup moves into it while there. */
function openControllerSpeed(chip) {
  const pop = $("cspeedPop");
  const full = document.fullscreenElement;
  const host = full && full.contains(chip) ? full : document.body;
  if (pop.parentElement !== host) host.appendChild(pop);
  pop.hidden = false;
  cspeedOpener = chip;
  chip.setAttribute("aria-expanded", "true");
  const r = chip.getBoundingClientRect();
  const w = pop.offsetWidth;
  if (chip.closest(".cockpit-rail")) {     // beside the rail, not over it
    const rail = chip.closest(".cockpit-rail").getBoundingClientRect();
    pop.style.left = (rail.left < innerWidth / 2 ? rail.right + 8 : rail.left - w - 8) + "px";
    pop.style.bottom = "";
    pop.style.top = Math.min(r.top, innerHeight - pop.offsetHeight - 8) + "px";
    return;
  }
  pop.style.left = Math.max(16, Math.min(r.right - w, innerWidth - w - 16)) + "px";
  if (r.bottom + 8 + pop.offsetHeight <= innerHeight - 8) {
    pop.style.bottom = "";
    pop.style.top = (r.bottom + 8) + "px";
  } else {
    pop.style.top = "";
    pop.style.bottom = (innerHeight - r.top + 8) + "px";
  }
}

document.querySelectorAll("[data-cspeed-chip]").forEach(chip => {
  chip.addEventListener("click", () => {
    const again = cspeedOpener === chip;
    closeControllerSpeed();
    if (!again) openControllerSpeed(chip);
  });
});

document.addEventListener("click", e => {
  if (!e.target.closest("#cspeedPop, [data-cspeed-chip], [data-cspeed-step]")) closeControllerSpeed();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && cspeedOpener) {
    const chip = cspeedOpener;
    closeControllerSpeed();
    chip.focus();
  }
});

addEventListener("resize", closeControllerSpeed);
document.addEventListener("fullscreenchange", closeControllerSpeed);
addEventListener("scroll", closeControllerSpeed, { passive: true });

setInterval(renderControllerSpeed, 500);
