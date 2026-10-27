import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qzonePreparationImageGrant } from '../src/src/access/services.js';

const script = fileURLToPath(new URL('../scripts/bind-scheduled.mjs', import.meta.url));
const id = '00000000-0000-4000-8000-000000000099';
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'qzone-retry-bind-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const name of ['onebot-features.json', 'onebot-services.json']) writeFileSync(join(root, name), readFileSync(`${process.env.ONEBOT_CONFIG_ROOT || '/root/.openclaw'}/${name}`));
    return { root, run: args => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, ONEBOT_CONFIG_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] }),
        read: name => JSON.parse(readFileSync(join(root, name), 'utf8')) };
}

test('real binding CLI registers and removes one bounded Qzone retry without changing unrelated feature permissions', t => {
    const f = fixture(t), before = f.read('onebot-features.json'), services = f.read('onebot-services.json');
    f.run(['add-qzone-retry', id, '2099-01-01', 'true', '2']);
    const registered = f.read('onebot-features.json'), subject = f.read('onebot-services.json').jobs[id];
    assert.deepEqual(registered.automationBindings[id], { feature: 'qzone', name: 'qzone-elysia-prepare-retry-2099-01-01-2', enabled: true, deliveryGroupIds: [] });
    assert.equal(subject.kind, 'command'); assert.equal(subject.accountId, 'default');
    assert.deepEqual(subject.argv.slice(-3), ['prepare-retry', '2099-01-01', '2']);
    assert.equal(qzonePreparationImageGrant(id, 'images', 'reference', 'default', registered, f.read('onebot-services.json')), true);
    for (const args of [['images','generate','default'],['images','reference','yuexia'],['qzone','reference','default']])
        assert.equal(qzonePreparationImageGrant(id, ...args, registered, f.read('onebot-services.json')), false);
    const disabled = structuredClone(registered); disabled.automationBindings[id].enabled = false;
    assert.equal(qzonePreparationImageGrant(id, 'images', 'reference', 'default', disabled, f.read('onebot-services.json')), false);
    const forged = structuredClone(f.read('onebot-services.json')); forged.jobs[id].argv[2] = 'publish';
    assert.equal(qzonePreparationImageGrant(id, 'images', 'reference', 'default', registered, forged), false);
    const unrelated = structuredClone(registered); delete unrelated.automationBindings[id]; assert.deepEqual(unrelated, before);
    f.run(['remove', id]);
    assert.deepEqual(f.read('onebot-features.json'), before); assert.deepEqual(f.read('onebot-services.json'), services);
});

test('retry binding rejects injected dates and attempts outside the daily cap before changing configuration', t => {
    const f = fixture(t), before = f.read('onebot-features.json'), services = f.read('onebot-services.json');
    for (const [date, attempt] of [['2099-01-01;id', '2'], ['2099-01-01', '1'], ['2099-01-01', '7'], ['2099-01-01', '2;id']])
        assert.throws(() => f.run(['add-qzone-retry', id, date, 'true', attempt]));
    assert.deepEqual(f.read('onebot-features.json'), before); assert.deepEqual(f.read('onebot-services.json'), services);
});

test('patrol is a fixed command service with no group delivery or open-ended agent tools', t => {
    const f = fixture(t), before = f.read('onebot-features.json');
    f.run(['add-qzone-patrol', id]);
    const policy = f.read('onebot-features.json'), subject = f.read('onebot-services.json').jobs[id];
    assert.deepEqual(policy.automationBindings[id], { feature: 'qzone', name: 'qzone-elysia-interaction-patrol', enabled: true, deliveryGroupIds: [] });
    assert.equal(subject.kind, 'command'); assert.equal(subject.accountId, 'default');
    assert.deepEqual(subject.argv.slice(-2), ['/root/.openclaw/workspace/skills/qzone-ops/scripts/qzone-patrol.mjs', 'run']);
    delete policy.automationBindings[id]; assert.deepEqual(policy, before);
});
