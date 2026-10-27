import { onebotPath } from '../paths.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

// Business operations and producer indexes only. OpenClaw owns transport retries.
export class OperationStore {
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
            state TEXT NOT NULL, input TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS approvals(operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, decision TEXT NOT NULL, expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, operation_id TEXT,
            request TEXT NOT NULL, state TEXT NOT NULL, native_id TEXT, receipt TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS artifacts(hash TEXT PRIMARY KEY, path TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS delivery_parts(delivery_id TEXT NOT NULL, part_index INTEGER NOT NULL, message_id TEXT NOT NULL, accepted INTEGER NOT NULL,
            PRIMARY KEY(delivery_id,part_index));
          CREATE TABLE IF NOT EXISTS dependencies(delivery_id TEXT NOT NULL, approval_id TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(delivery_id,approval_id));
          CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL, owner TEXT NOT NULL,
            request_id TEXT NOT NULL, due INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
            delivery_id TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state,due);
          CREATE UNIQUE INDEX IF NOT EXISTS reminders_source ON reminders(peer,owner,request_id);`);
    }
    transaction(run) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = run(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    begin(kind, input, id = randomUUID()) {
        const fingerprint = digest({ kind, input });
        const now = Date.now();
        this.db.prepare('INSERT OR IGNORE INTO operations VALUES(?,?,?,?,?,NULL,?,?)').run(id, fingerprint, kind, 'pending', canonical(input), now, now);
        const row = this.get(id);
        if (row.fingerprint !== fingerprint) throw new Error('operation identity conflict');
        return row;
    }
    get(id) { return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id); }
    state(id, state, result) {
        return this.transaction(() => {
            this.db.prepare('UPDATE operations SET state=?,result=?,updated=? WHERE id=?').run(state, result === undefined ? null : canonical(result), Date.now(), id);
            this.db.prepare('INSERT INTO events(operation_id,state,at) VALUES(?,?,?)').run(id, state, Date.now());
        });
    }
    approve(id, fingerprint, decision, expires = Date.now() + 600000) {
        if (this.get(id)?.fingerprint !== fingerprint) throw new Error('approval argument mismatch');
        this.db.prepare('INSERT OR REPLACE INTO approvals VALUES(?,?,?,?)').run(id, fingerprint, decision, expires);
    }
    consumeApproval(id, fingerprint) {
        return this.transaction(() => {
            const row = this.db.prepare('SELECT * FROM approvals WHERE operation_id=?').get(id);
            if (!row || row.fingerprint !== fingerprint || row.decision !== 'allow-once' || row.expires < Date.now()) return false;
            this.db.prepare('DELETE FROM approvals WHERE operation_id=?').run(id);
            return true;
        });
    }
    close() { this.db.close(); }
}
let singleton;
export function operationStore() {
    return singleton ??= new OperationStore(process.env.ONEBOT_OPERATIONS_DB || onebotPath('state/business/operations.sqlite'));
}
