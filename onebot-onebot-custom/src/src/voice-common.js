import { tmpdir } from "node:os";
import { join } from "node:path";
export const VOICE_TMP_DIR = join(tmpdir(), "openclaw-onebot-voice");
export function isSilkFormat(buf) {
    // SILK files: optional 0x02 prefix byte, then "#!SILK"
    const h = buf.toString("utf-8", 0, 10);
    return h.includes("#!SILK");
}
export function isAmrFormat(buf) {
    const h = buf.toString("utf-8", 0, 6);
    return h.startsWith("#!AMR");
}
export function resolveVoiceContentType(filePath) {
    if (filePath.endsWith(".mp3"))
        return "audio/mpeg";
    if (filePath.endsWith(".wav"))
        return "audio/wav";
    if (filePath.endsWith(".amr"))
        return "audio/amr";
    return "audio/ogg";
}
