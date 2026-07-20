"""Rule matching — the "set of instructions" the detector enforces.

A rule fires on a frame when all its conditions are met. Each rule tracks its
own cooldown so a persistent trigger doesn't flood the event log.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List

from .detector import FrameDetections
from .motion import MotionResult


@dataclass
class Rule:
    name: str
    classes: List[str]
    min_confidence: float
    min_count: int
    require_movement: bool
    cooldown_seconds: float
    _last_fired: float = 0.0

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Rule":
        return cls(
            name=d.get("name", "unnamed"),
            classes=list(d.get("classes", [])),
            min_confidence=float(d.get("min_confidence", 0.5)),
            min_count=int(d.get("min_count", 1)),
            require_movement=bool(d.get("require_movement", False)),
            cooldown_seconds=float(d.get("cooldown_seconds", 30)),
        )


@dataclass
class RuleMatch:
    rule: Rule
    count: int
    matching: List[Dict[str, Any]]   # the detections that satisfied the rule


def load_rules(config: Dict[str, Any]) -> List[Rule]:
    return [Rule.from_dict(r) for r in config.get("rules", [])]


def evaluate(
    rules: List[Rule],
    detections: FrameDetections,
    motion: MotionResult,
    now: float | None = None,
) -> List[RuleMatch]:
    """Return every rule that fires this frame (cooldowns enforced)."""
    t = now if now is not None else time.time()
    matches: List[RuleMatch] = []

    for rule in rules:
        if t - rule._last_fired < rule.cooldown_seconds:
            continue

        matching: List[Dict[str, Any]] = []
        for det in detections.detections:
            if rule.classes and det.class_name not in rule.classes:
                continue
            if det.confidence < rule.min_confidence:
                continue
            matching.append({
                "class": det.class_name,
                "confidence": round(det.confidence, 3),
                "box": [round(float(v), 1) for v in det.xyxy],
                "has_keypoints": det.keypoints is not None,
            })

        if len(matching) < rule.min_count:
            continue
        if rule.require_movement and motion.area < 1:  # caller pre-checks min_area
            continue

        rule._last_fired = t
        matches.append(RuleMatch(rule=rule, count=len(matching), matching=matching))

    return matches