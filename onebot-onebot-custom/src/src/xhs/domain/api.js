import { fail } from '../errors.js';

export function apiSearchRows(data) {
  if (!Array.isArray(data?.items)) fail('invalid_response');
  return data.items.map(row => {
    const card = row.note_card ?? row.noteCard;
    return { id: row.id, xsecToken: row.xsec_token ?? row.xsecToken ?? '', modelType: row.model_type ?? row.modelType,
      noteCard: card ? normalizeCard(card) : undefined };
  });
}

function normalizeCard(card) {
  return { ...card,
    displayTitle: card.display_title ?? card.displayTitle,
    user: card.user ? { ...card.user, userId: card.user.user_id ?? card.user.userId, nickname: card.user.nickname ?? card.user.nick_name ?? card.user.nickName } : undefined,
    interactInfo: normalizeInteract(card.interact_info ?? card.interactInfo),
    tagList: card.tag_list ?? card.tagList ?? [],
  };
}

export function normalizeInteract(value) {
  if (!value || typeof value !== 'object') return null;
  return { ...value,
    likedCount: value.liked_count ?? value.likedCount,
    collectedCount: value.collected_count ?? value.collectedCount,
    commentCount: value.comment_count ?? value.commentCount,
    shareCount: value.share_count ?? value.shareCount,
    liked: value.liked,
    collected: value.collected,
  };
}

const aliases = { drm_type: 'drmType', master_url: 'masterUrl', backup_urls: 'backupUrls', avg_bitrate: 'avgBitrate', video_bitrate: 'videoBitrate' };
function videoObject(value, depth = 0) {
  if (depth > 20) fail('invalid_video_metadata');
  if (Array.isArray(value)) return value.slice(0, 64).map(v => videoObject(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [aliases[k] ?? k, videoObject(v, depth + 1)]));
  return value;
}
export function apiNote(card) {
  if (!card || typeof card !== 'object') fail('invalid_response');
  const images = card.image_list ?? card.imageList ?? [];
  if (!Array.isArray(images)) fail('invalid_response');
  return { ...card, noteId: card.note_id ?? card.noteId,
    imageList: images.slice(0, 200).map(i => ({ ...i, urlDefault: i.url_default ?? i.urlDefault, urlPre: i.url_pre ?? i.urlPre,
      infoList: (i.info_list ?? i.infoList ?? []).map(v => ({ ...v, imageScene: v.image_scene ?? v.imageScene })) })),
    user: card.user ? { ...card.user, userId: card.user.user_id ?? card.user.userId, nickname: card.user.nickname ?? card.user.nick_name ?? card.user.nickName } : undefined,
    interactInfo: normalizeInteract(card.interact_info ?? card.interactInfo),
    tagList: card.tag_list ?? card.tagList ?? [],
    video: videoObject(card.video) };
}

export function apiProfile(data, userId) {
  if (!data || typeof data !== 'object') fail('invalid_response');
  const b = data.basic_info ?? data.basicInfo ?? {};
  const tags = data.tags ?? [];
  return {
    user_id: userId,
    nickname: text(b.nickname ?? b.nick_name, 160),
    red_id: text(b.red_id ?? b.redId, 128),
    bio: text(b.desc ?? b.description, 2000),
    avatar_url: safeUrl(b.imageb ?? b.images ?? b.avatar),
    gender: Number.isSafeInteger(b.gender) ? b.gender : null,
    ip_location: text(b.ip_location ?? b.ipLocation, 80),
    stats: { posted: numberOrNull(data.posted), liked: numberOrNull(data.liked), collected: numberOrNull(data.collected) },
    tags: Array.isArray(tags) ? tags.slice(0, 50).map(tag => ({ id: text(tag?.id, 128), name: text(tag?.name, 160), type: text(tag?.type, 40) })).filter(t => t.name) : [],
    visibility: data.tab_public ?? data.tabPublic ?? null,
    observed_at: new Date().toISOString(),
    trust: 'untrusted_external_sources',
  };
}

export function apiPosted(data) {
  if (!data || typeof data !== 'object') fail('invalid_response');
  const notes = Array.isArray(data.notes) ? data.notes : [];
  return { cursor: typeof data.cursor === 'string' ? data.cursor : '', hasMore: Boolean(data.has_more ?? data.hasMore),
    notes: notes.slice(0, 100).map(row => ({ post_id: row.note_id ?? row.noteId, source_url: row.xsec_token ? `https://www.xiaohongshu.com/explore/${row.note_id ?? row.noteId}?xsec_token=${encodeURIComponent(row.xsec_token)}` : null,
      title: text(row.display_title ?? row.displayTitle, 240), note_type: row.type === 'video' ? 'video' : 'normal', author: text(row.user?.nickname ?? row.user?.nick_name, 160), author_id: text(row.user?.user_id ?? row.user?.userId, 128),
      published_at: numberOrNull(row.time) ? new Date(Number(row.time)).toISOString() : null, metrics: normalizeInteract(row.interact_info ?? row.interactInfo), cover_url: safeUrl(row.cover?.url) })) };
}

export function apiComments(data) {
  if (!data || typeof data !== 'object') fail('invalid_response');
  const comments = Array.isArray(data.comments) ? data.comments : [];
  return { cursor: typeof data.cursor === 'string' ? data.cursor : '', hasMore: Boolean(data.has_more ?? data.hasMore),
    comments: comments.slice(0, 100).map(normalizeComment) };
}
function normalizeComment(c) {
  const u = c.user ?? {};
  return { comment_id: text(c.id ?? c.comment_id, 128), parent_id: text(c.parent_comment_id ?? c.parentCommentId, 128) || null,
    content: text(c.content ?? c.comment_content, 10000), created_at: numberOrNull(c.create_time ?? c.createTime) ? new Date(Number(c.create_time ?? c.createTime)).toISOString() : null,
    user: { user_id: text(u.user_id ?? u.userId, 128), nickname: text(u.nickname ?? u.nick_name, 160), avatar_url: safeUrl(u.avatar) },
    like_count: numberValue(c.like_count ?? c.likeCount), sub_comment_count: numberValue(c.sub_comment_count ?? c.subCommentCount), sub_comments: Array.isArray(c.sub_comments ?? c.subComments) ? (c.sub_comments ?? c.subComments).slice(0, 20).map(normalizeComment) : [] };
}
function text(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
function numberOrNull(v) { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; }
function numberValue(v) { return v === undefined || v === null || v === '' ? null : numberOrNull(v); }
function safeUrl(v) { try { const u = new URL(v); return u.protocol === 'https:' ? u.href : null; } catch { return null; } }
