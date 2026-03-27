// PocketTTS — TTS extension for pocket-tts-openapi
// Per-message playlists. Timer reads chat[mes] after reasoning parsing.

import { registerTtsProvider } from '../../tts/index.js';
import { event_types, eventSource } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { PocketTtsProvider } from './pocket-tts.js';
import { initTtsBar } from './tts-bar.js';

// ─── State ─────────────────────────────────────────────────────────

const adp = {
    playlists: new Map(),   // msgId → [{url, duration, text}]
    playOrder: [],           // [msgId, ...] in creation order
    playingMsgId: null,      // msgId currently playing
    playingTrack: null,      // text of track currently playing (already shifted out of queue)
    _lastHighlightMsgId: null, // tracks which message was last highlighted for offset reset
    isPlaying: false,
    currentAudio: null,
    timer: null,
    active: false,
    lastMsgId: null,
    lastTextLen: 0,
    sentenceBuffer: '',
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

function ensureHighlightLayer(msgId) {
    const mesEl = msgId != null
        ? document.querySelector(`.mes[mesid="${msgId}"] .mes_text`)
        : document.querySelector('.mes.last_mes .mes_text');
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

function highlightForText(playingText, msgId) {
    clearHighlight();
    if (!highlightEnabled || !playingText) return;

    const mesEl = msgId != null
        ? document.querySelector(`.mes[mesid="${msgId}"] .mes_text`)
        : document.querySelector('.mes.last_mes .mes_text');
    if (!mesEl) return;

    const layer = ensureHighlightLayer(msgId);
    if (!layer) return;

    if (layer.innerHTML !== mesEl.innerHTML) {
        layer.innerHTML = mesEl.innerHTML;
    }
    layer.style.display = 'block';

    // Build text node map: [{node, start, end}, ...]
    const nodes = [];
    let fullText = '';
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null, false);
    let nd;
    while ((nd = walker.nextNode())) {
        const len = nd.textContent.length;
        nodes.push({ node: nd, start: fullText.length, end: fullText.length + len });
        fullText += nd.textContent;
    }
    if (fullText.length === 0) return;

    // Search for original playing text as substring (preserves contractions like You're, I'll)
    const lowerFull = fullText.toLowerCase();
    const search = playingText.trim().toLowerCase();
    if (!search) return;

    let pos = lowerFull.indexOf(search, lastSearchOffset);
    if (pos < 0) pos = lowerFull.indexOf(search, 0);
    if (pos < 0) return;

    const matchStart = pos;
    const matchEnd = pos + search.length;
    lastSearchOffset = matchEnd;

    // Wrap matching text nodes in <mark> — safe even across HTML element boundaries
    for (let i = nodes.length - 1; i >= 0; i--) {
        const { node: tNode, start: ns, end: ne } = nodes[i];
        const ws = Math.max(matchStart, ns);
        const we = Math.min(matchEnd, ne);
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

// ─── Per-Message Playlist Playback ─────────────────────────────────

function setMesTextOverflow(msgId) {
    const el = msgId != null
        ? document.querySelector(`.mes[mesid="${msgId}"] .mes_block`)
        : document.querySelector('.mes.last_mes .mes_block');
    if (el) el.style.setProperty('overflow', 'auto', 'important');
}

function clearMesTextOverflow(msgId) {
    const el = msgId != null
        ? document.querySelector(`.mes[mesid="${msgId}"] .mes_block`)
        : document.querySelector('.mes.last_mes .mes_block');
    if (el) el.style.removeProperty('overflow');
}

function playNextInQueue() {
    if (adp.isPlaying) return;

    // Find first msgId in playOrder that has playable (non-pending) items
    let msgId = null;
    let items = null;
    for (const id of adp.playOrder) {
        const pl = adp.playlists.get(id);
        if (pl && pl.length > 0 && !pl[0].pending) {
            msgId = id;
            items = pl;
            break;
        }
    }
    if (!msgId || !items) {
        refreshPlaylistUi();
        return;
    }

    const item = items.shift();
    adp.isPlaying = true;
    adp.playingMsgId = msgId;
    adp.playingTrack = item.text;

    setMesTextOverflow(msgId);
    // Reset search offset when switching to a different message
    if (adp._lastHighlightMsgId !== msgId) {
        lastSearchOffset = 0;
        adp._lastHighlightMsgId = msgId;
    }
    highlightForText(item.text, msgId);
    refreshPlaylistUi();

    const audioEl = pttsAudio;
    audioEl.src = item.url;

    const cleanup = () => {
        URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        adp.playingMsgId = null;
        adp.playingTrack = null;
        clearHighlight();
        clearMesTextOverflow(msgId);

        // Remove empty playlist from playOrder
        if (items.length === 0) {
            adp.playlists.delete(msgId);
            const idx = adp.playOrder.indexOf(msgId);
            if (idx >= 0) adp.playOrder.splice(idx, 1);
        }

        refreshPlaylistUi();
        playNextInQueue();
    };

    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(() => cleanup());
}

function skipTrack() {
    if (!adp.isPlaying) return;
    // Pause with onended intact → cleanup fires → playNextInQueue → next track in same message
    pttsAudio.pause();
}

function nukePlaylist(msgId) {
    if (msgId == null) return;

    const items = adp.playlists.get(msgId);
    if (items) {
        for (const item of items) {
            if (item.url) URL.revokeObjectURL(item.url);
        }
    }
    adp.playlists.delete(msgId);
    const idx = adp.playOrder.indexOf(msgId);
    if (idx >= 0) adp.playOrder.splice(idx, 1);

    // If currently playing this message, stop its audio and advance
    if (adp.playingMsgId === msgId && adp.isPlaying) {
        pttsAudio.pause();
        pttsAudio.onended = null;
        pttsAudio.onerror = null;
        pttsAudio.removeAttribute('src');
        adp.isPlaying = false;
        adp.playingMsgId = null;
        adp.playingTrack = null;
        clearHighlight();
        clearMesTextOverflow(msgId);
        refreshPlaylistUi();
        playNextInQueue();
    } else {
        refreshPlaylistUi();
    }
}

function refreshPlaylistUi() {
    window._pttsRefreshPlaylist?.();
}

function getPlaylistView() {
    const view = [];
    for (const msgId of adp.playOrder) {
        const items = adp.playlists.get(msgId);
        if (!items || items.length === 0) {
            // Playlist might be empty but this message is currently playing
            // (playing track was shifted out). Show just the playing track.
            if (adp.playingMsgId === msgId && adp.isPlaying && adp.playingTrack) {
                view.push({
                    msgId,
                    tracks: [{ text: adp.playingTrack, playing: true }],
                    isPlaying: true,
                });
            }
            continue;
        }
        const isPlaying = adp.playingMsgId === msgId && adp.isPlaying;
        const tracks = [];

        // Add the currently playing track (already shifted out of array)
        if (isPlaying && adp.playingTrack) {
            tracks.push({ text: adp.playingTrack, playing: true });
        }

        // Add remaining queued tracks
        for (const i of items) {
            tracks.push({ text: i.text, playing: false, pending: !!i.pending });
        }

        view.push({ msgId, tracks, isPlaying });
    }
    return view;
}

window._pttsGetPlaylist = getPlaylistView;
window._pttsNukePlaylist = nukePlaylist;
window._pttsSkipTrack = skipTrack;

// ─── TTS Generation ────────────────────────────────────────────────

async function adpGenerateAndPlay(msgId, text) {
    if (!text || msgId == null) return;
    const provider = window._pttsProvider;
    if (!provider || !provider.ready) return;
    const voiceId = getVoiceId();

    // Add placeholder immediately (sync) — ensures correct order regardless
    // of which async generation finishes first
    if (!adp.playlists.has(msgId)) {
        adp.playlists.set(msgId, []);
        adp.playOrder.push(msgId);
    }
    const playlist = adp.playlists.get(msgId);
    const placeholder = { url: null, duration: 0, text: text, pending: true };
    playlist.push(placeholder);
    refreshPlaylistUi();

    try {
        const blobs = [];
        for await (const response of provider.generateTts(text, voiceId)) {
            blobs.push(await response.blob());
        }
        const combined = new Blob(blobs, { type: blobs[0]?.type || 'audio/mpeg' });
        placeholder.url = URL.createObjectURL(combined);
        placeholder.duration = provider.lastTiming.audio_duration || (text.length / 15);
        placeholder.pending = false;
        refreshPlaylistUi();
        playNextInQueue();
    } catch (err) {
        // Remove failed placeholder from playlist
        const idx = playlist.indexOf(placeholder);
        if (idx >= 0) playlist.splice(idx, 1);
        if (playlist.length === 0) {
            adp.playlists.delete(msgId);
            const oi = adp.playOrder.indexOf(msgId);
            if (oi >= 0) adp.playOrder.splice(oi, 1);
        }
        refreshPlaylistUi();
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

// ─── Text Capture (timer reads chat[mes] AFTER reasoning parsing) ──

function processNewText(fullText, msgId) {
    if (!adp.active) return;

    // Detect new message or swipe (text got shorter = content replaced)
    if (msgId !== adp.lastMsgId || fullText.length < adp.lastTextLen) {
        // Nuke the previous message's playlist if it was different
        if (adp.lastMsgId != null && adp.lastMsgId !== msgId) {
            nukePlaylist(adp.lastMsgId);
        }
        adp.lastMsgId = msgId;
        adp.sentenceBuffer = '';
        adp.lastTextLen = fullText.length;
        return;
    }

    if (!fullText || fullText.length <= adp.lastTextLen) return;

    const newText = fullText.substring(adp.lastTextLen);
    adp.lastTextLen = fullText.length;

    adp.sentenceBuffer += newText;
    const { sentences, remainder } = splitSentences(adp.sentenceBuffer);

    if (sentences.length > 0) {
        adp.sentenceBuffer = remainder;
        for (const sentence of sentences) {
            adpGenerateAndPlay(adp.lastMsgId, sentence);
        }
    }
}

function onSwipe() {
    if (!adp.active) return;
    nukePlaylist(adp.lastMsgId);
    adp.lastMsgId = null;
    adp.lastTextLen = 0;
    adp.sentenceBuffer = '';
}

// Timer reads chat[lastId].mes AFTER onProgressStreaming has processed reasoning
function onTick() {
    if (!adp.active) return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length) return;

    const lastId = context.chat.length - 1;
    const lastMsg = context.chat[lastId];
    if (!lastMsg || lastMsg.is_user || lastMsg.is_system) return;
    if (!lastMsg.mes && lastMsg.mes !== '') return;

    processNewText(lastMsg.mes, lastId);
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

const ST_KEYS = [
    'auto_generation', 'periodic_auto_generation', 'narrate_by_paragraphs',
    'narrate_quoted_only', 'narrate_dialogues_only', 'narrate_translated_only',
    'skip_codeblocks', 'skip_tags', 'pass_asterisks',
    'multi_voice_enabled', 'apply_regex',
];
const ST_CHECKBOXES = [
    'tts_auto_generation', 'tts_periodic_auto_generation', 'tts_narrate_by_paragraphs',
    'tts_narrate_quoted', 'tts_narrate_dialogues', 'tts_narrate_translated_only',
    'tts_skip_codeblocks', 'tts_skip_tags', 'tts_pass_asterisks',
    'tts_multi_voice_enabled', 'tts_apply_regex',
];

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

    // Only nuke on regenerate — old message's tracks are invalid.
    // Normal generation: old audio keeps playing, new tracks queue after it.
    // Swipe: handled by onSwipe via MESSAGE_SWIPED event.
    if (generationType === 'regenerate' && adp.lastMsgId != null) {
        nukePlaylist(adp.lastMsgId);
    }

    adp.active = true;
    adp.sentenceBuffer = '';
    lastSearchOffset = 0;
    adp.lastMsgId = null;
    adp.lastTextLen = 0;

    startPeriodicTimer();
}

function onGenerationEnded() {
    // Final text capture before flush — timer may have missed the last chunk
    onTick();

    // Flush any remaining buffered text
    if (adp.sentenceBuffer.trim().length > 0 && adp.lastMsgId != null) {
        adpGenerateAndPlay(adp.lastMsgId, adp.sentenceBuffer.trim());
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
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.on(event_types.MESSAGE_SWIPED, onSwipe);

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
