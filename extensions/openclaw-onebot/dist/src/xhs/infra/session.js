import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './files.js';
import { fail } from '../errors.js';
import { ROD_LOGIN_USER_AGENT } from '../browser/profile.js';
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function validCookie(name, value) {
  return /^[A-Za-z0-9_-]{1,80}$/u.test(name) && typeof value === 'string' && !/[;\r\n\u0000-\u001f\u007f]/u.test(value) && value.length <= 8192;
}
function browserCookies(values) {
  if (!Array.isArray(values) || values.length > 500) fail('session_invalid');
  return values.map(c => {
    if (!isObject(c) || !validCookie(c.name, c.value) || typeof c.domain !== 'string' ||
        !/^\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(c.domain) ||
        typeof c.path !== 'string' || !c.path.startsWith('/') || /[\u0000-\u0020\u007f]/u.test(c.path) ||
        c.expires !== undefined && (!Number.isFinite(c.expires) || c.expires < -1) ||
        c.sameSite !== undefined && c.sameSite !== '' && !['Strict', 'Lax', 'None'].includes(c.sameSite)) fail('session_invalid');
    return { name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires > 0 ? c.expires : -1, httpOnly: c.httpOnly === true,
      secure: c.secure === true, sameSite: c.sameSite || 'Lax' };
  });
}
export function cookiesForUrl(session, value, now = Date.now()) {
  if (!session.storageState) return { ...session.cookies };
  const url = new URL(value), result = {};
  const matches = session.storageState.cookies.filter(c => {
    const domain = c.domain.replace(/^\./u, '');
    const hostMatches = url.hostname === domain || c.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`);
    const pathMatches = url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`);
    return hostMatches && pathMatches && (!c.secure || url.protocol === 'https:') && (c.expires < 0 || c.expires * 1000 > now);
  }).sort((a, b) => b.path.length - a.path.length);
  for (const c of matches) if (!Object.hasOwn(result, c.name)) result[c.name] = c.value;
  return result;
}
export function sessionFromBrowser(storageState, extra = {}) {
  const state = { ...storageState, cookies: browserCookies(storageState.cookies) };
  return { storageState: state, cookies: cookiesForUrl({ storageState: state }, 'https://edith.xiaohongshu.com/'),
    ...extra, b1: typeof extra.b1 === 'string' && extra.b1.trim() ? extra.b1 : undefined };
}
export class SessionStore {
  constructor(root) { this.path = join(root, 'session.json'); }
  async load({ optional = false } = {}) {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024 || info.mode & 0o077) fail('session_invalid');
      const raw = JSON.parse(await readFile(this.path, 'utf8')); return this.validate(raw);
    } catch (e) { if (e.code === 'ENOENT' && optional) return null; if (e.code === 'ENOENT') fail('login_required'); fail('session_invalid'); }
  }
  validate(raw) {
    // Original Go files are accepted only when explicitly supplied by the operator.
    if (Array.isArray(raw)) raw = sessionFromBrowser({ cookies: raw, origins: [] }, { userAgent: ROD_LOGIN_USER_AGENT });
    if (!isObject(raw) || !isObject(raw.cookies) || typeof raw.userAgent !== 'string' || !raw.userAgent || /[\r\n]/u.test(raw.userAgent) || raw.userAgent.length > 1024) fail('session_invalid');
    if (Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024 || raw.b1 !== undefined && (typeof raw.b1 !== 'string' || !raw.b1.trim() || raw.b1.length > 16000)) fail('session_invalid');
    for (const [name, value] of Object.entries(raw.cookies)) {
      if (!validCookie(name, value)) fail('session_invalid');
    }
    let storageState;
    if (raw.storageState !== undefined) {
      if (!isObject(raw.storageState) || !Array.isArray(raw.storageState.origins)) fail('session_invalid');
      storageState = { cookies: browserCookies(raw.storageState.cookies), origins: raw.storageState.origins.map(origin => {
        if (!isObject(origin) || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)) fail('session_invalid');
        let url; try { url = new URL(origin.origin); } catch { fail('session_invalid'); }
        if (url.protocol !== 'https:' || url.origin !== origin.origin) fail('session_invalid');
        if (origin.localStorage.some(v => !isObject(v) || typeof v.name !== 'string' || typeof v.value !== 'string')) fail('session_invalid');
        return { origin: origin.origin, localStorage: origin.localStorage.map(({ name, value }) => ({ name, value })) };
      }) };
      const scoped = cookiesForUrl({ storageState }, 'https://edith.xiaohongshu.com/');
      for (const [name, value] of Object.entries(scoped)) if (Object.hasOwn(raw.cookies, name) && raw.cookies[name] !== value) fail('session_invalid');
    }
    return { version: 1, cookies: raw.cookies, userAgent: raw.userAgent, b1: raw.b1, webSsk: raw.webSsk, storageState, updated_at: raw.updated_at ?? new Date().toISOString() };
  }
  async save(raw, options) { const data = this.validate(raw); await atomicJson(this.path, data, options); return { configured: true, updated_at: data.updated_at }; }
}
