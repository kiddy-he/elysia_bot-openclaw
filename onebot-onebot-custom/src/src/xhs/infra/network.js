import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { unlink, open } from 'node:fs/promises';
import { publicUrl, isPublicAddress, siteBrowserUrl, isXhsHost } from '../domain/urls.js';
import { checkAbort, fail, signalFor, XhsError } from '../errors.js';
export async function resolvePublic(host, lookup = dnsLookup) {
  let answers; try { answers = await lookup(host, { all: true, verbatim: true }); } catch { fail('dns_failed'); }
  if (!answers.length || answers.some(a => !isPublicAddress(a.address))) fail('nonpublic_address');
  return answers;
}
function counter(max, onChunk) {
  let bytes = 0;
  return new Transform({ transform(chunk, _, done) {
    bytes += chunk.length;
    if (bytes > max) return done(new XhsError('download_size_limit'));
    try { onChunk(bytes, chunk.length); done(null, chunk); } catch (e) { done(e); }
  } });
}
export class PublicDownloader {
  constructor({ lookup = dnsLookup, request = null } = {}) { this.lookup = lookup; this.request = request; }
  async get(value, { signal, maxBytes = 2 * 1024 ** 2, timeoutMs = 30000, output, referer, follow = null, budget } = {}) {
    signal = signalFor(signal, timeoutMs); let url = publicUrl(value), result, ownedOutput = false;
    try {
      for (let hop = 0; hop < 5; hop++) {
        checkAbort(signal); budget?.request();
        const addresses = await resolvePublic(url.hostname.replace(/^\[|\]$/g, ''), this.lookup); checkAbort(signal);
        const headers = { Host: url.host, 'User-Agent': 'Mozilla/5.0 KomachiXhs/0.1', Accept: '*/*', 'Accept-Encoding': 'identity' };
        if (isXhsHost(url.hostname)) headers['User-Agent'] = url.pathname.startsWith('/discovery/item/')
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
        if (referer) headers.Referer = publicUrl(referer).origin + '/';
        const make = this.request ?? (url.protocol === 'https:' ? https.request : http.request);
        result = await new Promise((resolve, reject) => {
          const req = make({ protocol: url.protocol, hostname: addresses[0].address, family: addresses[0].family, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'GET', servername: url.hostname, headers, agent: false, signal }, resolve);
          req.on('error', reject); req.end();
        });
        if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
          const location = result.headers.location; result.destroy(); if (!location) fail('invalid_redirect');
          const next = publicUrl(new URL(location, url).href);
          if (follow && !follow(next)) fail('invalid_redirect');
          url = next; continue;
        }
        if (result.statusCode !== 200) { const status = result.statusCode; result.destroy(); fail(status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'permission_denied' : 'download_http_error', { status }); }
        if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') { result.destroy(); fail('encoded_response_denied'); }
        const declared = result.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) { result.destroy(); fail('download_size_limit'); }
        let bytes = 0;
        if (output) {
          const handle = await open(output, 'wx', 0o600); ownedOutput = true;
          try { await pipeline(result, counter(maxBytes, (n, delta) => { bytes = n; budget?.charge(delta); }), handle.createWriteStream(), { signal }); } finally { await handle.close().catch(() => {}); }
        } else {
          const chunks = [];
          for await (const chunk of result) { checkAbort(signal); bytes += chunk.length; budget?.charge(chunk.length); if (bytes > maxBytes) { result.destroy(); fail('download_size_limit'); } chunks.push(chunk); }
          result.body = Buffer.concat(chunks);
        }
        checkAbort(signal);
        if (declared !== undefined && bytes !== Number(declared)) fail('incomplete_download');
        return { url: url.href, bytes, body: output ? undefined : result.body, content_type: String(result.headers['content-type'] ?? '').split(';')[0] };
      }
      fail('redirect_limit');
    } catch (error) {
      result?.destroy(); if (ownedOutput) await unlink(output).catch(() => {});
      checkAbort(signal); if (error instanceof XhsError) throw error; fail('download_failed');
    }
  }
  async resolveNote(value, { signal } = {}) {
    const u = publicUrl(value);
    const allowed = u => ['xhslink.com', 'www.xhslink.com', 'www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) && u.protocol === 'https:';
    if (!allowed(u)) fail('invalid_target');
    const response = await this.get(u.href, { signal, follow: allowed }); return response.url;
  }
}
// The browser only reaches the site's allowlisted domains through public-IP pinned CONNECT tunnels.
// No direct-browser DNS lookup is relied on as an SSRF boundary.
export async function browserProxy({ signal, maxBytes = 32 * 1024 ** 2, lookup = dnsLookup, onFailure = () => {} } = {}) {
  const sockets = new Set(); let received = 0, stopped = false;
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  const close = () => { stopped = true; for (const socket of sockets) socket.destroy(); server.close(); };
  server.on('connect', async (req, client, head) => {
    sockets.add(client); client.on('error', () => {}); client.on('close', () => sockets.delete(client));
    try {
      const target = siteBrowserUrl(`https://${req.url}`);
      if (target.port || !req.url.endsWith(':443')) fail('browser_host_denied');
      const addresses = await resolvePublic(target.hostname, lookup);
      checkAbort(signal); if (stopped) return client.destroy();
      const upstream = net.connect({ host: addresses[0].address, port: 443, family: addresses[0].family });
      sockets.add(upstream); upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => client.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
      upstream.on('data', chunk => { received += chunk.length; if (received > maxBytes) { onFailure('response_size'); close(); } });
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    } catch (error) {
      // Chromium may make background requests outside the site allowlist. Deny
      // those individual tunnels without aborting the authorized site session.
      if (!stopped && !(error instanceof XhsError && error.code === 'browser_host_denied')) onFailure(error instanceof XhsError ? error.code : 'proxy_failed');
      client.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  signal?.addEventListener('abort', close, { once: true });
  return { url: `http://127.0.0.1:${server.address().port}`, get received() { return received; }, close() { signal?.removeEventListener('abort', close); close(); } };
}
