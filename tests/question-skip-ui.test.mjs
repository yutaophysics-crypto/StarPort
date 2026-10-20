import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tag,attrs={},children=[]){this.tag=tag;Object.assign(this,attrs);this.children=[];this.value=attrs.value||'';this.append(...children.filter(Boolean));}
  append(...children){this.children.push(...children);}
  querySelectorAll(tag){return this.children.flatMap(child=>child instanceof Element?[...child.tag===tag?[child]:[],...child.querySelectorAll(tag)]:[]);}
  focus(){this.focused=true;}
}
test('question skip works without answers or a ready steering channel, but permissions retain reject/allow',async()=>{
  const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/approvals.js',import.meta.url),'utf8'),context);
  const el=(tag,attrs,children)=>new Element(tag,attrs,children),t=text=>text,responses=[];
  const card=context.StarportApprovals.render({id:'q',kind:'question',params:{submitDisabled:true,questions:[{id:'a',question:'Choose?',options:[{label:'A'},{label:'B'}]}]}},{el,t,answer:async answer=>responses.push(answer),onError:()=>{}});
  const buttons=card.querySelectorAll('button');assert.equal(buttons[0].disabled,true);assert.equal(buttons[1].text,'跳过');
  await buttons[1].onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(responses[0].decision,'skip');assert.deepEqual(Object.keys(responses[0].answers),[]);
  const permission=context.StarportApprovals.render({id:'p',provider:'claude',kind:'permission',params:{toolName:'Bash'}},{el,t,answer:async()=>{},onError:()=>{}});
  assert.deepEqual(permission.querySelectorAll('button').map(button=>button.text),['允许这一次','拒绝']);
});
