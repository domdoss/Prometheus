"""Configuration loader for Security Mode.

Layered config:
    1. Bundled defaults — `config/settings.example.yaml` next to this package.
    2. User overrides — the --config path (defaults to `config/settings.yaml`).

Deep-merged so a user file only needs to list the keys it changes.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict

import yaml

# COCO 80-class names. RF-DETR is COCO-trained; class_id 0 = "person".
COCO_NAMES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
]


def _bundled_defaults() -> Path:
    return Path(__file__).resolve().parent.parent / "config" / "settings.example.yaml"


def _deep_merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: str | os.PathLike | None = None) -> Dict[str, Any]:
    """Load bundled defaults, then deep-merge the user file on top.

    `path` defaults to `config/settings.yaml` relative to the package.
    Missing user file is fine — defaults stand on their own.
    """
    with open(_bundled_defaults(), "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    user_path = Path(path) if path else (
        Path(__file__).resolve().parent.parent / "config" / "settings.yaml"
    )
    if user_path.exists():
        with open(user_path, "r", encoding="utf-8") as f:
            user = yaml.safe_load(f) or {}
        config = _deep_merge(config, user)

    return config


def class_name(class_id: int | None) -> str | None:
    if class_id is None:
        return None
    if 0 <= class_id < len(COCO_NAMES):
        return COCO_NAMES[class_id]
    return f"class_{class_id}"