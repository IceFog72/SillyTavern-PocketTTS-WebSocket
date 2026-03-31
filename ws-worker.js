// ws-worker.js — Fire-and-forget WebSocket TTS
// Client sends text immediately, server sends audio back when ready.
// Sending and receiving are independent — no queue, no waiting.

let ws = null;
let wsReady = false;
let wsUrl = '';
let reconnectTimer = null;
let reconnectAttempts = 0;
let pendingSends = [];  // messages buffered while reconnecting

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
        scheduleReconnect();
    };

    ws.onerror = () => {};
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
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
            if (reconnectTimer) clearTimeout(reconnectTimer);
            pendingSends = [];
            if (ws) try { ws.close(); } catch {}
            break;

        case 'clear':
            pendingSends = [];
            break;
    }
};
