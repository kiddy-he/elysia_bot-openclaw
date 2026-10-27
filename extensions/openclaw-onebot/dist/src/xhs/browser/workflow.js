import { join } from 'node:path';
import { atomicFile, atomicJson } from '../infra/files.js';
import { sessionFromBrowser } from '../infra/session.js';
import { noteTarget, canonicalUrl, browserNoteUrl } from '../domain/urls.js';
import { apiSearchRows } from '../domain/api.js';
import { fail } from '../errors.js';

const QR = '.login-container .qrcode-img';
export async function observeLogin(page) {
  return page.evaluate(() => {
    const visible = element => !!element && !!element.getClientRects().length &&
      getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
    const raw = window.__INITIAL_STATE__?.user?.userInfo;
    const info = raw?.value ?? raw?._value ?? raw;
    const logged = document.querySelector('.main-container .user .link-wrapper .channel');
    return { title: document.title, loggedElementPresent: !!logged, loggedElementVisible: visible(logged),
      loginVisible: [...document.querySelectorAll('.login-container')].some(visible),
      captchaVisible: [...document.querySelectorAll('[class*="captcha"],[id*="captcha"]')].some(visible),
      userIdPresent: !!(info?.userId || info?.user_id), guest: typeof info?.guest === 'boolean' ? info.guest : null,
      errorText: [...document.querySelectorAll('.access-wrapper,.error-wrapper,.not-found-wrapper,.blocked-wrapper')]
        .filter(visible).map(v => v.textContent).join(' ').slice(0, 1000) };
  });
}
export function loginConfirmed(state) {
  // Preserve Rod's element check, but never accept a visible login dialog or
  // an explicitly guest state or visible challenge. The secondary signal
  // handles a changed menu DOM.
  return !challengeVisible(state) && !state.loginVisible && state.guest !== true &&
    (state.loggedElementPresent || state.guest === false && state.userIdPresent);
}
export function challengeVisible(state) {
  return !!state.captchaVisible || /安全验证|访问验证/u.test(`${state.title ?? ''} ${state.errorText ?? ''}`);
}
export function gateObservation(state, { allowLogin = false, allowChallenge = false } = {}) {
  const controlled = state.title + ' ' + state.errorText;
  if (/安全限制/u.test(controlled)) fail('network_restricted');
  if (/操作频繁|访问频次/u.test(controlled)) fail('rate_limited');
  if (/私密笔记|仅作者可见|仅自己可见|因用户设置/u.test(controlled)) fail('permission_denied');
  if (challengeVisible(state)) { if (!allowChallenge) fail('challenge_required'); return; }
  if (/页面不见了|笔记不存在|已被删除|暂时无法浏览|内容不存在|已失效|因违规无法查看/u.test(controlled) || state.errorText?.trim()) fail('note_unavailable');
  if (state.loginVisible && !allowLogin) fail('login_required');
}
export function matchesSearchResponse(response, expected) {
  try {
    const url = new URL(response.url()), request = response.request();
    if (url.protocol !== 'https:' || !(url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com')) ||
        url.pathname !== '/api/sns/web/v1/search/notes' || response.status() !== 200 || request.method() !== 'POST') return false;
    const body = request.postDataJSON();
    return body?.keyword === expected.query && body?.sort === expected.sort && body?.note_type === expected.note_type && (body.page ?? 1) === 1;
  } catch { return false; }
}
export async function visibleFilterOption(panel, label, option) {
  for (const group of await panel.locator('div.filters').all()) {
    const heading = group.locator(':scope > span').first();
    if (!await heading.count() || (await heading.innerText()).trim() !== label) continue;
    for (const candidate of await group.locator('div.tags').all()) {
      if (await candidate.isVisible() && (await candidate.innerText()).trim() === option) return candidate;
    }
  }
  fail('filter_option_unavailable');
}
export async function runBrowserAction({ page, context, sessions, root, operation, params = {}, emit = () => {},
  checkNetwork = () => {}, trace = () => {}, sleep = ms => page.waitForTimeout(ms),
  interaction, loginTimeoutMs = 240000, pollMs = 500, initialLoginDelayMs = 2000, statusDelayMs = 1000 }) {
  async function state({ allowLogin = false } = {}) {
    checkNetwork(); const value = await observeLogin(page); checkNetwork(); gateObservation(value, { allowLogin, allowChallenge: !!interaction && ['login','verify'].includes(operation) }); return value;
  }
  async function navigate(url, { attempts = 1, timeout = 25000 } = {}) {
    for (let attempt = 1; ; attempt++) {
      checkNetwork(); trace('Page.navigate', { path: new URL(url).pathname, attempt, waitUntil: 'load' });
      try { await page.goto(url, { waitUntil: 'load', timeout }); checkNetwork(); return; }
      catch (error) { checkNetwork(); if (attempt >= attempts) throw error; await sleep(500); }
    }
  }
  async function save() {
    const storageState = await context.storageState();
    const extra = await page.evaluate(() => ({ b1: localStorage.getItem('b1') ?? undefined,
      webSsk: localStorage.getItem('webSsk') ?? undefined, userAgent: navigator.userAgent }));
    checkNetwork(); await sessions.save(sessionFromBrowser(storageState, extra)); trace('session.saved');
  }
  async function requireLogin() { const value = await state(); if (!loginConfirmed(value)) fail('login_required'); return value; }

  if (operation === 'verify') {
    if (!interaction) fail('interaction_required');
    const target = new URL('https://www.xiaohongshu.com/search_result');
    target.searchParams.set('keyword', typeof params.query === 'string' ? params.query.slice(0,120) : '咖啡');
    target.searchParams.set('source','web_explore_feed');
    await navigate(target.href, {timeout:40000});
    const observed = await state({allowLogin:true});
    emit({event:'verification_observation',captchaVisible:observed.captchaVisible,challengeVisible:challengeVisible(observed),loginVisible:observed.loginVisible,loggedIn:loginConfirmed(observed)});
    interaction.setStatus('waiting_for_verification');
    emit({event:'login_state',...interaction.snapshot()});
    const deadline = Date.now() + loginTimeoutMs;
    // A logged-in DOM is insufficient: only a human confirmation can finish
    // verification. Visible challenge/login still prevents session commit.
    while (Date.now() < deadline) {
      checkNetwork();
      if (interaction.takeConfirmation()) {
        const current = await state({allowLogin:true});
        if (loginConfirmed(current)) {
          await save(); interaction.setStatus('authenticated');
          return {configured:true,authenticated:true,human_confirmed:true,business_verified:false,backend:'browser'};
        }
        interaction.setStatus('waiting_for_verification');
      }
      await sleep(pollMs);
    }
    fail('login_timeout');
  }
  if (operation === 'login' || operation === 'status') {
    await navigate('https://www.xiaohongshu.com/explore', { timeout: operation === 'login' ? 40000 : 25000 });
    await sleep(operation === 'login' ? initialLoginDelayMs : statusDelayMs);
    let current = await state({ allowLogin: operation === 'login' });
    if (!loginConfirmed(current)) {
      if (operation === 'status') fail('login_required');
      let lastQr, lastStatus;
      async function updateLogin() {
        if (interaction) {
          // Do not block on a QR selector: a challenge may precede QR creation.
          const src = await page.locator(QR).first().getAttribute('src', { timeout: 200 }).catch(() => null);
          if (src && src !== lastQr) { await saveQr(src); lastQr = src; }
          const next = challengeVisible(current) ? 'waiting_for_verification' :
            interaction.snapshot().status === 'waiting_for_verification' ? 'waiting_for_verification' :
              current.loginVisible ? 'waiting_for_scan' : 'waiting_for_login';
          interaction.setStatus(next);
          if (next !== lastStatus) { emit({ event: 'login_state', ...interaction.snapshot() }); lastStatus = next; }
        }
        await atomicJson(join(root, 'login-observation.json'), { title: current.title,
          loginElementPresent: current.loginVisible, userIdPresent: current.userIdPresent, guest: current.guest,
          captchaVisible: current.captchaVisible, loggedElementVisible: current.loggedElementVisible, observed_at: new Date().toISOString() });
      }
      async function saveQr(src) {
        const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/u.exec(src ?? '');
        if (!match || match[2].length > 1400000) fail('login_qr_invalid');
        const path = join(root, `login-qr.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
        await atomicFile(path, Buffer.from(match[2], 'base64'));
        trace('login.qr_saved'); emit({ event: 'login_qr', path, expires_seconds: Math.ceil(loginTimeoutMs / 1000) });
      }
      if (!interaction) {
        let src;
        try { src = await page.locator(QR).getAttribute('src', { timeout: 15000 }); }
        catch { checkNetwork(); await state({ allowLogin: true }); fail('login_qr_unavailable'); }
        await saveQr(src);
      }
      const deadline = Date.now() + loginTimeoutMs;
      while (!loginConfirmed(current) && Date.now() < deadline) {
        await updateLogin();
        await sleep(pollMs); current = await state({ allowLogin: true });
      }
      if (!loginConfirmed(current)) fail('login_timeout');
    }
    await requireLogin(); await save();
    interaction?.setStatus('authenticated');
    return { configured: true, authenticated: true, backend: 'browser' };
  }
  if (operation === 'search') {
    const url = new URL('https://www.xiaohongshu.com/search_result');
    url.searchParams.set('keyword', params.query); url.searchParams.set('source', 'web_explore_feed');
    await navigate(url.href); await state();
    await page.waitForFunction(() => { const f = window.__INITIAL_STATE__?.search?.feeds; return Array.isArray(f?.value ?? f?._value ?? f); });
    await requireLogin();
    const choices = [params.sort === 'latest' ? ['排序依据', '最新'] : null,
      params.media_type ? ['笔记类型', params.media_type === 'image' ? '图文' : '视频'] : null].filter(Boolean);
    const expected = { query: params.query, sort: 'general', note_type: 0 };
    let filteredRows;
    for (const [label, option] of choices) {
      await page.locator('div.filter').hover();
      const panel = page.locator('div.filter-panel'); await panel.waitFor({ state: 'visible' }); await panel.hover();
      const item = await visibleFilterOption(panel, label, option);
      if (label === '排序依据') expected.sort = 'time_descending';
      else expected.note_type = params.media_type === 'image' ? 2 : 1;
      const responseTask = page.waitForResponse(r => matchesSearchResponse(r, expected), { timeout: 15000 });
      let response;
      try { [response] = await Promise.all([responseTask, item.click()]); }
      catch { checkNetwork(); await state(); fail('filter_refresh_unverified'); }
      const body = await response.json();
      if (body?.success !== true || body.code !== 0) fail('filter_refresh_unverified');
      filteredRows = apiSearchRows(body.data); trace('search.filter_verified', { filter: label === '排序依据' ? 'sort' : 'type' });
      await requireLogin();
    }
    const rows = filteredRows ?? await page.evaluate(() => { const f = window.__INITIAL_STATE__.search.feeds; return f.value ?? f._value ?? f; });
    await requireLogin(); await save(); return rows;
  }
  if (operation !== 'inspect') fail('invalid_operation');
  const { id, token } = noteTarget(params.source), source = canonicalUrl(id, token);
  await navigate(browserNoteUrl(id, token), { attempts: 3 }); await state();
  await page.waitForFunction(id => !!window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note, id);
  const note = await page.evaluate(id => window.__INITIAL_STATE__.note.noteDetailMap[id].note, id);
  if (note?.noteId !== id) fail('identity_mismatch');
  await requireLogin(); await save(); return { note, source_url: source };
}
