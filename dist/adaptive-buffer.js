
export class AdaptiveBuffer {
    target = 2;

    minTarget = 1;
    maxTarget = 5;

    underruns = 0;
    stableChunks = 0;

    // Call when audio arrives.
    arrive() {
        this.stableChunks++;

        // Gradually reduce buffering after stable arrivals.
        if (this.stableChunks >= 5) {
            this.target = Math.max(
                this.minTarget,
                this.target - 0.015
            );

            this.stableChunks = 0;
        }
    }

    // Call ONLY when playback actually runs out of audio.
    underrun() {
        this.underruns++;
        this.stableChunks = 0;

        this.target = Math.min(
            this.maxTarget,
            this.target + 0.1
        );
    }

    startupThreshold() {
        return 0.1;
    }

    reset() {
        this.target = 0.2;
        this.underruns = 0;
        this.stableChunks = 0;
    }
}
