import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TIME_POLICY, publicationTimeContext, chooseTimeTheme, assertTimeDraft, timeBoundScene, alignedReschedule, assertTimeReceipt } from './qzone-time.mjs';
import { publishState } from './qzone-daily.mjs';

const at = time => Date.parse(`2099-01-02T${time}:00+08:00`);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const caption = '午间在窗边翻翻新书，顺手给花瓶换了水，明亮的日光落在粉色花瓣上，连今天的小小心情也变得轻快起来了♪';
const scene = '午间明亮日光下，爱莉希雅在窗边坐着翻书，白昼的花园在窗外清晰可见，桌上摆着花瓶与茶杯。';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-time-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'image.png'); fs.writeFileSync(imagePath, 'synthetic-daylight-image');
  const time = publicationTimeContext(at('13:25'));
  const state = { date: '2099-01-02', account: 'default', status: 'ready', publishAt: at('13:25'), timePolicy: TIME_POLICY.version, timeContext: time,
    caption, scene, visibility: 4, imagePath, imageVerified: true, imageSha256: hash('synthetic-daylight-image') };
  fs.writeFileSync(`${imagePath}.quality.json`, JSON.stringify({ policy_version: 'anatomy-v1', passed: true, image_sha256: state.imageSha256,
    anatomy_score: 100, compliance_score: 95, anatomy_consistent: true, all_expected_characters_present: true, no_extra_characters: true,
    scene_and_actions_match: true, identity_mapping_confident: true, source_pose_and_layout_replaced: true, scene_directed_pose_and_gaze: true,
    severe_anatomy_errors: [], failures: [] }));
  const receipt = { policy_version: TIME_POLICY.version, date: state.date, period: 'noon', passed: true, image_sha256: state.imageSha256,
    caption_sha256: hash(caption), scene_sha256: hash(scene), lighting_matches: true, activity_matches: true, caption_matches: true, no_temporal_conflict: true,
    failures: [], observed_lighting: '明亮的午间自然日光', observed_activity: '窗边阅读' };
  fs.writeFileSync(`${imagePath}.time.json`, JSON.stringify(receipt));
  return { state, receipt, dir, writeReceipt: changes => fs.writeFileSync(`${imagePath}.time.json`, JSON.stringify({ ...receipt, ...changes })) };
}

test('all five publication periods use China time and exact boundaries, independent of preparation time', () => {
  for (const [time, expected] of [['08:00','morning'], ['10:59','morning'], ['11:00','noon'], ['13:59','noon'], ['14:00','afternoon'], ['16:59','afternoon'], ['17:00','evening'], ['18:59','evening'], ['19:00','night'], ['21:59','night']])
    assert.equal(publicationTimeContext(at(time)).period, expected, time);
  for (const time of ['07:59','22:00','23:00']) assert.throws(() => publicationTimeContext(at(time)), /outside/u);
  const time = publicationTimeContext(Date.parse('2099-01-02T05:25:00Z')); assert.equal(time.period, 'noon'); assert.match(time.publishAt, /13:25:00.*\+08:00/u);
});
test('night diary theme can only be chosen for a night slot and all candidates remain available after history exhaustion', () => {
  for (const time of ['08:30', '12:30', '15:30', '18:30']) {
    const period = TIME_POLICY.periods.find(p => p.id === publicationTimeContext(at(time)).period);
    for (let n = 0; n < period.themes.length; n++) assert.notEqual(chooseTimeTheme(at(time), [], () => n), '夜灯下写日记');
  }
  const night = TIME_POLICY.periods.find(p => p.id === 'night');
  assert.equal(chooseTimeTheme(at('20:30'), [], () => night.themes.indexOf('夜灯下写日记')), '夜灯下写日记');
  assert.ok(night.themes.includes(chooseTimeTheme(at('20:30'), night.themes.map(theme => ({ theme })), () => 0)));
});
test('the previous noon post and night background are rejected even if the caption calls it a memory', () => {
  const time = publicationTimeContext(at('13:25'));
  for (const draft of [
    { caption: '午间翻了翻昨夜写的日记', scene: '薄纱窗帘外是深蓝夜色与点点星光，桌角小夜灯洒下暖光' },
    { caption, scene: '深蓝夜空与星空下写日记' },
    { caption: '马上睡前去喝茶', scene },
    { caption, scene: 'Starlit night with a moonlight sky' },
    { caption: '看着旧照片回忆昨天的生活', scene },
  ]) assert.throws(() => assertTimeDraft(draft, time), /conflict/u);
  assert.equal(assertTimeDraft({ caption, scene }, time), true);
  const prompt = timeBoundScene(scene, time); assert.match(prompt, /13:25:00.*北京时间|北京时间.*13:25:00/u); assert.match(prompt, /回忆昨晚/u);
});
test('a delayed generation may only reschedule within its original period; crossing it requires regeneration', () => {
  const time = publicationTimeContext(at('13:25'));
  const first = alignedReschedule(time, at('13:40'), 60000, () => 0);
  const last = alignedReschedule(time, at('13:40'), 60000, n => n - 1);
  assert.equal(first, at('13:41')); assert.ok(last < at('14:00'));
  assert.equal(alignedReschedule(time, at('13:59')), null);
  assert.equal(alignedReschedule(time, at('19:00')), null);
});
test('visual verification is bound to actual image, caption, scene, day and period', t => {
  const f = fixture(t); assert.equal(assertTimeReceipt(f.state, at('13:26')).passed, true);
  for (const changes of [{ passed: false }, { image_sha256: 'changed' }, { caption_sha256: 'changed' }, { scene_sha256: 'changed' },
    { lighting_matches: false }, { activity_matches: false }, { caption_matches: false }, { no_temporal_conflict: false }, { failures: ['night sky'] }, { period: 'night' }, { date: '2099-01-01' }]) {
    f.writeReceipt(changes); assert.throws(() => assertTimeReceipt(f.state, at('13:26')), /verification/u);
  }
  f.writeReceipt({});
  assert.throws(() => assertTimeReceipt({ ...f.state, publishAt: at('19:30') }, at('19:30')), /crossed/u);
  assert.throws(() => assertTimeReceipt(f.state, at('14:00')), /crossed/u);
  assert.throws(() => assertTimeReceipt({ ...f.state, caption: caption + '改动' }, at('13:26')), /verification/u);
});
test('scheduled post checks time before upload and after upload; blocked writes never become uncertain or published', async t => {
  const f = fixture(t); let uploads = 0, posts = 0;
  const deps = { persist() {}, now: () => at('13:26'), upload: async () => { uploads++; return {}; }, post: async () => { posts++; return { tid: 'should-not-write' }; } };
  f.writeReceipt({ passed: false });
  await assert.rejects(publishState(f.state, deps), /verification/u); assert.equal(uploads, 0); assert.equal(posts, 0); assert.equal(f.state.status, 'ready');
  f.writeReceipt({});
  await assert.rejects(publishState(f.state, { ...deps, upload: async () => { uploads++; deps.now = () => at('14:00'); return {}; }, now: () => deps.now() }), /crossed/u);
  assert.equal(posts, 0); assert.equal(uploads, 1); assert.equal(f.state.status, 'ready'); assert.equal(f.state.publishStartedAt, undefined);
});
test('aligned scheduled post publishes once with verified receipt; repeated publish only returns the receipt', async t => {
  const f = fixture(t); let posts = 0;
  const deps = { persist() {}, now: () => at('13:26'), upload: async () => ({}), post: async () => { posts++; return { tid: 'aligned-post' }; },
    getPosts: async () => [{ tid: 'aligned-post', content: f.state.caption, pic: [{}] }], verifyImage: async () => ({ width: 320, height: 320 }) };
  assert.equal((await publishState(f.state, deps)).verified, true);
  assert.equal((await publishState(f.state, deps)).skipped, true); assert.equal(posts, 1);
});
test('Python and JavaScript derive identical time slots and both reject day/night contradictions', () => {
  const script = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('draft',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\na=[]\nfor v in json.loads(sys.argv[2]):\n t=m.time_context(v);a.append(t['period'])\n try:m.validate_time_draft('午间翻了翻昨夜写的日记','夜灯与深蓝夜空',m.time_context('2099-01-02T13:25:00+08:00'));raise AssertionError('must reject')\n except ValueError:pass\nprint(json.dumps(a))\n`;
  const times = ['08:30','12:30','15:30','18:30','20:30'].map(time => publicationTimeContext(at(time)).publishAt);
  const output = execFileSync('python3', ['-c', script, new URL('./qzone-draft.py', import.meta.url).pathname, JSON.stringify(times)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), ['morning','noon','afternoon','evening','night']);
});
