import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { onebotPath } from '../paths.js';
import { redactImageDiagnostic } from '../image-diagnostics.js';

const REASONS = new Set(['generation_failed', 'generation_timeout', 'output_validation_failed', 'missing_resources', 'busy', 'invalid_text']);

/** Wrapper stdout is diagnostic data. Keep it local; never return paths to QQ. */
export async function recordSpeechFailure(error, operationId, { root = onebotPath('state/tts') } = {}) {
    let wrapper;
    try { wrapper = JSON.parse(String(error.stdout ?? '').trim()); } catch { /* no valid wrapper reply */ }
    const reason = REASONS.has(wrapper?.reason) ? wrapper.reason
        : error.code === 'ABORT_ERR' ? 'cancelled' : error.killed ? 'timeout' : 'execution_failed';
    const report = { operationId, occurredAt: new Date().toISOString(), reason,
        exitCode: typeof error.code === 'number' ? error.code : undefined, signal: error.signal ?? undefined,
        stage: 'execution', diagnostic: '' };
    // Only inspect logs under this wrapper's private output tree. A model or
    // unrelated subprocess cannot turn diagnostic collection into a file read.
    try {
        const allowed = await realpath(join(root, 'elysia'));
        const path = await realpath(String(wrapper?.log ?? ''));
        if (path.startsWith(allowed + sep)) {
            const handle = await open(path, 'r');
            try {
                const size = (await handle.stat()).size, bytes = Buffer.alloc(Math.min(size, 12000));
                await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
                const text = bytes.toString('utf8');
                const trace = text.lastIndexOf('Traceback (most recent call last):');
                report.diagnostic = redactImageDiagnostic(trace >= 0 ? text.slice(trace) : text.slice(-2000), 6000);
                report.stage = text.includes('pitch_audio.py') ? 'postprocess_pitch'
                    : text.includes('elysia_light.py') ? 'postprocess' : 'synthesis';
                report.log = path;
            } finally { await handle.close(); }
        }
    } catch { /* missing diagnostics must not replace the original failure */ }
    try {
        const directory = join(root, 'errors');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // Operation ids are server-generated digests, not user-chosen paths.
        if (/^[a-f0-9]{64}$/u.test(operationId))
            await writeFile(join(directory, `${operationId}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    } catch { /* local logging failure cannot authorize a retry */ }
    return { reason, stage: report.stage };
}
