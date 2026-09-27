import type { OneBotMessageSegment } from "./types.js";
import { isAmrFormat, isSilkFormat, type VoiceLog } from "./voice-common.js";
import { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3 } from "./voice-convert.js";
import { downloadVoiceFile, ensureVoiceTmpDir } from "./voice-download.js";
export { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3, downloadVoiceFile, ensureVoiceTmpDir, isAmrFormat, isSilkFormat, };
export type { VoiceLog };
export declare function processVoiceSegments(segments: OneBotMessageSegment[], log?: VoiceLog): Promise<{
    path: string;
    contentType: string;
}[]>;
