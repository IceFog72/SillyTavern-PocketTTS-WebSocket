// PocketTTS — TTS extension for pocket-tts-openapi
// Adaptive streaming: quality-first chunking with server timing feedback.

import { registerTtsProvider } from '../../tts/index.js';
import { event_types, eventSource } from '../../../../script.js';
import { PocketTtsProvider } from './pocket-tts.js';

// ─── Adaptive Streaming State ──────────────────────────────────────

const adp = {
    // Text accumulation
    buffer: '',               // incomplete text (no sentence boundary yet)
    pending: [],              // complete sentences waiting to be sent

    // Audio playback queue
    queue: [],                // [{blob, url, duration}]
    isPlaying: false,
    currentAudio: null,
    currentStart: 0,

    // Speed learning
    genSpeed: 2.2,            // EMA of audio_sec / gen_sec, seeded from observed ~2.2x

    // Observer
    observer: null,
    element: null,
    lastLen: 0,
    observedMesId: null,

    // Timers
    flushTimer: null,
    decisionTimer: null,      // debounce: accumulate before deciding
};

// ─── Sentence Detection ────────────────────────────────────────────

// Matches sentence-ending punctuation followed by whitespace or end-of-string.
// Handles .!?… with optional closing quotes/brackets.
const SENTENCE_END = /[.!?…][)"'\u2019\u201D\u00BB\u300D\u300F\uFF02]*\s+/g;

function splitSentences(text) {
    const result = [];
    SENTENCE_END.lastIndex = 0;
    let lastIdx = 0;
    let match;

    while ((match = SENTENCE_END.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const s = text.substring(lastIdx, end).trim();
        if (s.length > 0) result.push(s);
        lastIdx = end;
    }

    const remainder = text.substring(lastIdx);
    return { sentences: result, remainder };
}

// ─── Buffer Duration Estimation ────────────────────────────────────

function estimateAudioDuration(blob, textLen) {
    // Use server-reported timing if available, otherwise estimate
    // Approximate speech rate: ~15 chars/sec
    return textLen / 15;
}

function bufferSecondsRemaining() {
    if (adp.queue.length === 0 && !adp.isPlaying) return 0;

    let total = 0;
    for (const item of adp.queue) {
        total += item.duration;
    }

    if (adp.isPlaying && adp.currentAudio) {
        const elapsed = (performance.now() - adp.currentStart) / 1000;
        const remaining = adp.currentAudio.duration - elapsed;
        total += Math.max(0, remaining);
    }

    return total;
}

// ─── Chunk Size Decision (quality-first) ───────────────────────────

function decideChunkSize() {
    const buf = bufferSecondsRemaining();
    const n = adp.pending.length;

    // First send — no audio yet, start playback ASAP but cap at 3 sentences
    // so chunks are reasonable (~10-15s of audio) and first audio plays quickly
    if (adp.queue.length === 0 && !adp.isPlaying) return Math.min(3, Math.max(1, n));

    // CRITICAL buffer — gap imminent
    if (buf < 1.5) return 1;

    // Low buffer — send one sentence
    if (buf < 4) return 1;

    // Comfortable — send 2 sentences for better intonation
    if (buf < 10) return Math.min(2, n);

    // Ahead — send 3+ sentences for maximum quality
    return Math.min(3, n);
}

// ─── Generate Silent Audio (gap padding) ───────────────────────────

function generateSilenceWav(durationMs) {
    const sampleRate = 24000;
    const numSamples = Math.floor(sampleRate * durationMs / 1000);
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = numSamples * blockAlign;
    const fileSize = 36 + dataSize;

    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);

    // RIFF header
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, fileSize, true);
    writeStr(view, 8, 'WAVE');

    // fmt chunk
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    // PCM data is all zeros = silence

    return new Blob([buf], { type: 'audio/wav' });
}

function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}

// ─── Audio Playback ────────────────────────────────────────────────

function playNextInQueue() {
    if (adp.isPlaying || adp.queue.length === 0) return;
    adp.isPlaying = true;

    const item = adp.queue.shift();
    const audio = item.audio || new Audio(item.url);

    adp.currentAudio = audio;
    adp.currentStart = performance.now();

    const cleanup = () => {
        if (item.url) URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        adp.currentAudio = null;

        if (adp.queue.length === 0 && adp.active) {
            const silence = generateSilenceWav(500);
            const sUrl = URL.createObjectURL(silence);
            adp.queue.push({ url: sUrl, duration: 0.5 });
            console.debug('PocketTTS: gap padded with 500ms silence');
        }
        playNextInQueue();
    };

    audio.onended = cleanup;
    audio.onerror = cleanup;

    // Streaming item: audio is already playing (pump called play() on first chunk)
    if (item.playStarted) return;

    // Legacy item: start playback now
    audio.play().catch(() => cleanup());
}

// ─── TTS Generation with Real-Time Streaming ───────────────────────

const MIME_BY_FORMAT = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/ogg; codecs="opus"',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    flac: 'audio/flac',
};

function getMimeType(format) {
    return MIME_BY_FORMAT[format] || 'audio/mpeg';
}

async function adpGenerateAndPlay(text) {
    const provider = window._pttsProvider;
    if (!provider || !provider.ready) return;

    const voiceMap = window.extension_settings?.tts?.voiceMap || {};
    const context = window.SillyTavern?.getContext?.();
    const charName = context?.name2 || '';
    const voiceName = voiceMap[charName] || voiceMap[''] || provider.settings.voice;

    try {
        const t0 = performance.now();
        const format = provider.settings.format;
        const mime = getMimeType(format);

        // Use MediaSource for real-time playback if supported
        const msSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
        console.debug(`PocketTTS: format=${format} mime="${mime}" MediaSource=${msSupported}`);

        if (msSupported) {
            console.debug('PocketTTS: trying MediaSource streaming...');
            try {
                await adpStreamViaMediaSource(provider, text, voiceName, mime, t0);
                console.debug('PocketTTS: MediaSource streaming completed');
            } catch (msErr) {
                console.warn('PocketTTS: MediaSource failed, falling back to legacy:', msErr);
                await adpGenerateAndPlayLegacy(provider, text, voiceName, t0);
            }
        } else {
            console.debug('PocketTTS: MediaSource not supported, using legacy blob');
            await adpGenerateAndPlayLegacy(provider, text, voiceName, t0);
        }
    } catch (err) {
        console.error('PocketTTS generation error:', err);
    }
}

async function adpStreamViaMediaSource(provider, text, voiceName, mime, t0) {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    const audio = new Audio();
    audio.src = url;

    // Queue entry — playNextInQueue handles onended/onerror/play
    const queueItem = { audio, url, duration: text.length / 15, playStarted: false };
    adp.queue.push(queueItem);
    playNextInQueue();

    try {
        await new Promise((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
            setTimeout(() => reject(new Error('MediaSource timeout')), 5000);
        });
    } catch (e) {
        console.warn('PocketTTS: MediaSource sourceopen timeout, falling back to legacy');
        URL.revokeObjectURL(url);
        return adpGenerateAndPlayLegacy(provider, text, voiceName, t0);
    }

    let sourceBuffer;
    try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch (e) {
        console.warn('PocketTTS: addSourceBuffer failed for ' + mime + ', falling back to legacy', e);
        URL.revokeObjectURL(url);
        return adpGenerateAndPlayLegacy(provider, text, voiceName, t0);
    }

    console.debug('PocketTTS: MediaSource streaming active, ' + text.length + ' chars');

    const { stream, done } = await provider.generateTtsStreaming(text, voiceName);
    const reader = stream.getReader();
    let firstChunkTime = 0;

    // Pump chunks to MediaSource as they arrive
    async function pump() {
        while (true) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;

            if (!firstChunkTime) {
                firstChunkTime = performance.now();
                queueItem.playStarted = true;
                // Start playback — if playNextInQueue already set this as current, audio plays now
                audio.play().catch(() => {});
            }

            while (sourceBuffer.updating) {
                await new Promise(r => sourceBuffer.addEventListener('updateend', r, { once: true }));
            }
            sourceBuffer.appendBuffer(value);
        }

        while (sourceBuffer.updating) {
            await new Promise(r => sourceBuffer.addEventListener('updateend', r, { once: true }));
        }
        if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }
    }

    const pumpPromise = pump();
    const timing = await done;
    await pumpPromise;

    const genTime = (performance.now() - t0) / 1000;
    const serverDuration = timing.audio_duration;
    const duration = serverDuration > 0 ? serverDuration : (text.length / 15);
    const speed = duration / (timing.gen_time || genTime);
    adp.genSpeed = adp.genSpeed * 0.7 + speed * 0.3;
    queueItem.duration = duration;

    const ttfc = firstChunkTime ? Math.round(firstChunkTime - t0) : '?';
    console.debug(
        `PocketTTS: ${Math.round(duration * 1000)}ms audio, gen ${Math.round(genTime * 1000)}ms, ` +
        `first chunk ${ttfc}ms (${speed.toFixed(1)}x, ema ${adp.genSpeed.toFixed(1)}x) | ` +
        `buffer ${bufferSecondsRemaining().toFixed(1)}s | "${text.substring(0, 40)}…"`
    );
}

async function adpGenerateAndPlayLegacy(provider, text, voiceName, t0) {
    const response = await provider.generateTts(text, voiceName);
    const genTime = (performance.now() - t0) / 1000;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const serverDuration = provider.lastTiming.audio_duration;
    const serverGenTime = provider.lastTiming.gen_time || genTime;
    const duration = serverDuration > 0 ? serverDuration : (text.length / 15);
    const speed = duration / serverGenTime;
    adp.genSpeed = adp.genSpeed * 0.7 + speed * 0.3;

    adp.queue.push({ blob, url, duration });
    playNextInQueue();

    console.debug(
        `PocketTTS [legacy]: ${Math.round(duration * 1000)}ms audio in ${Math.round(serverGenTime * 1000)}ms ` +
        `(${speed.toFixed(1)}x, ema ${adp.genSpeed.toFixed(1)}x) | ` +
        `buffer ${bufferSecondsRemaining().toFixed(1)}s | "${text.substring(0, 40)}…"`
    );
}

// ─── Send Chunk ────────────────────────────────────────────────────

function adpSendChunk(count) {
    if (count <= 0 || adp.pending.length === 0) return;

    const toSend = adp.pending.splice(0, count);
    const text = toSend.join(' ');
    adpGenerateAndPlay(text);
}

function adpFlushAll() {
    // Cancel pending timers
    if (adp.decisionTimer) {
        clearTimeout(adp.decisionTimer);
        adp.decisionTimer = null;
    }
    clearFlushTimer();

    // Combine ALL remaining text into one request — last chunk gets full context
    const parts = [];
    if (adp.pending.length > 0) {
        parts.push(adp.pending.join(' '));
    }
    if (adp.buffer.trim().length > 0) {
        parts.push(adp.buffer.trim());
    }

    if (parts.length > 0) {
        adpGenerateAndPlay(parts.join(' '));
    }

    adp.buffer = '';
    adp.pending = [];
}

// ─── Decision Timer (debounce) ─────────────────────────────────────

// Wait 300ms after last sentence boundary before deciding what to send.
// This lets the LLM generate more text, so we batch 2-3 sentences together
// instead of sending them one at a time.

function restartDecisionTimer() {
    if (adp.decisionTimer) clearTimeout(adp.decisionTimer);
    adp.decisionTimer = setTimeout(() => {
        adp.decisionTimer = null;
        evaluateAndSend();
    }, 300);
}

function evaluateAndSend() {
    if (adp.pending.length === 0) return;

    const toSend = decideChunkSize();
    if (toSend > 0) {
        adpSendChunk(toSend);
    }
    startFlushTimer();
}

// ─── Lazy Flush Timer ──────────────────────────────────────────────

function startFlushTimer() {
    clearFlushTimer();
    adp.flushTimer = setTimeout(() => {
        if (adp.pending.length > 0) {
            adpSendChunk(adp.pending.length);
        }
        if (adp.buffer.trim().length > 3) {
            adpGenerateAndPlay(adp.buffer.trim());
            adp.buffer = '';
        }
    }, 1500);
}

function clearFlushTimer() {
    if (adp.flushTimer) {
        clearTimeout(adp.flushTimer);
        adp.flushTimer = null;
    }
}

// ─── Mutation Observer ─────────────────────────────────────────────

function findLastMesText() {
    const els = document.querySelectorAll('.mes_text');
    return els.length > 0 ? els[els.length - 1] : null;
}

function adpStartObserver() {
    adpStopObserver();

    const el = findLastMesText();
    if (!el) return;

    const mesId = el.closest('.mes')?.getAttribute('mesid');

    // Don't re-observe the same message
    if (mesId === adp.observedMesId && adp.lastLen > 0) return;

    adp.element = el;
    adp.observedMesId = mesId;
    adp.lastLen = 0;
    adp.buffer = '';
    adp.pending = [];

    adp.observer = new MutationObserver(() => {
        if (!adp.active) return;

        const fullText = el.innerText || el.textContent || '';
        if (fullText.length <= adp.lastLen) return;

        const newText = fullText.substring(adp.lastLen);
        adp.lastLen = fullText.length;

        // Add new text to buffer and split sentences
        adp.buffer += newText;
        const { sentences, remainder } = splitSentences(adp.buffer);

        if (sentences.length > 0) {
            adp.pending.push(...sentences);
            adp.buffer = remainder;

            // Don't decide immediately — debounce to accumulate sentences
            // The LLM generates tokens faster than sentences complete,
            // so waiting 300ms lets us batch 2-3 sentences together.
            restartDecisionTimer();
        }
    });

    adp.observer.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    console.debug('PocketTTS: Adaptive observer started on mes ' + mesId);
}

function adpStopObserver() {
    if (adp.observer) {
        adp.observer.disconnect();
        adp.observer = null;
    }
    clearFlushTimer();
    if (adp.decisionTimer) {
        clearTimeout(adp.decisionTimer);
        adp.decisionTimer = null;
    }
}

// ─── Generation Lifecycle ──────────────────────────────────────────

let audioWarmupDone = false;

function warmupAudio() {
    if (audioWarmupDone) return;
    audioWarmupDone = true;

    // Play 2s silence to wake up audio pipeline (prevents volume fade-in on some systems)
    const silence = generateSilenceWav(2000);
    const url = URL.createObjectURL(silence);
    const audio = new Audio(url);
    audio.volume = 0.01; // nearly silent, just enough to init the pipeline
    audio.play().then(() => {
        audio.onended = () => URL.revokeObjectURL(url);
    }).catch(() => {
        URL.revokeObjectURL(url);
    });
}

function onGenerationStarted() {
    warmupAudio();
    adp.active = true;
    adp.buffer = '';
    adp.pending = [];
    adp.lastLen = 0;
    adp.observedMesId = null;
    setTimeout(() => adpStartObserver(), 300);
}

function onGenerationEnded() {
    adpFlushAll();
    adp.active = false;
}

// Fallback: watch chat container for new messages
function watchChatContainer() {
    const chat = document.querySelector('#chat');
    if (!chat) {
        setTimeout(watchChatContainer, 2000);
        return;
    }

    const chatObserver = new MutationObserver(() => {
        if (!adp.active) return;
        const lastEl = findLastMesText();
        if (lastEl && lastEl !== adp.element) {
            adpStartObserver();
        }
    });

    chatObserver.observe(chat, { childList: true, subtree: true });
}

// ─── Extension Entry Point ─────────────────────────────────────────

export function onActivate() {
    registerTtsProvider('PocketTTS', PocketTtsProvider);

    // Always-on adaptive streaming — no toggle needed
    waitForEvents();
}

function waitForEvents() {
    // event_types and eventSource are imported directly from events.js
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    watchChatContainer();
    console.debug('PocketTTS: Adaptive streaming active (always on)');
}
