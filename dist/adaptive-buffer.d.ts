/** Seconds of queued audio needed before starting or recovering playback. */
export declare class AdaptiveBuffer {
    target: number;
    underruns: number;
    private lastArrival;
    private previousDuration;
    private jitter;
    arrive(now: number, duration: number): void;
    underrun(): void;
}
