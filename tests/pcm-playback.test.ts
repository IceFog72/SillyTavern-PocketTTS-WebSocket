import { test, expect } from 'bun:test';
import { createPcmStream, appendPcm, pumpPcm, stopPcm, pausePcm, resumePcm, seekPcm, pcmPosition, pcmDuration, setPcmRate } from '../src/pcm-playback';

function fakeContext() {
    const starts: number[] = [];
    const buffers: Float32Array[] = [];
    let stops = 0;
    const context = {
        currentTime: 0, state: 'running', destination: {},
        createBuffer: (_channels, n, rate) => {
            const data = new Float32Array(n); buffers.push(data);
            return { duration: n / rate, getChannelData: () => data };
        },
        createBufferSource: () => ({ playbackRate: {value: 1}, connect() {}, disconnect() {}, start(t) { starts.push(t); }, stop() { stops++; } }),
        createGain: () => ({ connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }),
    };
    return { context: context as unknown as AudioContext, starts, buffers, get stops() { return stops; } };
}

test('starts with 60ms, recovers with a larger buffer, keeps exact sample duration', () => {
    const fake = fakeContext();
    const stream = createPcmStream(fake.context);
    stream.playing = true;
    appendPcm(stream, new Uint8Array(1920)); // 40ms
    expect(fake.starts.length).toBe(0);
    appendPcm(stream, new Uint8Array(1920));
    expect(fake.starts.length).toBe(2);
    expect(fake.starts[1] - fake.starts[0]).toBeCloseTo(0.04);
    fake.context.currentTime = stream.nextTime + 0.1;
    appendPcm(stream, new Uint8Array(1920));
    expect(stream.buffer.underruns).toBe(1);
    expect(stream.buffer.target).toBeGreaterThan(0.06);
    expect(fake.starts.length).toBe(2);
    stream.closed = true;
    pumpPcm(stream); // A short tail must drain, even below the target.
    expect(fake.starts.length).toBe(3);
    stopPcm(stream);
    expect(fake.stops).toBe(3);
});

test('preserves a PCM sample split between network messages', () => {
    const fake = fakeContext();
    const stream = createPcmStream(fake.context);
    appendPcm(stream, new Uint8Array([0]));
    appendPcm(stream, new Uint8Array([64]));
    stream.closed = true;
    stream.playing = true;
    pumpPcm(stream);
    expect(fake.buffers[0][0]).toBe(0.5);
    stopPcm(stream);
    appendPcm(stream, new Uint8Array(4000));
    expect(fake.starts.length).toBe(1);
});

test('pause retains new arrivals and rate/seek rebuild only the unplayed samples', () => {
    const fake = fakeContext();
    const stream = createPcmStream(fake.context);
    stream.playing = true;
    appendPcm(stream, new Uint8Array(48000));
    fake.context.currentTime = stream.anchorTime + 0.25;
    pausePcm(stream);
    expect(pcmPosition(stream)).toBeCloseTo(0.25);
    fake.context.currentTime = 4;
    appendPcm(stream, new Uint8Array(48000));
    expect(pcmPosition(stream)).toBeCloseTo(0.25);
    expect(pcmDuration(stream)).toBe(2);
    setPcmRate(stream, 1.5);
    seekPcm(stream, 1.2);
    expect(stream.playing).toBe(false);
    stream.closed = true;
    resumePcm(stream);
    expect(pcmPosition(stream)).toBeCloseTo(1.2);
    expect(stream.nextTime - stream.anchorTime).toBeCloseTo(0.8 / 1.5);
    fake.context.currentTime = stream.anchorTime + 0.2;
    expect(pcmPosition(stream)).toBeCloseTo(1.5);
    stopPcm(stream);
    expect(stream.history.length).toBe(0);
});

test('the media clock freezes during adaptive rebuffering', () => {
    const fake = fakeContext();
    const stream = createPcmStream(fake.context);
    stream.playing = true;
    appendPcm(stream, new Uint8Array(3840));
    fake.context.currentTime = 2;
    appendPcm(stream, new Uint8Array(960));
    expect(stream.rebuffering).toBe(true);
    expect(pcmPosition(stream)).toBeCloseTo(0.08);
    fake.context.currentTime = 4;
    expect(pcmPosition(stream)).toBeCloseTo(0.08);
    stopPcm(stream);
});
