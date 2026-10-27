import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from './session.js';
import { atomicJson } from './files.js';
import { fail } from '../errors.js';

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
export function validateLoginQr(qr) {
  if (!qr || typeof qr.qr_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(qr.qr_id) ||
      typeof qr.code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(qr.code) || typeof qr.url !== 'string' || qr.url.length > 4096) fail('login_qr_invalid');
  let url; try { url = new URL(qr.url); } catch { fail('login_qr_invalid'); }
  if (url.origin !== 'https://www.xiaohongshu.com' || url.username || url.password || url.pathname !== '/mobile/login' ||
      url.searchParams.getAll('qrId').length !== 1 || url.searchParams.getAll('xhs_code').length !== 1 ||
      url.searchParams.get('qrId') !== qr.qr_id || url.searchParams.get('xhs_code') !== qr.code) fail('login_qr_invalid');
  return { qr_id: qr.qr_id, code: qr.code, url: qr.url };
}
export class PendingLoginStore {
  constructor(root) { this.path = join(root, 'pending-login.json'); this.sessions = new SessionStore(root); }
  validate(value) {
    if (!value || value.version !== 1 || !Number.isFinite(value.created_at) || !Number.isFinite(value.expires_at) ||
        value.created_at > Date.now() + 1000 || value.expires_at <= value.created_at ||
        value.expires_at - value.created_at > PENDING_LOGIN_TTL_MS || typeof value.confirmed !== 'boolean') fail('pending_login_invalid');
    return { version: 1, created_at: value.created_at, expires_at: value.expires_at, confirmed: value.confirmed,
      qr: validateLoginQr(value.qr), session: this.sessions.validate(value.session) };
  }
  async load() {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > 256 * 1024 || info.mode & 0o077 ||
          typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('pending_login_invalid');
      const value = this.validate(JSON.parse(await file.readFile('utf8')));
      if (value.expires_at <= Date.now()) { await this.clear(); return null; }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('pending_login_invalid');
    } finally { await file?.close(); }
  }
  async save(value, options) { await atomicJson(this.path, this.validate(value), options); }
  async clear() { await unlink(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
