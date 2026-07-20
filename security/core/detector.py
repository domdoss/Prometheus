"""RF-DETR Keypoint wrapper — the light model that watches each frame.

Primary: `RFDETRKeypointPreview` (Apache 2.0) — detection + human pose in one
forward pass. Falls back to plain `RFDETR` (boxes only) if the keypoint variant
isn't installed. Returns normalized detections regardless of which backend
loaded, so the rest of the code doesn't branch on it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

log = logging.getLogger("security.detector")


@dataclass
class Keypoints:
    # xy: [K, 2] pixel coords; confidence: [K] in [0, 1]; None if undetected.
    xy: np.ndarray
    confidence: np.ndarray


@dataclass
class Detection:
    # xyxy box in pixel coords, confidence in [0,1], class_id (COCO), class_name.
    xyxy: np.ndarray
    confidence: float
    class_id: int
    class_name: str
    keypoints: Optional[Keypoints] = None


@dataclass
class FrameDetections:
    detections: List[Detection] = field(default_factory=list)
    backend: str = "unknown"


class Detector:
    """Wraps an RF-DETR variant behind a uniform predict() -> FrameDetections."""

    def __init__(self, variant: str = "keypoint", threshold: float = 0.5, size: str = "small"):
        self.variant = variant
        self.threshold = float(threshold)
        self.size = size
        self._model = None
        self._backend = "unknown"
        self._load()

    def _load(self):
        from rfdetr import (  # noqa: F401  (import once)
            RFDETR, RFDETRNano, RFDETRSmall, RFDETRMedium, RFDETRLarge, RFDETRKeypointPreview,
        )

        if self.variant == "keypoint":
            try:
                self._model = RFDETRKeypointPreview()
                self._backend = "rfdetr-keypoint"
                log.info("Loaded RF-DETR Keypoint Preview (Apache 2.0)")
                return
            except Exception as e:
                log.warning("RFDETRKeypointPreview unavailable (%s); falling back to RFDETR", e)

        # Detection-only (still Apache 2.0). `size` picks the checkpoint;
        # default Small — fast + reliable for person detection on CPU.
        size_cls = {
            "nano": RFDETRNano, "small": RFDETRSmall, "medium": RFDETRMedium,
            "large": RFDETRLarge, "base": RFDETR,
        }.get(self.size, RFDETRSmall)
        self._model = size_cls()
        self._backend = f"rfdetr-detection-{self.size}"
        log.info("Loaded RF-DETR %s (detection, Apache 2.0)", self.size)

    @property
    def backend(self) -> str:
        return self._backend

    def predict(self, frame_bgr: np.ndarray, threshold: Optional[float] = None) -> FrameDetections:
        """Run inference on a single BGR frame. Returns normalized detections.

        Handles both backends: plain `RFDETR` returns a supervision `Detections`
        (has `.xyxy`); `RFDETRKeypointPreview` returns a supervision `KeyPoints`
        object (no `.xyxy` — use `.as_detections()` for boxes and
        `.data['class_name']` for names; the keypoint preview is person-only and
        emits `class_id=1`, so the COCO map is wrong for it).
        """
        thr = float(threshold) if threshold is not None else self.threshold
        # rfdetr.predict expects RGB numpy arrays.
        frame_rgb = frame_bgr[:, :, ::-1].copy()
        result = self._model.predict(frame_rgb, threshold=thr)

        out = FrameDetections(backend=self._backend)

        # ── Keypoint Preview path: result is a supervision KeyPoints object ──
        if hasattr(result, "as_detections") and not hasattr(result, "xyxy"):
            d = result.as_detections()
            _x = getattr(d, "xyxy", None)
            xyxy = np.asarray(_x if _x is not None else [])
            if xyxy.size == 0:
                return out
            dconf = getattr(d, "confidence", None)
            _c = getattr(d, "class_id", None)
            cids = np.asarray(_c if _c is not None else [])
            # Real class names live in result.data['class_name'] (the keypoint
            # preview is person-only; its class_id is 1, not COCO 0).
            names = None
            rdata = getattr(result, "data", None)
            if isinstance(rdata, dict) and "class_name" in rdata:
                names = rdata["class_name"]
            # detection_confidence (0-1) is the sane per-detection score;
            # as_detections().confidence is on a different scale.
            det_conf = getattr(result, "detection_confidence", None)
            _kxy = getattr(result, "xy", None)
            kp_xy = np.asarray(_kxy if _kxy is not None else [])
            _kc = getattr(result, "keypoint_confidence", None)
            if _kc is None:
                _kc = getattr(result, "confidence", None)
            kp_conf = np.asarray(_kc if _kc is not None else [])
            for i in range(len(xyxy)):
                cid = int(cids[i]) if i < len(cids) else 0
                if names is not None and i < len(names):
                    cname = str(names[i])
                else:
                    cname = "person"  # keypoint preview is person-only
                conf = float(det_conf[i]) if det_conf is not None and i < len(det_conf) else (
                    float(dconf[i]) if dconf is not None and i < len(dconf) else 1.0
                )
                det = Detection(
                    xyxy=xyxy[i].astype(float),
                    confidence=conf,
                    class_id=cid,
                    class_name=cname,
                )
                if kp_xy.size and i < len(kp_xy):
                    det.keypoints = Keypoints(
                        xy=kp_xy[i].astype(float),
                        confidence=(
                            kp_conf[i].astype(float)
                            if kp_conf.size and i < len(kp_conf)
                            else np.ones(len(kp_xy[i]))
                        ),
                    )
                out.detections.append(det)
            return out

        # ── Detection path: result is a supervision Detections object ──
        xyxy = getattr(result, "xyxy", None)
        if xyxy is None or len(xyxy) == 0:
            return out

        confidences = getattr(result, "confidence", None)
        class_ids = getattr(result, "class_id", None)

        from .config import class_name

        for i in range(len(xyxy)):
            cid = int(class_ids[i]) if class_ids is not None else -1
            det = Detection(
                xyxy=np.asarray(xyxy[i], dtype=float),
                confidence=float(confidences[i]) if confidences is not None else 1.0,
                class_id=cid,
                class_name=class_name(cid) or f"class_{cid}",
            )
            out.detections.append(det)
        return out