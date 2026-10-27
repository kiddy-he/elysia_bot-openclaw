import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { onebotPath } from '../paths.js';

/** Enumerate keys only. Group-wide controls never read participants' transcripts. */
export function groupStreamKeys(baseKey, accountId, { activeKeys = [], databasePath } = {}) {
    if (!/^agent:[^:]+:onebot:group:[1-9][0-9]{4,19}:role:[^:]+:mode:(normal|nsfw)$/u.test(baseKey)
        || !/^[A-Za-z0-9_-]{1,64}$/u.test(String(accountId ?? ''))) throw new Error('invalid group stream scope');
    const prefix = `${baseKey}:account:${accountId}:sender:`;
    const belongs = key => key === baseKey || (String(key).startsWith(prefix) && /^[1-9][0-9]{4,19}$/u.test(key.slice(prefix.length)));
    const keys = new Set(activeKeys.filter(belongs));
    const agentId = baseKey.split(':')[1];
    const path = databasePath ?? onebotPath('agents', agentId, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(path)) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            for (const { session_key } of db.prepare('SELECT session_key FROM session_nodes WHERE session_key=? OR substr(session_key,1,?)=?').all(baseKey, prefix.length, prefix))
                if (belongs(session_key)) keys.add(session_key);
        } finally { db.close(); }
    }
    return [...keys];
}

/** One mutable execution per stream; unrelated participant streams never wait. */
export function createStreamLanes() {
    const tails = new Map();
    return {
        async acquire(key) {
            const previous = tails.get(key) ?? Promise.resolve();
            let done;
            const current = new Promise(resolve => { done = resolve; });
            tails.set(key, current);
            await previous;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (tails.get(key) === current) tails.delete(key);
                done();
            };
        },
        keys: () => [...tails.keys()],
    };
}
