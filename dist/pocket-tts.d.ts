import type { AudioFormat, DoneBufferEntry, PendingRequest, PocketTtsSettings, TimingInfo, VoiceInfo, WsClientPayload } from './types.js';
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
    /**
     * Retry a failed request. Resets pending state and re-sends with backoff.
     * Returns true if retry was scheduled, false if max retries reached.
     * Fix #3: Guard against duplicate retries by checking retryScheduled flag.
     */
    _retryRequest(pending: any, reason: any): boolean;
    _onWorkerMessage(event: any): void;
    _getWsUrl(): string;
    _getMimeType(): "audio/wav" | "audio/opus" | "audio/flac" | "audio/aac" | "audio/mpeg";
    _previewAbort: boolean;
    previewTtsVoice(voiceId: any): Promise<void>;
    dispose(): void;
}
