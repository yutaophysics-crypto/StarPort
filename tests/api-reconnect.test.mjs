import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('async function refreshLocalToken('),source.indexOf('\nfunction mark(p)'));
const old='a'.repeat(64),next='b'.repeat(64);
function fixture({denied='请从首页重新打开应用',rotate=true,failAgain=false}={}){
  const requests=[],meta={content:old};let home=0,successes=0;
  const ctx=vm.createContext({$:()=>meta,fetch:async(url,options)=>{
    requests.push({url,options});
    if(url==='/'){home++;return {ok:true,text:async()=>`<meta name="hub-token" content="${rotate?next:old}">`};}
    const allowed=!failAgain&&options.headers['X-Hub-Token']===next;
    if(allowed){successes++;return {ok:true,json:async()=>({ok:true})};}
    return {ok:false,status:denied==='请从首页重新打开应用'?401:403,json:async()=>({error:denied})};
  }});
  vm.runInContext(`let token=${JSON.stringify(old)}, tokenRefresh=null;\n`+functions,ctx);
  return {ctx,requests,meta,get home(){return home;},get successes(){return successes;}};
}
test('after restart an auth-rejected mutation refreshes its local token and executes only once',async()=>{
  const f=fixture();const payload={text:'preserve exact draft'};
  assert.equal((await f.ctx.api('/chats/example/messages','POST',payload)).ok,true);
  assert.equal(f.home,1);assert.equal(f.successes,1);assert.equal(f.meta.content,next);
  const api=f.requests.filter(x=>x.url.startsWith('/api/'));
  assert.equal(api.length,2);assert.equal(api[0].options.body,api[1].options.body);
});
test('concurrent rejected requests share the same token refresh',async()=>{
  const f=fixture();await Promise.all([f.ctx.api('/state'),f.ctx.api('/context/settings')]);
  assert.equal(f.home,1);assert.equal(f.successes,2);
});
test('origin and authorization errors do not cause a token refresh or request replay',async()=>{
  const f=fixture({denied:'拒绝跨站请求'});await assert.rejects(f.ctx.api('/state'),/拒绝跨站请求/);assert.equal(f.home,0);assert.equal(f.requests.length,1);
});
test('unchanged tokens and a second rejection do not loop',async()=>{
  const unchanged=fixture({rotate:false});await assert.rejects(unchanged.ctx.api('/state'));assert.equal(unchanged.requests.length,2);
  const twice=fixture({failAgain:true});await assert.rejects(twice.ctx.api('/state'));assert.equal(twice.home,1);assert.equal(twice.requests.length,3);
});
