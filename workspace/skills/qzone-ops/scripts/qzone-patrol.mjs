#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getQzoneFeeds, getQzoneMsgList, setQzoneLike, replyQzoneMsg, getQzoneCredentials } from './qzone-client.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = '/root/.openclaw/state/qzone-patrol';
const CONFIG = '/root/.openclaw/qzone-patrol.json';
const runFile = promisify(execFile);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uin = value => /^[1-9]\d{4,11}$/u.test(String(value ?? ''));
const tid = value => /^[a-zA-Z0-9_-]{5,100}$/u.test(String(value ?? ''));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'iu'))?.[1]?.replaceAll('&amp;', '&');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeFeedPage(response) {
  if (!response?.data || !Array.isArray(response.data.data)) throw new Error('Invalid feeds page; cannot advance patrol baseline');
  const result = [];
  for (const item of response.data.data) {
    if (!item || typeof item !== 'object') continue;
    const owner = String(item.opuin ?? item.uin ?? ''), id = String(item.key ?? ''), appid = Number(item.appid);
    if (!uin(owner) || !tid(id) || !Number.isInteger(appid) || appid <= 0 || appid > 99999 || /advertisement/iu.test(id)) continue;
    const button = String(item.html ?? '').match(/<a\b[^>]*\bdata-unikey\s*=[^>]*>/iu)?.[0];
    if (!button) continue; // Non-interactive cards/advertisements are not like targets.
    const unikey = attr(button, 'data-unikey'), curkey = attr(button, 'data-curkey');
    if (!unikey || !curkey) continue;
    const time = Number(item.abstime);
    if (!Number.isFinite(time) || time <= 0) continue;
    const liked = attr(button, 'data-islike');
    result.push({ key: hash([owner, appid, id]), owner, tid: id, appid, typeid: Number(item.typeid) || 0,
      abstime: time, unikey, curkey, liked: liked === '1' ? true : liked === '0' ? false : null });
  }
  return { items: result, cursor: response.data.main?.externparam || null, hasMore: response.data.main?.hasMoreFeeds === true };
}

export function commentEvents(posts, ownUin) {
  const events = [];
  for (const post of posts) {
    if (!tid(post.tid) || (post.uin !== undefined && String(post.uin) !== String(ownUin))) continue;
    for (const parent of post.commentlist ?? []) {
      if (!/^[1-9]\d{0,19}$/u.test(String(parent.tid)) || !uin(parent.uin)) continue;
      for (const [kind, item] of [['root', parent], ...(parent.list_3 ?? []).map(item => ['reply', item])]) {
        if (!uin(item.uin) || String(item.uin) === String(ownUin)) continue;
        const content = String(item.content ?? '');
        const created = Number(item.create_time) || 0;
        const key = hash([post.tid, String(parent.tid), kind, String(item.tid), String(item.uin), created]);
        const publicText = text => String(text ?? '').replace(/@\{[^}]*\}/gu, '').slice(0, 2400);
        events.push({ key, postTid: post.tid, parentId: String(parent.tid), parentUin: String(parent.uin),
          authorUin: String(item.uin), kind, created, sourceId: String(item.tid),
          alreadyAnswered: (parent.list_3 ?? []).some(reply => String(reply.uin) === String(ownUin) && Number(reply.create_time) >= created),
          context: { post: publicText(post.content), newComment: { nickname: String(item.name ?? '').slice(0, 60), text: publicText(content) },
            thread: [parent, ...(parent.list_3 ?? [])].slice(-8).map(comment => ({ self: String(comment.uin) === String(ownUin),
              nickname: String(comment.name ?? '').slice(0, 60), text: publicText(comment.content) })) } });
      }
    }
  }
  return events;
}

export function observePatrol(state, snapshot, now = Date.now()) {
  state.seenComments ??= {}; state.likes ??= {}; state.replies ??= {};
  const events = commentEvents(snapshot.posts, state.ownerUin);
  if (!state.initializedAt) {
    // First successful complete snapshot is observation only. Creation-time
    // filtering prevents older cards first seen on a later page being backfilled.
    state.initializedAt = now; state.activatedAt = state.activatedAt ?? Math.floor(now / 1000) * 1000;
    state.baselineFeeds = Object.fromEntries(snapshot.feeds.map(feed => [feed.key, true]));
    for (const event of events) state.seenComments[event.key] = 'baseline';
    state.lastObservedAt = now;
    return { baseline: true, events: [] };
  }
  for (const feed of snapshot.feeds) {
    if (state.baselineFeeds?.[feed.key] || feed.abstime * 1000 < state.activatedAt) continue;
    const existing = state.likes[feed.key];
    if (!existing) state.likes[feed.key] = { ...feed, state: feed.liked ? 'succeeded' : 'pending', attempts: 0, observedAt: now };
    else if (feed.liked) existing.state = 'succeeded';
    else if (existing.state === 'uncertain' && feed.liked === false) { existing.state = 'pending'; existing.lastCheckedAt = now; }
  }
  for (const event of events) {
    if (state.seenComments[event.key]) continue;
    state.seenComments[event.key] = 'observed';
    if (!event.created || event.created * 1000 < state.activatedAt) continue;
    state.replies[event.key] ??= { postTid: event.postTid, parentId: event.parentId, parentUin: event.parentUin,
      kind: event.kind, authorUin: event.authorUin, sourceId: event.sourceId, state: event.alreadyAnswered ? 'succeeded' : 'pending', attempts: 0, observedAt: now };
  }
  state.lastObservedAt = now;
  return { baseline: false, events };
}

export function validatePublicReply(text) {
  if (typeof text !== 'string' || text.trim().length < 5 || text.length > 240
      || /@|\[CQ:|<at\b|https?:\/\/|sk-[A-Za-z0-9]{8}|\/root\/|舰长|API.?Key|系统提示词|服务器|OpenClaw|OneBot|LLBot|Antigravity|```/iu.test(text)) throw new Error('Invalid public-only reply');
  return text.trim();
}

export async function executePatrol(state, snapshot, { persist, like, reply, compose, enabled = () => true,
  now = Date.now, wait = pause, random = crypto.randomInt, maxActions = 20, budgetMs = 660_000 } = {}) {
  const observed = observePatrol(state, snapshot, now()); persist(state);
  const summary = { baseline: observed.baseline, likes: 0, replies: 0, failures: 0, deferred: 0 };
  if (observed.baseline) return summary;
  // Reconcile a lost native receipt from the actual thread; never infer success
  // from a model's text or replay an uncertain comment POST.
  const plain = value => String(value ?? '').replace(/@\{[^}]*\}/gu, '').replace(/\s+/gu, '');
  for (const record of Object.values(state.replies)) {
    if (!['sending', 'uncertain'].includes(record.state) || !record.draft) continue;
    const parent = snapshot.posts.find(post => post.tid === record.postTid)?.commentlist
      ?.find(comment => String(comment.tid) === record.parentId && String(comment.uin) === record.parentUin);
    if (parent?.list_3?.some(item => String(item.uin) === state.ownerUin && plain(item.content) === plain(record.draft)
        && Number(item.create_time) * 1000 >= (record.startedAt ?? 0) - 30000)) record.state = 'succeeded';
  }
  persist(state);
  const deadline = now() + budgetMs;
  let writes = 0;
  const gap = async () => { if (writes > 0) await wait(15000 + random(15001)); };
  // Reply candidates are prioritized over the like backlog.
  for (const [key, record] of Object.entries(state.replies)) {
    if (record.state !== 'pending' || record.attempts >= 5) continue;
    const event = observed.events.find(item => item.key === key);
    if (!event) { summary.deferred++; continue; }
    if (event.alreadyAnswered) { record.state = 'succeeded'; persist(state); continue; }
    if (writes >= maxActions || deadline - now() < 180000 || !enabled()) { summary.deferred++; continue; }
    try {
      if (!record.draft) {
        const generated = await compose(event.context);
        record.draft = validatePublicReply(generated.reply); record.model = generated.model; persist(state);
      }
      await gap();
      if (!enabled() || deadline - now() < 45000) { summary.deferred++; continue; }
      record.state = 'sending'; record.attempts++; record.startedAt = now(); persist(state);
      writes++;
      const receipt = await reply(event, record.draft);
      if (!receipt?.nativeReply) throw new Error('Native reply not verified');
      record.state = 'succeeded'; record.completedAt = now(); summary.replies++;
    } catch {
      // No automatic replay after a POST might have reached QQ. Draft-only
      // failures can retry next tick without duplicating a public comment.
      record.state = record.state === 'sending' ? 'uncertain' : 'pending';
      if (record.state === 'pending') record.attempts++;
      record.lastFailureAt = now(); summary.failures++;
    }
    persist(state);
  }
  for (const record of Object.values(state.likes).sort((a, b) => a.abstime - b.abstime)) {
    if (record.state !== 'pending' || record.attempts >= 5) continue;
    if (writes >= maxActions || deadline - now() < 45000 || !enabled()) { summary.deferred++; continue; }
    await gap();
    if (!enabled() || deadline - now() < 30000) { summary.deferred++; continue; }
    record.state = 'sending'; record.attempts++; record.startedAt = now(); persist(state); writes++;
    try {
      await like(record); record.state = 'succeeded'; record.completedAt = now(); summary.likes++;
    } catch { record.state = 'uncertain'; record.lastFailureAt = now(); summary.failures++; }
    persist(state);
  }
  state.lastRun = { ...summary, completedAt: now() }; persist(state);
  return summary;
}

async function collectSnapshot(config, ownerUin, state) {
  const feeds = [], posts = [];
  let cursor = null;
  for (let page = 1; page <= config.maxFeedPages; page++) {
    const parsed = normalizeFeedPage(await getQzoneFeeds({ account: 'default', pageNum: page, count: 30, cursor }));
    feeds.push(...parsed.items);
    const boundary = Math.max(state.activatedAt ?? 0, (state.lastObservedAt ?? state.activatedAt ?? 0) - 3600000);
    if (!state.initializedAt || !parsed.hasMore || !parsed.cursor || parsed.cursor === cursor
        || (boundary && parsed.items.length && parsed.items.every(item => item.abstime * 1000 < boundary))) break;
    cursor = parsed.cursor;
    if (page === config.maxFeedPages) throw new Error('Feed pagination cap reached; refusing to discard an incomplete interval');
  }
  for (let page = 0; page < config.maxOwnPages; page++) {
    const result = await getQzoneMsgList({ account: 'default', targetUin: ownerUin, pos: page * 100, num: 100 });
    if (!Array.isArray(result.msglist)) throw new Error('Invalid own-post list');
    posts.push(...result.msglist);
    if (result.msglist.length < 100 || posts.length >= Number(result.total)) break;
    if (page === config.maxOwnPages - 1) throw new Error('Own-post pagination cap reached');
  }
  return { feeds, posts };
}

async function lookupParent({ hostUin, tid: postTid, commentId, replyUin }) {
  for (let page = 0; page < 20; page++) {
    const result = await getQzoneMsgList({ account: 'default', targetUin: hostUin, pos: page * 100, num: 100 });
    const post = result.msglist?.find(post => String(post.tid) === postTid);
    if (post) return post.commentlist?.find(comment => String(comment.tid) === commentId && String(comment.uin) === replyUin);
    if (!result.msglist || result.msglist.length < 100) return undefined;
  }
  return undefined;
}

function loadConfig() {
  const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (value.version !== 1 || value.accountId !== 'default' || !Number.isInteger(value.maxFeedPages) || value.maxFeedPages < 1 || value.maxFeedPages > 50
      || !Number.isInteger(value.maxOwnPages) || value.maxOwnPages < 1 || value.maxOwnPages > 20) throw new Error('Invalid patrol configuration');
  return value;
}
function checkEnabled() {
  if (!loadConfig().enabled) return false;
  try { for (const action of ['read', 'interact']) execFileSync(process.execPath, ['/root/.openclaw/bin/feature-check.mjs', 'qzone', action, 'default'], { stdio: 'pipe', timeout: 10000 }); return true; }
  catch { return false; }
}

async function main() {
  process.umask(0o077); fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const args = process.argv.slice(2);
  if (!['run', 'init', 'status', '--locked'].includes(args[0])) throw new Error('Use init, run or status');
  if (args[0] !== '--locked') {
    const child = spawn('flock', ['-n', '-E', '75', path.join(ROOT, 'patrol.lock'), process.execPath, SCRIPT, '--locked', ...args], { stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    if (code === 75) console.log(JSON.stringify({ status: 'busy' })); else process.exitCode = code ?? 1;
    return;
  }
  const file = path.join(ROOT, 'state.json');
  const persist = value => { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); };
  const command = args[1];
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, accountId: 'default', likes: {}, replies: {}, seenComments: {} };
  if (state.version !== 1 || state.accountId !== 'default') throw new Error('Invalid patrol state');
  if (command === 'status') { console.log(JSON.stringify({ initializedAt: state.initializedAt, lastRun: state.lastRun,
    likes: Object.values(state.likes).reduce((a, x) => ({ ...a, [x.state]: (a[x.state] ?? 0) + 1 }), {}),
    replies: Object.values(state.replies).reduce((a, x) => ({ ...a, [x.state]: (a[x.state] ?? 0) + 1 }), {}) })); return; }
  if (!checkEnabled()) throw new Error('Patrol or Qzone feature disabled');
  const config = loadConfig();
  state.ownerUin = (await getQzoneCredentials('default')).uin;
  state.activatedAt ??= Math.floor(Date.now() / 1000) * 1000;
  // A restarted worker must not resend writes that were in flight.
  for (const record of [...Object.values(state.likes), ...Object.values(state.replies)]) if (record.state === 'sending') record.state = 'uncertain';
  persist(state);
  const snapshot = await collectSnapshot(config, state.ownerUin, state);
  if (command === 'init') { if (!state.initializedAt) observePatrol(state, snapshot); persist(state); console.log(JSON.stringify({ status: 'baseline-ready', feedCount: snapshot.feeds.length, ownPosts: snapshot.posts.length })); return; }
  if (command !== 'run') throw new Error('Invalid patrol operation');
  const summary = await executePatrol(state, snapshot, { persist, enabled: checkEnabled,
    like: record => setQzoneLike({ account: 'default', targetUin: record.owner, tid: record.tid, appid: record.appid, typeid: record.typeid,
      abstime: record.abstime, unikey: record.unikey, curkey: record.curkey }),
    reply: (event, content) => replyQzoneMsg({ account: 'default', hostUin: state.ownerUin, tid: event.postTid,
      commentId: event.parentId, replyUin: event.parentUin, content }, { getParent: lookupParent, trigger: event.key }),
    compose: async context => {
      const work = runFile('/usr/bin/python3', [path.join(path.dirname(SCRIPT), 'qzone-patrol-model.py')], {
        timeout: 130000, maxBuffer: 20000, shell: false,
      });
      work.child.stdin.end(JSON.stringify(context));
      const { stdout } = await work;
      return JSON.parse(stdout);
    },
  });
  console.log(JSON.stringify({ status: 'completed', ...summary }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) main().catch(error => {
  const diagnostic = { at: new Date().toISOString(), type: error?.name ?? 'Error',
    code: String(error?.code ?? '').slice(0, 80), message: String(error?.message ?? 'unknown')
      .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, '[REDACTED]').replace(/((?:cookie|skey|api[_-]?key)\s*[:=]\s*)\S+/giu, '$1[REDACTED]').slice(0, 1000) };
  try { fs.writeFileSync(path.join(ROOT, 'last-error.json'), JSON.stringify(diagnostic), { mode: 0o600 }); } catch {}
  console.error(JSON.stringify({ status: 'failed', reason: 'Qzone patrol failed; inspect local diagnostics, no blind write retry' })); process.exitCode = 1;
});
