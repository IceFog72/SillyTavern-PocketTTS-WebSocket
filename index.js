// PocketTTS — TTS extension for pocket-tts-openapi
// Architecture: single global text buffer → flat track queue → sequential playback.
//
// WHY this design:
// - One global buffer avoids interleaving audio from multiple messages.
//   Previously each message had its own playlist → WS requests from different
//   messages got interleaved in the queue → audio played out of order.
// - Flat queue means WS requests go out in exact play order — no interleaving.
// - Server merges short sentences (< 30 chars) so "Good." + "A dazed prey..."
//   becomes one audio track instead of a tiny 0.8s track followed by a 3s track.
//
// Data flow:
//   chat[mes].mes (streaming text from ST)
//     → timer (250ms) reads new chars
//     → processNewText() appends to textBuffer
//     → splitSentences() on sentence boundaries (. ! ? …)
//     → adpGenerateAndPlay() creates placeholder in tracks[], sends WS request
//     → server generates audio (may merge short sentences)
//     → placeholder.url filled, pending=false
//     → playNextInQueue() plays in tracks[] order

import { registerTtsProvider } from '../../tts/index.js';
import { event_types, eventSource } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { PocketTtsProvider } from './pocket-tts.js';
import { initTtsBar } from './tts-bar.js';

// All console output prefixed [tts-pl] for easy filtering in devtools
const log = (...args) => console.log('[tts-pl]', ...args);

// ─── State ─────────────────────────────────────────────────────────

let ttsBarCleanup = null;

const adp = {
    // WHY flat array: tracks are ordered by text arrival = play order.
    // Each {url, duration, text, msgId, pending, error}.
    // msgId tags each track so playlist UI can group by message.
    tracks: [],
    playingIdx: -1,        // index into tracks[] of currently playing track (-1 = none)
    playingTrack: null,    // text of track currently playing (used for highlighting after cleanup)
    isPlaying: false,
    timer: null,           // 250ms interval that reads chat[mes].mes
    active: false,         // true during generation — timer only runs when active
    textBuffer: '',        // accumulates chars from streaming text until sentence boundary found
    lastMsgId: null,       // current message being streamed — used to detect new message / swipe
    lastTextLen: 0,        // how many chars of chat[mes].mes we've already processed
    lastSeenPrefix: '',    // prefix of last seen fullText — used to detect in-place modifications
    isUserMsg: false,      // whether current message is from user
    msgCharName: '',       // character name from current message (name property)
    bufferIsUser: false,   // isUser captured when buffer started (for this message)
    bufferCharName: '',    // charName captured when buffer started (for this message)
};


// ─── Sentence Detection ────────────────────────────────────────────
// WHY sentence-based splitting: the server generates audio per-sentence.
// Sending a full paragraph as one request creates a long audio file that
// can't be played until fully generated. Splitting into sentences allows
// the first sentence to play while the second is still generating.

// Matches: [sentence ending with .!?…] followed by optional closing
// punctuation (parens only) then whitespace.
// The \s+ ensures we only split at actual word boundaries, not mid-word.
// NOTE: quotes removed from closing chars — they cause corruption when splitting quoted dialogue.
const SENTENCE_END = /[.!?…][)]*\s+/g;

function splitSentences(text) {
    const result = [];
    SENTENCE_END.lastIndex = 0; // reset regex state (global flag)
    let lastIdx = 0;
    let match;

    while ((match = SENTENCE_END.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const s = text.substring(lastIdx, end).trimStart();
        if (s.length > 0) result.push(s);
        lastIdx = end;
    }

    // Remainder is text after the last sentence boundary — kept in buffer
    // until more text arrives or generation ends
    const remainder = text.substring(lastIdx);
    return { sentences: result, remainder };
}

// ─── Voice Resolution ──────────────────────────────────────────────
// WHY per-character voice mapping: different characters in ST can have
// different TTS voices. The voice map is stored in extension settings
// and looked up by character name.

function getVoiceId(isUserMessage = false, charName = null) {
    const provider = window._pttsProvider;
    const es = window.extension_settings || extension_settings;
    const voiceMap = es?.tts?.['PocketTTS WebSocket']?.voiceMap || {};

    // Use provided charName, or fall back to global state, or context
    const name = charName || adp.msgCharName || (isUserMessage
        ? (window.SillyTavern?.getContext?.()?.name1 || 'User')
        : (window.SillyTavern?.getContext?.()?.name2 || '[Default Voice]'));

    let voiceId = voiceMap[name];
    // Fallback for user messages: try "User" if actual name not found
    if (!voiceId && isUserMessage) voiceId = voiceMap['User'];
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
// WHY a highlight layer: we need to highlight text in ST messages without
// modifying the original DOM (ST may re-render it at any time). The highlight
// layer is a semi-transparent overlay that mirrors the message text and wraps
// matching portions in <mark> tags. The overlay sits on top of the original
// text, creating a highlighting effect.
//
// WHY TreeWalker for text nodes: messages contain HTML (formatting, emphasis,
// etc.). We need to find the character positions across HTML element boundaries.
// TreeWalker visits each text node, and we build a map of [{node, start, end}]
// so we can split and wrap arbitrary ranges.
//
// WHY substring search (not word-stripping): earlier versions stripped words
// from the playing text and searched for them individually. This broke
// contractions ("You're" → "youre" wouldn't match "you're" in the DOM).
// Substring search preserves the original text, including contractions.

let highlightEnabled = localStorage.getItem('ptts-highlight') === 'true';
let lastSearchOffset = 0; // search starts from last match position (sequential playback)

let highlightLayer = null;
let highlightContainer = null;

// Creates or returns the highlight overlay for a message element.
// The overlay copies font styles from the original to ensure alignment.
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

// Map position in normalized (whitespace-collapsed) text back to original position
function mapNormalizedPos(original, normPos) {
    let oi = 0, ni = 0;
    let inWhitespace = false;
    while (ni < normPos && oi < original.length) {
        if (/\s/.test(original[oi])) {
            if (!inWhitespace) { ni++; inWhitespace = true; }
        } else {
            ni++;
            inWhitespace = false;
        }
        oi++;
    }
    return oi;
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

    // Strip markdown formatting from TTS text to match rendered DOM
    // TTS gets `code` but DOM has <code>code</code> — backticks don't exist in DOM
    const stripMd = (s) => s
        .replace(/`{1,3}/g, '')  // remove backticks
        .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
        .replace(/\*(.+?)\*/g, '$1')      // italic
        .replace(/~~(.+?)~~/g, '$1');      // strikethrough

    // Normalize whitespace — DOM may have newlines from HTML structure
    const normalize = (s) => s.replace(/\s+/g, ' ');

    // Search for original playing text as substring (preserves contractions like You're, I'll)
    const lowerFull = normalize(fullText.toLowerCase());
    const search = normalize(stripMd(playingText.trim().toLowerCase()));
    if (!search) return;

    let pos = lowerFull.indexOf(search, lastSearchOffset);
    if (pos < 0) pos = lowerFull.indexOf(search, 0);
    if (pos < 0) return;

    // Map normalized position back to original text position
    const matchStart = mapNormalizedPos(fullText, pos);
    const matchEnd = mapNormalizedPos(fullText, pos + search.length);
    lastSearchOffset = pos + search.length;

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

window._pttsHighlightToggle = function () {
    highlightEnabled = !highlightEnabled;
    localStorage.setItem('ptts-highlight', highlightEnabled);
    if (!highlightEnabled) clearHighlight();
    return highlightEnabled;
};

window._pttsHighlightEnabled = function () { return highlightEnabled; };

// ─── Per-Message Playlist Playback ─────────────────────────────────

// _lastHighlightMsgId: tracks which message was last highlighted for offset reset
let _lastHighlightMsgId = null;

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

    // Skip past error tracks, find first playable
    while (adp.playingIdx + 1 < adp.tracks.length) {
        const next = adp.tracks[adp.playingIdx + 1];
        if (next.error) {
            adp.playingIdx++;
            log(`skip error: "${next.text.substring(0, 30)}" (${next.error})`);
            continue;
        }
        if (next.pending) break; // wait for it
        break;
    }

    const nextIdx = adp.playingIdx + 1;
    if (nextIdx >= adp.tracks.length) {
        refreshPlaylistUi();
        return;
    }
    const item = adp.tracks[nextIdx];
    if (item.pending) {
        refreshPlaylistUi();
        return;
    }

    // Warmup audio system before first track plays
    if (!audioWarmupDone) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(44)], { type: 'audio/wav' }));
        audioWarmupDone = true;
        pttsAudio.src = url;
        pttsAudio.onended = () => {
            URL.revokeObjectURL(url);
            pttsAudio.onended = null;
            playNextInQueue();
        };
        pttsAudio.onerror = () => {
            URL.revokeObjectURL(url);
            pttsAudio.onerror = null;
            playNextInQueue();
        };
        pttsAudio.play().catch(() => playNextInQueue());
        return;
    }

    adp.playingIdx = nextIdx;
    adp.isPlaying = true;
    adp.playingTrack = item.text;

    log(`play #${nextIdx} msg=${item.msgId} "${item.text.substring(0, 50)}"`);
    setMesTextOverflow(item.msgId);
    if (_lastHighlightMsgId !== item.msgId) {
        lastSearchOffset = 0;
        _lastHighlightMsgId = item.msgId;
    }
    highlightForText(item.text, item.msgId);
    refreshPlaylistUi();

    const audioEl = pttsAudio;
    audioEl.src = item.url;

    const cleanup = () => {
        URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        adp.playingTrack = null;
        clearHighlight();
        clearMesTextOverflow(item.msgId);
        // Remove played tracks for this message if no more remain
        removePlayedMsgTracks(item.msgId, nextIdx);
        refreshPlaylistUi();
        playNextInQueue();
    };

    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(() => cleanup());
}

// Remove played tracks for a message when all its tracks are done
function removePlayedMsgTracks(msgId, playedIdx) {
    // Check if any tracks for this message remain unplayed (pending or after playedIdx)
    const hasRemaining = adp.tracks.some((t, i) => t.msgId === msgId && (t.pending || i > playedIdx));
    if (hasRemaining) return;

    // All tracks for this message are done — remove them
    const toRemove = new Set();
    for (let i = 0; i < adp.tracks.length; i++) {
        if (adp.tracks[i].msgId === msgId) {
            if (adp.tracks[i].url) URL.revokeObjectURL(adp.tracks[i].url);
            toRemove.add(i);
        }
    }
    if (toRemove.size === 0) return;

    adp.tracks = adp.tracks.filter((_, i) => !toRemove.has(i));
    // Recalculate playingIdx
    adp.playingIdx = -1;
    log(`cleaned msg=${msgId}: removed ${toRemove.size} played tracks`);
}

function skipTrack() {
    if (!adp.isPlaying) return;
    log('skip');
    pttsAudio.pause();
}

function nukePlaylist() {
    const count = adp.tracks.length;
    log(`nuke (${count} tracks, playing=${adp.isPlaying})`);

    // Tell worker to clear its send queue — in-flight server requests will
    // complete but main thread will ignore their responses (no matching promise)
    window._pttsProvider?._worker?.postMessage({ type: 'clear' });

    // Revoke all blob URLs
    for (const t of adp.tracks) {
        if (t.url) URL.revokeObjectURL(t.url);
    }

    // If currently playing, stop audio
    if (adp.isPlaying) {
        pttsAudio.pause();
        pttsAudio.onended = null;
        pttsAudio.onerror = null;
        pttsAudio.removeAttribute('src');
        adp.isPlaying = false;
        adp.playingTrack = null;
        clearHighlight();
        clearMesTextOverflow(adp.tracks[adp.playingIdx]?.msgId);
    }

    adp.tracks = [];
    adp.playingIdx = -1;
    audioWarmupDone = false;
    refreshPlaylistUi();
}

// Nuke only tracks for a specific message
function nukeMsgTracks(msgId) {
    const removed = adp.tracks.filter(t => t.msgId === msgId);
    const remaining = adp.tracks.filter(t => t.msgId !== msgId);

    // Revoke blob URLs for removed tracks
    for (const t of removed) {
        if (t.url) URL.revokeObjectURL(t.url);
    }

    // If currently playing a track from this message, stop it
    if (adp.isPlaying && adp.playingIdx >= 0 && adp.playingIdx < adp.tracks.length) {
        const playing = adp.tracks[adp.playingIdx];
        if (playing && playing.msgId === msgId) {
            pttsAudio.pause();
            pttsAudio.onended = null;
            pttsAudio.onerror = null;
            pttsAudio.removeAttribute('src');
            adp.isPlaying = false;
            adp.playingTrack = null;
            clearHighlight();
            clearMesTextOverflow(msgId);
        }
    }

    // Recalculate playingIdx in new array
    if (adp.playingIdx >= 0 && adp.isPlaying) {
        // Find the playing track's text in remaining
        const playingText = adp.playingTrack;
        adp.playingIdx = remaining.findIndex(t => t.text === playingText);
        if (adp.playingIdx < 0) adp.playingIdx = -1;
    } else {
        adp.playingIdx = -1;
    }

    adp.tracks = remaining;
    log(`nuke msg=${msgId}: removed ${removed.length}, ${remaining.length} remain`);
    refreshPlaylistUi();
    if (!adp.isPlaying) playNextInQueue();
}

function refreshPlaylistUi() {
    window._pttsRefreshPlaylist?.();
}

function getPlaylistView() {
    const view = [];
    let currentMsg = null;

    for (let i = 0; i < adp.tracks.length; i++) {
        const t = adp.tracks[i];
        const isPlaying = i === adp.playingIdx && adp.isPlaying;

        // Start new message group
        if (!currentMsg || currentMsg.msgId !== t.msgId) {
            currentMsg = { msgId: t.msgId, tracks: [], isPlaying: false };
            view.push(currentMsg);
        }

        if (isPlaying) currentMsg.isPlaying = true;
        currentMsg.tracks.push({
            text: t.text,
            playing: isPlaying,
            pending: !!t.pending,
            error: t.error || null,
        });
    }

    // If playing but track was shifted (shouldn't happen with new design), show it
    if (adp.isPlaying && adp.playingTrack && adp.playingIdx < 0) {
        view.unshift({
            msgId: adp.tracks[0]?.msgId ?? '?',
            tracks: [{ text: adp.playingTrack, playing: true, pending: false, error: null }],
            isPlaying: true,
        });
    }

    return view;
}

window._pttsGetPlaylist = getPlaylistView;
window._pttsNukePlaylist = nukePlaylist;
window._pttsNukeMsgTracks = nukeMsgTracks;
window._pttsSkipTrack = skipTrack;

// ─── TTS Generation ────────────────────────────────────────────────

async function adpGenerateAndPlay(msgId, text, isUser = false, charName = '') {
    if (!text || msgId == null) return;
    const provider = window._pttsProvider;
    if (!provider || !provider.ready) return;

    // Use captured voice info
    const voiceId = getVoiceId(isUser, charName);
    log(`[tts] voice: ${voiceId} (${charName}${isUser ? ' user' : ''})`);

    // Add placeholder immediately (sync) — ensures correct order
    const trackIdx = adp.tracks.length;
    const placeholder = { url: null, duration: 0, text, msgId, pending: true, error: null, isUser, charName };
    adp.tracks.push(placeholder);
    log(`add #${trackIdx} msg=${msgId} "${text.substring(0, 50)}"`);
    refreshPlaylistUi();

    try {
        const blobs = [];
        for await (const blobPromise of provider.generateTts(text, voiceId)) {
            const blob = await blobPromise;
            if (blob !== null) blobs.push(blob);
        }

        // If no blobs — track was merged into another, remove placeholder
        if (blobs.length === 0) {
            const idx = adp.tracks.indexOf(placeholder);
            if (idx >= 0) {
                // Find the track that got the merged audio.
                // Search backwards first (most likely), then forwards.
                // The merged track is the one that just completed (has url, not pending).
                let targetIdx = -1;
                for (let i = idx - 1; i >= 0; i--) {
                    if (adp.tracks[i] && adp.tracks[i].url && !adp.tracks[i].pending) {
                        targetIdx = i;
                        break;
                    }
                }
                if (targetIdx < 0) {
                    for (let i = idx + 1; i < adp.tracks.length; i++) {
                        if (adp.tracks[i] && adp.tracks[i].url && !adp.tracks[i].pending) {
                            targetIdx = i;
                            break;
                        }
                    }
                }
                if (targetIdx >= 0) {
                    adp.tracks[targetIdx].text = adp.tracks[targetIdx].text + ' ' + text;
                    log(`merged #${trackIdx} → #${targetIdx} msg=${msgId}`);
                } else {
                    // Target not ready yet — defer removal until it appears.
                    // This can happen when both promises resolve in the same tick
                    // but the target's adpGenerateAndPlay hasn't set url yet.
                    queueMicrotask(() => {
                        const curIdx = adp.tracks.indexOf(placeholder);
                        if (curIdx < 0) return; // already handled
                        let tIdx = -1;
                        for (let i = 0; i < adp.tracks.length; i++) {
                            if (i !== curIdx && adp.tracks[i] && adp.tracks[i].url && !adp.tracks[i].pending) {
                                tIdx = i;
                                break;
                            }
                        }
                        if (tIdx >= 0) {
                            adp.tracks[tIdx].text = adp.tracks[tIdx].text + ' ' + text;
                            log(`merged (deferred) #${trackIdx} → #${tIdx} msg=${msgId}`);
                        } else {
                            log(`merged #${trackIdx} msg=${msgId} (no target found)`);
                        }
                        adp.tracks.splice(curIdx, 1);
                        refreshPlaylistUi();
                    });
                    return;
                }
                adp.tracks.splice(idx, 1);
            }
            // Adjust playingIdx if it shifted
            if (adp.playingIdx >= 0 && idx >= 0 && idx <= adp.playingIdx) {
                adp.playingIdx--;
            }
            refreshPlaylistUi();
            return;
        }

        const combined = new Blob(blobs, { type: blobs[0]?.type || 'audio/mpeg' });

        // Clean up old completed blob URLs to prevent memory leak
        const MAX_QUEUED_BLOBS = 10;
        let completedCount = 0;
        for (let i = 0; i < adp.tracks.length; i++) {
            if (adp.tracks[i].url && !adp.tracks[i].pending && i < adp.playingIdx) {
                completedCount++;
            }
        }
        if (completedCount > MAX_QUEUED_BLOBS) {
            for (let i = 0; i < adp.playingIdx; i++) {
                if (adp.tracks[i].url) {
                    URL.revokeObjectURL(adp.tracks[i].url);
                    adp.tracks[i].url = null;
                }
            }
        }

        placeholder.url = URL.createObjectURL(combined);
        placeholder.duration = provider.lastTiming.audio_duration || (text.length / 15);
        placeholder.pending = false;

        log(`done #${trackIdx} msg=${msgId} ${placeholder.duration.toFixed(1)}s "${text.substring(0, 40)}"`);
        refreshPlaylistUi();
        playNextInQueue();
    } catch (err) {
        placeholder.pending = false;
        placeholder.error = err.message;
        log(`err  #${trackIdx} msg=${msgId} ${err.message}`);
        refreshPlaylistUi();
        playNextInQueue();
    }
}

// ─── Text Capture (global buffer → flat queue) ─────────────────────
// Timer reads chat[mes] AFTER reasoning parsing (chat[lastId].mes is set
// by onProgressStreaming after #autoParseReasoningFromMessage runs).

function startPeriodicTimer() {
    stopPeriodicTimer();
    adp.timer = setInterval(onTick, 250);
}

function stopPeriodicTimer() {
    if (adp.timer) { clearInterval(adp.timer); adp.timer = null; }
}

// Flush any remaining text in the global buffer as a track
function flushBuffer() {
    const text = adp.textBuffer.trimStart();
    if (text.length > 0 && adp.lastMsgId != null) {
        adpGenerateAndPlay(adp.lastMsgId, text, adp.bufferIsUser, adp.bufferCharName);
        adp.textBuffer = '';
    }
}

function processNewText(fullText, msgId) {
    if (!adp.active) return;

    // New message detected (msgId changed)
    if (msgId !== adp.lastMsgId) {
        if (adp.lastMsgId != null) {
            log(`new msg=${msgId} (prev=${adp.lastMsgId})`);
            flushBuffer();
        }
        adp.lastMsgId = msgId;
        adp.lastTextLen = 0;
        adp.textBuffer = '';
        adp.lastSeenPrefix = '';
        // Capture voice info for THIS message's buffer
        adp.bufferIsUser = adp.isUserMsg;
        adp.bufferCharName = adp.msgCharName;
    }

    // Swipe detected (text got shorter = regenerated)
    if (fullText.length < adp.lastTextLen) {
        log(`swipe msg=${msgId}`);
        nukeMsgTracks(msgId);
        adp.lastTextLen = 0;
        adp.textBuffer = '';
        adp.lastSeenPrefix = '';
    }

    if (!fullText || fullText.length <= adp.lastTextLen) return;

    // Detect text modification — ST may change text during streaming (parse reasoning, apply regex)
    // If previously seen text doesn't match current prefix, reset tracking
    if (adp.lastTextLen > 0 && adp.lastSeenPrefix) {
        const currentPrefix = fullText.substring(0, Math.min(adp.lastTextLen, fullText.length));
        if (currentPrefix !== adp.lastSeenPrefix) {
            // Text was modified — reprocess from the last known good position
            log(`text modified at ${adp.lastTextLen}, resetting`);
            // Find where our last seen prefix still matches
            let newOffset = 0;
            for (let i = Math.min(adp.lastSeenPrefix.length, fullText.length) - 1; i > 0; i--) {
                if (fullText.startsWith(adp.lastSeenPrefix.substring(0, i))) {
                    newOffset = i;
                    break;
                }
            }
            adp.lastTextLen = newOffset;
            adp.textBuffer = adp.textBuffer.substring(0, Math.max(0, adp.textBuffer.length - (adp.lastSeenPrefix.length - newOffset)));
        }
    }

    // Append new text to global buffer
    const newText = fullText.substring(adp.lastTextLen);
    adp.lastTextLen = fullText.length;
    adp.lastSeenPrefix = fullText.substring(0, adp.lastTextLen);
    adp.textBuffer += newText;

    // Split sentences and push to queue — server merges short ones
    const { sentences, remainder } = splitSentences(adp.textBuffer);
    if (sentences.length > 0) {
        adp.textBuffer = remainder;
        for (const sentence of sentences) {
            adpGenerateAndPlay(adp.lastMsgId, sentence, adp.bufferIsUser, adp.bufferCharName);
        }
    }
}

function onSwipe() {
    if (!adp.active) return;
    log('swipe event');
    nukeMsgTracks(adp.lastMsgId);
    adp.lastMsgId = null;
    adp.lastTextLen = 0;
    adp.textBuffer = '';
    adp.lastSeenPrefix = '';
}

function onTick() {
    if (!adp.active) return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length) return;

    const lastId = context.chat.length - 1;
    const lastMsg = context.chat[lastId];
    if (!lastMsg || lastMsg.is_system) return;
    // Skip user messages unless narrate_user is enabled
    if (lastMsg.is_user && !extension_settings.tts.narrate_user) {
        log(`[tts] skip user msg: narrate_user=${extension_settings.tts.narrate_user}`);
        return;
    }
    if (!lastMsg.mes && lastMsg.mes !== '') return;

    adp.isUserMsg = !!lastMsg.is_user;
    adp.msgCharName = lastMsg.name || (lastMsg.is_user ? context.name1 : context.name2);
    log(`[tts] tick: isUser=${adp.isUserMsg} name=${adp.msgCharName}`);
    processNewText(lastMsg.mes, lastId);
}

// ─── Warmup ────────────────────────────────────────────────────────

let audioWarmupDone = false;

function warmupAudio() {
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

function isPocketTtsSelected() {
    const es = window.extension_settings || extension_settings;
    return es?.tts?.currentProvider === 'PocketTTS WebSocket';
}

function isPocketTtsActive() {
    const es = window.extension_settings || extension_settings;
    return isPocketTtsSelected() && es?.tts?.enabled === true;
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
    clearHighlight();
    if (isPocketTtsSelected()) disableStTts();
    else enableStTts();
}

function onGenerationStarted(generationType, _args, isDryRun) {
    if (!isPocketTtsActive()) return;
    if (isDryRun) return;

    log(`gen start type=${generationType}`);
    warmupAudio();

    if (generationType === 'regenerate') {
        nukePlaylist();
    }

    // Clear stale audio chunks from previous generation that may not have
    // received a 'done' message — prevents them from being merged with new audio
    const provider = window._pttsProvider;
    if (provider) {
        provider._audioChunks = [];
        provider._cancelledIds.clear();
    }

    adp.active = true;
    adp.textBuffer = '';
    lastSearchOffset = 0;
    adp.lastMsgId = null;
    adp.lastTextLen = 0;
    adp.lastSeenPrefix = '';

    startPeriodicTimer();
}

function onGenerationEnded() {
    onTick();
    if (adp.textBuffer.trim().length > 0) {
        log('gen end flush');
        flushBuffer();
    } else {
        log('gen end');
    }
    // Signal server to flush merge queue
    window._pttsProvider?.sendTextDone();
    adp.active = false;
    stopPeriodicTimer();
}

// ─── Entry Point ───────────────────────────────────────────────────

export function onActivate() {
    registerTtsProvider('PocketTTS WebSocket', PocketTtsProvider);

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

    $('#tts_provider').on('change.ptts', onProviderDropdownChange);
    // Disable ST TTS if PocketTTS is selected — check both saved setting AND dropdown value
    // (dropdown may already have the value from a previous session even if settings aren't loaded yet)
    const pocketTtsIsSelected = isPocketTtsSelected() || (select && select.value === 'PocketTTS WebSocket');
    if (pocketTtsIsSelected) disableStTts();

    ttsBarCleanup = initTtsBar(extension_settings);

    // Override narrate button — handle directly with PocketTTS
    $(document).on('click.ptts', '.mes_narrate', function (e) {
        if (!isPocketTtsActive()) return; // let ST handle it
        e.stopImmediatePropagation();
        e.preventDefault();

        const context = window.SillyTavern?.getContext?.();
        const id = $(this).closest('.mes').attr('mesid');
        const message = context?.chat?.[id];
        if (!message || !message.mes) return;

        log(`narrate msg=${id}`);
        clearHighlight();
        nukePlaylist();
        warmupAudio();
        adp.active = true;
        adp.isUserMsg = !!message.is_user;
        adp.msgCharName = message.name || (message.is_user ? context.name1 : context.name2);
        adp.textBuffer = '';
        lastSearchOffset = 0;
        adp.lastMsgId = null;
        adp.lastTextLen = 0;
        adp.lastSeenPrefix = '';

        // Process the full message immediately
        processNewText(message.mes, Number(id));
        flushBuffer();
        adp.active = false;
    });

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.on(event_types.MESSAGE_SWIPED, onSwipe);

    // Clean up on page unload — revoke blob URLs, stop provider
    window.addEventListener('beforeunload', () => {
        nukePlaylist();
        window._pttsProvider?.dispose();
    });
}

export function onDeactivate() {
    // Remove namespaced event listeners
    $('#tts_provider').off('change.ptts');
    $(document).off('click.ptts', '.mes_narrate');
    eventSource.off(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.off(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.off(event_types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.off(event_types.MESSAGE_SWIPED, onSwipe);

    // Clean up state
    stopPeriodicTimer();
    nukePlaylist();
    clearHighlight();
    enableStTts();
    ttsBarCleanup?.();
    window._pttsProvider?.dispose();
    delete window._pttsProvider;
    delete window._pttsAudio;
}
