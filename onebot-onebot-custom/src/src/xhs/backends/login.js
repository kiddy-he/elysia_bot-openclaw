import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CryptoConfig, createWebSskExchange, extractEncryptedSsk } from '@ikenxuan/xhshow-ts';
import { createGuestIdentity } from './identity.js';
import { applyLoginSession } from '../infra/cookies.js';
import { atomicFile, atomicJson } from '../infra/files.js';
import { loginQrPng } from '../domain/qr.js';
import { checkAbort, fail, safeError } from '../errors.js';
import { PendingLoginStore, PENDING_LOGIN_TTL_MS, validateLoginQr } from '../infra/pending-login.js';

export const LOGIN_APIS = Object.freeze({
  activate: '/api/sns/web/v1/login/activate', create: '/api/sns/web/v1/login/qrcode/create',
  poll: '/api/qrcode/userinfo', confirm: '/api/sns/web/v1/login/qrcode/status', me: '/api/sns/web/v2/user/me',
});
export function authenticatedUser(data) {
  return data?.guest === false && typeof (data.user_id ?? data.userId) === 'string' && !!(data.user_id ?? data.userId);
}
export class HttpLogin {
  constructor(client, { timeoutMs = 240000, pollMs = 2000, identityFactory = createGuestIdentity,
    exchangeFactory = createWebSskExchange, sleep = delay, qrEncoder = loginQrPng } = {}) {
    Object.assign(this, { client, timeoutMs, pollMs, identityFactory, exchangeFactory, sleep, qrEncoder });
  }
  async login({ signal, onProgress = () => {}, beforeCommit } = {}) {
    const root = dirname(this.client.sessions.path), events = [], pendingStore = new PendingLoginStore(root);
    let pending;
    let count = 0, failure = null, failureStatus = null;
    const record = (phase, detail = {}) => events.push({ phase, ...detail, at: new Date().toISOString() });
    const call = async (path, body, session, options = {}) => {
      checkAbort(signal); if (++count > 180) fail('api_request_budget');
      record('request', { path, method: options.method ?? 'POST' });
      return this.client.api(path, body, signal, { session, allowGuest: true, onRequestTrace: detail => record('request_prepared', detail), ...options });
    };
    const accept = (session, data, exchange) => {
      applyLoginSession(session, data);
      const encrypted = extractEncryptedSsk(data);
      if (encrypted) {
        try { session.webSsk = { 'xhs-pc-web': exchange.acceptEncryptedSsk(encrypted) }; }
        catch { fail('session_key_exchange_failed'); }
      }
    };
    try {
      const existing = await this.client.sessions.load({ optional: true });
      if (existing) {
        try {
          const me = await call(LOGIN_APIS.me, undefined, existing, { method: 'GET' });
          if (authenticatedUser(me)) {
            await pendingStore.clear();
            return { configured: true, authenticated: true, backend: 'http', verification: 'api_user_me' };
          }
        } catch (error) { if (error.code !== 'login_required') throw error; }
      }
      pending = await pendingStore.load();
      const resumed = !!pending;
      const session = pending?.session ?? this.identityFactory(), config = new CryptoConfig().forUserAgent(session.userAgent);
      if (!pending) {
        const activationExchange = this.exchangeFactory(config.SSK_SERVER_PUBLIC_KEY);
        const activation = await call(LOGIN_APIS.activate, { client_public_key_base64: activationExchange.clientPublicKeyBase64 }, session);
        accept(session, activation, activationExchange); record('guest_activated');
        const qr = validateLoginQr(await call(LOGIN_APIS.create, { qr_type: 1 }, session));
        const now = Date.now();
        pending = { version: 1, qr, session, created_at: now, expires_at: now + PENDING_LOGIN_TTL_MS, confirmed: false };
        checkAbort(signal); await pendingStore.save(pending, { beforeCommit });
      } else record('pending_resumed');
      const { qr } = pending;
      const commit = async () => {
        const me = await call(LOGIN_APIS.me, undefined, session, { method: 'GET' });
        if (!authenticatedUser(me)) fail('login_confirmation_unverified');
        checkAbort(signal); await this.client.sessions.save(session, { beforeCommit });
        await pendingStore.clear(); record('authenticated');
        return { configured: true, authenticated: true, backend: 'http', verification: 'api_user_me' };
      };
      if (pending.confirmed) return await commit();
      const path = join(root, 'login-qr.png'); await atomicFile(path, await this.qrEncoder(qr.url)); checkAbort(signal);
      const deadline = Math.min(Date.now() + this.timeoutMs, pending.expires_at); let scanned = false;
      onProgress({ event: 'login_qr', path, expires_seconds: Math.ceil((deadline - Date.now()) / 1000), backend: 'http', resumed });
      record('qr_saved');
      while (Date.now() < deadline) {
        const poll = await call(LOGIN_APIS.poll, { qrId: qr.qr_id, code: qr.code }, session);
        record('poll', { code_status: poll?.codeStatus ?? null });
        if (poll?.codeStatus === 3) fail('login_qr_expired');
        if (![0, 1, 2].includes(poll?.codeStatus)) fail('invalid_login_response');
        if (poll.codeStatus === 1 && !scanned) { scanned = true; onProgress({ event: 'login_scanned', backend: 'http' }); }
        if (poll.codeStatus === 2) {
          record('qr_confirmed', { geo_zone: Number.isInteger(poll.geoZone) ? poll.geoZone : null, geo_zone_type: typeof poll.geoZone });
          // Frontend chunk 1884 module 57653: 0 = xiaohongshu.com;
          // 1/2 = rednote.com. Country strings are not protocol geoZone values.
          if ([1, 2].includes(poll.geoZone)) fail('login_region_unsupported');
          if (poll.geoZone !== undefined && poll.geoZone !== 0) fail('invalid_login_region');
          applyLoginSession(session, poll.result);
          // The shipped Login bundle only calls the final GET for a same-region
          // geoZone. With no geoZone it directly verifies the resulting session.
          if (poll.geoZone !== undefined) {
            const exchange = this.exchangeFactory(config.SSK_SERVER_PUBLIC_KEY);
            const confirmed = await call(LOGIN_APIS.confirm, { qr_id: qr.qr_id, code: qr.code,
              client_public_key_base64: exchange.clientPublicKeyBase64 }, session,
            { method: 'GET', extraHeaders: { 'x-login-mode': '' } });
            accept(session, confirmed, exchange);
          }
          pending.confirmed = true;
          checkAbort(signal); await pendingStore.save(pending, { beforeCommit });
          return await commit();
        }
        await this.sleep(Math.min(this.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
      fail('login_timeout');
    } catch (error) {
      failure = signal?.aborted ? 'cancelled' : safeError(error).code;
      failureStatus = Number.isInteger(error.details?.status) ? error.details.status : null;
      record('failure', { code: failure, http_status: failureStatus });
      // A local timeout or an interrupted connection can be resumed with the
      // same identity. Site refusals, expiry and explicit cancellation stop it.
      if (pending && !['login_timeout', 'deadline_exceeded', 'api_request_failed', 'invalid_login_region', 'internal_error'].includes(failure)) await pendingStore.clear();
      checkAbort(signal); throw error;
    }
    finally { await atomicJson(join(root, 'http-login-trace.json'), { events, api_requests: count, error: failure, http_status: failureStatus,
      finished_at: new Date().toISOString() }).catch(() => {}); }
  }
}
