// Host-only authentication coordinator. Codes and phone numbers never enter a
// model tool, operation input, conversation history or diagnostic result.
import {readFileSync,writeFileSync,renameSync,mkdirSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export function challengeErrors(result) {
    return [result?.error,result?.data?.error,...(result?.data?.resources ?? []).map(r=>r.error)].filter(Boolean);
}
export function isChallenge(result) { return challengeErrors(result).some(e=>e.code==='challenge_required'); }
export function isLoginRequired(result) { return challengeErrors(result).some(e=>e.code==='login_required'); }
export function isRecoverableAuth(result) { return isChallenge(result) || isLoginRequired(result); }
export function actual461(result) {
    return challengeErrors(result).some(e=>e.code==='challenge_required' && e.status===461 && !e.stopped_in_request);
}
export function recoveryKey(c) { return JSON.stringify([c.accountId,c.scope,String(c.groupId ?? ''),String(c.senderId),String(c.requestId)]); }
function privateJson(path) {
    try {
        const info=lstatSync(path);
        if(!info.isFile() || info.isSymbolicLink() || info.uid!==process.getuid() || info.mode & 0o077 || info.size>1024*1024) throw new Error('unsafe_recovery_state');
        return JSON.parse(readFileSync(path,'utf8'));
    } catch(e) { if(e.code==='ENOENT') return null; throw e; }
}
function saveJson(path,value) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);
}
const waiting=new Set(['need_phone','sending','waiting_code','checking']);
const TASK_TTL=30*60*1000, FLOW_TTL=10*60*1000, COOLDOWN=60*60*1000;
export class XhsSmsRecovery {
    constructor({file,phoneFile,send,login,authorize,admins,resume,now=Date.now,threshold=2}) {
        Object.assign(this,{file,phoneFile,send,login,authorize,admins,resume,now,threshold});
        this.state=privateJson(file) ?? {version:1,hits:[],tasks:[],flow:null,bindings:[]};
        this.active=new Set();this.busy=false;this.draining=false;
        // An interrupted external send/check is uncertain: never repeat it.
        if(['sending','checking'].includes(this.state.flow?.status)) this.state.flow.status='interrupted';
        for(const task of this.state.tasks) if(task.status==='resuming') task.status='interrupted';
        this.save();
    }
    save() { saveJson(this.file,this.state); }
    remember(context,payload) {
        const key=recoveryKey(context);this.active.add(key);
        if(this.state.tasks.some(t=>t.key===key)) return;
        this.state.tasks=this.state.tasks.filter(t=>t.expiresAt>this.now());
        if(this.state.tasks.length>=16) {this.active.delete(key);return;}
        this.state.tasks.push({key,context,payload,status:'captured',createdAt:this.now(),expiresAt:this.now()+TASK_TTL});this.save();
    }
    finish(context) { const key=recoveryKey(context);this.active.delete(key);this.state.tasks=this.state.tasks.filter(t=>t.key!==key || t.status!=='captured');this.save(); }
    pending() { return waiting.has(this.state.flow?.status) && this.state.flow.expiresAt>this.now(); }
    async prompt(flow,kind,text) {
        // Bind each actual receipt to the recipient, bot account and flow.
        for(const admin of this.admins()) {
            const receipt=await this.send(admin,text);
            if(receipt?.messageId==null) throw new Error('admin_notification_failed');
            this.state.bindings.push({flow:flow.id,kind,accountId:'default',admin:String(admin),messageId:String(receipt.messageId),at:this.now()});this.save();
        }
    }
    async observe(result,context) {
        if(!isRecoverableAuth(result)) {
            if(result?.ok && ['search','inspect','profile','list_images','comments'].includes(result.operation)) {this.state.hits=[];this.save();}
            return null;
        }
        const task=this.state.tasks.find(t=>t.key===recoveryKey(context));
        if(!task || task.status==='cancelled' || task.expiresAt<=this.now())return {status:'not_resumable'};
        if(task && task.status==='captured') task.status='waiting';
        if(task && context.xhsOriginRequestId) task.originRequestIds=[...new Set([...(task.originRequestIds ?? []),context.xhsOriginRequestId])];
        // Do not create an endless re-login loop for an endpoint still blocked.
        if(task?.payload?.recovery || task?.attempted) {if(task)task.status='blocked';this.save();return {status:'blocked_after_login'};}
        if(this.pending()) {if(task)task.flow=this.state.flow.id;this.save();return {status:'pending'};}
        this.state.hits=this.state.hits.filter(h=>h.at>this.now()-15*60*1000);
        const directLogin = isLoginRequired(result);
        if(actual461(result) && !this.state.hits.some(h=>h.key===recoveryKey(context))) this.state.hits.push({key:recoveryKey(context),at:this.now()});
        this.save();
        // login_required is an explicit expired-session response and is sufficient
        // to start recovery; HTTP 461 keeps the two-distinct-failures threshold.
        if(!directLogin && this.state.hits.length<this.threshold) return {status:'watching',failures:this.state.hits.length,threshold:this.threshold};
        if(this.state.flow?.cooldownUntil>this.now()) return {status:'cooldown'};
        if(this.busy) return {status:'pending'};
        this.busy=true;
        const flow={id:randomUUID(),reason:directLogin?'login_required':'challenge_required',status:'need_phone',createdAt:this.now(),expiresAt:this.now()+FLOW_TTL,cooldownUntil:this.now()+COOLDOWN};
        this.state.flow=flow;
        for(const t of this.state.tasks) if(t.status==='waiting' && t.expiresAt>this.now()) t.flow=flow.id;
        this.save();
        // SMS/network work has its own lifetime; it must not occupy the global
        // XHS tool queue or consume the original tool's 90-second deadline.
        this.flight=(async()=>{
            if(!this.admins().length) throw new Error('admin_not_configured');
            const phone=privateJson(this.phoneFile)?.phone;
            if(/^1\d{10}$/u.test(phone ?? '')) await this.requestCode(flow,phone);
            else await this.prompt(flow,'phone',`${directLogin?'小红书登录已失效':'小红书连续出现461'}，之前的任务已暂停。首次短信登录恢复需要配置当前账号绑定的中国大陆手机号。请仅在本私聊引用这条消息回复11位手机号；我会请求短信验证码，再另发一条消息请你引用回复验证码。手机号和验证码不会交给对话模型。请勿提供其他账号的号码。`);
        })().catch(async error=>{try{await this.fail(error);}catch{flow.status='failed';this.save();}}).finally(()=>{this.busy=false;});
        return {status:'pending'};
    }

    async requestCode(flow,phone) {
        flow.status='sending';this.save();
        const sent=await this.login('send',phone);
        if(sent?.status!=='sms_requested') throw new Error('sms_send_unconfirmed');
        flow.status='waiting_code';flow.expiresAt=Math.min(Date.parse(sent.pending_expires_at),this.now()+FLOW_TTL);
        if(!Number.isFinite(flow.expiresAt)) throw new Error('sms_expiry_invalid');
        this.save();
        await this.prompt(flow,'code','小红书短信验证码已请求，上游接受请求不代表短信一定送达。请在10分钟内仅在本私聊引用这条消息，回复收到的6位验证码（保留开头的0）。验证登录成功后，我会继续之前暂停的小红书任务。不要在群聊发送验证码；本次不会自动重发短信。');
    }
    async fail(error) {
        const flow=this.state.flow;if(!flow)return;
        flow.status='failed';flow.error=['challenge_required','rate_limited','crawler_busy','sms_pending_exists','sms_pending_expired','authorization_revoked'].includes(error?.code)?error.code:'login_failed';
        this.save();
        for(const admin of this.admins()) await this.send(admin,`小红书本次短信登录恢复未完成（${flow.error}），已停止；没有自动重发短信，也没有将原任务标为成功。若站点要求人工验证，需要先由管理员处理。`).catch(()=>{});
    }
    async handle(event,accountId) {
        const reply=Array.isArray(event.message)?event.message.find(s=>s.type==='reply')?.data?.id:null;
        const binding=this.state.bindings.find(b=>b.messageId===String(reply) && b.accountId===accountId);
        if(!binding)return false;
        // Consume even invalid/expired replies to known auth prompts before logs.
        if(event.message_type!=='private' || String(event.user_id)!==binding.admin || !this.admins().includes(String(event.user_id)))return true;
        const flow=this.state.flow;
        if(!flow || flow.id!==binding.flow || !waiting.has(flow.status) || flow.expiresAt<=this.now()) {
            await this.send(binding.admin,'这条登录请求已结束或过期，未提交你回复的内容。');return true;
        }
        if(this.busy || ['sending','checking'].includes(flow.status)) return true;
        const value=event.message.filter(s=>s.type==='text').map(s=>s.data?.text ?? '').join('').trim();
        if(binding.kind==='phone' && flow.status!=='need_phone' || binding.kind==='code' && flow.status!=='waiting_code')return true;
        if(!(binding.kind==='phone'?/^1\d{10}$/u:/^\d{6}$/u).test(value)) {
            await this.send(binding.admin,binding.kind==='phone'?'请引用原消息只回复当前账号的11位中国大陆手机号。':'请引用原消息只回复6位短信验证码，并保留开头的0。');return true;
        }
        this.busy=true;
        try {
            if(binding.kind==='phone') {saveJson(this.phoneFile,{phone:value});await this.requestCode(flow,value);}
            else {
                flow.status='checking';this.save();
                const result=await this.login('complete',value);
                if(result?.authenticated!==true)throw new Error('login_unverified');
                flow.status='authenticated';flow.finishedAt=this.now();this.state.hits=[];
                for(const task of this.state.tasks) if(task.flow===flow.id && task.status==='waiting')task.status='ready';
                this.save();
                await this.send(binding.admin,'小红书短信登录已确认成功。我会重新检查原会话权限，继续尚未完成的步骤，并将结果发回原会话；已经发送的媒体不会重复发送。').catch(()=>{});
            }
        } catch(error) {await this.fail(error);}
        finally {this.busy=false;}
        return true;
    }
    async tick() {
        const flow=this.state.flow;
        if(this.pending()===false && waiting.has(flow?.status) && !this.busy) {
            flow.status='expired';this.save();
            for(const admin of this.admins())await this.send(admin,'小红书短信登录等待已过期，未自动重发短信，原任务未完成。').catch(()=>{});
        }
        if(this.draining)return;this.draining=true;
        try {
            for(const task of this.state.tasks) {
                if(task.status!=='ready' || this.active.has(task.key))continue;
                if(task.expiresAt<=this.now() || !await this.authorize(task.context)) {task.status='cancelled';this.save();continue;}
                if(!this.resume(task.context.accountId))continue;
                task.status='resuming';task.attempted=true;this.save();
                try {await this.resume(task.context.accountId)(task);if(task.status==='resuming')task.status='resumed';}
                catch {task.status='resume_failed';}
                this.save();
            }
            this.state.bindings=this.state.bindings.filter(b=>b.at>this.now()-24*60*60*1000);
            this.save();
        } finally {this.draining=false;}
    }
}
