import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { withVoiceToolPath } from "./env.js";
const execAsync = promisify(exec);
export async function convertSilkToMp3(silkPath, log) {
    const pcmPath = silkPath.replace(/\.[^.]+$/, ".pcm");
    const mp3Path = silkPath.replace(/\.[^.]+$/, ".mp3");
    try {
        // silk -> pcm via pilk
        await execAsync(withVoiceToolPath(`uv run --with pilk python3 -c "import pilk; pilk.decode('${silkPath}', '${pcmPath}')"`), { timeout: 15000 });
        // pcm -> mp3 (silk is typically 24000Hz mono 16-bit LE)
        await execAsync(withVoiceToolPath(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" "${mp3Path}"`), { timeout: 10000 });
        try {
            await unlink(pcmPath);
        }
        catch { /* ignore */ }
        if (existsSync(mp3Path)) {
            log?.info(`SILK -> mp3 OK: ${mp3Path}`);
            try {
                await unlink(silkPath);
            }
            catch { /* ignore */ }
            return mp3Path;
        }
        return null;
    }
    catch (err) {
        log?.error(`SILK conversion failed: ${err}`);
        try {
            await unlink(pcmPath);
        }
        catch { /* ignore */ }
        return null;
    }
}
export async function convertAmrToMp3(amrPath, log) {
    const mp3Path = amrPath.replace(/\.[^.]+$/, ".mp3");
    try {
        await execAsync(withVoiceToolPath(`ffmpeg -y -i "${amrPath}" -ar 16000 -ac 1 "${mp3Path}"`), { timeout: 10000 });
        if (existsSync(mp3Path)) {
            log?.info(`AMR -> mp3 OK: ${mp3Path}`);
            try {
                await unlink(amrPath);
            }
            catch { /* ignore */ }
            return mp3Path;
        }
        return null;
    }
    catch (err) {
        log?.error(`AMR conversion failed: ${err}`);
        return null;
    }
}
export function cleanupVoiceFiles(paths) {
    for (const p of paths) {
        unlink(p).catch(() => { });
    }
}
