"""Known-person keyframe recognition (detector-side, pHash).

The Warden host (Node) writes rows into the `known_persons` table of
`store/security.db` whenever Heimdall declares a detected person NORMAL:

    known_persons(id INTEGER PRIMARY KEY AUTOINCREMENT,
                  label TEXT,
                  frame_path TEXT,
                  phash TEXT,
                  created_at TEXT)

The host inserts {label, frame_path} with phash NULL — it has no image lib,
so the detector (us) is responsible for computing the pHash itself and
UPDATE-ing the row. `frame_path` is repo-relative
(e.g. "groups/owner/attachments/sec-20260720T125244.jpg").

`is_known(frame_bgr)` lets the detector skip flagging a person when the
current frame closely matches a saved known-person keyframe (Hamming
distance of pHashes <= threshold). This is application-side recognition —
no Heimdall round-trip needed.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path

log = logging.getLogger("security.known")

# security/ is at <repo>/security/; store/ is at <repo>/store/.
# This file is security/core/known.py → repo root is two parents up.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DB_PATH = _REPO_ROOT / "store" / "security.db"

# TTL for the in-memory known-persons cache (seconds). New rows the host
# writes while the detector is running are picked up on the next call to
# load_known() after this many seconds.
_CACHE_TTL = 10.0

# Module-level cache.
_cache: list[dict] | None = None
_cache_loaded_at: float = 0.0


def _open_db() -> sqlite3.Connection | None:
    """Open the security db read-write. Returns None if unavailable."""
    try:
        if not _DB_PATH.exists():
            return None
        conn = sqlite3.connect(str(_DB_PATH))
        conn.row_factory = sqlite3.Row
        # Verify the table exists.
        try:
            conn.execute("SELECT 1 FROM known_persons LIMIT 1")
        except sqlite3.Error:
            conn.close()
            return None
        return conn
    except Exception as e:
        log.warning("known: could not open known_persons db: %s", e)
        return None


def _compute_phash(frame_path: str):
    """Compute imagehash.phash for a repo-relative frame path.

    Returns the imagehash object, or None if the file can't be loaded or
    imagehash/PIL aren't importable.
    """
    try:
        from PIL import Image
        import imagehash
    except Exception as e:
        log.warning("known: imagehash/PIL unavailable: %s", e)
        return None
    # frame_path is repo-relative; resolve from repo root.
    p = _REPO_ROOT / frame_path
    try:
        if not p.exists():
            log.warning("known: frame file missing: %s", p)
            return None
        return imagehash.phash(Image.open(p))
    except Exception as e:
        log.warning("known: phash failed for %s: %s", p, e)
        return None


def _phash_from_bgr(frame_bgr):
    """Compute imagehash.phash on an in-memory BGR frame (numpy array)."""
    try:
        from PIL import Image
        import imagehash
        import cv2
    except Exception as e:
        log.warning("known: imagehash/PIL/cv2 unavailable: %s", e)
        return None
    try:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        return imagehash.phash(pil)
    except Exception as e:
        log.warning("known: phash on frame failed: %s", e)
        return None


def load_known(force: bool = False) -> list[dict]:
    """Load known persons from the db, computing + persisting any missing
    pHashes. Returns a list of {label, frame_path, phash} dicts (phash is
    an imagehash object, or None if it couldn't be computed). Cached for
    `_CACHE_TTL` seconds; pass force=True to bypass the cache.
    """
    global _cache, _cache_loaded_at

    now = time.time()
    if not force and _cache is not None and (now - _cache_loaded_at) < _CACHE_TTL:
        return _cache

    conn = _open_db()
    if conn is None:
        _cache = []
        _cache_loaded_at = now
        return _cache

    try:
        rows = conn.execute(
            "SELECT id, label, frame_path, phash FROM known_persons"
        ).fetchall()
    except Exception as e:
        log.warning("known: query failed: %s", e)
        conn.close()
        _cache = []
        _cache_loaded_at = now
        return _cache

    out: list[dict] = []
    for r in rows:
        label = r["label"]
        frame_path = r["frame_path"]
        phash_str = r["phash"]
        if phash_str is None or phash_str == "":
            # Compute it from the frame file and persist back.
            h = _compute_phash(frame_path)
            if h is not None:
                try:
                    conn.execute(
                        "UPDATE known_persons SET phash = ? WHERE id = ?",
                        (str(h), r["id"]),
                    )
                    conn.commit()
                except Exception as e:
                    log.warning("known: update phash failed (id=%s): %s", r["id"], e)
            out.append({"label": label, "frame_path": frame_path, "phash": h})
        else:
            # Parse the stored hash string back into an imagehash object.
            h = _parse_phash(phash_str)
            out.append({"label": label, "frame_path": frame_path, "phash": h})

    conn.close()
    _cache = out
    _cache_loaded_at = now
    return out


def _parse_phash(s: str):
    """Parse a stored pHash hex/decimal string back into an imagehash object."""
    try:
        import imagehash
        return imagehash.hex_to_hash(s)
    except Exception:
        return None


def is_known(frame_bgr, threshold: int = 8) -> tuple[bool, str | None]:
    """Check whether `frame_bgr` matches a saved known-person keyframe.

    Returns (True, label) if the minimum Hamming distance to any known
    pHash is <= threshold, else (False, None). Never raises — on any
    error (no db, no imagehash, empty cache) returns (False, None).
    """
    try:
        known = load_known()
        if not known:
            return (False, None)
        h = _phash_from_bgr(frame_bgr)
        if h is None:
            return (False, None)
        best_label: str | None = None
        best_dist = None
        for k in known:
            kh = k.get("phash")
            if kh is None:
                continue
            try:
                d = h - kh  # imagehash Hamming distance
            except Exception:
                continue
            if best_dist is None or d < best_dist:
                best_dist = d
                best_label = k.get("label")
        if best_dist is not None and best_dist <= threshold and best_label is not None:
            return (True, best_label)
        return (False, None)
    except Exception as e:
        log.warning("known: is_known failed: %s", e)
        return (False, None)