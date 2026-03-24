// PocketTTS — TTS extension for pocket-tts-openapi
// Periodic timer detects streaming text, splits by sentences, sends to provider.

import { registerTtsProvider } from '../../tts/index.js';
import { event_types, eventSource } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { PocketTtsProvider } from './pocket-tts.js';
import { initTtsBar } from './tts-bar.js';

// ─── State ─────────────────────────────────────────────────────────

const adp = {
    queue: [],
    isPlaying: false,
    currentAudio: null,
    currentStart: 0,

    timer: null,
    active: false,
    lastMsgId: null,
    lastTextLen: 0,
    sentenceBuffer: '',
    pending: [],
    flushTimer: null,
    decisionTimer: null,
};

// ─── Sentence Detection ────────────────────────────────────────────

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

// ─── Voice Resolution ──────────────────────────────────────────────

function getVoiceId() {
    const provider = window._pttsProvider;
    const es = window.extension_settings || extension_settings;

    // VoiceMap is stored under the provider name: extension_settings.tts.PocketTTS.voiceMap
    const voiceMap = es?.tts?.PocketTTS?.voiceMap || {};

    const context = window.SillyTavern?.getContext?.();
    const charName = context?.name2 || '[Default Voice]';

    let voiceId = voiceMap[charName];
    if (voiceId === '[Default Voice]') voiceId = voiceMap['[Default Voice]'];
    if (!voiceId || voiceId === 'disabled') {
        voiceId = voiceMap['[Default Voice]'] || provider?.settings?.voice || 'nova';
    }

    console.debug('PocketTTS: voice="' + voiceId + '" for "' + charName + '"');
    return voiceId;
}

// ─── Chunk Size Decision ───────────────────────────────────────────

function bufferSecondsRemaining() {
    let total = 0;
    for (const item of adp.queue) total += item.duration;
    if (adp.isPlaying && adp.currentAudio) {
        const elapsed = (performance.now() - adp.currentStart) / 1000;
        total += Math.max(0, adp.currentAudio.duration - elapsed);
    }
    return total;
}

function decideChunkSize() {
    const buf = bufferSecondsRemaining();
    const n = adp.pending.length;
    if (adp.queue.length === 0 && !adp.isPlaying) return Math.min(3, Math.max(1, n));
    if (buf < 1.5) return 1;
    if (buf < 4) return 1;
    if (buf < 10) return Math.min(2, n);
    return Math.min(3, n);
}

// ─── Silence Generator ─────────────────────────────────────────────

function generateSilenceWav(durationMs) {
    const sr = 24000;
    const n = Math.floor(sr * durationMs / 1000);
    const ds = n * 2;
    const buf = new ArrayBuffer(44 + ds);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + ds, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, ds, true);
    return new Blob([buf], { type: 'audio/wav' });
}

// ─── Shared Audio Element ──────────────────────────────────────────

const pttsAudio = new Audio();
pttsAudio.id = 'ptts_audio';

// ─── Sentence Highlighting (overlay, non-destructive) ──────────────

let highlightEnabled = localStorage.getItem('ptts-highlight') === 'true';

// Create overlay element once
const highlightOverlay = document.createElement('div');
highlightOverlay.className = 'ptts-highlight-overlay';
document.body.appendChild(highlightOverlay);

function clearHighlight() {
    highlightOverlay.style.display = 'none';
}

function highlightForText(text) {
    clearHighlight();
    if (!highlightEnabled || !text) return;

    const mesEl = document.querySelector('.mes.last_mes .mes_text');
    if (!mesEl) return;

    const search = text.trim();
    if (search.length < 5) return;

    // Find text in the message using TreeWalker
    const walker = document.createTreeWalker(mesEl, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(search);
        if (idx >= 0) {
            // Create a Range over the matching text
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + search.length);

            // Get bounding rect (viewport-relative)
            const rect = range.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
                // Position overlay using fixed positioning (stays correct during scroll)
                highlightOverlay.style.display = 'block';
                highlightOverlay.style.position = 'fixed';
                highlightOverlay.style.left = rect.left + 'px';
                highlightOverlay.style.top = rect.top + 'px';
                highlightOverlay.style.width = rect.width + 'px';
                highlightOverlay.style.height = rect.height + 'px';
            }

            range.detach();
            return;
        }
    }
}

window._pttsHighlightToggle = function () {
    highlightEnabled = !highlightEnabled;
    localStorage.setItem('ptts-highlight', highlightEnabled);
    if (!highlightEnabled) clearHighlight();
    return highlightEnabled;
};

window._pttsHighlightEnabled = function () { return highlightEnabled; };

// ─── Audio Playback ────────────────────────────────────────────────

function playNextInQueue() {
    if (adp.isPlaying || adp.queue.length === 0) return;
    adp.isPlaying = true;
    const item = adp.queue.shift();
    adp.currentAudio = pttsAudio;
    adp.currentStart = performance.now();

    // Highlight the playing text
    highlightForText(item.text);

    // Set source on our shared audio element
    if (item.audio) {
        adp.currentAudio = item.audio;
    } else {
        pttsAudio.src = item.url;
    }

    const cleanup = () => {
        if (item.url) URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        adp.currentAudio = null;
        if (adp.queue.length === 0 && adp.active) {
            const sUrl = URL.createObjectURL(generateSilenceWav(500));
            adp.queue.push({ url: sUrl, duration: 0.5 });
        }
        clearHighlight();
        playNextInQueue();
    };

    const audioEl = adp.currentAudio;
    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    if (item.playStarted) return;
    audioEl.play().catch(() => cleanup());
}

// ─── TTS Generation ────────────────────────────────────────────────

const MIME_BY_FORMAT = {
    mp3: 'audio/mpeg', wav: 'audio/wav',
    opus: 'audio/ogg; codecs="opus"', aac: 'audio/mp4; codecs="mp4a.40.2"', flac: 'audio/flac',
};

function getMimeType(fmt) { return MIME_BY_FORMAT[fmt] || 'audio/mpeg'; }

async function adpGenerateAndPlay(text) {
    const provider = window._pttsProvider;
    if (!provider || !provider.ready) return;
    const voiceId = getVoiceId();

    try {
        const t0 = performance.now();
        const mime = getMimeType(provider.settings.format);

        if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)) {
            await adpStreamViaMediaSource(provider, text, voiceId, mime, t0);
        } else {
            await adpGenerateAndPlayLegacy(provider, text, voiceId, t0);
        }
    } catch (err) {
        console.error('PocketTTS generation error:', err);
    }
}

async function adpStreamViaMediaSource(provider, text, voiceId, mime, t0) {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    const audio = new Audio();
    audio.src = url;

    const queueItem = { audio, url, duration: text.length / 15, playStarted: false, text };
    adp.queue.push(queueItem);
    playNextInQueue();

    try {
        await new Promise((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
            setTimeout(() => reject(new Error('MediaSource timeout')), 5000);
        });
    } catch (e) {
        URL.revokeObjectURL(url);
        return adpGenerateAndPlayLegacy(provider, text, voiceId, t0);
    }

    let sourceBuffer;
    try { sourceBuffer = mediaSource.addSourceBuffer(mime); }
    catch (e) { URL.revokeObjectURL(url); return adpGenerateAndPlayLegacy(provider, text, voiceId, t0); }

    const { stream, done } = await provider.generateTtsStreaming(text, voiceId);
    const reader = stream.getReader();
    let firstChunkTime = 0;

    async function pump() {
        while (true) {
            const { value, done: d } = await reader.read();
            if (d) break;
            if (!firstChunkTime) {
                firstChunkTime = performance.now();
                queueItem.playStarted = true;
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
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    }

    const timing = await done;
    await pump();

    const duration = timing.audio_duration > 0 ? timing.audio_duration : (text.length / 15);
    queueItem.duration = duration;
    console.debug(`PocketTTS: ${Math.round(duration * 1000)}ms audio, first chunk ${firstChunkTime ? Math.round(firstChunkTime - t0) : '?'}ms`);
}

async function adpGenerateAndPlayLegacy(provider, text, voiceId, t0) {
    const blobs = [];
    for await (const response of provider.generateTts(text, voiceId)) {
        blobs.push(await response.blob());
    }
    const combined = new Blob(blobs, { type: blobs[0]?.type || 'audio/mpeg' });
    const url = URL.createObjectURL(combined);
    const duration = provider.lastTiming.audio_duration || (text.length / 15);
    adp.queue.push({ blob: combined, url, duration, text });
    playNextInQueue();
}

// ─── Send / Flush ──────────────────────────────────────────────────

function adpSendChunk(count) {
    if (count <= 0 || adp.pending.length === 0) return;
    adpGenerateAndPlay(adp.pending.splice(0, count).join(' '));
}

function adpFlushAll() {
    if (adp.decisionTimer) { clearTimeout(adp.decisionTimer); adp.decisionTimer = null; }
    clearFlushTimer();

    const parts = [];
    if (adp.pending.length > 0) parts.push(adp.pending.join(' '));
    if (adp.sentenceBuffer.trim().length > 0) parts.push(adp.sentenceBuffer.trim());
    if (parts.length > 0) adpGenerateAndPlay(parts.join(' '));

    adp.sentenceBuffer = '';
    adp.pending = [];
}

function restartDecisionTimer() {
    if (adp.decisionTimer) clearTimeout(adp.decisionTimer);
    adp.decisionTimer = setTimeout(() => {
        adp.decisionTimer = null;
        if (adp.pending.length === 0) return;
        adpSendChunk(decideChunkSize());
        startFlushTimer();
    }, 300);
}

function startFlushTimer() {
    clearFlushTimer();
    adp.flushTimer = setTimeout(() => {
        if (adp.pending.length > 0) adpSendChunk(adp.pending.length);
        if (adp.sentenceBuffer.trim().length > 3) {
            adpGenerateAndPlay(adp.sentenceBuffer.trim());
            adp.sentenceBuffer = '';
        }
    }, 1500);
}

function clearFlushTimer() {
    if (adp.flushTimer) { clearTimeout(adp.flushTimer); adp.flushTimer = null; }
}

// ─── Periodic Timer ────────────────────────────────────────────────

function startPeriodicTimer() {
    stopPeriodicTimer();
    adp.timer = setInterval(onTick, 500);
}

function stopPeriodicTimer() {
    if (adp.timer) { clearInterval(adp.timer); adp.timer = null; }
    clearFlushTimer();
    if (adp.decisionTimer) { clearTimeout(adp.decisionTimer); adp.decisionTimer = null; }
}

function onTick() {
    if (!adp.active) return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length) return;

    const lastId = context.chat.length - 1;
    const lastMsg = context.chat[lastId];
    if (!lastMsg || lastMsg.is_user) return;
    if (!lastMsg.mes && lastMsg.mes !== '') return;

    const fullText = lastMsg.mes;
    if (fullText.length <= adp.lastTextLen) return;

    const newText = fullText.substring(adp.lastTextLen);
    adp.lastTextLen = fullText.length;

    if (lastId !== adp.lastMsgId) {
        adp.lastMsgId = lastId;
        adp.sentenceBuffer = '';
        adp.pending = [];
    }

    adp.sentenceBuffer += newText;
    const { sentences, remainder } = splitSentences(adp.sentenceBuffer);

    if (sentences.length > 0) {
        adp.pending.push(...sentences);
        adp.sentenceBuffer = remainder;
        restartDecisionTimer();
    }
}

// ─── Warmup ────────────────────────────────────────────────────────

let audioWarmupDone = false;

function warmupAudio() {
    if (audioWarmupDone) return;
    audioWarmupDone = true;
    const url = URL.createObjectURL(generateSilenceWav(2000));
    const audio = new Audio(url);
    audio.volume = 0.01;
    audio.play().then(() => { audio.onended = () => URL.revokeObjectURL(url); }).catch(() => { URL.revokeObjectURL(url); });
}

const ST_KEYS = ['auto_generation', 'periodic_auto_generation', 'narrate_by_paragraphs'];
const ST_CHECKBOXES = ['tts_auto_generation', 'tts_periodic_auto_generation', 'tts_narrate_by_paragraphs'];

let stSettingsSaved = null;

function isPocketTtsActive() {
    const es = window.extension_settings || extension_settings;
    return es?.tts?.currentProvider === 'PocketTTS' && es?.tts?.enabled === true;
}

function disableStTts() {
    const es = window.extension_settings || extension_settings;
    if (!es?.tts) return;

    // Save current state before disabling (only once per disable cycle)
    if (stSettingsSaved === null) {
        stSettingsSaved = {};
        for (const key of ST_KEYS) {
            stSettingsSaved[key] = es.tts[key];
        }
    }

    // Disable
    for (const key of ST_KEYS) es.tts[key] = false;
    for (const id of ST_CHECKBOXES) {
        const cb = document.getElementById(id);
        if (cb) { cb.checked = false; cb.disabled = true; }
    }
}

function enableStTts() {
    const es = window.extension_settings || extension_settings;

    // Restore saved state
    if (stSettingsSaved !== null) {
        for (const key of ST_KEYS) {
            if (es?.tts) es.tts[key] = stSettingsSaved[key];
        }
        stSettingsSaved = null;
    }

    // Re-enable and update checkboxes
    for (let i = 0; i < ST_CHECKBOXES.length; i++) {
        const cb = document.getElementById(ST_CHECKBOXES[i]);
        if (cb) {
            cb.disabled = false;
            cb.checked = es?.tts?.[ST_KEYS[i]] ?? false;
        }
    }
}

function onProviderDropdownChange() {
    if (isPocketTtsActive()) {
        disableStTts();
    } else {
        enableStTts();
    }
}

function onGenerationStarted(generationType, _args, isDryRun) {
    if (!isPocketTtsActive()) return;
    if (isDryRun) return;

    warmupAudio();
    adp.active = true;
    adp.sentenceBuffer = '';
    adp.pending = [];
    adp.lastTextLen = 0;
    adp.lastMsgId = null;
    startPeriodicTimer();
}

function onGenerationEnded() {
    adpFlushAll();
    adp.active = false;
    stopPeriodicTimer();
}

// ─── Entry Point ───────────────────────────────────────────────────

export function onActivate() {
    registerTtsProvider('PocketTTS', PocketTtsProvider);

    // Expose our audio element for the player bar
    window._pttsAudio = pttsAudio;

    // Re-select saved provider
    const es = window.extension_settings || extension_settings;
    const savedProvider = es.tts?.currentProvider;
    const select = document.getElementById('tts_provider');
    if (savedProvider && select) {
        const option = select.querySelector(`option[value="${savedProvider}"]`);
        if (option && select.value !== savedProvider) {
            select.value = savedProvider;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Hook into ST's provider dropdown — disable ST's TTS checkboxes when PocketTTS selected
    $('#tts_provider').on('change', onProviderDropdownChange);
    if (isPocketTtsActive()) {
        disableStTts();
    }

    initTtsBar(extension_settings);

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    console.debug('PocketTTS: Streaming active');
}
