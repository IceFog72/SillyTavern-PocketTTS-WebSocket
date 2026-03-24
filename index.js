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

// ─── Narrate Highlight State ───────────────────────────────────────
// Used when user clicks Narrate — tracks ST's audio playback to show
// word-by-word highlighting synced to audio.

const narrator = {
    active: false,
    messageId: null,
    text: '',        // accumulated filtered text from TTS_AUDIO_READY
    words: [],       // [{start, end, text}]
    wordIdx: 0,
    elapsed: 0,      // real elapsed play time in ms (accumulated by timer ticks)
    lastTick: 0,     // performance.now() of last timer tick
    sentences: [{ text: '', duration: 0 }],
};

let narratorTimer = null;

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

// ─── Sentence Highlighting (overlay layer) ─────────────────────────

let highlightEnabled = localStorage.getItem('ptts-highlight') === 'true';
let lastSearchOffset = 0; // resume search from here (sentences are sequential)

// Highlight layer — sits on top of .mes_text, we control its content
let highlightLayer = null;
let highlightContainer = null;

function ensureHighlightLayer() {
    const mesEl = document.querySelector('.mes.last_mes .mes_text');
    if (!mesEl) return null;
    // Skip system messages
    if (mesEl.closest('.smallSysMes')) return null;

    // Check if already wrapped
    if (mesEl.parentElement.classList.contains('ptts-highlight-wrap')) {
        return highlightLayer;
    }

    // Copy mes_text computed styles to wrapper
    const mesStyle = window.getComputedStyle(mesEl);

    // Wrap mes_text in a container
    const wrap = document.createElement('div');
    wrap.className = 'ptts-highlight-wrap';
    wrap.style.position = 'relative';
    wrap.style.display = mesStyle.display;
    wrap.style.margin = mesStyle.margin;

    mesEl.parentNode.insertBefore(wrap, mesEl);
    wrap.appendChild(mesEl);

    // Remove mes_text margin/padding now that wrapper has it
    mesEl.style.margin = '0';
    mesEl.style.padding = '0';

    // Create highlight layer on top
    const layer = document.createElement('div');
    layer.className = 'ptts-highlight-layer';

    // Copy text styles from mes_text so positions match exactly
    layer.style.fontFamily = mesStyle.fontFamily;
    layer.style.fontSize = mesStyle.fontSize;
    layer.style.fontWeight = mesStyle.fontWeight;
    layer.style.fontStyle = mesStyle.fontStyle;
    layer.style.lineHeight = mesStyle.lineHeight;
    layer.style.letterSpacing = mesStyle.letterSpacing;
    layer.style.wordSpacing = mesStyle.wordSpacing;
    layer.style.textAlign = mesStyle.textAlign;
    layer.style.textIndent = mesStyle.textIndent;
    layer.style.margin = '0';

    wrap.appendChild(layer);

    highlightContainer = wrap;
    highlightLayer = layer;
    return layer;
}

function clearHighlight() {
    // Unwrap mes_text from highlight wrap if present
    if (highlightContainer && highlightContainer.classList.contains('ptts-highlight-wrap')) {
        const mesText = highlightContainer.querySelector('.mes_text');
        if (mesText && highlightContainer.parentNode) {
            highlightContainer.parentNode.insertBefore(mesText, highlightContainer);
            mesText.style.margin = '';
            mesText.style.padding = '';
        }
        highlightContainer.remove();
    }
    highlightLayer = null;
    highlightContainer = null;
    // Don't reset lastSearchOffset — it tracks position across sentences
}

function highlightForText(playingText) {
    clearHighlight();
    if (!highlightEnabled || !playingText) return;

    const mesEl = document.querySelector('.mes.last_mes .mes_text');
    if (!mesEl) return;

    const layer = ensureHighlightLayer();
    if (!layer) return;

    if (layer.innerHTML !== mesEl.innerHTML) {
        layer.innerHTML = mesEl.innerHTML;
    }
    layer.style.display = 'block';

    // Get words (≥3 chars)
    const words = playingText.trim().split(/\s+/)
        .map(w => w.replace(/[^\w]/g, '').toLowerCase())
        .filter(w => w.length >= 3);
    if (words.length === 0) return;

    // Build text
    let fullText = '';
    const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null, false);
    let tn;
    while ((tn = tw.nextNode())) fullText += tn.textContent;

    const lowerText = fullText.toLowerCase();

    // Find all word positions
    const positions = [];
    let offset = lastSearchOffset;
    for (const word of words) {
        const pos = lowerText.indexOf(word, offset);
        if (pos >= 0) {
            positions.push({ start: pos, end: pos + word.length });
            offset = pos + word.length;
        }
    }

    if (positions.length === 0) return;
    lastSearchOffset = positions[positions.length - 1].end;

    // Wrap in REVERSE — earlier wraps don't affect later DOM positions
    for (let wi = positions.length - 1; wi >= 0; wi--) {
        const { start: rStart, end: rEnd } = positions[wi];

        // Rebuild text nodes for THIS wrap
        const nodes = [];
        let ft = '';
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null, false);
        let n;
        while ((n = walker.nextNode())) {
            nodes.push({ node: n, start: ft.length, end: ft.length + n.textContent.length });
            ft += n.textContent;
        }

        for (let i = nodes.length - 1; i >= 0; i--) {
            const { node: tNode, start: ns, end: ne } = nodes[i];
            const ws = Math.max(rStart, ns);
            const we = Math.min(rEnd, ne);
            if (ws >= we) continue;

            const ls = ws - ns;
            const le = we - ns;
            const nl = tNode.textContent.length;
            if (ls >= nl || le > nl || ls < 0 || le < 0) continue;

            let target = tNode;
            if (le < nl) target.splitText(le);
            let wrapNode = target;
            if (ls > 0) wrapNode = target.splitText(ls);

            const mark = document.createElement('mark');
            mark.className = 'ptts-hl-active';
            wrapNode.parentNode.replaceChild(mark, wrapNode);
            mark.appendChild(wrapNode);
        }
    }

    const firstMark = layer.querySelector('.ptts-hl-active');
    if (firstMark) firstMark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Narrate Highlight ─────────────────────────────────────────────

async function getAudioDuration(blobOrUrl) {
    return new Promise(resolve => {
        let url;
        if (blobOrUrl instanceof Blob) {
            url = URL.createObjectURL(blobOrUrl);
        } else if (typeof blobOrUrl === 'string') {
            url = blobOrUrl;
        } else {
            resolve(0);
            return;
        }
        const a = new Audio();
        a.preload = 'metadata';
        a.onloadedmetadata = () => {
            const d = a.duration;
            if (blobOrUrl instanceof Blob) URL.revokeObjectURL(url);
            resolve(isFinite(d) && d > 0 ? d : 0);
        };
        a.onerror = () => {
            if (blobOrUrl instanceof Blob) URL.revokeObjectURL(url);
            resolve(0);
        };
        a.src = url;
    });
}

function buildWordHtml(text) {
    const words = [];
    let html = '';
    let lastEnd = 0;
    const re = /[\w']+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        html += text.substring(lastEnd, m.index);
        const idx = words.length;
        words.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
        html += `<mark class="ptts-hl-word" data-wi="${idx}">${m[0]}</mark>`;
        lastEnd = m.index + m[0].length;
    }
    html += text.substring(lastEnd);
    return { html, words };
}

function startNarrateHighlight(text, messageId) {
    if (!highlightEnabled || !text) return;
    stopNarrateHighlight();

    // Skip system messages — check chat data
    if (messageId != null) {
        const context = window.SillyTavern?.getContext?.();
        const msg = context?.chat?.[messageId];
        if (msg?.is_system) return;
    }

    narrator.active = true;
    narrator.messageId = messageId;
    narrator.text = text;
    narrator.wordIdx = 0;
    narrator.elapsed = 0;
    narrator.lastTick = performance.now();
    narrator.sentences = [{ text: '', duration: 0 }];

    const { html, words } = buildWordHtml(text);
    narrator.words = words;
    if (words.length === 0) return;

    let target = null;
    if (messageId != null) {
        target = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    }
    // Skip .smallSysMes elements
    if (target && target.closest('.smallSysMes')) return;
    if (!target) target = document.querySelector('.mes.last_mes .mes_text');
    if (!target || target.closest('.smallSysMes')) return;

    const layer = ensureHighlightLayerFor(target);
    if (!layer) return;
    layer.innerHTML = html;
    layer.style.display = 'block';

    // Start tracking elapsed time using ST audio element's currentTime
    narratorTimer = setInterval(updateNarrateHighlight, 150);
}

async function onNarrateAudioReady(data) {
    if (!narrator.active) return;
    narrator.text += (narrator.text ? ' ' : '') + data.text;

    const dur = await getAudioDuration(data.audio);
    if (!narrator.active) return;
    const last = narrator.sentences[narrator.sentences.length - 1];
    if (last.duration === 0 && last.text === '') {
        // First sentence — update the placeholder
        last.text = data.text;
        last.duration = dur;
    } else {
        narrator.sentences.push({ text: data.text, duration: dur });
    }
}

function stopNarrateHighlight() {
    if (narratorTimer) { clearInterval(narratorTimer); narratorTimer = null; }
    narrator.active = false;
    narrator.text = '';
    narrator.words = [];
    narrator.sentences = [{ text: '', duration: 0 }];
    narrator.wordIdx = 0;
    narrator.elapsed = 0;
    clearHighlight();
}

function updateNarrateHighlight() {
    if (!narrator.active || narrator.words.length === 0) return;

    // Only accumulate elapsed time while audio is actually playing
    const stAudio = document.getElementById('tts_audio');
    const audioPlaying = stAudio && !stAudio.paused;
    const now = performance.now();
    if (audioPlaying) {
        narrator.elapsed += now - narrator.lastTick;
    }
    narrator.lastTick = now;

    // Calculate word index from elapsed time
    let totalDur = 0;
    for (const s of narrator.sentences) totalDur += s.duration;
    if (totalDur <= 0) return;

    const totalWords = narrator.words.length;
    const wps = totalWords / totalDur; // words per second
    const newIdx = Math.min(Math.floor(narrator.elapsed / 1000 * wps), totalWords - 1);

    if (newIdx === narrator.wordIdx) return;
    narrator.wordIdx = newIdx;

    // Update marks — only change classes, don't rebuild DOM
    const layer = document.querySelector('.ptts-highlight-layer');
    if (!layer) return;
    const marks = layer.querySelectorAll('mark.ptts-hl-word');
    marks.forEach((mark, i) => {
        if (i <= newIdx) {
            mark.classList.add('ptts-hl-active');
        } else {
            mark.classList.remove('ptts-hl-active');
        }
    });

    // Scroll active word into view
    const activeMark = marks[newIdx];
    if (activeMark) activeMark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Hook into ST's #tts_audio element for precise timing
let stAudioEl = null;
let stAudioListenersAttached = false;

function setupStAudioListeners() {
    const el = document.getElementById('tts_audio');
    if (!el) return;
    if (el === stAudioEl && stAudioListenersAttached) return;

    stAudioEl = el;
    stAudioListenersAttached = true;

    // Detect user pause/stop
    el.addEventListener('pause', () => {
        if (narrator.active) {
            // Check if this is a real pause (user action) vs between-chunks
            setTimeout(() => {
                if (narrator.active && el.paused && !isTtsProcessingLike()) {
                    stopNarrateHighlight();
                }
            }, 500);
        }
    });
}

function isTtsProcessingLike() {
    // Check if ST's TTS system is still processing
    const stAudio = document.getElementById('tts_audio');
    return stAudio && !stAudio.paused;
}

// Poll for #tts_audio element (ST creates it asynchronously)
function pollForStAudio() {
    setupStAudioListeners();
    if (stAudioListenersAttached) return;
    const id = setInterval(() => {
        setupStAudioListeners();
        if (stAudioListenersAttached) clearInterval(id);
    }, 2000);
}

// Ensure highlight layer for a specific mes_text element (not just .last_mes)
function ensureHighlightLayerFor(mesEl) {
    if (!mesEl) return null;

    // Check if already wrapped
    if (mesEl.parentElement.classList.contains('ptts-highlight-wrap')) {
        return mesEl.parentElement.querySelector('.ptts-highlight-layer');
    }

    const mesStyle = window.getComputedStyle(mesEl);
    const wrap = document.createElement('div');
    wrap.className = 'ptts-highlight-wrap';
    wrap.style.position = 'relative';
    wrap.style.display = mesStyle.display;
    wrap.style.margin = mesStyle.margin;

    mesEl.parentNode.insertBefore(wrap, mesEl);
    wrap.appendChild(mesEl);
    mesEl.style.margin = '0';
    mesEl.style.padding = '0';

    const layer = document.createElement('div');
    layer.className = 'ptts-highlight-layer';
    layer.style.fontFamily = mesStyle.fontFamily;
    layer.style.fontSize = mesStyle.fontSize;
    layer.style.fontWeight = mesStyle.fontWeight;
    layer.style.fontStyle = mesStyle.fontStyle;
    layer.style.lineHeight = mesStyle.lineHeight;
    layer.style.letterSpacing = mesStyle.letterSpacing;
    layer.style.wordSpacing = mesStyle.wordSpacing;
    layer.style.textAlign = mesStyle.textAlign;
    layer.style.textIndent = mesStyle.textIndent;
    layer.style.margin = '0';

    wrap.appendChild(layer);

    highlightContainer = wrap;
    highlightLayer = layer;
    return layer;
}

window._pttsHighlightToggle = function () {
    highlightEnabled = !highlightEnabled;
    localStorage.setItem('ptts-highlight', highlightEnabled);
    if (!highlightEnabled) {
        clearHighlight();
        stopNarrateHighlight();
    }
    return highlightEnabled;
};

window._pttsHighlightEnabled = function () { return highlightEnabled; };

// ─── Text Processing (ST TTS toggle support) ──────────────────────

function processTtsText(text) {
    const es = window.extension_settings || extension_settings;
    if (!es?.tts || !text) return text;

    let processed = text;

    // Skip code blocks — exact copy from ST tts/index.js line 651-655
    if (es.tts.skip_codeblocks) {
        processed = processed.replace(/^\s{4}.*$/gm, '').trim();
        processed = processed.replace(/```.*?```/gs, '').trim();
        processed = processed.replace(/~~~.*?~~~/gs, '').trim();
    }

    // Skip tagged blocks — exact copy from ST tts/index.js line 657-659
    if (es.tts.skip_tags) {
        processed = processed.replace(/<.*?>[\s\S]*?<\/.*?>/g, '').trim();
    }

    // Handle asterisks — exact copy from ST tts/index.js line 661-665
    if (!es.tts.pass_asterisks) {
        processed = es.tts.narrate_dialogues_only
            ? processed.replace(/\*[^*]*?(\*|$)/g, '').trim()
            : processed.replaceAll('*', '').trim();
    }

    // Apply regex filter — exact copy from ST tts/index.js line 667-675
    if (es.tts.apply_regex && es.tts.regex_pattern) {
        try {
            const regex = new RegExp(es.tts.regex_pattern, 'g');
            processed = processed.replace(regex, '').replace(/\s+/g, ' ').trim();
        } catch { /* invalid regex */ }
    }

    // Narrate quoted only — simplified version of ST's joinQuotedBlocks
    if (es.tts.narrate_quoted_only) {
        const quoted = processed.match(/"[^"]*"|'[^']*'|[\u201C\u201D][^\u201C\u201D]*[\u201C\u201D]/g);
        processed = quoted ? quoted.join(' ') : '';
    }

    // Remove embedded images — exact copy from ST tts/index.js line 683
    processed = processed.replace(/!\[.*?]\([^)]*\)/g, '');

    // Collapse whitespace — exact copy from ST tts/index.js line 690
    processed = processed.replace(/\s+/g, ' ').trim();

    return processed;
}

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
    if (!text) return;
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
                audio.play().catch(() => { });
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
    if (!lastMsg || lastMsg.is_user || lastMsg.is_system) return;
    if (!lastMsg.mes && lastMsg.mes !== '') return;

    // Filter full text FIRST, then diff filtered version
    const rawText = lastMsg.mes;
    const fullText = processTtsText(rawText);
    if (!fullText || fullText.length <= adp.lastTextLen) return;

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
    stopNarrateHighlight();
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
    lastSearchOffset = 0;
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

    // Narrate button highlighting — hook into ST's TTS events
    eventSource.on(event_types.TTS_JOB_STARTED, (data) => {
        if (!highlightEnabled) return;
        // Don't interfere with our own periodic timer playback
        if (adp.active) return;
        startNarrateHighlight(data.text || '', data.messageId);
    });
    eventSource.on(event_types.TTS_AUDIO_READY, (data) => {
        if (!narrator.active) return;
        onNarrateAudioReady(data);
    });
    eventSource.on(event_types.TTS_JOB_COMPLETE, () => {
        if (!narrator.active) return;
        // Delay cleanup so last sentence's highlight is visible
        setTimeout(() => stopNarrateHighlight(), 1500);
    });

    // Monitor ST's #tts_audio element for precise playback timing
    pollForStAudio();

    console.debug('PocketTTS: Streaming active');
}
