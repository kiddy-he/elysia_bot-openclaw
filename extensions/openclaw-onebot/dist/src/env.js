import { homedir } from "node:os";
import { join } from "node:path";
export function getDefaultSharedDir() {
    return process.env.ONEBOT_SHARED_DIR ?? join(homedir(), "napcat", "shared");
}
export function getDefaultContainerSharedDir() {
    return process.env.ONEBOT_CONTAINER_SHARED_DIR ?? "/shared";
}
export function withVoiceToolPath(command) {
    return `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ${command}`;
}
