export declare const GUEST_IMAGE_INTERVAL_MS: number;
export declare const GUEST_IMAGE_PROMPT_MAX_CHARS: number;
export declare function extractGuestImagePrompt(text: string): string | null;
export declare function guestImageCooldownRemaining(lastUsedAt: number | undefined, now?: number): number;
