// Loaded only by the explicit isolated simulation command, never production.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.ONEBOT_CONFIG_ROOT;
if (process.env.ONEBOT_SIMULATION !== '1' || !root?.includes('/simulation-')) throw new Error('simulation preload requires an isolated simulation root');
// Shorten only the staged-deadline fixture's five-minute timer. This preload
// requires explicit isolated simulation mode and is never loaded in production.
if (process.env.SIMULATION_STAGED === '1') {
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => timer(callback, delay === 300000 ? 30000 : delay, ...args);
}
const original = childProcess.execFile;
if (process.env.SIMULATION_BILISYNC === '1') {
    const target = new URL(process.env.ONEBOT_SIM_BILI_URL);
    if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:') throw new Error('Bilibili simulation requires loopback');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url ?? input);
        return originalFetch(url.origin === 'http://127.0.0.1:8787' ? `${target.origin}/bili${url.pathname}${url.search}` : input, options);
    };
}
function current() { try { return JSON.parse(readFileSync(`${root}/scenario.json`)).id; } catch { return 'startup'; } }
const originalRandom = Math.random;
Math.random = () => current().startsWith('CASE_SPEECH_') ? current().includes('NO_APPEND') ? 0.9 : 0.1 : originalRandom();
function log(value) { appendFileSync(`${root}/executions.jsonl`, JSON.stringify({ at: Date.now(), scenario: current(), ...value }) + '\n', { mode: 0o600 }); }
function mocked(file, args) {
    const text = [file, ...args].join(' ');
    if (file === '/usr/local/bin/openclaw') {
        if (args[0] === 'agent') log({ kind: 'helper', agent: args[args.indexOf('--agent') + 1], sessionKey: args[args.indexOf('--session-key') + 1] });
        return null;
    }
    if (file === '/bin/sh') {
        // Classification curl is allowed only to the harness loopback endpoint.
        return null;
    }
    const script = args[0] ?? '';
    if (file === '/usr/bin/python3' && script.endsWith('/elysia-tts/scripts/synthesize.py')) {
        log({ kind: 'business', name: 'tts', text: args[args.indexOf('--text') + 1] });
        return JSON.stringify({ ok: true, preset: 'elysia-light-v1', audio_output: `${root}/fixtures/speech.wav` });
    }
    if (file.endsWith('/node') && /qzone-cli\.mjs$/u.test(script)) {
        log({ kind: 'business', name: 'qzone', action: args[1] });
        return JSON.stringify({ ok: true, code: 0, msglist: [{ tid: 'synthetic-tid', content: '模拟动态' }], tid: 'synthetic-published-tid' });
    }
    if (file === '/usr/bin/systemctl') { log({ kind: 'business', name: 'network', action: args[0] }); return args[0] === 'show' ? 'ActiveState=active\nSubState=running\n' : 'simulated control only\n'; }
    if (file === '/bin/bash' || text.includes('/skills/')) {
        if (text.includes('agy-proxy-diagnose.sh')) {
            const action = file.endsWith('agy-proxy-diagnose.sh') ? args[0] : args[1]; log({ kind: 'business', name: 'agy', action });
            if (action === 'quota' || action === 'refresh') return `${action === 'refresh' ? 'refresh_http=200\nrefresh_total=1\nrefresh_success=1\nrefresh_failed=0\n' : ''}account_1 forbidden=false disabled=false subscription_tier=PRO model_count=1\naccount_1 model=gemini-3.8-flash-high remaining=75% reset=2026-10-17T00:00:00Z\n`;
            const path = `/tmp/agy-proxy-${action === 'image-edit' ? 'edited' : 'generated'}.S${process.pid}${Date.now()}.png`;
            writeFileSync(path, readFileSync(`${root}/fixtures/generated.png`));
            return `image_output=${path}\nvisual_verification=passed\n`;
        }
        if (text.includes('adsb_query.sh')) { log({ kind: 'business', name: 'adsb', action: args[1] }); return '{"status":"ok","aircraft":2}\n'; }
        if (text.includes('rewards-summary.sh')) { log({ kind: 'business', name: 'rewards', action: 'summary' }); return '{"ok":true,"balance":5000,"todayGained":100,"tasks":[]}\n'; }
        if (text.includes('alas-diagnose.sh')) { log({ kind: 'business', name: 'alas', action: args[1] }); return 'SCHEDULER=stopped\nSIMULATION=1\n'; }
        if (text.includes('qbtctl.sh')) { log({ kind: 'business', name: 'downloads', action: args[1] }); return '{"ok":true,"state":"running"}\n'; }
        if (text.includes('capture.sh')) return `STATUS=ok\nIMAGE=${root}/fixtures/generated.png\n`;
        log({ kind: 'blocked-executable', executable: file }); throw new Error('unknown executable blocked by simulation');
    }
    return null;
}
function execFile(file, args = [], options = {}, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (file === '/usr/bin/python3' && args[0]?.endsWith('/elysia-tts/scripts/synthesize.py') && current().includes('SYNTH_FAIL')) {
        log({ kind: 'business', name: 'tts', action: 'synthetic-failure' });
        const child = new EventEmitter(); child.kill = () => true;
        process.nextTick(() => callback?.(Object.assign(new Error('private command failed'), { code: 1 }),
            JSON.stringify({ ok: false, reason: 'generation_failed', log: `${root}/missing-private.log` }), ''));
        return child;
    }
    let stdout;
    try { stdout = mocked(file, args); }
    catch (error) { stdout = ''; const child = new EventEmitter(); child.kill = () => true; process.nextTick(() => callback?.(error, '', 'simulation blocked')); return child; }
    if (stdout === null) return original(file, args, options, callback);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.pid = 99999999;
    process.nextTick(() => { child.stdout.end(stdout); child.stderr.end(); callback?.(null, stdout, ''); child.emit('exit', 0); child.emit('close', 0); });
    return child;
}
execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
}));
childProcess.execFile = execFile;
syncBuiltinESMExports();
