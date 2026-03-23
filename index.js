// PocketTTS — TTS extension for pocket-tts-openapi
// Registers the PocketTTS provider with SillyTavern's TTS system.

import { registerTtsProvider } from '../../tts/index.js';
import { PocketTtsProvider } from './pocket-tts.js';

export function onActivate() {
    registerTtsProvider('PocketTTS', PocketTtsProvider);
}
