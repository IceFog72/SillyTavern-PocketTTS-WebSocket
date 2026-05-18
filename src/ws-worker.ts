// ws-worker.js — Fire-and-forget WebSocket TTS
// Client sends text immediately, server sends audio back when ready.
// Sending and receiving are independent — no queue, no waiting.

import type { WsClientPayload } from './types.js';

let ws: WebSocket | null = null;
let wsReady = false;
let wsUrl = '';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let pendingSends: WsClientPayload[] = [];  // messages buffered while reconnecting
let explicitlyClosed = false; // Fix #18: track if worker was explicitly closed

const MAX_RECONNECT_ATTEMPTS = 10;

function connect() {
    if (ws && ws.readyState <= 1) {
        postMessage({ type: 'debug', message: 'connect skipped: websocket already exists', readyState: ws.readyState });
        return;
    }

    postMessage({ type: 'debug', message: 'connecting websocket', url: wsUrl });
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        wsReady = true;
        reconnectAttempts = 0;
        postMessage({ type: 'debug', message: 'websocket open', buffered: pendingSends.length });
        postMessage({ type: 'status', connected: true });
        // Flush any messages that were buffered during disconnect
        const toSend = pendingSends;
        pendingSends = [];
        for (const msg of toSend) {
            try {
                postMessage({ type: 'debug', message: 'sending buffered payload', payloadType: msg.type, requestId: 'request_id' in msg ? msg.request_id : null });
                ws.send(JSON.stringify(msg));
            } catch {
                postMessage({ type: 'debug', message: 'buffered send failed, requeueing', payloadType: msg.type });
                pendingSends.push(msg);
            }
        }
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            postMessage({ type: 'audio', data: event.data }, [event.data]);
        } else {
            try {
                const msg = JSON.parse(event.data);
                postMessage({ type: 'json', msg });
            } catch (e) {
                postMessage({ type: 'error', error: 'Parse: ' + errorMessage(e) });
            }
        }
    };

    ws.onclose = () => {
        wsReady = false;
        ws = null;
        postMessage({ type: 'debug', message: 'websocket closed', explicitlyClosed });
        postMessage({ type: 'status', connected: false });
        // Fix #18: Don't reconnect if explicitly closed
        if (!explicitlyClosed) {
            scheduleReconnect();
        }
    };

    ws.onerror = () => {
        postMessage({ type: 'debug', message: 'websocket error' });
    };
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`[pocketTTS-WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
        postMessage({ type: 'status', connected: false, fatal: true });
        return;
    }
    const delay = Math.min(500 * Math.pow(1.5, reconnectAttempts), 5000);
    reconnectAttempts++;
    postMessage({ type: 'debug', message: 'scheduled reconnect', delay, reconnectAttempts });
    reconnectTimer = setTimeout(connect, delay);
}

self.onmessage = (event: MessageEvent<{ type: string; url?: string; payload?: WsClientPayload }>) => {
    const { type, url, payload } = event.data;

    switch (type) {
        case 'init':
            wsUrl = url || '';
            postMessage({ type: 'debug', message: 'worker init', url: wsUrl });
            connect();
            break;

        case 'send':
            // Fire and forget — send immediately, don't wait for response
            if (!payload) return;
            if (wsReady && ws) {
                try {
                    postMessage({ type: 'debug', message: 'sending payload', payloadType: payload.type, requestId: 'request_id' in payload ? payload.request_id : null });
                    ws.send(JSON.stringify(payload));
                } catch {
                    postMessage({ type: 'debug', message: 'send failed, buffering payload', payloadType: payload.type });
                    pendingSends.push(payload);
                }
            } else {
                // Buffer until reconnected
                postMessage({ type: 'debug', message: 'buffering payload: websocket not ready', payloadType: payload.type, requestId: 'request_id' in payload ? payload.request_id : null, pending: pendingSends.length + 1 });
                pendingSends.push(payload);
            }
            break;

        case 'close':
            explicitlyClosed = true; // Fix #18: mark as explicitly closed
            postMessage({ type: 'debug', message: 'worker close requested' });
            if (reconnectTimer) clearTimeout(reconnectTimer);
            pendingSends = [];
            if (ws) try { ws.close(); } catch {}
            break;

        case 'clear':
            postMessage({ type: 'debug', message: 'worker clear requested', pending: pendingSends.length });
            pendingSends = [];
            break;
    }
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
