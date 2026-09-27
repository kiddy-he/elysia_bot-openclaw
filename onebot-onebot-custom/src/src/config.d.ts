import type { ResolvedOneBotAccount, OneBotAccountConfig } from "./types.js";
interface OpenClawConfig {
    channels?: {
        onebot?: OneBotChannelConfig;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
interface OneBotChannelConfig extends OneBotAccountConfig {
    accounts?: Record<string, OneBotAccountConfig>;
}
/**
 * List all configured OneBot account IDs.
 */
export declare function listOneBotAccountIds(cfg: OpenClawConfig): string[];
/**
 * Resolve a OneBot account from config.
 */
export declare function resolveOneBotAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedOneBotAccount;
/**
 * Apply account configuration changes.
 */
export declare function applyOneBotAccountConfig(cfg: OpenClawConfig, accountId: string, input: {
    wsUrl?: string;
    httpUrl?: string;
    accessToken?: string;
    sharedDir?: string;
    containerSharedDir?: string;
    name?: string;
}): OpenClawConfig;
export {};
