import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {onebotPath,onebotRoot} from '../paths.js';
const running = new Set(['starting','waiting_for_verification','checking']);
export function verificationAdmission(state, now=Date.now()) {
    if (!state) return 'start';
    if (running.has(state.status) && state.expiresAt>now) return 'pending';
    if (state.cooldownUntil>now) return 'cooldown';
    return 'start';
}
export function xhsVerificationPending() {
    if(onebotRoot!=='/root/.openclaw')return false;
    try {
        const cfg=JSON.parse(readFileSync(onebotPath('onebot-xhs.json'),'utf8'));
        if(cfg.manualVerification?.enabled!==true)return false;
        return verificationAdmission(JSON.parse(readFileSync(`${cfg.dataDir}/manual-verification.json`,'utf8')))==='pending';
    }catch{return false;}
}
export function requestXhsVerification() {
    // The live operator workflow must never be launched by isolated simulators.
    if (onebotRoot !== '/root/.openclaw') return {status:'unavailable'};
    try {
        const cfg=JSON.parse(readFileSync(onebotPath('onebot-xhs.json'),'utf8'));
        if (cfg.manualVerification?.enabled!==true) return {status:'disabled'};
        let state;
        try {state=JSON.parse(readFileSync(`${cfg.dataDir}/manual-verification.json`,'utf8'));} catch {}
        const decision=verificationAdmission(state);
        if(decision!=='start') return {status:decision};
        // Runner holds a cross-process operator lock and the account site lock.
        // No URL or credential is returned through this untrusted tool path.
        const child=spawn(process.execPath,['/root/.openclaw/onebot-onebot-custom/scripts/xhs-verify.mjs'],
            {detached:true,stdio:'ignore',env:{...process.env}});
        child.on('error',()=>{});child.unref();
        return {status:'requested'};
    } catch {return {status:'unavailable'};}
}
