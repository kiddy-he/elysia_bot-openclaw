import { runReachCommand, loadReachSettings } from '../../features/reach-provider.js';
import { fail, checkAbort } from '../errors.js';

const errors=new Set(['login_required','challenge_required','rate_limited','permission_denied','invalid_target','not_found','deadline_exceeded','manual_verification_pending']);
const inflight=new Map(),cache=new Map();
export class ReachXhsBackend {
  constructor({run=runReachCommand,config=loadReachSettings(),ttlMs=45000}={}){Object.assign(this,{run,config,ttlMs,noteCacheTtlMs:ttlMs});}
  async call(operation,params,{signal}={}) {
    checkAbort(signal);
    const timeoutMs=operation==='prepare_login'?45000:60000;
    const out=await this.run([operation,JSON.stringify(params)],{config:{...this.config,executable:'/opt/openclaw-agent-reach/xhs-command'},timeoutMs,signal});
    let result;try{result=JSON.parse(out.stdout);}catch{fail('invalid_response');}
    if(!result?.ok)fail(errors.has(result?.error?.code)?result.error.code:'reach_unavailable');
    checkAbort(signal);return result.data;
  }
  async shared(operation,params,{signal}={}) {
    checkAbort(signal);const key=JSON.stringify([this.config.home,operation,params]),existing=cache.get(key);
    if(existing?.expires>Date.now())return structuredClone(existing.data);
    if(!inflight.has(key)){
      // Shared reads have their own deadline: cancelling one peer never cancels another peer's read.
      const pending=this.call(operation,params,{signal:AbortSignal.timeout(60000)}).then(data=>{
        if(cache.size>=80)cache.delete(cache.keys().next().value);
        cache.set(key,{data,expires:Date.now()+this.ttlMs});return data;
      }).finally(()=>inflight.delete(key));
      pending.catch(()=>{});inflight.set(key,pending);
    }
    const pending=inflight.get(key);
    if(!signal)return structuredClone(await pending);
    let abort;
    try{return structuredClone(await Promise.race([pending,new Promise((_,reject)=>{abort=()=>{try{checkAbort(signal);}catch(e){reject(e);}};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]));}
    finally{signal.removeEventListener('abort',abort);}
  }
  async search(params,options){
    if(params.sort==='latest')fail('search_sort_unavailable');
    const data=await this.shared('search',{query:params.query,limit:params.limit??12},options);
    if(!Array.isArray(data?.rows)||data.rows.length>30)fail('invalid_response');
    return data.rows;
  }
  async inspect(target,options){
    const data=await this.shared('inspect',{target},options);
    if(!data?.note||typeof data.source_url!=='string')fail('invalid_response');
    return data;
  }
  async profile(user_id,options){const {posts,...profile}=await this.shared('profile',{user_id},options);return profile;}
  async userPosted({user_id,cursor,limit=10},options){if(cursor)fail('pagination_unavailable');const data=await this.shared('profile',{user_id},options);return {notes:(data.posts??[]).slice(0,limit),hasMore:false,cursor:'',coverage:'loaded_public_profile_only'};}
  async status(options){return this.call('status',{},options);}
  async close(){}
}
