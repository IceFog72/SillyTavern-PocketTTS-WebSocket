// PocketTTS — TTS extension for pocket-tts-openapi
// Registers the PocketTTS provider and sentence-based streaming.

import { registerTtsProvider } from '../../tts/index.js';
import { PocketTtsProvider } from './pocket-tts.js';

// ─── Sentence Streaming State ──────────────────────────────────────

let sentenceStreamingEnabled = false;
let messageObserver = null;
let observedElement = null;
let sentenceBuffer = '';
let lastSeenLength = 0;
let audioQueue = [];
let isPlayingAudio = false;
let currentMessageId = null;

const SENTENCE_REGEX = /([.!?…]+)\s+/g;

function getProvider() {
    return window._pttsProvider;
}

// ─── Sentence Extraction ───────────────────────────────────────────

function extractSentences(text) {
    const sentences = [];
    let lastIndex = 0;
    let match;

    while ((match = SENTENCE_REGEX.exec(text)) !== null) {
        const endIdx = match.index + match[0].length;
        const sentence = text.substring(lastIndex, endIdx).trim();
        if (sentence.length > 0) {
            sentences.push(sentence);
        }
        lastIndex = endIdx;
    }

    // Return complete sentences + leftover buffer
    const remainder = text.substring(lastIndex).trim();
    return { sentences, remainder };
}

// ─── Audio Playback Queue ──────────────────────────────────────────

function playNextInQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    isPlayingAudio = true;

    const { blob, url } = audioQueue.shift();
    const audio = new Audio(url);
    audio.playbackRate = 1.0;

    audio.onended = () => {
        URL.revokeObjectURL(url);
        isPlayingAudio = false;
        playNextInQueue();
    };

    audio.onerror = () => {
        URL.revokeObjectURL(url);
        isPlayingAudio = false;
        playNextInQueue();
    };

    audio.play().catch(() => {
        URL.revokeObjectURL(url);
        isPlayingAudio = false;
        playNextInQueue();
    });
}

async function generateAndQueueSentence(text) {
    const provider = getProvider();
    if (!provider || !provider.ready) return;

    // Get voice from voice map
    const voiceMap = window.extension_settings?.tts?.voiceMap || {};
    const context = window.SillyTavern?.getContext?.();
    const charName = context?.name2 || '';
    let voiceName = voiceMap[charName] || voiceMap[''] || provider.settings.voice;

    try {
        const resp = await provider.generateTts(text, voiceName);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        audioQueue.push({ blob, url });
        playNextInQueue();
    } catch (err) {
        console.error('PocketTTS sentence streaming error:', err);
    }
}

// ─── MutationObserver ──────────────────────────────────────────────

function findLastMesText() {
    const mesTexts = document.querySelectorAll('.mes_text');
    return mesTexts.length > 0 ? mesTexts[mesTexts.length - 1] : null;
}

function startObserver() {
    stopObserver();

    observedElement = findLastMesText();
    if (!observedElement) return;

    currentMessageId = observedElement.closest('.mes')?.getAttribute('mesid');
    lastSeenLength = 0;
    sentenceBuffer = '';

    messageObserver = new MutationObserver(() => {
        const fullText = observedElement.innerText || observedElement.textContent || '';
        if (fullText.length <= lastSeenLength) return;

        const newText = fullText.substring(lastSeenLength);
        sentenceBuffer += newText;
        lastSeenLength = fullText.length;

        const { sentences, remainder } = extractSentences(sentenceBuffer);

        for (const sentence of sentences) {
            generateAndQueueSentence(sentence);
        }
        sentenceBuffer = remainder;
    });

    messageObserver.observe(observedElement, {
        childList: true,
        subtree: true,
        characterData: true,
    });

    console.debug('PocketTTS: Sentence streaming observer started');
}

function stopObserver() {
    if (messageObserver) {
        messageObserver.disconnect();
        messageObserver = null;
    }

    // Send any remaining buffered text
    if (sentenceBuffer.trim().length > 3) {
        generateAndQueueSentence(sentenceBuffer.trim());
    }
    sentenceBuffer = '';
    lastSeenLength = 0;
    observedElement = null;
    console.debug('PocketTTS: Sentence streaming observer stopped');
}

// ─── Extension Lifecycle ───────────────────────────────────────────

export function onActivate() {
    registerTtsProvider('PocketTTS', PocketTtsProvider);
    injectSentenceStreamingToggle();
}

function injectSentenceStreamingToggle() {
    // Wait for TTS settings panel to be ready
    const checkInterval = setInterval(() => {
        const ttsContainer = $('#tts_block, #ttsExtensionMenuItem').closest('.extensions_settings, .extensionsMenu, .inline-drawer');
        if (ttsContainer.length === 0) {
            // Try alternate locations
            if ($('#tts_auto_generation').length > 0) {
                clearInterval(checkInterval);
                appendToggle();
            }
            return;
        }
        clearInterval(checkInterval);
        appendToggle();
    }, 1000);
}

function appendToggle() {
    // Don't add twice
    if ($('#ptts_sentence_streaming').length > 0) return;

    // Insert after the existing TTS auto-generation checkbox
    const anchor = $('#tts_periodic_auto_generation').closest('.checkbox_label, .tts-option-block');
    if (anchor.length === 0) {
        // Retry after a delay
        setTimeout(appendToggle, 2000);
        return;
    }

    const toggleHtml = `
    <label for="ptts_sentence_streaming" class="checkbox_label" title="PocketTTS: Send each complete sentence to TTS immediately as it streams in (faster than paragraph-based)">
        <input id="ptts_sentence_streaming" type="checkbox" />
        <span>PocketTTS: Sentence streaming</span>
    </label>
    `;

    anchor.after(toggleHtml);

    // Restore saved state
    const saved = localStorage.getItem('ptts_sentence_streaming');
    if (saved === 'true') {
        $('#ptts_sentence_streaming').prop('checked', true);
        sentenceStreamingEnabled = true;
        startGenerationListeners();
    }

    $('#ptts_sentence_streaming').on('change', function () {
        sentenceStreamingEnabled = $(this).is(':checked');
        localStorage.setItem('ptts_sentence_streaming', String(sentenceStreamingEnabled));

        if (sentenceStreamingEnabled) {
            startGenerationListeners();
        } else {
            stopGenerationListeners();
            stopObserver();
        }
    });

    console.debug('PocketTTS: Sentence streaming toggle injected');
}

// ─── Generation Lifecycle Hooks ────────────────────────────────────

let generationStartedHooked = false;

function startGenerationListeners() {
    if (generationStartedHooked) return;
    generationStartedHooked = true;

    // Listen for generation start — start observing DOM
    if (window.eventSource && window.event_types) {
        window.eventSource.on(window.event_types.GENERATION_STARTED, onGenerationStarted);
        window.eventSource.on(window.event_types.GENERATION_ENDED, onGenerationEnded);
    }

    // Also watch for new message elements appearing (fallback)
    watchForNewMessages();
}

function stopGenerationListeners() {
    generationStartedHooked = false;
    if (window.eventSource && window.event_types) {
        window.eventSource.removeListener(window.event_types.GENERATION_STARTED, onGenerationStarted);
        window.eventSource.removeListener(window.event_types.GENERATION_ENDED, onGenerationEnded);
    }
}

function onGenerationStarted() {
    if (!sentenceStreamingEnabled) return;
    // Small delay to let the message element render
    setTimeout(() => startObserver(), 300);
}

function onGenerationEnded() {
    if (!sentenceStreamingEnabled) return;
    stopObserver();
}

function watchForNewMessages() {
    // Watch the chat container for new message elements
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) {
        setTimeout(watchForNewMessages, 2000);
        return;
    }

    const containerObserver = new MutationObserver(() => {
        if (!sentenceStreamingEnabled) return;

        // Check if there's an actively streaming message (has "generating" class or similar)
        const lastMes = findLastMesText();
        if (lastMes && lastMes !== observedElement && sentenceStreamingEnabled) {
            // New message element detected, start observing it
            startObserver();
        }
    });

    containerObserver.observe(chatContainer, {
        childList: true,
        subtree: true,
    });
}
