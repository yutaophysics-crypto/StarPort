import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.mjs';
import { PromptSnippets, DEFAULT_SNIPPETS } from '../src/prompt-snippets.mjs';

const call=(snippets,method,body)=>snippets.handle(method,'/api/prompt-snippets',async()=>body);

test('prompt snippets start with the deepen example, save in order and keep an emptied list empty',async()=>{
  const snippets=new PromptSnippets(new Store(':memory:'));
  const first=await call(snippets,'GET');
  assert.equal(first.status,200);assert.deepEqual(first.data.snippets,DEFAULT_SNIPPETS);
  assert.match(DEFAULT_SNIPPETS[0].text,/^I want a deeper version of this task, not a bigger one\./);
  const saved=await call(snippets,'PUT',{snippets:[{id:'b',name:' 验收 ',text:'逐条对照验收标准。'},{id:'deepen',name:'深化',text:DEFAULT_SNIPPETS[0].text}]});
  assert.deepEqual(saved.data.snippets.map(s=>[s.id,s.name]),[['b','验收'],['deepen','深化']]);
  assert.deepEqual((await call(snippets,'GET')).data.snippets,saved.data.snippets);
  await call(snippets,'PUT',{snippets:[]});
  assert.deepEqual((await call(snippets,'GET')).data.snippets,[]);
  assert.equal(await snippets.handle('GET','/api/other',async()=>({})),null);
});

test('prompt snippets reject missing names or content and replace unusable ids',async()=>{
  const snippets=new PromptSnippets(new Store(':memory:'));
  await assert.rejects(call(snippets,'PUT',{snippets:[{name:'',text:'x'}]}),/没有名称/);
  await assert.rejects(call(snippets,'PUT',{snippets:[{name:'空的',text:'  \n'}]}),/还没有内容/);
  await assert.rejects(call(snippets,'PUT',{snippets:'nope'}),/格式无效/);
  await assert.rejects(call(snippets,'PUT',{snippets:[{name:'x'.repeat(61),text:'y'}]}),/名称超过/);
  const saved=(await call(snippets,'PUT',{snippets:[{id:'same',name:'一',text:'a'},{id:'same',name:'二',text:'b'},{id:'../bad',name:'三',text:'c'}]})).data.snippets;
  assert.equal(saved[0].id,'same');assert.notEqual(saved[1].id,'same');assert.match(saved[2].id,/^p_[\w-]+$/);
  assert.equal(new Set(saved.map(s=>s.id)).size,3);
});
