import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';

const context={URL};
runInNewContext(readFileSync(new URL('../public/mobile/invitation.js',import.meta.url),'utf8'),context);
const parse=context.StarportInvitation.parse,origin='https://groups.example.com';

test('complete invitation links and raw codes preserve every token character',()=>{
  for(let i=0;i<50;i++){
    const token=randomBytes(32).toString('base64url');
    assert.equal(parse(token,origin),token);
    assert.equal(parse('  '+origin+'/?invite='+encodeURIComponent(token)+'\n',origin),token);
  }
  const token='AbC_'.repeat(10)+'XYZ';assert.equal(parse(token,origin),token);
});

test('homepage addresses, wrong servers and damaged copies receive actionable errors before joining',()=>{
  const token=randomBytes(32).toString('base64url');
  assert.throws(()=>parse(origin,origin),/不含邀请码/);
  assert.throws(()=>parse(origin+'/?invite=',origin),/不含邀请码/);
  assert.throws(()=>parse('https://another.example/?invite='+token,origin),/另一个群聊服务/);
  assert.throws(()=>parse('http://127.0.0.1:3218/?invite='+token,origin),/另一个群聊服务/);
  for(const value of [token.slice(1),token+'x',token.slice(0,10)+' '+token.slice(10),token.slice(0,10)+'\u200b'+token.slice(10)])assert.throws(()=>parse(value,origin),/不完整或格式有误/);
  for(const url of ['javascript:alert(1)','https://user:password@groups.example.com/?invite='+token,origin+'/unrelated?invite='+token])assert.throws(()=>parse(url,origin),/格式不正确/);
});

test('links copied as Markdown retain their destination and still enforce the shared server',()=>{
  const token=randomBytes(32).toString('base64url'),url=origin+'/?invite='+token;
  assert.equal(parse('['+url+']('+url+')',origin),token);
  assert.equal(parse('[加入群聊]('+url+')',origin),token);
  assert.equal(parse('<'+url+'>',origin),token);
  const local='http://127.0.0.1:3218/?invite='+token;
  assert.throws(()=>parse('['+local+']('+local+')',origin),/另一个群聊服务/);
  assert.throws(()=>parse('[邀请](javascript:alert(1))',origin),/不完整或格式有误/);
});
