import type { AudioFormat, ActiveAudioStream, DoneBufferEntry, PcmAudioStream, PendingRequest, PocketTtsSettings, TimingInfo, VoiceInfo, WsClientPayload } from './types.js';
export { PocketTtsProvider };
declare class PocketTtsProvider {
    settings: PocketTtsSettings;
    ready: boolean;
    voices: VoiceInfo[];
    separator: string;
    static EXPECTED_SERVER_VERSION: string;
    audioElement: HTMLAudioElement;
    _worker: Worker | null;
    _workerReady: boolean;
    _wsPending: PendingRequest[];
    _doneBuffer: Map<string, DoneBufferEntry>;
    static MAX_DONE_BUFFER: number;
    _audioChunks: Uint8Array[];
    _cancelledIds: Set<string>;
    _sendQueue: WsClientPayload[];
    _nextReqId: number;
    lastTiming: TimingInfo;
    _previewUrl: string | null;
    _pcmContext: AudioContext | null;
    static MAX_RETRIES: number;
    static RETRY_DELAYS: number[];
    static MODEL_OPTIONS: {
        value: string;
        label: string;
    }[];
    defaultSettings: {
        provider_endpoint: string;
        voice: string;
        format: AudioFormat;
        streamingFormat: "auto";
        speed: number;
        temperature: number;
        top_p: number;
        model: string;
        voiceMap: {};
    };
    get settingsHtml(): string;
    _updateStatus(connected: any, fatal?: boolean): void;
    _updateServerInfo(info: any): void;
    onSettingsChange(): void;
    _initWorker(): void;
    _closeWorker(): void;
    resetSession(reason?: string): void;
    loadSettings(settings: any): Promise<void>;
    checkReady(): Promise<boolean>;
    onRefreshClick(): Promise<void>;
    _loadVoices(): Promise<VoiceInfo[]>;
    _loadModels(): Promise<void>;
    getVoice(voiceName: any): Promise<VoiceInfo>;
    fetchTtsVoiceObjects(): Promise<VoiceInfo[]>;
    _refreshStreamingFormatOptions(autoSelect?: boolean): Promise<{
        format: AudioFormat;
        mime: string;
        label: string;
    }[]>;
    _updateStreamingInfo(message?: string): void;
    processText(text: any): Promise<any>;
    /**
     * Generate TTS audio. Yields one Promise<Blob> per text part.
     *
     * WHY this design: text goes into a send queue that ensures ordering
     * (sequential IDs = text order). The queue sends to the worker one at
     * a time, but does NOT wait for the response — fire-and-forget. The
     * server processes sequentially and sends audio back when ready.
     * Audio is received independently and matched to promises by request_id.
     *
     * The queue exists for ORDERING, not for waiting. All text from all
     * messages goes through this single queue, ensuring correct text order
     * regardless of which message it came from.
     */
    generateTts(text: any, voiceId: any): AsyncGenerator<any, void, unknown>;
    _canStreamCurrentFormat(): boolean;
    _getStreamFormat(): AudioFormat;
    _getStreamMimeType(): string;
    _getStreamCandidate(): {
        format: AudioFormat;
        mime: string;
        label: string;
    } | null;
    _detectStreamingCandidates(): Array<{
        format: AudioFormat;
        mime: string;
        label: string;
    }>;
    _unlockPcm: () => void;
    _createPcmStream(sampleRate?: number, channels?: number): PcmAudioStream;
    _appendPcmChunk(stream: PcmAudioStream, bytes: Uint8Array): void;
    _startPcmStream(stream: PcmAudioStream): void;
    _finishPcmStream(stream: PcmAudioStream): void;
    _stopPcmStream(stream: PcmAudioStream): void;
    /**
     * Send queued requests to worker in order.
     * Fire-and-forget: sends all queued items, doesn't wait for responses.
     * Called after each generateTts push and after each done/error received.
     */
    _flushSendQueue(): void;
    /**
     * Send text.done to signal end of generation.
     * Server flushes merge queue and sends session_ended when complete.
     */
    sendTextDone(): void;
    _createStream(mimeType?: string): ActiveAudioStream | null;
    _appendStreamChunk(stream: ActiveAudioStream, data: Uint8Array): void;
    _finishStream(stream: ActiveAudioStream): void;
    /**
     * Retry a failed request. Resets pending state and re-sends with backoff.
     * Returns true if retry was scheduled, false if max retries reached.
     * Fix #3: Guard against duplicate retries by checking retryScheduled flag.
     */
    _retryRequest(pending: PendingRequest, reason: string, retryAfter?: number): boolean;
    _onWorkerMessage(event: any): void;
    _getWsUrl(): string;
    _getMimeType(): "audio/wav" | "audio/opus" | "audio/webm" | "audio/flac" | "audio/aac" | "audio/mpeg";
    _previewAbort: boolean;
    _previewStream: PcmAudioStream | null;
    previewTtsVoice(voiceId: any): Promise<void>;
    dispose(): void;
}
