#!/usr/bin/env python3
"""Security Mode — standalone webcam watcher using RF-DETR Keypoint (Apache 2.0).

A cheap model watches the local webcam, detects people + movement per a
configurable rule set ("the instructions"), and shows a small viewing + status
window with an alert light. When a rule fires, it sends ONE frame to Warden
(with an instruction prompt) so Warden's vision agent can decide whether to
alert you — the per-rule cooldown is what stops 1000 images being sent. The
voice/ (Jarvis) client is opened alongside so Warden's replies get spoken and
you can talk to Warden.

The dedicated Warden alert skill + 2-way frame-pull are a later step — for now
this just posts an owner-chat message with the frame attached.

Usage:
    python main.py                      # config/settings.yaml (or defaults)
    python main.py --config my.yaml
    python main.py --camera 1           # override webcam index
    python main.py --no-voice           # don't launch the voice/ client
    python main.py --no-window          # headless (no GUI window)

Install:
    pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from core.config import load_config
from core.detector import Detector
from core.motion import MotionDetector
from core.rules import evaluate, load_rules
from core.capture import CaptureSink, annotate
from core.warden import WardenClient
from core.voice_launcher import VoiceLauncher
from core.server import FrameServer
from core import known

log = logging.getLogger("security")

# Alert-light states -> (BGR color, label).
LIGHT_GREEN = (0, 200, 0)     # idle / clear
LIGHT_AMBER = (0, 180, 255)   # motion only, no rule fire
LIGHT_RED = (0, 0, 230)       # alert sent to Warden
LIGHT_BLUE = (230, 130, 0)    # (reserved for "Warden reviewing")

_running = True


def _stop(*_):
    global _running
    _running = False


def parse_args(argv: list[str] | None = None):
    p = argparse.ArgumentParser(description="Warden Security Mode detector")
    p.add_argument("--config", help="Path to settings.yaml")
    p.add_argument("--camera", type=int, help="Override webcam index")
    p.add_argument("--no-voice", action="store_true", help="Don't launch the voice/ client")
    p.add_argument("--no-window", action="store_true", help="Headless (no GUI window)")
    return p.parse_args(argv)


def _stand_down_rect(frame: np.ndarray):
    """The red STAND DOWN button rect, centered along the bottom of the frame."""
    h, w = frame.shape[:2]
    bw, bh = 300, 44
    x1 = (w - bw) // 2
    y1 = h - bh - 14
    return (x1, y1, x1 + bw, y1 + bh)


def _overlay(frame: np.ndarray, light_color, status: str, fps: float,
             alert_open: bool = False) -> np.ndarray:
    """Draw the alert light (top-left circle) + a status line onto the frame.
    When an alert is open, also draw the red STAND DOWN button the security
    guard presses to review the image + close the alert."""
    out = frame
    cv2.circle(out, (28, 28), 14, light_color, -1)
    cv2.circle(out, (28, 28), 14, (255, 255, 255), 1)
    cv2.rectangle(out, (0, 0), (out.shape[1], 4), light_color, -1)  # top bar
    cv2.putText(out, f"Warden Security  |  {status}",
                (55, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(out, f"{fps:4.1f} fps",
                (out.shape[1] - 90, out.shape[0] - 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
    if alert_open:
        x1, y1, x2, y2 = _stand_down_rect(out)
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 0, 220), -1)  # red button
        cv2.rectangle(out, (x1, y1), (x2, y2), (255, 255, 255), 1)
        cv2.putText(out, "STAND DOWN — close alert",
                    (x1 + 18, y1 + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)
    logging.basicConfig(
        level=getattr(logging, cfg.get("logging", {}).get("level", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    cam_cfg = cfg["camera"]
    model_cfg = cfg["model"]
    motion_cfg = cfg["motion"]
    out_cfg = cfg["output"]
    warden_cfg = cfg.get("warden", {})
    voice_cfg = cfg.get("voice", {})
    fs_cfg = cfg.get("frame_server", {})

    if args.camera is not None:
        cam_cfg["index"] = args.camera

    show_window = not args.no_window

    log.info("opening webcam index %s (%dx%d @ %d fps)",
             cam_cfg["index"], cam_cfg["width"], cam_cfg["height"], cam_cfg["fps"])
    cap = cv2.VideoCapture(int(cam_cfg["index"]))
    if not cap.isOpened():
        log.error("could not open webcam index %s", cam_cfg["index"])
        return 2
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["width"])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["height"])

    log.info("loading model (variant=%s, threshold=%.2f) — first frame may be slow",
             model_cfg["variant"], model_cfg["threshold"])
    detector = Detector(
        variant=model_cfg["variant"],
        threshold=model_cfg["threshold"],
        size=model_cfg.get("size", "small"),
    )
    motion = MotionDetector(
        blur=motion_cfg["blur"],
        pixel_threshold=motion_cfg["pixel_threshold"],
        min_area=motion_cfg["min_area"],
    )
    rules = load_rules(cfg)
    sink = CaptureSink(
        events_dir=out_cfg["events_dir"],
        save_annotated=out_cfg["save_annotated"],
        save_raw=out_cfg["save_raw"],
        max_events=out_cfg["max_events"],
    )
    log.info("loaded %d rule(s): %s", len(rules), [r.name for r in rules])

    warden = WardenClient(
        base_url=warden_cfg.get("base_url", "http://127.0.0.1:3200"),
        owner_jid=warden_cfg.get("owner_jid", "owner@local"),
        attachments_dir=warden_cfg.get("attachments_dir", "../groups/owner/attachments"),
    )

    # Frame server so Warden's webcam_capture can pull frames over HTTP while
    # we own /dev/video0.
    frame_server = FrameServer(
        host=fs_cfg.get("host", "127.0.0.1"),
        port=int(fs_cfg.get("port", 8765)),
    )
    frame_server.start()

    voice = None
    if not args.no_voice and voice_cfg.get("enabled", True):
        voice = VoiceLauncher(
            voice_dir=voice_cfg.get("dir", "../voice"),
            auto_setup=voice_cfg.get("auto_setup", True),
        )
        voice.start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    # ── Alert state machine + class filter ──────────────────────────────────
    alert_cfg = cfg.get("alert", {})
    allowed_classes = set(alert_cfg.get("allowed_classes", ["person"]))
    rearm_timeout = float(alert_cfg.get("rearm_timeout", 300))
    covered_std = float(alert_cfg.get("covered_std", 6))
    covered_frames = int(alert_cfg.get("covered_frames", 3))

    # State machine: ARMED → REVIEWING → (ALERTED | ARMED).
    #   ARMED     — clear, ready to flag a detection.
    #   REVIEWING — a person/covered-camera was flagged and sent to Heimdall for
    #               review. NO red button yet; the alert is NOT spawned until
    #               Heimdall declares it abnormal (→ ALERTED via /alert/open).
    #   ALERTED   — Heimdall declared an alert: red STAND DOWN button shows; the
    #               guard presses it (or /alert/close) to re-arm.
    phase = "ARMED"
    alert_open_since = 0.0
    alert_popup_pending = False  # main loop shows the alert-frame popup when set
    covered_count = 0  # consecutive near-uniform frames (lens covered)
    # After the detector returns to ARMED, wait this long before flagging again
    # (so Heimdall has time to wake up + a person standing in frame doesn't
    # immediately re-trigger). Read from the "rearm sec" slider live.
    rearm_delay = float(alert_cfg.get("rearm_delay", 10))
    suppress_until = 0.0  # don't flag before this time
    last_alert_frame = None  # the flagged frame (for the STAND DOWN review window)

    def rearm():
        # /alert/close or STAND DOWN → back to ARMED (dismisses a review OR closes
        # an open alert). Heimdall calls this on a NORMAL verdict; the guard calls
        # it via the STAND DOWN button on an ALERTED alert.
        nonlocal phase, alert_open_since, suppress_until
        phase = "ARMED"
        alert_open_since = 0.0
        suppress_until = time.time() + rearm_delay
        log.info("alert closed → detector re-armed (suppressed for %.0fs)", rearm_delay)

    def open_alert():
        # /alert/open → Heimdall declared ABNORMAL; spawn the alert (red button)
        # and queue the alert-frame popup so the guard sees what triggered it.
        nonlocal phase, alert_open_since, alert_popup_pending
        phase = "ALERTED"
        alert_open_since = time.time()
        alert_popup_pending = True
        frame_server.set_state("ALERT", time.strftime("%Y%m%dT%H%M%S"))
        log.info("Heimdall declared an alert → ALERTED (red button + popup queued)")

    frame_server.on_alert_close = rearm
    frame_server.on_alert_open = open_alert

    interval = 1.0 / max(1, cam_cfg["fps"])
    last_infer = 0.0
    last_frame_time = 0.0
    fps = 0.0
    state = "IDLE"
    light = LIGHT_GREEN

    # ── Sliders (trackbars on the webcam window) ──────────────────────────────
    # Live-tune without editing config / restarting.
    if show_window:
        cv2.namedWindow("Warden Security")
        cv2.createTrackbar("conf x100", "Warden Security",
                           int(model_cfg.get("threshold", 0.2) * 100), 95, lambda _v: None)
        cv2.createTrackbar("motion px", "Warden Security",
                           int(motion_cfg.get("min_area", 800)), 5000, lambda _v: None)
        cv2.createTrackbar("rearm sec", "Warden Security",
                           int(rearm_delay), 120, lambda _v: None)

        # STAND DOWN button hit-rect (matches _stand_down_rect for this frame size).
        _bw, _bh = 300, 44
        _bx1 = (cam_cfg["width"] - _bw) // 2
        _by1 = cam_cfg["height"] - _bh - 14
        _btn_rect = (_bx1, _by1, _bx1 + _bw, _by1 + _bh)

        def on_mouse(event, x, y, _flags, _param):
            # Pressing the red STAND DOWN button closes the open alert (re-arms
            # the detector) and opens a review window with the alert image.
            if event != cv2.EVENT_LBUTTONDOWN:
                return
            if phase != "ALERTED" or last_alert_frame is None:
                return
            rx1, ry1, rx2, ry2 = _btn_rect
            if rx1 <= x <= rx2 and ry1 <= y <= ry2:
                rearm()
                try:
                    cv2.imshow("Security Alert — review", last_alert_frame)
                except Exception as e:
                    log.warning("review window failed: %s", e)
                log.info("STAND DOWN pressed → alert closed, review window opened")

        cv2.setMouseCallback("Warden Security", on_mouse)

    try:
        while _running:
            now = time.time()
            if now - last_infer < interval:
                time.sleep(min(0.05, interval - (now - last_infer)))
                continue

            ok, frame = cap.read()
            if not ok or frame is None:
                log.warning("frame grab failed; retrying")
                time.sleep(0.1)
                continue

            last_infer = now
            if last_frame_time:
                fps = 0.9 * fps + 0.1 * (1.0 / max(1e-3, now - last_frame_time))
            last_frame_time = now

            # Read sliders → apply live.
            if show_window:
                detector.threshold = cv2.getTrackbarPos("conf x100", "Warden Security") / 100.0
                motion.min_area = cv2.getTrackbarPos("motion px", "Warden Security")
                rearm_delay = float(cv2.getTrackbarPos("rearm sec", "Warden Security"))

            # Publish the raw frame to the /frame server (JPEG) every capture so
            # Warden's webcam_capture can pull a fresh frame on demand.
            ok_enc, jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            if ok_enc:
                frame_server.set_frame(jpg.tobytes())

            motion_res = motion.step(frame)
            dets = detector.predict(frame)

            # Keep only alert-worthy classes; ignore everything else (tv, pizza,
            # dining table, etc.).
            kept = [d for d in dets.detections if d.class_name in allowed_classes]
            dets.detections = kept

            # Camera-tamper: a covered/blocked lens is a near-uniform frame
            # (very low grayscale std) sustained over a few frames.
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            frame_std = float(gray.std())
            if frame_std < covered_std:
                covered_count += 1
            else:
                covered_count = 0
            camera_covered = covered_count >= covered_frames

            # Auto-rearm if a review/alert was left open too long (Heimdall didn't
            # respond, or the guard walked away).
            if phase != "ARMED" and rearm_timeout > 0 and (now - alert_open_since) > rearm_timeout:
                log.info("auto-rearm after %ss", int(now - alert_open_since))
                rearm()

            # Light/status by phase.
            if phase == "ALERTED":
                light, state = LIGHT_RED, "ALERT — press STAND DOWN"
            elif phase == "REVIEWING":
                light, state = LIGHT_AMBER, "REVIEWING — Heimdall assessing"
            elif camera_covered:
                light, state = LIGHT_RED, "CAMERA COVERED"
            elif motion_res.area >= motion.min_area:
                light, state = LIGHT_AMBER, "MOTION"
            else:
                light, state = LIGHT_GREEN, "IDLE"

            # Flag ONE detection (person or covered camera) for Heimdall review
            # while ARMED and past the post-close suppress window. This does NOT
            # spawn the alert — Heimdall's abnormal verdict does (→ /alert/open).
            #
            # Known-person skip: when a person is detected (kept non-empty) and
            # the camera is NOT covered, compare the current frame against saved
            # known-person keyframes by pHash. A match means Heimdall already
            # vetted this person as NORMAL — skip flagging them this frame. A
            # covered/tampered camera always flags (no skip).
            if phase == "ARMED" and now >= suppress_until and (kept or camera_covered):
                if kept and not camera_covered:
                    try:
                        is_known, known_label = known.is_known(frame)
                    except Exception as _e:
                        is_known, known_label = False, None
                        log.warning("known.is_known raised: %s", _e)
                    if is_known:
                        log.info("known person '%s' — skipping flag", known_label)
                        frame_server.set_state(state)
                        if show_window:
                            display = annotate(frame, dets) if kept else frame.copy()
                            _overlay(display, light, state, fps, alert_open=(phase == "ALERTED"))
                            cv2.imshow("Warden Security", display)
                            if cv2.waitKey(1) & 0xFF == ord("q"):
                                break
                        continue
                if camera_covered:
                    caption = "camera covered/blocked (tamper)"
                else:
                    caption = ", ".join(sorted({d.class_name for d in kept}))
                res = warden.send_alert(frame, caption)
                if res.get("ok"):
                    sink.write(frame, dets, [], motion_area=motion_res.area)
                    phase = "REVIEWING"
                    alert_open_since = now
                    last_alert_frame = frame.copy()  # for the STAND DOWN review window
                    light, state = LIGHT_AMBER, f"REVIEWING ({caption}) → Heimdall"
                    frame_server.set_state("REVIEWING", time.strftime("%Y%m%dT%H%M%S"))
                    log.info("flagged for review: %s → Heimdall (ref=%s)", caption, res.get("ref"))
                else:
                    light, state = LIGHT_RED, f"flag failed (Warden down: {res.get('error', '')[:40]})"
                    log.warning("flag not delivered: %s", res.get("error"))

            frame_server.set_state(state)
            if show_window:
                display = annotate(frame, dets) if kept else frame.copy()
                _overlay(display, light, state, fps, alert_open=(phase == "ALERTED"))
                cv2.imshow("Warden Security", display)
                # Auto-popup of the alert frame when an alert spawns (Heimdall
                # declared abnormal) so the guard sees what triggered it.
                if alert_popup_pending and last_alert_frame is not None:
                    cv2.imshow("Security Alert — review", last_alert_frame)
                    alert_popup_pending = False
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        cap.release()
        if show_window:
            cv2.destroyAllWindows()
        frame_server.stop()
        if voice is not None:
            voice.stop()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())