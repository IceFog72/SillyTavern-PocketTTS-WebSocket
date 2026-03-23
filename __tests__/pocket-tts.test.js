import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockTts = {
    saveTtsProviderSettings: () => {},
    getPreviewString: () => 'The quick brown fox jumps over the lazy dog',
};
jest.unstable_mockModule(
    '/home/icefog/LLM/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/tts/index.js',
    () => mockTts,
);

// Polyfill Response/Blob if missing in jsdom
if (typeof globalThis.Response === 'undefined') {
    const { Blob } = await import('buffer');
    globalThis.Blob = Blob;
    globalThis.Response = class Response {
        constructor(body, init) { this.body = body; this._init = init; this.headers = init?.headers || {}; }
        async blob() { return this.body; }
        async text() { return ''; }
    };
}

const { PocketTtsProvider } = await import('../pocket-tts.js');

describe('PocketTtsProvider', () => {
    let provider;

    beforeEach(() => {
        provider = new PocketTtsProvider();
        provider.settings = { ...provider.defaultSettings };
    });

    // ── Model Options ────────────────────────────────

    describe('MODEL_OPTIONS', () => {
        test('has 4 tiers', () => {
            expect(PocketTtsProvider.MODEL_OPTIONS).toHaveLength(4);
        });

        test('contains all expected values', () => {
            const vals = PocketTtsProvider.MODEL_OPTIONS.map(m => m.value);
            expect(vals).toContain('tts-1');
            expect(vals).toContain('tts-1-hd');
            expect(vals).toContain('tts-1-cuda');
            expect(vals).toContain('tts-1-hd-cuda');
        });
    });

    // ── Default Settings ─────────────────────────────

    describe('defaultSettings', () => {
        test('endpoint is localhost:8005', () => {
            expect(provider.defaultSettings.provider_endpoint).toBe('http://localhost:8005');
        });

        test('model defaults to tts-1', () => {
            expect(provider.defaultSettings.model).toBe('tts-1');
        });

        test('format defaults to mp3', () => {
            expect(provider.defaultSettings.format).toBe('mp3');
        });

        test('speed defaults to 1.0', () => {
            expect(provider.defaultSettings.speed).toBe(1.0);
        });

        test('temperature defaults to 1.0', () => {
            expect(provider.defaultSettings.temperature).toBe(1.0);
        });

        test('top_p defaults to 1.0', () => {
            expect(provider.defaultSettings.top_p).toBe(1.0);
        });
    });

    // ── Settings HTML ────────────────────────────────

    describe('settingsHtml', () => {
        test('contains endpoint input', () => {
            expect(provider.settingsHtml).toContain('ptts_endpoint');
        });

        test('contains model select', () => {
            expect(provider.settingsHtml).toContain('ptts_model');
        });

        test('contains format select', () => {
            expect(provider.settingsHtml).toContain('ptts_format');
        });

        test('contains speed slider', () => {
            expect(provider.settingsHtml).toContain('ptts_speed');
        });

        test('contains temperature slider', () => {
            expect(provider.settingsHtml).toContain('ptts_temperature');
        });

        test('contains top_p slider', () => {
            expect(provider.settingsHtml).toContain('ptts_top_p');
        });

        test('contains status indicator', () => {
            expect(provider.settingsHtml).toContain('ptts_status');
        });

        test('contains server info area', () => {
            expect(provider.settingsHtml).toContain('ptts_server_info');
        });

        test('does NOT contain streaming checkbox', () => {
            expect(provider.settingsHtml).not.toContain('ptts_streaming');
        });

        test('model options include all tiers', () => {
            const html = provider.settingsHtml;
            expect(html).toContain('tts-1');
            expect(html).toContain('tts-1-hd');
            expect(html).toContain('tts-1-cuda');
            expect(html).toContain('tts-1-hd-cuda');
        });
    });

    // ── WebSocket URL Construction ───────────────────

    describe('_getWsUrl', () => {
        test('converts http:// to ws://', () => {
            provider.settings.provider_endpoint = 'http://localhost:8005';
            expect(provider._getWsUrl()).toBe('ws://localhost:8005/v1/audio/stream');
        });

        test('converts https:// to wss://', () => {
            provider.settings.provider_endpoint = 'https://example.com';
            expect(provider._getWsUrl()).toBe('wss://example.com/v1/audio/stream');
        });

        test('keeps ws:// unchanged', () => {
            provider.settings.provider_endpoint = 'ws://localhost:8005';
            expect(provider._getWsUrl()).toBe('ws://localhost:8005/v1/audio/stream');
        });

        test('adds ws:// if no scheme', () => {
            provider.settings.provider_endpoint = 'localhost:8005';
            expect(provider._getWsUrl()).toBe('ws://localhost:8005/v1/audio/stream');
        });

        test('strips trailing slash from endpoint', () => {
            provider.settings.provider_endpoint = 'http://localhost:8005/';
            expect(provider._getWsUrl()).toBe('ws://localhost:8005/v1/audio/stream');
        });

        test('accepts custom path', () => {
            provider.settings.provider_endpoint = 'http://localhost:8005';
            expect(provider._getWsUrl('/v1/realtime')).toBe('ws://localhost:8005/v1/realtime');
        });

        test('handles port with path', () => {
            provider.settings.provider_endpoint = 'http://192.168.1.10:8005';
            expect(provider._getWsUrl()).toBe('ws://192.168.1.10:8005/v1/audio/stream');
        });
    });

    // ── MIME Type ────────────────────────────────────

    describe('_getMimeType', () => {
        test('mp3 → audio/mpeg', () => {
            provider.settings.format = 'mp3';
            expect(provider._getMimeType()).toBe('audio/mpeg');
        });

        test('wav → audio/wav', () => {
            provider.settings.format = 'wav';
            expect(provider._getMimeType()).toBe('audio/wav');
        });

        test('opus → audio/opus', () => {
            provider.settings.format = 'opus';
            expect(provider._getMimeType()).toBe('audio/opus');
        });

        test('flac → audio/flac', () => {
            provider.settings.format = 'flac';
            expect(provider._getMimeType()).toBe('audio/flac');
        });

        test('aac → audio/aac', () => {
            provider.settings.format = 'aac';
            expect(provider._getMimeType()).toBe('audio/aac');
        });

        test('unknown defaults to audio/mpeg', () => {
            provider.settings.format = 'ogg';
            expect(provider._getMimeType()).toBe('audio/mpeg');
        });
    });

    // ── WebSocket Disconnect ─────────────────────────

    describe('_disconnectWs', () => {
        test('nulls _ws and sets _wsReady false', () => {
            provider._ws = { close: () => {} };
            provider._wsReady = true;
            provider._disconnectWs();
            expect(provider._ws).toBeNull();
            expect(provider._wsReady).toBe(false);
        });

        test('tolerates null _ws', () => {
            provider._ws = null;
            expect(() => provider._disconnectWs()).not.toThrow();
        });
    });

    // ── Request Queue ────────────────────────────────

    describe('request queue', () => {
        test('_wsQueue starts empty', () => {
            expect(provider._wsQueue).toEqual([]);
        });

        test('_wsCurrent starts null', () => {
            expect(provider._wsCurrent).toBeNull();
        });

        test('_wsChunks starts empty', () => {
            expect(provider._wsChunks).toEqual([]);
        });

        test('_processQueue does nothing when queue empty', () => {
            expect(() => provider._processQueue()).not.toThrow();
        });

        test('dispose rejects queued requests', async () => {
            const p1 = new Promise((resolve, reject) => {
                provider._wsQueue.push({ text: 'hi', voice: 'nova', resolve, reject, timeout: setTimeout(() => {}, 99999) });
            });
            provider.dispose();
            await expect(p1).rejects.toThrow('Provider disposed');
            expect(provider._wsQueue).toEqual([]);
        });
    });

    // ── Initial State ────────────────────────────────

    describe('initial state', () => {
        test('ready is false', () => {
            expect(provider.ready).toBe(false);
        });

        test('voices is empty', () => {
            expect(provider.voices).toEqual([]);
        });

        test('separator is ". "', () => {
            expect(provider.separator).toBe('. ');
        });

        test('_ws is null', () => {
            expect(provider._ws).toBeNull();
        });

        test('_wsReady is false', () => {
            expect(provider._wsReady).toBe(false);
        });
    });

    // ── onWsMessage ──────────────────────────────────

    describe('_onWsMessage', () => {
        test('accumulates binary chunks', () => {
            provider._wsCurrent = { resolve: jest.fn(), reject: jest.fn(), timeout: setTimeout(() => {}, 99999) };
            provider._wsChunks = [];

            const chunk1 = new ArrayBuffer(10);
            const chunk2 = new ArrayBuffer(5);
            provider._onWsMessage({ data: chunk1 });
            provider._onWsMessage({ data: chunk2 });

            expect(provider._wsChunks).toHaveLength(2);
            expect(provider._wsChunks[0]).toHaveLength(10);
            expect(provider._wsChunks[1]).toHaveLength(5);

            clearTimeout(provider._wsCurrent.timeout);
        });

        test('resolves on done with combined blob', () => {
            const resolve = jest.fn();
            provider._wsCurrent = { resolve, reject: jest.fn(), timeout: setTimeout(() => {}, 99999) };
            provider._wsChunks = [new Uint8Array([1, 2, 3])];

            provider._onWsMessage({ data: JSON.stringify({ status: 'done' }) });

            expect(resolve).toHaveBeenCalledTimes(1);
            expect(resolve.mock.calls[0][0]).toBeInstanceOf(Response);
            expect(provider._wsCurrent).toBeNull();
        });

        test('rejects on error', () => {
            const reject = jest.fn();
            provider._wsCurrent = { resolve: jest.fn(), reject, timeout: setTimeout(() => {}, 99999) };
            provider._wsChunks = [];

            provider._onWsMessage({ data: JSON.stringify({ status: 'error', error: 'test failure' }) });

            expect(reject).toHaveBeenCalledTimes(1);
            expect(reject.mock.calls[0][0].message).toBe('test failure');
            expect(provider._wsCurrent).toBeNull();
        });

        test('ignores messages when no current request', () => {
            provider._wsCurrent = null;
            expect(() => provider._onWsMessage({ data: '{"status":"done"}' })).not.toThrow();
        });
    });
});
