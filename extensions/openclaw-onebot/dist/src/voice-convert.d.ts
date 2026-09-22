import type { VoiceLog } from "./voice-common.js";
export declare function convertSilkToMp3(silkPath: string, log?: VoiceLog): Promise<string | null>;
export declare function convertAmrToMp3(amrPath: string, log?: VoiceLog): Promise<string | null>;
export declare function cleanupVoiceFiles(paths: string[]): void;
