import type { PlaylistMessageView } from './types.js';
import type { PocketTtsProvider } from './pocket-tts.js';

declare module '*tts/index.js' {
    export function registerTtsProvider(name: string, provider: unknown): void;
    export function saveTtsProviderSettings(): void;
    export function getPreviewString(lang: string): string;
}

declare module '*script.js' {
    export const event_types: Record<string, string>;
    export const eventSource: {
        on(event: string, handler: (...args: any[]) => void): void;
        off(event: string, handler: (...args: any[]) => void): void;
    };
}

declare module '*extensions.js' {
    export const extension_settings: any;
}

declare global {
    const $: any;

    interface Window {
        SillyTavern?: any;
        extension_settings?: any;
        _pttsProvider?: PocketTtsProvider;
        _pttsAudio?: HTMLAudioElement;
        _pttsRefreshPlaylist?: () => void;
        _pttsGetPlaylist?: () => PlaylistMessageView[];
        _pttsNukePlaylist?: () => void;
        _pttsNukeMsgTracks?: (msgId: number | null) => void;
        _pttsSkipTrack?: () => void;
        _pttsHighlightToggle?: () => boolean;
        _pttsHighlightEnabled?: () => boolean;
        _pttsNarrateCaptureHandler?: EventListener;
        _pttsNarrateKeydownCaptureHandler?: EventListener;
    }

    interface HTMLMediaElement {
        _savedVol?: number;
    }

    interface Element {
        style: any;
        value: any;
        checked: any;
        disabled: any;
        max: any;
    }
}

export {};
