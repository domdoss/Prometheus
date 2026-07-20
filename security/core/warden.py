"""Warden alert client — sends a security trigger to Warden as a chat message.

When the cheap detector fires, this writes the frame into the owner group's
attachments dir and POSTs a message to Warden's /api/messages (the same path
the dashboard uses). The message includes the frame as an `[Image: ...]`
reference plus an instruction prompt (the "system prompt when something comes
in") so Warden's vision agent knows what to do: read the frame, decide whether
it's worth alerting the user, and send_message if so (which voice/ speaks).

No Warden-side code changes are required — the message arrives like any other
owner-chat message and the poll loop spawns the agent. The 2-way frame-pull
(dedicated alert skill, request_camera_frame, etc.) is a later step.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.request
import urllib.error
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("security.warden")

# The trigger sent with every alert. Heimdall's system prompt carries all the
# behavioral logic; this just tells it what fired and where the frame is.
ALERT_PROMPT = (
    "SECURITY ALERT — {caption} at {ts}. Frame: [Image: {ref}]. "
    "Read the frame and handle per your instructions."
)


class WardenClient:
    def __init__(self, base_url: str, owner_jid: str, attachments_dir: str):
        self.base_url = base_url.rstrip("/")
        self.owner_jid = owner_jid
        self.attachments_dir = Path(attachments_dir)
        self.attachments_dir.mkdir(parents=True, exist_ok=True)

    def send_alert(self, frame_bgr: np.ndarray, caption: str) -> dict:
        """Write the frame to attachments, POST an alert message to Warden.

        Returns the Warden response (or an {ok:false,error:...} dict on failure).
        """
        ts = time.strftime("%Y%m%dT%H%M%S")
        fname = f"sec-{ts}.jpg"
        ref = f"groups/owner/attachments/{fname}"  # relative to Warden repo root
        abs_path = self.attachments_dir / fname
        ok = cv2.imwrite(str(abs_path), frame_bgr)
        if not ok:
            return {"ok": False, "error": f"failed to write frame to {abs_path}"}

        text = ALERT_PROMPT.format(caption=caption, ts=ts, ref=ref)
        payload = json.dumps({"jid": self.owner_jid, "text": text}).encode("utf-8")
        url = f"{self.base_url}/api/messages"

        try:
            req = urllib.request.Request(
                url, data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = resp.read().decode("utf-8", "replace")
                log.info("alert sent to Warden (%s): %s", resp.status, body[:200])
                return {"ok": True, "status": resp.status, "ref": ref}
        except urllib.error.URLError as e:
            log.warning("Warden unreachable (%s) — alert not delivered: %s", url, e)
            return {"ok": False, "error": str(e)}
        except Exception as e:
            log.warning("alert POST failed: %s", e)
            return {"ok": False, "error": str(e)}