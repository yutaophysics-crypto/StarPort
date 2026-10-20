import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PROVIDERS } from '../src/providers.mjs';

const source=readFileSync(new URL('../public/i18n.js',import.meta.url),'utf8');
function load(saved=new Map()){
  const sandbox={localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}};
  runInNewContext(source,sandbox);return sandbox.StarportI18n;
}
test('language preference survives a new page and falls back safely',()=>{
  const saved=new Map(),first=load(saved);assert.equal(first.language,'en');
  first.setLanguage('zh');const chinese=load(saved);assert.equal(chinese.language,'zh');assert.equal(chinese.locale,'zh-CN');
  assert.equal(chinese.t('设置'),'设置');
  chinese.setLanguage('en');const next=load(saved);assert.equal(next.language,'en');assert.equal(next.locale,'en-US');
  assert.equal(next.t('已导入 {count} 个对话',{count:3}),'Imported 3 conversations');
  assert.equal(next.notice('目标 Token 预算应为正整数'),'Must be a positive integer: Goal token budget');
  assert.equal(next.notice('provider raw diagnostic: 用户原文'),'provider raw diagnostic: 用户原文');
  assert.equal(next.notice('Antigravity 报错：quota exceeded\nretry later'),'Antigravity reported an error: quota exceeded\nretry later');
  assert.equal(next.notice('DeepSeek 本轮未正常结束：interrupted'),'DeepSeek did not finish this turn normally: interrupted');
  next.setLanguage('invalid');assert.equal(next.language,'en');
});

test('a fresh page uses English when storage is absent, unsupported or unavailable',()=>{
  for(const localStorage of [undefined,{getItem:()=>null},{getItem:()=> 'fr'},
    {getItem(){throw Error('Storage blocked');},setItem(){throw Error('Storage blocked');}}]){
    const sandbox={localStorage};runInNewContext(source,sandbox);
    assert.equal(sandbox.StarportI18n.language,'en');
    assert.equal(sandbox.StarportI18n.t('设置'),'Settings');
    assert.equal(sandbox.StarportI18n.setLanguage('zh'),'zh');
  }
});
test('all provider labels, choices and help texts have an English translation',()=>{
  const i18n=load();
  for(const provider of Object.values(PROVIDERS)){
    const texts=[provider.notes,...provider.fields.flatMap(field=>[field.label,field.placeholder,...(field.choices||[]).flatMap(choice=>[choice.label,choice.description])])];
    for(const text of texts.filter(text=>text&&/\p{Script=Han}/u.test(text)))assert.ok(Object.hasOwn(i18n.english,text),`Missing translation: ${text}`);
  }
});
test('every marked static label has a translation',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),i18n=load();
  const labels=[...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map(match=>match[1]);
  assert.ok(labels.length>30);
  for(const label of labels)assert.ok(Object.hasOwn(i18n.english,label),`Missing translation: ${label}`);
});
test('exam cards have English labels',()=>{
  const i18n=load();
  for(const file of ['workflow-exam.js','workflow-cards.js']){
    const labels=[...readFileSync(new URL('../public/'+file,import.meta.url),'utf8').matchAll(/tr\('([^']+)'/g)].map(match=>match[1]);
    for(const label of labels)assert.ok(Object.hasOwn(i18n.english,label),`Missing translation in ${file}: ${label}`);
  }
});
test('queue actions and statuses have English labels',()=>{
  const queue=readFileSync(new URL('../public/queue.js',import.meta.url),'utf8'),i18n=load();
  const labels=[...queue.matchAll(/(?:button|t)\('([^']+)'/g)].map(match=>match[1]);
  labels.push('等待你继续','正在修改，保存前不会发送','正在发送…','当前任务完成后发送');
  i18n.setLanguage('en');for(const label of labels)assert.ok(!/\p{Script=Han}/u.test(i18n.t(label,{count:2})),`Untranslated queue label: ${label}`);
});
