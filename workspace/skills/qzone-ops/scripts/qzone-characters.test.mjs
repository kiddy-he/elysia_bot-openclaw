import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CHARACTER_POLICY, discoverCharacters, chooseCharacterPlan, characterDraftContext, localImageArguments } from './qzone-characters.mjs';

function library(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-characters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, count] of [['爱莉希雅', 2], ['伊甸', 1], ['芽衣', 4], ['空角色', 0]]) {
    fs.mkdirSync(path.join(root, name));
    for (let n = 0; n < count; n++) fs.writeFileSync(path.join(root, name, `${n}.png`), Buffer.from('89504e470d0a1a0a0000000000000000', 'hex'));
  }
  return { ...CHARACTER_POLICY, referenceRoot: root, characters: { 伊甸: { weight: 3 }, 芽衣: { weight: 1 } } };
}
const rolls = (...values) => n => { const value = values.shift(); assert.ok(Number.isInteger(value) && value >= 0 && value < n, `${value} outside ${n}`); return value; };

test('discovery excludes empty folders, fake extensions and symlinks', t => {
  const policy = library(t);
  fs.writeFileSync(path.join(policy.referenceRoot, '芽衣', 'fake.jpg'), 'not-a-real-image');
  fs.symlinkSync(path.join(policy.referenceRoot, '伊甸', '0.png'), path.join(policy.referenceRoot, '芽衣', 'linked.png'));
  const all = discoverCharacters(policy);
  assert.equal(all.length, 3); assert.equal(all.find(x => x.name === '芽衣').images.length, 4);
});
test('solo selects exactly one randomly chosen Elysia reference, exposing no paths to copywriting', t => {
  const policy = library(t), plan = chooseCharacterPlan({ policy, randomInt: rolls(999999, 1) });
  assert.equal(plan.mode, 'solo'); assert.equal(plan.characters.length, 1); assert.match(plan.characters[0].referencePath, /1.png$/);
  assert.equal(JSON.stringify(characterDraftContext(plan)).includes(policy.referenceRoot), false);
  const args = localImageArguments(plan, '白昼爱莉希雅正在整理花束');
  assert.equal(args.length, 3); assert.equal(args[0], 'local-image-generate'); assert.equal(args[2], plan.characters[0].referencePath);
});
test('interaction draws one character by weight, independent of image count; each reference stays ordered', t => {
  const policy = { ...library(t), interactionProbability: 1 }, counts = {};
  for (let ticket = 0; ticket < 4; ticket++) {
    const plan = chooseCharacterPlan({ policy, randomInt: rolls(0, ticket, 0, 0) });
    assert.equal(plan.mode, 'interaction'); assert.equal(plan.characters[0].name, '爱莉希雅');
    const name = plan.characters[1].name; counts[name] = (counts[name] ?? 0) + 1;
    const args = localImageArguments(plan, `白昼爱莉希雅与${name}一起布置花篮`);
    assert.equal(args.length, 4); assert.match(args[1], /参考图1唯一对应崩坏3角色「爱莉希雅」/);
    assert.ok(args[1].includes(`参考图2唯一对应崩坏3角色「${name}」`));
  }
  assert.deepEqual(counts, { 芽衣: 1, 伊甸: 3 });
});
test('no companions falls back to solo; no Elysia fails; changed references cannot be submitted', t => {
  const policy = library(t);
  fs.rmSync(path.join(policy.referenceRoot, '伊甸'), { recursive: true });
  fs.rmSync(path.join(policy.referenceRoot, '芽衣'), { recursive: true });
  const plan = chooseCharacterPlan({ policy, randomInt: rolls(0, 0) });
  assert.equal(plan.mode, 'solo'); assert.equal(plan.soloFallback, true);
  fs.appendFileSync(plan.characters[0].referencePath, 'changed');
  assert.throws(() => localImageArguments(plan, 'test'), /changed/);
  fs.rmSync(path.join(policy.referenceRoot, '爱莉希雅'), { recursive: true });
  assert.throws(() => chooseCharacterPlan({ policy }), /unavailable/);
});
test('new characters with valid references join using configured default weight', t => {
  const policy = library(t);
  fs.mkdirSync(path.join(policy.referenceRoot, '新角色'));
  fs.copyFileSync(path.join(policy.referenceRoot, '爱莉希雅', '0.png'), path.join(policy.referenceRoot, '新角色', '0.png'));
  assert.equal(discoverCharacters(policy).find(x => x.name === '新角色').weight, 3);
});
test('local reference adapter preserves actual image bytes and rejects files outside the library', () => {
  const file = discoverCharacters().find(x => x.name === '爱莉希雅').images[0];
  const helper = '/root/.openclaw/workspace/skills/agy-proxy/scripts/local-reference.py';
  const parts = JSON.parse(execFileSync('python3', [helper, 'parts', file], { maxBuffer: 64 * 1024 * 1024 }));
  assert.deepEqual(Buffer.from(parts[0].image_url.split(',')[1], 'base64'), fs.readFileSync(file));
  assert.throws(() => execFileSync('python3', [helper, 'validate', '/etc/hosts'], { stdio: 'pipe' }));
});
