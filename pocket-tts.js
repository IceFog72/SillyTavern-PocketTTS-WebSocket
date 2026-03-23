// pocket-tts.js — SillyTavern TTS Provider for pocket-tts-openapi
// Persistent WebSocket connection with request queue. All audio goes through WS.

import { saveTtsProviderSettings, getPreviewString } from '../../tts/index.js';

export { PocketTtsProvider };

class PocketTtsProvider {
    settings = {};
    ready = false;
    voices = [];
    separator = '. ';

    audioElement = document.createElement('audio');

    // Persistent WS state
    _ws = null;
    _wsReady = false;
    _wsQueue = [];       // pending requests: [{text, voice, resolve, reject, timeout}]
    _wsCurrent = null;   // currently processing request
    _wsChunks = [];      // binary chunks for current request

    static MODEL_OPTIONS = [
        { value: 'tts-1', label: 'tts-1 (Fast CPU)' },
        { value: 'tts-1-hd', label: 'tts-1-hd (Quality CPU)' },
        { value: 'tts-1-cuda', label: 'tts-1-cuda (Fast GPU)' },
        { value: 'tts-1-hd-cuda', label: 'tts-1-hd-cuda (Quality GPU)' },
    ];

    defaultSettings = {
        provider_endpoint: 'http://localhost:8005',
        voice: 'nova',
        format: 'mp3',
        speed: 1.0,
        temperature: 1.0,
        top_p: 1.0,
        model: 'tts-1',
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

    _updateStatus(connected) {
        const el = document.getElementById('ptts_status');
        if (!el) return;
        const qLen = this._wsQueue.length;
        const qInfo = qLen > 0 ? ` (queue: ${qLen})` : '';
        el.innerHTML = connected
            ? '<span style="color:#4caf50;">●</span> Connected' + qInfo
            : '<span style="color:#f44336;">●</span> Disconnected';
    }

    _updateServerInfo(info) {
        const el = document.getElementById('ptts_server_info');
        if (!el || !info) return;
        const parts = [];
        if (info.device) parts.push('Device: ' + info.device);
        if (info.sample_rate) parts.push(info.sample_rate + 'Hz');
        if (info.voice_cloning) {
            parts.push('Voice cloning: ON (custom .wav files in voices/ are usable)');
        } else {
            parts.push('Voice cloning: OFF (preset voices only)');
        }
        el.textContent = parts.join(' | ');
        el.style.color = '#6a6';
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
            this._disconnectWs();
            this.checkReady().then(() => this._updateStatus(this.ready));
        }
        saveTtsProviderSettings();
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

        $('#ptts_endpoint').on('input', () => this.onSettingsChange());
        $('#ptts_model').on('change', () => this.onSettingsChange());
        $('#ptts_format').on('change', () => this.onSettingsChange());
        $('#ptts_speed').on('input', () => this.onSettingsChange());
        $('#ptts_temperature').on('input', () => this.onSettingsChange());
        $('#ptts_top_p').on('input', () => this.onSettingsChange());

        window._pttsProvider = this;
        await this._loadVoices();
        await this.checkReady();
        this._updateStatus(this.ready);

        console.debug('PocketTTS: Settings loaded');
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
        await this.checkReady();
        this._updateStatus(this.ready);
    }

    // ─── Voice Management ──────────────────────────────────────────

    async _loadVoices() {
        try {
            const url = this.settings.provider_endpoint.replace(/\/$/, '');
            const resp = await fetch(url + '/v1/voices', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                this.voices = (data.voices || []).map(v => ({
                    name: v,
                    voice_id: v,
                    lang: 'en',
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

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName);
        if (!match) {
            throw 'TTS Voice name "' + voiceName + '" not found';
        }
        return match;
    }

    async fetchTtsVoiceObjects() {
        if (this.voices.length === 0) {
            await this._loadVoices();
        }
        return this.voices;
    }

    // ─── TTS Generation (Persistent WS) ────────────────────────────

    async generateTts(text, voiceId) {
        console.debug('PocketTTS: generate, voice="' + voiceId + '", ' + text.length + ' chars');
        return new Promise((resolve, reject) => {
            const req = { text, voice: voiceId, resolve, reject };
            req.timeout = setTimeout(() => {
                const idx = this._wsQueue.indexOf(req);
                if (idx >= 0) this._wsQueue.splice(idx, 1);
                if (this._wsCurrent === req) this._wsCurrent = null;
                reject(new Error('TTS request timeout (120s)'));
                this._updateStatus(this.ready);
            }, 120000);

            this._wsQueue.push(req);
            this._updateStatus(this.ready);
            this._processQueue();
        });
    }

    async _processQueue() {
        // Already processing a request
        if (this._wsCurrent) return;
        // Queue empty
        if (this._wsQueue.length === 0) return;

        this._wsCurrent = this._wsQueue.shift();
        this._updateStatus(this.ready);

        try {
            const ws = await this._ensureWs();
            this._wsChunks = [];

            ws.send(JSON.stringify({
                text: this._wsCurrent.text,
                voice: this._wsCurrent.voice,
                format: this.settings.format,
                speed: this.settings.speed,
                temperature: this.settings.temperature,
                top_p: this.settings.top_p,
                model: this.settings.model,
            }));
        } catch (err) {
            clearTimeout(this._wsCurrent.timeout);
            this._wsCurrent.reject(err);
            this._wsCurrent = null;
            this._updateStatus(this.ready);
            this._processQueue();
        }
    }

    _onWsMessage(event) {
        if (!this._wsCurrent) return;

        if (event.data instanceof ArrayBuffer) {
            this._wsChunks.push(new Uint8Array(event.data));
            return;
        }

        try {
            const msg = JSON.parse(event.data);
            if (msg.status === 'done') {
                clearTimeout(this._wsCurrent.timeout);
                const totalLen = this._wsChunks.reduce((s, c) => s + c.length, 0);
                const combined = new Uint8Array(totalLen);
                let off = 0;
                for (const ch of this._wsChunks) { combined.set(ch, off); off += ch.length; }
                const blob = new Blob([combined], { type: this._getMimeType() });
                const resp = new Response(blob, { headers: { 'Content-Type': blob.type } });
                this._wsCurrent.resolve(resp);
                this._wsCurrent = null;
                this._updateStatus(this.ready);
                this._processQueue();
            } else if (msg.status === 'error') {
                clearTimeout(this._wsCurrent.timeout);
                this._wsCurrent.reject(new Error(msg.error || 'WebSocket TTS error'));
                this._wsCurrent = null;
                this._updateStatus(this.ready);
                this._processQueue();
            }
        } catch { /* ignore non-JSON text frames */ }
    }

    _onWsClose() {
        this._wsReady = false;
        if (this._wsCurrent) {
            clearTimeout(this._wsCurrent.timeout);
            this._wsCurrent.reject(new Error('WebSocket closed'));
            this._wsCurrent = null;
        }
        this._updateStatus(false);

        // Retry queue items if any remain
        if (this._wsQueue.length > 0) {
            setTimeout(() => this._processQueue(), 1000);
        }
    }

    // ─── Preview ───────────────────────────────────────────────────

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const text = getPreviewString('en-US');

        try {
            const response = await this.generateTts(text, voiceId);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            this.audioElement.src = url;
            this.audioElement.play();
            this.audioElement.onended = () => URL.revokeObjectURL(url);
        } catch (err) {
            console.error('PocketTTS preview error:', err);
        }
    }

    // ─── Persistent WebSocket Connection ───────────────────────────

    _getWsUrl(path) {
        let ep = this.settings.provider_endpoint.replace(/\/$/, '');
        if (ep.startsWith('http://')) ep = ep.replace('http://', 'ws://');
        else if (ep.startsWith('https://')) ep = ep.replace('https://', 'wss://');
        if (!ep.startsWith('ws://') && !ep.startsWith('wss://')) ep = 'ws://' + ep;
        return ep + (path || '/v1/audio/stream');
    }

    async _ensureWs() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsReady) {
            return this._ws;
        }
        this._disconnectWs();

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this._getWsUrl());
            ws.binaryType = 'arraybuffer';

            const timer = setTimeout(() => {
                ws.removeEventListener('open', onOpen);
                ws.removeEventListener('error', onErr);
                try { ws.close(); } catch { /* */ }
                reject(new Error('WebSocket connection timeout'));
            }, 10000);

            const onOpen = () => {
                clearTimeout(timer);
                ws.removeEventListener('error', onErr);
                console.debug('PocketTTS: WebSocket connected (persistent)');
                this._ws = ws;
                this._wsReady = true;
                ws.addEventListener('message', (e) => this._onWsMessage(e));
                ws.addEventListener('close', () => this._onWsClose());
                ws.addEventListener('error', () => {
                    console.error('PocketTTS: WebSocket error during operation');
                });
                resolve(ws);
            };

            const onErr = (err) => {
                clearTimeout(timer);
                ws.removeEventListener('open', onOpen);
                console.error('PocketTTS: WebSocket connection error', err);
                reject(new Error('WebSocket connection failed'));
            };

            ws.addEventListener('open', onOpen);
            ws.addEventListener('error', onErr);
        });
    }

    _disconnectWs() {
        this._wsReady = false;
        if (this._ws) {
            try { this._ws.close(); } catch { /* */ }
            this._ws = null;
        }
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

    // ─── Cleanup ───────────────────────────────────────────────────

    dispose() {
        // Reject all queued requests
        for (const req of this._wsQueue) {
            clearTimeout(req.timeout);
            req.reject(new Error('Provider disposed'));
        }
        this._wsQueue = [];
        if (this._wsCurrent) {
            clearTimeout(this._wsCurrent.timeout);
            this._wsCurrent.reject(new Error('Provider disposed'));
            this._wsCurrent = null;
        }
        this._disconnectWs();
    }
}
