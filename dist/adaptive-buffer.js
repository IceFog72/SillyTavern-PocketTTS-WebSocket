/** Seconds of queued audio needed before starting or recovering playback. */
export class AdaptiveBuffer {
    target = 0.06;
    underruns = 0;
    lastArrival;
    previousDuration = 0;
    jitter = 0;
    arrive(now, duration) {
        if (this.lastArrival !== undefined) {
            const gap = Math.max(0, now - this.lastArrival - this.previousDuration);
            this.jitter = 0.2 * gap + 0.8 * this.jitter;
            this.target = Math.max(0.06, Math.min(0.6, this.target * 0.98));
            this.target = Math.max(this.target, Math.min(0.6, this.jitter * 2 + 0.04));
        }
        this.lastArrival = now;
        this.previousDuration = duration;
    }
    underrun() {
        this.underruns++;
        this.target = Math.min(0.6, Math.max(this.target * 1.5, this.target + 0.04));
    }
}
//# sourceMappingURL=adaptive-buffer.js.map