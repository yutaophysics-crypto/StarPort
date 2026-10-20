import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context={Event};
runInNewContext(readFileSync(new URL('../public/mobile/composer.js',import.meta.url),'utf8'),context);
function composer(value='hello'){
  const input=new EventTarget();input.value=value;input.selectionStart=input.selectionEnd=value.length;
  input.setRangeText=(text,start,end)=>{input.value=input.value.slice(0,start)+text+input.value.slice(end);input.selectionStart=input.selectionEnd=start+text.length;};
  let sends=0,changes=0,ready=true;input.addEventListener('input',()=>changes++);
  const unbind=context.StarportGroupComposer.bind(input,{requestSubmit(){sends++;ready=false;}},()=>ready);
  const key=(options={})=>{const event=Object.assign(new Event('keydown',{cancelable:true}),{key:'Enter',...options});input.dispatchEvent(event);return event;};
  return {input,key,unbind,get sends(){return sends;},get changes(){return changes;}};
}

test('Enter submits once and does not insert a newline while the send is pending',()=>{
  const c=composer();assert.equal(c.key().defaultPrevented,true);c.key({repeat:true});assert.equal(c.sends,1);assert.equal(c.input.value,'hello');assert.equal(c.changes,0);
  c.unbind();assert.equal(c.key().defaultPrevented,false);
});
test('Shift and Control Enter replace the selected text with a newline and update the draft',()=>{
  for(const options of [{shiftKey:true},{ctrlKey:true},{shiftKey:true,ctrlKey:true}]){
    const c=composer('helloNAMEworld');c.input.selectionStart=5;c.input.selectionEnd=9;
    assert.equal(c.key(options).defaultPrevented,true);assert.equal(c.input.value,'hello\nworld');assert.equal(c.input.selectionStart,6);assert.equal(c.changes,1);assert.equal(c.sends,0);
  }
});
test('input method confirmation and unrelated keys never submit a group message',()=>{
  const c=composer();
  for(const options of [{isComposing:true},{keyCode:229},{key:'a'},{metaKey:true},{altKey:true}])assert.equal(c.key(options).defaultPrevented,false);
  assert.equal(c.sends,0);assert.equal(c.input.value,'hello');
});
test('modifier newlines respect the message length limit while allowing selection replacement',()=>{
  const c=composer('hello');c.input.maxLength=5;c.key({ctrlKey:true});assert.equal(c.input.value,'hello');assert.equal(c.changes,0);
  c.input.selectionStart=1;c.input.selectionEnd=2;c.key({shiftKey:true});assert.equal(c.input.value,'h\nllo');assert.equal(c.changes,1);
});
