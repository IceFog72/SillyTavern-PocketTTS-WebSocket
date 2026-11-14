import { AdaptiveBuffer } from './adaptive-buffer.js';
export function createPcmStream(context, sampleRate = 24000) {
    const output = context.createGain();
    output.connect(context.destination);
    return { output, history: [], totalSamples: 0, position: 0, anchorTime: 0, playbackRate: 1, context, sampleRate, channels: 1, nextTime: 0, started: false,
        playing: false, closed: false, resumeFade: false, queue: [], scheduledChunks: 0,
        buffer: new AdaptiveBuffer(), sources: new Set(), pendingByte: null,
        rebuffering: true, stopped: false, startupThreshold: 3, recoveryThreshold: 2, pendingPcm: [], pendingSamples: 0, chunkSamples: Math.round(sampleRate * 0.25)};
}
export function appendPcm(stream, input) {
    if (stream.closed || stream.stopped)
        return;
    let bytes = input;
    if (stream.pendingByte !== null) {
        bytes = new Uint8Array(input.length + 1);
        bytes[0] = stream.pendingByte;
        bytes.set(input, 1);
        stream.pendingByte = null;
    }
    if (bytes.length % 2) {
        stream.pendingByte = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length) {
        stream.buffer.arrive(performance.now() / 1000, bytes.length / (stream.sampleRate * 2));
        stream.history.push(bytes);
        stream.totalSamples += bytes.length / 2;


        stream.pendingPcm.push(bytes);
        stream.pendingSamples += bytes.length / 2;

        if (stream.pendingSamples >= stream.chunkSamples) {
            const combined = new Uint8Array(
                stream.pendingSamples * 2
            );

            let offset = 0;

            for (const chunk of stream.pendingPcm) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }

            stream.queue.push(combined);
            stream.pendingPcm = [];
            stream.pendingSamples = 0;
        }
    }
    pumpPcm(stream);
}
export function stopPcm(stream) {
    stream.stopped = true;
    stream.playing = false;
    stream.queue.length = 0;
    stream.history.length = 0;
    cancelSources(stream);
    stream.output.disconnect();
}

export function pumpPcm(stream) {
    if (!stream.playing || stream.stopped)
        return;

    clearTimeout(stream.endTimer);

    // Wait until the AudioContext is actually running.
    if (stream.context.state !== 'running') {
        void stream.context.resume().then(() => {
            if (!stream.stopped && stream.playing)
                pumpPcm(stream);
        }).catch(() => {});
        return;
    }

    const now = stream.context.currentTime;

    // Detect a genuine playback underrun.
    // Allow 25ms of scheduling tolerance.

    if (
        stream.started &&
        !stream.rebuffering &&
        !stream.closed &&
        stream.nextTime < now - 0.015
    ) {
        const elapsed = Math.max(
            0,
            stream.nextTime - stream.anchorTime
        ) * stream.playbackRate;

        stream.position = Math.min(
            pcmDuration(stream),
                                   stream.position + elapsed
        );

        stream.anchorTime = now;
        stream.nextTime = now;

        stream.buffer.underrun();
        stream.rebuffering = true;
        stream.resumeFade = true;
    }


    // Calculate audio waiting to be scheduled.
    const queuedSeconds = stream.queue.reduce(
        (total, bytes) => total + bytes.length,
                                              0
    ) / (stream.sampleRate * 2);

    // Separate startup and recovery thresholds.
    const startupThreshold = 3;
    const recoveryThreshold = 2;

    if (stream.rebuffering) {
        const threshold = stream.started
        ? recoveryThreshold
        : startupThreshold;

        // At end-of-stream, never wait for more audio.
        if (!stream.closed && queuedSeconds < threshold)
            return;

        // Nothing left to play.
        if (queuedSeconds === 0) {
            if (stream.closed && stream.onEnded) {
                stream.endTimer = setTimeout(() => {
                    if (!stream.stopped && stream.playing)
                        stream.onEnded?.();
                }, 20);
            }
            return;
        }

        stream.nextTime = Math.max(
            stream.nextTime,
            now + 0.04
        );

        stream.position = Math.max(
            0,
            pcmDuration(stream) - queuedSeconds
        );

        stream.anchorTime = stream.nextTime;
        stream.rebuffering = false;
    }

    // Schedule available audio.
    while (stream.queue.length) {
        const bytes = stream.queue.shift();
        const samples = bytes.length / 2;

        if (!samples)
            continue;

        const buffer = stream.context.createBuffer(
            1,
            samples,
            stream.sampleRate
        );

        const channel = buffer.getChannelData(0);
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength
        );

        for (let i = 0; i < samples; i++) {
            channel[i] = view.getInt16(i * 2, true) / 32768;
        }

        const source = stream.context.createBufferSource();
        const gain = stream.context.createGain();
        const startTime = Math.max(
            stream.nextTime,
        );

        source.buffer = buffer;
        source.connect(gain);
        gain.connect(stream.output);

        source.playbackRate.value = stream.playbackRate;

        gain.gain.setValueAtTime(1, startTime);

        if (!stream.started || stream.resumeFade) {
            gain.gain.setValueAtTime(0, startTime);

            gain.gain.linearRampToValueAtTime(
                1,
                startTime + Math.min(
                    0.005,
                    buffer.duration / 2
                )
            );

            stream.resumeFade = false;
        }

        stream.sources.add(source);

        source.onended = () => {
            stream.sources.delete(source);
            source.disconnect();
            gain.disconnect();
        };

        source.start(startTime);

        stream.nextTime =
            startTime + buffer.duration / stream.playbackRate;

        stream.scheduledChunks++;
        stream.started = true;
    }

    // Notify when the final scheduled audio finishes.
    if (stream.closed && stream.onEnded) {
        const delay = Math.max(
            0,
            stream.nextTime - stream.context.currentTime
        ) * 1000 + 20;

        stream.endTimer = setTimeout(() => {
            if (!stream.stopped && stream.playing)
                stream.onEnded?.();
        }, delay);
    }
}

export function pcmDuration(stream) {
    return stream.totalSamples / stream.sampleRate;
}
export function pcmPosition(stream) {
    const elapsed = stream.playing && stream.started && !stream.rebuffering ? Math.max(0, stream.context.currentTime - stream.anchorTime) * stream.playbackRate : 0;
    return Math.min(pcmDuration(stream), stream.position + elapsed);
}
function cancelSources(stream) {
    clearTimeout(stream.endTimer);
    for (const source of stream.sources) {
        try {
            source.stop();
        }
        catch { }
    }
    stream.sources.clear();
}
// Keep received samples until this track ends so seeking and rate changes can
// rebuild one schedule without duplicating samples still arriving over the wire.
export function seekPcm(stream, seconds) {
    if (stream.stopped || !Number.isFinite(seconds))
        return;
    const offset = Math.round(Math.max(0, Math.min(pcmDuration(stream), seconds)) * stream.sampleRate);
    cancelSources(stream);
    stream.position = offset / stream.sampleRate;
    stream.started = false;
    stream.rebuffering = true;
    stream.nextTime = 0;
    stream.queue = [];
    let skip = offset * 2;
    for (const bytes of stream.history) {
        if (skip >= bytes.length) {
            skip -= bytes.length;
            continue;
        }
        stream.queue.push(bytes.subarray(skip));
        skip = 0;
    }
    pumpPcm(stream);
}
export function pausePcm(stream) {
    const position = pcmPosition(stream);
    stream.playing = false;
    seekPcm(stream, position);
}
export function resumePcm(stream) {
    stream.playing = true;
    pumpPcm(stream);
}
export function setPcmRate(stream, rate) {
    if (!Number.isFinite(rate) || rate <= 0 || stream.playbackRate === rate)
        return;
    const position = pcmPosition(stream);
    stream.playbackRate = rate;
    seekPcm(stream, position);
}
export function setPcmVolume(stream, volume) {
    stream.output.gain.value = Math.max(0, Math.min(1, volume));
}
//# sourceMappingURL=pcm-playback.js.map
