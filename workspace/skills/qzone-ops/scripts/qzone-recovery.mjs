import fs from 'node:fs';
import crypto from 'node:crypto';

export const PREPARE_JOB_ID = '4b13a241-07de-57bb-8d55-7c7fb958b5f3';
export const RECOVERY_DEFAULTS = Object.freeze({ maxPrepareAttempts: 6, retryMinMinutes: 15, retryMaxMinutes: 60, latestPrepareHour: 20.5 });
const dateAt = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export function choosePrepareRetry(state, now = Date.now(), random = crypto.randomInt, options = RECOVERY_DEFAULTS) {
  if (state.date !== dateAt(now) || (state.prepareAttempts ?? 1) >= options.maxPrepareAttempts
      || ['published', 'publishing', 'uncertain', 'ready', 'expired'].includes(state.status) || state.publishStartedAt || state.tid) return null;
  const cutoff = Date.parse(`${state.date}T00:00:00+08:00`) + options.latestPrepareHour * 3600000;
  const start = Math.ceil((now + options.retryMinMinutes * 60000) / 1000) * 1000;
  const end = Math.min(now + options.retryMaxMinutes * 60000, cutoff - 1000);
  if (start >= end) return null;
  return start + random(Math.floor((end - start) / 1000) + 1) * 1000;
}

export function describePreparationFailure(log = '', stage = 'prepare') {
  if (/publication-time|Publication-time|Publication.time conflict|verifying-time/u.test(log)) return '文案或配图与计划发布时间不一致，需重新准备';
  if (stage === 'publish') return '发布未完成，已保留记录以避免重复发送';
  if (/image_edit_error=transport-failed|curl_exit=(?:5|6|7|18|28|35|52|55|56|92)\b/u.test(log)) return '图片接口连接中断或超时';
  if (/http=(?:401|403)\b/u.test(log)) return '图片接口鉴权或权限检查失败';
  if (/http=429\b/u.test(log)) return '图片接口额度不足或暂时限流';
  if (/visual-verification-unavailable/u.test(log)) return '图片已生成，但质量复核暂不可用';
  if (/quality|verification-rejected/u.test(log)) return '图片生成或质量验收未完成';
  return '图文准备未完成';
}

export function failureText({ date, attempt, stage, reason, retryAt, makeup, resolved }) {
  if (resolved) return `${date} 的爱莉空间每日图文此前准备失败：${reason}。现已补发成功，并回读确认了文案和 1 张配图。后续准备失败会在当天随机重试，并私聊通知你。`;
  const next = retryAt ? `${new Date(retryAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(11, 16)}（北京时间）` : null;
  return `${date} 的爱莉空间${makeup ? '补发' : '每日图文'}${stage === 'publish' ? '发布' : '准备'}未完成（第 ${attempt} 次）：${reason}。`
    + (next ? `已安排今天 ${next} 随机重试准备，届时重新选择发布时间。` : '未自动安排更多尝试，请检查后处理。')
    + '尚未确认发布成功；不会用缺图内容代替。';
}

async function deliverFailure(payload) {
  const base = '/root/.openclaw';
  const config = JSON.parse(fs.readFileSync(`${base}/openclaw.json`, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(`${base}/onebot-features.json`, 'utf8'));
  const targetId = policy.accounts.default.privateAdminIds[0];
  if (!targetId) throw new Error('Missing registered private owner');
  const secret = fs.readFileSync(`${base}/secrets/onebot-delivery.key`, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${config.gateway?.port ?? 18789}/onebot/internal/deliver`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'qzone-daily', originJobId: PREPARE_JOB_ID, targetId, ...payload }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Notification ingress HTTP ${response.status}`);
  const result = await response.json();
  return { deliveryId: result.id, state: result.state, messageId: result.receipt?.primaryPlatformMessageId };
}

// Store the exact notification once before handing it to the existing durable
// queue. Retrying submission reuses its identity; it never creates another send.
export async function notifyDailyFailure(state, stage, { persist, deliver = deliverFailure, now = Date.now() } = {}) {
  state.failureNotifications ??= {};
  const key = `${stage}:${state.makeupRequestedAt ?? 'daily'}:${state.prepareAttempts ?? 1}`;
  let notice = state.failureNotifications[key];
  if (notice?.state === 'accepted') return notice;
  if (!notice) {
    const fields = { date: state.date, attempt: state.prepareAttempts ?? 1, stage,
      reason: state.failureReason ?? '图文准备未完成', retryAt: state.retryAt ?? null, makeup: !!state.makeupRequestedAt,
      resolved: state.status === 'published' && !!state.tid };
    notice = state.failureNotifications[key] = { dedupeKey: `qzone-daily:${state.date}:${key}`, text: failureText(fields), state: 'pending', created: now };
    persist(state);
  }
  try {
    const receipt = await deliver({ dedupeKey: notice.dedupeKey, text: notice.text });
    Object.assign(notice, receipt, { updated: now });
  } catch { notice.state = 'submission_uncertain'; notice.updated = now; }
  persist(state);
  return notice;
}

export async function recoverPreparationFailure(state, { now = Date.now(), random = crypto.randomInt, persist,
  schedule, notify = notifyDailyFailure, cancelPublication = async () => {} } = {}) {
  if (state.status === 'retry_waiting' && state.retryJobId && state.retryAt > now) return { reused: true, retryAt: state.retryAt };
  state.status = 'failed';
  state.retryAt = choosePrepareRetry(state, now, random);
  // Disable stale publication before creating a retry. A failed schedule or
  // notification must not undo the original failed preparation state.
  persist(state);
  try { await cancelPublication(state); } catch { state.publicationDisableFailed = true; }
  if (state.retryAt) {
    try {
      const id = await schedule(state.retryAt, (state.prepareAttempts ?? 1) + 1);
      state.retryJobId = id; state.status = 'retry_waiting';
    } catch { state.retryAt = null; state.retryScheduleFailed = true; }
  }
  persist(state);
  await notify(state, 'prepare', { persist, now });
  return { retryAt: state.retryAt, retryJobId: state.retryJobId ?? null };
}

export function retryMayRun(state, expectedAttempt, now = Date.now()) {
  return !!state && state.date === dateAt(now) && state.status === 'retry_waiting'
    && Number.isInteger(expectedAttempt) && expectedAttempt === (state.prepareAttempts ?? 1) + 1
    && now >= state.retryAt && now < Date.parse(`${state.date}T20:30:00+08:00`)
    && !state.publishStartedAt && !state.tid;
}
