# Changelog

All notable changes to the SillyTavern PocketTTS WebSocket extension will be documented in this file.

## [Unreleased]

### Added
- **Multi-voice**: SillyTavern's Multi-voice option now works with PocketTTS. Quoted text, `*asterisk*` text and other text use their own voice map entries while streaming. The extension no longer forces the option off.
- **Only narrate "quotes"**: SillyTavern's option now works with PocketTTS. Quoted text streams as usual. A message without quotes is narrated in full when it ends, matching SillyTavern.

### Fixed
- **Long Message Narration**: Sends are paced to 4 phrases in flight. Narrating a long message at once no longer hits the server's rate limit or queue limit and stalls for about a minute. Timeouts start when a phrase is sent, not when it is queued.
- **Top P Setting Removed**: Pocket TTS 3.3 ignores `top_p`, and slider values below 0.1 made the server reject every request.
- **Web Worker Startup**: Fixed the TypeScript build regression where `ws-worker.js` was emitted as an ES module but loaded as a classic worker, preventing websocket connections from opening.
- **Manual Narrate Button**: Restored SillyTavern's message Narrate button path by forcing PocketTTS readiness checks, resetting stale websocket sessions, and sending `text.done` after manual message flushes.
- **Stale Queue Cleanup**: Clearing or restarting playback now rejects old pending websocket requests, clears send/audio buffers, and starts a fresh worker instead of carrying dead pending tracks forward.
- **Merged Track Playback**: Delayed playback by one tick after merged audio resolves so absorbed text segments can update the playable track before highlight and playback begin.
- **Highlight Matching**: Improved highlight matching for merged tracks that span paragraphs or rendered HTML boundaries, avoiding tiny partial matches and skipping whitespace-only highlight marks.
- **PCM Stream Playback**: Reworked experimental PCM streaming to use WebAudio sequencing with a small startup prebuffer and start/end fades, reducing clicks and preventing multiple streamed tracks from playing at once.

### Changed
- **Narrate Interception**: Added both capture-phase and delegated click handling for `.mes_narrate`, plus keyboard activation support, to make manual narration less dependent on SillyTavern event ordering.
- **Diagnostics**: Added detailed `[pocketTTS-WS]` console logging for activation, narrate handling, provider queueing, worker lifecycle, and websocket traffic.
- **Streaming Transport**: When WebAudio is available, websocket requests now ask the PocketTTS server for raw PCM streaming instead of relying on browser MediaSource support for MP3/WebM containers.

## [0.4.0]

### Added
- **Dynamic Model Fetching**: The extension now actively queries the server's `/v1/models` endpoint when loaded or refreshed to dynamically populate the available language and compute models (e.g., `english-cpu`, `french_24l-gpu`), mirroring the server's dynamically installed `pocket-tts` model catalog.

### Changed
- **Default Models Updated**: Removed legacy, hardcoded `tts-1`, `tts-1-hd`, and `tts-1-cuda` configuration entries from the base UI template.
- **Default Fallback**: Changed the base fallback model selection to `english-cpu` instead of `tts-1` to match the new `pocket-tts` multi-language structural expectations before server synchronization.
