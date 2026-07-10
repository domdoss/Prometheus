# Jarvis — Dockbox Voice

A desktop voice thin client for a Dockbox server. Wake it, speak, and your Dockbox agent replies out loud. All reasoning, tools, and memory live on the server — this app is just ears and a mouth with a hologram UI.

## How it works

- Local Whisper transcribes your speech; the text is sent to the server's `/api/messages`.
- The agent's reply streams back over SSE and is spoken by Kokoro TTS.
- A pywebview hologram window shows state (idle / listening / thinking / speaking).

## Waking it

Three ways to start a conversation:

- **Double clap** (or snap) — an always-on detector listens for two sharp transients in quick succession while idle. It pauses itself during conversation and TTS playback so Jarvis can't wake itself.
- **F9** — global hotkey, works anywhere on the system.
- **Click the button** in the hologram window.

Speak after the beep; a second beep marks the end of your turn. Press/clap again at any time to interrupt.

## Setup

There is no setup wizard, no login, no user account, and no group selection. The app runs in no-auth single-server mode: one local Dockbox server, one implicit group.

```bash
pip install -r requirements.txt
python single.py    # points the client at the local server, clears any stale auth
python main.py
```

`single.py` verifies the server is reachable and writes the base URL to the user config. `main.py` reads it on launch and boots straight in.

## Configuration

Bundled defaults live in `config/settings.yaml`; per-user overrides are written to `~/.config/jarvis/config.yaml` (Linux/macOS) or `%APPDATA%\Jarvis\config.yaml` (Windows). Useful keys:

- `dockbox.base_url` — the server (written by `single.py`)
- `voice.whisper_model` — Whisper model size (default `base`)
- `voice.clap_enabled` — turn the clap wake on/off (default on)
- `voice.clap_threshold` / `voice.clap_crest` — clap sensitivity tuning
- `audio.input_device` / `audio.playback_device` — explicit device indexes (auto-detected otherwise; PipeWire/pulse backends preferred for Bluetooth mics)

## Requirements

- Python 3.10+
- Microphone and speakers
- A running Dockbox server on the local network

## Troubleshooting

- **Clap wake too eager / deaf:** adjust `voice.clap_threshold` (int16 peak, default 9000) and `voice.clap_crest` (peak/RMS ratio, default 4.0).
- **No audio in/out:** set `audio.input_device` / `audio.playback_device` explicitly; check `arecord -l`.
- **"no server configured" on boot:** run `python single.py` first.
- **Packaged (frozen) builds** log to `%APPDATA%\Jarvis\jarvis.log` instead of the console.
