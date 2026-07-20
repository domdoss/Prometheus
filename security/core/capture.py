"""Capture — draws detections on the frame and writes flagged frames + event JSON.

Output layout (one event per fire):
    <events_dir>/<timestamp>.jpg   (annotated and/or raw frame)
    <events_dir>/<timestamp>.json  (event metadata + matching detections)

This is the surface the Warden IPC handoff will later poll. Nothing here talks
to Warden yet — it only writes to disk.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List

import cv2
import numpy as np

log = logging.getLogger("security.capture")


def _draw_box(frame: np.ndarray, xyxy, label: str, color=(0, 255, 0)) -> None:
    x1, y1, x2, y2 = [int(v) for v in xyxy]
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    cv2.putText(frame, label, (x1, max(15, y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)


def _draw_keypoints(frame: np.ndarray, kps, color=(0, 200, 255)) -> None:
    if kps is None:
        return
    for (x, y), c in zip(kps.xy, kps.confidence):
        if c <= 0.3 or (x == 0 and y == 0):
            continue
        cv2.circle(frame, (int(x), int(y)), 3, color, -1)


def annotate(frame_bgr: np.ndarray, detections) -> np.ndarray:
    out = frame_bgr.copy()
    for det in detections.detections:
        label = f"{det.class_name} {det.confidence:.2f}"
        _draw_box(out, det.xyxy, label)
        _draw_keypoints(out, det.keypoints)
    return out


class CaptureSink:
    def __init__(self, events_dir: str, save_annotated: bool = True,
                 save_raw: bool = False, max_events: int = 1000):
        self.dir = Path(events_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.save_annotated = save_annotated
        self.save_raw = save_raw
        self.max_events = int(max_events)

    def write(self, frame_bgr: np.ndarray, detections, matches: List[Any],
              motion_area: int, timestamp: str | None = None) -> Dict[str, Any]:
        ts = timestamp or time.strftime("%Y%m%dT%H%M%S")
        base = self.dir / ts
        written: List[str] = []

        if self.save_annotated:
            p = base.with_name(f"{ts}_annotated.jpg")
            cv2.imwrite(str(p), annotate(frame_bgr, detections))
            written.append(p.name)
        if self.save_raw:
            p = base.with_name(f"{ts}_raw.jpg")
            cv2.imwrite(str(p), frame_bgr)
            written.append(p.name)

        event = {
            "timestamp": ts,
            "frames": written,
            "motion_area": motion_area,
            "matches": [
                {
                    "rule": m.rule.name,
                    "count": m.count,
                    "detections": m.matching,
                }
                for m in matches
            ],
        }
        (base.with_suffix(".json")).write_text(
            json.dumps(event, indent=2), encoding="utf-8"
        )
        log.info("event %s — %d rule(s) fired", ts, len(matches))
        self._prune()
        return event

    def _prune(self) -> None:
        if self.max_events <= 0:
            return
        jsons = sorted(self.dir.glob("*.json"))
        if len(jsons) <= self.max_events:
            return
        excess = len(jsons) - self.max_events
        for j in jsons[:excess]:
            try:
                data = json.loads(j.read_text(encoding="utf-8"))
                for f in data.get("frames", []):
                    (self.dir / f).unlink(missing_ok=True)
                j.unlink(missing_ok=True)
            except Exception as e:
                log.warning("prune failed for %s: %s", j, e)