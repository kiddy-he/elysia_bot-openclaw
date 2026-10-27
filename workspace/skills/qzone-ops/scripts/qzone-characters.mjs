import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CHARACTER_POLICY = JSON.parse(fs.readFileSync(new URL('./qzone-character-policy.json', import.meta.url), 'utf8'));
const TYPES = new Map([['.png', 'png'], ['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.webp', 'webp']]);
function imageFile(file) {
  const type = TYPES.get(path.extname(file).toLowerCase());
  if (!type) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 12 || stat.size > 32 * 1024 * 1024) return false;
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  return type === 'png' ? head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    type === 'jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255 :
    head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
}
export function discoverCharacters(policy = CHARACTER_POLICY) {
  const root = fs.realpathSync(policy.referenceRoot);
  return fs.readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(dir => {
    const directory = path.join(root, dir.name);
    const images = fs.readdirSync(directory).sort().map(file => path.join(directory, file)).filter(imageFile);
    const spec = policy.characters[dir.name] ?? {};
    return { name: dir.name, images, weight: spec.weight ?? policy.unknownCharacterWeight,
      relationship: spec.relationship ?? '互相尊重的虚构角色日常同伴，不擅自添加恋爱或亲属关系' };
  }).filter(x => x.images.length);
}
function pick(items, randomInt) { return items[randomInt(items.length)]; }
export function chooseCharacterPlan({ policy = CHARACTER_POLICY, randomInt = crypto.randomInt } = {}) {
  if (!Number.isFinite(policy.interactionProbability) || policy.interactionProbability < 0 || policy.interactionProbability > 1)
    throw new Error('Invalid character interaction probability');
  const available = discoverCharacters(policy), main = available.find(x => x.name === policy.protagonist);
  if (!main) throw new Error('Elysia reference images unavailable');
  const others = available.filter(x => x !== main && Number.isSafeInteger(x.weight) && x.weight > 0);
  const wantsInteraction = randomInt(1000000) < Math.round(policy.interactionProbability * 1000000);
  let companion;
  if (wantsInteraction && others.length) {
    const total = others.reduce((sum, x) => sum + x.weight, 0);
    let ticket = randomInt(total);
    companion = others.find(x => { ticket -= x.weight; return ticket < 0; });
  }
  const characters = [main, ...(companion ? [companion] : [])].map((x, index) => {
    const referencePath = pick(x.images, randomInt);
    return { name: x.name, referenceIndex: index + 1, referencePath,
      referenceSha256: crypto.createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex'),
      weight: x.weight, relationship: index ? x.relationship : '说说第一人称主人公' };
  });
  return { policyVersion: policy.version, mode: companion ? 'interaction' : 'solo',
    interactionProbability: policy.interactionProbability, soloFallback: wantsInteraction && !companion,
    characters, eligibleCompanions: others.map(({ name, weight }) => ({ name, weight })) };
}
export function characterDraftContext(plan) {
  return { mode: plan.mode, expectedCharacterCount: plan.characters.length,
    characters: plan.characters.map(({ name, referenceIndex, relationship }) => ({ name, referenceIndex, relationship })),
    referenceRule: '参考图仅锁定人物身份和外观；动作、表情、姿态、视线、构图和背景全部根据本次活动与互动重新设计。服装按活动和时段调整。' };
}
export function localImageArguments(plan, scene) {
  const expected = plan.mode === 'interaction' ? 2 : 1;
  if (plan.characters.length !== expected || plan.characters[0]?.name !== CHARACTER_POLICY.protagonist ||
      new Set(plan.characters.map(x => x.name)).size !== expected) throw new Error('Invalid daily character plan');
  for (const ref of plan.characters) {
    if (!imageFile(ref.referencePath) || crypto.createHash('sha256').update(fs.readFileSync(ref.referencePath)).digest('hex') !== ref.referenceSha256)
      throw new Error('Selected character reference changed or unavailable');
  }
  const mapping = plan.characters.map(x => `参考图${x.referenceIndex}唯一对应崩坏3角色「${x.name}」`).join('；');
  const instruction = `${mapping}。画面恰好出现${expected}位指定角色，每人一次，不混合身份、不添加其他人。参考图仅作人物身份与外观设计参考，绝不照搬原图的动作、表情、姿态、身体朝向、视线、构图、镜头、背景或光照。根据下述活动${expected === 2 ? '和双方互动' : ''}重新设计姿态、表情、手势和视线，让动作有明确对象、身体自然受力，人物真实参与活动；服装以活动和时段要求为准。${scene}`;
  return ['local-image-generate', instruction, ...plan.characters.map(x => x.referencePath)];
}
