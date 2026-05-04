# Changelog

All notable changes to the SillyTavern PocketTTS WebSocket extension will be documented in this file.

## [0.4.0]

### Added
- **Dynamic Model Fetching**: The extension now actively queries the server's `/v1/models` endpoint when loaded or refreshed to dynamically populate the available language and compute models (e.g., `english-cpu`, `french_24l-gpu`), mirroring the server's dynamically installed `pocket-tts` model catalog.

### Changed
- **Default Models Updated**: Removed legacy, hardcoded `tts-1`, `tts-1-hd`, and `tts-1-cuda` configuration entries from the base UI template.
- **Default Fallback**: Changed the base fallback model selection to `english-cpu` instead of `tts-1` to match the new `pocket-tts` multi-language structural expectations before server synchronization.
