export const event_types: Record<string, string>;
export const eventSource: {
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
};
