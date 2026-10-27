import test from 'node:test';
import assert from 'node:assert/strict';
import{groupApprovalDetails}from'../src/src/approval-presentation.js';
test('group approval details contain summaries and cannot echo secrets from commands, model purpose, rationale or URLs',()=>{
 const secrets=['sk-synthetic-secret','intermediate-token-value','https://private.invalid/a?token=hidden','/root/private/key.json'];
 const command=`/bin/bash /tmp/task.sh --key ${secrets[0]} --token ${secrets[1]} --url ${secrets[2]} --file ${secrets[3]}`;
 for(const toolName of ['onebot_image_generate','image_edit','network_control',undefined,'unknown']){
  const text=groupApprovalDetails({toolName,command,purpose:secrets.join(' '),review:{rationale:secrets.join(' '),voteRationales:secrets.join(' ')}}).join('\n');
  for(const secret of secrets)assert.equal(text.includes(secret),false);
  assert.doesNotMatch(text,/```|--key|\/bin\/bash|task\.sh/u);assert.match(text,/操作说明：/u);assert.match(text,/尚未执行/u);
 }
});
test('raw command approvals get fixed category summaries without displaying original arguments',()=>{
 assert.match(groupApprovalDetails({command:"'/usr/bin/systemctl' 'restart' 'hidden.service'"}).join('\n'),/运行状态/u);
 assert.match(groupApprovalDetails({command:"'/bin/bash' '/root/x/agy-proxy-diagnose.sh' 'image-generate' 'private prompt'"}).join('\n'),/图片生成/u);
 assert.doesNotMatch(groupApprovalDetails({command:'opaque arbitrary private text'}).join('\n'),/opaque|arbitrary|private/u);
});
