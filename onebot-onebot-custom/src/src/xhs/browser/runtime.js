import { join } from 'node:path';
import { SessionStore } from '../infra/session.js';
import { atomicJson } from '../infra/files.js';
import { browserProxy } from '../infra/network.js';
import { siteBrowserUrl } from '../domain/urls.js';
import { applyRodDevice } from './profile.js';
import { runBrowserAction } from './workflow.js';
import { fail, safeError } from '../errors.js';
import { createLoginInteraction } from './interaction.js';

export async function runBrowser(request, { chromium, emit = () => {}, configureContext,
  maxReceivedBytes = 32 * 1024 ** 2, actionOptions = {} } = {}) {
  const { operation, params, root, executablePath, chromiumSandbox = true, directConnection = true, interactiveLogin = false, interactionPort = 0, interactionPublicOrigin, headed = false, deferSessionCommit = false } = request;
  if (!['search', 'inspect', 'login', 'status', 'verify'].includes(operation)) fail('invalid_operation');
  const humanMode = operation === 'verify' || operation === 'login' && interactiveLogin;
  const sessions = new SessionStore(root), session = await sessions.load({ optional: operation === 'login' });
  let stagedSession;
  const actionSessions = deferSessionCommit ? { save: async raw => { stagedSession = sessions.validate(raw); } } : sessions;
  let browser, proxy, interaction, stopped, requests = 0, apiRequests = 0, received = 0;
  const history = [], controller = new AbortController();
  const trace = (method, detail = {}) => { if (history.length < 200) history.push({ method, ...detail, at: new Date().toISOString() }); };
  const stop = code => { stopped ??= code; controller.abort(); void browser?.close().catch(() => {}); };
  const checkNetwork = () => { if (stopped) fail(stopped); };
  try {
    if (!directConnection) proxy = await browserProxy({ signal: controller.signal, onFailure: stop });
    try {
      browser = await chromium.launch({ headless: !headed, executablePath, chromiumSandbox,
        ...(proxy ? { proxy: { server: proxy.url, bypass: '<-loopback>' } } : {}),
        args: [...(directConnection ? ['--no-proxy-server'] : []), '--lang=zh-CN', '--disable-gpu',
          '--disable-quic', '--disable-dev-shm-usage', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        env: { PATH: process.env.PATH, HOME: root, LANG: process.env.LANG ?? 'zh_CN.UTF-8', ...(process.env.TZ ? { TZ: process.env.TZ } : {}), ...(headed && process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) } : {}) } });
    } catch { fail('browser_unavailable'); }
    trace('browser.launched', { direct: directConnection, profile: 'rod-v0.116.2-laptop-mdpi' });
    const storageState = session?.storageState ?? (session ? { cookies: Object.entries(session.cookies).map(([name, value]) =>
      ({ name, value, domain: '.xiaohongshu.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' })), origins: [] } : undefined);
    const context = await browser.newContext({ storageState, viewport: null, serviceWorkers: 'block', acceptDownloads: false });
    // Login includes up to four minutes of QR polling, site telemetry and the
    // post-confirmation hydration burst. Keep business actions on their tighter
    // budget; both modes retain total-request, byte and wall-clock limits.
    const apiRequestLimit = humanMode || operation === 'login' ? 600 : 180;
    context.on('request', req => {
      try { siteBrowserUrl(req.url()); } catch { return; }
      requests++;
      if (requests > (humanMode || operation === 'login' ? 1200 : 600)) { stop('request_budget'); return; }
      if (new URL(req.url()).pathname.startsWith('/api/') && ['xhr', 'fetch'].includes(req.resourceType()) && ++apiRequests > apiRequestLimit) stop('api_request_budget');
    });
    await context.route('**/*', async route => {
      const req = route.request();
      try { siteBrowserUrl(req.url()); } catch { await route.abort().catch(() => {}); return; }
      if (stopped) { await route.abort().catch(() => {}); return; }
      if (!humanMode && operation !== 'login' && ['image', 'media', 'font'].includes(req.resourceType())) { await route.abort(); return; }
      await route.continue().catch(error => { if (!stopped) throw error; });
    });
    context.on('response', response => {
      const url = new URL(response.url()), req = response.request();
      if ((url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com')) &&
          (req.isNavigationRequest() || url.pathname.startsWith('/api/'))) {
        trace('Network.responseReceived', { host: url.hostname, path: url.pathname, status: response.status() });
        if (response.status() === 429) stop('rate_limited');
        if ([401, 403].includes(response.status())) stop('permission_denied');
        if ([406, 461, 471].includes(response.status())) {
          if (humanMode) interaction?.setStatus('waiting_for_verification');
          else stop('challenge_required');
        }
      }
    });
    // The optional hook is only an in-process fixture seam; it is never exposed
    // in CLI stdin, service parameters, or model tool arguments.
    await configureContext?.(context);
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(25000);
    const cdp = await applyRodDevice(context, page, session);
    trace('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1 });
    trace('Emulation.setTouchEmulationEnabled', { enabled: false }); trace('Network.setUserAgentOverride', { acceptLanguage: 'en' });
    await cdp.send('Network.enable');
    cdp.on('Network.dataReceived', event => { received += event.dataLength; if (received > maxReceivedBytes) stop('response_size'); });
    if (humanMode) {
      interaction = await createLoginInteraction({ page, port: interactionPort, publicOrigin: interactionPublicOrigin, verificationMode: operation === 'verify', cancel: stop });
      emit({ event: 'login_interaction', loginId: interaction.loginId, interaction_url: interaction.url,
        expiresAt: interaction.expiresAt, transport: 'browser-pixels', viewport: { width: 1280, height: 800 } });
    }
    const result = await runBrowserAction({ page, context, sessions: actionSessions, root, operation, params, emit, checkNetwork, trace, ...actionOptions, interaction });
    return deferSessionCommit ? { result, ...(stagedSession ? { workerSession: stagedSession } : {}) } : result;
  } catch (error) {
    // Closing Chromium on a refusal can make a pending goto/evaluate throw an
    // ordinary Playwright error. Preserve the refusal that caused the close.
    const code = stopped ?? safeError(error).code;
    interaction?.setStatus(code === 'login_timeout' ? 'expired' : code === 'cancelled' ? 'cancelled' : 'failed', code);
    checkNetwork(); throw error;
  } finally {
    await interaction?.close();
    await browser?.close().catch(() => {}); proxy?.close();
    await atomicJson(join(root, 'browser-trace.json'), { operation, events: history,
      metrics: { http_requests: requests, api_requests: apiRequests, received_bytes: received },
      stopped: stopped ?? null, finished_at: new Date().toISOString() }).catch(() => {});
  }
}
