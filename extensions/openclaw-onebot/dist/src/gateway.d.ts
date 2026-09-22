import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount, OneBotMessageSegment } from "./types.js";
import { getOneBotRuntime } from "./runtime.js";
export { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3, downloadVoiceFile, ensureVoiceTmpDir, isAmrFormat, isSilkFormat, processVoiceSegments, } from "./voice.js";
export interface GatewayContext {
    account: ResolvedOneBotAccount;
    abortSignal: AbortSignal;
    cfg: OpenClawConfig;
    onReady?: (data: unknown) => void;
    onError?: (error: Error) => void;
    log?: {
        info: (msg: string) => void;
        error: (msg: string) => void;
        debug?: (msg: string) => void;
    };
}
export declare function extractText(segments: OneBotMessageSegment[]): string;
export declare function extractImages(segments: OneBotMessageSegment[]): string[];
export declare function extractRecordSegments(segments: OneBotMessageSegment[]): OneBotMessageSegment[];
export declare function resolveInboundCommandAuthorization(params: {
    pluginRuntime: ReturnType<typeof getOneBotRuntime>;
    cfg: OpenClawConfig;
    allowFrom?: string[];
    peerId: string;
}): boolean;
export declare function startGateway(ctx: GatewayContext): Promise<void>;
