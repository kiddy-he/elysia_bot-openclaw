import { fail } from '../errors.js';
import { noteTarget, canonicalUrl, publicUrl } from './urls.js';
export const MAX_IMAGE_BYTES = 8 * 1024 ** 2;
export const MAX_VIDEO_BYTES = 128 * 1024 ** 2;
export const MAX_VIDEO_SECONDS = 1200;
const text = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
export const count = v => { if (v === undefined || v === null || v === '') return null; const m=String(v).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|亿|[kKmMwW])?\+?$/u); const scale=m?.[2]?({万:1e4,亿:1e8,k:1e3,m:1e6,w:1e4}[m[2].toLowerCase()]??1):1; const n=m?Math.round(Number(m[1])*scale):NaN; return Number.isSafeInteger(n) && n >= 0 ? { value: n, raw: String(v), approximate: scale!==1||String(v).includes('+') } : { value: null, raw: String(v).slice(0, 64), approximate: true }; };
const metrics = i => i && typeof i === 'object' ? { likes: count(i.liked_count ?? i.likedCount), collects: count(i.collected_count ?? i.collectedCount), comments: count(i.comment_count ?? i.commentCount), shares: count(i.share_count ?? i.shareCount) } : { likes: null, collects: null, comments: null, shares: null };
const tags = value => Array.isArray(value) ? value.slice(0, 50).map(t => ({ id: text(t?.id, 128), name: text(t?.name, 160), type: text(t?.type, 40) })).filter(t => t.name) : [];
export function timestamp(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
export function normalizeSearch(rows, params) {
  if (!Array.isArray(rows) || rows.length > 2000) fail('invalid_response');
  const posts = [], seen = new Set();
  for (const row of rows) {
    const card = row?.noteCard;
    if (row?.modelType !== 'note' || !['normal', 'video'].includes(card?.type)) continue;
    if (params.media_type && card.type !== (params.media_type === 'image' ? 'normal' : 'video')) continue;
    try { noteTarget(canonicalUrl(row.id, row.xsecToken ?? '')); } catch { continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    posts.push({ post_id: row.id, source_url: canonicalUrl(row.id, row.xsecToken ?? ''), title: text(card.displayTitle, 240), author: text(card.user?.nickname || card.user?.nickName, 160), author_id: text(card.user?.userId, 128), note_type: card.type, published_at: null, metrics: metrics(card.interactInfo ?? card.interact_info), tags: tags(card.tagList ?? card.tag_list), identity_status: 'candidate', media_roles: [] });
    if (posts.length === (params.limit ?? 6)) break;
  }
  return { posts, visible_posts: posts.length, coverage: 'visible_candidates_only', date_status: 'unknown', search_visibility: posts.length ? 'candidates_observed' : 'not_verified' };
}
export function normalizeNote(note, source) {
  const { id, token } = noteTarget(source);
  if (!note || note.noteId !== id || !['normal', 'video'].includes(note.type) || typeof note.user?.userId !== 'string' || !note.user.userId) fail('identity_mismatch');
  return { post_id: id, source_url: canonicalUrl(id, token), title: text(note.title, 240), text: text(note.desc, 20000), author: text(note.user.nickname || note.user.nickName, 160), author_id: text(note.user.userId, 128), note_type: note.type, published_at: timestamp(note.time), metrics: metrics(note.interactInfo ?? note.interact_info), tags: tags(note.tagList ?? note.tag_list), identity_status: 'matched', date_status: timestamp(note.time) ? 'source_reported' : 'unknown', publicity_status: 'not_independently_verified', trust: 'untrusted_external_sources' };
}
export function imageCandidates(note, source) {
  const post = normalizeNote(note, source);
  if (post.note_type !== 'normal') fail('video_has_no_album');
  if (!Array.isArray(note.imageList) || !note.imageList.length) fail('note_no_images');
  const result = [], seen = new Set();
  for (const [index, item] of note.imageList.slice(0, 160).entries()) {
    if (!item || typeof item !== 'object') continue;
    const infos = Array.isArray(item.infoList) ? item.infoList : [];
    const values = [item.urlDefault, item.url, ...infos.filter(i => ['WB_DFT', 'H5_DTL'].includes(i?.imageScene)).map(i => i.url), item.urlPre];
    let url;
    for (const value of values) { try { url = publicUrl(value).href; break; } catch {} }
    if (!url || seen.has(url)) continue;
    seen.add(url); result.push({ url, media_index: index, role: 'post_image', quality: 'source_served', width: positive(item.width), height: positive(item.height), post });
  }
  if (!result.length) fail('note_no_images');
  return { post, images: result, declared_image_count: note.imageList.length, candidate_limit_reached: note.imageList.length > 160 };
}
function positive(n) { return Number.isFinite(n) && n >= 0 ? n : 0; }
export function videoVariants(note, source, { quality = 'best_available' } = {}) {
  normalizeNote(note, source);
  if (note.type !== 'video') fail('note_has_no_video');
  const media = note.video?.media;
  if (!media || media.video?.drmType != null && media.video.drmType !== 0) fail('protected_stream');
  const streams = media.stream ?? {}, all = [], seen = new Set();
  for (const key of ['h264', 'EF4']) {
    if (streams[key] != null && !Array.isArray(streams[key])) fail('invalid_video_metadata');
    for (const item of (streams[key] ?? []).slice(0, 16)) {
      if (!item || !['', 'mp4', undefined, null].includes(item.format)) continue;
      const numbers = [item.size ?? 0, item.duration ?? 0, item.width ?? 0, item.height ?? 0, item.avgBitrate ?? item.videoBitrate ?? 0];
      if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) continue;
      const [bytes, ms, width, height, bitrate] = numbers, duration = ms / 1000;
      if (duration > MAX_VIDEO_SECONDS) continue;
      const urls = [];
      for (const value of [item.masterUrl, ...(Array.isArray(item.backupUrls) ? item.backupUrls.slice(0, 3) : [])]) {
        try { const u = publicUrl(value); if (!/\.m3u8(?:$|\?)/iu.test(u.href) && !urls.includes(u.href)) urls.push(u.href); } catch {}
      }
      if (!urls.length || seen.has(urls[0])) continue;
      seen.add(urls[0]); all.push({ urls, declared_bytes: bytes, estimated_bytes: bytes || bitrate * duration / 8, duration_seconds: duration, width, height, bitrate, codec: 'h264' });
    }
  }
  all.sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate || b.declared_bytes - a.declared_bytes);
  // Metadata proves a native rendition, never the original upload.
  if (quality === 'original_only') fail('original_quality_unverified');
  const valid = all.filter(v => v.estimated_bytes <= MAX_VIDEO_BYTES).slice(0, 3);
  if (!valid.length) fail('no_compatible_video');
  return valid.map(v => ({ ...v, quality: v === all[0] ? 'highest_native' : 'lower_native', fallback_reason: v === all[0] ? null : 'higher_version_over_budget_or_failed' }));
}
export function checkConstraints(post, constraints = {}, now = Date.now()) {
  if (constraints.author_id && constraints.author_id !== post.author_id) fail('publisher_unverified');
  const dates = ['published_after', 'published_before'].map(k => constraints[k] === undefined ? null : Date.parse(constraints[k]));
  if (dates.some(d => d !== null && !Number.isFinite(d)) || dates.every(d => d !== null) && dates[0] >= dates[1]) fail('invalid_date_constraint');
  if (dates.some(d => d !== null)) {
    const stamp = Date.parse(post.published_at);
    if (!Number.isFinite(stamp) || stamp > now + 300000 || dates[0] !== null && stamp < dates[0] || dates[1] !== null && stamp >= dates[1]) fail('resource_freshness_unverified');
  }
}
