export interface VoiceInfo {
    name: string;
    voice_id: string;
    lang?: string;
}

export interface PocketTtsSettings {
    provider_endpoint: string;
    voice: string;
    format: AudioFormat;
    speed: number;
    temperature: number;
    top_p: number;
    model: string;
    voiceMap: Record<string, string>;
}

export type AudioFormat = 'mp3' | 'wav' | 'opus' | 'flac' | 'aac';

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
    promise: Promise<Blob | null> & {
        _resolve: (value: Blob | null) => void;
        _reject: (reason?: unknown) => void;
    };
    chunks: Uint8Array[];
    retryCount: number;
    payload: WsTextAppendPayload | null;
    retryScheduled: boolean;
    timeout?: ReturnType<typeof setTimeout>;
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
}

export type WsClientPayload = WsTextAppendPayload | { type: 'text.done' };
