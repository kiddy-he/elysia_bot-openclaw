// Archived Komachi behavior is regression-tested only in an isolated synthetic
// deployment. Production has switched to Reach and must never re-enable it.
import {mkdtempSync,readFileSync,writeFileSync,existsSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'onebot-legacy-xhs-tests-'));
for(const name of ['onebot-features.json','onebot-executors.json','onebot-app-config.json','onebot-role-routing.json','onebot-model-routing.json','onebot-delivery.json','onebot-service-registry.json','onebot-workspaces.json']){
 const from=join('/root/.openclaw',name);if(existsSync(from))cpSync(from,join(root,name));
}
const policy=JSON.parse(readFileSync(join(root,'onebot-features.json'),'utf8'));policy.features.xiaohongshu.actions.media.enabled=true;writeFileSync(join(root,'onebot-features.json'),JSON.stringify(policy));
const settings=JSON.parse(readFileSync(join(root,'onebot-executors.json'),'utf8'));for(const[name,value]of Object.entries(settings.tools))if(name.startsWith('xhs_'))value.enabled=true;writeFileSync(join(root,'onebot-executors.json'),JSON.stringify(settings));
writeFileSync(join(root,'onebot-xhs.json'),JSON.stringify({version:1,enabled:true,backend:'http',dataDir:join(root,'synthetic-data')}));
process.env.ONEBOT_CONFIG_ROOT=root;
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
