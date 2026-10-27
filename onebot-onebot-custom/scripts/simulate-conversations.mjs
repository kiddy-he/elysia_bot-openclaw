import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile, appendFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire('/root/.openclaw/extensions/openclaw-onebot/package.json');
const { WebSocketServer } = require('ws');
const run = promisify(execFile), source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] ?? `/root/.openclaw/state/modular-implementation-20261016/simulation-${Date.now()}`;
if (!output.includes('/simulation-')) throw new Error('use a separate simulation-* directory');
await mkdir(join(output, 'fixtures'), { recursive: true, mode: 0o700 });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2sAAAAASUVORK5CYII=', 'base64');
await writeFile(join(output, 'fixtures/generated.png'), png);
const wav = Buffer.alloc(44 + 6400);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(32000, 24); wav.writeUInt32LE(64000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(6400, 40);
await writeFile(join(output, 'fixtures/speech.wav'), wav);
const sends = [], modelCalls = [], quotes = new Map(), results = [], connections = new Map();
const forwards = new Map(), forwardReads = [];
const privateFileHistory = new Map();
const emittedToolCalls = new Set();
const biliState = { subs: [], targets: [], connections: [], mutations: 0 };
let active = 'startup', nextMessage = 9100000, child, gatewayPort, logs = '', policy, configuration, environment;
let streamSlowHeld = false, releaseStreamSlow, streamSlowReleasedAt;
let workspaceScopes = {};
const privateMarker = `PRIVATE_ONLY_SENTINEL_${randomUUID()}`;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : '';
function answer(body) {
    const messages = body.messages ?? body.input ?? [];
    const text = Array.isArray(messages) ? messages.map(message => textOf(message.content)).join('\n') : textOf(messages);
    const systemText = Array.isArray(messages) ? messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n') : '';
    const agentId = /(?:^|\n)Runtime: agent=([^\s|]+)/u.exec(systemText)?.[1] ?? null;
    modelCalls.push({ at: Date.now(), scenario: active, model: body.model, agentId, agentScope: workspaceScopes[agentId] ?? null, messages, tools: body.tools, privateMarkerPresent: text.includes(privateMarker) });
    void appendFile(join(output, 'model-calls-live.jsonl'), JSON.stringify(modelCalls.at(-1)) + '\n', { mode: 0o600 });
    if (text.includes('语音合成前的独立安全审查员')) {
        if (active.includes('UNAVAILABLE')) return 'invalid-json';
        const allow = !active.includes('BLOCK');
        return JSON.stringify({ allow, persona_ok: allow, privacy_ok: allow, sexual_safe: allow, reason: 'simulated guest review' });
    }
    if (text.includes('QQ 消息做入站分类')) {
        if (active.includes('CLASSIFIER_FAIL')) return 'invalid-json';
        const speech_mode = active.includes('DISABLED') ? 'disabled' : active.includes('LITERAL') ? 'literal'
            : /CASE_TTS|CASE_SPEECH_.*(?:EXPLICIT|TOO_LONG|BLOCK|UNAVAILABLE|NO_KEYWORDS)/u.test(active) ? 'answer' : 'none';
        const reminder_action = active.startsWith('CASE_TIMER_') ? active.includes('LIST') ? 'list' : active.includes('CANCEL') ? 'cancel' : active.includes('DISCUSS') ? 'none' : 'create' : 'none';
        return JSON.stringify({ need_web_search: active.includes('SEARCH'), image_generation: active.includes('IMAGE_GENERATE') || active.includes('IMAGE_EDIT') || active.includes('IMAGE_REFERENCE'), official_reference: active.includes('IMAGE_REFERENCE'), backend_operation: /ADSB|FORBIDDEN|NETWORK|BILI_SUB/u.test(active), speech_mode: process.env.SIMULATION_GROUP_STREAMS === '1' ? 'disabled' : speech_mode, reminder_action: process.env.SIMULATION_GROUP_STREAMS === '1' ? 'list' : reminder_action, xiaohongshu_operation: false, quota_action: active.includes('QUOTA_REFRESH') ? 'refresh' : active.includes('QUOTA') ? 'query' : 'none', rationale: 'synthetic classification' });
    }
    if (text.includes('判断这条 QQ 消息是不是要你生成')) return JSON.stringify({ imageGeneration: /IMAGE_GENERATE|IMAGE_EDIT|IMAGE_REFERENCE/u.test(active), officialReference: active.includes('IMAGE_REFERENCE') });
    if (text.includes('Internal first-speaker arbitration')) return '[[PEER_FIRST role=main]]';
    if (text.includes('message_type=peer_continuation')) return '[[PEER_NO_REPLY score=0]]';
    if (text.includes('三模型') || text.includes('待审批命令') || text.includes('给这台个人服务器')) return JSON.stringify({ decision: active.includes('IMAGE_REFERENCE') ? 'allow' : 'ask', purpose: '模拟控制操作', rationale: '模拟要求人工确认，未访问真实服务' });
    if (text.includes('你在给 QQ 回复做终审')) {
        if (active.includes('CONTENT_NUL') && body.model.startsWith('qwen')) return JSON.stringify({ judgement: 'blocked', reason: 'synthetic blocked', output_text: '' });
        return JSON.stringify({ judgement: 'replaced', reason: 'synthetic fallback', output_text: '备用链路的模拟回复已经准备好。' });
    }
    if (text.includes('judgement') && text.includes('clean|reject')) return JSON.stringify({ judgement: 'clean', reason: 'synthetic review' });
    if (text.includes('草稿开始') && text.includes('改写')) return text.split('草稿开始').at(-1).split('草稿结束')[0].trim() || '模拟消息。';
    if (active === 'CASE_DESTINATION_CRON_GROUP') return 'DESTINATION_GROUP_REMINDER_SENTINEL 该准备吃午饭啦。';
    if (active === 'CASE_DESTINATION_CRON_PRIVATE') return 'DESTINATION_PRIVATE_REMINDER_SENTINEL 该准备休息啦。';
    if (active === 'CASE_CONTEXT_INITIAL') return 'CONTEXT_PRIMARY_INITIAL 已记住你喜欢蓝色。';
    if (active === 'CASE_CONTEXT_FINAL') return 'CONTEXT_PRIMARY_FINAL 我记得刚才确认的安排。';
    if (process.env.SIMULATION_GROUP_STREAMS === '1') {
        const currentText = [...messages].reverse().find(message => message.role === 'user' && /STREAM_[ABCD]/u.test(textOf(message.content)));
        const tag = /STREAM_[ABCD]/u.exec(textOf(currentText?.content))?.[0];
        if (tag) {
            const result = messages.some(message => message.role === 'tool');
            if (tag !== 'STREAM_B' && !result) return { tool: { id: `call_${randomUUID().replaceAll('-', '')}`, name: 'reminder_list', arguments: '{}' } };
            return `${tag}_DONE 这一轮已经完成。`;
        }
    }
    const callKey = `${active}:${body.model}:${text.includes('ROLE_MARKER=yuexia') ? 'yuexia' : 'elysia'}`;
    const toolResults = emittedToolCalls.has(callKey);
    const call = (name, args) => { emittedToolCalls.add(callKey); return { tool: { id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: JSON.stringify(args) } }; };
    if (active.startsWith('CASE_TIMER_')) {
        if (active.includes('DISCUSS')) return '定时器可以在设定的时间触发提醒。';
        const tool = active.includes('LIST') ? 'reminder_list' : active.includes('CANCEL') ? 'reminder_cancel' : 'reminder_create';
        if (!toolResults && body.tools?.some(t => t.function?.name === tool || t.name === tool)) return call(tool,
            tool === 'reminder_create' ? { content: '喝水', delaySeconds: active.includes('FUZZY') ? 10 : 3600, ...(active.includes('FUZZY') ? { recipient: '海盐' } : {}) } : tool === 'reminder_cancel' ? { reminderId: configuration._timerId } : {});
        return '提醒任务已经处理，请以登记的结果为准。';
    }
    if (active.startsWith('CASE_SPEECH_')) {
        const speechKey = `${active}:${agentId}`, tools = body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'tts_synthesize');
        if (/EXPLICIT|TOO_LONG|BLOCK|UNAVAILABLE|LITERAL|NO_KEYWORDS/u.test(active) && tools) {
            if (!emittedToolCalls.has(speechKey)) {
                emittedToolCalls.add(speechKey);
                return call('tts_synthesize', { text: active.includes('TOO_LONG') ? '答'.repeat(201) : active.includes('BLOCK') ? '不合适的测试稿件' : active.includes('LITERAL') ? '不要语音，只用文字' : '今天也要记得好好吃饭哦。' });
            }
            const result = messages.filter(message => message.role === 'tool').map(message => textOf(message.content)).join('\n');
            if (result.includes('\"delivered\":true')) return active.includes('DUP_MEDIA') ? '语音已经送到啦。\nMEDIA:/private/internal.wav' : active.includes('NO_MEDIA') ? '合成结果：{audio_output: /private/internal.wav} 语音发好啦。' : '语音已经送到啦。';
            const path = /audio_output=([^\\\n\s"]+)/u.exec(result)?.[1];
            return path ? `语音好了。\nMEDIA:${path}` : '故意省略工具文字回退，验证网关完整回退。';
        }
        const token = [...text.matchAll(/\[\[VOICE_APPEND:([a-f0-9-]+)\]\]/gu)].at(-1)?.[1];
        return token ? `这是完整的文字回答。[[VOICE_APPEND:${token}]]${active.includes('OVER40') ? '好'.repeat(41) : '也祝你今天有个好心情哦。'}[[/VOICE_APPEND]]` : '这是正常的文字回答。';
    }
    const speechTurn = `${callKey}:speech:${agentId}`;
    const speechTools = body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'tts_synthesize');
    if (active.startsWith('CASE_TTS') && !speechTools) return '语音已准备好。';
    if (active.startsWith('CASE_TTS') && !emittedToolCalls.has(speechTurn)) {
        emittedToolCalls.add(speechTurn); return call('tts_synthesize', { text: '今天你也很可爱哦' });
    }
    if (active.startsWith('CASE_TTS')) {
        if (active.includes('CRON')) return '语音通知已完成。';
        const result = messages.filter(message => message.role === 'tool').map(message => textOf(message.content)).join('\n');
        const path = /audio_output=([^\\\n\s"]+)/u.exec(result)?.[1];
        return path ? `语音已准备好。\nMEDIA:${path}` : '本次语音未完成。';
    }
    if (active.includes('BILI_SUB_MULTIPLE')) for (const uid of ['700000009','700000007']) {
        const key=callKey+':'+uid;if(!emittedToolCalls.has(key)){emittedToolCalls.add(key);return call('bilibili_subscribe',{action:'add',uid,event:'all'});}
    }
    if (!toolResults && active.includes('BILI_SUB') && !active.includes('MULTIPLE')) return call('bilibili_subscribe', { action: active.includes('REMOVE') ? 'remove' : 'add', uid: '123456', event: active.includes('DYNAMIC') ? 'dynamic' : 'all' });
    if (!toolResults && active.includes('ADSB')) return call('adsb_query', { query: 'health' });
    if (!toolResults && active.includes('FORBIDDEN')) return call('adsb_query', { query: 'health' });
    if (!toolResults && active.includes('NETWORK')) return call('network_control', { action: 'restart' });
    if (!toolResults && active.includes('CRON_REWARDS')) return call('rewards_summary', {});
    if (!toolResults && active.includes('IMAGE_REFERENCE')) return call('image_reference', { character: '崩坏3 爱莉希雅', prompt: '模拟花园场景，完整着装' });
    if (active.includes('CONTENT_NUL')) return "The prompt could not be submitted. The prompt contains sensitive words that violate Google's Generative AI Prohibited Use policy.";
    if (active.includes('FALLBACK') && !text.includes('终审')) return 'LLM request failed.';
    if (toolResults && /FORBIDDEN/u.test(active)) return '这项功能未开放，操作没有执行。';
    if (toolResults && active.includes('BILI_SUB')) return '本群B站订阅操作已返回，请以同步结果为准。';
    if (toolResults && active.includes('NETWORK')) return '这项操作还未执行，请引用审批消息确认。';
    if (toolResults && active.includes('IMAGE_REFERENCE')) { const output = messages.filter(message => message.role === 'tool').map(message => textOf(message.content)).join('\n'); const path = /image_output=([^\\\n\s"]+)/u.exec(output)?.[1]; return path ? `参考图模拟已生成。\nMEDIA:${path}` : '模拟参考图未返回有效图片路径。'; }
    if (toolResults && active.includes('CRON_REWARDS')) return '模拟今日新增100积分，余额5000。';
    if (active === 'CASE_FOREIGN_MEDIA') return `模拟附件。\nMEDIA:${join(output, 'media/outbound/unrelated-private.png')}`;
    const role = text.includes('ROLE_MARKER=yuexia') ? '月下' : '爱莉';
    return `舰长，${role}收到了这条模拟消息。${active.includes('QUOTED') ? '引用原文已明确提供。' : ''}`;
}
const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw); } catch {}
    if (req.url.startsWith('/bili/')) {
        const path = req.url.slice(5), merge = (a,b) => { for(const[k,v]of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {},v) : structuredClone(v); return a; };
        let value;
        if (path === '/api/session/login') { res.setHeader('Set-Cookie','bn_session=synthetic-local-cookie; HttpOnly'); value = {ok:true}; }
        else if(path === '/api/auth/status') value = {status:5};
        else if(path.startsWith('/api/subs/lookup')) value = {uid:new URL('http://localhost'+path).searchParams.get('uid'),name:'模拟UP'};
        else if(path === '/api/connections') {
            if(req.method === 'POST') { biliState.mutations++; const old=biliState.connections.find(c=>c.id===body.id); if(old) merge(old,body); else {biliState.connections.push(structuredClone(body));biliState.targets.push({id:randomUUID(),connectionId:body.id,enabled:true,kind:'endpoint'});} }
            value=biliState.connections;
        } else if(path === '/api/targets') value=biliState.targets;
        else if(path === '/api/subs') {
            if(req.method === 'POST') { biliState.mutations++; const old=biliState.subs.find(s=>s.id===body.id); if(old)merge(old,body);else biliState.subs.push({...structuredClone(body),followed:true}); }
            value=biliState.subs;
        } else if(path.startsWith('/api/subs/') && req.method==='PATCH') {biliState.mutations++;value=merge(biliState.subs.find(s=>path.endsWith(s.id)),body);}
        else {res.writeHead(404);res.end('{}');return;}
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
    }
    if (req.url === '/fixture.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return; }
    if (/\/(?:chat\/completions|responses)(?:\?|$)/u.test(req.url)) {
        const value = answer(body);
        if (process.env.SIMULATION_GROUP_STREAMS === '1' && value.tool && !streamSlowHeld) {
            const user = [...(body.messages ?? [])].reverse().find(message => message.role === 'user' && /STREAM_[ABCD]/u.test(textOf(message.content)));
            if (/STREAM_A/u.test(textOf(user?.content))) {
                streamSlowHeld = true;
                await new Promise(resolve => { releaseStreamSlow = () => { streamSlowReleasedAt = Date.now(); resolve(); }; });
            }
        }
        const stagedMain = active.startsWith('CASE_STAGED') && modelCalls.at(-1)?.agentId?.endsWith('-normal-main') && !value.tool;
        if (stagedMain) await new Promise(resolve => setTimeout(resolve, active.includes('HARD') ? 45000 : 3200));
        if (req.url.includes('responses')) {
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'resp_simulation', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof value === 'string' ? value : '模拟审批' }] }] })); return;
        }
        const tool = value.tool;
        if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl-simulated', choices: [{ message: { role: 'assistant', content: typeof value === 'string' ? value : null, ...(tool ? { tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-simulated', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] } : { content: value }) });
        chunk({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n'); return;
    }
    const accountId = req.url.startsWith('/yuexia/') ? 'yuexia' : 'default';
    if (req.url.endsWith('/get_group_member_list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: [
            ...['700000003','188888888','188888889'].map(user_id => ({ user_id, nickname: `成员${user_id}`, card: '' })),
            { user_id: '199999999', nickname: 'SaltOcean', card: '海盐饼干' },
        ] })); return;
    }
    if (req.url.endsWith('/get_friend_msg_history')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: privateFileHistory.get(`${accountId}:${body.user_id}`) ?? [] } })); return;
    }
    if (req.url.endsWith('/get_forward_msg')) {
        forwardReads.push({ accountId, id: String(body.message_id) });
        const messages = forwards.get(String(body.message_id));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages ? { status: 'ok', retcode: 0, data: { messages } } : { status: 'failed', retcode: 100, data: null })); return;
    }
    if (req.url.includes('/send_')) {
        const messageId = String(++nextMessage);
        sends.push({ scenario: active, accountId, messageId, body, at: Date.now() });
        if (process.env.SIMULATION_GROUP_STREAMS === '1' && JSON.stringify(body.message).includes('STREAM_B_DONE')) releaseStreamSlow?.();
        quotes.set(messageId, { message_id: messageId, message_type: body.group_id ? 'group' : 'private', group_id: body.group_id, user_id: body.user_id,
            sender: { user_id: accountId === 'default' ? 700000006 : 700000005, nickname: accountId }, message: body.message });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: messageId } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url.includes('/get_msg') ? quotes.get(String(body.message_id)) ?? {} : { user_id: accountId === 'default' ? 700000006 : 700000005, nickname: 'simulation' } }));
});
const wsServer = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => wsServer.handleUpgrade(req, socket, head, ws => {
    const accountId = req.url.endsWith('yuexia') ? 'yuexia' : 'default'; connections.set(accountId, ws);
    ws.on('close', () => { if (connections.get(accountId) === ws) connections.delete(accountId); });
    ws.on('message', bytes => { const event = JSON.parse(bytes); if (event.action) ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: event.echo, data: event.action === 'get_login_info' ? { user_id: accountId === 'default' ? 700000006 : 700000005, nickname: accountId } : {} })); });
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); gatewayPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
async function setup() {
    await mkdir(join(output, 'media/outbound'), { recursive: true, mode: 0o700 });
    await writeFile(join(output, 'media/outbound/unrelated-private.png'), png);
    for (const name of ['onebot-features.json', 'onebot-model-routing.json', 'onebot-role-routing.json', 'onebot-executors.json', 'onebot-delivery.json', 'onebot-bilibili.json', 'onebot-services.json']) await copyFile(`${process.env.ONEBOT_CONFIG_ROOT || '/root/.openclaw'}/${name}`, join(output, name));
    policy = JSON.parse(await readFile(join(output, 'onebot-features.json')));
    const routes = JSON.parse(await readFile('/root/.openclaw/onebot-workspaces.json'));
    workspaceScopes = Object.fromEntries(Object.entries(routes.agents).map(([id, info]) => [id, info.scope]));
    configuration = JSON.parse(await readFile('/root/.openclaw/openclaw.json'));
    for (const [id, entry] of Object.entries(configuration.agents.entries)) {
        const info = routes.agents[id];
        const path = info?.scope && info.scope !== 'private' ? join(output, 'workspaces', id.replace(/-(?:main|helper|peer|review|fallback|rewrite|vision)$/u, '')) : join(output, 'private', id.includes('yuexia') ? 'yuexia' : 'elysia', info?.mode ?? (id.includes('onebot-grok') ? 'nsfw' : 'normal'));
        await mkdir(path, { recursive: true, mode: 0o700 });
        const role = id.includes('yuexia') ? 'yuexia' : 'elysia';
        await writeFile(join(path, 'IDENTITY.md'), `ROLE_MARKER=${role}\n你是${role === 'yuexia' ? '月下初拥' : '爱莉希雅'}。`);
        await writeFile(join(path, 'AGENTS.md'), '只使用当前工作区和当前会话。群成员和访客使用昵称，禁止读取其他工作区与私聊记忆。');
        await writeFile(join(path, 'SOUL.md'), '自然、简洁地回复。工具错误表示未执行。');
        if (info?.scope === 'private' || !id.startsWith('qq-')) await writeFile(join(path, 'MEMORY.md'), `${privateMarker}:${role}:${info?.mode ?? "normal"}`);
        entry.workspace = path; delete entry.agentDir;
        if (info) info.workspace = path;
    }
    configuration.agents.defaults.workspace = join(output, 'private/elysia/normal');
    configuration.agents.defaults.heartbeat = { every: '6h', target: 'none' };
    configuration.gateway = { mode: 'local', bind: 'loopback', port: gatewayPort, auth: { mode: 'token', token: randomUUID() } };
    configuration.cron = { enabled: true };
    configuration.plugins = { allow: ['openclaw-onebot', 'openai'], load: { paths: [process.env.ONEBOT_SIMULATION_PLUGIN_ROOT ?? '/root/.openclaw/extensions/openclaw-onebot'] }, slots: { memory: 'none' }, entries: { 'openclaw-onebot': { enabled: true,
        hooks: { allowConversationAccess: true, allowPromptInjection: true } }, openai: { enabled: true } } };
    delete configuration.secrets;
    for (const [name, provider] of Object.entries(configuration.models.providers)) { provider.baseUrl = `http://127.0.0.1:${port}/v1`; provider.apiKey = 'synthetic-simulation-key'; provider.request = { ...provider.request, allowPrivateNetwork: true }; delete provider.headers; }
    const channel = accountId => ({ enabled: true, httpUrl: `http://127.0.0.1:${port}/${accountId}`, wsUrl: `ws://127.0.0.1:${port}/ws/${accountId}`,
        allowFrom: [...policy.accounts[accountId].privateAdminIds.map(id=>`private:${id}`),...policy.accounts[accountId].groupIds.map(id=>`group:${id}`)], sharedDir: join(output, 'shared'), containerSharedDir: join(output, 'shared') });
    configuration.channels = { onebot: { ...channel('default'), accounts: { yuexia: channel('yuexia') } } };
    await writeFile(join(output, 'openclaw.json'), JSON.stringify(configuration), { mode: 0o600 });
    await writeFile(join(output, 'onebot-workspaces.json'), JSON.stringify(routes), { mode: 0o600 });
    await writeFile(join(output, 'onebot-app-config.json'), JSON.stringify({ batchGapMs: 20, batchMaxMessages: 12, batchMaxChars: 50000,
        defaultResponseTimeoutMs: process.env.SIMULATION_STAGED === '1' ? 1000 : 150000,
        imageAnalysisResponseTimeoutMs: process.env.SIMULATION_STAGED === '1' ? 2000 : 150000,
        extendedResponseTimeoutMs: process.env.SIMULATION_STAGED === '1' ? 300000 : 900000,
        // Legacy cooldown configuration must no longer throttle guest chat.
        imageResponseTimeoutMs: 90000, guestReplyIntervalMs: 60000 }), { mode: 0o600 });
    const roleConfig = JSON.parse(await readFile(join(output, 'onebot-role-routing.json')));
    for (const role of Object.values(roleConfig.roles)) { const path = join(output, `public-${role.accountId}.md`); await writeFile(path, `你是${role.displayName}，只有公开人设，无私人记忆。`); role.peerSoulPath = path; }
    await writeFile(join(output, 'onebot-role-routing.json'), JSON.stringify(roleConfig));
    await mkdir(join(output, 'secrets'), { recursive: true, mode: 0o700 });
    if(process.env.SIMULATION_BILISYNC === '1') {
        const dir=join(output,'onebot-onebot-custom/integrations/bilibili-notify');await mkdir(dir,{recursive:true,mode:0o700});
        await writeFile(join(dir,'.env'),'BN_DASHBOARD_USER=simulation\nBN_DASHBOARD_PASS=synthetic-local-pass\n',{mode:0o600});
        const key=join(output,'secrets/bilibili-simulation.key');await writeFile(key,'synthetic-webhook-secret-'.repeat(3),{mode:0o600});
        await writeFile(join(output,'onebot-bilibili.json'),JSON.stringify({version:1,enabled:true,secretFile:key,routes:[]}),{mode:0o600});
        policy.features.bilibili.enabled=true;await writeFile(join(output,'onebot-features.json'),JSON.stringify(policy),{mode:0o600});
    }
    await writeFile(join(output, 'secrets/onebot-delivery.key'), 'simulation-secret-'.repeat(4), { mode: 0o600 });
    environment = { ...process.env, ONEBOT_CONFIG_ROOT: output, OPENCLAW_STATE_DIR: output, OPENCLAW_CONFIG_PATH: join(output, 'openclaw.json'), ONEBOT_OPERATIONS_DB: join(output, 'state/business/operations.sqlite'),
        ONEBOT_SIM_BILI_URL: `http://127.0.0.1:${port}`,
        ONEBOT_CLASSIFIER_BASE_URL: `http://127.0.0.1:${port}/v1`, GEMINI_API_KEY: 'synthetic-simulation-key', ONEBOT_SIMULATION: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${join(source, 'scripts/simulation-preload.mjs')}`.trim() };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
    child = spawn('/usr/local/bin/openclaw', ['gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = bytes => { logs += bytes; void appendFile(join(output, 'gateway-live.log'), bytes, { mode: 0o600 }); };
    child.stdout.on('data', log); child.stderr.on('data', log);
    for (let i = 0; i < 900; i++) { if (child.exitCode !== null) throw new Error(`simulation gateway exited ${child.exitCode}`); if (connections.has('default') && connections.has('yuexia')) return; await pause(200); }
    throw new Error('simulation OneBot connections not ready');
}
async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
let eventId = 820000;
async function emit({ id, user = '700000003', group = '700000011', account = 'default', mention = '700000006', text = '你好', segments = [], scope = 'group', wait = true, noReply = false, senderName }) {
    active = id; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id }));
    const before = sends.length, beforeCalls = modelCalls.length;
    const message = [...(mention && scope === 'group' ? [{ type: 'at', data: { qq: mention } }] : []), ...segments, { type: 'text', data: { text } }];
    const event = { post_type: 'message', message_type: scope === 'group' ? 'group' : 'private', sub_type: scope === 'group' ? 'normal' : 'friend', time: Math.floor(Date.now() / 1000), message_id: ++eventId,
        user_id: Number(user), ...(scope === 'group' ? { group_id: Number(group) } : {}), sender: { user_id: Number(user), nickname: senderName ?? `模拟用户${user}`, card: senderName ?? `模拟用户${user}`, role: user === '700000003' ? 'owner' : 'member' }, message, raw_message: text };
    quotes.set(String(event.message_id), event);
    for (const [key, ws] of connections) if (scope === 'group' || key === account) ws.send(JSON.stringify({ ...event, self_id: key === 'default' ? 700000006 : 700000005 }));
    if (wait) {
        if (noReply) await pause(1300);
        else { for (let i = 0; i < 600 && !sends.slice(before).some(message => scope === "group" ? String(message.body.group_id) === String(group) : String(message.body.user_id) === String(user) && message.accountId === account); i++) await pause(200); assert.ok(sends.slice(before).some(message => scope === "group" ? String(message.body.group_id) === String(group) : String(message.body.user_id) === String(user) && message.accountId === account), `${id}: no response`); if (/IMAGE_GENERATE|IMAGE_EDIT|IMAGE_REFERENCE/u.test(id)) { for (let i = 0; i < 450 && (!sends.slice(before).some(message => message.body.message?.some?.(part => part.type === "text")) || !sends.slice(before).some(message => message.body.message?.some?.(part => part.type === "image"))); i++) await pause(200); } await pause(1500); }
    }
    return { event, sends: sends.slice(before).filter(message => scope === "group" ? String(message.body.group_id) === String(group) : String(message.body.user_id) === String(user)), calls: modelCalls.slice(beforeCalls) };
}
async function check(name, callback) {
    if (process.env.SIMULATION_FILTER && !new RegExp(process.env.SIMULATION_FILTER, 'u').test(name)) return;
    const started = Date.now();
    emittedToolCalls.clear();
    try { const evidence = await callback(); results.push({ name, passed: true, elapsedMs: Date.now() - started, evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, elapsedMs: Date.now() - started, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
const visible = messages => messages.map(message => JSON.stringify(message.body.message)).join('\n');
async function updatePolicy(change) { change(policy); await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy), { mode: 0o600 }); }
async function executionCounts() { return (await readFile(join(output, 'executions.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function speechSettled(start) {
    for (let i = 0; i < 400 && !logs.slice(start).includes('Speech delivery confirmed operation='); i++) await pause(200);
    assert.ok(logs.slice(start).includes('Speech delivery confirmed operation='), 'speech finalization must acknowledge the native receipt');
    await pause(200);
}
async function cron(args) { return JSON.parse((await run('/usr/local/bin/openclaw', ['cron', ...args], { env: environment, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout); }
async function simulateAutomations() {
    const baseline = JSON.parse(await readFile('/root/.openclaw/state/modular-implementation-20261016/cron-baseline.json'));
    const fixture = join(output, 'fixtures/scheduled.mjs');
    await writeFile(fixture, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(output, 'scheduled-events.jsonl'))},JSON.stringify({jobId:process.env.ONEBOT_ORIGIN_JOB_ID,name:process.argv[2]})+'\\n');console.log(JSON.stringify({ok:true,simulated:true,name:process.argv[2]}));`);
    const services = JSON.parse(await readFile(join(output, 'onebot-services.json')));
    let rewardsId;
    for (const original of baseline.jobs) await check(`automation-${original.name}-${original.id.slice(0, 8)}`, async () => {
        if (original.payload.kind === 'heartbeat') {
            active = 'CASE_OWNER_PRIVATE_HEARTBEAT'; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
            // Heartbeats are core-managed jobs, intentionally not creatable by
            // public cron.add. Exercise the real fixture-owned managed job.
            const created = (await cron(['list', '--all', '--json'])).jobs.find(job => job.payload.kind === 'heartbeat' && job.agentId === 'main');
            const id = created?.id; assert.ok(id, 'managed private heartbeat missing');
            policy.automationBindings[id] = { ...policy.automationBindings[original.id] };
            services.jobs[id] = { ...services.jobs[original.id] };
            await writeFile(join(output, 'onebot-services.json'), JSON.stringify(services)); await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy));
            const before = sends.length; await cron(['run', id, '--expect-final', '--timeout', '100000']);
            const persisted = (await cron(['list', '--all', '--json'])).jobs.find(job => job.id === id);
            assert.equal(persisted.payload.kind, 'heartbeat'); assert.equal(persisted.agentId, 'main'); assert.equal(persisted.sessionTarget, 'main'); assert.equal(sends.length, before);
            return { jobId: id, originalKind: 'heartbeat', ownerPrivateSubjectPreserved: true, realQqMessages: 0 };
        }
        active = original.payload.kind === 'agentTurn' && original.name.includes('rewards') ? 'CASE_CRON_REWARDS' : 'CASE_CRON_REMINDER';
        await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
        const binding = policy.automationBindings[original.id];
        const accountId = original.delivery?.accountId ?? 'default';
        const agentId = `qq-auto-${accountId === 'yuexia' ? 'yuexia' : 'elysia'}-normal-${original.name.includes('rewards') ? 'main' : 'helper'}`;
        const asAgent = original.payload.kind === 'agentTurn' && original.enabled;
        const args = ['add', '--name', `simulation-${original.name}-${original.id.slice(0, 4)}`, '--cron', '0 23 * * *', '--tz', 'Asia/Shanghai', '--disabled', '--agent', agentId, '--json'];
        if (asAgent) args.push('--message', original.name.includes('rewards') ? '调用 rewards_summary 获取今日积分，然后给出简短汇报。' : '发一条简短模拟提醒。', '--tools', original.name.includes('rewards') ? 'rewards_summary' : '', '--announce', '--channel', 'onebot', '--account', accountId, '--to', 'group:700000011', '--timeout-seconds', '90');
        else args.push('--command-argv', JSON.stringify([process.execPath, fixture, original.name]), '--no-deliver');
        const created = await cron(args), id = created.id ?? created.job?.id;
        assert.ok(id);
        policy.automationBindings[id] = { ...binding, deliveryGroupIds: asAgent ? ['700000011'] : [] };
        services.jobs[id] = asAgent ? { kind: 'agent', feature: binding.feature, accountId, agentId, actions: binding.feature === 'rewards' ? ['read'] : [] }
            : { kind: 'command', feature: binding.feature, accountId, argv: [process.execPath, fixture, original.name], cwd: output };
        await writeFile(join(output, 'onebot-services.json'), JSON.stringify(services));
        await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy));
        if (asAgent && !original.name.includes('rewards')) await run('/usr/local/bin/openclaw', ['gateway', 'call', 'cron.update', '--params', JSON.stringify({ id, patch: { payload: { kind: 'agentTurn', toolsAllow: [] } } }), '--json'], { env: environment, timeout: 30000 });
        if (!asAgent) await run('/usr/local/bin/openclaw', ['cron', 'edit', id, '--command-argv', JSON.stringify([process.execPath, join(source, 'scripts/run-scheduled.mjs'), id])], { env: environment, timeout: 30000 });
        if (!original.enabled) {
            const result = await run(process.execPath, [join(source, 'scripts/run-scheduled.mjs'), id], { env: environment, timeout: 10000 }).then(() => ({ blocked: false }), () => ({ blocked: true }));
            assert.equal(result.blocked, true); return { jobId: id, disabledPreserved: true };
        }
        await run('/usr/local/bin/openclaw', ['cron', 'enable', id], { env: environment, timeout: 30000 });
        const before = sends.length;
        await cron(['run', id, '--expect-final', '--timeout', '100000']);
        for (let i = 0; i < 450; i++) {
            const runs = await cron(['runs', '--id', id, '--limit', '1']);
            const entry = runs.entries?.[0];
            if (entry?.action === 'finished') { assert.equal(entry.status, 'ok', JSON.stringify(entry)); break; }
            if (i === 449) throw new Error('automation did not reach a completed run');
            await pause(200);
        }
        if (asAgent) { for (let i = 0; i < 100 && sends.length === before; i++) await pause(200); assert.ok(sends.slice(before).some(message => message.accountId === accountId && String(message.body.group_id) === '700000011')); }
        else assert.ok((await readFile(join(output, 'scheduled-events.jsonl'), 'utf8')).includes(id));
        if (binding.feature === 'rewards') rewardsId = id;
        return { jobId: id, publicAgent: asAgent ? agentId : null, originalKind: original.payload.kind, originalEnabled: original.enabled };
    });
    await check('automation-revoked-feature-blocks-outbound-and-tools', async () => {
        assert.ok(rewardsId); active = 'CASE_CRON_REWARDS'; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
        const before = sends.length, executions = (await executionCounts()).filter(entry => entry.name === 'rewards').length;
        await updatePolicy(config => { config.features.rewards.enabled = false; });
        await cron(['run', rewardsId, '--expect-final', '--timeout', '100000']).catch(() => {}); await pause(1000);
        assert.equal(sends.length, before); assert.equal((await executionCounts()).filter(entry => entry.name === 'rewards').length, executions);
        await updatePolicy(config => { config.features.rewards.enabled = true; });
    });
    await check('automation-unknown-command-subject-fails-closed', async () => {
        await assert.rejects(run(process.execPath, [join(source, 'scripts/run-scheduled.mjs'), '00000000-0000-0000-0000-000000000000'], { env: environment, timeout: 10000 }));
    });
}
async function simulateIngress() {
    await check('script-text-ingress-native-receipt-and-idempotency', async () => {
        active = 'CASE_SCRIPT_TEXT'; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
        const path = join(output, 'fixtures/alert.txt'); await writeFile(path, '模拟 ALAS 告警，仅发往假 OneBot。');
        const before = sends.length, env = { ...environment, ONEBOT_DELIVERY_ID: 'simulation-stable-script-text' };
        for (let attempt = 0; attempt < 2; attempt++) assert.match((await run(process.execPath, [join(source, 'scripts/deliver.mjs'), 'alas-monitor', path], { env, timeout: 30000 })).stdout, /STATUS=ok/u);
        assert.equal(sends.length - before, 1);
    });
    await check('script-screenshot-ingress-persists-image-and-receipt', async () => {
        active = 'CASE_SCRIPT_IMAGE'; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
        const before = sends.length;
        assert.match((await run(process.execPath, [join(source, 'scripts/deliver.mjs'), 'alas-screenshot', join(output, 'fixtures/generated.png')], { env: environment, timeout: 30000 })).stdout, /STATUS=ok/u);
        assert.ok(sends.slice(before).some(message => message.body.message?.some?.(part => part.type === 'image')));
    });
    await check('bilibili-generic-webhook-simulated-end-to-end', async () => {
        active = 'CASE_BILIBILI';
        const config = JSON.parse(await readFile(join(output, 'onebot-bilibili.json')));
        config.enabled = true; config.secretFile = join(output, 'secrets/bilibili-simulation.key'); config.routes = [{ targetId: 'sim-up-dynamic', uid: '123456', event: 'dynamic', accountId: 'default', groupId: '700000011', enabled: true }];
        const key = randomUUID().replaceAll('-', '') + randomUUID(); await writeFile(config.secretFile, key, { mode: 0o600 });
        await writeFile(join(output, 'onebot-bilibili.json'), JSON.stringify(config)); await updatePolicy(policy => { policy.features.bilibili.enabled = true; });
        const event = { targetId: 'sim-up-dynamic', scope: 'private', private: true, ts: new Date().toISOString(), payload: { kind: 'composite', segments: [{ type: 'text', text: '模拟动态 https://t.bilibili.com/123456789' }, { type: 'image', mime: 'image/png', data: png.toString('base64') }] } };
        const post = async (value, secret = key) => fetch(`http://127.0.0.1:${gatewayPort}/onebot/bilibili/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bilibili-notify-secret': secret }, body: JSON.stringify(value) });
        const before = sends.length;
        const first = await post(event), result = await first.json(); assert.equal(first.status, 202); assert.equal(result.state, 'accepted'); assert.equal(sends.length - before, 2);
        assert.equal((await post(event)).status, 202); assert.equal(sends.length - before, 2);
        assert.ok(sends.slice(before).every(message => String(message.body.group_id) === '700000011'));
        assert.equal((await post(event, 'invalid')).status, 401); assert.equal((await post({ ...event, targetId: 'group:99999999' })).status, 400);
        config.enabled = false; config.routes = []; await writeFile(join(output, 'onebot-bilibili.json'), JSON.stringify(config)); await updatePolicy(policy => { policy.features.bilibili.enabled = false; });
    });
}
try {
    await setup(); await start();
    await check('parallel-group-participant-streams', async () => {
        const start = Date.now(), before = sends.length, logStart = logs.length;
        await emit({id:'CASE_STREAM_A',user:'188888881',group:'700000012',text:'STREAM_A 查看我的提醒，只用文字回答',wait:false});
        for(let i=0;i<300&&!streamSlowHeld;i++)await pause(200);
        assert(streamSlowHeld,'first participant must enter a held native model request');
        await emit({id:'CASE_STREAM_B',user:'188888882',group:'700000012',text:'STREAM_B 向我问好，只用文字回答',wait:false});
        await emit({id:'CASE_STREAM_C',user:'700000003',group:'700000012',text:'STREAM_C 查看我的提醒，只用文字回答',wait:false});
        for(let i=0;i<600&&!['STREAM_A_DONE','STREAM_B_DONE','STREAM_C_DONE'].every(tag=>visible(sends.slice(before)).includes(tag));i++)await pause(200);
        const replies=sends.slice(before), times={};
        for(const tag of ['STREAM_A','STREAM_B','STREAM_C']){
            const message=replies.find(message=>JSON.stringify(message.body.message).includes(tag+'_DONE'));
            assert(message,tag+' must receive its own final response');
            assert.equal(String(message.body.group_id),'700000012'); times[tag]=message.at-start;
        }
        assert(times.STREAM_B<times.STREAM_A,'fast chat must finish while the slow participant is held');
        assert(Number.isFinite(streamSlowReleasedAt));
        assert(replies.find(message=>JSON.stringify(message.body.message).includes('STREAM_B_DONE')).at<=streamSlowReleasedAt);
        const {DatabaseSync}=await import('node:sqlite');
        const db=new DatabaseSync(join(output,'state/business/operations.sqlite'),{readOnly:true});
        const operations=db.prepare("SELECT input,state,created FROM operations WHERE kind='reminder_list' AND created>=?").all(start).map(row=>({...row,input:JSON.parse(row.input)}));db.close();
        assert.equal(operations.length,2);assert(operations.every(row=>row.state==='succeeded'));
        assert.equal(new Set(operations.map(row=>row.input.origin.sessionKey)).size,2);
        assert.deepEqual(new Set(operations.map(row=>row.input.origin.senderId)),new Set(['188888881','700000003']));
        assert(operations.find(row=>row.input.origin.senderId==='700000003').created<streamSlowReleasedAt,'third participant must execute its tool while the first model request is held');
        const streamLogs=logs.slice(logStart).split('\n').filter(line=>line.includes('Group stream sender='));
        assert.equal(new Set(streamLogs.map(line=>line.match(/ session=(.*)$/u)?.[1])).size,3);
        assert(!logs.slice(logStart).includes('缺少唯一可信发送者上下文'));
        return {parallelNativeModelRequests:true,fastReplyPrecededSlowRelease:true,otherToolExecutedWhileSlowHeld:true,independentSenderSessions:3,independentToolOwners:2,completedTools:2,realQqMessages:0,replyTimesMs:times};
    });
    await check('conversation-reminders-create-list-cancel-and-due-at-for-all-users', async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(join(output, 'state/business/operations.sqlite'));
        try {
            for (const scenario of [
                { account: 'default', scope: 'private', user: '700000003' },
                { account: 'default', scope: 'private', user: '188888888' },
                { account: 'default', scope: 'group', group: '700000012', user: '188888888' },
                { account: 'yuexia', scope: 'group', group: '700000011', user: '188888889', mention: '700000005' },
            ]) {
                const key = `${scenario.account}-${scenario.scope}-${scenario.user}`;
                await emit({ ...scenario, id: `CASE_TIMER_CREATE_${key}`, text: '一小时后提醒我喝水' });
                const row = db.prepare('SELECT * FROM reminders ORDER BY created DESC LIMIT 1').get();
                assert.ok(row, 'reminder tool must persist a task'); assert.equal(row.owner, scenario.user); assert.equal(row.account, scenario.account);
                configuration._timerId = row.id;
                await emit({ ...scenario, id: `CASE_TIMER_LIST_${key}`, text: '看看我的提醒' });
                await emit({ ...scenario, id: `CASE_TIMER_CANCEL_${key}`, text: '取消刚才那个提醒' });
                assert.equal(db.prepare('SELECT state FROM reminders WHERE id=?').get(row.id).state, 'cancelled');
            }
            const before = db.prepare('SELECT count(*) AS n FROM reminders').get().n;
            await emit({ id: 'CASE_TIMER_DISCUSS', group: '700000012', user: '188888888', text: '定时器是什么原理？' });
            assert.equal(db.prepare('SELECT count(*) AS n FROM reminders').get().n, before);
            const start = sends.length;
            await emit({ id: 'CASE_TIMER_FUZZY', group: '700000012', user: '188888888', text: '十秒钟后艾特海盐告诉他喝水' });
            for (let n = 0; n < 100 && !sends.slice(start).some(s => s.body.message?.some(p => p.type === 'at' && p.data.qq === '199999999')); n++) await pause(200);
            const delivered = sends.slice(start).filter(s => s.body.message?.some(p => p.type === 'at' && p.data.qq === '199999999'));
            assert.equal(delivered.length, 1); assert.equal(String(delivered[0].body.group_id), '700000012');
            assert.match(visible(delivered), /喝水/u);
            return { users: 4, lifecycle: 'create/list/cancel', fuzzyTarget: 'account nickname and group card', dueDelivery: 'one real at segment to mock OneBot' };
        } finally { db.close(); }
    });
    await check('control-nickname-content-refusal-falls-through-qwen-to-grok-without-crossing-workspaces', async () => {
        const start = logs.length;
        const result = await emit({ id: 'CASE_CONTENT_NUL', group: '700000012', user: '2423711725',
            senderName: '\n\b\x12\x06有栖\n\b\n\x06FooFoo\x10\x00', text: '真的妖精小姐说话是要带喵的' });
        assert.match(visible(result.sends), /备用链路/u);
        assert.doesNotMatch(logs.slice(start), /ERR_INVALID_ARG_VALUE/u);
        const fallback = result.calls.filter(call => JSON.stringify(call.messages).includes('你在给 QQ 回复做终审'));
        assert.ok(fallback.some(call => call.model.startsWith('qwen')));
        assert.ok(fallback.some(call => call.model.startsWith('grok')));
        assert.ok(fallback.every(call => call.agentScope === 'group' && !call.privateMarkerPresent));
        assert.ok(result.calls.every(call => !JSON.stringify(call.messages).includes('\\u0000')));
        const next = await emit({ id: 'CASE_CONTROL_NICKNAME_REVIEW', group: '700000012', user: '188887025', text: '大家下午好' });
        assert.ok(next.calls.some(call => JSON.stringify(call.messages).includes('主模型的回复要发到 QQ')));
        assert.doesNotMatch(logs.slice(start), /ERR_INVALID_ARG_VALUE/u);
        assert.doesNotMatch(visible(next.sends), /\x00|\x08|\x12/u);
        return { cases: 2, qwenBlockedThenGrokReplied: true, textReviewAndRewriteWorked: true, realQqMessages: 0 };
    });
    await check('speech-synthesis-failure-keeps-full-answer-and-private-diagnostics', async () => {
        const before = sends.length, user = '188887019';
        await emit({ id: 'CASE_SPEECH_EXPLICIT_SYNTH_FAIL', scope: 'private', user, text: '用语音向我问好', wait: false });
        for (let i = 0; i < 400 && !sends.slice(before).some(row => row.body.message.some(part => part.type === 'text')); i++) await pause(200);
        const deliveredMessages = sends.slice(before), text = visible(deliveredMessages);
        assert.ok(!deliveredMessages.some(row => row.body.message.some(part => part.type === 'record')));
        assert.match(text, /语音没有生成成功/u); assert.match(text, /今天也要记得好好吃饭哦/u);
        assert.doesNotMatch(text, /private command|missing-private|Traceback|generation_failed|\/root\//u);
        const errors = await readdir(join(output, 'state/tts/errors'));
        assert.equal(errors.length, 1);
        const diagnostic = JSON.parse(await readFile(join(output, 'state/tts/errors', errors[0])));
        assert.equal(diagnostic.reason, 'generation_failed'); assert.equal(diagnostic.exitCode, 1);
        return { cases: 1, noVoiceSend: true, completeTextFallback: true, localDiagnostic: true, realQqMessages: 0 };
    });
    await check('speech-native-delivery-without-model-media-admin-guest-private-group-and-duplicate-directive', async () => {
        const cases = [['admin-group','700000003','group'],['guest-group','188887110','group'],
            ['admin-private','700000003','private'],['guest-private','188887111','private'],['duplicate-directive','188887112','group']];
        for (const [id, user, scope] of cases) {
            const before = sends.length, logStart = logs.length;
            await emit({ id: `CASE_SPEECH_EXPLICIT_${id === 'duplicate-directive' ? 'DUP_MEDIA' : 'NO_MEDIA'}_${id}`,
                user, scope, group: '700000008', text: '和大家用语音打个招呼吧', wait: false });
            await speechSettled(logStart);
            const output = sends.slice(before);
            assert.equal(output.filter(row => row.body.message.some(part => part.type === 'record')).length, 1, id);
            assert.ok(output.every(row => row.accountId === 'default' && (scope === 'group' ? String(row.body.group_id) === '700000008' : String(row.body.user_id) === user)));
            assert.doesNotMatch(visible(output), /\/private\/internal|audio_output|合成结果|MEDIA:/u);
        }
        return { cases: cases.length, recordsPerRequest: 1, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('speech-policy-group-natural-greeting-explicit-admin-and-guest', async () => {
        for (const [role, user] of [['admin', '700000003'], ['guest', '188887799']]) {
            const before = sends.length, beforeCalls = modelCalls.length, logStart = logs.length;
            await emit({ id: `CASE_SPEECH_EXPLICIT_GREETING_${role}`, group: '700000008', user,
                text: '和大家语音打个招呼吧', wait: false });
            for (let i = 0; i < 400 && !sends.slice(before).some(row => row.body.message.some(part => part.type === 'record')); i++) await pause(200);
            await speechSettled(logStart);
            const delivered = sends.slice(before);
            assert.equal(delivered.filter(row => row.body.message.some(part => part.type === 'record')).length, 1);
            assert.ok(delivered.every(row => row.accountId === 'default' && String(row.body.group_id) === '700000008'));
            const main = modelCalls.slice(beforeCalls).find(row => row.messages.some(message => textOf(message.content).includes('本次是明确的语音请求')));
            assert.ok(main, `${role}: explicit voice instructions missing`);
            assert.ok(main.tools.some(tool => (tool.function?.name ?? tool.name) === 'tts_synthesize'));
            assert.ok(!main.messages.some(message => textOf(message.content).includes('本次已经由程序选中30%随机追加语音')));
        }
        return { cases: 2, originalUtterance: '和大家语音打个招呼吧', realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('speech-policy-model-classification-no-keywords-quoted-negation-disabled-and-failure', async () => {
        const cases = [
            ['NO_KEYWORDS', '别打字了，让大家听听你的声音', 'group', true],
            ['LITERAL', '请逐字念出“不要语音，只用文字”', 'private', true],
            ['DISABLED', '不要语音，文字问候一下', 'private', false],
            ['DISCUSSION_NO_APPEND', '语音识别是怎么实现的', 'private', false],
            ['CLASSIFIER_FAIL', '用语音告诉我今天怎么放松', 'private', false],
        ];
        for (const [index, [type, text, scope, voice]] of cases.entries()) {
            const before = sends.length, beforeCalls = modelCalls.length, user = String(188887500 + index), logStart = logs.length;
            await emit({ id: `CASE_SPEECH_${type}`, user, scope, text, wait: false });
            for (let i = 0; i < 400 && !sends.slice(before).length; i++) await pause(200);
            if (voice) await speechSettled(logStart);
            await pause(1000);
            assert.equal(sends.slice(before).some(row => row.body.message.some(part => part.type === 'record')), voice, type);
            const classifiers = modelCalls.slice(beforeCalls).filter(row => row.messages.some(message => textOf(message.content).includes('一次判断五个字段')));
            assert.equal(classifiers.length, 1, `${type}: classification must share the inbound pass`);
            if (type === 'LITERAL') assert.ok((await executionCounts()).some(row => row.scenario === 'CASE_SPEECH_LITERAL' && row.name === 'tts' && row.text === '不要语音，只用文字'));
        }
        return { cases: cases.length, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('speech-policy-explicit-guest-passed-rejected-unavailable-and-length-fallback', async () => {
        for (const [index, type] of ['EXPLICIT', 'BLOCK', 'UNAVAILABLE', 'TOO_LONG'].entries()) {
            const before = (await executionCounts()).filter(row => row.name === 'tts').length;
            const logStart = logs.length;
            const result = await emit({ id: `CASE_SPEECH_${type}`, scope: 'private', user: String(188887800 + index), mention: null, text: '用语音告诉我：今天中午吃什么', wait: false });
            const start = sends.length;
            for (let i = 0; i < 400 && !sends.slice(start).some(row => String(row.body.user_id) === String(188887800 + index)); i++) await pause(200);
            if (type === 'EXPLICIT') await speechSettled(logStart);
            const output = sends.filter(row => String(row.body.user_id) === String(188887800 + index));
            const count = (await executionCounts()).filter(row => row.name === 'tts').length;
            if (type === 'EXPLICIT') { assert.equal(count, before + 1); assert.ok(output.some(row => row.body.message.some(part => part.type === 'record'))); }
            else { assert.equal(count, before); assert.ok(!output.some(row => row.body.message.some(part => part.type === 'record'))); }
            if (type === 'TOO_LONG') { assert.match(visible(output), /超过200字/u); assert.ok(visible(output).includes('答'.repeat(201))); }
            if (type === 'BLOCK') assert.doesNotMatch(visible(output), /不合适的测试稿件/u);
        }
        return { cases: 4, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('speech-policy-random-appendix-joint-generation-order-limit-and-role', async () => {
        for (const [index, type] of ['APPEND', 'NO_APPEND', 'OVER40', 'MOON'].entries()) {
            const user = String(188887900 + index), before = sends.length;
            await emit({ id: `CASE_SPEECH_${type}`, scope: 'private', account: type === 'MOON' ? 'yuexia' : 'default', user, mention: null, text: '今天过得怎么样呀', wait: false });
            for (let i = 0; i < 400 && !sends.slice(before).some(row => String(row.body.user_id) === user); i++) await pause(200);
            if (type === 'APPEND') for (let i = 0; i < 200 && !sends.slice(before).some(row => row.body.message.some(part => part.type === 'record')); i++) await pause(200);
            else await pause(1000);
            const output = sends.slice(before).filter(row => String(row.body.user_id) === user);
            assert.ok(output[0].body.message.some(part => part.type === 'text'));
            assert.equal(output.some(row => row.body.message.some(part => part.type === 'record')), type === 'APPEND');
            assert.doesNotMatch(visible(output.filter(row => row.body.message.some(part => part.type === 'text'))), /VOICE_APPEND|\/root\//u);
        }
        return { cases: 4, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('speech-policy-automation-joint-appendix-after-original-text', async () => {
        active = 'CASE_SPEECH_AUTO_APPEND'; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
        const agentId = 'qq-auto-elysia-normal-helper';
        const created = await cron(['add','--name','speech-appendix-automation','--cron','0 23 * * *','--disabled','--agent',agentId,
            '--message','发一条吃午饭的日常提醒。','--tools','tts_synthesize','--announce','--channel','onebot','--account','default','--to','group:700000011','--timeout-seconds','90','--json']);
        const id = created.id ?? created.job?.id, services = JSON.parse(await readFile(join(output, 'onebot-services.json')));
        policy.automationBindings[id] = { feature: 'automation', name: 'speech-appendix-automation', enabled: true, deliveryGroupIds: ['700000011'] };
        services.jobs[id] = { kind: 'agent', feature: 'automation', accountId: 'default', agentId, actions: [], speechTarget: { type: 'group', id: '700000011' } };
        await writeFile(join(output, 'onebot-services.json'), JSON.stringify(services)); await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy));
        const before = sends.length; await cron(['enable',id]); await cron(['run',id,'--expect-final','--timeout','100000']);
        for (let i = 0; i < 200 && !sends.slice(before).some(row => row.body.message.some(part => part.type === 'record')); i++) await pause(200);
        const deliveredMessages = sends.slice(before); assert.ok(deliveredMessages[0]?.body.message.some(part => part.type === 'text'));
        assert.equal(deliveredMessages.filter(row => row.body.message.some(part => part.type === 'record')).length, 1);
        const text = deliveredMessages.flatMap(row => row.body.message).filter(part => part.type === 'text').map(part => part.data.text).join('\n');
        assert.doesNotMatch(text, /VOICE_APPEND/u);
        return { originalTextThenVoice: true, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('tts-role-policy-admin-and-guest-private-and-group-voice-delivery', async () => {
        let cases = 0;
        for (const account of ['default', 'yuexia']) for (const scope of ['private', 'group']) for (const user of ['700000003', '188888898']) {
            if (process.env.SIMULATION_TTS_GROUP_ONLY === '1' && (account !== 'yuexia' || scope !== 'group')) continue;
            const before = (await executionCounts()).filter(row => row.name === 'tts').length;
            const beforeSends = sends.length, beforeCalls = modelCalls.length, logStart = logs.length;
            const result = await emit({ id: `CASE_TTS_${account}_${scope}_${user}`, account, scope, user, wait: false,
                mention: scope === 'group' ? account === 'default' ? '700000006' : '700000005' : null,
                text: '用爱莉的声线说一句：今天你也很可爱哦' });
            if (account === 'yuexia') {
                for (let i = 0; i < 400 && !sends.slice(beforeSends).some(row => row.accountId === account); i++) await pause(200);
                assert.ok(!sends.slice(beforeSends).some(row => row.accountId === account && row.body.message?.some(part => part.type === 'record')));
                assert.equal((await executionCounts()).filter(row => row.name === 'tts').length, before);
                cases++; continue;
            }
            // Text from a preceding turn can finish rewriting after this turn
            // starts. Wait for this turn's actual voice, not any group message.
            for (let i = 0; i < 400 && !sends.slice(beforeSends).some(row => row.accountId === account && row.body.message?.some(part => part.type === 'record')); i++) await pause(200);
            await speechSettled(logStart);
            result.sends = sends.slice(beforeSends); result.calls = modelCalls.slice(beforeCalls);
            assert.ok(result.sends.some(row => row.accountId === account && row.body.message?.some(part => part.type === 'record')));
            assert.equal((await executionCounts()).filter(row => row.name === 'tts').length, before + 1);
            const userVisibleText = result.sends.flatMap(row => row.body.message ?? []).filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('\n');
            assert.doesNotMatch(userVisibleText, /\/root\/|raw_output|generation\.log/u);
            if (user !== '700000003') {
                const tools = result.calls.flatMap(row => row.tools ?? []).map(tool => tool.function?.name ?? tool.name);
                assert.ok(tools.includes('tts_synthesize')); assert.ok(!tools.some(name => ['exec','read','write','message','adsb_query'].includes(name)));
            }
            cases++;
        }
        return { cases, realQqMessages: 0, realTtsExecutions: 0 };
    });
    await check('tts-registered-elysia-automation-delivers-to-bound-target', async () => {
        const services = JSON.parse(await readFile(join(output, 'onebot-services.json')));
        for (const accountId of ['default']) {
            active = `CASE_TTS_CRON_${accountId}`; await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
            const agentId = `qq-auto-${accountId === 'default' ? 'elysia' : 'yuexia'}-normal-helper`;
            const created = await cron(['add','--name',`tts-test-${accountId}`,'--cron','0 23 * * *','--disabled','--agent',agentId,
                '--message','用语音发一条简短鼓励。','--tools','tts_synthesize','--announce','--channel','onebot','--account',accountId,'--to','group:700000011','--timeout-seconds','90','--json']);
            const id = created.id ?? created.job?.id;
            policy.automationBindings[id] = { feature: 'automation', name: `tts-test-${accountId}`, enabled: true, deliveryGroupIds: ['700000011'] };
            services.jobs[id] = { kind: 'agent', feature: 'automation', accountId, agentId, actions: [], speechTarget: { type: 'group', id: '700000011' } };
            await writeFile(join(output, 'onebot-services.json'), JSON.stringify(services)); await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy));
            const before = sends.length; await cron(['enable',id]); await cron(['run',id,'--expect-final','--timeout','100000']);
            for(let i=0;i<100&&!sends.slice(before).some(row=>row.body.message?.some(part=>part.type==='record'));i++)await pause(200);
            const records = sends.slice(before).filter(row=>row.body.message?.some(part=>part.type==='record'));
            assert.equal(records.length,1);assert.equal(records[0].accountId,accountId);assert.equal(String(records[0].body.group_id),'700000011');
        }
        return { roles: 1, recordDeliveries: 1, realQqMessages: 0 };
    });
    await check('private-file-receipt-both-accounts-admin-and-guest-never-call-model-or-reply', async () => {
        for (const account of ['default', 'yuexia']) for (const user of ['700000003', '188888899']) {
            const file = { type: 'file', data: { file: 'comparison.wav', file_id: `sent-${account}-${user}`, file_size: '1234', url: '', path: '' } };
            privateFileHistory.set(`${account}:${user}`, [{ message_type: 'private', message_id: 100, time: Math.floor(Date.now() / 1000) - 10,
                sender: { user_id: account === 'default' ? 700000006 : 700000005 }, message: [file] }]);
            const result = await emit({ id: 'CASE_FILE_RECEIPT', account, user, scope: 'private', mention: null, text: '', segments: [file], noReply: true });
            assert.equal(result.sends.length, 0); assert.equal(result.calls.length, 0);
        }
        return { receiptEvents: 4, modelCalls: 0, replies: 0, realQqMessages: 0 };
    });
    await check('private-file-receipt-preserves-new-upload-and-explicit-followup-text', async () => {
        const file = { type: 'file', data: { file: 'comparison.wav', file_id: 'new-file-id', file_size: '1234', url: '', path: '' } };
        const fresh = await emit({ id: 'CASE_FILE_UPLOAD', scope: 'private', mention: null, text: '', segments: [file] });
        assert.ok(fresh.calls.length > 0); assert.ok(fresh.sends.length > 0);
        file.data.file_id = 'sent-default-700000003';
        const followup = await emit({ id: 'CASE_FILE_FOLLOWUP', scope: 'private', mention: null, text: '请解释这些对比版本的区别', segments: [file] });
        assert.ok(followup.calls.length > 0); assert.ok(followup.sends.length > 0);
        return { newUploadResponded: true, explicitFollowupResponded: true, realQqMessages: 0 };
    });
    await check('bilibili-sync-group-tools-add-remove-without-approval-and-preserve-other-group', async () => {
        if(process.env.SIMULATION_BILISYNC !== '1')return {skipped:true};
        const first=await emit({id:'CASE_BILI_SUB_ADD_A',group:'700000012',text:'添加UID123456的动态和开播监听'});
        assert.ok(!visible(first.sends).includes('状态：需确认'));assert.equal(biliState.subs.length,1);assert.equal(biliState.connections.length,2);
        await emit({id:'CASE_BILI_SUB_ADD_B',group:'700000008',text:'添加UID123456的动态和开播监听'});
        assert.equal(biliState.subs.length,1);assert.equal(biliState.connections.length,4);
        await emit({id:'CASE_BILI_SUB_REMOVE_DYNAMIC',group:'700000012',text:'取消UID123456的动态监听'});
        assert.equal(biliState.subs[0].routing.dynamic.length,1);assert.equal(biliState.subs[0].routing.live.length,2);
        await emit({id:'CASE_BILI_SUB_REMOVE_ALL',group:'700000012',text:'取消UID123456的全部监听'});
        const cfg=JSON.parse(await readFile(join(output,'onebot-bilibili.json')));assert.equal(cfg.routes.length,2);assert.ok(cfg.routes.every(r=>r.groupId==='700000008'));
        assert.equal(biliState.subs[0].enabled,true);assert.equal(biliState.subs[0].routing.live.length,1);
        const mutations=biliState.mutations;await emit({id:'CASE_BILI_SUB_GUEST',group:'700000012',user:'188888850',text:'添加UID123456的监听'});assert.equal(biliState.mutations,mutations);
        const firstSystem=first.calls.map(call=>JSON.stringify(call.messages)).join('\n');assert.match(firstSystem,/Scoped business execution/u);assert.match(firstSystem,/bilibili_subscribe/u);
        assert.doesNotMatch(firstSystem,/Group execution gate: no single executor/u);
        assert.ok(sends.every(m=>!visible([m]).includes('状态：需确认')));
        return {synchronized:true,noApproval:true,otherGroupPreserved:true,guestDenied:true,realQqMessages:0,realUpstreamChanges:0};
    });
    await check('bilibili-only-group-batch-uids-uses-dedicated-tools-without-generic-backend-access',async()=>{
        if(process.env.SIMULATION_BILISYNC !== '1')return {skipped:true};
        const result=await emit({id:'CASE_BILI_SUB_MULTIPLE',group:'700000012',text:'添加动态和直播监控：700000009,700000007'});
        const cfg=JSON.parse(await readFile(join(output,'onebot-bilibili.json')));
        for(const uid of ['700000009','700000007']){
            assert.equal(cfg.routes.filter(r=>r.groupId==='700000012'&&r.uid===uid&&r.enabled).length,2);
            const sub=biliState.subs.find(s=>s.uid===uid);assert.ok(sub?.enabled);assert.equal(sub.routing.dynamic.length,1);assert.equal(sub.routing.live.length,1);
        }
        const serialized=result.calls.map(x=>JSON.stringify(x.messages)).join('\n');
        assert.match(serialized,/Scoped business execution/u);assert.doesNotMatch(serialized,/Group execution gate: no single executor/u);
        const exposed=result.calls.flatMap(x=>x.tools??[]).map(x=>x.function?.name??x.name);
        assert.ok(exposed.includes('bilibili_subscribe'));assert.ok(!exposed.includes('exec'));
        assert.ok(!visible(result.sends).includes('状态：需确认'));
        return {trustedAtRecognized:true,twoUidsSynchronized:true,genericExecDenied:true,realQqMessages:0,realUpstreamChanges:0};
    });
    await check('staged-wait-keeps-original-tool-run-and-summarizes-completed-steps', async () => {
        if (process.env.SIMULATION_STAGED !== '1') return { skipped: true };
        const before = sends.length;
        await emit({ id: 'CASE_STAGED_ADSB', text: '查询 ADS-B 状态并汇报', wait: false });
        for (let i = 0; i < 200 && !visible(sends.slice(before)).includes('本次处理汇总'); i++) await pause(200);
        const output = visible(sends.slice(before)); assert.match(output, /阶段进展/u); assert.match(output, /已确认完成的步骤：查询飞机数据/u);
        assert.match(output, /本次处理汇总/u); assert.doesNotMatch(output, /\/root\/|synthetic-simulation-key|PRIVATE_ONLY_SENTINEL/u);
        const executions = (await executionCounts()).filter(x => x.scenario === 'CASE_STAGED_ADSB' && x.name === 'adsb'); assert.equal(executions.length, 1);
        return { progressThenFinal: true, businessExecutions: executions.length, realQqMessages: 0 };
    });
    await check('staged-wait-member-gets-progress-and-hard-deadline-summary-without-late-reply', async () => {
        if (process.env.SIMULATION_STAGED !== '1') return { skipped: true };
        const before = sends.length; await emit({ id: 'CASE_STAGED_HARD', user: '188888845', wait: false });
        for (let i = 0; i < 250 && !visible(sends.slice(before)).includes('总等待上限。'); i++) await pause(200);
        const output = visible(sends.slice(before)); assert.match(output, /阶段进展/u); assert.match(output, /整体结果尚未确认完成/u);
        const finalCount = sends.length; await pause(17000); assert.equal(sends.length, finalCount);
        assert.doesNotMatch(output, /\/root\/|synthetic-simulation-key|PRIVATE_ONLY_SENTINEL/u);
        return { hardDeadlineSummary: true, lateReplies: 0, realQqMessages: 0 };
    });
    await check('staged-wait-private-guest-final-is-not-suppressed-by-progress-cooldown', async () => {
        if (process.env.SIMULATION_STAGED !== '1') return { skipped: true };
        const before = sends.length;
        await emit({ id: 'CASE_STAGED_GUEST', user: '188888846', scope: 'private', mention: null, wait: false });
        for (let i = 0; i < 200 && !visible(sends.slice(before)).includes('本次处理汇总'); i++) await pause(200);
        const output = visible(sends.slice(before)); assert.match(output, /阶段进展/u); assert.match(output, /本次处理汇总/u);
        assert.doesNotMatch(output, /\/root\/|synthetic-simulation-key|PRIVATE_ONLY_SENTINEL/u);
        return { progressAndFinalWithinGuestCooldown: true, realQqMessages: 0 };
    });
    await check('staged-wait-image-analysis-keeps-running-after-its-own-first-deadline', async () => {
        if (process.env.SIMULATION_STAGED !== '1') return { skipped: true };
        const before = sends.length;
        await emit({ id: 'CASE_STAGED_MEDIA', user: '188888847', text: '分析图片', wait: false,
            segments: [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }] });
        for (let i = 0; i < 200 && !visible(sends.slice(before)).includes('本次处理汇总'); i++) await pause(200);
        const output = visible(sends.slice(before)); assert.match(output, /阶段进展/u); assert.match(output, /本次处理汇总/u);
        return { imageAnalysisExtended: true, realQqMessages: 0 };
    });
    await check('supplement-image-understanding-keeps-public-context', async () => {
        const result = await emit({ id: 'CASE_MEDIA_IMAGE', user: '188888830', text: '描述这张图片', segments: [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('image_url'))); assert.ok(result.calls.every(call => !call.privateMarkerPresent));
    });
    await check('supplement-missing-voice-attachment-does-not-block-text', async () => {
        const result = await emit({ id: 'CASE_INVALID_VOICE', user: '188888831', text: '这条语音附件可能失效了，先回复这句文字', segments: [{ type: 'record', data: { file: '/nonexistent-onebot-simulation-voice.amr' } }] }); assert.ok(result.sends.length > 0);
    });
    await check('supplement-bot-echo-does-not-create-a-response-loop', async () => {
        const result = await emit({ id: 'CASE_BOT_ECHO', user: '700000006', noReply: true }); assert.equal(result.sends.length, 0); assert.equal(result.calls.length, 0);
    });
    await check('supplement-member-cannot-switch-group-mode', async () => {
        const result = await emit({ id: 'CASE_DENIED_MODE', user: '188888832', text: '/mode nsfw' }); assert.equal(result.calls.length, 0);
    });
    await check('supplement-two-selected-roles-cannot-execute-admin-backend', async () => {
        const before = (await executionCounts()).filter(entry => entry.name === 'adsb').length;
        await emit({ id: 'CASE_ADSB_MULTIPLE', text: '查询 ADS-B 状态', segments: [{ type: 'at', data: { qq: '700000005' } }] });
        assert.equal((await executionCounts()).filter(entry => entry.name === 'adsb').length, before);
    });
    await check('supplement-dedicated-read-delegation-does-not-grant-shell', async () => {
        const original = policy.features.adsb.actions.read.profile;
        await updatePolicy(config => { config.features.adsb.actions.read.profile = 'group-public'; });
        try {
            const before = (await executionCounts()).filter(entry => entry.name === 'adsb').length;
            const result = await emit({ id: 'CASE_ADSB_DELEGATED', user: '188888833', text: '查询 ADS-B 状态' });
            assert.equal((await executionCounts()).filter(entry => entry.name === 'adsb').length, before + 1);
            assert.ok(result.calls.every(call => !call.tools?.some(tool => ['exec', 'read', 'write', 'network_control'].includes(tool.function?.name))));
        } finally { await updatePolicy(config => { config.features.adsb.actions.read.profile = original; }); }
    });
    await check('supplement-foreign-managed-image-cannot-be-sent-by-group-model', async () => {
        const result = await emit({ id: 'CASE_FOREIGN_MEDIA', text: '模拟模型输出与本请求无关的附件' });
        assert.ok(!result.sends.some(message => message.body.message?.some?.(part => part.type === 'image')));
    });
    await check('admin-group-dedicated-read', async () => { const result = await emit({ id: 'CASE_ADSB', text: '查询 ADS-B 接收器状态' }); assert.ok(result.calls.some(call => call.tools?.some(tool => tool.function?.name === 'adsb_query'))); return { responses: result.sends.length }; });
    await check('member-group-rejects-backend', async () => { const result = await emit({ id: 'CASE_FORBIDDEN', user: '188888801', text: '查询服务器 ADS-B 状态' }); assert.doesNotMatch(visible(result.sends), /状态：已完成/u); return { responses: result.sends.length }; });
    await check('member-group-uses-nickname', async () => { const result = await emit({ id: 'CASE_MEMBER_CHAT', user: '188888802' }); assert.doesNotMatch(visible(result.sends), /舰长/u); return { responses: result.sends.length }; });
    await check('visitor-private-normal-chat', async () => { const result = await emit({ id: 'CASE_VISITOR_CHAT', scope: 'private', user: '188888803', mention: null }); assert.doesNotMatch(visible(result.sends), /舰长/u); return { responses: result.sends.length }; });
    await check('owner-private-positive-memory-control', async () => { const result = await emit({ id: 'CASE_OWNER_PRIVATE', scope: 'private', mention: null }); assert.ok(result.calls.some(call => call.privateMarkerPresent)); return { privateMarkerPresentOnlyHere: true }; });
    await check('yuexia-private-owner-route', async () => { const result = await emit({ id: 'CASE_YUEXIA_PRIVATE', scope: 'private', account: 'yuexia', mention: null }); assert.ok(result.sends.every(message => message.accountId === 'yuexia')); return { account: 'yuexia' }; });
    await check('visitor-private-cannot-request-backend', async () => { const before = (await executionCounts()).filter(entry => entry.name === 'adsb').length; await emit({ id: 'CASE_VISITOR_FORBIDDEN', user: '188888820', scope: 'private', mention: null, text: '查询服务器 ADS-B 状态' }); assert.equal((await executionCounts()).filter(entry => entry.name === 'adsb').length, before); });
    await check('mention-only-group-ignores-unmentioned', async () => { const result = await emit({ id: 'CASE_MENTION_IGNORE', group: '700000008', mention: null, noReply: true }); assert.equal(result.sends.length, 0); assert.equal(result.calls.length, 0); });
    await check('mention-only-group-responds-to-explicit-role', async () => { const result = await emit({ id: 'CASE_MENTION_CHAT', group: '700000008', user: '188888804' }); assert.doesNotMatch(visible(result.sends), /舰长/u); });
    await check('unconfigured-group-never-dispatches', async () => { const result = await emit({ id: 'CASE_UNKNOWN_GROUP', group: '999999999', noReply: true }); assert.equal(result.sends.length, 0); assert.equal(result.calls.length, 0); });
    await check('guest-fixed-quota-query', async () => { const result = await emit({ id: 'CASE_QUOTA_QUERY', user: '188888805', text: '/agy quota' }); assert.match(visible(result.sends), /75%/u); });
    await check('guest-fixed-quota-refresh', async () => { const result = await emit({ id: 'CASE_QUOTA_REFRESH', user: '188888806', text: '/agy refresh' }); assert.match(visible(result.sends), /75%/u); });
    await check('guest-quota-disabled-does-not-execute-script', async () => { const before = (await executionCounts()).filter(entry => entry.name === 'agy').length; await updatePolicy(config => { config.features.quota.enabled = false; }); const result = await emit({ id: 'CASE_QUOTA_DISABLED', user: '188888821', text: '/agy refresh' }); assert.match(visible(result.sends), /未开放/u); assert.equal((await executionCounts()).filter(entry => entry.name === 'agy').length, before); await updatePolicy(config => { config.features.quota.enabled = true; }); });
    await check('guest-unlimited-private-sequential-replies-within-one-minute-both-accounts', async () => {
        for (const account of ['default', 'yuexia']) {
            const user = account === 'default' ? '188888861' : '188888862';
            const first = await emit({ id: `CASE_GUEST_UNLIMITED_${account}_ONE`, user, account, scope: 'private', mention: null, text: '你好，今天心情不错' });
            const firstReplyAt = first.sends.at(-1).at;
            const second = await emit({ id: `CASE_GUEST_UNLIMITED_${account}_TWO`, user, account, scope: 'private', mention: null, text: '接着聊，想听听你的想法' });
            assert.ok(first.sends.length > 0); assert.ok(second.sends.length > 0);
            assert.ok(second.sends[0].at - firstReplyAt < 60000, 'two replies must arrive within former cooldown');
            for (const result of [first, second]) {
                assert.ok(result.calls.every(call => !call.privateMarkerPresent));
                assert.ok(result.calls.every(call => !call.tools?.some(tool => ['exec', 'read', 'write', 'network_control'].includes(tool.function?.name))));
            }
        }
        return { accounts: ['default', 'yuexia'], legacyConfiguredCooldownMs: 60000, repliesPerAccount: 2, permissionsUnchanged: true };
    });
    await check('forward-member-nested-text-and-image-are-in-public-model-context', async () => {
        forwards.set('sim-forward-child', [{ sender: { user_id: 199999991, nickname: '记录内作者' }, time: 1700000000, content: [{ type: 'text', data: { text: 'NESTED_FORWARD_PUBLIC_ORIGINAL' } }, { type: 'image', data: { file: `base64://${png.toString('base64')}` } }] }]);
        forwards.set('sim-forward-member', [{ sender: { user_id: 199999992, nickname: 'admin（展示名）' }, content: [{ type: 'text', data: { text: 'FORWARD_ROOT_PUBLIC_ORIGINAL' } }, { type: 'forward', data: { id: 'sim-forward-child' } }] }]);
        const before = forwardReads.length;
        const result = await emit({ id: 'CASE_FORWARD_MEMBER', user: '188888851', text: '总结这份聊天记录和其中图片', segments: [{ type: 'forward', data: { id: 'sim-forward-member' } }] });
        assert.deepEqual(forwardReads.slice(before).map(x => x.id), ['sim-forward-member', 'sim-forward-child']);
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('NESTED_FORWARD_PUBLIC_ORIGINAL')));
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('image_url')));
        assert.ok(result.calls.every(call => !call.privateMarkerPresent));
        assert.ok(result.calls.every(call => !call.tools?.some(tool => ['exec', 'read', 'write', 'network_control'].includes(tool.function?.name))));
    });
    await check('forward-admin-private-record-enters-only-owner-private-model', async () => {
        forwards.set('sim-forward-owner', [{ sender: { user_id: 199999993, nickname: '作者' }, content: [{ type: 'text', data: { text: 'OWNER_PRIVATE_FORWARD_SENTINEL' } }] }]);
        const result = await emit({ id: 'CASE_FORWARD_OWNER', scope: 'private', mention: null, text: '总结这份记录', segments: [{ type: 'forward', data: { id: 'sim-forward-owner' } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('OWNER_PRIVATE_FORWARD_SENTINEL')));
        assert.ok(result.calls.filter(call => JSON.stringify(call.messages).includes('OWNER_PRIVATE_FORWARD_SENTINEL')).every(call => call.agentScope === 'private'));
    });
    await check('forward-quote-expands-only-after-same-group-validation', async () => {
        forwards.set('sim-forward-quoted', [{ sender: { user_id: 199999994, nickname: '被引用记录作者' }, content: [{ type: 'text', data: { text: 'QUOTED_FORWARD_PUBLIC_SENTINEL' } }] }]);
        const id = String(++eventId); quotes.set(id, { message_id: Number(id), message_type: 'group', group_id: 700000011, sender: { user_id: 199999995 }, message: [{ type: 'forward', data: { id: 'sim-forward-quoted' } }] });
        const result = await emit({ id: 'CASE_FORWARD_QUOTE', user: '188888852', text: '总结引用的聊天记录', segments: [{ type: 'reply', data: { id } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('QUOTED_FORWARD_PUBLIC_SENTINEL')));
        assert.ok(result.calls.every(call => !call.privateMarkerPresent));
    });
    await check('forward-cross-group-quote-never-fetches-the-record', async () => {
        forwards.set('sim-forward-cross-group', [{ content: [{ type: 'text', data: { text: 'CROSS_GROUP_FORWARD_NEVER_VISIBLE' } }] }]);
        const id = String(++eventId); quotes.set(id, { message_id: Number(id), message_type: 'group', group_id: 700000008, sender: { user_id: 199999996 }, message: [{ type: 'forward', data: { id: 'sim-forward-cross-group' } }] });
        const before = forwardReads.length;
        const result = await emit({ id: 'CASE_FORWARD_CROSS', user: '188888853', text: '总结引用的聊天记录', segments: [{ type: 'reply', data: { id } }] });
        assert.equal(forwardReads.length, before); assert.ok(result.calls.every(call => !JSON.stringify(call.messages).includes('CROSS_GROUP_FORWARD_NEVER_VISIBLE')));
    });
    await check('forward-expired-record-is-reported-unavailable-in-model-context', async () => {
        const result = await emit({ id: 'CASE_FORWARD_EXPIRED', user: '188888854', text: '总结聊天记录', segments: [{ type: 'forward', data: { id: 'sim-forward-expired' } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('合并聊天记录未能读取')));
    });
    await check('forward-no-text-still-carries-record-instead-of-empty-message', async () => {
        forwards.set('sim-forward-only', [{ content: [{ type: 'text', data: { text: 'FORWARD_WITHOUT_CAPTION_SENTINEL' } }] }]);
        const result = await emit({ id: 'CASE_FORWARD_ONLY', user: '188888855', text: '', segments: [{ type: 'forward', data: { id: 'sim-forward-only' } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('FORWARD_WITHOUT_CAPTION_SENTINEL')));
    });
    await check('forward-private-visitor-can-read-attached-record-without-tools-or-owner-memory', async () => {
        forwards.set('sim-forward-visitor', [{ content: [{ type: 'text', data: { text: 'VISITOR_FORWARD_PUBLIC_SENTINEL' } }] }]);
        const result = await emit({ id: 'CASE_FORWARD_VISITOR', user: '188888856', scope: 'private', mention: null, text: '看看这份聊天记录', segments: [{ type: 'forward', data: { id: 'sim-forward-visitor' } }] });
        assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('VISITOR_FORWARD_PUBLIC_SENTINEL')));
        assert.ok(result.calls.every(call => !call.privateMarkerPresent));
    });
    await check('forward-media-revocation-prevents-lookup-and-model-dispatch', async () => {
        const before = forwardReads.length;
        const previous = policy.features.conversation.actions.media.enabled;
        await updatePolicy(config => { config.features.conversation.actions.media.enabled = false; });
        try {
            const result = await emit({ id: 'CASE_FORWARD_DISABLED', user: '188888857', text: '总结记录', segments: [{ type: 'forward', data: { id: 'sim-forward-disabled' } }] });
            assert.equal(forwardReads.length, before); assert.equal(result.calls.length, 0); assert.match(visible(result.sends), /未开放媒体理解/u);
        } finally { await updatePolicy(config => { config.features.conversation.actions.media.enabled = previous; }); }
    });
    await check('forward-mention-only-group-ignores-unaddressed-record', async () => {
        const before = forwardReads.length;
        const result = await emit({ id: 'CASE_FORWARD_NO_MENTION', user: '188888858', group: '700000012', mention: null, text: '', noReply: true, segments: [{ type: 'forward', data: { id: 'sim-forward-no-mention' } }] });
        assert.equal(forwardReads.length, before); assert.equal(result.calls.length, 0); assert.equal(result.sends.length, 0);
    });
    await check('same-group-quote-original-text', async () => { const id = String(++eventId); quotes.set(id, { message_id: Number(id), message_type: 'group', group_id: 700000011, sender: { user_id: 188888807, nickname: '原作者' }, message: [{ type: 'text', data: { text: 'SAME_GROUP_QUOTED_ORIGINAL' } }] }); const result = await emit({ id: 'CASE_QUOTED', segments: [{ type: 'reply', data: { id } }], text: '解释被引用的原话' }); assert.ok(result.calls.some(call => JSON.stringify(call.messages).includes('SAME_GROUP_QUOTED_ORIGINAL'))); });
    await check('cross-group-quote-excludes-original', async () => { const id = String(++eventId); quotes.set(id, { message_id: Number(id), message_type: 'group', group_id: 700000008, sender: { user_id: 188888808 }, message: [{ type: 'text', data: { text: 'CROSS_GROUP_FORBIDDEN_SENTINEL' } }] }); const result = await emit({ id: 'CASE_CROSS_QUOTE', segments: [{ type: 'reply', data: { id } }], text: '解释被引用的原话' }); assert.ok(result.calls.every(call => !JSON.stringify(call.messages).includes('CROSS_GROUP_FORBIDDEN_SENTINEL'))); });
    await check('member-image-generate-fixed-handler', async () => { const result = await emit({ id: 'CASE_IMAGE_GENERATE', user: '188888809', text: '生成一张花园图片' }); assert.ok(result.sends.some(message => message.body.message?.some?.(part => part.type === 'image'))); });
    await check('member-image-edit-fixed-handler', async () => { const result = await emit({ id: 'CASE_IMAGE_EDIT', user: '188888810', text: '修改这张图片为花园风格', segments: [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }] }); assert.ok(result.sends.some(message => message.body.message?.some?.(part => part.type === 'image'))); });
    await check('admin-reference-image-uses-approved-dedicated-chain', async () => { const result = await emit({ id: 'CASE_IMAGE_REFERENCE', text: '先搜索官方角色立绘参考图，再生成爱莉希雅花园图片' }); assert.ok(result.sends.some(message => message.body.message?.some?.(part => part.type === 'image'))); });
    await check('destination-context-private-group-scheduled-bidirectional', async () => {
        await emit({ id: 'CASE_DESTINATION_PRIVATE_SOURCE', scope: 'private', text: 'DESTINATION_PRIVATE_SOURCE_SENTINEL 我今天想早点休息。' });
        await emit({ id: 'CASE_DESTINATION_GROUP_SOURCE', user: '188888888', text: 'DESTINATION_GROUP_SOURCE_SENTINEL 今天准备吃香锅。' });
        const services = JSON.parse(await readFile(join(output, 'onebot-services.json')));
        const helper = 'qq-auto-elysia-normal-helper';
        for (const scope of ['group', 'private']) {
            const group = scope === 'group', target = `${scope}:${group ? '700000011' : '700000003'}`;
            const created = await cron(['add', '--name', `destination-context-${scope}`, '--cron', '0 23 * * *', '--tz', 'Asia/Shanghai',
                '--agent', helper, '--message', '参考同一目标会话的近期公开或本人私聊记录，给出一条自然提醒。', '--tools', '',
                '--announce', '--channel', 'onebot', '--account', 'default', '--to', target, '--timeout-seconds', '90', '--json']);
            const id = created.id ?? created.job?.id; assert.ok(id);
            policy.automationBindings[id] = { feature: 'automation', enabled: true, name: `context-${scope}`, deliveryGroupIds: group ? ['700000011'] : [] };
            services.jobs[id] = { kind: 'agent', feature: 'automation', accountId: 'default', agentId: helper, actions: [] };
            await writeFile(join(output, 'onebot-services.json'), JSON.stringify(services));
            await writeFile(join(output, 'onebot-features.json'), JSON.stringify(policy));
            active = group ? 'CASE_DESTINATION_CRON_GROUP' : 'CASE_DESTINATION_CRON_PRIVATE';
            await writeFile(join(output, 'scenario.json'), JSON.stringify({ id: active }));
            const before = modelCalls.length, sentBefore = sends.length;
            await cron(['run', id, '--expect-final', '--timeout', '100000']);
            for (let i = 0; i < 300 && !sends.slice(sentBefore).some(msg => visible([msg]).includes(group ? 'DESTINATION_GROUP_REMINDER_SENTINEL' : 'DESTINATION_PRIVATE_REMINDER_SENTINEL')); i++) await pause(100);
            const calls = modelCalls.slice(before).filter(call => call.agentId === helper && call.model === 'gemini-3.8-flash-high');
            assert.ok(calls.length, `missing ${scope} cron model request`);
            const input = JSON.stringify(calls[0].messages);
            assert.ok(input.includes(group ? 'DESTINATION_GROUP_SOURCE_SENTINEL' : 'DESTINATION_PRIVATE_SOURCE_SENTINEL'), `${scope} cron must see its chat`);
            assert.ok(!input.includes(group ? 'DESTINATION_PRIVATE_SOURCE_SENTINEL' : 'DESTINATION_GROUP_SOURCE_SENTINEL'), `${scope} cron crossed destination`);
            assert.ok(sends.slice(sentBefore).some(msg => visible([msg]).includes(group ? 'DESTINATION_GROUP_REMINDER_SENTINEL' : 'DESTINATION_PRIVATE_REMINDER_SENTINEL')), `${scope} reminder must be sent`);
            await cron(['disable', id]);
        }
        const groupReply = await emit({ id: 'CASE_DESTINATION_GROUP_NEXT', user: '188888889', text: '刚才推荐了什么？' });
        const groupInput = groupReply.calls.filter(call => call.model === 'gemini-3.8-flash-high' && call.agentScope === 'group').map(call => JSON.stringify(call.messages)).join('\n');
        assert.ok(groupInput.includes('DESTINATION_GROUP_REMINDER_SENTINEL'), 'different member must see delivered group reminder');
        assert.ok(!groupInput.includes('DESTINATION_PRIVATE_REMINDER_SENTINEL'), 'group must not see private reminder');
        const privateReply = await emit({ id: 'CASE_DESTINATION_PRIVATE_NEXT', scope: 'private', text: '刚才提醒我什么？' });
        const privateInput = privateReply.calls.filter(call => call.model === 'gemini-3.8-flash-high' && call.agentId === 'main').map(call => JSON.stringify(call.messages)).join('\n');
        assert.ok(privateInput.includes('DESTINATION_PRIVATE_REMINDER_SENTINEL'), 'private chat must see delivered private reminder');
        assert.ok(!privateInput.includes('DESTINATION_GROUP_REMINDER_SENTINEL'), 'private must not pull group context');
        return { groupBidirectional: true, privateBidirectional: true, differentGroupMember: true, destinationIsolation: true, realQqMessages: 0 };
    });
    await check('conversation-context-primary-fallback-primary', async () => {
        const first = await emit({id:'CASE_CONTEXT_INITIAL',scope:'private',text:'记住我喜欢蓝色。'});
        assert.match(visible(first.sends), /CONTEXT_PRIMARY_INITIAL/u);
        const secondary = await emit({id:'CASE_CONTEXT_FALLBACK',scope:'private',text:'继续确认刚才的安排。'});
        assert.match(visible(secondary.sends), /备用链路的模拟回复已经准备好/u);
        const last = await emit({id:'CASE_CONTEXT_FINAL',scope:'private',text:'复述已经确认的安排。'});
        assert.match(visible(last.sends), /CONTEXT_PRIMARY_FINAL/u);
        const primary = last.calls.filter(call=>call.model==='gemini-3.8-flash-high' && call.agentId==='main');
        assert.ok(primary.length>0, 'next primary invocation is observable');
        const lastInput=JSON.stringify(primary.at(-1).messages);
        assert.ok(lastInput.includes('备用链路的模拟回复已经准备好。'), 'delivered fallback is in next primary input');
        assert.ok(!lastInput.includes('LLM request failed.'), 'unsent failed primary candidate is excluded');
        const fallback=secondary.calls.find(call=>call.model.startsWith('qwen') && JSON.stringify(call.messages).includes('你在给 QQ 回复做终审'));
        assert.ok(fallback && JSON.stringify(fallback.messages).includes('CONTEXT_PRIMARY_INITIAL'), 'fallback sees delivered primary answer');
        const secondPrimary = secondary.calls.find(call=>call.model==='gemini-3.8-flash-high' && call.agentId==='main');
        const system = secondPrimary.messages.filter(message=>message.role==='system').map(message=>textOf(message.content)).join('\n');
        const primaryWindow = system.split('[Shared conversation transcript]\n')[1]?.split('\n[End shared conversation transcript]')[0]?.split('\n').slice(1).join('\n');
        const fallbackPrompt = fallback.messages.filter(message=>message.role==='user').map(message=>textOf(message.content)).join('\n');
        const fallbackWindow = fallbackPrompt.split('最近对话实录与摘要（可能为空）：\n')[1]?.split('\n\n主模型最终回复：')[0];
        assert.ok(primaryWindow && fallbackWindow, 'both route windows are observable');
        assert.equal(primaryWindow, fallbackWindow, 'both routes receive exactly the same shared text');
        assert.match(logs, /Conversation transcript committed=true/u);
        return {rounds:3,primaryReadsDeliveredFallback:true,fallbackReadsDeliveredPrimary:true,identicalSharedWindow:true,unsentCandidateExcluded:true};
    });
    await check('group-text-fallback-keeps-public-workspace', async () => { const result = await emit({ id: 'CASE_FALLBACK', user: '188888811' }); assert.match(visible(result.sends), /备用链路/u); assert.ok(result.calls.every(call => !call.privateMarkerPresent)); });
    await check('gemini-native-grounding-is-not-local-tool', async () => { const result = await emit({ id: 'CASE_SEARCH', text: '搜索今天的新闻' }); assert.ok(result.calls.some(call => call.tools?.some(tool => tool.googleSearch != null) && !call.tools.some(tool => tool.function?.name === 'web_search'))); });
    await check('yuexia-group-role-account', async () => { const result = await emit({ id: 'CASE_YUEXIA_GROUP', mention: '700000005', user: '188888812' }); assert.ok(result.sends.every(message => message.accountId === 'yuexia')); assert.ok(result.calls.every(call => !call.privateMarkerPresent)); });
    await check('ordinary-two-role-group-arbitration-is-public', async () => { const result = await emit({ id: 'CASE_TWO_ROLE_CHAT', user: '188888822', mention: null }); assert.ok(result.sends.length > 0); assert.ok(result.calls.every(call => !call.privateMarkerPresent)); });
    await check('group-normal-grok-normal-workspace-routing', async () => {
        await emit({ id: 'CASE_MODE_SWITCH', text: '/mode nsfw' });
        const result = await emit({ id: 'CASE_GROUP_GROK', user: '188888823' }); assert.ok(result.calls.some(call => call.model === 'grok-4.7')); assert.ok(result.calls.every(call => !call.privateMarkerPresent));
        await emit({ id: 'CASE_MODE_NORMAL', text: '/mode normal' });
    });
    await check('private-yuexia-mode-does-not-change-elysia-or-share-grok-workspace', async () => {
        await emit({ id: 'CASE_YUEXIA_PRIVATE_MODE', scope: 'private', account: 'yuexia', mention: null, text: '/mode nsfw' });
        const result = await emit({ id: 'CASE_YUEXIA_GROK', scope: 'private', account: 'yuexia', mention: null }); assert.ok(result.calls.some(call => call.model === 'grok-4.7'));
        const elysia = await emit({ id: 'CASE_OWNER_PRIVATE_STILL_NORMAL', scope: 'private', mention: null }); assert.ok(elysia.calls.some(call => call.model === 'gemini-3.8-flash-high'));
        await emit({ id: 'CASE_YUEXIA_PRIVATE_NORMAL', scope: 'private', account: 'yuexia', mention: null, text: '/mode normal' });
    });
    await check('network-control-waits-for-bound-confirmation', async () => { const result = await emit({ id: 'CASE_NETWORK', text: '重启宿主机网络代理服务' }); const prompt = result.sends.find(message => visible([message]).includes('状态：需确认')); assert.ok(prompt, 'missing business confirmation'); configuration._approvalMessage = prompt.messageId; });
    await check('unrelated-chat-continues-while-approval-pending', async () => { const result = await emit({ id: 'CASE_UNRELATED', user: '188888813' }); assert.ok(result.sends.length > 0); });
    await check('member-cannot-resolve-admin-control-approval', async () => { const before = (await executionCounts()).filter(entry => entry.name === 'network' && entry.action === 'restart').length; await emit({ id: 'CASE_MEMBER_CONFIRM', user: '188888824', text: '确认', segments: [{ type: 'reply', data: { id: configuration._approvalMessage } }] }); assert.equal((await executionCounts()).filter(entry => entry.name === 'network' && entry.action === 'restart').length, before); });
    await check('business-approval-survives-gateway-restart', async () => { await stop(); await start(); const result = await emit({ id: 'CASE_CONFIRM', text: '确认', segments: [{ type: 'reply', data: { id: configuration._approvalMessage } }] }); assert.match(visible(result.sends), /已完成|确认已经生效/u); });
    await simulateAutomations();
    await simulateIngress();
    await check('public-primary-and-all-helpers-exclude-private-marker', async () => { const publicCalls = modelCalls.filter(call => call.agentScope !== 'private'); assert.ok(publicCalls.length > 20); assert.ok(publicCalls.every(call => !call.privateMarkerPresent)); return { checkedRequests: publicCalls.length, scopeSource: 'actual request system Runtime agent, independent of asynchronous test label' }; });
} catch (error) { results.push({ name: 'harness', passed: false, error: error.stack }); console.log(`FAIL harness: ${error.message}`); }
finally {
    releaseStreamSlow?.(); await stop(); for (const ws of connections.values()) ws.terminate(); wsServer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await writeFile(join(output, 'gateway.log'), logs, { mode: 0o600 });
    await writeFile(join(output, 'model-calls.json'), JSON.stringify(modelCalls, null, 2), { mode: 0o600 });
    await writeFile(join(output, 'sends.json'), JSON.stringify(sends, null, 2), { mode: 0o600 });
    const report = { simulated: true, filter: process.env.SIMULATION_FILTER ?? null, realQqMessages: 0, realBusinessWrites: 0, root: output, total: results.length, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results };
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, root: output })); if (report.failed) process.exitCode = 1;
}
