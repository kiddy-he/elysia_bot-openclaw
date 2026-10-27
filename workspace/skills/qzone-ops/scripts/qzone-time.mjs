import fs from 'node:fs';
import crypto from 'node:crypto';
export const TIME_POLICY = JSON.parse(fs.readFileSync(new URL('./qzone-time-policy.json', import.meta.url), 'utf8'));
export function publicationTimeContext(publishAt) {
  if (!Number.isSafeInteger(publishAt)) throw new Error('Invalid planned publication time');
  const china = new Date(publishAt + 8 * 3600000).toISOString();
  const hour = Number(china.slice(11, 13));
  const period = TIME_POLICY.periods.find(item => hour >= item.startHour && hour < item.endHour);
  if (!period) throw new Error('Planned publication outside 08:00–22:00');
  return { policyVersion: TIME_POLICY.version, timezone: TIME_POLICY.timezone, publishAt: china.replace('Z', '+08:00'),
    period: period.id, label: period.label, lighting: period.lighting, activities: period.activities, forbidden: period.forbidden,
    validFrom: Date.parse(`${china.slice(0, 10)}T${String(period.startHour).padStart(2, '0')}:00:00+08:00`),
    validUntil: Date.parse(`${china.slice(0, 10)}T${String(period.endHour).padStart(2, '0')}:00:00+08:00`) };
}
export function chooseTimeTheme(publishAt, recent = [], random = crypto.randomInt) {
  const time = publicationTimeContext(publishAt);
  const themes = TIME_POLICY.periods.find(item => item.id === time.period).themes;
  const used = new Set(recent.slice(-4).map(item => item.theme));
  const fresh = themes.filter(theme => !used.has(theme));
  const candidates = fresh.length ? fresh : themes;
  return candidates[random(candidates.length)];
}
export function assertTimeDraft(draft, time) {
  if (typeof draft?.caption !== 'string' || typeof draft?.scene !== 'string') throw new Error('Missing time-aligned draft');
  const data = `${draft.caption}\n${draft.scene}`;
  const conflict = time.forbidden.split('、').find(word => word && data.includes(word));
  if (conflict || /昨晚|昨夜|回忆.*(?:夜|晚)|梦境|旧照片/u.test(data)) throw new Error('Publication-time conflict in draft');
  const english = time.period === 'night' ? /\b(?:morning|midday|noon|daylight|sunrise)\b/iu
    : ['morning', 'noon', 'afternoon'].includes(time.period) ? /\b(?:night|nighttime|moonlight|starlit|bedtime|sunset|dusk)\b/iu : /\b(?:morning|midday|noon|midnight|bedtime)\b/iu;
  if (english.test(data)) throw new Error('Publication-time conflict in draft');
  return true;
}
export function timeBoundScene(scene, time) {
  return `${scene}\n【发布时间硬约束】描绘爱莉希雅在计划发布当下正在进行的活动。北京时间${time.publishAt}，时段为${time.label}。光照与背景：${time.lighting}。活动：${time.activities}。不要出现：${time.forbidden}。不要通过回忆昨晚、梦境、插叙、旧照片或隔夜活动来绕过时间匹配。文案、动作、服装、环境与光照必须同时符合当前时段。`;
}
export function alignedReschedule(time, now = Date.now(), leadMs = 60000, random = crypto.randomInt) {
  const start = Math.ceil(Math.max(time.validFrom, now + leadMs) / 1000) * 1000;
  if (start >= time.validUntil) return null;
  return start + random(Math.ceil((time.validUntil - start) / 1000)) * 1000;
}
export function assertTimeReceipt(state, now = Date.now()) {
  const time = state.timeContext;
  if (state.timePolicy !== TIME_POLICY.version || !time || !Number.isSafeInteger(state.publishAt)) throw new Error('Missing publication-time verification');
  const planned = publicationTimeContext(state.publishAt), actual = publicationTimeContext(now);
  if (planned.period !== time.period || actual.period !== time.period || planned.validFrom !== time.validFrom || actual.validFrom !== time.validFrom)
    throw new Error('Publication time crossed prepared period; regenerate required');
  assertTimeDraft({ caption: state.caption, scene: state.scene }, time);
  const receipt = JSON.parse(fs.readFileSync(`${state.imagePath}.time.json`, 'utf8'));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(state.imagePath)).digest('hex');
  if (receipt.policy_version !== TIME_POLICY.version || receipt.passed !== true || receipt.period !== time.period || receipt.date !== state.date
      || receipt.image_sha256 !== hash || receipt.caption_sha256 !== crypto.createHash('sha256').update(state.caption).digest('hex')
      || receipt.scene_sha256 !== crypto.createHash('sha256').update(state.scene).digest('hex')
      || ['lighting_matches', 'activity_matches', 'caption_matches', 'no_temporal_conflict'].some(key => receipt[key] !== true)
      || !Array.isArray(receipt.failures) || receipt.failures.length) throw new Error('Missing or failed publication-time visual verification');
  return receipt;
}
