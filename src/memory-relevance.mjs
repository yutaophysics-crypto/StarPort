// An open-vocabulary candidate index; the task model judges applicability.
export const MEMORY_RECALL_POLICY='retrieval-v3';
const stop=new Set(`the and for that this with from have has their them they user users wants want prefers preference preferences profile stated confirmed memory memories old imported legacy archive about when then also only can but your you are was been will should would could please help continue okay hi hello 用户 画像 偏好 记忆 共同 个人 确认 信息 基本 旧记 户画 希望 想要 需要 喜欢 要求 以后 现在 当前 这个 那个 一个 以及 可以 进行 关于 对话 讨论 问题 内容 来源 请帮 帮我 继续 一下 好的 谢谢`.split(/\s+/));
const segmenter=new Intl.Segmenter(undefined,{granularity:'word'});
const clean=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/【旧记忆[^】]*】/g,'').replace(/(?:claude\s*)?旧记忆[·\s]*/g,'').replace(/\[(?:stated|inferred)\]/g,'');
function words(text){
  const value=clean(text),result=[];
  for(const {segment,isWordLike} of segmenter.segment(value))if(isWordLike&&segment.length>=2&&!stop.has(segment))result.push(segment);
  for(const run of value.match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i<run.length-1;i++){const word=run.slice(i,i+2);if(!stop.has(word))result.push(word);}
  return result;
}
const continuation=text=>/^(?:(?:继续|接着|然后呢|再来|是的|好的|可以|修复|修改|优化|完善|修一下|改一下)(?:吧|一下|做|处理|工作|优化|修改|完善|它|这里|这个问题|这个bug)*|continue(?: please)?|go on|yes|ok(?:ay)?|fix (?:it|this))[\s。.!！？?]*$/i.test(text.trim());
export function memoryQuery(query,recentMessages=[]){
  const current=String(query||'').slice(0,4000);
  if(!continuation(current))return current;
  for(const message of recentMessages.slice(-12).reverse()){
    if(message.role!=='user'||message.status!=='complete'||message.details?.guidance?.state&&message.details.guidance.state!=='delivered')continue;
    const text=String(message.content||'').slice(0,4000);
    if(text===current||continuation(text)||!words(text).length)continue;
    return current+'\n'+text;
  }
  return current;
}
export function memoryRanker(query,rows,cache=new Map()){
  const terms=new Set(words(query)),docs=[];
  if(cache.size>rows.length*2+64)cache.clear();
  for(const row of rows){
    let doc=cache.get(row.id);
    if(!doc||doc.revision!==row.revision){
      const title=words(row.title),content=words(row.content),counts=new Map();
      for(const word of content)counts.set(word,(counts.get(word)||0)+1);
      for(const word of title)counts.set(word,(counts.get(word)||0)+2);
      doc={revision:row.revision,length:title.length+content.length,counts};cache.set(row.id,doc);
    }
    docs.push(doc);
  }
  const average=docs.reduce((sum,doc)=>sum+doc.length,0)/Math.max(docs.length,1)||1,idf=new Map();
  for(const term of terms){const frequency=docs.filter(doc=>doc.counts.has(term)).length;idf.set(term,Math.log(1+(docs.length-frequency+0.5)/(frequency+0.5)));}
  return row=>{const doc=cache.get(row.id);let score=0;for(const term of terms){const tf=doc.counts.get(term)||0;if(tf)score+=idf.get(term)*tf*2.2/(tf+1.2*(0.25+0.75*doc.length/average));}return score;};
}
