// PocketTTS — TTS extension for pocket-tts-openapi
// Periodic timer detects streaming text, splits by sentences, sends to provider.

import { registerTtsProvider } from '../../tts/index.js';
import { event_types, eventSource } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { PocketTtsProvider } from './pocket-tts.js';
import { initTtsBar } from './tts-bar.js';

// ─── State ─────────────────────────────────────────────────────────

let adpNextSeq = 0;
let nextPlaySeq = 0;
let generationId = 0; // incremented on each new generation to discard stale results

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
};

// ─── Narrate Highlight State ───────────────────────────────────────

const narrator = {
    active: false,
    messageId: null,
    text: '',
    words: [],
    wordIdx: 0,
    elapsed: 0,
    lastTick: 0,
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
    const voiceMap = es?.tts?.PocketTTS?.voiceMap || {};
    const context = window.SillyTavern?.getContext?.();
    const charName = context?.name2 || '[Default Voice]';

    let voiceId = voiceMap[charName];
    if (voiceId === '[Default Voice]') voiceId = voiceMap['[Default Voice]'];
    if (!voiceId || voiceId === 'disabled') {
        voiceId = voiceMap['[Default Voice]'] || provider?.settings?.voice || 'nova';
    }
    return voiceId;
}

// ─── Shared Audio Element ──────────────────────────────────────────

const pttsAudio = new Audio();
pttsAudio.id = 'ptts_audio';

// ─── Sentence Highlighting ─────────────────────────────────────────

let highlightEnabled = localStorage.getItem('ptts-highlight') === 'true';
let lastSearchOffset = 0;

let highlightLayer = null;
let highlightContainer = null;

function ensureHighlightLayer() {
    const mesEl = document.querySelector('.mes.last_mes .mes_text');
    if (!mesEl) return null;
    if (mesEl.closest('.smallSysMes')) return null;

    if (mesEl.parentElement.classList.contains('ptts-highlight-wrap')) {
        return highlightLayer;
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

function clearHighlight() {
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

    const words = playingText.trim().split(/\s+/)
        .map(w => w.replace(/[^\w]/g, '').toLowerCase())
        .filter(w => w.length >= 3);
    if (words.length === 0) return;

    let fullText = '';
    const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null, false);
    let tn;
    while ((tn = tw.nextNode())) fullText += tn.textContent;

    const lowerText = fullText.toLowerCase();
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

    for (let wi = positions.length - 1; wi >= 0; wi--) {
        const { start: rStart, end: rEnd } = positions[wi];
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
    if (target && target.closest('.smallSysMes')) return;
    if (!target) target = document.querySelector('.mes.last_mes .mes_text');
    if (!target || target.closest('.smallSysMes')) return;

    const layer = ensureHighlightLayerFor(target);
    if (!layer) return;
    layer.innerHTML = html;
    layer.style.display = 'block';

    narratorTimer = setInterval(updateNarrateHighlight, 150);
}

async function onNarrateAudioReady(data) {
    if (!narrator.active) return;
    narrator.text += (narrator.text ? ' ' : '') + data.text;

    const dur = await getAudioDuration(data.audio);
    if (!narrator.active) return;
    const last = narrator.sentences[narrator.sentences.length - 1];
    if (last.duration === 0 && last.text === '') {
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

    const stAudio = document.getElementById('tts_audio');
    if (!stAudio || stAudio.paused) return;

    let totalDur = 0;
    for (const s of narrator.sentences) totalDur += s.duration;
    if (totalDur <= 0) return;

    const totalWords = narrator.words.length;
    const progress = stAudio.currentTime / totalDur;
    const newIdx = Math.min(Math.floor(progress * totalWords), totalWords - 1);

    if (newIdx === narrator.wordIdx) return;
    narrator.wordIdx = newIdx;

    const layer = document.querySelector('.ptts-highlight-layer');
    if (!layer) return;
    const marks = layer.querySelectorAll('mark.ptts-hl-word');
    marks.forEach((mark, i) => {
        if (i <= newIdx) mark.classList.add('ptts-hl-active');
        else mark.classList.remove('ptts-hl-active');
    });

    const activeMark = marks[newIdx];
    if (activeMark) activeMark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let stAudioEl = null;
let stAudioListenersAttached = false;

function setupStAudioListeners() {
    const el = document.getElementById('tts_audio');
    if (!el) return;
    if (el === stAudioEl && stAudioListenersAttached) return;

    stAudioEl = el;
    stAudioListenersAttached = true;

    el.addEventListener('pause', () => {
        if (narrator.active) {
            setTimeout(() => {
                if (narrator.active && el.paused) stopNarrateHighlight();
            }, 500);
        }
    });
}

function pollForStAudio() {
    setupStAudioListeners();
    if (stAudioListenersAttached) return;
    const id = setInterval(() => {
        setupStAudioListeners();
        if (stAudioListenersAttached) clearInterval(id);
    }, 2000);
}

function ensureHighlightLayerFor(mesEl) {
    if (!mesEl) return null;

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

// ─── Audio Playback ────────────────────────────────────────────────

function playNextInQueue() {
    if (adp.isPlaying) return;
    const idx = adp.queue.findIndex(item => item.seqNum === nextPlaySeq);
    if (idx === -1) return;
    const item = adp.queue.splice(idx, 1)[0];
    nextPlaySeq++;
    adp.isPlaying = true;
    adp.currentStart = performance.now();

    highlightForText(item.text);

    const audioEl = item.audio || pttsAudio;
    if (item.url) audioEl.src = item.url;

    const cleanup = () => {
        if (item.url) URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        clearHighlight();
        playNextInQueue();
    };

    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(() => cleanup());
}

// ─── TTS Generation ────────────────────────────────────────────────

async function adpGenerateAndPlay(text) {
    if (!text) return;
    const provider = window._pttsProvider;
    if (!provider || !provider.ready) return;
    const voiceId = getVoiceId();
    const genId = generationId;

    try {
        const blobs = [];
        for await (const response of provider.generateTts(text, voiceId)) {
            blobs.push(await response.blob());
        }
        // Discard if generation was cancelled (regenerate/stop)
        if (genId !== generationId) return;
        const combined = new Blob(blobs, { type: blobs[0]?.type || 'audio/mpeg' });
        const url = URL.createObjectURL(combined);
        const duration = provider.lastTiming.audio_duration || (text.length / 15);
        const seqNum = adpNextSeq++;
        adp.queue.push({ url, duration, text, seqNum });
        adp.queue.sort((a, b) => a.seqNum - b.seqNum);
        playNextInQueue();
    } catch (err) {
        console.error('PocketTTS generation error:', err);
    }
}

// ─── Periodic Timer ────────────────────────────────────────────────

function startPeriodicTimer() {
    stopPeriodicTimer();
    adp.timer = setInterval(onTick, 250);
}

function stopPeriodicTimer() {
    if (adp.timer) { clearInterval(adp.timer); adp.timer = null; }
}

function onTick() {
    if (!adp.active) return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length) return;

    const lastId = context.chat.length - 1;
    const lastMsg = context.chat[lastId];
    if (!lastMsg || lastMsg.is_user || lastMsg.is_system) return;
    if (!lastMsg.mes && lastMsg.mes !== '') return;

    // Use raw text directly — ST already filters before TTS
    const fullText = lastMsg.mes;
    if (!fullText || fullText.length <= adp.lastTextLen) return;

    const newText = fullText.substring(adp.lastTextLen);
    adp.lastTextLen = fullText.length;

    if (lastId !== adp.lastMsgId) {
        adp.lastMsgId = lastId;
        adp.sentenceBuffer = '';
        adp.pending = [];
        lastSearchOffset = 0;
    }

    adp.sentenceBuffer += newText;
    const { sentences, remainder } = splitSentences(adp.sentenceBuffer);

    if (sentences.length > 0) {
        adp.sentenceBuffer = remainder;
        for (const sentence of sentences) {
            adpGenerateAndPlay(sentence);
        }
    }
}

// ─── Warmup ────────────────────────────────────────────────────────

let audioWarmupDone = false;

function warmupAudio() {
    if (audioWarmupDone) return;
    audioWarmupDone = true;
    const url = URL.createObjectURL(new Blob([new Uint8Array(44)], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.volume = 0.01;
    audio.play().then(() => { audio.onended = () => URL.revokeObjectURL(url); }).catch(() => { URL.revokeObjectURL(url); });
}

// ─── ST Integration ────────────────────────────────────────────────

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

    if (stSettingsSaved === null) {
        stSettingsSaved = {};
        for (const key of ST_KEYS) stSettingsSaved[key] = es.tts[key];
    }

    for (const key of ST_KEYS) es.tts[key] = false;
    for (const id of ST_CHECKBOXES) {
        const cb = document.getElementById(id);
        if (cb) { cb.checked = false; cb.disabled = true; }
    }
}

function enableStTts() {
    const es = window.extension_settings || extension_settings;

    if (stSettingsSaved !== null) {
        for (const key of ST_KEYS) {
            if (es?.tts) es.tts[key] = stSettingsSaved[key];
        }
        stSettingsSaved = null;
    }

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
    if (isPocketTtsActive()) disableStTts();
    else enableStTts();
}

function onGenerationStarted(generationType, _args, isDryRun) {
    if (!isPocketTtsActive()) return;
    if (isDryRun) return;

    warmupAudio();

    // Invalidate all pending adpGenerateAndPlay calls
    generationId++;

    // Clear stale items from previous generation
    for (const item of adp.queue) {
        if (item.url) URL.revokeObjectURL(item.url);
    }
    adp.queue = [];
    if (adp.isPlaying) {
        if (adp.currentAudio) {
            adp.currentAudio.pause();
            adp.currentAudio.onended = null;
            adp.currentAudio.onerror = null;
            adp.currentAudio.removeAttribute('src');
        }
        adp.isPlaying = false;
    }
    adp.currentAudio = null;

    adp.active = true;
    adp.sentenceBuffer = '';
    adp.pending = [];
    adp.lastTextLen = 0;
    adp.lastMsgId = null;
    lastSearchOffset = 0;
    startPeriodicTimer();
}

function onGenerationEnded() {
    // Final text capture before flush — timer may have missed the last chunk
    onTick();

    // Flush any remaining buffered text
    if (adp.sentenceBuffer.trim().length > 0) {
        adpGenerateAndPlay(adp.sentenceBuffer.trim());
        adp.sentenceBuffer = '';
    }
    adp.active = false;
    stopPeriodicTimer();
}

// ─── Entry Point ───────────────────────────────────────────────────

export function onActivate() {
    registerTtsProvider('PocketTTS', PocketTtsProvider);

    window._pttsAudio = pttsAudio;

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

    $('#tts_provider').on('change', onProviderDropdownChange);
    if (isPocketTtsActive()) disableStTts();

    initTtsBar(extension_settings);

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    eventSource.on(event_types.TTS_JOB_STARTED, (data) => {
        if (!highlightEnabled) return;
        if (adp.active) return;
        startNarrateHighlight(data.text || '', data.messageId);
    });
    eventSource.on(event_types.TTS_AUDIO_READY, (data) => {
        if (!narrator.active) return;
        onNarrateAudioReady(data);
    });
    eventSource.on(event_types.TTS_JOB_COMPLETE, () => {
        if (!narrator.active) return;
        setTimeout(() => stopNarrateHighlight(), 1500);
    });

    pollForStAudio();
}
