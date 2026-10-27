import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../integrations/agent-reach/xhs-media.py',import.meta.url),'utf8');
const script=name=>source.match(new RegExp(name+" = r'''([\\s\\S]*?)'''"))[1];
function extract(name,state,{dialog=false,href='https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'}={}){
 const e={getBoundingClientRect:()=>({width:50,height:50})};
 return JSON.parse(JSON.stringify(runInNewContext('(() => {'+script('COMMON')+script(name)+'})()',{
  window:{__INITIAL_STATE__:state},location:new URL(href),URL,
  document:{body:{innerText:''},querySelector:()=>null,querySelectorAll:selectors=>dialog&&selectors.includes('captcha')?[e]:[]}
 })));
}
test('search reads Vue _value refs, preserves video types and all signed candidate identities',()=>{
 const r=extract('SEARCH',{user:{loggedIn:{_value:true}},search:{feeds:{_value:[{id:'0123456789abcdef01234567',xsecToken:'synthetic',noteCard:{type:'video',displayTitle:'猫咪',user:{userId:'author',nickname:'name'},interactInfo:{likedCount:'2.1万'}}}]}}});
 assert.equal(r.ready,true);assert.equal(r.rows[0].noteCard.type,'video');assert.equal(r.rows[0].xsecToken,'synthetic');assert.equal(r.rows[0].noteCard.interactInfo.likedCount,'2.1万');
});
test('note manifest preserves complete carousel order, signed URL and stream metadata without account credentials',()=>{
 const id='0123456789abcdef01234567';const r=extract('INSPECT',{user:{loggedIn:{value:true},web_session:'must-not-export'},note:{noteDetailMap:{value:{[id]:{note:{noteId:id,type:'normal',title:'title',user:{userId:'author'},imageList:[{urlDefault:'https://a.xhscdn.com/first?sig=keep'},{urlDefault:'https://a.xhscdn.com/second'}],video:{media:{stream:{h264:[{masterUrl:'https://v.xhscdn.com/video.mp4',duration:5000,size:1024,format:'mp4'}]}}}}}}}}});
 assert.equal(r.note.imageList.length,2);assert.equal(r.note.imageList[0].urlDefault,'https://a.xhscdn.com/first?sig=keep');assert.equal(r.note.video.media.stream.h264[0].duration,5000);assert.equal(JSON.stringify(r).includes('must-not-export'),false);
});
test('visible security challenge takes precedence over logged-in flag and never exposes underlying media',()=>{
 const r=extract('INSPECT',{user:{loggedIn:true}},{dialog:true});assert.deepEqual(r,{gate:'challenge_required'});
});
test('profile interactions are labelled as source counters; unsupported metrics are never relabelled as followers',()=>{
 const r=extract('PROFILE',{user:{loggedIn:true,userPageData:{_value:{basicInfo:{nickname:'作者',desc:'简介'},interactions:[{name:'获赞与收藏',type:'interaction',count:'3万'}]}},notes:{_value:[]}}},{href:'https://www.xiaohongshu.com/user/profile/abcdef123456'});
 assert.equal(r.profile.nickname,'作者');assert.equal(r.profile.bio,'简介');assert.equal(r.profile.interactions[0].name,'获赞与收藏');assert.equal(r.profile.followers,undefined);assert.equal(r.profile.coverage,'loaded_public_profile_only');
});
