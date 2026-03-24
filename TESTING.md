# Testing SillyTavern-PocketTTS-WebSocket

## Prerequisites

- pocket-tts-openapi server running on `localhost:8005`
- SillyTavern running (for browser tests)
- Node.js (for unit tests)

## 1. Server Health Check (command line)

Verify the server is up before touching SillyTavern:

```bash
curl http://localhost:8005/health | jq
```

Expected:
```json
{
  "status": "ok",
  "model_loaded": true,
  "device": "cpu",
  "sample_rate": 24000,
  "voice_cloning": true,
  "hf_authenticated": true
}
```

Check available voices:
```bash
curl http://localhost:8005/v1/voices | jq
```

## 2. WebSocket Smoke Test (command line)

Use the server's own test script to verify WS works:

```bash
cd /home/icefog/LLM/pocket-tts-openapi
source venv/bin/activate
python test_websocket.py ws://localhost:8005/v1/audio/stream
```

Expected output: chunks received, file saved to `/tmp/ws_test.mp3`.

## 3. Unit Tests (Jest)

Run from the extension directory:

```bash
cd /home/icefog/LLM/SillyTavern-Launcher/SillyTavern/data/default-user/extensions/SillyTavern-PocketTTS-WebSocket
bash __tests__/run-tests.sh
```

Or with the SillyTavern test runner:

```bash
cd /home/icefog/LLM/SillyTavern-Launcher/SillyTavern
node --experimental-vm-modules tests/node_modules/.bin/jest \
  --config data/default-user/extensions/SillyTavern-PocketTTS-WebSocket/__tests__/jest.config.js
```

What the tests cover (38 tests):
- `MODEL_OPTIONS` — 4 model tiers present
- `defaultSettings` — correct defaults for all fields
- `settingsHtml` — all UI elements rendered, no streaming checkbox
- `_getWsUrl` — http→ws, https→wss, trailing slash, custom path
- `_getMimeType` — mp3/wav/opus/flac/aac/unknown
- `_disconnectWs` — cleanup, null safety
- Initial state — ready=false, empty voices, null ws

## 4. Browser Testing (SillyTavern UI)

### 4a. Extension loads

1. Open SillyTavern in browser
2. Go to **Extensions → TTS**
3. In the provider dropdown, select **PocketTTS**
4. Open browser console (F12), check for errors

Expected console output:
```
PocketTTS: Settings loaded
```

No errors about imports or missing modules.

### 4b. Settings UI

Verify the settings panel shows:
- Server Endpoint input (default: `http://localhost:8005`)
- Connection status indicator (green dot = connected)
- Server info line (device, sample rate, cloning status)
- Model dropdown (tts-1, tts-1-hd, tts-1-cuda, tts-1-hd-cuda)
- Format dropdown (MP3, WAV, Opus, FLAC, AAC)
- Speed slider (0.5–2.0)
- Temperature slider (0.0–2.0)
- Top P slider (0.0–1.0)

No streaming checkbox should be visible.

### 4c. Voice discovery

1. Click the **Voices** button (head icon) in TTS panel
2. Verify the popup lists all server voices

Expected voices:
- OpenAI aliases: alloy, echo, fable, nova, onyx, shimmer
- PocketTTS: alba, azelma, cosette, eponine, fantine, javert, jean, marius
- Any custom voices you added to `voices/` directory

### 4d. Voice preview

1. In the voices popup, click the play button next to any voice
2. Audio should play through WebSocket

Check browser console for:
```
PocketTTS: WS generate, voice="nova", 43 chars
PocketTTS: WebSocket connected
```

### 4e. Voice map assignment

1. In the TTS panel, expand the **Voice Map** section
2. Assign voices to characters
3. Click **Apply** / refresh

### 4f. Live TTS generation

1. Open a chat with a character that has a voice assigned
2. Send a message, wait for character reply
3. TTS should auto-play the response via WebSocket

Check browser console for generation logs.

### 4g. Model switching

1. Change the **Model** dropdown to `tts-1-hd`
2. Send another message
3. Audio should regenerate (slower but higher quality)
4. Switch to `tts-1-cuda` (requires GPU on server)
5. Verify generation still works

### 4h. Parameter changes

Test that settings persist across page reload:
1. Change speed to 1.5, temperature to 0.5
2. Reload the page (F5)
3. Open TTS settings — values should be restored

## 5. Integration Test Script

A quick end-to-end test you can paste in browser console after selecting PocketTTS:

```javascript
// In SillyTavern browser console
const p = window._pttsProvider;
console.log('Provider:', !!p);
console.log('Ready:', p.ready);
console.log('Voices:', p.voices.length);
console.log('Model:', p.settings.model);

// Test WebSocket generation directly
p.generateTts('Hello from test', 'nova').then(resp => {
    console.log('Got response:', resp.status);
    return resp.blob();
}).then(blob => {
    console.log('Blob:', blob.type, blob.size, 'bytes');
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
}).catch(err => console.error('Failed:', err));

// Check timing from last generation
console.log('Last timing:', p.lastTiming);
```

## 6. Adaptive Streaming Verification

Adaptive streaming is **always on** — no toggle. To verify it works:

1. Enable TTS auto-generation in SillyTavern settings
2. Start a chat with a character that has a voice mapped
3. Send a message, watch the LLM generate
4. Open browser console (F12)

Expected console output during streaming:
```
PocketTTS: Adaptive observer started on mes 42
PocketTTS: 1840ms audio in 969ms (1.9x, ema 1.9x) | buffer 0.0s | "Hello, how are you doing tod…"
PocketTTS: 3200ms audio in 1680ms (1.9x, ema 1.9x) | buffer 1.8s | "I'm quite well thank you. The weather is lovely…"
PocketTTS: gap padded with 500ms silence
PocketTTS: 2100ms audio in 1100ms (1.9x, ema 1.9x) | buffer 0.5s | "Indeed it is a beautiful day…"
```

What to look for:
- **`buffer` increases** as audio queues up — should stay above 0 after first sentence
- **`ema` converges** to the server's real speed (usually 1.5-2.5x)
- **Chunk text gets longer** as buffer grows (1 sentence → 2-3 sentences)
- **"gap padded"** appears if buffer runs dry — 500ms silence prevents audio glitches
- **`generateTtsTimed`** in console shows server-reported `audio_duration` and `gen_time`

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Provider not in dropdown | Extension not loaded | Check manifest.json `js` field, check browser console for import errors |
| "Disconnected" status | Server not running | Start pocket-tts-openapi, check endpoint URL |
| Empty voice list | `/v1/voices` unreachable | Check CORS, check server logs |
| WS connection fails | Firewall / wrong URL | Verify `ws://host:8005/v1/audio/stream` accessible |
| Audio plays but garbled | Wrong format | Try WAV format, check FFmpeg installed on server |
| Model switch does nothing | Model not supported | Check server logs for model loading errors |
| Import error in console | Wrong relative paths | `index.js` must use `../tts/index.js` not `../../tts/index.js` |
