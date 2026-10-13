import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function worker() {
    let now = 0;
    let nextTimer = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const sockets: FakeSocket[] = [];
    const messages: any[] = [];
    class FakeSocket {
        readyState = 0;
        onopen: () => void;
        onclose: (event: any) => void;
        onerror: () => void;
        onmessage: (event: any) => void;
        constructor(public url: string) { sockets.push(this); }
        send() {}
        open() { this.readyState = 1; this.onopen?.(); }
        close(code = 1006, reason = '') {
            this.readyState = 3;
            this.onclose?.({ code, reason, wasClean: code === 1000 });
        }
    }
    const self: any = {};
    runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(
        readFileSync(new URL('../src/ws-worker.ts', import.meta.url), 'utf8')), {
        self, WebSocket: FakeSocket, console, ArrayBuffer,
        postMessage: (message: any) => messages.push(message),
        setTimeout: (callback: () => void, delay: number) => {
            const id = ++nextTimer;
            timers.set(id, { at: now + delay, callback });
            return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
    });
    function advance(ms: number) {
        const end = now + ms;
        while (true) {
            const pending = [...timers].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!pending) break;
            now = pending[1].at;
            timers.delete(pending[0]);
            pending[1].callback();
        }
        now = end;
    }
    const send = (data: any) => self.onmessage({ data });
    send({ type: 'init', url: 'ws://test/v1/audio/stream' });
    return { sockets, messages, advance, send };
}

describe('WebSocket reconnect policy', () => {
    test('immediate open/close keeps increasing backoff and eventually stops', () => {
        const instance = worker();
        for (let attempt = 0; attempt < 11; attempt++) {
            const socket = instance.sockets.at(-1)!;
            socket.open();
            socket.close();
            if (attempt < 10) instance.advance(Math.min(500 * 1.5 ** attempt, 5000));
        }
        const scheduled = instance.messages.filter(message => message.message === 'scheduled reconnect');
        expect(scheduled.slice(0, 3).map(message => message.delay)).toEqual([500, 750, 1125]);
        expect(scheduled).toHaveLength(10);
        expect(instance.messages.some(message => message.fatal === true)).toBe(true);
        instance.advance(60000);
        expect(instance.sockets).toHaveLength(11);
    });

    test('a stable connection resets backoff', () => {
        const instance = worker();
        instance.sockets[0].open();
        instance.sockets[0].close();
        instance.advance(500);
        instance.sockets[1].open();
        instance.advance(10000);
        instance.sockets[1].close();
        const scheduled = instance.messages.filter(message => message.message === 'scheduled reconnect');
        expect(scheduled.map(message => message.delay)).toEqual([500, 500]);
    });

    test('1013 respects server retry delay and explicit close cancels it', () => {
        const instance = worker();
        instance.sockets[0].open();
        instance.sockets[0].close(1013, 'Rate limit exceeded; retry after 42s');
        instance.advance(41999);
        expect(instance.sockets).toHaveLength(1);
        instance.send({ type: 'close' });
        instance.advance(60000);
        expect(instance.sockets).toHaveLength(1);
    });

    test('policy rejection does not reconnect', () => {
        const instance = worker();
        instance.sockets[0].open();
        instance.sockets[0].close(1008, 'Invalid session');
        instance.advance(60000);
        expect(instance.sockets).toHaveLength(1);
        expect(instance.messages.some(message => message.fatal === true)).toBe(true);
    });
});
