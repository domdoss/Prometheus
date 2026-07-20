"""Motion detection via frame differencing.

Produces a motion mask and its nonzero area — the signal that distinguishes
"person present" from "person moving." Stateless per call; the caller keeps
the previous grayscale frame.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class MotionResult:
    area: int           # nonzero pixels in the thresholded motion mask
    ratio: float        # area / total pixels (0-1)
    mask: np.ndarray    # the binary mask (uint8), for annotation/debug


class MotionDetector:
    def __init__(self, blur: int = 21, pixel_threshold: int = 25, min_area: int = 800):
        self.blur = int(blur)
        self.pixel_threshold = int(pixel_threshold)
        self.min_area = int(min_area)
        self._prev_gray: np.ndarray | None = None
        self._last_area: int = 0

    def reset(self) -> None:
        self._prev_gray = None
        self._last_area = 0

    def step(self, frame_bgr: np.ndarray) -> MotionResult:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (self.blur, self.blur), 0)

        if self._prev_gray is None or self._prev_gray.shape != gray.shape:
            self._prev_gray = gray
            self._last_area = 0
            return MotionResult(area=0, ratio=0.0, mask=np.zeros_like(gray))

        diff = cv2.absdiff(self._prev_gray, gray)
        self._prev_gray = gray
        _, mask = cv2.threshold(diff, self.pixel_threshold, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, None, iterations=2)
        area = int(np.count_nonzero(mask))
        self._last_area = area
        total = mask.size
        return MotionResult(area=area, ratio=area / total if total else 0.0, mask=mask)

    @property
    def is_moving(self) -> bool:
        """Convenience: True if the *last* step exceeded min_area. Reads a cached flag."""
        return self._last_area >= self.min_area