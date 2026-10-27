import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { onebotRoot } from './paths.js';

// Read only the current session identity, never message contents. Bind it before
// stopping the primary turn so a later reset cannot redirect the delivery mirror.
export function captureMediaTranscriptTarget({ agentId, sessionKey }, { root = onebotRoot } = {}) {
    if (!/^[a-z0-9_-]+$/u.test(agentId ?? '') || !sessionKey) return null;
    const storePath = join(root, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
    let db;
    try {
        db = new DatabaseSync(storePath, { readOnly: true });
        const row = db.prepare('SELECT current_session_id FROM session_nodes WHERE session_key=?').get(sessionKey);
        return row?.current_session_id ? { agentId, sessionKey, sessionId: row.current_session_id, storePath } : null;
    } catch { return null; }
    finally { db?.close(); }
}
export async function mirrorMediaCompletion({ target, text, idempotencyKey, config }, {
    append = async input => (await import('openclaw/plugin-sdk/session-transcript-runtime')).appendAssistantMirrorMessageByIdentity(input),
} = {}) {
    if (!target?.sessionId || !text?.trim() || !idempotencyKey) return false;
    try {
        // The SDK owns locking, exact session-id validation, deduplication and
        // transcript cache updates. Never write transcript SQL from the plugin.
        return (await append({ ...target, text, idempotencyKey, config }))?.ok === true;
    } catch { return false; }
}
