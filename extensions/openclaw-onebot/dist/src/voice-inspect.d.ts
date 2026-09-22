import { type VoiceLog } from "./voice-common.js";
export declare function inspectVoiceFile(filePath: string, log?: VoiceLog): Promise<{
    path: string;
    contentType: string;
} | null>;
