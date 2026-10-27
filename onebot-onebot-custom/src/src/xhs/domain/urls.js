import ipaddr from 'ipaddr.js';
import { fail } from '../errors.js';
export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value)) fail('invalid_url');
  let u; try { u = new URL(value); } catch { fail('invalid_url'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port && !['80', '443'].includes(u.port)) fail('invalid_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) fail('nonpublic_address');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) fail('nonpublic_address');
  u.hash = ''; return u;
}
export function isPublicAddress(value) {
  try { const ip = ipaddr.process(value); return ip.range() === 'unicast'; } catch { return false; }
}
export function isXhsHost(host) { return host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'); }
export function isShortUrl(value) { const u = publicUrl(value); return ['xhslink.com', 'www.xhslink.com'].includes(u.hostname); }
export function noteTarget(value) {
  const u = publicUrl(value);
  const match = /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/u.exec(u.pathname);
  if (u.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(u.hostname) || u.port || !match) fail('invalid_target');
  const tokens = u.searchParams.getAll('xsec_token'); const token = tokens[0] ?? '';
  if (tokens.length > 1 || token.length > 1024 || !/^[A-Za-z0-9_+/=-]*$/u.test(token)) fail('invalid_target');
  return { id: match[1], token };
}
export function canonicalUrl(id, token = '') {
  if (!/^[a-f0-9]{24}$/u.test(id)) fail('invalid_target');
  const u = new URL(`https://www.xiaohongshu.com/explore/${id}`);
  if (token) { u.searchParams.set('xsec_token', token); u.searchParams.set('xsec_source', 'pc_search'); }
  return u.href;
}
// The upstream browser detail action uses pc_feed, even when the public
// candidate URL was produced by search. Keep locator and source identity apart.
export function browserNoteUrl(id, token = '') {
  const u = new URL(canonicalUrl(id));
  u.searchParams.set('xsec_token', token); u.searchParams.set('xsec_source', 'pc_feed');
  return u.href;
}
export function siteBrowserUrl(value) {
  const u = publicUrl(value);
  const domains = ['xiaohongshu.com', 'xhslink.com', 'xhscdn.com', 'xhsimg.com', 'xhsstatic.com'];
  if (u.protocol !== 'https:' || !domains.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`))) fail('browser_host_denied');
  return u;
}
