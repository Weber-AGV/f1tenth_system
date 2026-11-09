#!/usr/bin/env python3
# MIT License

# Copyright (c) 2026 WSU F1TENTH

# MJPEG proxy in front of the GStreamer tcpserversink started by
# bringup_launch.py. Browsers can't speak the raw
# multipart TCP stream directly; this relays it as a proper HTTP response.
#
# Newest frame only. Relaying every frame in order meant that whenever a
# viewer's Wi-Fi was slower than the camera, frames queued up (in GStreamer,
# in this process, in the kernel) and the picture fell seconds behind - you
# drove looking at the past. Now the camera is read at full speed and each
# viewer is sent the latest whole frame whenever it can take one; frames it
# could not keep up with are skipped. A slow link costs frame rate, never delay.
import collections
import json
import socket
import threading
import time
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GSTREAMER_HOST = "127.0.0.1"
GSTREAMER_PORT = 8081
HTTP_PORT = 8082
BOUNDARY = b"--robotcamera"         # one per JPEG frame in the stream

# How much a viewer's socket may hold. Enough for a couple of frames, so a
# slow viewer drops frames here instead of queueing seconds of them.
SEND_BUFFER = 64 * 1024

# Frame times per viewer, for /stats. Each open stream counts the frames it
# relays; the dashboard grades the camera's frame rate from this.
_frames = {}
_frames_lock = threading.Lock()


def camera_stats(now):
    """
    Return (fps, seconds since the last frame) for the best open stream.

    fps is counted over the last 2 s. None for both while nobody is watching.
    """
    with _frames_lock:
        viewers = [list(times) for times in _frames.values()]
    fps = max((sum(1 for t in times if now - t <= 2.0) / 2.0 for times in viewers),
              default=None)
    newest = max((times[-1] for times in viewers if times), default=None)
    return {"viewers": len(viewers), "fps": fps,
            "last_frame_s": None if newest is None else round(now - newest, 2)}


def split_frames(buf):
    """
    Split buf into whole multipart parts and the rest still being received.

    A part runs from one boundary to the next, boundary included, so each is
    sent exactly as GStreamer wrote it. Bytes before the first boundary belong
    to no frame and are dropped.
    """
    start = buf.find(BOUNDARY)
    if start < 0:
        # keep a tail long enough to hold a boundary split across reads
        return [], buf[-(len(BOUNDARY) - 1):]
    parts = []
    end = buf.find(BOUNDARY, start + len(BOUNDARY))
    while end >= 0:
        parts.append(buf[start:end])
        start = end
        end = buf.find(BOUNDARY, start + len(BOUNDARY))
    return parts, buf[start:]


class LatestFrame:
    """The newest whole frame from the camera, for one viewer."""

    def __init__(self):
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0
        self.done = False

    def put(self, frame):
        with self.cond:
            self.frame = frame
            self.seq += 1
            self.cond.notify_all()

    def finish(self):
        with self.cond:
            self.done = True
            self.cond.notify_all()

    def next_after(self, seq, timeout=5.0):
        """(frame, seq) newer than seq, or (None, seq) once the camera stops."""
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq or self.done, timeout)
            if self.seq == seq:
                return None, seq
            return self.frame, self.seq


def read_camera(stream, latest):
    """Read GStreamer as fast as it sends, keeping only the newest frame."""
    buf = b""
    try:
        while True:
            data = stream.recv(65536)
            if not data:
                break
            parts, buf = split_frames(buf + data)
            if parts:
                latest.put(parts[-1])
            if len(buf) > 8 * 1024 * 1024:      # no boundary for 8 MB: resync
                buf = b""
    except OSError:
        pass
    finally:
        latest.finish()


class CameraHandler(BaseHTTPRequestHandler):

    # The dashboard's Restart button, when rosbridge does not answer (what
    # makes the page "stop working" is usually rosbridge): restart everything
    # bringup runs, as restart_stack.py does for system_diagnostics.
    # This server is apart from rosbridge, so it still answers. It cannot see
    # ROS, so the page disarms first and says the car must be stopped. A plain
    # POST with "restart" as the body: no custom header, so the browser sends it
    # without a preflight, and a stray GET (a prefetch, a crawler) never counts.
    def do_POST(self):
        if urlsplit(self.path).path != "/restart":
            self.send_response(404)
            self.end_headers()
            return
        length = min(int(self.headers.get("Content-Length") or 0), 64)
        body = self.rfile.read(length).decode("utf-8", "replace").strip()
        if body != "restart":
            ok, msg = False, 'send "restart" as the body to confirm'
        else:
            try:
                import restart_stack                        # next to this file (~/diag)
            except ImportError:
                try:
                    from f1tenth_stack import restart_stack  # installed with bringup
                except ImportError:
                    restart_stack = None
            if restart_stack is None:
                ok, msg = False, "restart_stack.py is missing next to camera_http.py"
            else:
                import os
                ok, msg = restart_stack.restart(os.path.dirname(os.path.abspath(__file__)))
        reply = json.dumps({"ok": ok, "message": msg}).encode()
        self.send_response(200 if ok else 409)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(reply)

    def do_GET(self):
        # The dashboard appends ?t=<timestamp> on a reconnect so the
        # browser cannot hand back a cached failure; match on the path
        # alone or that retry is a 404.
        if urlsplit(self.path).path == "/stats":
            body = json.dumps(camera_stats(time.monotonic())).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return

        if urlsplit(self.path).path != "/camera.mjpg":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        try:
            stream = socket.create_connection(
                (GSTREAMER_HOST, GSTREAMER_PORT)
            )

            self.send_response(200)
            self.send_header(
                "Content-Type",
                "multipart/x-mixed-replace; boundary=robotcamera"
            )
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            # The dashboard is served on a different port (8000 vs 8082),
            # which browsers treat as a different origin. Without this
            # header the <img> still shows the stream, but any canvas
            # draw of it is "tainted" and toDataURL()/toBlob() throws -
            # the video works, the download button doesn't.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            # small send buffer, sent at once: frames go out as they come
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, SEND_BUFFER)
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

            mine = collections.deque(maxlen=120)
            with _frames_lock:
                _frames[threading.get_ident()] = mine

            latest = LatestFrame()
            threading.Thread(target=read_camera, args=(stream, latest),
                             daemon=True).start()

            seq = 0
            while True:
                frame, newer = latest.next_after(seq)
                if frame is None:
                    if latest.done:
                        break
                    continue                     # camera quiet; keep waiting
                seq = newer
                self.wfile.write(frame)
                self.wfile.flush()
                # frames actually delivered: what this viewer really sees
                with _frames_lock:
                    mine.append(time.monotonic())

        except (ConnectionError, BrokenPipeError, OSError):
            pass

        finally:
            with _frames_lock:
                _frames.pop(threading.get_ident(), None)
            try:
                stream.close()               # ends the reader thread too
            except (NameError, OSError):
                pass

    def log_message(self, format, *args):
        print(f"[HTTP] {args[0]}")


def self_test():
    """Check the frame counting with no camera: python3 camera_http.py --self-test."""
    now = time.monotonic()
    assert camera_stats(now) == {"viewers": 0, "fps": None, "last_frame_s": None}
    _frames[1] = collections.deque(now - 1.5 + i / 30 for i in range(45))
    stats = camera_stats(now)
    assert stats["viewers"] == 1 and 22 <= stats["fps"] <= 23, stats
    _frames.clear()
    # frames split across reads, and a boundary split across two reads
    buf, got = b"", []
    for data in (b"junk--robot", b"camera\r\nA1--robotca", b"mera\r\nB2--robotcamera\r\nC"):
        parts, buf = split_frames(buf + data)
        got += parts
    assert got == [b"--robotcamera\r\nA1", b"--robotcamera\r\nB2"], got
    assert buf == b"--robotcamera\r\nC", buf

    # a slow viewer gets the newest frame, not the backlog
    latest = LatestFrame()
    for name in (b"f1", b"f2", b"f3"):
        latest.put(name)
    frame, seq = latest.next_after(0, timeout=0.1)
    assert (frame, seq) == (b"f3", 3), (frame, seq)
    assert latest.next_after(seq, timeout=0.05) == (None, 3)
    print("camera_http self-test passed")


def main():
    server = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), CameraHandler)
    print(f"Camera HTTP server running on port {HTTP_PORT}")
    print(f"Open: http://<robot-ip>:{HTTP_PORT}/camera.mjpg")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping camera server...")
        server.server_close()


if __name__ == "__main__":
    import sys
    self_test() if "--self-test" in sys.argv else main()
