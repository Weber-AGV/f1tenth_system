"use strict";

/* Camera stream and take-picture. */

/* ==========================================================
   CAMERA STREAM

   A plain MJPEG stream over HTTP. The browser renders it in an
   <img> all by itself, so there is no ROS image topic, no
   rosbridge traffic and no library involved — just a URL.
========================================================== */

/* ==========================================================
   AUTOMATIC CAMERA

   The camera follows the robot: when rosbridge connects, the stream
   is opened on that same robot (bringup serves it on :8082), so switching robots in the top bar switches the camera
   too. While the robot is connected and the stream is not up yet
   (camera still starting, or it dropped), it keeps retrying on its
   own. Typing an address (or ?video=) switches this off until "Use
   automatic" is pressed.
========================================================== */

const CAMERA_PORT = 8082;
const CAMERA_PATH = "/camera.mjpg";
const CAMERA_RETRY_MIN_MS = 3000;
const CAMERA_RETRY_MAX_MS = 15000;

let cameraManual = false;       // the user chose the address
let cameraAuto = false;         // the current stream was picked for them
let cameraUrlNow = "";
let cameraRetryTimer = null;
let cameraRetryMs = CAMERA_RETRY_MIN_MS;
let cameraRobotDropped = false; // the robot went away since the stream opened

/* ws://192.168.1.206:9090 -> http://192.168.1.206:8082/camera.mjpg */
function cameraUrlFor(wsUrl) {

  try {

    const host = new URL(wsUrl).hostname;

    return host ? `http://${host}:${CAMERA_PORT}${CAMERA_PATH}` : "";

  } catch (error) {

    return "";
  }
}

function cameraLive() {
  return !$("cameraImage").hidden && Boolean($("cameraImage").naturalWidth);
}

/* rosbridge just opened (connection.js) */
function cameraOnRobotConnected(wsUrl) {

  const dropped = cameraRobotDropped;

  cameraRobotDropped = false;

  if (cameraManual) {
    /* their address, but the robot is back: try it again */
    if (dropped || !cameraLive()) connectCamera(cameraUrlNow, false);
    return;
  }

  const url = cameraUrlFor(wsUrl);

  if (!url) return;

  $("cameraUrl").value = url;

  /* already showing this robot's camera, and nothing went away:
     a Refresh should not blank the picture */
  if (url === cameraUrlNow && cameraLive() && !dropped) {
    renderCameraSource();
    return;
  }

  connectCamera(url, true);
}

/* rosbridge closed (connection.js): stop retrying until it is back */
function cameraOnRobotDisconnected() {

  cameraRobotDropped = true;

  clearTimeout(cameraRetryTimer);
  cameraRetryTimer = null;
}

function useAutomaticCamera() {

  cameraManual = false;

  const url =
    cameraUrlFor(socketOpen() ? ws.url : $("wsUrl").value.trim());

  $("cameraUrl").value = url;
  connectCamera(url, true);
}

function useManualCamera(url) {

  cameraManual = true;
  connectCamera(url, false);
}

/* the Reconnect buttons: same address, same mode */
function reconnectCamera() {
  connectCamera(cameraUrlNow || $("cameraUrl").value.trim(), cameraAuto);
}

function renderCameraSource() {

  let where = cameraUrlNow;

  try {
    where = new URL(cameraUrlNow).host;
  } catch (error) {}

  $("cameraSource").textContent =
    cameraAuto
      ? `Automatic · follows the robot${where ? " (" + where + ")" : ""}`
      : `Manual address${where ? " · " + where : ""}`;

  $("cameraSource").classList.toggle("manual", !cameraAuto);
  $("cameraAutoBtn").hidden = cameraAuto;
}

function setCameraStatus(text, color) {

  $("camTag").textContent = text;
  $("camTag").style.color = color;
}

/* ==========================================================
   FRAME RATE

   camera_http counts the frames it relays and reports them at /stats
   on the same host and port as the stream. Read every 2 s while the
   stream is showing; an older camera_http without /stats just leaves
   this null.
========================================================== */

let cameraStats = null;

async function pollCameraStats() {

  const image = $("cameraImage");

  if (image.hidden || !image.src) {
    cameraStats = null;
    return;
  }

  try {
    const response = await fetch(new URL(image.src).origin + "/stats", { cache: "no-store" });
    cameraStats = { ...(await response.json()), at: Date.now() };
  } catch (error) {
    cameraStats = null;
    return;
  }

  const { fps, last_frame_s: age } = cameraStats;

  if (age !== null && age > CAMERA_NO_FRAME_S) {
    setCameraStatus("NO FRAMES", "var(--bad-ink)");
  } else if (fps !== null) {
    setCameraStatus(
      `LIVE · ${Math.round(fps)} fps`,
      fps < CAMERA_MIN_FPS ? "var(--warn-ink)" : "var(--healthy)");
  }
}

setInterval(pollCameraStats, 2000);

function connectCamera(url, auto = false) {

  const image = $("cameraImage");

  cameraPaused = false;                // syncCameraPause pauses it again if hidden

  clearTimeout(cameraRetryTimer);
  cameraRetryTimer = null;

  if (url !== cameraUrlNow) cameraRetryMs = CAMERA_RETRY_MIN_MS;

  cameraUrlNow = url;
  cameraAuto = auto;
  renderCameraSource();

  if (!url) {

    setCameraStatus("NO STREAM", "var(--bad-ink)");
    $("camMessage").textContent =
      auto ? "Waiting for the robot…" : "Enter a camera URL first.";
    $("camMessage").hidden = false;
    image.hidden = true;
    return;
  }

  setCameraStatus("CONNECTING", "var(--muted)");

  /* Without this, the browser loads the stream in "no-cors" mode
     and treats it as opaque no matter what headers the server
     sends — canvas draws from it are tainted regardless. With it,
     the browser actually checks Access-Control-Allow-Origin, so
     the server-side header above only takes effect once this is
     set too. */
  image.crossOrigin = "anonymous";

  image.hidden = true;

  $("camMessage").textContent = "Connecting…";
  $("camMessage").hidden = false;

  image.onload = () => {
    image.hidden = false;
    $("camMessage").hidden = true;
    setCameraStatus("LIVE", "var(--healthy)");
    cameraRetryMs = CAMERA_RETRY_MIN_MS;
  };

  image.onerror = () => {

    image.hidden = true;
    $("camMessage").hidden = false;

    /* automatic, with the robot there: the camera may still be
       starting, so keep trying, backing off */
    if (auto && socketOpen()) {

      const wait = cameraRetryMs;

      cameraRetryMs = Math.min(cameraRetryMs * 2, CAMERA_RETRY_MAX_MS);

      $("camMessage").textContent =
        `No stream at ${url} yet — trying again in ${Math.round(wait / 1000)} s`;
      setCameraStatus("RETRYING", "var(--warn-ink)");

      cameraRetryTimer = setTimeout(() => {
        if (cameraAuto && cameraUrlNow === url && socketOpen()) {
          connectCamera(url, true);
        }
      }, wait);

      return;
    }

    $("camMessage").textContent =
      auto
        ? `No stream at ${url} — it connects again when the robot does`
        : "No stream at " + url;
    setCameraStatus("NO STREAM", "var(--bad-ink)");
  };

  /* On a reconnect the browser may hand back its cached copy of
     a failed request, so the retry would never leave the page.
     A timestamp makes it a new URL. Skipped on the first connect
     to keep the plain URL intact. */
  image.src =
    image.getAttribute("src")
      ? url + (url.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now()
      : url;
}

/* ==========================================================
   PAUSED WHILE NOT ON SCREEN

   The stream is the heaviest thing on the car's Wi-Fi (30 fps of JPEG),
   and it used to keep coming while no tab or pane showed it - one viewer
   at 30 fps on camera_http's /stats with the Camera pane closed. Once a
   second: if the picture is not on screen (its pane is closed, another tab
   is showing, or the browser tab is in the background), the stream is
   closed; when it is back on screen, it opens again. A recording keeps it,
   since it draws every frame.
========================================================== */

let cameraPaused = false;
let cameraHeldUntil = 0;               // cameraWake: stay open until then
const CAMERA_WAKE_MS = 5000;           // how long a wake waits for a frame
const CAMERA_HOLD_MS = 10000;          // and keeps the stream open after

function cameraOnScreen() {
  const box = $("cameraImage").parentElement;
  return document.visibilityState === "visible" &&
    Boolean(box) && box.getClientRects().length > 0;
}

function syncCameraPause() {

  const image = $("cameraImage");

  if (recording || cameraOnScreen() || performance.now() < cameraHeldUntil) {
    if (cameraPaused) {
      cameraPaused = false;
      connectCamera(cameraUrlNow, cameraAuto);
    }
    return;
  }

  if (cameraPaused || !image.getAttribute("src")) return;

  cameraPaused = true;
  clearTimeout(cameraRetryTimer);
  cameraRetryTimer = null;
  image.onload = image.onerror = null;
  image.removeAttribute("src");        // closes the stream
  image.hidden = true;
  $("camMessage").textContent = "Paused while not on screen";
  $("camMessage").hidden = false;
  setCameraStatus("PAUSED", "var(--muted)");
}

setInterval(syncCameraPause, 1000);

/* Take Picture and Record from a pane that does not show the picture: open
   the stream (if it was paused), wait for a frame, keep it open a little.
   True once there is a live frame. */
async function cameraWake() {

  if (cameraLive()) return true;
  if (!cameraUrlNow) return false;

  cameraHeldUntil = performance.now() + CAMERA_HOLD_MS;
  if (cameraPaused || !$("cameraImage").getAttribute("src")) {
    connectCamera(cameraUrlNow, cameraAuto);
  }

  const end = performance.now() + CAMERA_WAKE_MS;
  while (performance.now() < end) {
    if (cameraLive()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return cameraLive();
}
document.addEventListener("visibilitychange", syncCameraPause);

/* ==========================================================
   TAKE PICTURE

   Copies whatever frame is on screen into a canvas and turns it
   into a PNG the browser can save. No library, no round trip to
   the robot — the frame is already here.
========================================================== */

function showCameraHint(text) {

  $("cameraHint").textContent = text;
  $("cameraHint").hidden = !text;
}

async function takePicture() {

  const image = $("cameraImage");

  if (!cameraLive() && cameraPaused) showCameraHint("Opening the camera…");

  if (!(await cameraWake()) || image.hidden || !image.naturalWidth) {

    showCameraHint(
      "No live frame to capture — connect the camera first.");
    return;
  }

  const canvas = document.createElement("canvas");

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  canvas.getContext("2d").drawImage(image, 0, 0);

  let data;

  try {

    data = canvas.toDataURL("image/png");

  } catch (error) {

    /* Drawing an image served by another origin "taints" the
       canvas, and the browser then refuses to let the page read
       the pixels back. The video keeps working — only the
       capture is blocked. The fix is on the camera server:
       send an Access-Control-Allow-Origin header. */
    showCameraHint(
      "The browser blocked reading this frame. The camera server " +
      "does not send an Access-Control-Allow-Origin header, so the " +
      "page can show the video but cannot copy its pixels. The " +
      "stream itself is fine.");
    return;
  }

  const stamp = new Date();

  $("snapshotImage").src = data;
  $("snapshotSave").href = data;

  $("snapshotSave").download =
    "camera-" +
    stamp.toISOString().slice(0, 19).replace(/[:T]/g, "-") +
    ".png";

  $("snapshotTime").textContent =
    canvas.width + "×" + canvas.height + " · " +
    stamp.toLocaleTimeString();

  $("snapshot").hidden = false;

  showCameraHint("");
}


/* ==========================================================
   RECORD

   Records what the camera shows, in the browser: every frame of the
   <img> is drawn onto a canvas, and the browser's MediaRecorder turns
   the canvas into a video file. Nothing runs on the robot and nothing
   extra crosses the Wi-Fi - it is the stream already on screen. The
   camera server's Access-Control-Allow-Origin header is what lets the
   page read the frames, as for Take Picture. Stop saves the file.

   The one <img> moves between the Overview, the Drive tab and full
   screen, so a recording carries on across all three.
========================================================== */

const RECORD_FPS = 30;
const RECORD_BITRATE = 2500000;            // bits/s: about 19 MB a minute
const RECORD_MAX_MS = 15 * 60 * 1000;      // held in memory until saved

/* the first the browser can make: MP4 (Safari, newer Chrome), else WebM */
const RECORD_TYPES = [
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"]
];

let recording = null;      // the recording in progress, or null

function recordFormat() {

  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;

  return RECORD_TYPES.find(([type]) => MediaRecorder.isTypeSupported(type)) || null;
}

function cameraRecording() {
  return Boolean(recording);
}

function recordElapsed() {
  return recording ? Date.now() - recording.startedAt : 0;
}

function clockText(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/* to the camera card, and to the driving view when it is open */
function reportRecording(text) {

  showCameraHint(text);

  if (typeof cockpitOpen !== "undefined" && cockpitOpen) setCockpitNote(text);
}

async function startRecording() {

  if (recording) return;

  const image = $("cameraImage");
  const format = recordFormat();

  if (!format) {
    reportRecording("This browser cannot record video. Chrome, Edge, Firefox and Safari can.");
    return;
  }

  if (!cameraLive() && cameraPaused) reportRecording("Opening the camera…");

  if (!(await cameraWake())) {
    reportRecording("No live picture to record. Connect the camera first.");
    return;
  }

  if (recording) return;               // a second click while waiting

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  /* the same block as Take Picture: no header, no pixels */
  try {
    context.getImageData(0, 0, 1, 1);
  } catch (error) {
    reportRecording(
      "The browser blocked reading the camera's frames, so it cannot record " +
      "them. The camera server needs to send an Access-Control-Allow-Origin " +
      "header. The stream itself is fine.");
    return;
  }

  const stream = canvas.captureStream(RECORD_FPS);
  let recorder;

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format[0],
      videoBitsPerSecond: RECORD_BITRATE
    });
  } catch (error) {
    reportRecording("Recording could not start: " + error.message);
    return;
  }

  const take = {
    recorder,
    stream,
    canvas,
    context,
    chunks: [],
    ext: format[1],
    type: format[0].split(";")[0],
    startedAt: Date.now(),
    reason: "",
    timers: []
  };

  recorder.ondataavailable = event => {
    if (event.data && event.data.size) take.chunks.push(event.data);
  };

  recorder.onstop = () => saveRecording(take);

  take.timers.push(setInterval(() => drawRecordFrame(take), 1000 / RECORD_FPS));
  take.timers.push(setInterval(renderRecording, 500));

  recorder.start(1000);
  recording = take;

  showCameraHint("");
  renderRecording();
}

/* the frame on screen; black with a note while the stream is down,
   so the video keeps the real timing */
function drawRecordFrame(take) {

  const { canvas, context } = take;
  const image = $("cameraImage");

  if (Date.now() - take.startedAt >= RECORD_MAX_MS) {
    stopRecording("it reached the " + RECORD_MAX_MS / 60000 + "-minute limit");
    return;
  }

  if (cameraLive()) {

    /* the camera changed size mid-recording: fit it, never crop */
    const scale = Math.min(canvas.width / image.naturalWidth,
                           canvas.height / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;

    if (w < canvas.width || h < canvas.height) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    return;
  }

  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#bbb";
  context.font = `${Math.round(canvas.height / 18)}px sans-serif`;
  context.textAlign = "center";
  context.fillText("No camera signal", canvas.width / 2, canvas.height / 2);
}

function stopRecording(reason = "") {

  if (!recording) return;

  const take = recording;

  recording = null;
  take.reason = reason;
  take.endedAt = Date.now();
  take.timers.forEach(clearInterval);

  take.recorder.stop();               // the last piece arrives, then onstop
  take.stream.getTracks().forEach(track => track.stop());

  renderRecording();
}

function toggleRecording() {
  if (recording) stopRecording();
  else startRecording();
}

/* Stop: the file goes to the browser's downloads, named by when it started */
function saveRecording(take) {

  if (!take.chunks.length) {
    reportRecording("The recording was empty, so nothing was saved.");
    return;
  }

  const blob = new Blob(take.chunks, { type: take.type });
  const url = URL.createObjectURL(blob);
  /* the clock on the wall, not UTC: camera-2026-10-26-14-03-22.mp4 */
  const at = new Date(take.startedAt);
  const two = n => String(n).padStart(2, "0");
  const name = `camera-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-` +
    `${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.${take.ext}`;

  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60000);

  reportRecording(
    `Saved ${name} · ${clockText(take.endedAt - take.startedAt)} · ` +
    `${(blob.size / 1048576).toFixed(1)} MB` +
    (take.reason ? ` (stopped because ${take.reason})` : ""));
}

/* every Record button, and the REC mark on the picture */
function renderRecording() {

  const on = Boolean(recording);
  const time = clockText(recordElapsed());

  $("recBadge").hidden = !on;
  $("recTime").textContent = time;

  document.querySelectorAll("[data-record]").forEach(button => {

    const short = button.dataset.record === "short";

    button.classList.toggle("recording", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on
      ? "Stop recording and save the video"
      : "Record the camera to a video file";
    button.innerHTML = on
      ? icon("square") + `<span class="btn-lbl"> ${short ? time : "Stop " + time}</span>`
      : icon("record") + `<span class="btn-lbl"> ${short ? "Rec" : "Record"}</span>`;
  });
}

document.querySelectorAll("[data-record]").forEach(button => {
  button.onclick = toggleRecording;
});

/* a recording lives in memory until it is saved */
window.addEventListener("beforeunload", event => {
  if (recording) {
    event.preventDefault();
    event.returnValue = "";
  }
});

renderRecording();
