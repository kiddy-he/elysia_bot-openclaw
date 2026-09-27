import { isAmrFormat, isSilkFormat } from "./voice-common.js";
import { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3 } from "./voice-convert.js";
import { downloadVoiceFile, ensureVoiceTmpDir } from "./voice-download.js";
import { inspectVoiceFile } from "./voice-inspect.js";
import { resolveLocalVoicePath } from "./voice-local.js";
export { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3, downloadVoiceFile, ensureVoiceTmpDir, isAmrFormat, isSilkFormat, };
export async function processVoiceSegments(segments, log) {
    const results = [];
    for (const seg of segments) {
        const url = String(seg.data.url ?? seg.data.file ?? "");
        log?.info(`[voice] segment data: url=${seg.data.url}, file=${seg.data.file}, resolved=${url.slice(0, 200)}`);
        if (!url)
            continue;
        const filePath = url.startsWith("http")
            ? await downloadVoiceFile(url, log)
            : resolveLocalVoicePath(url);
        if (!filePath)
            continue;
        const inspected = await inspectVoiceFile(filePath, log);
        if (inspected) {
            results.push(inspected);
        }
    }
    return results;
}
