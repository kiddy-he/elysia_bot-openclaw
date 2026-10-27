// Administrative QR flow. Authentication material never enters a model tool or group.
import {mkdirSync,readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isRecoverableAuth,recoveryKey} from './xhs-sms-recovery.js';
export class ReachXhsRecovery {
  constructor({file,sendQr,send,status,prepare,verify,authorize,admins,resume,now=Date.now}) {
    Object.assign(this,{file,sendQr,send,status,prepare,verify,authorize,admins,resume,now});
    try{const st=lstatSync(file);if(st.isSymbolicLink()||st.mode&0o077||st.uid!==process.getuid()||st.size>1024*1024)throw Error('unsafe_recovery_state');this.state=JSON.parse(readFileSync(file,'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,tasks:[],bindings:[],flow:null};}
    for(const t of this.state.tasks)if(t.status==='resuming')t.status='interrupted';
    this.active=new Set();this.busy=false;this.lastPoll=0;this.save();
  }
  save(){mkdirSync(dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify(this.state),{mode:0o600});renameSync(tmp,this.file);}
  remember(context,payload){const key=recoveryKey(context);this.active.add(key);if(this.state.tasks.some(t=>t.key===key))return;this.state.tasks=this.state.tasks.filter(t=>t.expiresAt>this.now());if(this.state.tasks.length>=16)return;this.state.tasks.push({key,context,payload,status:'captured',expiresAt:this.now()+30*60e3});this.save();}
  finish(context){const key=recoveryKey(context);this.active.delete(key);this.state.tasks=this.state.tasks.filter(t=>t.key!==key||t.status!=='captured');this.save();}
  pending(){return this.state.flow?.status==='waiting'&&this.state.flow.expiresAt>this.now();}
  async observe(result,context){
    if(!isRecoverableAuth(result))return null;
    const task=this.state.tasks.find(t=>t.key===recoveryKey(context));if(!task||task.expiresAt<=this.now())return {status:'not_resumable'};
    if(task.payload.recovery||task.attempted){task.status='blocked';this.save();return {status:'blocked_after_login'};}
    task.status='waiting';if(context.xhsOriginRequestId)task.originRequestIds=[...new Set([...(task.originRequestIds??[]),context.xhsOriginRequestId])];
    if(!this.pending())this.state.flow={id:randomUUID(),status:'waiting',expiresAt:this.now()+10*60e3,lastQrAt:0,kind:null};
    task.flow=this.state.flow.id;this.save();
    // The chat tool returns promptly. Only the host can send a login QR.
    void this.tick().catch(()=>{});return {status:'pending'};
  }
  async notifyQr(flow){
    const q=await this.prepare();if(!q?.image_base64)return;
    const image=Buffer.from(q.image_base64,'base64');if(image.length>1024*1024||image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('invalid_qr');
    for(const admin of this.admins()){
      const r=await this.sendQr(admin,image,q.kind);if(!r?.messageId)throw Error('admin_notification_failed');
      this.state.bindings.push({messageId:String(r.messageId),admin:String(admin),accountId:'default',flow:flow.id,at:this.now()});
    }
    flow.lastQrAt=this.now();flow.kind=q.kind;this.save();
  }
  async handle(event,accountId){
    const reply=event.message?.find?.(s=>s.type==='reply')?.data?.id;
    const b=this.state.bindings.find(b=>b.messageId===String(reply)&&b.accountId===accountId);
    if(!b)return false;
    if(event.message_type==='private'&&String(event.user_id)===b.admin&&this.admins().includes(b.admin))void this.tick(true).catch(()=>{});
    return true;
  }
  async tick(force=false){
    if(this.busy||!force&&this.now()-this.lastPoll<5000)return;this.busy=true;this.lastPoll=this.now();
    try{
      const f=this.state.flow;
      if(f?.status==='waiting'){
        if(f.expiresAt<=this.now()||!this.admins().length){f.status='expired';this.save();for(const a of this.admins())await this.send(a,'小红书扫码登录等待已结束，原任务尚未完成。请重新发起请求。').catch(()=>{});return;}
        const s=await this.status();
        if(s.loggedIn&&!s.gate){
          // A closed dialog alone never proves success. Require a real browser search.
          await this.verify();f.status='authenticated';for(const t of this.state.tasks)if(t.flow===f.id&&t.status==='waiting')t.status='ready';this.save();
          for(const a of this.admins())await this.send(a,'小红书登录与实际搜索已验证成功，将在重新检查原会话权限后继续未完成的任务。').catch(()=>{});
        }else if(!f.lastQrAt||this.now()-f.lastQrAt>=60000||s.gate==='challenge_required'&&f.kind!=='security_verification')await this.notifyQr(f);
      }
      for(const t of this.state.tasks){
        if(t.status!=='ready'||this.active.has(t.key))continue;
        if(t.expiresAt<=this.now()||!await this.authorize(t.context)){t.status='cancelled';this.save();continue;}
        const handler=this.resume(t.context.accountId);if(!handler)continue;t.status='resuming';t.attempted=true;this.save();
        try{await handler(t);t.status='resumed';}catch{t.status='resume_failed';}this.save();
      }
      this.state.tasks=this.state.tasks.filter(t=>t.expiresAt>this.now());this.state.bindings=this.state.bindings.filter(b=>b.at>this.now()-86400e3);this.save();
    }catch{this.save();}finally{this.busy=false;}
  }
}
