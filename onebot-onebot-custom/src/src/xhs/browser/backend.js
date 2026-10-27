// Optional browser backend. Only this module imports Playwright, lazily.
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SessionStore } from '../infra/session.js';
import { fileURLToPath } from 'node:url';
import { fail, checkAbort, signalFor, XhsError } from '../errors.js';
const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
export class BrowserBackend {
  constructor({ root, executablePath, chromiumSandbox = true, directConnection = true,
    interactiveLogin = false, interactionPort = 0, interactionPublicOrigin, headed = false, spawnWorker = spawn } = {}) {
    Object.assign(this, { root, executablePath, chromiumSandbox, directConnection,
      interactiveLogin, interactionPort, interactionPublicOrigin, headed, spawnWorker });
    this.children = new Set();
  }

  async invoke(operation, params, { signal, onProgress, beforeCommit } = {}) {
    signal = signalFor(signal, operation === 'login' ? 300000 : 80000); checkAbort(signal);
    const env = Object.fromEntries(['PATH', 'LANG', 'TZ', ...(this.headed ? ['DISPLAY', 'XAUTHORITY'] : [])].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.HOME = this.root; env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(this.root, 'browsers');
    const request = { operation, params, root: this.root, executablePath: this.executablePath, chromiumSandbox: this.chromiumSandbox, directConnection: this.directConnection, interactiveLogin: operation === 'login' && this.interactiveLogin, interactionPort: this.interactionPort, interactionPublicOrigin: this.interactionPublicOrigin, headed: operation === 'login' && this.headed, deferSessionCommit: true };
    const child = this.spawnWorker(process.execPath, [worker], { env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    this.children.add(child); let buffer = '', result, overflow = false; const decoder = new StringDecoder('utf8'); let totalBytes = 0;
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    signal.addEventListener('abort', kill, { once: true });
    try {
      await new Promise((resolve, reject) => {
        child.on('error', () => reject(new XhsError('worker_unavailable')));
        child.stdout.on('data', bytes => {
          totalBytes += bytes.length; buffer += decoder.write(bytes);
          if (totalBytes > 512 * 1024) { overflow = true; kill(); return; }
          let index;
          while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            try { const frame = JSON.parse(line); if (['login_qr', 'login_interaction', 'login_state'].includes(frame.event)) { try { onProgress?.(frame); } catch {} } else result = frame; } catch { kill(); }
          }
        });
        child.on('close', () => resolve()); child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
      });
      checkAbort(signal); if (overflow) fail('response_size');
      if (!result || buffer.trim()) fail('invalid_worker_response');
      if (!result.ok) fail(typeof result.error?.code === 'string' && /^[a-z_]+$/u.test(result.error.code) ? result.error.code : 'browser_failed');
      if (!result.data || !Object.hasOwn(result.data, 'result')) fail('invalid_worker_response');
      if (result.data.workerSession) await new SessionStore(this.root).save(result.data.workerSession, { beforeCommit: async () => { checkAbort(signal); await beforeCommit?.(); checkAbort(signal); } });
      return result.data.result;
    } finally { signal.removeEventListener('abort', kill); this.children.delete(child); kill(); }
  }
  search(params, context) { return this.invoke('search', params, context); }
  inspect(source, context) { return this.invoke('inspect', { source }, context); }
  login(context) { return this.invoke('login', {}, context); }
  status(context) { return this.invoke('status', {}, context); }
  async close() { for (const child of this.children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
}
