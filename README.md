# SillyTavern PocketTTS WebSocket

TTS extension for [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi).
<img width="1857" height="1284" alt="image" src="https://github.com/user-attachments/assets/a6d10597-21bc-467d-86d0-98edcb9e1948" />

## Features

- Sentence-level streaming — audio plays during generation
- Server-reported audio duration per sentence
- Persistent WebSocket connection (single `/v1/audio/stream` endpoint)
- Player bar with seek, volume, speed, and playlist controls
- Auto-discovered voice cloning (`.wav` voices from server)
- CPU/GPU model selection
- Auto-cleanup of played tracks

## Requirements

- [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi) server (default `localhost:8005`)
- SillyTavern

## Development

The extension is written in TypeScript under `src/` and compiled to browser ES modules under `dist/`.
SillyTavern loads `dist/index.js` from `manifest.json`; the root `index.js` is only a compatibility re-export.

```bash
npm install
npm run check
npm run build
```

## Architecture

### Text Processing

Text is split on sentence boundaries (`.!?…`). Short sentences (<20 chars) are merged server-side. Each sentence becomes a track in a flat queue — requests go out in play order.

### WebSocket

Single persistent connection to `/v1/audio/stream`. Requests are fire-and-forget with sequential IDs. Audio chunks arrive independently and are matched to requests by `request_id` on `done` message.

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

## PCM streaming

Set **Streaming** to **Auto** for adaptive streaming or **Off** for buffered playback.
Auto selects a browser-supported format and prefers PCM. Saved explicit streaming formats migrate to Auto.

PCM uses WebSocket and Web Audio. It does not require MediaSource or a browser audio codec.
Click a playback control once to allow audio under the browser's autoplay policy.
The player resamples the 24 kHz mono stream to the device rate.

Playback starts with 60 ms of queued audio. The target grows after underruns and
arrival jitter, up to 600 ms. Stable delivery lowers it toward 60 ms.
Short final chunks drain immediately. Stop and skip cancel scheduled audio.

Validation:

```bash
npm run check
npm run build
npm test
npx playwright install chromium firefox webkit
npm run test:browser
```

The browser check exercises real Web Audio in Chromium, Firefox, and WebKit.
It checks startup, underrun recovery, final draining, and device resampling.

Saved `Live WebM` settings migrate to **Auto**. Each sentence has its own request and playback destination. The removed message-level mode assumed a continuous WebM container and discarded later sentence responses.

`npm run test:browser` checks adaptive playback and the complete three-sentence text → provider → playlist path in Chromium, Firefox, and WebKit. Set `TTS_TEST_ENDPOINT=http://localhost:8005` to also exercise the real WebSocket worker and server.

The playback bar controls both PCM and buffered audio: pause/resume, volume/mute, speed, skip, and stop. Seeking in PCM is limited to audio already received. The seek range grows as more audio arrives. Pausing keeps the current sentence selected while synthesis continues. Received PCM is retained for seeking until its track ends or is stopped.

Browser regression checks exercise the actual bar buttons and sliders, including settings carried into the next sentence.

The selected TTS provider owns the controls. PocketTTS uses its PCM or buffered player. Other providers use SillyTavern’s `#tts_audio`; late events from PocketTTS cannot redirect the controls. Skip completes the current media job, and Stop uses SillyTavern’s queue reset when its stop action is available.
