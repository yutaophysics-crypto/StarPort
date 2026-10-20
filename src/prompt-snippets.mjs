import { randomUUID } from 'node:crypto';

// 提示词: named prompts the composer inserts in one click, kept as one ordered list in settings.
// The list starts with one example; once saved, even an empty list stays as the user left it.
export const DEFAULT_SNIPPETS=[{id:'deepen',name:'深化',text:'I want a deeper version of this task, not a bigger one. Before rewriting it: (1) say what a top professional in this field would do here that I’m not asking for; (2) name the rawest material they would start from instead of what has already been digested for me; (3) name the specific methods and tools they would use; (4) say what, other than you or me, would show the result is right. Then rewrite my prompt to ask for exactly that.'}];
const KEY='promptSnippets',MAX_COUNT=200,MAX_NAME=60,MAX_TEXT=20000;
const fail=message=>Object.assign(new Error(message),{status:400});

export function cleanSnippets(raw){
  if(!Array.isArray(raw))throw fail('提示词列表格式无效');
  if(raw.length>MAX_COUNT)throw fail(`提示词最多 ${MAX_COUNT} 条`);
  const ids=new Set();
  return raw.map((item,i)=>{
    const name=typeof item?.name==='string'?item.name.trim():'',text=typeof item?.text==='string'?item.text:'';
    if(!name)throw fail(`第 ${i+1} 条提示词没有名称`);
    if(name.length>MAX_NAME)throw fail(`「${name.slice(0,20)}」的名称超过 ${MAX_NAME} 个字`);
    if(!text.trim())throw fail(`「${name}」还没有内容`);
    if(text.length>MAX_TEXT)throw fail(`「${name}」超过 ${MAX_TEXT} 个字`);
    let id=typeof item.id==='string'&&/^[\w-]{1,64}$/.test(item.id)?item.id:'';
    if(!id||ids.has(id))id='p_'+randomUUID().slice(0,12);
    ids.add(id);
    return {id,name,text};
  });
}

export class PromptSnippets{
  constructor(store){this.store=store;}
  list(){return this.store.setting(KEY,DEFAULT_SNIPPETS);}
  save(raw){const snippets=cleanSnippets(raw);this.store.setSetting(KEY,snippets);return snippets;}
  async handle(method,path,read){
    if(path!=='/api/prompt-snippets')return null;
    if(method==='GET')return {data:{snippets:this.list()},status:200};
    if(method==='PUT')return {data:{snippets:this.save((await read()).snippets)},status:200};
    throw Object.assign(new Error('请求方法无效'),{status:405});
  }
}
