import { type VoiceLog } from "./voice-common.js";
export declare function ensureVoiceTmpDir(): Promise<void>;
export declare function downloadVoiceFile(url: string, log?: VoiceLog): Promise<string | null>;
