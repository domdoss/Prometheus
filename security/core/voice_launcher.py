"""Launches the voice/ (Jarvis) client alongside the webcam window.

The security app owns the webcam; voice/ owns the mic + speaker. Opening both
together gives the demo its mouth: Warden's alert replies arrive over SSE and
Kokoro speaks them, and you can talk to Warden ("look at the camera and
describe what you see").

`voice/single.py` points the client at the local Warden (127.0.0.1:3200, jid
owner@local, no auth). We run it once if the user config isn't already local
(it clears the session each run, so we skip it when already configured), then
spawn `voice/main.py` as a subprocess. The subprocess is terminated on
shutdown.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("security.voice")

CONFIG_PATH = Path.home() / ".config" / "jarvis" / "config.yaml"
LOCAL_BASE_URL = "http://127.0.0.1:3200"


def _is_local_configured() -> bool:
    """True if voice/ config already points at the local Warden."""
    try:
        import yaml
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        base = (cfg.get("dockbox") or {}).get("base_url", "")
        return base == LOCAL_BASE_URL
    except Exception:
        return False


class VoiceLauncher:
    def __init__(self, voice_dir: str, auto_setup: bool = True):
        self.dir = Path(voice_dir).resolve()
        self.auto_setup = auto_setup
        self.proc: subprocess.Popen | None = None

    def start(self) -> bool:
        if not self.dir.exists():
            log.warning("voice dir not found: %s — skipping voice client", self.dir)
            return False

        if self.auto_setup and not _is_local_configured():
            log.info("configuring voice/ for local Warden via single.py …")
            try:
                subprocess.run(
                    [sys.executable, "single.py"], cwd=str(self.dir),
                    timeout=15, check=False,
                )
            except Exception as e:
                log.warning("voice/single.py failed (is Warden up?): %s", e)

        log.info("launching voice client from %s", self.dir)
        try:
            self.proc = subprocess.Popen(
                [sys.executable, "main.py"], cwd=str(self.dir),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            log.info("voice client pid=%s", self.proc.pid)
            return True
        except Exception as e:
            log.warning("failed to launch voice client: %s", e)
            self.proc = None
            return False

    def stop(self) -> None:
        if self.proc is None:
            return
        try:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            log.info("voice client stopped")
        except Exception as e:
            log.warning("error stopping voice client: %s", e)
        finally:
            self.proc = None