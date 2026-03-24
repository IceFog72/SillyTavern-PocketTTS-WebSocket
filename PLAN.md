# Adaptive Streaming Plan

## Core Insight

**More text = better intonation.** The PocketTTS model generates each sentence using the
same voice context (model_state). Sending 3 sentences together produces natural prosody
across sentence boundaries. Sending 1 sentence at a time sounds choppy.

**Goal:** Send the largest text chunks possible while maintaining gap-free playback.

## Current Server Behavior (already correct)

```
audio.py:145  →  parts = re.split(r'(?<=[.!?])\s+', text)
```

The server already splits incoming text by sentences and generates each one
sequentially with the **same model_state**. Sending "Hello. How are you. I'm fine."
produces one coherent audio with flowing intonation across all 3 sentences.

We do NOT need server-side sentence splitting — it already does this.
We need the server to report timing so the client can adapt chunk sizes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIENT (index.js)                                               │
│                                                                 │
│  LLM text ──→ Sentence Buffer ──→ Chunk Calculator ──→ TTS     │
│                                     │                           │
│                              ┌──────┴──────┐                   │
│                              │  How many   │                   │
│                              │  sentences  │                   │
│                              │  to send?   │                   │
│                              └──────┬──────┘                   │
│                                     │                           │
│  Audio Queue ←── TTS Response ←─────┘                          │
│      │                                                          │
│  Buffer Tracker ──→ logs speed, feeds back to Chunk Calculator  │
└─────────────────────────────────────────────────────────────────┘
         │
         │ WebSocket (persistent)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ SERVER (api.py - /v1/audio/stream)                              │
│                                                                 │
│  Receives text → splits by sentences → generates with same      │
│  model_state → streams audio chunks → sends {"status":"done",   │
│  "audio_duration": 4.2, "gen_time": 2.1}                       │
│                                                                 │
│  New: report timing in done response                            │
└─────────────────────────────────────────────────────────────────┘
```

## Client: Chunk Calculator

### Inputs
- `adpBufferRemaining` — seconds of audio queued ahead of playback
- `adpGenSpeed` — learned ratio: audio_seconds / generation_seconds (EMA smoothed)
- `adpPendingSentences` — complete sentences sitting in buffer, not yet sent

### Decision Table (quality-first)

| Buffer Remaining | Action | Reasoning |
|---|---|---|
| < 1.5s | Send 1 sentence (even partial) | CRITICAL — gap imminent, any audio is better |
| 1.5s–4s | Send 1 sentence | Getting low — send one now |
| 4s–10s | Send 2 sentences together | Comfortable — bigger chunk for better intonation |
| > 10s | Send 3+ sentences | Ahead — maximum quality, group paragraphs |

### Special Cases
- **First text:** Always send first available sentence immediately (buffer=0, need to start)
- **Generation ended:** Flush all remaining text (last chunk, no more coming)
- **Lazy flush (2s idle):** Send whatever is buffered (end of a long pause in LLM output)

### Speed Tracking

```
After each TTS response:
  audioDuration = from server "audio_duration" field OR estimated from blob size
  genTime = time from send to response received
  speed = audioDuration / genTime
  adpGenSpeed = adpGenSpeed * 0.7 + speed * 0.3   // EMA

Example log: "TTS: 1840ms audio in 969ms (1.9x real-time)"
```

### Audio Gap Handling

When playback queue runs empty:
- Create a short silent audio blob (500ms of silence)
- Queue it for playback
- This prevents audio player initialization artifacts
- The silence is imperceptible — next real audio starts right after

```
generateSilence(durationMs) → Blob (WAV format, silent PCM data)
```

## Server: Timing Report

### What changes (minimal)

In `api.py` WebSocket handler, track generation timing and report in done message:

```python
# Before generation
t0 = time.time()

# ... generate ...

# After generation
gen_time = time.time() - t0
# Estimate audio duration from byte count
audio_duration = total_bytes / bytes_per_second[format]

await websocket.send_json({
    "status": "done",
    "audio_duration": audio_duration,
    "gen_time": round(gen_time, 3)
})
```

### Why server reports audio_duration

The client doesn't know the actual audio duration until it decodes the blob.
The server can estimate it from the output byte count:
- WAV: bytes / (sample_rate * channels * bytes_per_sample)
- MP3: bytes / (bitrate / 8) ≈ bytes / 16000

This is faster and more accurate than client-side estimation.

## Files Changed

### pocket-tts-openapi (server)
- `pocket_tts_server/api.py` — WS handler: add timing, report in done message

### SillyTavern-PocketTTS-WebSocket (client)
- `index.js` — Replace sentence streaming with adaptive chunking:
  - Remove toggle (always on)
  - Add chunk calculator
  - Add buffer tracker
  - Add silence generator
  - Add speed learning
  - Fix: don't re-observe same message

### Testing
- `__tests__/pocket-tts.test.js` — Add chunk calculator unit tests
- Manual: watch browser console for "TTS: Xms audio in Yms (Zx real-time)"
