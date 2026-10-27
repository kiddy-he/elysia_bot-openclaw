// Shared bridge for Python/Bash consumers of the same Flash Lite failover chain.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withFlashLiteFallback, callConfiguredChat, completionText } from '../src/src/flash-lite-fallback.js';
export function nativeChatBody(input) {
    return {temperature:input.generationConfig?.temperature??0,max_tokens:input.generationConfig?.maxOutputTokens??8192,
        messages:[...(input.systemInstruction?.parts ? [{role:'system',content:input.systemInstruction.parts.map(p=>p.text??'').join('\n')}] : []),
            ...(input.contents??[]).map(item=>({role:item.role==='model'?'assistant':'user',content:(item.parts??[]).map(part=>{
                const image=part.inline_data??part.inlineData;
                return image?{type:'image_url',image_url:{url:`data:${image.mime_type??image.mimeType};base64,${image.data}`}}:{type:'text',text:part.text??''};
            })}))]};
}
export function validateAssessment(decoded, schema) {
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('invalid JSON decision');
    if(!schema)return;
    const schemas={
        'qzone-time':['/root/.openclaw/workspace/skills/qzone-ops/scripts/qzone-draft.py','verify_time_evidence'],
        'image-quality':['/root/.openclaw/workspace/skills/agy-proxy/scripts/image-quality.py','evaluate'],
    };
    if(!schemas[schema])throw Error('invalid schema');
    const [path,method]=schemas[schema];
    const result=spawnSync('/usr/bin/python3.12',['-c',
        'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("assessment",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); getattr(m,sys.argv[2])(json.load(sys.stdin))',path,method],
        {input:JSON.stringify(decoded),encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
    if(result.status!==0)throw Error('invalid assessment evidence');
}
async function main(){
    const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
    const primary=args.includes('--model')?value('--model'):'antigravity/gemini-3.5-flash-lite';
    const timeoutMs=args.includes('--timeout-ms')?Number(value('--timeout-ms')):120000;
    try {
        if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>900000)throw Error('invalid timeout');
        const schema=args.includes('--schema')?value('--schema'):undefined;
        const input=JSON.parse(readFileSync(0,'utf8')),native=args.includes('--native');
        const body=native?nativeChatBody(input):input;
        const signal=AbortSignal.timeout(timeoutMs),start=Date.now();
        const result=await withFlashLiteFallback({model:primary,thinking:'off'},async route=>{
            const reply=await callConfiguredChat(route,body,{signal,timeoutMs:Math.max(1,Math.min(30000,timeoutMs-(Date.now()-start)))});
            const text=completionText(reply),decoded=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu,''));
            validateAssessment(decoded,schema);
            return native?{candidates:[{content:{parts:[{text:JSON.stringify(decoded)}]},finishReason:'STOP'}],onebot_model:route.model}
                :{...reply,onebot_model:route.model};
        },{signal});
        console.log(JSON.stringify(result));
    }catch{console.error(JSON.stringify({ok:false,error:'flash_lite_chain_unavailable'}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
