import { HttpBackend } from './http.js';
import { BrowserBackend } from '../browser/backend.js';
import { PendingLoginStore } from '../infra/pending-login.js';
import { checkAbort, safeError } from '../errors.js';

// Browser only for explicit operator login. Business methods stay on HttpBackend;
// challenges in HTTP calls never silently launch or retry another login.
export class InteractiveBackend extends HttpBackend {
  constructor({ root, executablePath, chromiumSandbox = true, interactionPort = 0, interactionPublicOrigin, headed = false, browserBackend, ...options } = {}) {
    super(options);
    this.root = root;
    this.browserLogin = browserBackend ?? new BrowserBackend({ root, executablePath, chromiumSandbox,
      directConnection: true, interactiveLogin: true, interactionPort, interactionPublicOrigin, headed });
  }
  async login(options = {}) {
    const { signal, onProgress, beforeCommit } = options;
    checkAbort(signal); await beforeCommit?.(); checkAbort(signal);
    const browser = await this.browserLogin.login(options);
    if (browser.authenticated !== true) return { ...browser, authenticated: false, browser_authenticated: false, http_reusable: false };
    checkAbort(signal);
    await new PendingLoginStore(this.root).clear();
    try { onProgress?.({ event: 'login_state', status: 'verifying_http_session' }); } catch {}
    let verification;
    try {
      verification = await this.status({ signal }); checkAbort(signal);
    } catch (error) {
      checkAbort(signal);
      return { configured: true, authenticated: false, backend: 'http', login_method: 'interactive_browser',
        browser_authenticated: true, session_saved: true, http_reusable: false, business_verified: false,
        verification: 'api_user_me', http_error: safeError(error) };
    }
    return { ...verification, login_method: 'interactive_browser', browser_authenticated: true, session_saved: true,
      http_reusable: verification.authenticated === true, business_verified: false };
  }
  async close() { await this.browserLogin.close(); await super.close(); }
}
