export interface VoiceLog {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
}
export declare const VOICE_TMP_DIR: string;
export declare function isSilkFormat(buf: Buffer): boolean;
export declare function isAmrFormat(buf: Buffer): boolean;
export declare function resolveVoiceContentType(filePath: string): string;
