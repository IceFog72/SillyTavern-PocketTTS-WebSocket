// ws-worker.js — Fire-and-forget WebSocket TTS
// Client sends text immediately, server sends audio back when ready.
// Sending and receiving are independent — no queue, no waiting.

let ws = null;
let wsReady = false;
let wsUrl = '';
let reconnectTimer = null;
let reconnectAttempts = 0;
let pendingSends = [];  // messages buffered while reconnecting
let explicitlyClosed = false; // Fix #18: track if worker was explicitly closed

const MAX_RECONNECT_ATTEMPTS = 10;

function connect() {
    if (ws && ws.readyState <= 1) return;

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        wsReady = true;
        reconnectAttempts = 0;
        postMessage({ type: 'status', connected: true });
        // Flush any messages that were buffered during disconnect
        const toSend = pendingSends;
        pendingSends = [];
        for (const msg of toSend) {
            try { ws.send(JSON.stringify(msg)); } catch {
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
                postMessage({ type: 'error', error: 'Parse: ' + e.message });
            }
        }
    };

    ws.onclose = () => {
        wsReady = false;
        ws = null;
        postMessage({ type: 'status', connected: false });
        // Fix #18: Don't reconnect if explicitly closed
        if (!explicitlyClosed) {
            scheduleReconnect();
        }
    };

    ws.onerror = () => {};
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
    reconnectTimer = setTimeout(connect, delay);
}

self.onmessage = (event) => {
    const { type, url, payload } = event.data;

    switch (type) {
        case 'init':
            wsUrl = url;
            connect();
            break;

        case 'send':
            // Fire and forget — send immediately, don't wait for response
            if (wsReady && ws) {
                try { ws.send(JSON.stringify(payload)); } catch {
                    pendingSends.push(payload);
                }
            } else {
                // Buffer until reconnected
                pendingSends.push(payload);
            }
            break;

        case 'close':
            explicitlyClosed = true; // Fix #18: mark as explicitly closed
            if (reconnectTimer) clearTimeout(reconnectTimer);
            pendingSends = [];
            if (ws) try { ws.close(); } catch {}
            break;

        case 'clear':
            pendingSends = [];
            break;
    }
};
