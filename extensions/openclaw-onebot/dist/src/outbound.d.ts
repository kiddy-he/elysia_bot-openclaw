import type { ResolvedOneBotAccount, OneBotApiResponse } from './types.js';
export interface OutboundContext {
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
    account: ResolvedOneBotAccount;
    /** Internal flag used while releasing a result held by the approval barrier. */
    bypassApprovalBarrier?: boolean;
}
export interface OutboundResult {
    channel: string;
    messageId?: string;
    timestamp?: string | number;
    error?: string;
}
export type OneBotReactionResult = {
    channel: 'onebot';
    messageId: string | number;
    emojiId: string | number;
    ok: boolean;
    error?: string;
};
export declare function sendText(ctx: OutboundContext): Promise<OutboundResult>;
export declare function startApprovalBarrier(sessionKey: string): void;
export declare function expectApprovalResult(sessionKey: string, approvalId: string, fallback?: {
    to: string;
    account: unknown;
    text: string;
    rewritePersona?: boolean;
}): void;
export declare function sendImage(account: ResolvedOneBotAccount, targetType: 'private' | 'group', targetId: number, filePath: string): Promise<OneBotApiResponse>;
export declare function sendRecord(account: ResolvedOneBotAccount, targetType: 'private' | 'group', targetId: number, filePath: string): Promise<OneBotApiResponse>;
export declare function uploadFile(account: ResolvedOneBotAccount, targetType: 'private' | 'group', targetId: number, filePath: string, fileName: string): Promise<OneBotApiResponse>;
export declare function reactToMessage(account: ResolvedOneBotAccount, messageId: string | number, emojiId: string | number): Promise<OneBotReactionResult>;
export declare function toOneBotPlainText(text: string): string;
