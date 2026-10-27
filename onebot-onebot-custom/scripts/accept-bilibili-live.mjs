import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? `/root/.openclaw/state/bilibili-live-persona-20261019/isolated-${Date.now()}`);
if (!root.includes('/isolated-')) throw new Error('use an isolated-* output directory');
await mkdir(root, { recursive: true, mode: 0o700 });
for (const name of ['onebot-app-config.json', 'onebot-model-routing.json', 'onebot-role-routing.json', 'onebot-executors.json', 'onebot-features.json', 'onebot-services.json', 'onebot-workspaces.json', 'onebot-delivery.json'])
    await copyFile(`/root/.openclaw/${name}`, join(root, name));
const secret = randomUUID() + randomUUID();
await writeFile(join(root, 'bili-secret'), secret, { mode: 0o600 });
const live = { kind: 'live-start', uid: '123456', roomId: '234567', upName: '测试主播', title: '一起聊聊新游戏', areaName: '游戏杂谈', startedAt: '2099-01-01 12:00:00' };
const text = '嗨♪ 测试主播开播啦，这次的标题是「一起聊聊新游戏」，就在游戏杂谈分区。有空的朋友，和我一起去直播间看看吧！';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const policy = JSON.parse(await readFile(join(root, 'onebot-features.json'), 'utf8')); policy.features.bilibili.enabled = true;
if (!policy.features.bilibili.groupIds.includes('700000011')) policy.features.bilibili.groupIds.push('700000011');
await writeFile(join(root, 'onebot-features.json'), JSON.stringify(policy));
await writeFile(join(root, 'onebot-bilibili.json'), JSON.stringify({ version: 1, enabled: true, liveNotifications: { enabled: true }, secretFile: join(root, 'bili-secret'),
    routes: [{ targetId: 'live-test', uid: live.uid, event: 'live', accountId: 'default', groupId: '700000011', enabled: true }] }));
const sends = []; let models = 0; let release; let logs = ''; let child; let report;
const modelGate = new Promise(resolve => { release = resolve; });
const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/chat/completions') {
        models++; await modelGate;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] })); return;
    }
    if (req.url.startsWith('/send_')) sends.push({ endpoint: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? { user_id: 123456789, nickname: 'isolated-test' } : { message_id: 8800000 + sends.length } }));
});
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve)); const fakePort = fake.address().port;
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const gatewayPort = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const config = { gateway: { mode: 'local', bind: 'loopback', port: gatewayPort, auth: { mode: 'token', token: randomUUID() } }, cron: { enabled: false },
    agents: { defaults: { workspace: join(root, 'workspace'), heartbeat: { every: '0m' } }, entries: { main: { default: true } } },
    channels: { onebot: { enabled: true, httpUrl: `http://127.0.0.1:${fakePort}`, wsUrl: 'ws://127.0.0.1:21988', allowFrom: ['group:700000011'], sharedDir: join(root, 'shared'), containerSharedDir: join(root, 'shared') } },
    models: { providers: { antigravity: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'synthetic-test-only', models: [{ id: 'gemini-3.8-flash-high', name: 'test', contextWindow: 32768, maxTokens: 1024 }] } } },
    plugins: { allow: ['openclaw-onebot'], load: { paths: ['/root/.openclaw/extensions/openclaw-onebot'] }, slots: { memory: 'none' }, entries: { 'openclaw-onebot': { enabled: true } } } };
await writeFile(join(root, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 });
const post = body => fetch(`http://127.0.0.1:${gatewayPort}/onebot/bilibili/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bilibili-notify-secret': secret }, body: JSON.stringify(body) });
const waitFor = async (predicate, maxMs) => {
    const start = Date.now(); while (Date.now() - start < maxMs) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('isolated condition timed out');
};
try {
    child = spawn('/usr/local/bin/openclaw', ['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback'], {
        env: { ...process.env, OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'), OPENCLAW_STATE_DIR: join(root, 'state'), ONEBOT_CONFIG_ROOT: root, ONEBOT_OPERATIONS_DB: join(root, 'ops.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error('isolated gateway exited');
        try { return (await fetch(`http://127.0.0.1:${gatewayPort}/onebot/bilibili/events`, { method: 'POST' })).status === 401; } catch { return false; }
    }, 45000);
    const event = { targetId: 'live-test', ts: Date.now(), live, payload: { kind: 'composite', segments: [{ type: 'image', mime: 'image/png', data: png.toString('base64') }, { type: 'text', text: '旧模板\nhttps://live.bilibili.com/234567' }] } };
    const pendingA = post(event); await waitFor(() => models === 1, 10000);
    const pendingB = post({ ...event, ts: Date.now() }); await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(models, 1); assert.equal(sends.length, 0); release();
    const responses = await Promise.all([pendingA, pendingB]); const receipts = [];
    for (const response of responses) { const result = await response.json(); assert.equal(response.status, 202, JSON.stringify(result)); assert.equal(result.state, 'accepted', JSON.stringify(result)); receipts.push(result); }
    assert.equal(sends.length, 1); assert.equal(sends[0].endpoint, '/send_group_msg');
    assert.deepEqual(sends[0].body.message.map(x => x.type), ['image', 'text']);
    assert.equal(sends[0].body.message[1].data.text, `${text}\nhttps://live.bilibili.com/234567`);
    assert.equal(sends[0].body.group_id, 700000011);
    const repeat = await post(event); assert.equal((await repeat.json()).deliveryId, receipts[0].deliveryId); assert.equal(models, 1); assert.equal(sends.length, 1);
    const changed = await post({ ...event, live: { ...live, uid: '999' } }); assert.equal(changed.status, 400); assert.equal(sends.length, 1);
    report = { ok: true, nativeSdk: true, imageHeldUntilCopy: true, imageAndCopyInOneOneBotMessage: true, generatedCopies: models, fakeQqMessages: sends.length,
        dedupedConcurrentReplay: true, mismatchedUidBlocked: true, realQqMessages: 0, receipts };
    console.log(JSON.stringify(report));
} catch (error) { report = { ok: false, error: error.message, realQqMessages: 0 }; console.log(JSON.stringify(report)); process.exitCode = 1; }
finally {
    release(); if (child) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
    fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve));
    await writeFile(join(root, 'gateway.log'), logs, { mode: 0o600 }); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
