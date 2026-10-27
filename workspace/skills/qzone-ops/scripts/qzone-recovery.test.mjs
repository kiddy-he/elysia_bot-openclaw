import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePrepareRetry, recoverPreparationFailure, notifyDailyFailure, retryMayRun, describePreparationFailure, failureText } from './qzone-recovery.mjs';

const date = '2026-10-19';
const morning = Date.parse(`${date}T06:17:00+08:00`);
const failed = () => ({ date, status: 'failed', prepareAttempts: 1, failureReason: '图片接口连接中断或超时' });

test('retry picks a fresh bounded random time on the same day and reserves preparation/publication time', () => {
  const first = choosePrepareRetry(failed(), morning, () => 0);
  const last = choosePrepareRetry(failed(), morning, n => n - 1);
  assert.equal(first, morning + 15 * 60000); assert.equal(last, morning + 60 * 60000);
  const late = Date.parse(`${date}T20:00:00+08:00`);
  assert.ok(choosePrepareRetry(failed(), late, n => n - 1) < Date.parse(`${date}T20:30:00+08:00`));
  assert.equal(choosePrepareRetry(failed(), Date.parse(`${date}T20:20:00+08:00`)), null);
  assert.equal(choosePrepareRetry({ ...failed(), prepareAttempts: 6 }, morning), null);
  assert.equal(choosePrepareRetry({ ...failed(), date: '2026-10-18' }, morning), null);
  for (const status of ['published', 'publishing', 'uncertain', 'ready', 'expired']) assert.equal(choosePrepareRetry({ ...failed(), status }, morning), null);
  assert.equal(choosePrepareRetry({ ...failed(), publishStartedAt: morning }, morning), null);
});

test('preparation failure disables stale publication, persists a unique retry and notifies the owner once', async () => {
  const state = failed(), calls = [];
  const deps = { now: morning, random: () => 0, persist: value => calls.push(`saved:${value.status}`),
    cancelPublication: async () => calls.push('disable'),
    schedule: async (at, attempt) => { calls.push('schedule'); assert.equal(at, morning + 15 * 60000); assert.equal(attempt, 2); return 'retry-id'; },
    notify: async (value, stage) => { calls.push('notify'); assert.equal(value.status, 'retry_waiting'); assert.equal(stage, 'prepare'); },
  };
  await recoverPreparationFailure(state, deps);
  assert.equal(state.status, 'retry_waiting'); assert.equal(state.retryJobId, 'retry-id');
  assert.ok(calls.indexOf('disable') < calls.indexOf('schedule')); assert.ok(calls.indexOf('schedule') < calls.indexOf('notify'));
  assert.equal((await recoverPreparationFailure(state, deps)).reused, true);
  assert.equal(calls.filter(x => x === 'schedule').length, 1); assert.equal(calls.filter(x => x === 'notify').length, 1);
});

test('scheduled retries only run for the expected attempt when due, and stale/next-day invocations do nothing', () => {
  const state = { ...failed(), status: 'retry_waiting', retryAt: morning + 15 * 60000 };
  assert.equal(retryMayRun(state, 2, morning), false);
  assert.equal(retryMayRun(state, 2, state.retryAt), true);
  assert.equal(retryMayRun(state, 3, state.retryAt), false);
  assert.equal(retryMayRun({ ...state, status: 'drafting', prepareAttempts: 2 }, 2, state.retryAt), false);
  assert.equal(retryMayRun({ ...state, tid: 'already-posted' }, 2, state.retryAt), false);
  assert.equal(retryMayRun(state, 2, Date.parse(`${date}T22:01:00+08:00`)), false);
  assert.equal(retryMayRun(state, 2, Date.parse('2026-10-20T06:00:00+08:00')), false);
});

test('terminal daily failure notifies without scheduling; registration failure never advertises a scheduled retry', async () => {
  for (const capped of [true, false]) {
    const state = { ...failed(), prepareAttempts: capped ? 6 : 1 }; let notices = 0, schedules = 0;
    await recoverPreparationFailure(state, { now: morning, random: () => 0, persist() {},
      schedule: async () => { schedules++; throw new Error('cron unreachable'); },
      notify: async value => { notices++; assert.equal(value.status, 'failed'); assert.equal(value.retryAt, null); },
    });
    assert.equal(notices, 1); assert.equal(schedules, capped ? 0 : 1);
    assert.equal(state.retryScheduleFailed, capped ? undefined : true);
  }
});

test('notification acceptance is durable and independent from business retry state', async () => {
  const state = { ...failed(), status: 'retry_waiting', retryAt: morning + 15 * 60000 };
  let calls = 0; const deps = { now: morning, persist() {}, deliver: async payload => {
    calls++; assert.match(payload.text, /06:32/u); assert.doesNotMatch(payload.text, /\/root|curl|sk-|私聊内容/u);
    return { state: 'accepted', deliveryId: 'durable-1', messageId: 'platform-1' };
  } };
  assert.equal((await notifyDailyFailure(state, 'prepare', deps)).state, 'accepted');
  const reopened = JSON.parse(JSON.stringify(state));
  assert.equal((await notifyDailyFailure(reopened, 'prepare', deps)).messageId, 'platform-1');
  assert.equal(calls, 1); assert.equal(state.status, 'retry_waiting');
});

test('notification timeout preserves exact identity and text for durable reconciliation without duplicating sends', async () => {
  const state = failed(), sent = [];
  const deps = { now: morning, persist() {}, deliver: async payload => { sent.push(payload); if (sent.length === 1) throw new Error('lost receipt'); return { state: 'accepted', messageId: 'one-message' }; } };
  assert.equal((await notifyDailyFailure(state, 'prepare', deps)).state, 'submission_uncertain');
  state.retryAt = morning + 1800000;
  await notifyDailyFailure(state, 'prepare', deps);
  assert.deepEqual(sent[0], sent[1]);
  state.prepareAttempts++;
  await notifyDailyFailure(state, 'prepare', deps);
  assert.notEqual(sent[1].dedupeKey, sent[2].dedupeKey);
});

test('safe failure summaries never forward raw provider responses, credentials or local paths', () => {
  const reason = describePreparationFailure('image_edit_error=transport-failed\napi_key=secret\n/root/private');
  assert.equal(reason, '图片接口连接中断或超时');
  const text = failureText({ date, attempt: 6, stage: 'prepare', reason, retryAt: null });
  assert.match(text, /未自动安排更多尝试/u); assert.doesNotMatch(text, /secret|\/root|api_key/u);
});
