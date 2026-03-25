# SillyTavern PocketTTS WebSocket

**Dedicated TTS extension for [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi)** — the fastest way to use Pocket TTS with SillyTavern.

- 🎯 **Sentence-level streaming** — audio plays while the server generates, no waiting for full message
- 📊 **Exact audio duration** — server reports real duration per sentence, no estimation gaps
- 🔌 **Persistent WebSocket** — one connection reused across all requests, minimal overhead
- 🎮 **Built-in player bar** — seek, volume, speed controls above the chat
- 🎭 **Voice cloning** — auto-discovers custom `.wav` voices from the server
- ⚡ **Model selection** — choose CPU/GPU, fast/quality tiers

## Requirements

- [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi) server running (default `localhost:8005`)
- SillyTavern

## Installation

Copy or symlink the extension folder into SillyTavern's user extensions:

```
SillyTavern/data/default-user/extensions/SillyTavern-PocketTTS-WebSocket/
├── index.js
├── pocket-tts.js
├── tts-bar.js
├── tts-bar.css
└── manifest.json
```

Then refresh SillyTavern. Select **PocketTTS** from the TTS provider dropdown.

## How It Works

### Sentence-Level Generation

Instead of sending the entire message or paragraph as one TTS request, the extension splits text by big sentences and sends each separately.

Short sentences are merged together (minimum 20 chars) to avoid choppy audio.

### Persistent WebSocket

The extension maintains a single WebSocket connection to the server (`/v1/audio/stream`). All sentence requests are queued and processed sequentially on this connection. No reconnect overhead.

### Async Generator

SillyTavern's TTS system supports async generators. `generateTts()` yields one `Response` per sentence. Each yield is processed immediately by SillyTavern's audio queue — audio starts playing while the server is still generating later sentences.

### Player Bar

A floating bar above the chat shows when TTS is enabled:

```
🔊  ▶  ⏹  0:02 / 0:05  [====seek====]  🔊 [===vol===]  1.0x  ⬇
```

- **Play/Pause** — controls the TTS audio element
- **Stop** — stops and clears audio
- **Seek** — drag to jump within the current audio
- **Volume** — slider + mute toggle
- **Speed** — click to cycle through 0.7x → 1.5x
- **Download** — saves current audio as file
- **Toggle** — enables/disables TTS (synced with SillyTavern's TTS toggle)

Volume and speed persist across sessions via `localStorage`. Bar visibility follows SillyTavern's TTS enabled state.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Server Endpoint | `http://localhost:8005` | Pocket TTS server URL |
| Model | `tts-1` | Model tier: `tts-1` (fast CPU), `tts-1-hd` (quality CPU), `tts-1-cuda` (fast GPU), `tts-1-hd-cuda` (quality GPU) |
| Audio Format | `mp3` | Output format: mp3, wav, opus, flac, aac |
| Speed | `1.0` | Playback speed (0.5–2.0) |
| Temperature | `1.0` | Model randomness (0.0–2.0) |
| Top P | `1.0` | Nucleus sampling (0.0–1.0) |

Voice mapping is configured in SillyTavern's TTS Voice Map section — assign voices to character names.

## Server Logs

The server logs sentence/word counts and timing per WebSocket request:

```
INFO:pocket_tts_server.api:WS: 1 sentences, 15 words, 81 chars | 5.6s audio in 3.4s (1.65x) | voice=Aemeath
```

## Audio Warmup

On first generation, 2 seconds of near-silent audio plays to initialize the audio pipeline. This prevents volume fade-in artifacts on some systems. Only runs once per page load.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Provider not in dropdown | Check browser console for import errors. Ensure server is running. |
| "Disconnected" status | Verify server endpoint URL. Check `curl http://localhost:8005/health`. |
| Empty voice list | Check server CORS settings. Try refreshing voices. |
| Choppy audio | Very short sentences are merged automatically (min 20 chars). If still choppy, check server logs for generation speed. |
| First message no audio | Known SillyTavern issue with swipe regeneration in new chats. Not provider-specific. |
| Bar not showing | Ensure TTS is enabled in SillyTavern settings. Bar visibility follows `extension_settings.tts.enabled`. |

### WebSocket & Connection Issues

The extension uses a persistent WebSocket connection. If you see "Disconnected" or "WebSocket connection failed" in the browser console:

1. **CORS (Cross-Origin Resource Sharing)**: If SillyTavern and the PocketTTS server are on different machines or ports, the server must allow SillyTavern's origin. Ensure `pocket-tts-openapi` is started with `--cors-origins="*"` or your specific SillyTavern URL.
2. **SSL/HTTPS vs HTTP**:
   - If SillyTavern is running on **HTTPS**, your browser will block **ws://** (insecure) connections. You must use **wss://** and have a valid SSL certificate on the PocketTTS server (e.g., via a reverse proxy like Nginx or Caddy).
   - If SillyTavern is on **HTTP**, use **ws://**.
3. **Port Conflicts**: Ensure no other service is using port `8005`. You can change the port on the server with `--port 8006` and update the endpoint in SillyTavern.
4. **Firewalls**: If running the server on a different machine, ensure port `8005` is open in the server's firewall (ufw, iptables, etc.).
5. **Reverse Proxies**: If using Nginx/Apache as a proxy, ensure it is configured to handle WebSocket upgrades:
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```


## License

Same as [pocket-tts-openapi](https://github.com/IceFog72/pocket-tts-openapi).
