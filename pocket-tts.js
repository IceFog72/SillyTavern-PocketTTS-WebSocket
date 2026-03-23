// pocket-tts.js — SillyTavern TTS Provider for pocket-tts-openapi
// Supports HTTP streaming (GET) and standard generation (POST).
// WebSocket optional for real-time streaming.

import { saveTtsProviderSettings, getPreviewString } from '../../tts/index.js';

export { PocketTtsProvider };

class PocketTtsProvider {
    settings = {};
    ready = false;
    voices = [];
    separator = '. ';

    audioElement = document.createElement('audio');

    _ws = null;
    _wsBuffer = [];
    _wsResolve = null;

    defaultSettings = {
        provider_endpoint: 'http://localhost:8005',
        voice: 'nova',
        format: 'mp3',
        speed: 1.0,
        language: 'en',
        streaming: true,
        temperature: 1.0,
        top_p: 1.0,
        voiceMap: {},
    };

    get settingsHtml() {
        return `
        <div class="pocket-tts-settings">
            <label for="ptts_endpoint">Server Endpoint:</label>
            <input id="ptts_endpoint" type="text" class="text_pole" maxlength="500"
                value="${this.defaultSettings.provider_endpoint}" placeholder="http://localhost:8005" />

            <div id="ptts_server_info" style="margin:4px 0;font-size:0.85em;color:#888;"></div>
            <div id="ptts_status" style="margin:4px 0;font-size:0.85em;">
                <span style="color:#888;">●</span> Not connected
            </div>

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

            <label for="ptts_streaming" class="checkbox_label">
                <input id="ptts_streaming" type="checkbox" ${this.defaultSettings.streaming ? 'checked' : ''} />
                Streaming (direct URL, faster start)
            </label>
        </div>
        `;
    }

    _updateStatus(connected) {
        const el = document.getElementById('ptts_status');
        if (!el) return;
        el.innerHTML = connected
            ? '<span style="color:#4caf50;">●</span> Connected'
            : '<span style="color:#f44336;">●</span> Disconnected';
    }

    _updateServerInfo(info) {
        const el = document.getElementById('ptts_server_info');
        if (!el || !info) return;
        const parts = [];
        if (info.device) parts.push(`Device: ${info.device}`);
        if (info.sample_rate) parts.push(`${info.sample_rate}Hz`);
        if (info.voice_cloning) parts.push('Cloning: ON');
        el.textContent = parts.join(' | ');
        el.style.color = '#6a6';
    }

    onSettingsChange() {
        this.settings.provider_endpoint = String($('#ptts_endpoint').val());
        this.settings.format = String($('#ptts_format').val());
        this.settings.speed = parseFloat($('#ptts_speed').val());
        this.settings.temperature = parseFloat($('#ptts_temperature').val());
        this.settings.top_p = parseFloat($('#ptts_top_p').val());
        this.settings.streaming = $('#ptts_streaming').is(':checked');

        $('#ptts_speed_val').text(this.settings.speed);
        $('#ptts_temperature_val').text(this.settings.temperature);
        $('#ptts_top_p_val').text(this.settings.top_p);

        this._disconnectWs();
        this.checkReady().then(() => this._updateStatus(this.ready));
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
        $('#ptts_format').val(this.settings.format);
        $('#ptts_speed').val(this.settings.speed);
        $('#ptts_speed_val').text(this.settings.speed);
        $('#ptts_temperature').val(this.settings.temperature);
        $('#ptts_temperature_val').text(this.settings.temperature);
        $('#ptts_top_p').val(this.settings.top_p);
        $('#ptts_top_p_val').text(this.settings.top_p);
        $('#ptts_streaming').prop('checked', this.settings.streaming);

        $('#ptts_endpoint').on('input', () => this.onSettingsChange());
        $('#ptts_format').on('change', () => this.onSettingsChange());
        $('#ptts_speed').on('input', () => this.onSettingsChange());
        $('#ptts_temperature').on('input', () => this.onSettingsChange());
        $('#ptts_top_p').on('input', () => this.onSettingsChange());
        $('#ptts_streaming').on('change', () => this.onSettingsChange());

        window._pttsProvider = this;
        await this._loadVoices();
        await this.checkReady();
        this._updateStatus(this.ready);

        console.debug('PocketTTS: Settings loaded');
    }

    async checkReady() {
        try {
            const url = this.settings.provider_endpoint.replace(/\/$/, '');
            const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
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
            const resp = await fetch(`${url}/v1/voices`, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                this.voices = (data.voices || []).map(v => ({
                    name: v,
                    voice_id: v,
                    lang: this.settings.language,
                }));
                return this.voices;
            }
        } catch { /* server unavailable */ }

        this.voices = ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer',
            'alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma']
            .map(v => ({ name: v, voice_id: v, lang: this.settings.language }));
        return this.voices;
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName);
        if (!match) {
            throw `TTS Voice name "${voiceName}" not found`;
        }
        return match;
    }

    async fetchTtsVoiceObjects() {
        if (this.voices.length === 0) {
            await this._loadVoices();
        }
        return this.voices;
    }

    // ─── TTS Generation ────────────────────────────────────────────

    async generateTts(text, voiceId) {
        console.debug(`PocketTTS: Generating for voice "${voiceId}", ${text.length} chars`);

        if (this.settings.streaming) {
            return this._generateStreamingUrl(text, voiceId);
        }

        return this._generateViaPost(text, voiceId);
    }

    _generateStreamingUrl(text, voiceId) {
        const base = this.settings.provider_endpoint.replace(/\/$/, '');
        const params = new URLSearchParams({
            text: text,
            voice: voiceId,
            format: this.settings.format,
            speed: this.settings.speed,
        });
        return `${base}/tts_stream?${params.toString()}`;
    }

    async _generateViaPost(text, voiceId) {
        const base = this.settings.provider_endpoint.replace(/\/$/, '');
        const response = await fetch(`${base}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: text,
                voice: voiceId,
                response_format: this.settings.format,
                speed: this.settings.speed,
                temperature: this.settings.temperature,
                top_p: this.settings.top_p,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            toastr.error(response.statusText, 'PocketTTS Generation Failed');
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        return response;
    }

    // ─── Preview ───────────────────────────────────────────────────

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const text = getPreviewString(this.settings.language === 'en' ? 'en-US' : this.settings.language);

        if (this.settings.streaming) {
            this.audioElement.src = this._generateStreamingUrl(text, voiceId);
            this.audioElement.play();
        } else {
            try {
                const response = await this._generateViaPost(text, voiceId);
                const audio = await response.blob();
                const url = URL.createObjectURL(audio);
                this.audioElement.src = url;
                this.audioElement.play();
                this.audioElement.onended = () => URL.revokeObjectURL(url);
            } catch (err) {
                console.error('PocketTTS preview error:', err);
            }
        }
    }

    // ─── WebSocket Helpers ─────────────────────────────────────────

    _getWsUrl(path = '/v1/audio/stream') {
        let ep = this.settings.provider_endpoint.replace(/\/$/, '');
        if (ep.startsWith('http://')) ep = ep.replace('http://', 'ws://');
        else if (ep.startsWith('https://')) ep = ep.replace('https://', 'wss://');
        if (!ep.startsWith('ws://') && !ep.startsWith('wss://')) ep = 'ws://' + ep;
        return ep + path;
    }

    async connectWs() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) return this._ws;
        this._disconnectWs();

        return new Promise((resolve, reject) => {
            this._ws = new WebSocket(this._getWsUrl());
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                console.debug('PocketTTS: WebSocket connected');
                resolve(this._ws);
            };

            this._ws.onerror = (err) => {
                console.error('PocketTTS: WebSocket error', err);
                reject(err);
            };

            this._ws.onmessage = (event) => {
                if (this._wsResolve) {
                    this._wsResolve(event.data);
                    this._wsResolve = null;
                } else {
                    this._wsBuffer.push(event.data);
                }
            };
        });
    }

    async generateTtsWs(text, voiceId) {
        const ws = await this.connectWs();

        return new Promise((resolve, reject) => {
            const chunks = [];
            let done = false;

            const handler = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    chunks.push(new Uint8Array(event.data));
                } else {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.status === 'done') {
                            done = true;
                            ws.removeEventListener('message', handler);

                            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
                            const combined = new Uint8Array(totalLen);
                            let offset = 0;
                            for (const chunk of chunks) {
                                combined.set(chunk, offset);
                                offset += chunk.length;
                            }
                            const mime = this._getMimeType();
                            resolve(new Blob([combined], { type: mime }));
                        } else if (msg.status === 'error') {
                            ws.removeEventListener('message', handler);
                            reject(new Error(msg.error || 'WebSocket TTS error'));
                        }
                    } catch { /* ignore parse errors */ }
                }
            };

            ws.addEventListener('message', handler);

            ws.send(JSON.stringify({
                text: text,
                voice: voiceId,
                format: this.settings.format,
                speed: this.settings.speed,
                temperature: this.settings.temperature,
                top_p: this.settings.top_p,
            }));

            setTimeout(() => {
                if (!done) {
                    ws.removeEventListener('message', handler);
                    reject(new Error('WebSocket TTS timeout'));
                }
            }, 60000);
        });
    }

    _disconnectWs() {
        if (this._ws) {
            try { this._ws.close(); } catch { /* */ }
            this._ws = null;
        }
        this._wsBuffer = [];
        this._wsResolve = null;
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
        this._disconnectWs();
    }
}
