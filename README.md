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
| Model | `english-cpu` | Dynamically populated from server (e.g., `english-cpu`, `french_24l-gpu`) |
| Audio Format | `mp3` | mp3, wav, opus, flac, aac |
| Speed | `1.0` | 0.5–2.0 |
| Temperature | `1.0` | 0.0–2.0 |
| Top P | `1.0` | 0.0–1.0 |

Voice mapping: SillyTavern's TTS Voice Map section.

### GPU VRAM Overhead (CUDA Context)
When using a `-gpu` model variant, you may notice a lingering ~170 MB of VRAM usage even after TTS generation finishes and you switch back to a `-cpu` model. **This is not a memory leak.**

Whenever a PyTorch application initializes the GPU for the first time, the NVIDIA driver creates a "CUDA context" for that Python process. This context loads essential GPU libraries (like cuBLAS/cuDNN handles) and driver state into VRAM. Depending on your driver version and GPU architecture, this base footprint is typically between 150 MB and 300 MB.

This overhead is a hard architectural limitation of PyTorch and CUDA. Once a Python process creates a CUDA context, that memory is locked to the process until the backend server itself is shut down. However, the heavy components (the 1GB+ TTS model weights) are successfully freed when switching to a `-cpu` model in the extension UI, leaving the vast majority of your VRAM completely free for your LLMs and other tasks.

## Feedback

Join my Discord: [https://discord.gg/2tJcWeMjFQ](https://discord.gg/2tJcWeMjFQ)
Or find me on the official SillyTavern Discord server.

Support me:
[Patreon](https://www.patreon.com/cw/IceFog72)
