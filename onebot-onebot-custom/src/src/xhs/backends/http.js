import https from 'node:https';
import { CryptoConfig, SessionManager } from '@ikenxuan/xhshow-ts';
import { randomInt, createHash } from 'node:crypto';
import { resolvePublic, PublicDownloader } from '../infra/network.js';
import { isShortUrl, noteTarget, canonicalUrl, publicUrl } from '../domain/urls.js';
import { parseNoteHtml } from '../domain/html.js';
import { apiNote, apiSearchRows, apiProfile, apiPosted, apiComments } from '../domain/api.js';
import { cookiesForUrl } from '../infra/session.js';
import { mergeSetCookies } from '../infra/cookies.js';
import { HttpLogin, authenticatedUser } from './login.js';
import { businessErrorCode } from '../domain/protocol.js';
import { fail, checkAbort, signalFor, XhsError } from '../errors.js';
import { ApiSigner } from './signing.js';
import { apiRequestTarget } from './request-target.js';
const ORIGIN = 'https://edith.xiaohongshu.com';
export class HttpBackend {
  constructor({ sessionStore, downloader = new PublicDownloader(), lookup, transport, signerFactory, loginOptions } = {}) {
    this.sessions = sessionStore; this.downloader = downloader; this.lookup = lookup; this.transport = transport ?? https.request;
    this.signerFactory = signerFactory ?? (session => {
      const config = new CryptoConfig().forUserAgent(session.userAgent);
      return { signer: new ApiSigner(config), state: new SessionManager(config, { webSsk: session.webSsk }) };
    });
    this.identity = null; this.signing = null;
    this.loginWorkflow = new HttpLogin(this, loginOptions);
  }
  async api(path, body, signal, { method = 'POST', session: suppliedSession, allowGuest = false, extraHeaders = {}, onRequestTrace } = {}) {
    if (!/^\/api\/[A-Za-z0-9_/-]+$/u.test(path) || !['GET', 'POST'].includes(method)) fail('invalid_api_path');
    const session = suppliedSession ?? await this.sessions.load();
    const u = new URL(method === 'GET' ? apiRequestTarget(path, body) : path, ORIGIN);
    const scopedCookies = cookiesForUrl(session, u.href);
    if (!scopedCookies.a1 || !allowGuest && !scopedCookies.web_session) fail('login_required');
    const identity = JSON.stringify([scopedCookies, session.b1, session.webSsk, session.userAgent]);
    if (identity !== this.identity) { this.signing = this.signerFactory(session); this.identity = identity; }
    const useRap = ['/api/sns/web/v1/search/notes', '/api/sns/web/v1/feed'].includes(path);
    const signerMethod = method === 'GET' ? 'signHeadersGet' : 'signHeadersPost';
    const generated = this.signing.signer[signerMethod](path, scopedCookies, 'xhs-pc-web', body, undefined, this.signing.state, 'xys', undefined, useRap);
    const headers = Object.fromEntries(Object.entries(generated).filter(([name]) => ['x-s', 'x-s-common', 'x-t', 'x-b3-traceid', 'x-xray-traceid', 'x-rap-param'].includes(name.toLowerCase())));
    if (Object.keys(extraHeaders).some(name => name !== 'x-login-mode') || Object.values(extraHeaders).some(v => !['', 'qrcode'].includes(v))) fail('invalid_request');
    const payload = method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined;
    if (onRequestTrace) {
      let signingMatchesTransport = null;
      if (method === 'GET' && typeof this.signing.signer.decodeXs === 'function') {
        try { signingMatchesTransport = this.signing.signer.decodeXs(headers['x-s']).x5 === createHash('md5').update(u.pathname + u.search).digest('hex'); } catch {}
      }
      onRequestTrace({ path, method, query_keys: [...u.searchParams.keys()], signing_matches_transport: signingMatchesTransport });
    }
    const addresses = await resolvePublic(u.hostname, this.lookup);
    signal = signalFor(signal, 25000); checkAbort(signal);
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        const req = this.transport({ protocol: 'https:', hostname: addresses[0].address, family: addresses[0].family, port: 443, servername: u.hostname, path: u.pathname + u.search, method, signal, agent: false,
          headers: { ...headers, ...extraHeaders, Host: u.host, 'User-Agent': session.userAgent, Origin: 'https://www.xiaohongshu.com', Referer: 'https://www.xiaohongshu.com/', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en', ...(payload === undefined ? {} : { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(payload) }), 'Accept-Encoding': 'identity', Cookie: Object.entries(scopedCookies).map(([k, v]) => `${k}=${v}`).join('; ') },
        }, resolve); req.on('error', reject); req.end(payload);
      });
      if (response.statusCode !== 200) {
        const code = response.statusCode; response.destroy();
        fail(code === 429 ? 'rate_limited' : [461, 471, 406].includes(code) ? 'challenge_required' : [401, 403].includes(code) ? 'permission_denied' : 'upstream_http_error', { status: code });
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail('encoded_response_denied');
      const chunks = []; let bytes = 0;
      for await (const chunk of response) { checkAbort(signal); bytes += chunk.length; if (bytes > 2 * 1024 ** 2) { response.destroy(); fail('response_size'); } chunks.push(chunk); }
      let data; try { data = JSON.parse(Buffer.concat(chunks)); } catch { fail('invalid_response'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_response');
      if (data.success !== true || data.code !== 0) {
        // Never auto-retry account refusal or rotate transport on a gate.
        const code = data.code;
        fail(businessErrorCode(code), { upstream_code: Number.isFinite(code) ? code : null });
      }
      if (response.headers['set-cookie']) {
        mergeSetCookies(session, response.headers['set-cookie'], u.href);
        checkAbort(signal); if (!suppliedSession) await this.sessions.save(session);
      }
      return data.data;
    } catch (e) { response?.destroy(); checkAbort(signal); if (e instanceof XhsError) throw e; fail('api_request_failed'); }
  }
  async search(params, { signal } = {}) {
    const searchId = ((BigInt(Date.now()) << 64n) + BigInt(randomInt(1, 2147483647))).toString(36);
    const body = { keyword: params.query, page: 1, page_size: 20, search_id: searchId, sort: params.sort === 'latest' ? 'time_descending' : 'general', note_type: params.media_type === 'image' ? 2 : params.media_type === 'video' ? 1 : 0, ext_flags: [], image_formats: ['jpg', 'webp', 'avif'] };
    const data = await this.api('/api/sns/web/v1/search/notes', body, signal);
    return apiSearchRows(data);
  }
  async comments(params, { signal } = {}) {
    const body = { noteId: params.note_id, cursor: params.cursor ?? '', topCommentId: params.top_comment_id ?? '', ...(params.parent_comment_id ? { rootCommentId: params.parent_comment_id } : {}), num: params.limit ?? 20, imageFormats: 'jpg,webp,avif', xsecToken: params.xsec_token ?? '' };
    const data = await this.api(params.parent_comment_id ? '/api/sns/web/v2/comment/sub/page' : '/api/sns/web/v2/comment/page', body, signal, { method: 'GET' });
    return apiComments(data);
  }
  async profile(userId, { signal } = {}) {
    const data = await this.api('/api/sns/web/v1/user/otherinfo', { target_user_id: userId }, signal, { method: 'GET' });
    return apiProfile(data, userId);
  }
  async userPosted(params, { signal } = {}) {
    const data = await this.api('/api/sns/web/v1/user_posted', { user_id: params.user_id, cursor: params.cursor ?? '', num: params.limit ?? 20 }, signal, { method: 'GET' });
    return apiPosted(data);
  }
  async resolve(source, signal) {
    if (isShortUrl(source)) source = await this.downloader.resolveNote(source, { signal });
    const { id, token } = noteTarget(source); return canonicalUrl(id, token);
  }
  async inspect(source, { signal } = {}) {
    source = await this.resolve(source, signal);
    const session = await this.sessions.load({ optional: true });
    if (session) {
      const { id, token } = noteTarget(source);
      const data = await this.api('/api/sns/web/v1/feed', { source_note_id: id, image_formats: ['jpg', 'webp', 'avif'], extra: { need_body_topic: '1' }, xsec_source: 'pc_feed', xsec_token: token }, signal);
      const item = data?.items?.find(v => (v.id ?? v.note_card?.note_id) === id);
      if (!item?.note_card) fail('note_unavailable');
      return { source_url: source, note: apiNote(item.note_card) };
    }
    let response = await this.downloader.get(source, { signal, follow: u => u.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) });
    try { return { source_url: source, note: parseNoteHtml(response.body.toString('utf8'), source) }; } catch (e) {
      if (e.code !== 'note_state_unavailable') throw e;
      const mobile = new URL(source); mobile.pathname = mobile.pathname.replace('/explore/', '/discovery/item/');
      response = await this.downloader.get(mobile.href, { signal, follow: u => u.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) });
      return { source_url: source, note: parseNoteHtml(response.body.toString('utf8'), source) };
    }
  }
  async status({ signal } = {}) {
    const session = await this.sessions.load({ optional: true });
    if (!session) return { configured: false, authenticated: false, backend: 'http', verification: 'no_session', login_method: 'qrcode_or_import' };
    const scoped = cookiesForUrl(session, ORIGIN + '/');
    if (!scoped.a1 || !scoped.web_session) return { configured: true, authenticated: false, backend: 'http', verification: 'incomplete_session', login_method: 'qrcode_or_import' };
    try {
      const data = await this.api('/api/sns/web/v2/user/me', undefined, signal, { method: 'GET', session });
      return { configured: true, authenticated: authenticatedUser(data), backend: 'http', verification: 'api_user_me', login_method: 'qrcode_or_import' };
    } catch (error) { if (error.code !== 'login_required') throw error; return { configured: true, authenticated: false, backend: 'http', verification: 'api_user_me', login_method: 'qrcode_or_import' }; }
  }
  async login(options) { return this.loginWorkflow.login(options); }
  async close() {}
}
export { apiNote } from '../domain/api.js';
