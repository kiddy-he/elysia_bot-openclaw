import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { discoverCharacters } from './qzone-characters.mjs';
const SCRIPT = '/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const native of [false, true]) for (const count of [1, 2]) test(`local ${count}-character ${native ? 'native fallback' : 'Gemini plan'} pipeline passes ordered original bytes and quality assessment`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qzone-local-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chars = discoverCharacters();
  const refs = [chars.find(x => x.name === '爱莉希雅').images[0], ...(count === 2 ? [chars.find(x => x.name === '伊甸').images[0]] : [])];
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ proxy: { api_key: 'synthetic-only' } }));
  fs.writeFileSync(path.join(root, 'noop.py'), '');
  // Mock only model/HTTP responses; exercise payload construction, local copies,
  // multipart assembly, quality schema validation and receipts.
  const output = execFileSync('bash', [fileURLToPath(new URL('./qzone-local-image-fixture.sh', import.meta.url)), SCRIPT, root, ...refs],
    { env: { ...process.env, MOCK_COUNT: String(count), MOCK_NATIVE: native ? '1' : '0' }, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000 });
  const expected = refs.map(file => hash(fs.readFileSync(file)));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json')));
  const planned = plan.input[0].content.filter(x => x.type === 'input_image');
  assert.equal(planned.length, count);
  assert.deepEqual(planned.map(x => hash(Buffer.from(x.image_url.split(',')[1], 'base64'))), expected);
  if (!native) assert.deepEqual(fs.readFileSync(path.join(root, 'edit-hashes.txt'), 'utf8').trim().split('\n'), expected);
  const assessment = JSON.parse(fs.readFileSync(path.join(root, 'quality-request.json')));
  const inline = assessment.contents[0].parts.filter(x => x.inline_data).slice(1);
  assert.deepEqual(inline.map(x => hash(Buffer.from(x.inline_data.data, 'base64'))), expected);
  assert.ok(output.includes(`visual_character_count=${count}`));
  const image = output.match(/^image_output=(.+)$/m)?.[1]; assert.ok(image);
  const receipt = JSON.parse(fs.readFileSync(`${image}.quality.json`));
  assert.equal(receipt.passed, true); assert.equal(receipt.image_sha256, hash(fs.readFileSync(image)));
  assert.deepEqual(refs.map(file => hash(fs.readFileSync(file))), expected);
  fs.rmSync(image); fs.rmSync(`${image}.quality.json`);
});
