import {ReachXhsRecovery} from './xhs-reach-recovery.js';
import {ReachXhsBackend} from '../xhs/backends/reach.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {onebotPath,onebotRoot} from '../paths.js';
import {authorizeFeature,loadFeatureConfig} from '../feature-policy.js';
import {XhsSmsRecovery} from './xhs-sms-recovery.js';

let coordinator,timer;
const handlers=new Map();
function config() {return JSON.parse(readFileSync(onebotPath('onebot-xhs.json'),'utf8'));}
function admins() {
    const p=loadFeatureConfig();
    return (p.accounts.default?.privateAdminIds ?? []).filter(id=>p.identities.adminIds.includes(id)
        && authorizeFeature(p,'xiaohongshu','read',{accountId:'default',scope:'private',senderId:id}).allowed);
}
function enabled() {try {const c=config();return c.enabled===true && (c.backend==='agent-reach'?c.reachRecovery?.enabled===true:c.smsRecovery?.enabled===true);}catch{return false;}}
function assertEnabled() {if(!enabled()||!admins().length)throw Object.assign(new Error('authorization_revoked'),{code:'authorization_revoked'});}
function get() {
    // Simulators must never send real SMS or notifications.
    if(onebotRoot!=='/root/.openclaw')return null;
    if(coordinator)return coordinator;
    const cfg=config();
    if(cfg.backend==='agent-reach'){
        if(cfg.reachRecovery?.enabled!==true)return null;
        const backend=new ReachXhsBackend();
        coordinator=new ReachXhsRecovery({file:onebotPath('state/business/xhs-reach-recovery.json'),admins,
            send:(id,text)=>handlers.get('default')?.send(id,text),
            sendQr:(id,image,kind)=>handlers.get('default')?.sendQr(id,image,kind),
            status:()=>backend.status(),prepare:()=>backend.call('prepare_login',{}),
            verify:()=>backend.call('search',{query:'咖啡',limit:1}),
            authorize:async c=>enabled()&&authorizeFeature(loadFeatureConfig(),'xiaohongshu','read',c).allowed,
            resume:accountId=>handlers.get(accountId)?.resume});
        return coordinator;
    }
    if(!cfg.smsRecovery)return null;
    coordinator=new XhsSmsRecovery({file:onebotPath('state/business/xhs-sms-recovery.json'),
        phoneFile:onebotPath('secrets/xhs-phone.json'),threshold:2,
        admins,
        send:async(id,text)=>{
            const handler=handlers.get('default');if(!handler)throw new Error('admin_transport_unavailable');
            return handler.send(id,text);
        },
        login:async(operation,value)=>{
            assertEnabled();
            // Reuse the documented and tested SMS module, not the model's XHS
            // tool interface. Same root + site-account lock across both phases.
            const base='/root/komachi-xhs-js/src/';
            const [{SmsLogin},{HttpBackend},{SessionStore},{Store}]=await Promise.all(
                ['backends/sms-login.js','backends/http.js','infra/session.js','infra/store.js'].map(p=>import(pathToFileURL(base+p).href)));
            const root=config().dataDir,store=new Store(root);let release;
            try {
                release=store.lock('site-account');
                const sessions=new SessionStore(root),save=sessions.save.bind(sessions);
                sessions.save=(data,opts={})=>save(data,{...opts,beforeCommit:async()=>{assertEnabled();await opts.beforeCommit?.();}});
                const backend=new HttpBackend({sessionStore:sessions});
                try {const login=new SmsLogin(backend);
                    return operation==='send'?await login.send({phone:value,apiVersion:'auto',signal:AbortSignal.timeout(90000)})
                        :await login.complete({code:value,signal:AbortSignal.timeout(90000)});
                } finally {await backend.close();}
            } finally {release?.();store.close();}
        },
        authorize:async c=>enabled() && authorizeFeature(loadFeatureConfig(),'xiaohongshu','read',c).allowed,
        resume:accountId=>handlers.get(accountId)?.resume,
    });
    return coordinator;
}
export function smsRecoveryEnabled() {return onebotRoot==='/root/.openclaw' && enabled();}
export function xhsSmsPending() {try{return enabled() && get()?.pending()===true;}catch{return false;}}
export async function observeXhsChallenge(result,context) {
    if(!smsRecoveryEnabled())return null;
    return get()?.observe(result,context);
}
export function rememberXhsRecoveryTurn(context,{batchKey,messages,dispatchOptions},sessionKey) {
    if(!smsRecoveryEnabled())return;
    // Persist only the original XHS request and routing, never arbitrary state
    // from the gateway, model histories or authentication events.
    const safe=messages.map(m=>({text:String(m.text ?? '').slice(0,16000),images:[],recordSegments:[],event:{
        time:m.event.time,self_id:m.event.self_id,message_type:m.event.message_type,message_id:m.event.message_id,
        user_id:m.event.user_id,group_id:m.event.group_id,sender:{nickname:m.event.sender?.nickname,card:m.event.sender?.card},
        message:(Array.isArray(m.event.message)?m.event.message:[{type:'text',data:{text:m.text}}]).filter(s=>['text','at','reply'].includes(s.type)),raw_message:''}}));
    get()?.remember({...context,sessionKey},{batchKey,messages:safe,dispatchOptions:{groupSelectionExplicit:context.explicit,
        roleAgentId:dispatchOptions.roleOverride?.agentId},recovery:dispatchOptions.xhsRecovery===true});
}
export function finishXhsRecoveryTurn(context) {try {get()?.finish(context);}catch{}}
export async function handleXhsAuthReply(event,accountId) {
    const reply=Array.isArray(event.message)?event.message.find(s=>s.type==='reply')?.data?.id:null;
    let c;try{c=get();}catch{
        // If durable bindings are unreadable, do not log a likely private auth
        // value while the host cannot establish which request it belongs to.
        const text=Array.isArray(event.message)?event.message.filter(s=>s.type==='text').map(s=>s.data?.text ?? '').join('').trim():'';
        try{return accountId==='default' && event.message_type==='private' && !!reply && admins().includes(String(event.user_id)) && /^(?:[0-9]{6}|1[0-9]{10})$/u.test(text);}catch{return false;}
    }
    if(!c?.state.bindings.some(b=>b.messageId===String(reply) && b.accountId===accountId))return false;
    try{return await c.handle(event,accountId);}catch{return true;} // fail closed for auth replies
}
export function registerXhsRecovery(accountId,handler) {
    handlers.set(accountId,handler);
    if(!timer && onebotRoot==='/root/.openclaw') {timer=setInterval(()=>{try{void get()?.tick().catch(()=>{});}catch{}},2000);timer.unref();}
    return ()=>{if(handlers.get(accountId)===handler)handlers.delete(accountId);};
}
export function cancelXhsRecoverySession(sessionKey) {
    const c=get();if(!c)return;
    for(const t of c.state.tasks) if(t.context.sessionKey===sessionKey && ['captured','waiting','ready'].includes(t.status))t.status='cancelled';
    c.save();
}
