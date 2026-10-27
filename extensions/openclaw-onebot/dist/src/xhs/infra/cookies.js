import { cookiesForUrl, sessionFromBrowser } from './session.js';
import { fail } from '../errors.js';
export function cookieState(session) {
  return session.storageState ?? { cookies: Object.entries(session.cookies).map(([name, value]) =>
    ({ name, value, domain: '.xiaohongshu.com', path: '/', expires: -1, secure: true, httpOnly: false, sameSite: 'Lax' })), origins: [] };
}
export function mergeSetCookies(session, headers, sourceUrl) {
  const state = cookieState(session), url = new URL(sourceUrl), next = [...state.cookies];
  for (const line of Array.isArray(headers) ? headers : headers ? [headers] : []) {
    if (typeof line !== 'string' || line.length > 12000) fail('invalid_response_cookie');
    const [pair, ...attributes] = line.split(';'), index = pair.indexOf('=');
    if (index <= 0) fail('invalid_response_cookie');
    const c = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: url.hostname,
      path: '/', expires: -1, secure: false, httpOnly: false, sameSite: 'Lax' };
    for (const attribute of attributes) {
      const [rawName, ...rest] = attribute.trim().split('='), name = rawName.toLowerCase(), value = rest.join('=');
      if (name === 'domain') c.domain = '.' + value.toLowerCase().replace(/^\./u, '');
      if (name === 'path') c.path = value;
      if (name === 'expires') { const time = Date.parse(value); if (Number.isFinite(time)) c.expires = time / 1000; }
      if (name === 'max-age' && /^-?\d+$/u.test(value)) c.expires = Date.now() / 1000 + Number(value);
      if (name === 'secure') c.secure = true;
      if (name === 'httponly') c.httpOnly = true;
      if (name === 'samesite') c.sameSite = { lax: 'Lax', none: 'None', strict: 'Strict' }[value.toLowerCase()] ?? 'Lax';
    }
    const domain = c.domain.replace(/^\./u, '');
    if (!(url.hostname === domain || c.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`)) ||
        !(domain === 'xiaohongshu.com' || domain.endsWith('.xiaohongshu.com'))) fail('invalid_response_cookie');
    const old = next.findIndex(v => v.name === c.name && v.domain === c.domain && v.path === c.path);
    if (old >= 0) next.splice(old, 1);
    if (c.expires < 0 || c.expires * 1000 > Date.now()) next.push(c);
  }
  Object.assign(session, sessionFromBrowser({ ...state, cookies: next }, { userAgent: session.userAgent, b1: session.b1, webSsk: session.webSsk }));
  return cookiesForUrl(session, sourceUrl);
}
export function applyLoginSession(session, data) {
  const info = data?.login_info ?? data?.loginInfo ?? data;
  if (typeof info?.session === 'string' && info.session) {
    mergeSetCookies(session, [`web_session=${info.session}; Domain=.xiaohongshu.com; Path=/; Secure; HttpOnly; SameSite=Lax`], 'https://edith.xiaohongshu.com/');
  }
}
