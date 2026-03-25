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

        test('_processQueue does nothing when queue empty', () => {
            expect(() => provider._processQueue()).not.toThrow();
        });

        test('dispose rejects queued requests', async () => {
            const p1 = new Promise((resolve, reject) => {
                provider._wsQueue.push({
                    text: 'hi', voice: 'nova',
                    streamController: () => null,
                    resolve, reject,
                    timeout: setTimeout(() => {}, 99999),
                });
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

    // ── onWsMessage (streaming) ──────────────────────

    describe('_onWsMessage', () => {
        test('enqueues binary chunks to stream controller', () => {
            const chunks = [];
            const ctrl = { enqueue: (data) => chunks.push(data) };
            provider._wsCurrent = {
                streamController: () => ctrl,
                resolve: jest.fn(), reject: jest.fn(),
                timeout: setTimeout(() => {}, 99999),
            };

            provider._onWsMessage({ data: new ArrayBuffer(10) });
            provider._onWsMessage({ data: new ArrayBuffer(5) });

            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toHaveLength(10);
            expect(chunks[1]).toHaveLength(5);

            clearTimeout(provider._wsCurrent.timeout);
        });

        test('closes stream controller on done', () => {
            const closed = jest.fn();
            const ctrl = { enqueue: jest.fn(), close: closed };
            provider._wsCurrent = {
                streamController: () => ctrl,
                resolve: jest.fn(), reject: jest.fn(),
                timeout: setTimeout(() => {}, 99999),
            };

            provider._onWsMessage({ data: JSON.stringify({ status: 'done', audio_duration: 2.5, gen_time: 1.3 }) });

            expect(closed).toHaveBeenCalledTimes(1);
            expect(provider._wsCurrent).toBeNull();
            expect(provider.lastTiming.audio_duration).toBe(2.5);
            expect(provider.lastTiming.gen_time).toBe(1.3);
        });

        test('errors stream controller on error', () => {
            const errored = jest.fn();
            const ctrl = { enqueue: jest.fn(), error: errored };
            provider._wsCurrent = {
                streamController: () => ctrl,
                resolve: jest.fn(), reject: jest.fn(),
                timeout: setTimeout(() => {}, 99999),
            };

            provider._onWsMessage({ data: JSON.stringify({ status: 'error', error: 'test failure' }) });

            expect(errored).toHaveBeenCalledTimes(1);
            expect(errored.mock.calls[0][0].message).toBe('test failure');
            expect(provider._wsCurrent).toBeNull();
        });

        test('ignores messages when no current request', () => {
            provider._wsCurrent = null;
            expect(() => provider._onWsMessage({ data: '{"status":"done"}' })).not.toThrow();
        });
    });

    // ── lastTiming ───────────────────────────────────

    describe('lastTiming', () => {
        test('defaults to zeros', () => {
            expect(provider.lastTiming.audio_duration).toBe(0);
            expect(provider.lastTiming.gen_time).toBe(0);
        });
    });

    // ── Reconnection & Backoff ───────────────────────

    describe('reconnection & backoff', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            globalThis.WebSocket = jest.fn().mockImplementation(() => ({
                addEventListener: jest.fn(),
                removeEventListener: jest.fn(),
                close: jest.fn(),
                send: jest.fn(),
            }));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('_onWsClose increments _reconnectAttempts and schedules retry', () => {
            provider._wsQueue.push({ text: 'test', voice: 'nova' });
            provider._reconnectAttempts = 0;

            provider._onWsClose();

            expect(provider._reconnectAttempts).toBe(1);
            expect(jest.getTimerCount()).toBe(1);
        });

        test('_processQueue failure increments _reconnectAttempts and schedules retry', async () => {
            provider._wsQueue.push({ text: 'test', voice: 'nova' });
            provider._ensureWs = jest.fn().mockRejectedValue(new Error('Conn fail'));

            await provider._processQueue();

            expect(provider._reconnectAttempts).toBe(1);
            expect(provider._wsQueue).toHaveLength(1); // Item was unshifted back
            expect(jest.getTimerCount()).toBe(1);
        });

        test('_ensureWs resets _reconnectAttempts on success', async () => {
            provider._reconnectAttempts = 5;
            
            // Mock a successful connection flow
            const mockWs = {
                addEventListener: jest.fn(),
                removeEventListener: jest.fn(),
                readyState: 1, // OPEN
            };
            
            // We need to simulate the promise resolution in _ensureWs
            // Since we're mocking the whole method for simplicity in other tests, 
            // let's test the real one by providing a mock WebSocket constructor
            
            const wsInstance = {
                addEventListener: jest.fn((event, cb) => {
                    if (event === 'open') setTimeout(cb, 10);
                }),
                removeEventListener: jest.fn(),
                binaryType: '',
            };
            globalThis.WebSocket = jest.fn(() => wsInstance);

            const promise = provider._ensureWs();
            jest.advanceTimersByTime(20);
            await promise;

            expect(provider._reconnectAttempts).toBe(0);
        });
    });

    // ── generateTtsTimed ─────────────────────────────

    describe('generateTtsTimed', () => {
        test('returns response and timing', async () => {
            const mockResp = new Response(new Blob([new Uint8Array([1])]), {
                headers: { 'Content-Type': 'audio/mpeg' },
            });
            provider.generateTts = jest.fn(async () => {
                provider.lastTiming = { audio_duration: 3.2, gen_time: 1.6 };
                return mockResp;
            });

            const result = await provider.generateTtsTimed('hello', 'nova');

            expect(result.response).toBeInstanceOf(Response);
            expect(result.audioDuration).toBe(3.2);
            expect(result.genTime).toBe(1.6);
        });
    });
});
