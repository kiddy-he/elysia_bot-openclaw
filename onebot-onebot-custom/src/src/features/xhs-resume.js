import {isRecoverableAuth} from './xhs-sms-recovery.js';
// Clear only explicit authentication failures belonging to this actual peer.
// Completed, partial, cancelled, uncertain and delivered work is never reset.
export async function prepareXhsResume(context,{service,store,authorize,originRequestIds=[]}) {
    if(!await authorize(context))throw new Error('小红书权限已撤销');
    const peer=context.scope==='group'?`onebot:${context.accountId}:group:${context.groupId}:${context.senderId}`:`onebot:${context.accountId}:private:${context.senderId}`;
    const rows=service.store.db.prepare('SELECT request,origin FROM onebot_request_owners WHERE peer=?').all(peer);
    const keys=rows.filter(r=>{const o=JSON.parse(r.origin);return o.actorId===String(context.senderId) && [String(context.requestId),...originRequestIds].includes(o.requestId);}).map(r=>r.request);
    if(keys.some(key=>!['challenge_required','login_required',null,undefined].includes(service.store.terminal(key))))throw new Error('原小红书请求存在其他终止原因，未恢复');
    for(const key of keys) {
        service.store.db.prepare("UPDATE requests SET terminal=NULL WHERE key=? AND terminal IN ('challenge_required','login_required') AND expires>?").run(key,Date.now());
        // A failed read-only download discarded its partial artifacts. Retain its
        // job ID; queued/accepted/successful/partial jobs are not touched.
        service.store.db.prepare("UPDATE jobs SET state='queued',error=NULL,result=NULL,owner=NULL,pid=NULL,lease=NULL WHERE request=? AND state='failed' AND result IS NULL AND json_extract(error,'$.code') IN ('challenge_required','login_required') AND expires>?").run(key,Date.now());
    }
    const previous=[];
    for(const row of store.db.prepare("SELECT * FROM operations WHERE (kind LIKE 'xhs_%' OR kind LIKE 'reach_xhs_%') AND json_extract(input,'$.origin.accountId')=? AND json_extract(input,'$.origin.senderId')=? AND json_extract(input,'$.origin.requestId')=?").all(context.accountId,context.senderId,String(context.requestId))) {
        const input=JSON.parse(row.input),o=input.origin;
        if(o.scope!==context.scope || String(o.groupId ?? '')!==String(context.groupId ?? ''))continue;
        const result=row.result?JSON.parse(row.result):null;
        if(['failed','succeeded'].includes(row.state) && (isRecoverableAuth(result?.xhs) || ['NEED_LOGIN','PLATFORM_BLOCKED'].includes(result?.reach?.error?.code) || row.state==='failed' && result?.xhs?.error?.code==='manual_verification_pending')) {store.state(row.id,'pending');previous.push({tool:row.kind,params:input.params,status:'retry_after_login'});}
        else if(row.state==='succeeded')previous.push({tool:row.kind,params:input.params,result:result?.xhs});
    }
    return previous;
}
