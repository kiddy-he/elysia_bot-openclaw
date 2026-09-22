import { readFile } from "node:fs/promises";
import { isAmrFormat, isSilkFormat, resolveVoiceContentType } from "./voice-common.js";
import { convertAmrToMp3, convertSilkToMp3 } from "./voice-convert.js";
export async function inspectVoiceFile(filePath, log) {
    try {
        const buf = await readFile(filePath);
        const hexHead = buf.subarray(0, 16).toString("hex");
        log?.info(`[voice] file=${filePath} size=${buf.length} hex=${hexHead} isSilk=${isSilkFormat(buf)} isAmr=${isAmrFormat(buf)}`);
        if (isSilkFormat(buf)) {
            const mp3 = await convertSilkToMp3(filePath, log);
            return mp3 ? { path: mp3, contentType: "audio/mpeg" } : null;
        }
        if (isAmrFormat(buf)) {
            const mp3 = await convertAmrToMp3(filePath, log);
            return mp3 ? { path: mp3, contentType: "audio/mpeg" } : null;
        }
        return { path: filePath, contentType: resolveVoiceContentType(filePath) };
    }
    catch (err) {
        log?.error(`Voice processing error: ${err}`);
        return null;
    }
}
