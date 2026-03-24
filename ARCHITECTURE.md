# PocketTTS × SillyTavern: Complete Architecture Reference

For future self with 0 memory of this session.

---

## 1. SillyTavern TTS System

### How TTS Works in SillyTavern

SillyTavern has a built-in TTS system at `public/scripts/extensions/tts/index.js`.

**Core flow:**
```
CHARACTER_MESSAGE_RENDERED event fires
  → onMessageEvent() detects new/changed message
  → processAndQueueTtsMessage() splits by paragraphs (if enabled), pushes to ttsJobQueue
  → moduleWorker() runs every 1s, calls processTtsQueue()
  → processTtsQueue() pops job, calls tts()
  → tts() calls ttsProvider.generateTts(text, voiceId)
  → IF response is async generator: for await (chunk of response) { processResponse(chunk) }
  → IF response is normal: processResponse(response)
  → processResponse() calls addAudioJob(response)
  → addAudioJob() calls response.blob(), pushes {blob, char} to audioJobQueue
  → processAudioJobQueue() calls playAudioData() → <audio> element plays
```

**Key point for providers:** `generateTts()` can return:
1. A `string` (URL) — browser plays directly
2. A `Response` object — `addAudioJob` calls `response.blob()`, then plays
3. An **async generator** yielding `Response` objects — each yield is processed immediately via `processResponse()`, queued and played while next chunks are still generating

**This extension uses option 3** (async generator).

### Extension Loading

Extensions in `data/default-user/extensions/` are served at `/scripts/extensions/third-party/`.

For an extension at `SillyTavern-PocketTTS-WebSocket/index.js`:
- Served URL: `/scripts/extensions/third-party/SillyTavern-PocketTTS-WebSocket/index.js`
- Import TTS core: `../../tts/index.js` → `/scripts/extensions/tts/index.js`
- Import main script: `../../../../script.js` → `/script.js`

The `manifest.json` specifies `"js": "index.js"` and `"hooks": { "activate": "onActivate" }`.

`onActivate()` is called when the extension loads. It must call `registerTtsProvider(name, ProviderClass)` to register the TTS provider.

### TTS Provider Interface

A provider class must implement:
- `loadSettings(settings)` — called on init, restore saved settings
- `settingsHtml` (getter) — HTML for the provider's settings panel
- `checkReady()` — returns boolean, is the provider ready?
- `fetchTtsVoiceObjects()` — returns `[{name, voice_id, lang}]`
- `getVoice(voiceName)` — returns voice object
- `generateTts(text, voiceId)` — **THE KEY METHOD**. Returns Response or async generator
- `previewTtsVoice(voiceId)` — play a preview
- `dispose()` — cleanup

---

## 2. PocketTTS Server

### Location

```
/home/icefog/LLM/pocket-tts-openapi/
```

### Start Command

```bash
cd /home/icefog/LLM/pocket-tts-openapi
source venv/bin/activate
python pocketapi.py
```

Server runs on `http://localhost:8005`.

### Health Check

```bash
curl http://localhost:8005/health
```

### WebSocket Endpoint: `/v1/audio/stream`

**Protocol:**
```
Client → Server: {"text": "Hello world", "voice": "nova", "format": "wav", "speed": 1.0, ...}
Server → Client: binary audio chunks (many small frames)
Server → Client: {"status": "done", "audio_duration": 2.1, "gen_time": 1.05}
```

**Connection is persistent:** Server loops `while True:`, can process multiple requests per connection sequentially.

**Server internally splits text by sentences:**
```python
# audio.py line 145
parts = re.split(r'(?<=[.!?])\s+', text.strip())
for part in parts:
    for chunk in tts_model.generate_audio_stream(model_state=model_state, text_to_generate=part):
        yield chunk
```

Each sentence is generated with the SAME `model_state` (voice context), so intonation flows naturally across sentences.

**Audio chunk size:** WAV 24kHz 16-bit mono = 3840 bytes per frame = ~80ms of audio per frame.

**Generation speed:** Typically 1.5x-2.5x real-time on CPU. 5 seconds of audio takes ~2-3 seconds to generate.

**Server logs per request:**
```
INFO:pocket_tts.models.tts_model:Generated: 5680 ms of audio in 2959 ms so 1.92x faster than real-time
INFO:pocket_tts_server.api:WS: 1 sentences, 15 words, 81 chars | 5.6s audio in 3.4s (1.65x) | voice=Aemeath
```

### Other Endpoints

- `GET /health` — server status, model loaded, device, voice cloning
- `GET /v1/voices` — list available voices (built-in + custom .wav files)
- `POST /v1/audio/speech` — OpenAI-compatible HTTP endpoint
- `GET /tts_stream` — HTTP streaming endpoint (direct URL for audio)

### Voice Cloning

Place `.wav` files (~10 seconds of speech) in the `voices/` directory. Server auto-converts them to `.safetensors` embeddings. They appear in the voice list by filename (without extension).

---

## 3. Extension Architecture

### Files

```
SillyTavern-PocketTTS-WebSocket/
├── index.js          ← Extension entry point, adaptive streaming, sentence splitting
├── pocket-tts.js     ← TTS provider class (WS connection, queue, generateTts)
├── manifest.json     ← Extension metadata
├── __tests__/        ← Jest unit tests
├── TESTING.md        ← Testing guide
├── PLAN.md           ← Design plan
└── README.md         ← User-facing docs
```

### index.js — Extension Entry Point

**Imports:**
```js
import { registerTtsProvider } from '../../tts/index.js';           // TTS core
import { event_types, eventSource } from '../../../../script.js';   // SillyTavern events
import { PocketTtsProvider } from './pocket-tts.js';                // Our provider
```

**onActivate():** Registers the provider and hooks into SillyTavern generation events.

**Adaptive Streaming (currently dormant):** The extension has a MutationObserver system that watches the last `.mes_text` element for text changes during generation. It splits text by sentences, accumulates them, and decides when to send based on audio buffer remaining. This runs in PARALLEL to SillyTavern's TTS system (which calls `generateTts` directly). The adaptive code calls its own `adpGenerateAndPlay()` which uses `generateTtsStreaming()` — a separate method from `generateTts()`.

**Current state:** The main audio path goes through SillyTavern's TTS system → `generateTts()`. The adaptive streaming code in index.js is secondary and may or may not activate depending on whether `GENERATION_STARTED`/`GENERATION_ENDED` events fire.

### pocket-tts.js — TTS Provider

**WebSocket Connection:**
- `_ensureWs()` — creates persistent WebSocket, connects, sets up handlers
- `_disconnectWs()` — closes connection
- `_getWsUrl()` — converts http:// to ws://, appends `/v1/audio/stream`
- Connection is reused across multiple `generateTts` calls

**Request Queue:**
- `_wsQueue` — pending requests waiting for their turn
- `_wsCurrent` — the request currently being processed by the WS
- `_processQueue()` — pops next request, sends WS message
- Sequential: one request at a time per connection

**`generateTts(text, voiceId)` — THE CORE METHOD:**

```js
async *generateTts(text, voiceId) {
    // 1. Split text into sentences
    const parts = text.match(/[^.!?…]+[.!?…]+|[^.!?…]+/g) || [text];

    // 2. For each sentence, send a separate WS request
    for (const sentence of parts) {
        // Create a ReadableStream + request object
        // Queue the request → _processQueue sends WS message
        // _onWsMessage streams binary chunks to the ReadableStream controller
        // On done, controller closes
        // Resolve Promise with Response wrapping the ReadableStream
        yield response;  // ← one Response per sentence
    }
}
```

**Why split by sentences:** Each sentence gets its own WS request. The server generates that one sentence and reports exact `audio_duration` in the done message. No estimation needed.

**How SillyTavern consumes it:**
```js
// SillyTavern's tts() function (tts/index.js line 510-517)
if (typeof response[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response) {
        await processResponse(chunk);  // addAudioJob → blob → play
    }
}
```

Each yielded Response becomes a separate audio job. First sentence plays immediately, second queues behind it, etc. No gaps between sentences.

**`_onWsMessage(event)` — processes WS responses:**
- Binary frames: `ctrl.enqueue(new Uint8Array(event.data))` → adds to ReadableStream
- JSON `{"status":"done", ...}`: closes stream controller, clears `_wsCurrent`, calls `_processQueue()` for next request
- JSON `{"status":"error", ...}`: errors stream controller

**`generateTtsStreaming(text, voiceId)` — alternative method for extension's adaptive code:**
- Returns `{stream: ReadableStream, done: Promise}` — used by `adpStreamViaMediaSource()` in index.js
- Temporarily replaces WS message handler
- NOT used by SillyTavern's TTS system (that uses `generateTts`)

**`lastTiming` — server-reported timing:**
- Updated on every done message: `{audio_duration, gen_time}`
- Used by the extension for speed tracking and buffer estimation

**Voice Management:**
- `fetchTtsVoiceObjects()` — calls `GET /v1/voices`, returns `[{name, voice_id, lang}]`
- Falls back to hardcoded list if server unreachable
- Custom voices (`.wav` files in server's `voices/` dir) appear automatically

**Settings:**
- `provider_endpoint` — server URL (default `http://localhost:8005`)
- `voice` — default voice (default `nova`)
- `format` — mp3/wav/opus/flac/aac (default `mp3`)
- `speed` — playback speed 0.5-2.0 (default 1.0)
- `temperature` — model temperature 0.0-2.0 (default 1.0)
- `top_p` — nucleus sampling 0.0-1.0 (default 1.0)
- `model` — tts-1/tts-1-hd/tts-1-cuda/tts-1-hd-cuda (default `tts-1`)

---

## 4. Import Paths

Extension at `/scripts/extensions/third-party/SillyTavern-PocketTTS-WebSocket/`:

| Import | Resolves to | Notes |
|--------|-------------|-------|
| `../../tts/index.js` | `/scripts/extensions/tts/index.js` | TTS core, exports `registerTtsProvider`, `saveTtsProviderSettings`, `getPreviewString` |
| `../../../../script.js` | `/script.js` | Main script, re-exports `event_types`, `eventSource` from `events.js` |
| `./pocket-tts.js` | same dir | Our provider class |

**Wrong paths that were tried:**
- `../tts/index.js` → `/scripts/extensions/third-party/tts/index.js` (WRONG, doesn't exist)
- `../../../events.js` → `/scripts/third-party/events.js` (WRONG)
- `../../events.js` → `/scripts/extensions/events.js` (WRONG)

---

## 5. Audio Format Details

**WAV** (recommended for streaming):
- 24kHz, 16-bit, mono PCM
- 48,000 bytes per second
- 3,840 bytes per chunk = 80ms per chunk
- Server streams naturally (no FFmpeg needed)

**MP3** (default):
- ~16,000 bytes per second (128kbps)
- Requires FFmpeg re-encoding on server
- More bandwidth-efficient but adds latency

---

## 6. Test Infrastructure

**Location:** `__tests__/pocket-tts.test.js`

**Run:**
```bash
cd /home/icefog/LLM/SillyTavern-Launcher/SillyTavern/data/default-user/extensions/SillyTavern-PocketTTS-WebSocket
bash __tests__/run-tests.sh
```

Uses Jest with jsdom environment. Tests the provider class methods: `_getWsUrl`, `_getMimeType`, `_onWsMessage`, request queue, settings, etc.

**Server tests:**
```bash
cd /home/icefog/LLM/pocket-tts-openapi
source venv/bin/activate
python -m pytest --tb=short -q -k "not websocket"
```

**WebSocket streaming test:**
```bash
cd /home/icefog/LLM/pocket-tts-openapi
source venv/bin/activate
python test_ws_streaming.py
```

Tests real-time streaming behavior: chunk arrival times, gaps between sentences, total throughput.

---

## 7. Known Issues & Future Work

### First message may not play TTS
**Symptom:** First character message in a conversation produces no audio. Second message works.
**Status:** Under investigation. Added detailed logging to `generateTts`, `_processQueue`, `_onWsMessage`.
**Possible causes:** WebSocket connection race condition, browser autoplay policy, or SillyTavern TTS initialization timing.

### Adaptive streaming in index.js is secondary
The MutationObserver-based streaming in index.js runs in parallel to SillyTavern's TTS system. It calls its own `adpGenerateAndPlay()` → `generateTtsStreaming()` which temporarily replaces the WS message handler. This can conflict with the queue-based `generateTts()` if both run simultaneously.

### Server doesn't report per-sentence boundaries
The server splits by sentences internally but doesn't send markers between them. The client splits by sentences and sends each separately to get exact duration per sentence. This adds ~5-10ms WS round-trip overhead per sentence but provides exact audio boundaries.

### MediaSource API (unused currently)
The extension has MediaSource streaming code (`adpStreamViaMediaSource`) that could enable real-time audio playback without waiting for blob accumulation. Currently not used because `generateTts` returns an async generator and SillyTavern handles the queuing.

---

## 8. Quick Reference: Adding New Features

### To change how sentences are split:
Edit `pocket-tts.js` line 251: `text.match(/[^.!?…]+[.!?…]+|[^.!?…]+/g)`

### To change the WS protocol:
Edit `_processQueue()` (sends request) and `_onWsMessage()` (handles response) in `pocket-tts.js`.

### To add a new setting:
1. Add to `defaultSettings` in pocket-tts.js
2. Add HTML control in `settingsHtml` getter
3. Add to `onSettingsChange()` and `loadSettings()`
4. Use in `_processQueue()` when building the WS message

### To change batch size / chunking:
The generator in `generateTts` currently sends one sentence per WS request. To batch multiple sentences, change the loop to accumulate sentences before sending.

### To test a change:
```bash
# Run unit tests
bash __tests__/run-tests.sh

# Test server directly
curl http://localhost:8005/health

# Test WS streaming
python test_ws_streaming.py
```
