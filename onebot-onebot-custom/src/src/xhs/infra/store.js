import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../errors.js';
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = v => createHash('sha256').update(typeof v === 'string' ? v : stable(v)).digest('hex');
export class Store {
  constructor(root, { quotaBytes = 512 * 1024 ** 2, ttlMs = 86400000 } = {}) {
    this.root = root; this.quotaBytes = quotaBytes; this.ttlMs = ttlMs;
    const path = join(root, 'state.db');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('unsafe_data_directory');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, terminal TEXT, searches INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, request TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, request TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (id TEXT PRIMARY KEY, request TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, request TEXT NOT NULL, file TEXT NOT NULL UNIQUE, data TEXT NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, operation TEXT NOT NULL, params TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, owner TEXT, lease INTEGER, pid INTEGER);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,created);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, job TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  lock(key, ttl = 100000) {
    const owner = randomUUID(), now = Date.now();
    this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM locks WHERE key=?').get(key);
      if (old && alive(old.pid)) fail('crawler_busy');
      this.db.prepare('INSERT OR REPLACE INTO locks VALUES(?,?,?,?)').run(key, owner, process.pid, now + ttl);
    });
    return () => this.db.prepare('DELETE FROM locks WHERE key=? AND owner=?').run(key, owner);
  }
  request(key) {
    const now = Date.now();
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
      // Caller-issued IDs are never silently reset during their lifetime.
      if (r && r.expires <= now) fail('request_expired');
      if (!r) this.db.prepare('INSERT INTO requests(key,expires) VALUES(?,?)').run(key, now + this.ttlMs);
      return r ?? { key, expires: now + this.ttlMs, terminal: null, searches: 0 };
    });
  }
  terminal(request) { return this.db.prepare('SELECT terminal FROM requests WHERE key=?').get(request)?.terminal; }
  stop(request, code) { this.db.prepare("UPDATE requests SET terminal=CASE WHEN terminal='authorization_revoked' THEN terminal ELSE ? END WHERE key=?").run(code, request); }
  searchAttempt(request, max) {
    const r = this.db.prepare('UPDATE requests SET searches=searches+1 WHERE key=? AND searches<?').run(request, max);
    if (!r.changes) fail('search_request_budget');
  }
  cacheGet(request, name, params) { const r = this.db.prepare('SELECT data FROM cache WHERE key=? AND expires>?').get(digest([request, name, params]), Date.now()); return r ? JSON.parse(r.data) : null; }
  cachePut(request, name, params, data) { this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?,?)').run(digest([request, name, params]), request, JSON.stringify(data), Date.now() + this.ttlMs); }
  putCursor(request, kind, data) {
    const id = 'cur-' + randomUUID();
    this.db.prepare('INSERT INTO cursors VALUES(?,?,?,?,?)').run(id, request, kind, JSON.stringify(data), Date.now() + this.ttlMs);
    return id;
  }
  getCursor(request, id, kind) {
    if (typeof id !== 'string' || !id.startsWith('cur-')) fail('invalid_cursor');
    const row = this.db.prepare('SELECT data FROM cursors WHERE id=? AND request=? AND kind=? AND expires>?').get(id, request, kind, Date.now());
    if (!row) fail('invalid_cursor');
    return JSON.parse(row.data);
  }
  candidate(request, data) {
    const id = 'img-' + digest([request, data.post.post_id, data.media_index, data.url]).slice(0, 40);
    this.db.prepare('INSERT OR IGNORE INTO candidates VALUES(?,?,?,?)').run(id, request, JSON.stringify(data), Date.now() + this.ttlMs); return id;
  }
  getCandidate(request, id) { const r = this.db.prepare('SELECT data FROM candidates WHERE id=? AND request=? AND expires>?').get(id, request, Date.now()); if (!r) fail('candidate_unavailable'); return JSON.parse(r.data); }
  reserve(bytes) {
    const id = randomUUID(), now = Date.now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM reservations WHERE expires<=?').run(now);
      const used = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM artifacts').get().n;
      const pending = this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM reservations').get().n;
      if (used + pending + bytes > this.quotaBytes) fail('media_cache_full');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(id, bytes, now + 180000);
    });
    return () => this.db.prepare('DELETE FROM reservations WHERE id=?').run(id);
  }
  saveArtifact(request, id, file, data) { this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)').run(id, request, file, JSON.stringify(data), data.bytes, Date.now() + this.ttlMs, 0); }
  artifact(request, id) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=? AND request=? AND expires>?').get(id, request, Date.now());
    if (!row) fail('artifact_unavailable'); return { ...row, metadata: JSON.parse(row.data) };
  }
  enqueue(request, operation, params) {
    const dedupe = digest([request, operation, params]), now = Date.now();
    return this.transaction(() => {
      let row = this.db.prepare('SELECT * FROM jobs WHERE dedupe=?').get(dedupe);
      if (!row) {
        const id = 'job-' + randomUUID();
        this.db.prepare("INSERT INTO jobs(id,request,dedupe,operation,params,state,created,expires) VALUES(?,?,?,?,?,'queued',?,?)").run(id, request, dedupe, operation, JSON.stringify(params), now, now + this.ttlMs);
        row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      }
      return this.publicJob(row);
    });
  }
  publicJob(row) { return { job_id: row.id, state: row.state, operation: row.operation, result: row.result ? JSON.parse(row.result) : null, error: row.error ? JSON.parse(row.error) : null, created_at: new Date(row.created).toISOString(), expires_at: new Date(row.expires).toISOString() }; }
  job(request, id) { const r = this.db.prepare('SELECT * FROM jobs WHERE id=? AND request=? AND expires>?').get(id, request, Date.now()); if (!r) fail('job_unavailable'); return this.publicJob(r); }
  cancel(request, id) {
    this.job(request, id);
    this.db.prepare("UPDATE jobs SET state='cancelled',error=? WHERE id=? AND request=? AND state IN ('queued','running')").run(JSON.stringify({ code: 'cancelled' }), id, request); return this.job(request, id);
  }
  claim(owner) {
    return this.transaction(() => {
      const now = Date.now();
      for (const r of this.db.prepare("SELECT id,pid,lease FROM jobs WHERE state='running'").all()) {
        if (!alive(r.pid) || r.lease < now) this.db.prepare("UPDATE jobs SET state='queued',owner=NULL WHERE id=?").run(r.id);
      }
      this.db.prepare("UPDATE jobs SET state='expired' WHERE expires<=? AND state='queued'").run(now);
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND expires>? ORDER BY created,id LIMIT 1").get(now);
      if (!row) return null;
      const claimOwner = `${owner}:${randomUUID()}`;
      this.db.prepare("UPDATE jobs SET state='running',owner=?,lease=?,pid=? WHERE id=?").run(claimOwner, now + 30000, process.pid, row.id);
      return { ...row, owner: claimOwner, params: JSON.parse(row.params) };
    });
  }
  jobActive(id, owner) { const r = this.db.prepare('SELECT state,owner FROM jobs WHERE id=?').get(id); return r?.state === 'running' && r.owner === owner; }
  heartbeat(id, owner) { this.db.prepare("UPDATE jobs SET lease=? WHERE id=? AND owner=? AND state='running'").run(Date.now() + 30000, id, owner); }
  finish(row, state, result, error) {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE jobs SET state=?,result=?,error=? WHERE id=? AND owner=? AND state='running'").run(state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, row.id, row.owner).changes;
      if (changed) this.db.prepare('INSERT INTO events(type,job,request,data,created) VALUES(?,?,?,?,?)').run('job_finished', row.id, row.request, JSON.stringify({ job_id: row.id, state }), Date.now());
      return changed;
    });
  }
  close() { this.db.close(); }
}
function alive(pid) { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
