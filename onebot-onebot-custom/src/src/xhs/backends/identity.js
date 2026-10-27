import { randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Xhshow, a1PlatformDigit } from '@ikenxuan/xhshow-ts';
import { ROD_LOGIN_USER_AGENT } from '../browser/profile.js';
// Observed in the actual 2026-10-20 index bundle and original browser cookie.
export const OBSERVED_WEB_BUILD = '6.57.6';
export function createGuestIdentity({ userAgent = ROD_LOGIN_USER_AGENT, webBuild = OBSERVED_WEB_BUILD } = {}) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = Array.from({ length: 30 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const body = Date.now().toString(16) + random + a1PlatformDigit(userAgent) + '0000';
  const a1 = (body + String(crc32(Buffer.from(body)))).slice(0, 52);
  return { userAgent, cookies: { a1, webId: Xhshow.generateWebId(a1), webBuild, xsecappid: 'xhs-pc-web', loadts: String(Date.now()) } };
}
