import { createPcmStream, appendPcm, pumpPcm, stopPcm } from "./pcm-playback.js";
// pocket-tts.js — SillyTavern TTS Provider for pocket-tts-openapi
// Web Worker for WS connection (survives main thread blocking by LLM streaming).
// SillyTavern runtime modules live outside this extension package and do not ship local .d.ts files.
// @ts-ignore
import { saveTtsProviderSettings, getPreviewString } from '../../../tts/index.js';
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
    _doneBuffer = new Map(); // request_id → {chunks, timing}
    static MAX_DONE_BUFFER = 10; // limit to prevent memory leak
    // Raw audio chunk buffer — accumulated between requests, claimed on 'done'
    _audioChunks = [];
    // Track cancelled/timed-out request IDs to discard late chunks
    _cancelledIds = new Set();
    // Send queue: ensures text goes to server in order (sequential IDs)
    // Sends fire-and-forget — doesn't wait for response
    _sendQueue = [];
    _nextReqId = 0;
    lastTiming = { audio_duration: 0, gen_time: 0 };
    _previewUrl = null;
    _pcmContext = null;
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
        streamingFormat: 'auto',
        speed: 1.0,
        temperature: 0.3,
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

            <label for="ptts_format">Buffered playback format:</label>
            <select id="ptts_format" class="text_pole">
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
                <option value="opus">Opus</option>
                <option value="webm">WebM / Opus</option>
                <option value="flac">FLAC</option>
                <option value="aac">AAC</option>
            </select>
            <label for="ptts_streaming_format">Streaming:</label>
            <select id="ptts_streaming_format" class="text_pole">
                <option value="off">Off — buffered playback</option>
                <option value="auto">Auto — adaptive streaming</option>
            </select>
            <div id="ptts_streaming_info" style="margin:4px 0;font-size:0.85em;color:#aaa;"></div>

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
        if (!el)
            return;
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
        if (!el || !info)
            return;
        const parts = [];
        if (info.device)
            parts.push('Device: ' + info.device);
        if (info.sample_rate)
            parts.push(info.sample_rate + 'Hz');
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
            }
            else {
                warnEl.style.display = 'none';
            }
        }
    }
    // ─── Settings Load / Change ─────────────────────────────────────
    onSettingsChange() {
        const oldEndpoint = this.settings.provider_endpoint;
        this.settings.provider_endpoint = String($('#ptts_endpoint').val());
        this.settings.model = String($('#ptts_model').val());
        this.settings.format = normalizeAudioFormat(String($('#ptts_format').val()));
        this.settings.streamingFormat = normalizeStreamingFormat(String($('#ptts_streaming_format').val()));
        this.settings.speed = parseFloat($('#ptts_speed').val());
        this.settings.temperature = parseFloat($('#ptts_temperature').val());
        this.settings.top_p = parseFloat($('#ptts_top_p').val());
        $('#ptts_speed_val').text(this.settings.speed);
        $('#ptts_temperature_val').text(this.settings.temperature);
        $('#ptts_top_p_val').text(this.settings.top_p);
        this._updateStreamingInfo();
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
        if (this._worker) {
            console.log('[pocketTTS-WS] provider: worker already initialized');
            return;
        }
        const workerUrl = new URL('./ws-worker.js', import.meta.url);
        console.log('[pocketTTS-WS] provider: init worker', {
            workerUrl: workerUrl.toString(),
            wsUrl: this._getWsUrl(),
            ready: this.ready,
        });
        this._worker = new Worker(workerUrl, { type: 'module' });
        this._worker.onmessage = (e) => this._onWorkerMessage(e);
        this._worker.postMessage({ type: 'init', url: this._getWsUrl(), reconnect: true });
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
            clearTimeout(p.retryTimer);
            p.retryScheduled = false;
            if (p.pcmStream)
                this._finishPcmStream(p.pcmStream);
            p.promise._reject(new Error('Worker closed'));
            p.done?._reject(new Error('Worker closed'));
        }
        this._wsPending = [];
        this._audioChunks = [];
        this._sendQueue = [];
        this._doneBuffer.clear();
        this._cancelledIds.clear();
    }
    resetSession(reason = 'reset') {
        console.log('[pocketTTS-WS] provider: reset session', {
            reason,
            pending: this._wsPending.length,
            sendQueue: this._sendQueue.length,
            worker: !!this._worker,
            workerReady: this._workerReady,
        });
        this._closeWorker();
        if (this.ready) {
            this._initWorker();
        }
    }
    async loadSettings(settings) {
        document.addEventListener("pointerdown", this._unlockPcm, { passive: true });
        document.addEventListener("keydown", this._unlockPcm, { passive: true });
        this.settings = { ...this.defaultSettings };
        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            }
        }
        $('#ptts_endpoint').val(this.settings.provider_endpoint);
        $('#ptts_model').val(this.settings.model);
        $('#ptts_format').val(this.settings.format);
        await this._refreshStreamingFormatOptions(false);
        $('#ptts_streaming_format').val(this.settings.streamingFormat);
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
        $('#ptts_streaming_format').off('change.ptts').on('change.ptts', () => this.onSettingsChange());
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
            }
            else {
                this.ready = false;
            }
        }
        catch {
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
        }
        catch { /* server unavailable */ }
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
        }
        catch { /* server unavailable or endpoint not supported */ }
    }
    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName);
        if (!match)
            throw 'TTS Voice name "' + voiceName + '" not found';
        return match;
    }
    async fetchTtsVoiceObjects() {
        if (this.voices.length === 0)
            await this._loadVoices();
        return this.voices;
    }
    async _refreshStreamingFormatOptions(autoSelect = true) {
        const candidates = this._detectStreamingCandidates();
        this.settings.streamingFormat = normalizeStreamingFormat(this.settings.streamingFormat || 'off');
        const select = document.getElementById('ptts_streaming_format');
        if (!select)
            return candidates;
        const current = normalizeStreamingFormat(this.settings.streamingFormat || select.value || 'off');
        const options = [
            '<option value="off">Off — buffered playback</option>',
            candidates.length > 0 ? '<option value="auto">Auto — adaptive streaming</option>' : '',
        ].filter(Boolean);
        select.innerHTML = options.join('');
        const valid = current === 'off'
            || (current === 'auto' && candidates.length > 0);
        const next = valid ? current : 'off';
        select.value = next;
        this.settings.streamingFormat = next;
        if (autoSelect && current !== next) {
            saveTtsProviderSettings();
        }
        this._updateStreamingInfo();
        return candidates;
    }
    _updateStreamingInfo(message) {
        const el = document.getElementById('ptts_streaming_info');
        if (!el)
            return;
        if (message) {
            el.textContent = message;
            el.style.color = '#d9a441';
            return;
        }
        const selected = normalizeStreamingFormat(this.settings.streamingFormat || 'off');
        const candidate = this._getStreamCandidate();
        const buffered = `Buffered tracks use ${this.settings.format.toUpperCase()}.`;
        if (selected === 'off') {
            el.textContent = `Live streaming is off. ${buffered}`;
            el.style.color = '#aaa';
        }
        else if (candidate) {
            el.textContent = `Streaming uses ${candidate.label}. ${buffered} Used only if streaming falls back or is turned off.`;
            el.style.color = '#aaa';
        }
        else {
            el.textContent = `Selected streaming mode is not supported by this browser. Falling back to buffered ${this.settings.format.toUpperCase()}.`;
            el.style.color = '#d9a441';
        }
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
        if (!trimmed)
            return;
        const reqId = 'r' + (this._nextReqId++);
        console.log('[pocketTTS-WS] provider: generateTts', {
            reqId,
            voiceId,
            chars: trimmed.length,
            ready: this.ready,
            worker: !!this._worker,
            workerReady: this._workerReady,
        });
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
        let _resolve;
        let _reject;
        const blobPromise = new Promise((res, rej) => { _resolve = res; _reject = rej; });
        blobPromise._resolve = _resolve;
        blobPromise._reject = _reject;
        let doneResolve;
        let doneReject;
        const done = new Promise((res, rej) => { doneResolve = res; doneReject = rej; });
        done._resolve = doneResolve;
        done._reject = doneReject;
        void done.catch(() => { });
        const pending = { id: reqId, promise: blobPromise, done, chunks: [], retryCount: 0, payload: null, retryScheduled: false };
        this._wsPending.push(pending);
        pending.timeout = setTimeout(() => {
            const idx = this._wsPending.indexOf(pending);
            if (idx >= 0) {
                if (this._retryRequest(pending, 'timeout')) {
                    return; // retry scheduled
                }
                this._cancelledIds.add(pending.id);
                this._wsPending.splice(idx, 1);
            }
            blobPromise._reject(new Error('TTS timeout (60s)'));
        }, 60000);
        // Push to send queue — maintains text order
        const streamCandidate = this._getStreamCandidate();
        const stream = streamCandidate !== null;
        const wireFormat = streamCandidate?.format || this.settings.format;
        if (!stream && this.settings.streamingFormat !== 'off') {
            const message = `Live streaming ${this.settings.streamingFormat} is unavailable; falling back to buffered ${this.settings.format.toUpperCase()}.`;
            console.warn('[pocketTTS-WS] provider:', message);
            this._updateStreamingInfo(message);
        }
        const payload = {
            type: 'text.append',
            request_id: reqId,
            text: trimmed,
            voice: voiceId,
            format: wireFormat,
            speed: this.settings.speed,
            temperature: this.settings.temperature,
            top_p: this.settings.top_p,
            model: this.settings.model,
            stream,
        };
        pending.payload = payload;
        this._sendQueue.push(payload);
        console.log('[pocketTTS-WS] provider: queued payload', {
            reqId,
            sendQueue: this._sendQueue.length,
            pending: this._wsPending.length,
            mode: stream ? 'streaming' : 'buffered',
            format: wireFormat,
            mimeType: stream ? streamCandidate?.mime : this._getMimeType(),
        });
        // Flush immediately — promise is already in _wsPending, so responses
        // can be matched. This ensures the server doesn't process the request
        // before the promise exists.
        this._flushSendQueue();
        yield blobPromise;
    }
    _canStreamCurrentFormat() {
        return this._getStreamCandidate() !== null;
    }
    _getStreamFormat() {
        return this._getStreamCandidate()?.format || 'mp3';
    }
    _getStreamMimeType() {
        return this._getStreamCandidate()?.mime || 'audio/mpeg';
    }
    _getStreamCandidate() {
        const selected = normalizeStreamingFormat(this.settings.streamingFormat || 'off');
        if (selected === 'off')
            return null;
        const candidates = this._detectStreamingCandidates();
        return candidates[0] || null;
    }
    _detectStreamingCandidates() {
        const candidates = [];
        if (window.AudioContext || window.webkitAudioContext) {
            candidates.push({ format: 'pcm', mime: 'audio/pcm', label: 'PCM / adaptive buffer' });
        }
        if (typeof MediaSource !== 'undefined') {
            for (const candidate of [
                { format: 'webm', mime: 'audio/webm; codecs="opus"', label: 'WebM / Opus' },
                { format: 'mp3', mime: 'audio/mpeg', label: 'MP3 byte stream' },
            ]) {
                if (MediaSource.isTypeSupported(candidate.mime))
                    candidates.push(candidate);
            }
        }
        return candidates;
    }
    _unlockPcm = () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx)
            return;
        if (!this._pcmContext || this._pcmContext.state === 'closed')
            this._pcmContext = new Ctx();
        void this._pcmContext.resume();
    };
    _createPcmStream(sampleRate = 24000, channels = 1) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!this._pcmContext || this._pcmContext.state === 'closed') {
            this._pcmContext = new Ctx();
        }
        const context = this._pcmContext;
        return createPcmStream(context, sampleRate);
    }
    _appendPcmChunk(stream, bytes) { appendPcm(stream, bytes); }
    _startPcmStream(stream) { stream.playing = true; pumpPcm(stream); }
    _finishPcmStream(stream) { stream.closed = true; pumpPcm(stream); }
    _stopPcmStream(stream) { stopPcm(stream); }
    /**
     * Send queued requests to worker in order.
     * Fire-and-forget: sends all queued items, doesn't wait for responses.
     * Called after each generateTts push and after each done/error received.
     */
    _flushSendQueue() {
        if (!this._worker && this.ready) {
            console.log('[pocketTTS-WS] provider: no worker during flush, initializing');
            this._initWorker();
        }
        if (!this._worker) {
            console.warn('[pocketTTS-WS] provider: cannot flush, worker missing', {
                ready: this.ready,
                sendQueue: this._sendQueue.length,
            });
            return;
        }
        console.log('[pocketTTS-WS] provider: flushing send queue', { count: this._sendQueue.length });
        while (this._sendQueue.length > 0) {
            const payload = this._sendQueue.shift();
            console.log('[pocketTTS-WS] provider: post worker payload', {
                type: payload?.type,
                requestId: payload && 'request_id' in payload ? payload.request_id : null,
            });
            this._worker.postMessage({ type: 'send', payload });
        }
    }
    /**
     * Send text.done to signal end of generation.
     * Server flushes merge queue and sends session_ended when complete.
     */
    sendTextDone() {
        if (this._worker) {
            console.log('[pocketTTS-WS] provider: send text.done');
            this._flushSendQueue();
            this._worker.postMessage({ type: 'send', payload: { type: 'text.done' } });
        }
        else {
            console.warn('[pocketTTS-WS] provider: text.done skipped, worker missing');
        }
    }
    _createStream(mimeType = this._getStreamMimeType()) {
        if (!this._canStreamCurrentFormat()) {
            console.warn('[pocketTTS-WS] provider: MediaSource mime unsupported', mimeType);
            return null;
        }
        const mediaSource = new MediaSource();
        mediaSource.addEventListener('sourceopen', () => console.log('[pocketTTS-WS] provider: MediaSource open', { mimeType }));
        mediaSource.addEventListener('sourceended', () => console.log('[pocketTTS-WS] provider: MediaSource ended', { mimeType }));
        mediaSource.addEventListener('sourceclose', () => console.log('[pocketTTS-WS] provider: MediaSource closed', { mimeType }));
        const stream = {
            mediaSource,
            sourceBuffer: null,
            url: URL.createObjectURL(mediaSource),
            queue: [],
            opened: false,
            ended: false,
            playable: false,
        };
        const pump = () => {
            const sb = stream.sourceBuffer;
            if (!sb || sb.updating)
                return;
            const next = stream.queue.shift();
            if (next) {
                try {
                    sb.appendBuffer(next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength));
                }
                catch (e) {
                    console.error('[pocketTTS-WS] provider: stream append failed', e);
                }
                return;
            }
            if (stream.ended && mediaSource.readyState === 'open') {
                try {
                    mediaSource.endOfStream();
                }
                catch { }
            }
        };
        mediaSource.addEventListener('sourceopen', () => {
            stream.opened = true;
            try {
                const sb = mediaSource.addSourceBuffer(mimeType);
                try {
                    sb.mode = 'sequence';
                }
                catch { }
                stream.sourceBuffer = sb;
                sb.addEventListener('error', () => console.error('[pocketTTS-WS] provider: SourceBuffer error', {
                    mimeType,
                    mediaSourceState: mediaSource.readyState,
                    buffered: (() => {
                        try {
                            return Array.from({ length: sb.buffered.length }, (_, i) => [sb.buffered.start(i), sb.buffered.end(i)]);
                        }
                        catch {
                            return [];
                        }
                    })(),
                }));
                sb.addEventListener('updateend', () => {
                    if (!stream.playable) {
                        stream.playable = true;
                        console.log('[pocketTTS-WS] provider: MediaSource first append complete', {
                            buffered: (() => {
                                try {
                                    return Array.from({ length: sb.buffered.length }, (_, i) => [sb.buffered.start(i), sb.buffered.end(i)]);
                                }
                                catch {
                                    return [];
                                }
                            })(),
                        });
                        stream.onPlayable?.();
                    }
                    pump();
                });
                pump();
            }
            catch (e) {
                console.error('[pocketTTS-WS] provider: source buffer failed', e);
            }
        }, { once: true });
        return stream;
    }
    _appendStreamChunk(stream, data) {
        stream.queue.push(data);
        const sb = stream.sourceBuffer;
        if (stream.opened && sb && !sb.updating) {
            const next = stream.queue.shift();
            if (next) {
                try {
                    sb.appendBuffer(next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength));
                }
                catch (e) {
                    console.error('[pocketTTS-WS] provider: stream append failed', e);
                }
            }
        }
    }
    _finishStream(stream) {
        stream.ended = true;
        const sb = stream.sourceBuffer;
        if (stream.mediaSource.readyState === 'open' && sb && !sb.updating && stream.queue.length === 0) {
            try {
                stream.mediaSource.endOfStream();
            }
            catch { }
        }
    }
    /**
     * Retry a failed request. Resets pending state and re-sends with backoff.
     * Returns true if retry was scheduled, false if max retries reached.
     * Fix #3: Guard against duplicate retries by checking retryScheduled flag.
     */
    _retryRequest(pending, reason, retryAfter = 0) {
        if (pending.streamResolved) {
            if (pending.pcmStream)
                this._finishPcmStream(pending.pcmStream);
            if (pending.stream)
                this._finishStream(pending.stream);
            return false;
        }
        if (pending.retryScheduled)
            return true; // already scheduled, don't duplicate
        if (pending.retryCount >= PocketTtsProvider.MAX_RETRIES)
            return false;
        const delay = Math.max(PocketTtsProvider.RETRY_DELAYS[pending.retryCount] || 4000, Math.min(Math.max(Number(retryAfter) || 0, 0), 300) * 1000);
        pending.retryCount++;
        if (pending.pcmStream) {
            this._stopPcmStream(pending.pcmStream);
            pending.pcmStream = undefined;
        }
        pending.chunks = [];
        pending.retryScheduled = true;
        console.log('[pocketTTS-WS] retry %d/%d for %s in %dms (%s)', pending.retryCount, PocketTtsProvider.MAX_RETRIES, pending.id, delay, reason);
        pending.retryTimer = setTimeout(() => {
            pending.retryTimer = undefined;
            pending.retryScheduled = false;
            // Reset/disconnect/completion owns removal. Never resurrect a job.
            if (!this._wsPending.includes(pending) || !this._worker)
                return;
            // Reset timeout — also retry on timeout
            clearTimeout(pending.timeout);
            pending.timeout = setTimeout(() => {
                const idx = this._wsPending.indexOf(pending);
                if (this._retryRequest(pending, 'timeout'))
                    return;
                this._cancelledIds.add(pending.id);
                if (idx >= 0)
                    this._wsPending.splice(idx, 1);
                pending.promise._reject(new Error('TTS timeout (60s)'));
                pending.done?._reject(new Error('TTS timeout (60s)'));
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
        if (type === 'debug') {
            console.log('[pocketTTS-WS] worker:', event.data.message, event.data);
            return;
        }
        if (type === 'status') {
            console.log('[pocketTTS-WS] provider: worker status', { connected, fatal });
            this._workerReady = connected;
            this._updateStatus(connected, fatal);
            // On disconnect, reject all pending requests so the client doesn't hang
            if (!connected) {
                for (const p of this._wsPending) {
                    clearTimeout(p.timeout);
                    clearTimeout(p.retryTimer);
                    p.retryScheduled = false;
                    if (p.pcmStream)
                        this._finishPcmStream(p.pcmStream);
                    p.promise._reject(new Error(fatal ? 'Connection failed (reconnect limit reached)' : 'WebSocket disconnected'));
                    p.done?._reject(new Error('WebSocket disconnected'));
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
            const bytes = new Uint8Array(data);
            const activePcm = this._wsPending.find(p => p.streamed && p.pcmStream);
            if (activePcm?.pcmStream) {
                this._appendPcmChunk(activePcm.pcmStream, bytes);
                if (!activePcm.streamResolved) {
                    activePcm.streamResolved = true;
                    console.log('[pocketTTS-WS] provider: pcm streaming playable', { requestId: activePcm.id });
                    activePcm.promise._resolve({
                        streamUrl: '',
                        mimeType: this._getStreamMimeType(),
                        audioStream: activePcm.pcmStream,
                    });
                }
                return;
            }
            const streaming = this._wsPending.find(p => p.stream);
            if (streaming?.stream) {
                streaming.chunks.push(bytes);
                this._appendStreamChunk(streaming.stream, bytes);
                if (!streaming.streamResolved) {
                    const resolveStream = () => {
                        if (streaming.streamResolved || !streaming.stream)
                            return;
                        streaming.streamResolved = true;
                        console.log('[pocketTTS-WS] provider: streaming playable', {
                            requestId: streaming.id,
                            chunks: streaming.chunks.length,
                            bytes: streaming.chunks.reduce((sum, c) => sum + c.byteLength, 0),
                        });
                        streaming.promise._resolve({
                            streamUrl: streaming.stream.url,
                            mimeType: this._getStreamMimeType(),
                        });
                    };
                    if (streaming.stream.playable) {
                        resolveStream();
                    }
                    else {
                        streaming.stream.onPlayable = resolveStream;
                    }
                }
                return;
            }
            this._audioChunks.push(bytes);
            return;
        }
        if (type === 'json') {
            if (msg.status === 'audio_start') {
                const startIds = Array.isArray(msg.request_id) ? msg.request_id : [msg.request_id];
                const firstId = startIds[0];
                const idx = this._wsPending.findIndex(p => p.id === firstId);
                if (idx >= 0 && msg.format === 'pcm') {
                    const p = this._wsPending[idx];
                    p.pcmStream = this._createPcmStream(msg.sample_rate || 24000, 1);
                    p.streamed = true;
                    p.streamResolved = false;
                    console.log('[pocketTTS-WS] provider: pcm streaming started', {
                        requestId: firstId,
                        sampleRate: msg.sample_rate || 24000,
                    });
                }
                else if (idx >= 0 && msg.format === this._getStreamFormat()) {
                    const p = this._wsPending[idx];
                    const stream = this._createStream(this._getStreamMimeType());
                    if (stream) {
                        p.stream = stream;
                        p.streamed = true;
                        p.streamResolved = true;
                        console.log('[pocketTTS-WS] provider: streaming started', {
                            requestId: firstId,
                            format: msg.format,
                            mimeType: this._getStreamMimeType(),
                        });
                        p.promise._resolve({
                            streamUrl: stream.url,
                            mimeType: this._getStreamMimeType(),
                            done: p.done,
                        });
                    }
                }
                return;
            }
            if (msg.status === 'done') {
                const doneIds = Array.isArray(msg.request_id) ? msg.request_id : [msg.request_id];
                const timing = {
                    audio_duration: msg.audio_duration || 0,
                    gen_time: msg.gen_time || 0,
                };
                // Claim the accumulated audio chunks for this request, then reset buffer
                const chunks = this._audioChunks;
                this._audioChunks = [];
                const firstIdCancelled = this._cancelledIds.has(doneIds[0]);
                if (firstIdCancelled) {
                    console.log('[pocketTTS-WS] discarding chunks for cancelled request:', doneIds[0]);
                }
                for (let di = 0; di < doneIds.length; di++) {
                    const rid = doneIds[di];
                    if (this._cancelledIds.delete(rid)) {
                        const cancelledIdx = this._wsPending.findIndex(p => p.id === rid);
                        if (cancelledIdx >= 0) {
                            const p = this._wsPending.splice(cancelledIdx, 1)[0];
                            clearTimeout(p.timeout);
                            clearTimeout(p.retryTimer);
                            p.retryScheduled = false;
                            p.promise._reject(new Error('TTS request cancelled'));
                        }
                        continue;
                    }
                    const idx = this._wsPending.findIndex(p => p.id === rid);
                    if (idx >= 0) {
                        const p = this._wsPending.splice(idx, 1)[0];
                        clearTimeout(p.timeout);
                        clearTimeout(p.retryTimer);
                        p.retryScheduled = false;
                        this.lastTiming = timing;
                        if (p.pcmStream) {
                            this._finishPcmStream(p.pcmStream);
                            p.done?._resolve();
                            continue;
                        }
                        if (p.stream) {
                            if (!p.streamResolved) {
                                const blob = new Blob(p.chunks, { type: this._getStreamMimeType() });
                                const message = `MediaSource did not start; falling back to complete ${p.stream ? this._getStreamFormat().toUpperCase() : this.settings.format.toUpperCase()} blob.`;
                                console.warn('[pocketTTS-WS] provider:', message, {
                                    requestId: p.id,
                                    chunks: p.chunks.length,
                                    bytes: p.chunks.reduce((sum, c) => sum + c.byteLength, 0),
                                    type: blob.type,
                                    size: blob.size,
                                });
                                this._updateStreamingInfo(message);
                                URL.revokeObjectURL(p.stream.url);
                                p.promise._resolve({
                                    streamUrl: URL.createObjectURL(blob),
                                    mimeType: this._getStreamMimeType(),
                                    done: p.done,
                                });
                                p.done?._resolve();
                            }
                            else {
                                this._finishStream(p.stream);
                                p.done?._resolve();
                            }
                            continue;
                        }
                        // First ID in merge group gets the blob; rest get null (merged away)
                        if (di === 0 && !firstIdCancelled) {
                            const blob = new Blob(chunks, { type: this._getMimeType() });
                            p.promise._resolve(blob);
                        }
                        else {
                            console.log('[pocketTTS-WS] merged: %s absorbed into %s', rid, doneIds[0]);
                            p.promise._resolve(null);
                        }
                    }
                    else {
                        // Promise not created yet — buffer the response
                        console.log('[pocketTTS-WS] buffered early response for %s (%d chunks)', rid, chunks.length);
                        this._doneBuffer.set(rid, { chunks: di === 0 && !firstIdCancelled ? chunks : [], timing, merged: di > 0 || firstIdCancelled });
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
                const errIds = msg?.request_id
                    ? (Array.isArray(msg.request_id) ? msg.request_id : [msg.request_id])
                    : (requestId ? [requestId] : []);
                // A rejected queued request must not erase another request's
                // buffered audio that is still arriving on this socket.
                if (errIds.includes(this._wsPending[0]?.id))
                    this._audioChunks = [];
                for (const rid of errIds) {
                    const idx = this._wsPending.findIndex(p => p.id === rid);
                    if (idx >= 0) {
                        const p = this._wsPending[idx];
                        clearTimeout(p.timeout);
                        clearTimeout(p.retryTimer);
                        p.retryScheduled = false;
                        const reason = msg?.error || error || 'Unknown error';
                        if (msg.retryable !== false && this._retryRequest(p, reason, msg.retry_after)) {
                            // Retry scheduled — keep in pending, don't reject
                            continue;
                        }
                        // Permanent error or exhausted retries: finish delivered
                        // audio, or release an unresolved stream's resources.
                        if (p.pcmStream) {
                            if (p.streamResolved)
                                this._finishPcmStream(p.pcmStream);
                            else
                                this._stopPcmStream(p.pcmStream);
                        }
                        if (p.stream)
                            this._finishStream(p.stream);
                        this._wsPending.splice(idx, 1);
                        p.promise._reject(new Error(reason));
                        p.done?._reject(new Error(reason));
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
        if (ep.startsWith('http://'))
            ep = ep.replace('http://', 'ws://');
        else if (ep.startsWith('https://'))
            ep = ep.replace('https://', 'wss://');
        if (!ep.startsWith('ws://') && !ep.startsWith('wss://'))
            ep = 'ws://' + ep;
        return ep + '/v1/audio/stream';
    }
    _getMimeType() {
        switch (this.settings.format) {
            case 'wav': return 'audio/wav';
            case 'opus': return 'audio/opus';
            case 'webm': return 'audio/webm';
            case 'flac': return 'audio/flac';
            case 'aac': return 'audio/aac';
            default: return 'audio/mpeg';
        }
    }
    // ─── Preview ───────────────────────────────────────────────────
    _previewAbort = false;
    _previewStream = null;
    async previewTtsVoice(voiceId) {
        this._previewAbort = true; // cancel any in-flight preview
        this.audioElement.pause();
        this.audioElement.currentTime = 0;
        if (this._previewStream)
            this._stopPcmStream(this._previewStream);
        this._previewStream = null;
        this._unlockPcm();
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
                if (this._previewAbort)
                    return; // cancelled by newer preview
                const blob = await blobPromise;
                if (this._previewAbort)
                    return;
                if (blob && 'streamUrl' in blob) {
                    if (blob.audioStream) {
                        this._previewStream = blob.audioStream;
                        this._startPcmStream(blob.audioStream);
                    }
                    else {
                        this._previewUrl = blob.streamUrl;
                        this.audioElement.src = blob.streamUrl;
                        void this.audioElement.play();
                    }
                    return;
                }
                const url = URL.createObjectURL(blob);
                this._previewUrl = url;
                this.audioElement.src = url;
                this.audioElement.play();
                this.audioElement.onended = () => {
                    URL.revokeObjectURL(url);
                    if (this._previewUrl === url)
                        this._previewUrl = null;
                };
                return;
            }
        }
        catch (err) {
            console.error('[pocketTTS-WS] preview error:', err);
        }
    }
    // ─── Cleanup ───────────────────────────────────────────────────
    dispose() {
        document.removeEventListener("pointerdown", this._unlockPcm);
        document.removeEventListener("keydown", this._unlockPcm);
        void this._pcmContext?.close();
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
function normalizeAudioFormat(value) {
    return ['mp3', 'wav', 'opus', 'webm', 'flac', 'aac'].includes(value)
        ? value
        : 'mp3';
}
function normalizeStreamingFormat(value) {
    // Preserve streaming for settings saved before format selection became automatic.
    return ['auto', 'pcm', 'webm', 'live-webm', 'mp3'].includes(value) ? 'auto' : 'off';
}
//# sourceMappingURL=pocket-tts.js.map