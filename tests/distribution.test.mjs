import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub,ROOT} from '../src/server.mjs';

test('a checkout serves local Markdown, math and font assets without a MAGI installation',async t=>{
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-distribution-')),registry:{list:async()=>[]}});
  const port=await hub.listen();t.after(()=>hub.close());
  const base=`http://127.0.0.1:${port}`;
  for(const name of ['marked.min.js','katex.min.js','katex.min.css','fonts/archivo-latin-var.woff2','katex-fonts/KaTeX_Main-Regular.woff2']){
    const response=await fetch(base+'/vendor/'+name);
    assert.equal(response.status,200,name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(join(ROOT,'public','vendor',name)),name);
  }
  const css=readFileSync(join(ROOT,'public','vendor','katex.min.css'),'utf8');
  for(const [,path]of css.matchAll(/url\(([^)]+)\)/g)){
    const url=new URL(path,base+'/vendor/katex.min.css');
    assert(url.pathname.startsWith('/vendor/'),path);
    assert(existsSync(join(ROOT,'public','vendor',url.pathname.slice('/vendor/'.length))),path);
  }
  const html=await(await fetch(base+'/')).text();
  assert.match(html,/\/memory-receipt\.js\?v=/);
  assert.equal((await fetch(base+'/vendor/does-not-exist.js')).status,404);
});
