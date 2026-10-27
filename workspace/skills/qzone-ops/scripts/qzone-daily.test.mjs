import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { chinaDate, choosePublishAt, findPublished, publishState, readQualityReceipt, makeupState, schedulePrepareRetry, ensurePublishJob } from "./qzone-daily.mjs";

test("random slots stay inside the China-time window, including late setup and midnight boundaries", () => {
  const date = "2026-10-17", before = Date.parse(`${date}T06:15:00+08:00`);
  const first = choosePublishAt(date, before, 90 * 60000, () => 0);
  const last = choosePublishAt(date, before, 90 * 60000, (n) => n - 1);
  assert.equal(first, Date.parse(`${date}T08:00:00+08:00`));
  assert.ok(last < Date.parse(`${date}T22:00:00+08:00`));
  assert.ok(last > Date.parse(`${date}T21:59:00+08:00`));
  assert.equal(choosePublishAt(date, Date.parse(`${date}T21:00:00+08:00`)), null);
  assert.equal(chinaDate(Date.parse("2026-10-16T16:01:00Z")), date);
});

function ready(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qzone-state-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, "verified-image"); fs.writeFileSync(imagePath, "test-image");
  fs.writeFileSync(`${imagePath}.quality.json`, JSON.stringify({ policy_version: "anatomy-v1", passed: true,
    image_sha256: crypto.createHash("sha256").update("test-image").digest("hex"), anatomy_score: 100, compliance_score: 95,
    anatomy_consistent: true, all_expected_characters_present: true, no_extra_characters: true, scene_and_actions_match: true,
    identity_mapping_confident: true, source_pose_and_layout_replaced: true, scene_directed_pose_and_gaze: true,
    severe_anatomy_errors: [], failures: [] }));
  return { date: "2026-10-17", status: "ready", caption: "unique-caption", visibility: 4, imageVerified: true, imagePath,
    imageSha256: crypto.createHash("sha256").update("test-image").digest("hex") };
}

test("publication persists before writing, checks readback, and never posts twice", async (t) => {
  const state = ready(t), persisted = [], calls = [];
  const deps = {
    persist: (s) => persisted.push(s.status),
    upload: async () => ({ account: "default", richval: "x", pic_bo: "x" }),
    post: async (args) => { assert.equal(persisted.at(-1), "publishing"); calls.push(args); return { code: 0, tid: "post123456" }; },
    getPosts: async () => [{ tid: "post123456", content: state.caption, pic: [{}] }],
    wait: async () => {},
    verifyImage: async () => ({ width: 320, height: 320, codec: "mjpeg" }),
  };
  assert.equal((await publishState(state, deps)).verified, true);
  assert.equal((await publishState(state, deps)).skipped, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ugcRight, 4);
});

test("a timed-out external write is reconciled rather than retried", async (t) => {
  const state = ready(t); let writes = 0;
  const deps = { persist: () => {}, upload: async () => ({}), getPosts: async () => [], post: async () => { writes++; throw new Error("timeout"); }, verifyImage: async () => ({ width: 320, height: 320 }) };
  await assert.rejects(publishState(state, deps), /timeout/);
  assert.equal(state.status, "uncertain");
  await assert.rejects(publishState(state, deps), /refused to repost/);
  assert.equal(writes, 1);
  deps.getPosts = async () => [{ tid: "recovered123", content: state.caption, pic: [{}], created_time: Math.floor(state.publishStartedAt / 1000) }];
  assert.equal((await publishState(state, deps)).reconciled, true);
  assert.equal(writes, 1);
});

test("missing or modified images cannot be published", async (t) => {
  const state = ready(t); fs.writeFileSync(state.imagePath, "changed");
  await assert.rejects(publishState(state), /intact verified draft/);
});

test("legacy or severe-anatomy assessments cannot be used to publish a daily post", async (t) => {
  const state = ready(t), receiptPath = `${state.imagePath}.quality.json`;
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  for (const changes of [{ policy_version: "old" }, { anatomy_score: 89 }, { severe_anatomy_errors: ["extra arm"] }, { image_sha256: "wrong" }]) {
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...changes }));
    assert.throws(() => readQualityReceipt(state.imagePath), /anatomy-quality/);
    await assert.rejects(publishState(state), /anatomy-quality/);
  }
});

test("daily publication accepts the highest of exactly three scored failures", async (t) => {
  const state = ready(t), receiptPath = `${state.imagePath}.quality.json`;
  const base = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const candidates = [60, 80, 70].map((score, index) => ({ ...base,
    expected_count: 1, visible_character_count: 1, anatomy_score: score, compliance_score: 80,
    anatomy_consistent: false, severe_anatomy_errors: ["extra hand"], failures: ["extra hand"],
    passed: false, weighted_score: Math.round((score * 0.7 + 24) * 100) / 100,
    image_sha256: index === 1 ? base.image_sha256 : String(index).repeat(64),
  }));
  const fallback = { ...candidates[1], accepted_for_delivery: true,
    selection: { policy: "best-of-three-v1", candidate_count: 3, selected_index: 1, candidates } };
  fs.writeFileSync(receiptPath, JSON.stringify(fallback));
  assert.equal(readQualityReceipt(state.imagePath).passed, false);
  const result = await publishState(state, {
    persist: () => {}, upload: async () => ({ account: "default", richval: "x", pic_bo: "x" }),
    post: async () => ({ code: 0, tid: "fallback-post-123" }),
    getPosts: async () => [{ tid: "fallback-post-123", content: state.caption, pic: [{}] }],
    verifyImage: async () => ({ width: 320, height: 320, codec: "mjpeg" }),
  });
  assert.equal(result.verified, true);
  fallback.selection.candidates.pop();
  fs.writeFileSync(receiptPath, JSON.stringify(fallback));
  assert.throws(() => readQualityReceipt(state.imagePath));
});

test("ambiguous recovery candidates cannot cause deletion or reposting", async () => {
  const state = { caption: "x", publishStartedAt: Date.now() };
  const post = { content: "x", created_time: Math.floor(Date.now() / 1000), pic: [{}] };
  assert.equal(await findPublished(state, async () => [{ ...post, tid: "a" }, { ...post, tid: "b" }]), null);
});

test('explicit yesterday makeup keeps original content and uses the ordinary quality-checked publish once', async t => {
  const state = { ...ready(t), date: '2026-10-18', account: 'default', status: 'failed', scene: 'original scene' };
  let writes = 0; const persisted = [];
  const deps = { now: Date.parse('2026-10-19T01:00:00+08:00'), persist: value => persisted.push(value.status), getPosts: async () => [],
    publish: async (value, { persist }) => { writes++; assert.equal(value.caption, 'unique-caption'); assert.equal(value.date, '2026-10-18'); assert.equal(value.imageVerified, true);
      value.status = 'published'; value.tid = 'makeup-post-123'; persist(value); return { tid: value.tid, verified: true }; },
  };
  assert.equal((await makeupState(state, state.imagePath, deps)).verified, true);
  assert.equal(state.makeupForDate, '2026-10-18');
  assert.equal((await makeupState(state, state.imagePath, deps)).skipped, true); assert.equal(writes, 1);
});

test('makeup refuses other dates, duplicate captions and unverified images, and never resets uncertain publication', async t => {
  const state = { ...ready(t), date: '2026-10-18', account: 'default', scene: 'original scene' };
  const deps = { now: Date.parse('2026-10-19T01:00:00+08:00'), persist() {}, getPosts: async () => [] };
  await assert.rejects(makeupState({ ...state, date: '2026-10-17' }, state.imagePath, deps), /limited to yesterday/u);
  await assert.rejects(makeupState(state, state.imagePath, { ...deps, getPosts: async () => [{ content: state.caption }] }), /already exists/u);
  const uncertain = { ...state, status: 'uncertain', publishStartedAt: Date.now() };
  await assert.rejects(makeupState(uncertain, state.imagePath, deps), /refused to repost/u);
  assert.equal(uncertain.status, 'uncertain');
  fs.writeFileSync(state.imagePath, 'tampered');
  await assert.rejects(makeupState(state, state.imagePath, deps), /anatomy-quality/u);
});

test('random retry job is disabled first, bound to exact date/attempt, persisted and only then enabled; replay reuses declaration', () => {
  const state = { date: '2026-10-19' }, calls = [], jobs = [];
  const deps = { persist: s => { calls.push(['persist', s.retryJobId]); },
    runFile: (file, args) => { calls.push(['bind', ...args.slice(1)]); },
    runCron: args => {
      calls.push(args);
      if (args[0] === 'list') return { jobs };
      if (args[0] === 'add') { assert.ok(args.includes('--disabled')); const job = { id: 'retry-123', declarationKey: args[args.indexOf('--declaration-key') + 1] }; jobs.push(job); return job; }
      if (args[0] === 'enable') assert.ok(calls.some(c => c[0] === 'bind' && c.includes('add-qzone-retry') && c.at(-1) === '2'));
      return { ok: true };
    },
  };
  const at = Date.parse('2026-10-19T07:00:00+08:00');
  assert.equal(schedulePrepareRetry(state, at, 2, deps), 'retry-123');
  assert.equal(schedulePrepareRetry(state, at, 2, deps), 'retry-123');
  assert.equal(calls.filter(c => c[0] === 'add').length, 1);
  const edit = calls.find(c => c[0] === 'edit');
  assert.equal(edit[edit.indexOf('--at') + 1], new Date(at).toISOString());
  assert.match(edit[edit.indexOf('--command-argv') + 1], /run-scheduled.mjs/u);
});

test('a disabled stale publish job is rescheduled to the new random time and re-enabled without creating another post job', () => {
  const state = { date: '2026-10-19', status: 'ready', publishAt: Date.parse('2026-10-19T18:30:00+08:00') }, calls = [];
  ensurePublishJob(state, { persist() {}, runFile: (file, args) => calls.push(['bind', ...args]), runCron: args => {
    calls.push(args);
    if (args[0] === 'list') return { jobs: [{ id: 'stale-publish', enabled: false, declarationKey: 'qzone-elysia-publish:2026-10-19' }] };
    return {};
  } });
  assert.equal(state.publishJobId, 'stale-publish');
  assert.equal(calls.some(c => c[0] === 'add'), false);
  const edit = calls.find(c => c[0] === 'edit');
  assert.equal(edit[edit.indexOf('--at') + 1], new Date(state.publishAt).toISOString());
  assert.ok(calls.some(c => c[0] === 'enable' && c[1] === 'stale-publish'));
});
