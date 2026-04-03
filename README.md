# SillyTavern PocketTTS WebSocket

TTS extension for [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi).
<img width="1857" height="1284" alt="image" src="https://github.com/user-attachments/assets/a6d10597-21bc-467d-86d0-98edcb9e1948" />

## Features

- Sentence-level streaming — audio plays during generation
- Server-reported audio duration per sentence
- Persistent WebSocket connection (single `/v1/audio/stream` endpoint)
- Player bar with seek, volume, speed, highlight, and playlist controls
- Auto-discovered voice cloning (`.wav` voices from server)
- CPU/GPU model selection
- Auto-cleanup of played tracks

## Requirements

- [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi) server (default `localhost:8005`)
- SillyTavern

## Architecture

### Text Processing

Text is split on sentence boundaries (`.!?…`). Short sentences (<20 chars) are merged server-side. Each sentence becomes a track in a flat queue — requests go out in play order.

### WebSocket

Single persistent connection to `/v1/audio/stream`. Requests are fire-and-forget with sequential IDs. Audio chunks arrive independently and are matched to requests by `request_id` on `done` message.

### Highlighting

Text highlighting uses substring search against rendered DOM with Unicode normalization for quotes and ellipsis characters.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Server Endpoint | `http://localhost:8005` | Server URL |
| Model | `tts-1` | `tts-1`, `tts-1-hd`, `tts-1-cuda`, `tts-1-hd-cuda` |
| Audio Format | `mp3` | mp3, wav, opus, flac, aac |
| Speed | `1.0` | 0.5–2.0 |
| Temperature | `1.0` | 0.0–2.0 |
| Top P | `1.0` | 0.0–1.0 |

Voice mapping: SillyTavern's TTS Voice Map section.s

## Feedback

Join my Discord: [https://discord.gg/2tJcWeMjFQ](https://discord.gg/2tJcWeMjFQ)
Or find me on the official SillyTavern Discord server.

Support me:
[Patreon](https://www.patreon.com/cw/IceFog72)
