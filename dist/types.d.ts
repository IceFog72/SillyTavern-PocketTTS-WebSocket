import type { AdaptiveBuffer } from "./adaptive-buffer.js";
export interface VoiceInfo {
    name: string;
    voice_id: string;
    lang?: string;
}
export interface PocketTtsSettings {
    provider_endpoint: string;
    voice: string;
    format: AudioFormat;
    streamingFormat: 'off' | 'auto';
    speed: number;
    temperature: number;
    top_p: number;
    model: string;
    voiceMap: Record<string, string>;
}
export type AudioFormat = 'mp3' | 'wav' | 'pcm' | 'opus' | 'webm' | 'flac' | 'aac';
export interface TtsTrack {
    trackId: number;
    url: string | null;
    duration: number;
    text: string;
    msgId: number;
    pending: boolean;
    error: string | null;
    isUser: boolean;
    charName: string;
    audioStream?: PcmAudioStream;
}
export interface PlaylistTrackView {
    text: string;
    playing: boolean;
    pending: boolean;
    error: string | null;
}
export interface PlaylistMessageView {
    msgId: number | null;
    tracks: PlaylistTrackView[];
    isPlaying: boolean;
}
export interface TimingInfo {
    audio_duration: number;
    gen_time: number;
}
export interface PendingRequest {
    id: string;
    promise: Promise<Blob | StreamedAudio | null> & {
        _resolve: (value: Blob | StreamedAudio | null) => void;
        _reject: (reason?: unknown) => void;
    };
    chunks: Uint8Array[];
    retryCount: number;
    payload: WsTextAppendPayload | null;
    retryScheduled: boolean;
    timeout?: ReturnType<typeof setTimeout>;
    done?: Promise<void> & {
        _resolve: () => void;
        _reject: (reason?: unknown) => void;
    };
    stream?: ActiveAudioStream;
    pcmStream?: PcmAudioStream;
    streamed?: boolean;
    streamResolved?: boolean;
}
export interface StreamedAudio {
    streamUrl: string;
    mimeType: string;
    audioStream?: PcmAudioStream;
    done?: Promise<void>;
}
export interface ActiveAudioStream {
    mediaSource: MediaSource;
    sourceBuffer: SourceBuffer | null;
    url: string;
    queue: Uint8Array[];
    opened: boolean;
    ended: boolean;
    playable: boolean;
    onPlayable?: () => void;
}
export interface PcmAudioStream {
    output: GainNode;
    history: Uint8Array[];
    totalSamples: number;
    position: number;
    anchorTime: number;
    playbackRate: number;
    buffer: AdaptiveBuffer;
    sources: Set<AudioBufferSourceNode>;
    pendingByte: number | null;
    rebuffering: boolean;
    stopped: boolean;
    context: AudioContext;
    sampleRate: number;
    channels: number;
    nextTime: number;
    started: boolean;
    playing: boolean;
    closed: boolean;
    resumeFade: boolean;
    queue: Uint8Array[];
    scheduledChunks: number;
    endTimer?: ReturnType<typeof setTimeout>;
    onEnded?: () => void;
}
export interface DoneBufferEntry {
    chunks: Uint8Array[];
    timing: TimingInfo;
    merged?: boolean;
}
export interface WsTextAppendPayload {
    type: 'text.append';
    request_id: string;
    text: string;
    voice: string;
    format: AudioFormat;
    speed: number;
    temperature: number;
    top_p: number;
    model: string;
    retry?: boolean;
    stream?: boolean;
}
export type WsClientPayload = WsTextAppendPayload | {
    type: 'text.done';
};
