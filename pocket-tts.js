// pocket-tts.js — SillyTavern TTS Provider for pocket-tts-openapi
// Web Worker for WS connection (survives main thread blocking by LLM streaming).

import { saveTtsProviderSettings, getPreviewString } from '../../tts/index.js';

export { PocketTtsProvider };

class PocketTtsProvider {
    settings = {};
    ready = false;
    voices = [];
    separator = '. ';
    static EXPECTED_SERVER_VERSION = '2.0.0';

    audioElement = document.createElement('audio');

    _worker = null;
    _workerReady = false;
    // Main thread: tracks promises by request_id — resolved when audio arrives
    _wsPending = [];
    // Buffer for responses that arrive before their promises are created
    _doneBuffer = new Map();  // request_id → {chunks, timing}
    static MAX_DONE_BUFFER = 10; // limit to prevent memory leak
    // Raw audio chunk buffer — accumulated between requests, claimed on 'done'
    _audioChunks = [];
    // Track cancelled/timed-out request IDs to discard late chunks
    _cancelledIds = new Set();
    // Send queue: ensures text goes to server in order (sequential IDs)
    // Sends fire-and-forget — doesn't wait for response
    _sendQueue = [];
    _nextReqId = 0;

    static MAX_RETRIES = 3;
    static RETRY_DELAYS = [1000, 2000, 4000];

    static MODEL_OPTIONS = [
        { value: 'english-cpu', label: 'english-cpu' },
        { value: 'english-gpu', label: 'english-gpu' },
    ];

    defaultSettings = {
        provider_endpoint: 'http://localhost:8005',
        voice: 'nova',
        format: 'mp3',
        speed: 1.0,
        temperature: 1.0,
        top_p: 1.0,
        model: 'english-cpu',
        voiceMap: {},
    };

    // ─── Settings HTML ──────────────────────────────────────────────

    get settingsHtml() {
        const modelOptions = PocketTtsProvider.MODEL_OPTIONS
            .map(m => `<option value="${m.value}"${this.defaultSettings.model === m.value ? ' selected' : ''}>${m.label}</option>`)
            .join('');

        return `
        <div class="pocket-tts-settings">
            <label for="ptts_endpoint">Server Endpoint:</label>
            <input id="ptts_endpoint" type="text" class="text_pole" maxlength="500"
                value="${this.defaultSettings.provider_endpoint}" placeholder="http://localhost:8005" />

            <div id="ptts_server_info" style="margin:4px 0;font-size:0.85em;color:#888;"></div>
            <div id="ptts_version_warning" style="margin:4px 0;font-size:0.85em;display:none;"></div>
            <div id="ptts_status" style="margin:4px 0;font-size:0.85em;">
                <span style="color:#888;">●</span> Not connected
            </div>

            <label for="ptts_model">Model:</label>
            <select id="ptts_model" class="text_pole">
                ${modelOptions}
            </select>

            <label for="ptts_format">Audio Format:</label>
            <select id="ptts_format" class="text_pole">
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
                <option value="opus">Opus</option>
                <option value="flac">FLAC</option>
                <option value="aac">AAC</option>
            </select>

            <label for="ptts_speed">Speed: <span id="ptts_speed_val">${this.defaultSettings.speed}</span></label>
            <input id="ptts_speed" type="range" min="0.5" max="2.0" step="0.1"
                value="${this.defaultSettings.speed}" />

            <label for="ptts_temperature">Temperature: <span id="ptts_temperature_val">${this.defaultSettings.temperature}</span></label>
            <input id="ptts_temperature" type="range" min="0.0" max="2.0" step="0.1"
                value="${this.defaultSettings.temperature}" />

            <label for="ptts_top_p">Top P: <span id="ptts_top_p_val">${this.defaultSettings.top_p}</span></label>
            <input id="ptts_top_p" type="range" min="0.0" max="1.0" step="0.05"
                value="${this.defaultSettings.top_p}" />
        </div>
        `;
    }

    // ─── Status ─────────────────────────────────────────────────────

    _updateStatus(connected, fatal = false) {
        const el = document.getElementById('ptts_status');
        if (!el) return;
        const pending = this._wsPending.length;
        const qInfo = pending > 0 ? ` (${pending} pending)` : '';

        if (fatal) {
            el.innerHTML = `<span style="color:#f44336;">&#9888; Connection failed permanently.</span><br><small>Max retries reached. Check server and manual reload ST.</small>`;
            return;
        }

        el.innerHTML = connected
            ? `<span style="color:#4caf50;">●</span> Connected${qInfo}`
            : `<span style="color:#f44336;">●</span> Disconnected${qInfo}`;
    }

    _updateServerInfo(info) {
        const el = document.getElementById('ptts_server_info');
        if (!el || !info) return;
        const parts = [];
        if (info.device) parts.push('Device: ' + info.device);
        if (info.sample_rate) parts.push(info.sample_rate + 'Hz');
        parts.push(info.voice_cloning ? 'Voice cloning: ON' : 'Voice cloning: OFF');
        el.textContent = parts.join(' | ');
        el.style.color = '#6a6';

        // Version check
        const warnEl = document.getElementById('ptts_version_warning');
        if (warnEl) {
            const serverVer = info.version || '';
            const expected = PocketTtsProvider.EXPECTED_SERVER_VERSION;
            if (serverVer && serverVer !== expected) {
                warnEl.innerHTML = `<span style="color:#f44336;">&#9888; Version mismatch: server ${serverVer}, extension expects ${expected}. Please update the server.</span>`;
                warnEl.style.display = 'block';
            } else {
                warnEl.style.display = 'none';
            }
        }
    }

    // ─── Settings Load / Change ─────────────────────────────────────

    onSettingsChange() {
        const oldEndpoint = this.settings.provider_endpoint;

        this.settings.provider_endpoint = String($('#ptts_endpoint').val());
        this.settings.model = String($('#ptts_model').val());
        this.settings.format = String($('#ptts_format').val());
        this.settings.speed = parseFloat($('#ptts_speed').val());
        this.settings.temperature = parseFloat($('#ptts_temperature').val());
        this.settings.top_p = parseFloat($('#ptts_top_p').val());

        $('#ptts_speed_val').text(this.settings.speed);
        $('#ptts_temperature_val').text(this.settings.temperature);
        $('#ptts_top_p_val').text(this.settings.top_p);

        if (this.settings.provider_endpoint !== oldEndpoint) {
            this._closeWorker();
            this.checkReady().then(() => {
                if (this.ready) {
                    this._initWorker();
                }
                this._updateStatus(this.ready || this._workerReady);
            });
        }
        saveTtsProviderSettings();
    }

    // ─── Worker Lifecycle ───────────────────────────────────────────

    _initWorker() {
        if (this._worker) return;

        // Skip init if TTS is disabled globally to prevent unnecessary background connections
        const es = window.extension_settings || window.SillyTavern?.extension_settings;
        // Robust check: explicitly check for false, or treat null/undefined as disabled if that's the intention.
        // Usually, in ST, if it's not enabled, we shouldn't be connecting.
        if (es?.tts?.enabled === false) {
            console.log('[pocketTTS-WS] worker init skipped: TTS disabled globally');
            return;
        }

        const workerUrl = new URL('./ws-worker.js', import.meta.url);
        this._worker = new Worker(workerUrl);
        this._worker.onmessage = (e) => this._onWorkerMessage(e);
        this._worker.postMessage({ type: 'init', url: this._getWsUrl() });
    }

    _closeWorker() {
        if (this._worker) {
            this._worker.postMessage({ type: 'close' });
            this._worker.terminate();
            this._worker = null;
            this._workerReady = false;
        }
        // Reject all pending promises — worker is gone, no responses will come
        for (const p of this._wsPending) {
            clearTimeout(p.timeout);
            p.promise._reject(new Error('Worker closed'));
        }
        this._wsPending = [];
        this._audioChunks = [];
        this._sendQueue = [];
        this._doneBuffer.clear();
        this._cancelledIds.clear();
    }

    async loadSettings(settings) {
        this.settings = { ...this.defaultSettings };
        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            }
        }

        $('#ptts_endpoint').val(this.settings.provider_endpoint);
        $('#ptts_model').val(this.settings.model);
        $('#ptts_format').val(this.settings.format);
        $('#ptts_speed').val(this.settings.speed);
        $('#ptts_speed_val').text(this.settings.speed);
        $('#ptts_temperature').val(this.settings.temperature);
        $('#ptts_temperature_val').text(this.settings.temperature);
        $('#ptts_top_p').val(this.settings.top_p);
        $('#ptts_top_p_val').text(this.settings.top_p);

        // Fix #17: Use namespaced events to prevent duplicate listeners on reinit
        $('#ptts_endpoint').off('input.ptts').on('input.ptts', () => this.onSettingsChange());
        $('#ptts_model').off('change.ptts').on('change.ptts', () => this.onSettingsChange());
        $('#ptts_format').off('change.ptts').on('change.ptts', () => this.onSettingsChange());
        $('#ptts_speed').off('input.ptts').on('input.ptts', () => this.onSettingsChange());
        $('#ptts_temperature').off('input.ptts').on('input.ptts', () => this.onSettingsChange());
        $('#ptts_top_p').off('input.ptts').on('input.ptts', () => this.onSettingsChange());

        window._pttsProvider = this;
        await this._loadVoices();
        await this._loadModels();
        await this.checkReady();
        // Only init worker if health check passes AND it's enabled
        if (this.ready) {
            this._initWorker();
        }
        this._updateStatus(this.ready || this._workerReady);
    }

    // ─── Readiness ──────────────────────────────────────────────────

    async checkReady() {
        try {
            const url = this.settings.provider_endpoint.replace(/\/$/, '');
            const resp = await fetch(url + '/health', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                this.ready = data.model_loaded === true;
                this._updateServerInfo(data);
            } else {
                this.ready = false;
            }
        } catch {
            this.ready = false;
        }
        return this.ready;
    }

    async onRefreshClick() {
        await this._loadVoices();
        await this._loadModels();
        await this.checkReady();
        if (this.ready) {
            this._initWorker();
        }
        this._updateStatus(this.ready || this._workerReady);
    }

    // ─── Voice Management ──────────────────────────────────────────

    async _loadVoices() {
        try {
            const url = this.settings.provider_endpoint.replace(/\/$/, '');
            const resp = await fetch(url + '/v1/voices', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                this.voices = (data.voices || []).map(v => ({
                    name: v, voice_id: v, lang: 'en',
                }));
                return this.voices;
            }
        } catch { /* server unavailable */ }

        this.voices = [
            'nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer',
            'alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma',
        ].map(v => ({ name: v, voice_id: v, lang: 'en' }));
        return this.voices;
    }

    async _loadModels() {
        try {
            const url = this.settings.provider_endpoint.replace(/\/$/, '');
            const resp = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                const modelSelect = document.getElementById('ptts_model');
                if (modelSelect && data.data && Array.isArray(data.data)) {
                    const currentVal = this.settings.model || this.defaultSettings.model;
                    modelSelect.innerHTML = data.data.map(m => {
                        const isSelected = currentVal === m.id ? ' selected' : '';
                        return `<option value="${m.id}"${isSelected}>${m.id}</option>`;
                    }).join('');
                    // Sync the settings value just in case the currentVal isn't in the new list
                    this.settings.model = String($('#ptts_model').val());
                }
            }
        } catch { /* server unavailable or endpoint not supported */ }
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName);
        if (!match) throw 'TTS Voice name "' + voiceName + '" not found';
        return match;
    }

    async fetchTtsVoiceObjects() {
        if (this.voices.length === 0) await this._loadVoices();
        return this.voices;
    }

    // ─── Text Processing ────────────────────────────────────────────

    async processText(text) {
        return text;
    }

    // ─── TTS Generation ─────────────────────────────────────────────

    /**
     * Generate TTS audio. Yields one Promise<Blob> per text part.
     *
     * WHY this design: text goes into a send queue that ensures ordering
     * (sequential IDs = text order). The queue sends to the worker one at
     * a time, but does NOT wait for the response — fire-and-forget. The
     * server processes sequentially and sends audio back when ready.
     * Audio is received independently and matched to promises by request_id.
     *
     * The queue exists for ORDERING, not for waiting. All text from all
     * messages goes through this single queue, ensuring correct text order
     * regardless of which message it came from.
     */
    async *generateTts(text, voiceId) {
        const trimmed = text.trim();
        if (!trimmed) return;

        const reqId = 'r' + (this._nextReqId++);

        // Check if response already arrived (server processed before promise created)
        // This happens when the server is fast and the client is slow (blocked by LLM)
        const buffered = this._doneBuffer.get(reqId);
        if (buffered) {
            this._doneBuffer.delete(reqId);
            this.lastTiming = buffered.timing;
            if (buffered.merged) {
                // This request was merged into another — signal null
                yield Promise.resolve(null);
                return;
            }
            const blob = new Blob(buffered.chunks, { type: this._getMimeType() });
            yield Promise.resolve(blob);
            return;
        }

        // Create promise — resolved when audio arrives with matching request_id
        let _resolve, _reject;
        const blobPromise = new Promise((res, rej) => { _resolve = res; _reject = rej; });
        blobPromise._resolve = _resolve;
        blobPromise._reject = _reject;

        const pending = { id: reqId, promise: blobPromise, chunks: [], retryCount: 0, payload: null, retryScheduled: false };
        this._wsPending.push(pending);

        pending.timeout = setTimeout(() => {
            const idx = this._wsPending.indexOf(pending);
            if (idx >= 0) {
                this._cancelledIds.add(pending.id);
                if (this._retryRequest(pending, 'timeout')) {
                    return; // retry scheduled
                }
                this._wsPending.splice(idx, 1);
            }
            blobPromise._reject(new Error('TTS timeout (60s)'));
        }, 60000);

        // Push to send queue — maintains text order
        const payload = {
            type: 'text.append',
            request_id: reqId,
            text: trimmed,
            voice: voiceId,
            format: this.settings.format,
            speed: this.settings.speed,
            temperature: this.settings.temperature,
            top_p: this.settings.top_p,
            model: this.settings.model,
        };
        pending.payload = payload;
        this._sendQueue.push(payload);

        // Flush immediately — promise is already in _wsPending, so responses
        // can be matched. This ensures the server doesn't process the request
        // before the promise exists.
        this._flushSendQueue();

        yield blobPromise;
    }

    /**
     * Send queued requests to worker in order.
     * Fire-and-forget: sends all queued items, doesn't wait for responses.
     * Called after each generateTts push and after each done/error received.
     */
    _flushSendQueue() {
        if (!this._worker) return;
        while (this._sendQueue.length > 0) {
            const payload = this._sendQueue.shift();
            this._worker.postMessage({ type: 'send', payload });
        }
    }

    /**
     * Send text.done to signal end of generation.
     * Server flushes merge queue and sends session_ended when complete.
     */
    sendTextDone() {
        if (this._worker) {
            this._worker.postMessage({ type: 'send', payload: { type: 'text.done' } });
        }
    }

    /**
     * Retry a failed request. Resets pending state and re-sends with backoff.
     * Returns true if retry was scheduled, false if max retries reached.
     * Fix #3: Guard against duplicate retries by checking retryScheduled flag.
     */
    _retryRequest(pending, reason) {
        if (pending.retryScheduled) return true; // already scheduled, don't duplicate
        if (pending.retryCount >= PocketTtsProvider.MAX_RETRIES) return false;

        const delay = PocketTtsProvider.RETRY_DELAYS[pending.retryCount] || 4000;
        pending.retryCount++;
        pending.chunks = [];
        pending.retryScheduled = true;

        console.log('[pocketTTS-WS] retry %d/%d for %s in %dms (%s)',
            pending.retryCount, PocketTtsProvider.MAX_RETRIES,
            pending.id, delay, reason);

        setTimeout(() => {
            pending.retryScheduled = false;
            // Re-add to pending if it was removed
            if (!this._wsPending.includes(pending)) {
                this._wsPending.push(pending);
            }
            // Reset timeout — also retry on timeout
            clearTimeout(pending.timeout);
            pending.timeout = setTimeout(() => {
                const idx = this._wsPending.indexOf(pending);
                if (this._retryRequest(pending, 'timeout')) return;
                if (idx >= 0) this._wsPending.splice(idx, 1);
                pending.promise._reject(new Error('TTS timeout (60s)'));
            }, 60000);

            // Re-send with retry flag
            const retryPayload = { ...pending.payload, retry: true };
            if (this._worker) {
                this._worker.postMessage({ type: 'send', payload: retryPayload });
            }
        }, delay);

        return true;
    }

    // ─── Worker Message Handling ─────────────────────────────────────

    _onWorkerMessage(event) {
        const { type, data, msg, error, connected, requestId, fatal } = event.data;

        if (type === 'status') {
            this._workerReady = connected;
            this._updateStatus(connected, fatal);
            // On disconnect, reject all pending requests so the client doesn't hang
            if (!connected) {
                for (const p of this._wsPending) {
                    clearTimeout(p.timeout);
                    p.promise._reject(new Error(fatal ? 'Connection failed (reconnect limit reached)' : 'WebSocket disconnected'));
                }
                this._wsPending = [];
                this._audioChunks = [];
            }
            return;
        }

        if (type === 'audio') {
            // Accumulate raw chunks — they'll be associated with a request ID on 'done'.
            // WHY no request_id on binary frames: the WebSocket protocol sends raw audio bytes
            // for efficiency; the server is single-threaded and sequential so chunks always
            // belong to the oldest pending request.
            // Fix #2: If no pending requests exist, these chunks are orphaned (late delivery
            // from a cancelled/timed-out request that was already removed) — discard them.
            if (this._wsPending.length === 0) {
                console.log('[pocketTTS-WS] warning: audio chunk received with no pending request (orphaned), discarding');
                this._audioChunks = []; // reset in case of partial accumulation
                return;
            }
            this._audioChunks.push(new Uint8Array(data));
            return;
        }

        if (type === 'json') {
            if (msg.status === 'done') {
                const doneIds = Array.isArray(msg.request_id) ? msg.request_id : [msg.request_id];
                const timing = {
                    audio_duration: msg.audio_duration || 0,
                    gen_time: msg.gen_time || 0,
                };

                // Fix #1: Check if any done IDs were cancelled — discard chunks if so
                const hasCancelled = doneIds.some(id => this._cancelledIds.has(id));
                if (hasCancelled) {
                    for (const id of doneIds) this._cancelledIds.delete(id);
                    this._audioChunks = []; // discard stale audio
                    console.log('[pocketTTS-WS] discarding chunks for cancelled request(s):', doneIds);
                    this._updateStatus(this.ready);
                    return;
                }

                // Claim the accumulated audio chunks for this request, then reset buffer
                const chunks = this._audioChunks;
                this._audioChunks = [];

                for (let di = 0; di < doneIds.length; di++) {
                    const rid = doneIds[di];
                    const idx = this._wsPending.findIndex(p => p.id === rid);
                    if (idx >= 0) {
                        const p = this._wsPending.splice(idx, 1)[0];
                        clearTimeout(p.timeout);
                        this.lastTiming = timing;
                        // First ID in merge group gets the blob; rest get null (merged away)
                        if (di === 0) {
                            const blob = new Blob(chunks, { type: this._getMimeType() });
                            p.promise._resolve(blob);
                        } else {
                            console.log('[pocketTTS-WS] merged: %s absorbed into %s', rid, doneIds[0]);
                            p.promise._resolve(null);
                        }
                    } else {
                        // Promise not created yet — buffer the response
                        console.log('[pocketTTS-WS] buffered early response for %s (%d chunks)', rid, chunks.length);
                        this._doneBuffer.set(rid, { chunks: di === 0 ? chunks : [], timing, merged: di > 0 });
                        // Evict oldest entries if buffer grows too large
                        while (this._doneBuffer.size > PocketTtsProvider.MAX_DONE_BUFFER) {
                            const oldest = this._doneBuffer.keys().next().value;
                            console.log('[pocketTTS-WS] warning: evicting buffered response for %s (buffer full)', oldest);
                            this._doneBuffer.delete(oldest);
                        }
                    }
                }
                this._updateStatus(this.ready);
                return;
            }

            if (msg.status === 'error') {
                this._audioChunks = []; // discard partial audio from failed request
                const errIds = msg?.request_id
                    ? (Array.isArray(msg.request_id) ? msg.request_id : [msg.request_id])
                    : (requestId ? [requestId] : []);

                for (const rid of errIds) {
                    const idx = this._wsPending.findIndex(p => p.id === rid);
                    if (idx >= 0) {
                        const p = this._wsPending[idx];
                        clearTimeout(p.timeout);
                        const reason = msg?.error || error || 'Unknown error';
                        if (this._retryRequest(p, reason)) {
                            // Retry scheduled — keep in pending, don't reject
                            continue;
                        }
                        // Max retries reached — reject
                        this._wsPending.splice(idx, 1);
                        p.promise._reject(new Error(reason));
                    }
                }
                if (!errIds.length) {
                    console.log('[pocketTTS-WS] worker error:', error || msg?.error);
                }
                this._updateStatus(this.ready);
                return;
            }

            if (msg.status === 'session_ended') {
                console.log('[pocketTTS-WS] session ended');
                this._updateStatus(this.ready);
                return;
            }

            // Other JSON — ignore
            return;
        }
    }

    _getWsUrl() {
        let ep = this.settings.provider_endpoint.replace(/\/$/, '');
        if (ep.startsWith('http://')) ep = ep.replace('http://', 'ws://');
        else if (ep.startsWith('https://')) ep = ep.replace('https://', 'wss://');
        if (!ep.startsWith('ws://') && !ep.startsWith('wss://')) ep = 'ws://' + ep;
        return ep + '/v1/audio/stream';
    }

    _getMimeType() {
        switch (this.settings.format) {
            case 'wav': return 'audio/wav';
            case 'opus': return 'audio/opus';
            case 'flac': return 'audio/flac';
            case 'aac': return 'audio/aac';
            default: return 'audio/mpeg';
        }
    }

    // ─── Preview ───────────────────────────────────────────────────

    _previewAbort = false;

    async previewTtsVoice(voiceId) {
        this._previewAbort = true; // cancel any in-flight preview
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
        // Revoke previous blob URL if any
        if (this._previewUrl) {
            URL.revokeObjectURL(this._previewUrl);
            this._previewUrl = null;
        }
        const text = getPreviewString('en-US');
        const thisPreview = {}; // unique reference per call
        this._previewAbort = false;
        try {
            for await (const blobPromise of this.generateTts(text, voiceId)) {
                if (this._previewAbort) return; // cancelled by newer preview
                const blob = await blobPromise;
                if (this._previewAbort) return;
                const url = URL.createObjectURL(blob);
                this._previewUrl = url;
                this.audioElement.src = url;
                this.audioElement.play();
                this.audioElement.onended = () => {
                    URL.revokeObjectURL(url);
                    if (this._previewUrl === url) this._previewUrl = null;
                };
                return;
            }
        } catch (err) {
            console.error('[pocketTTS-WS] preview error:', err);
        }
    }

    // ─── Cleanup ───────────────────────────────────────────────────

    dispose() {
        for (const p of this._wsPending) clearTimeout(p.timeout);
        this._wsPending = [];
        this._doneBuffer.clear();
        this._audioChunks = [];
        this._cancelledIds.clear();
        this._previewAbort = true;
        if (this._previewUrl) {
            URL.revokeObjectURL(this._previewUrl);
            this._previewUrl = null;
        }
        this._closeWorker();
    }
}
