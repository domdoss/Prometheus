# Warden Security Mode

A standalone webcam watcher that flags detections to **Heimdall**, Warden's
background security agent, which reviews each flag and decides whether to raise
an alert. Known people are skipped at the detector (no agent round-trip). It's a
**basic framework** — plumbed in and upgradable for real home-security use
(Home Assistant, a real guard-dispatch service, face-ID, etc. can be added as
plugins/MCP later).

No YOLO (AGPL). Commercially-free models only: **RF-DETR Keypoint** (Apache 2.0)
for detection, **gemma4** (via Warden's Ollama) for vision.

## How it works

```
webcam → RF-DETR Keypoint detector (CPU)
  │  detects a person / vehicle / thief-tool / covered camera
  │  known person?  → pHash-match a saved keyframe → SKIP (no alert)
  ▼
FLAGGED → posts one frame to Warden (POST /api/messages "SECURITY ALERT …")
  ▼
Warden routes it to Heimdall (background sub-agent, NOT the main chat)
  ▼
Heimdall reviews the frame (vision) + its security_log history:
  │  NORMAL  → save_known_person (keyframe) + dismiss_security_flag (silent)
  │  ABNORMAL → alert_security (mock escalate) + send_message (image attached,
  │            shows in chat + Telegram) + open_security_alert (red button + popup)
  ▼
ALERTED → red STAND DOWN button + auto-popup of the alert image.
  The GUARD presses STAND DOWN (or says "close the alert" in chat) to re-arm.
  Heimdall cannot close alerts — only the guard can.
```

State machine: **ARMED → REVIEWING → (ALERTED | ARMED)**. The alert is spawned
*only* after Heimdall declares it abnormal — the detector just flags for review.

## Files

```
security/
  main.py                # webcam loop, state machine, GUI (alert light + STAND DOWN button + sliders)
  core/
    detector.py          # RF-DETR Keypoint wrapper (detection-only fallback)
    motion.py            # frame-differencing motion detector
    rules.py             # rule matching (allowed classes, confidence, movement)
    capture.py           # annotate frames + write event JSON
    config.py            # settings loader + COCO class names
    warden.py            # posts the SECURITY ALERT frame to Warden
    server.py            # tiny HTTP server: GET /frame, /status; POST /alert/open, /alert/close
    voice_launcher.py    # opens the voice/ (Jarvis) client alongside the webcam
    known.py             # known-person keyframe pHash compare (skip flagging known people)
  config/settings.example.yaml   # the "set of instructions" — copy to settings.yaml
  requirements.txt
```

## Install

```bash
cd security
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt     # rfdetr pulls weights on first run (CPU)
cp config/settings.example.yaml config/settings.yaml   # edit if you like
```

## Start

```bash
cd security && . .venv/bin/activate
python main.py                 # webcam window + (optionally) voice/ open together
# flags:
#   --camera 1        override webcam index
#   --no-voice        don't launch the voice/ client
#   --no-window       headless (no GUI)
#   --config my.yaml  override settings file
```

The window shows the live feed, an alert light (green idle / amber motion or
reviewing / red alert), and three sliders: **conf x100** (detection threshold),
**motion px** (motion sensitivity), **rearm sec** (min seconds between flags,
default 20).

When Heimdall declares an alert, a **red STAND DOWN** button appears at the
bottom and a **"Security Alert — review"** window pops up with the alert image.
Press STAND DOWN (or type "close the alert" / "stand down" / "all clear" in the
Warden chat) to close the alert and re-arm the detector.

## Stop

- Close the webcam window or press **q** in it, or
- `pkill -f "security/main.py"` (or kill the pid printed at start).

The frame server (`http://127.0.0.1:8765`) stops with it; Warden's
`webcam_capture` then falls back to ffmpeg `/dev/video0`.

## Warden side (already plumbed in)

- **Heimdall** sub-agent: `container/agent-runner/src/index.ts` (SUBAGENTS) +
  `tools/security-tools.ts` (webcam_capture, send_message, alert_security,
  open_security_alert, dismiss_security_flag, save_known_person, security_log).
- **Auto-trigger**: `src/index.ts processOwnerMessages` routes `SECURITY ALERT`
  messages to Heimdall (background), only the latest flag, never the main
  orchestrator → no chat spam.
- **Orchestrator → Heimdall direct**: the `tell_heimdall` tool (no Atlas).
- **Close the alert**: `close_security_alert` host callback → `POST /alert/close`
  (Heimdall's normal-dismiss, or the guard's "close the alert" chat command, or
  the STAND DOWN button).
- **Telegram**: alert `send_message` includes `[Image: …]`; the Telegram channel
  sends it as a photo, so alerts + their frames show on your phone.
- **security.db** (`store/security.db`): `security_log` (every flag + assessment,
  engrained host-side recording) + `known_persons` (keyframes for the pHash skip).

## Model

Heimdall shares the orchestrator's model (dashboard `orchestrator:model` —
`gemma4:31b-cloud` here, vision-capable). No fallback — if that model is down,
Heimdall retries (500s) but won't swap models.

## Upgradable (later, not in the demo)

- **Home Assistant** as a plugin/MCP (arm/disarm, sensors, automations).
- **Real guard-dispatch** — swap the `alert_security` mock stub for a real
  HTTP call to a monitoring service.
- **Face-ID** — replace the whole-frame pHash skip with InsightFace embeddings
  for reliable recognition across positions/lighting.
- **More cameras / RTSP** — the detector opens one webcam; multi-camera is a
  config + loop change.