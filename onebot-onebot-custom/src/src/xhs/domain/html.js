import { fail } from '../errors.js';
import { noteTarget } from './urls.js';
export function classifyPage(text) {
  // Inspect only page text outside scripts; never classify user note descriptions as a gate.
  const body = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(body)?.[1] ?? '';
  if (/安全限制/u.test(title)) return 'network_restricted';
  if (/<[^>]+(?:class|id)=["'][^"']*captcha/iu.test(body) || /(?:安全验证|访问验证)/u.test(title)) return 'challenge_required';
  if (/(?:访问频次|操作频繁)/u.test(title)) return 'rate_limited';
  if (/(?:私密笔记|仅作者可见|仅自己可见|因用户设置)/u.test(title)) return 'permission_denied';
  if (/(?:页面不见了|笔记不存在|已被删除|暂时无法浏览)/u.test(title)) return 'note_unavailable';
  if (/<[^>]+class=["'][^"']*login-container/iu.test(body)) return 'login_required';
  return null;
}
export function parseInitialState(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 ** 2) fail('page_size_limit');
  const match = /window\.__INITIAL_STATE__\s*=\s*/gu.exec(html);
  if (!match) fail('note_state_unavailable');
  const start = match.index + match[0].length;
  if (html[start] !== '{') fail('invalid_note_state');
  let depth = 0, quoted = false, escaped = false, value = '';
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quoted) {
      value += ch;
      if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    if (ch === '{' || ch === '[') { depth++; if (depth > 80) fail('invalid_note_state'); }
    if (ch === '}' || ch === ']') depth--;
    if (html.startsWith('undefined', i) && !/[\w$]/u.test(html[i - 1] ?? '') && !/[\w$]/u.test(html[i + 9] ?? '')) { value += 'null'; i += 8; } else value += ch;
    if (depth === 0) {
      try { const result = JSON.parse(value); if (!result || Array.isArray(result)) fail('invalid_note_state'); return result; } catch { fail('invalid_note_state'); }
    }
  }
  fail('invalid_note_state');
}
export function parseNoteHtml(html, source) {
  const gate = classifyPage(html); if (gate && gate !== 'login_required') fail(gate);
  const { id } = noteTarget(source);
  let state; try { state = parseInitialState(html); } catch (error) { if (gate === 'login_required') fail(gate); throw error; }
  const map = state.note?.noteDetailMap ?? {};
  let note = Object.hasOwn(map, id) ? map[id]?.note : undefined;
  if (!note || typeof note !== 'object' || Array.isArray(note)) note = state.noteData?.data?.noteData;
  if (!note || (note.noteId ?? note.id) !== id) fail('identity_mismatch');
  return { ...note, noteId: note.noteId ?? note.id };
}
