import { existsSync } from "node:fs";
export function resolveLocalVoicePath(url) {
    const localPath = url.replace(/^file:\/\//, "");
    return existsSync(localPath) ? localPath : null;
}
