import { onebotPath } from "./paths.js";
import { helperAgent } from "./workspaces/routes.js";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_DIRECTORY = onebotPath("state", "image-diagnostics");
const DIAGNOSTIC_LINE = /^(?:image_[a-z_]+|reference_(?:generate|reverify|plan)[a-z_]*|visual_verification[a-z_]*|prompt_optimizer_[a-z_]+|image_count|image_model|b64_present)=/u;

export function redactImageDiagnostic(value, limit = 8192) {
    return String(value ?? "")
        .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/giu, "[IMAGE DATA REDACTED]")
        .replace(/\bsk-[a-z0-9_-]+/giu, "[KEY REDACTED]")
        .replace(/\bBearer\s+[^\s"',;]+/giu, "Bearer [REDACTED]")
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu, "$1[REDACTED]")
        .replace(/https?:\/\/[^\s"'<>]+/giu, (raw) => {
            try {
                const url = new URL(raw);
                url.username = "";
                url.password = "";
                url.search = "";
                url.hash = "";
                return url.toString();
            }
            catch { return "[URL REDACTED]"; }
        })
        .replace(/[A-Za-z0-9+/=_-]{256,}/gu, "[LONG DATA REDACTED]")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
        .slice(0, limit);
}

function scriptOutput(value) {
    // The script also prints complete prompts and may print image data. Only
    // recognized status lines belong in persistent diagnostics.
    return String(value ?? "").split(/\r?\n/u)
        .filter((line) => DIAGNOSTIC_LINE.test(line))
        .map((line) => redactImageDiagnostic(line, 4096)).join("\n").slice(-16384);
}

export function imageErrorDetails(error) {
    const message = String(error?.message ?? error ?? "unknown error");
    const commandError = message.startsWith("Command failed:");
    return {
        name: redactImageDiagnostic(error?.name ?? "Error", 128),
        code: error?.code ?? null,
        signal: error?.signal ?? null,
        killed: error?.killed === true,
        // execFile's message repeats the complete command, including the user's
        // prompt. stdout/stderr below carry the useful, filtered diagnostics.
        message: commandError ? "image script exited unsuccessfully" : redactImageDiagnostic(message, 2048),
        stdout: scriptOutput(error?.stdout),
        stderr: scriptOutput(error?.stderr),
    };
}

export function createImageDiagnostics({ logger, accountId, workflow, workspaceAgentId, directory = DEFAULT_DIRECTORY }) {
    const id = randomUUID();
    const started = Date.now();
    const path = join(directory, `${id}.jsonl`);
    let currentStage = "generate";
    const record = async (event, extra = {}) => {
        const data = { time: new Date().toISOString(), id, accountId, workflow, event,
            stage: currentStage, elapsedMs: Date.now() - started, ...extra };
        const json = JSON.stringify(data);
        logger?.[event === "failed" ? "error" : "info"]?.(`[onebot:image] ${json}`);
        try {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);
            await appendFile(path, `${json}\n`, { mode: 0o600 });
            await chmod(path, 0o600);
        }
        catch (error) {
            // A logging/disk failure must never trigger a second generation or
            // hide the original error.
            logger?.warn?.(`[onebot:image] id=${id} diagnostic_write_failed=${redactImageDiagnostic(error?.code ?? "unknown", 128)}`);
        }
    };
    return {
        id, path,
        async stage(name, extra = {}) {
            currentStage = name;
            await record("stage", extra);
        },
        async runScript(execute, file, args, options) {
            await record("started", { timeoutMs: options.timeout, diagnosticsPath: path });
            const result = await execute(file, args, {
                ...options,
                env: { ...process.env, ...options.env, AGY_IMAGE_TRACE_ID: id, ...(workspaceAgentId ? { ONEBOT_IMAGE_HELPER_AGENT_ID: helperAgent(workspaceAgentId, "rewrite") } : {}) },
            });
            await record("script_completed", { stdout: scriptOutput(result.stdout), stderr: scriptOutput(result.stderr) });
            return result;
        },
        async fail(error) { await record("failed", { error: imageErrorDetails(error), diagnosticsPath: path }); },
        async complete() { await record("completed"); },
    };
}
