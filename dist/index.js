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
//     → timer (500ms) reads new chars
//     → processNewText() appends to textBuffer
//     → splitSentences() on sentence boundaries (. ! ? …)
//     → adpGenerateAndPlay() creates placeholder in tracks[], sends WS request
//     → server generates audio (may merge short sentences)
//     → placeholder.url filled, pending=false
//     → playNextInQueue() plays in tracks[] order
// SillyTavern runtime modules live outside this extension package and do not ship local .d.ts files.
// @ts-ignore
import { registerTtsProvider } from '../../../tts/index.js';
// @ts-ignore
import { event_types, eventSource } from '../../../../../script.js';
// @ts-ignore
import { extension_settings } from '../../../../extensions.js';
import { PocketTtsProvider } from './pocket-tts.js';
import { initTtsBar } from './tts-bar.js';
import { pcmPosition, pcmDuration, pausePcm, resumePcm, seekPcm, setPcmRate, setPcmVolume } from './pcm-playback.js';
// All console output prefixed [pocketTTS-WS] for easy filtering in devtools
const log = (...args) => console.log('[pocketTTS-WS]', ...args);
const logDebug = (...args) => console.debug('[pocketTTS-WS]', ...args);
// ─── State ─────────────────────────────────────────────────────────
let ttsBarCleanup = null;
let nextTrackId = 0; // unique ID for each track
const adp = {
    // WHY flat array: tracks are ordered by text arrival = play order.
    // Each {url, duration, text, msgId, pending, error}.
    // msgId tags each track so playlist UI can group by message.
    tracks: [],
    playingIdx: -1, // index into tracks[] of currently playing track (-1 = none)
    playingTrack: null, // text of track currently playing
    isPlaying: false,
    timer: null, // 500ms interval that reads chat[mes].mes
    active: false, // true during generation — timer only runs when active
    textBuffer: '', // accumulates chars from streaming text until sentence boundary found
    lastMsgId: null, // current message being streamed — used to detect new message / swipe
    lastTextLen: 0, // how many chars of chat[mes].mes we've already processed
    lastSeenPrefix: '', // prefix of last seen fullText — used to detect in-place modifications
    isUserMsg: false, // whether current message is from user
    msgCharName: '', // character name from current message (name property)
    bufferIsUser: false, // isUser captured when buffer started (for this message)
    bufferCharName: '', // charName captured when buffer started (for this message)
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
// Don't split when punctuation is inside quotes to preserve dialogue.
// Fix #14: Cleaned up regex character class — removed redundant characters.
const SENTENCE_END = /(?<![""\u201c\u201d\u2018\u2019'])[.!?…][)]*\s+/g;
function splitSentences(text) {
    const result = [];
    SENTENCE_END.lastIndex = 0; // reset regex state (global flag)
    let lastIdx = 0;
    let match;
    while ((match = SENTENCE_END.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const s = text.substring(lastIdx, end).trimStart();
        if (s.length > 0)
            result.push(s);
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
    if (!voiceId && isUserMessage)
        voiceId = voiceMap['User'];
    // Fix #13: Avoid circular fallback where voiceMap['[Default Voice]'] === '[Default Voice]'
    if (voiceId === '[Default Voice]') {
        const defaultVoice = voiceMap['[Default Voice]'];
        voiceId = (defaultVoice && defaultVoice !== '[Default Voice]') ? defaultVoice : null;
    }
    if (!voiceId || voiceId === 'disabled') {
        voiceId = voiceMap['[Default Voice]'] || provider?.settings?.voice || 'nova';
    }
    return voiceId;
}
// ─── Shared Audio Element ──────────────────────────────────────────
const pttsAudio = new Audio();
pttsAudio.id = 'ptts_audio';
function activePcmStream() {
    return adp.isPlaying ? adp.tracks[adp.playingIdx]?.audioStream : null;
}
// Both players expose the same controls to the bar. Saved bar preferences
// carry across sentence boundaries without relying on an idle media clock.
const pcmPlayback = {
    get paused() { return !activePcmStream()?.playing; },
    get currentTime() { const stream = activePcmStream(); return stream ? pcmPosition(stream) : 0; },
    set currentTime(value) { const stream = activePcmStream(); if (stream)
        seekPcm(stream, value); },
    get duration() { const stream = activePcmStream(); return stream ? pcmDuration(stream) : 0; },
    get volume() { return activePcmStream()?.output.gain.value ?? pttsAudio.volume; },
    set volume(value) { pttsAudio.volume = value; const stream = activePcmStream(); if (stream)
        setPcmVolume(stream, value); },
    get playbackRate() { return activePcmStream()?.playbackRate ?? pttsAudio.playbackRate; },
    set playbackRate(value) { pttsAudio.defaultPlaybackRate = value; pttsAudio.playbackRate = value; const stream = activePcmStream(); if (stream)
        setPcmRate(stream, value); },
    play() { const stream = activePcmStream(); if (stream)
        resumePcm(stream); return Promise.resolve(); },
    pause() { const stream = activePcmStream(); if (stream)
        pausePcm(stream); },
    get _savedVol() { return pttsAudio._savedVol; },
    set _savedVol(value) { pttsAudio._savedVol = value; },
};
const getPlayback = () => activePcmStream() ? pcmPlayback : null;
window._pttsGetPlayback = getPlayback;
function scheduleUiTask(fn, label) {
    setTimeout(() => {
        try {
            fn();
        }
        catch (err) {
            console.warn(`[pocketTTS-WS] ${label} failed`, err);
        }
    }, 0);
}
// ─── Per-Message Playlist Playback ─────────────────────────────────
let activeTrackCleanup = null;
function playNextInQueue() {
    if (adp.isPlaying)
        return;
    // Skip past error tracks, find first playable
    while (adp.playingIdx + 1 < adp.tracks.length) {
        const next = adp.tracks[adp.playingIdx + 1];
        if (next.error) {
            adp.playingIdx++;
            log(`skip error: "${next.text.substring(0, 30)}" (${next.error})`);
            continue;
        }
        if (next.pending)
            break; // wait for it
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
    if (!audioWarmupDone && !item.audioStream) {
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
    adp.playingTrack = item.currentText || item.text;
    log(`play #${nextIdx} msg=${item.msgId} "${adp.playingTrack.substring(0, 50)}"`);
    refreshPlaylistUi();
    const audioEl = pttsAudio;
    if (item.audioStream) {
        const cleanup = () => {
            if (activeTrackCleanup !== cleanup)
                return;
            activeTrackCleanup = null;
            window._pttsProvider?._stopPcmStream(item.audioStream);
            adp.isPlaying = false;
            adp.playingTrack = null;
            removePlayedMsgTracks(item.msgId, item.trackId);
            refreshPlaylistUi();
            playNextInQueue();
        };
        activeTrackCleanup = cleanup;
        item.audioStream.onEnded = cleanup;
        const savedVolume = localStorage.getItem('ptts-bar-volume');
        const savedRate = localStorage.getItem('ptts-bar-speed');
        setPcmVolume(item.audioStream, savedVolume === null ? pttsAudio.volume : Number(savedVolume));
        setPcmRate(item.audioStream, savedRate === null ? pttsAudio.playbackRate : Number(savedRate));
        window._pttsProvider?._startPcmStream(item.audioStream);
        return;
    }
    audioEl.src = item.url;
    const cleanup = () => {
        if (activeTrackCleanup !== cleanup)
            return;
        activeTrackCleanup = null;
        URL.revokeObjectURL(item.url);
        adp.isPlaying = false;
        adp.playingTrack = null;
        // Remove played tracks for this message if no more remain
        removePlayedMsgTracks(item.msgId, item.trackId);
        refreshPlaylistUi();
        playNextInQueue();
    };
    activeTrackCleanup = cleanup;
    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(() => cleanup());
}
// Remove played tracks for a message when all its tracks are done
function removePlayedMsgTracks(msgId, playedTrackId) {
    const playedIdx = adp.tracks.findIndex(t => t.trackId === playedTrackId);
    if (playedIdx < 0)
        return;
    // Check if any tracks for this message remain unplayed (pending or after playedIdx)
    const hasRemaining = adp.tracks.some((t, i) => t.msgId === msgId && (t.pending || i > playedIdx));
    if (hasRemaining)
        return;
    // All tracks for this message are done — remove them
    const toRemove = new Set();
    for (let i = 0; i < adp.tracks.length; i++) {
        if (adp.tracks[i].msgId === msgId) {
            if (adp.tracks[i].url)
                URL.revokeObjectURL(adp.tracks[i].url);
            toRemove.add(i);
        }
    }
    if (toRemove.size === 0)
        return;
    adp.tracks = adp.tracks.filter((_, i) => !toRemove.has(i));
    // Recalculate playingIdx
    adp.playingIdx = -1;
    log(`cleaned msg=${msgId}: removed ${toRemove.size} played tracks`);
}
function skipTrack() {
    if (!adp.isPlaying || !activeTrackCleanup)
        return;
    log('skip');
    pttsAudio.pause();
    const cleanup = activeTrackCleanup;
    cleanup();
}
function nukePlaylist() {
    const count = adp.tracks.length;
    log(`nuke (${count} tracks, playing=${adp.isPlaying})`);
    window._pttsProvider?.resetSession('playlist nuked');
    // Revoke all blob URLs
    for (const t of adp.tracks) {
        if (t.url)
            URL.revokeObjectURL(t.url);
        if (t.audioStream)
            window._pttsProvider?._stopPcmStream(t.audioStream);
    }
    // If currently playing, stop audio
    if (adp.isPlaying) {
        pttsAudio.pause();
        pttsAudio.onended = null;
        pttsAudio.onerror = null;
        pttsAudio.removeAttribute('src');
        adp.isPlaying = false;
        activeTrackCleanup = null;
        adp.playingTrack = null;
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
        if (t.url)
            URL.revokeObjectURL(t.url);
        if (t.audioStream)
            window._pttsProvider?._stopPcmStream(t.audioStream);
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
            activeTrackCleanup = null;
            adp.playingTrack = null;
        }
    }
    // Recalculate playingIdx in new array
    // Fix #4: Use trackId for unique matching instead of .text
    if (adp.playingIdx >= 0 && adp.isPlaying) {
        const playingTrackId = adp.tracks[adp.playingIdx]?.trackId;
        if (playingTrackId != null) {
            adp.playingIdx = remaining.findIndex(t => t.trackId === playingTrackId);
        }
        else {
            adp.playingIdx = -1;
        }
        if (adp.playingIdx < 0)
            adp.playingIdx = -1;
    }
    else {
        adp.playingIdx = -1;
    }
    adp.tracks = remaining;
    log(`nuke msg=${msgId}: removed ${removed.length}, ${remaining.length} remain`);
    refreshPlaylistUi();
    if (!adp.isPlaying)
        playNextInQueue();
}
function refreshPlaylistUi() {
    scheduleUiTask(() => window._pttsRefreshPlaylist?.(), 'playlist refresh');
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
        if (t.playlistSegments?.length) {
            const activeSegment = t.activeSegment ?? 0;
            if (isPlaying)
                currentMsg.isPlaying = true;
            for (let j = 0; j < t.playlistSegments.length; j++) {
                currentMsg.tracks.push({
                    text: t.playlistSegments[j],
                    playing: isPlaying && j === activeSegment,
                    pending: !!t.pending,
                    error: t.error || null,
                });
            }
        }
        else {
            if (isPlaying)
                currentMsg.isPlaying = true;
            currentMsg.tracks.push({
                text: t.text,
                playing: isPlaying,
                pending: !!t.pending,
                error: t.error || null,
            });
        }
    }
    // Fix #19: Only show phantom entry if we have a valid msgId from tracks
    if (adp.isPlaying && adp.playingTrack && adp.playingIdx < 0 && adp.tracks.length > 0) {
        view.unshift({
            msgId: adp.tracks[0]?.msgId ?? null,
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
    if (!text || msgId == null)
        return;
    const provider = window._pttsProvider;
    if (!provider || !provider.ready)
        return;
    // Use captured voice info
    const voiceId = getVoiceId(isUser, charName);
    log(`[tts] voice: ${voiceId} (${charName}${isUser ? ' user' : ''})`);
    // Add placeholder immediately (sync) — ensures correct order
    // Fix #4: Include unique trackId for reliable matching
    const trackIdx = adp.tracks.length;
    const placeholder = { trackId: nextTrackId++, url: null, duration: 0, text, msgId, pending: true, error: null, isUser, charName, audioStream: null };
    adp.tracks.push(placeholder);
    log(`add #${trackIdx} msg=${msgId} "${text.substring(0, 50)}"`);
    refreshPlaylistUi();
    try {
        const blobs = [];
        let streamed = null;
        for await (const blobPromise of provider.generateTts(text, voiceId)) {
            const result = await blobPromise;
            if (result && typeof result === 'object' && 'streamUrl' in result) {
                streamed = result;
                break;
            }
            if (result !== null)
                blobs.push(result);
        }
        if (streamed) {
            placeholder.url = streamed.streamUrl;
            placeholder.audioStream = streamed.audioStream;
            placeholder.duration = text.length / 15;
            placeholder.pending = false;
            log(`stream #${trackIdx} msg=${msgId} "${text.substring(0, 40)}"`);
            refreshPlaylistUi();
            setTimeout(() => {
                refreshPlaylistUi();
                playNextInQueue();
            }, 0);
            return;
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
                }
                else {
                    // Target not ready yet — defer removal until it appears.
                    // This can happen when both promises resolve in the same tick
                    // but the target's adpGenerateAndPlay hasn't set url yet.
                    queueMicrotask(() => {
                        const curIdx = adp.tracks.indexOf(placeholder);
                        if (curIdx < 0)
                            return; // already handled
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
                        }
                        else {
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
        // Merged responses resolve the playable blob before the absorbed
        // requests resolve null and append their text to this placeholder.
        // Give those continuations a tick so playback sees the full
        // merged track text instead of only the first sentence.
        setTimeout(() => {
            refreshPlaylistUi();
            playNextInQueue();
        }, 0);
    }
    catch (err) {
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
    adp.timer = setInterval(onTick, 500);
}
function stopPeriodicTimer() {
    if (adp.timer) {
        clearInterval(adp.timer);
        adp.timer = null;
    }
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
    if (!adp.active)
        return;
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
    if (!fullText || fullText.length <= adp.lastTextLen)
        return;
    // Detect text modification — ST may change text during streaming (parse reasoning, apply regex)
    // If previously seen text doesn't match current prefix, reset tracking
    // Fix: Only reset on DELETIONS (text got shorter than what we've seen).
    // Insertions/modifications that shift text should NOT reprocess old content.
    if (adp.lastTextLen > 0 && adp.lastSeenPrefix && fullText.length >= adp.lastSeenPrefix.length) {
        const currentPrefix = fullText.substring(0, adp.lastSeenPrefix.length);
        if (currentPrefix !== adp.lastSeenPrefix) {
            // Prefix changed — could be a modification during streaming.
            // Only reset if we can find where the old prefix still matches,
            // meaning text was deleted/shifted. Otherwise keep current position.
            let newOffset = 0;
            for (let i = Math.min(adp.lastSeenPrefix.length, fullText.length) - 1; i > 0; i--) {
                if (fullText.startsWith(adp.lastSeenPrefix.substring(0, i))) {
                    newOffset = i;
                    break;
                }
            }
            // Only reset if we found a valid match point (not the full current position)
            if (newOffset < adp.lastTextLen) {
                log(`text modified at ${adp.lastTextLen}, resetting to ${newOffset}`);
                const charsDeleted = adp.lastTextLen - newOffset;
                adp.lastTextLen = newOffset;
                if (charsDeleted > 0 && adp.textBuffer.length > 0) {
                    const trim = Math.min(charsDeleted, adp.textBuffer.length);
                    adp.textBuffer = adp.textBuffer.substring(0, adp.textBuffer.length - trim);
                    if (charsDeleted > trim) {
                        log(`text modified: ${charsDeleted - trim} chars lost (deletion exceeds buffer)`);
                    }
                }
            }
            else {
                // No earlier match found — text was modified but not deleted.
                // Skip ahead to avoid reprocessing. Update prefix to current state.
                log(`text modified but keeping position at ${adp.lastTextLen}`);
                adp.lastSeenPrefix = fullText.substring(0, Math.min(adp.lastTextLen, fullText.length));
            }
        }
    }
    // Append new text to global buffer
    const newText = fullText.substring(adp.lastTextLen);
    adp.lastTextLen = fullText.length;
    adp.lastSeenPrefix = fullText;
    adp.textBuffer += newText;
    // Send complete sentences while the rest of the reply is arriving.
    const { sentences, remainder } = splitSentences(adp.textBuffer);
    if (sentences.length > 0) {
        adp.textBuffer = remainder;
        for (const sentence of sentences) {
            adpGenerateAndPlay(adp.lastMsgId, sentence, adp.bufferIsUser, adp.bufferCharName);
        }
    }
}
function onSwipe() {
    // Fix: Don't gate on adp.active — swipe can happen after generation ends
    // while old audio is still playing. We need to stop it regardless.
    log('swipe event');
    // Determine which message to nuke: currently playing or last generated
    const playingMsgId = adp.isPlaying && adp.playingIdx >= 0
        ? adp.tracks[adp.playingIdx]?.msgId
        : null;
    const targetMsgId = playingMsgId ?? adp.lastMsgId;
    if (targetMsgId != null) {
        nukeMsgTracks(targetMsgId);
    }
    else {
        // No known message — just stop any playing audio
        if (adp.isPlaying) {
            pttsAudio.pause();
            pttsAudio.onended = null;
            pttsAudio.onerror = null;
            pttsAudio.removeAttribute('src');
            adp.isPlaying = false;
            adp.playingTrack = null;
        }
    }
    adp.lastMsgId = null;
    adp.lastTextLen = 0;
    adp.textBuffer = '';
    adp.lastSeenPrefix = '';
    setTimeout(() => narrateCurrentLastMessageAfterSwipe(), 0);
}
function narrateCurrentLastMessageAfterSwipe() {
    if (!isPocketTtsActive())
        return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length)
        return;
    const msgId = context.chat.length - 1;
    const message = context.chat[msgId];
    if (!message || message.is_system || !message.mes)
        return;
    if (message.is_user && !extension_settings.tts.narrate_user)
        return;
    const provider = window._pttsProvider;
    provider?.resetSession('message swipe');
    log(`swipe narrate msg=${msgId}`);
    adp.active = true;
    adp.isUserMsg = !!message.is_user;
    adp.msgCharName = message.name || (message.is_user ? context.name1 : context.name2);
    adp.bufferIsUser = adp.isUserMsg;
    adp.bufferCharName = adp.msgCharName;
    adp.textBuffer = '';
    adp.lastMsgId = null;
    adp.lastTextLen = 0;
    adp.lastSeenPrefix = '';
    processNewText(message.mes, msgId);
    flushBuffer();
    provider?.sendTextDone();
    adp.active = false;
}
function onTick() {
    if (!adp.active)
        return;
    const context = window.SillyTavern?.getContext?.();
    if (!context?.chat?.length)
        return;
    const lastId = context.chat.length - 1;
    const lastMsg = context.chat[lastId];
    if (!lastMsg || lastMsg.is_system)
        return;
    // Skip user messages unless narrate_user is enabled
    if (lastMsg.is_user && !extension_settings.tts.narrate_user) {
        logDebug(`[tts] skip user msg: narrate_user=${extension_settings.tts.narrate_user}`);
        return;
    }
    if (lastMsg.mes == null)
        return;
    adp.isUserMsg = !!lastMsg.is_user;
    adp.msgCharName = lastMsg.name || (lastMsg.is_user ? context.name1 : context.name2);
    logDebug(`[tts] tick: isUser=${adp.isUserMsg} name=${adp.msgCharName}`);
    processNewText(lastMsg.mes, lastId);
}
// ─── Warmup ────────────────────────────────────────────────────────
let audioWarmupDone = false;
// Fix #9: Removed redundant warmupAudio() — playNextInQueue() already handles warmup.
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
    return isPocketTtsSelected() && window._pttsProvider?.ready === true;
}
function disableStTts() {
    const es = window.extension_settings || extension_settings;
    if (!es?.tts)
        return;
    if (stSettingsSaved === null) {
        stSettingsSaved = {};
        for (const key of ST_KEYS)
            stSettingsSaved[key] = es.tts[key];
    }
    for (const key of ST_KEYS)
        es.tts[key] = false;
    for (const id of ST_CHECKBOXES) {
        const cb = document.getElementById(id);
        if (cb) {
            cb.checked = false;
            cb.disabled = true;
        }
    }
}
function enableStTts() {
    const es = window.extension_settings || extension_settings;
    if (stSettingsSaved !== null) {
        for (const key of ST_KEYS) {
            if (es?.tts)
                es.tts[key] = stSettingsSaved[key];
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
    if (isPocketTtsSelected())
        disableStTts();
    else
        enableStTts();
}
function onGenerationStarted(generationType, _args, isDryRun) {
    if (!isPocketTtsActive())
        return;
    if (isDryRun)
        return;
    log(`gen start type=${generationType}`);
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
    }
    else {
        log('gen end');
    }
    // Signal server to flush merge queue
    window._pttsProvider?.sendTextDone();
    adp.active = false;
    stopPeriodicTimer();
}
// ─── Entry Point ───────────────────────────────────────────────────
export function onActivate() {
    log('activate', {
        provider: extension_settings?.tts?.currentProvider,
        enabled: extension_settings?.tts?.enabled,
    });
    registerTtsProvider('PocketTTS WebSocket', PocketTtsProvider);
    window._pttsAudio = pttsAudio;
    window._pttsGetPlayback = getPlayback;
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
    if (pocketTtsIsSelected)
        disableStTts();
    ttsBarCleanup = initTtsBar(extension_settings);
    log('narrate handlers installing');
    let lastNarrateAt = 0;
    let lastNarrateMsgId = null;
    async function narrateButton(btn) {
        log('narrate button invoked', {
            selected: isPocketTtsSelected(),
            active: isPocketTtsActive(),
            ready: window._pttsProvider?.ready,
            worker: !!window._pttsProvider?._worker,
        });
        if (!isPocketTtsSelected()) {
            log('narrate skipped: provider not selected', {
                provider: (window.extension_settings || extension_settings)?.tts?.currentProvider,
            });
            return;
        }
        const provider = window._pttsProvider;
        if (!provider) {
            log('narrate skipped: provider missing');
            return;
        }
        if (!provider.ready && !(await provider.checkReady())) {
            log('narrate skipped: PocketTTS server not ready');
            return;
        }
        provider.resetSession('manual narrate');
        const context = window.SillyTavern?.getContext?.();
        const id = btn.closest('.mes')?.getAttribute('mesid');
        const message = context?.chat?.[id];
        log('narrate message lookup', {
            id,
            hasContext: !!context,
            hasMessage: !!message,
            chars: message?.mes?.length || 0,
        });
        if (!message || !message.mes) {
            log('narrate skipped: message missing or empty');
            return;
        }
        const now = Date.now();
        if (lastNarrateMsgId === id && now - lastNarrateAt < 500)
            return;
        lastNarrateMsgId = id;
        lastNarrateAt = now;
        log(`narrate msg=${id}`);
        nukePlaylist();
        adp.active = true;
        adp.isUserMsg = !!message.is_user;
        adp.msgCharName = message.name || (message.is_user ? context.name1 : context.name2);
        adp.textBuffer = '';
        adp.lastMsgId = null;
        adp.lastTextLen = 0;
        adp.lastSeenPrefix = '';
        processNewText(message.mes, Number(id));
        flushBuffer();
        window._pttsProvider?.sendTextDone();
        adp.active = false;
    }
    // Override narrate button — capture catches normal DOM clicks before ST's
    // delegated handler, jQuery covers cases where ST synthesizes the event.
    function narrateCaptureHandler(e) {
        const target = e.target instanceof Element ? e.target : null;
        const btn = target?.closest('.mes_narrate');
        if (!btn || !isPocketTtsSelected())
            return;
        log('narrate capture handler hit');
        e.stopImmediatePropagation();
        e.preventDefault();
        void narrateButton(btn);
    }
    function narrateKeydownCaptureHandler(e) {
        if (e.key !== 'Enter' && e.key !== ' ')
            return;
        void narrateCaptureHandler(e);
    }
    document.addEventListener('click', narrateCaptureHandler, true);
    document.addEventListener('keydown', narrateKeydownCaptureHandler, true);
    $(document).off('click.pttsNarrate', '.mes_narrate').on('click.pttsNarrate', '.mes_narrate', function (e) {
        if (!isPocketTtsSelected())
            return;
        log('narrate jquery handler hit');
        e.stopImmediatePropagation();
        e.preventDefault();
        void narrateButton(this);
    });
    window._pttsNarrateCaptureHandler = narrateCaptureHandler;
    window._pttsNarrateKeydownCaptureHandler = narrateKeydownCaptureHandler;
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
    if (window._pttsNarrateCaptureHandler) {
        document.removeEventListener('click', window._pttsNarrateCaptureHandler, true);
        delete window._pttsNarrateCaptureHandler;
    }
    if (window._pttsNarrateKeydownCaptureHandler) {
        document.removeEventListener('keydown', window._pttsNarrateKeydownCaptureHandler, true);
        delete window._pttsNarrateKeydownCaptureHandler;
    }
    $(document).off('click.pttsNarrate', '.mes_narrate');
    eventSource.off(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.off(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.off(event_types.GENERATION_STOPPED, onGenerationEnded);
    eventSource.off(event_types.MESSAGE_SWIPED, onSwipe);
    // Clean up state
    stopPeriodicTimer();
    nukePlaylist();
    enableStTts();
    ttsBarCleanup?.();
    window._pttsProvider?.dispose();
    delete window._pttsProvider;
    delete window._pttsAudio;
    delete window._pttsGetPlayback;
}
//# sourceMappingURL=index.js.map