import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fail } from '../errors.js';

const WIDTH = 1280, HEIGHT = 800;
export function loginPublicOrigin(value) {
  if (value === undefined) return undefined;
  let url; try { url = new URL(value); } catch { fail('invalid_interaction_origin'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value ||
      url.username || url.password || !url.hostname || /[\s\\]/u.test(value)) fail('invalid_interaction_origin');
  return url.origin;
}
const STATES = new Set(['starting', 'waiting_for_scan', 'waiting_for_verification', 'waiting_for_login', 'authenticated', 'failed', 'expired', 'cancelled']);
const TERMINAL = new Set(['authenticated', 'failed', 'expired', 'cancelled']);
const KEYS = new Set(['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Control+A', 'Meta+A', 'Space']);
const assets = new Map([
  ['view', ['text/html; charset=utf-8', new URL('./view.html', import.meta.url)]],
  ['view.js', ['text/javascript; charset=utf-8', new URL('./view.js', import.meta.url)]],
]);

function validateEvents(value) {
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.events) || !value.events.length || value.events.length > 64) fail('invalid_input');
  for (const event of value.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('invalid_input');
    const allowed = { move: ['type', 'x', 'y'], down: ['type'], up: ['type'], wheel: ['type', 'deltaX', 'deltaY'], key: ['type', 'key'], text: ['type', 'text'] }[event.type];
    if (!Array.isArray(allowed) || Object.keys(event).some(k => !allowed.includes(k))) fail('invalid_input');
    if (event.type === 'move' && (!Number.isFinite(event.x) || !Number.isFinite(event.y) || event.x < 0 || event.x >= WIDTH || event.y < 0 || event.y >= HEIGHT)) fail('invalid_input');
    if (event.type === 'wheel' && (![event.deltaX, event.deltaY].every(Number.isFinite) || Math.abs(event.deltaX) > 2000 || Math.abs(event.deltaY) > 2000)) fail('invalid_input');
    if (event.type === 'key' && !KEYS.has(event.key)) fail('invalid_input');
    if (event.type === 'text' && (typeof event.text !== 'string' || !event.text.length || event.text.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(event.text))) fail('invalid_input');
  }
  return value.events;
}

// Transfers pixels and human input for one existing page. No DOM, script,
// navigation, cookies or CDP endpoints are exposed to the remote operator.
export async function createLoginInteraction({ page, port = 0, timeoutMs = 285000, publicOrigin: suppliedOrigin, verificationMode = false, cancel = () => {}, closeGraceMs = 1500 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) fail('invalid_interaction_options');
  const publicOrigin = loginPublicOrigin(suppliedOrigin), publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;
  const loginId = randomUUID(), secret = randomBytes(32).toString('hex'), expected = Buffer.from(`Bearer ${secret}`);
  const prefix = `/login/${loginId}/`, expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  let confirmation = false;
  let status = 'starting', error, closing = false, closePromise, frameTask, frameAt = 0, frame, inputTask = Promise.resolve(), queued = 0, eventCount = 0;
  const snapshot = () => ({ loginId, status, mode:verificationMode?'verification':'login', verificationRequired: status === 'waiting_for_verification', expiresAt, ...(error ? { error: { code: error } } : {}) });
  const setStatus = (next, code) => {
    if (!STATES.has(next) || TERMINAL.has(status)) return;
    status = next; error = code;
  };
  const reply = (res, code, value, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    try {
      const actualPort = server.address()?.port;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, ...(publicHost ? [publicHost] : [])].includes(req.headers.host)) return reply(res, 403, { error: { code: 'invalid_host' } });
      const origin = publicHost && req.headers.host === publicHost ? publicOrigin : `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: { code: 'invalid_origin' } });
      if (!req.url?.startsWith(prefix) || req.url.includes('?')) return reply(res, 404, { error: { code: 'not_found' } });
      const action = req.url.slice(prefix.length), asset = assets.get(action);
      if (req.method === 'GET' && asset) return reply(res, 200, await readFile(asset[1]), asset[0]);
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(res, 401, { error: { code: 'unauthorized' } });
      if (req.method === 'GET' && action === 'status') return reply(res, 200, snapshot());
      if (TERMINAL.has(status) || closing) return reply(res, 410, snapshot());
      if (req.method === 'GET' && action === 'frame') {
        if (!frameTask && (!frame || Date.now() - frameAt >= 250)) {
          frameTask = page.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 }).then(bytes => { frame = bytes; frameAt = Date.now(); return bytes; }).finally(() => { frameTask = undefined; });
        }
        const bytes = await (frameTask ?? frame);
        if (bytes.length > 2 * 1024 * 1024) fail('response_size');
        return reply(res, 200, bytes, 'image/jpeg');
      }
      if (req.method !== 'POST' || !['input', 'cancel', ...(verificationMode ? ['complete'] : [])].includes(action)) return reply(res, 404, { error: { code: 'not_found' } });
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return reply(res, 403, { error: { code: 'invalid_origin' } });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return reply(res, 413, { error: { code: 'request_size' } }); }
      if (action === 'cancel') { setStatus('cancelled', 'cancelled'); cancel('cancelled'); return reply(res, 200, snapshot()); }
      if (action === 'complete') { if (body !== '{}') return reply(res,400,{error:{code:'invalid_input'}}); confirmation=true; return reply(res,200,{accepted:true}); }
      let value; try { value = JSON.parse(body); } catch { fail('invalid_input'); }
      const events = validateEvents(value);
      if (queued >= 4 || eventCount + events.length > 60000) return reply(res, 429, { error: { code: 'input_budget' } });
      queued++; eventCount += events.length;
      const task = inputTask.then(async () => {
        if (TERMINAL.has(status) || closing) fail('interaction_closed');
        for (const event of events) {
          if (TERMINAL.has(status) || closing) fail('interaction_closed');
          if (event.type === 'move') await page.mouse.move(event.x, event.y);
          else if (event.type === 'down') await page.mouse.down({ button: 'left' });
          else if (event.type === 'up') await page.mouse.up({ button: 'left' });
          else if (event.type === 'wheel') await page.mouse.wheel(event.deltaX, event.deltaY);
          else if (event.type === 'key') await page.keyboard.press(event.key);
          else await page.keyboard.insertText(event.text);
        }
      });
      inputTask = task.catch(() => {});
      try { await task; reply(res, 200, { accepted: true }); } finally { queued--; }
    } catch (e) { if (!res.headersSent && !res.destroyed) reply(res, e.code === 'invalid_input' ? 400 : 503, { error: { code: e.code === 'invalid_input' ? 'invalid_input' : 'interaction_unavailable' } }); }
  });
  server.maxConnections = 12;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { setStatus('expired', 'login_timeout'); cancel('login_timeout'); }, timeoutMs); timer.unref();
  return {
    loginId, expiresAt, url: `${publicOrigin ?? `http://127.0.0.1:${server.address().port}`}${prefix}view#token=${secret}`,
    snapshot, setStatus, takeConfirmation() { const value=confirmation; confirmation=false; return value; },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearTimeout(timer);
      if (!TERMINAL.has(status)) setStatus('failed', 'interaction_closed');
      closePromise = new Promise(resolve => {
        setTimeout(() => { server.close(resolve); server.closeAllConnections(); frame = undefined; }, closeGraceMs);
      });
      return closePromise;
    },
  };
}
