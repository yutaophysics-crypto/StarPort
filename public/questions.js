'use strict';
globalThis.StarportQuestions=(()=>{
  const hash=text=>{let value=2166136261;for(const character of text)value=Math.imul(value^character.charCodeAt(0),16777619);return (value>>>0).toString(36);};
  const clean=text=>text.replace(/^#{1,6}\s+/,'').replace(/\*\*([^*]+)\*\*/g,'$1').trim();
  const replyRequest=text=>/(?:请|麻烦|烦请)(?:你|您)?[^。！？?\n]{0,16}(?:选择|选|确认|回答|回复|告诉我|补充)/.test(text)||/(?:^|[.!?;]\s*|\n)(?:please\s+)?(?:choose|pick|select|answer|confirm)\b|\b(?:let me know|tell me (?:which|whether))\b/i.test(text);
  const lastSentence=text=>text.split(/[。！？?]|\.(?=\s)/).at(-1).trim();
  function isReplyPrompt(text){
    // A question mark inside an explanation is not a request for user input.
    // This fallback needs a local choice/clarification prompt; native structured
    // questions bypass text inference and retain their own options and controls.
    const end=Math.max(text.lastIndexOf('?'),text.lastIndexOf('？'));
    if(end<0)return replyRequest(lastSentence(text.replace(/[。.]\s*$/,'')));
    const question=lastSentence(text.slice(0,end)),after=text.slice(end+1).trim();
    const asksReply=replyRequest(question)||replyRequest(after);
    const rhetorical=/^(?:你|您)(?:知道|了解|有没有想过|可曾)|^(?:do|did) you know\b/i.test(question);
    const directed=/[你您][\s\S]{0,160}(?:说的|指的|提到|使用|想|希望|需要|打算|倾向|偏好|选择|愿意|更喜欢)/.test(question)||(/\b(?:you|your)\b/i.test(question)&&/\b(?:want|need|prefer|choose|pick|select|mean|using|use|would|which|whether)\b/i.test(question));
    const choice=/还是|是否|(?:想|希望|需要|要)[\s\S]{0,80}哪|\b(?:choose|pick|select|prefer)\b|^which\b/i.test(question);
    if(!asksReply&&(rhetorical||(!directed&&!choice)))return false;
    if(!after||replyRequest(after))return true;
    // Only choice labels and reasons for asking may follow the actual question.
    // An answered question followed by "for example:" remains ordinary prose.
    return /^(?:(?:可选)?(?:选项|方案)(?:如下|包括|是)?|(?:options|choices)(?:\s+(?:are|include))?)\s*[:：]?$/i.test(after)||(/^(?:这(?:会|将|有助于|能)|你的选择|该选择|this (?:will|helps)|your (?:choice|answer))/i.test(after)&&after.length<=280);
  }
  function extract(text,{allowTail=true}={}){
    if(typeof text!=='string'||text.length>2000000)return [];
    const lines=text.split(/\r?\n/),questions=[];let fence=false;
    for(let index=0;index<lines.length;index++){
      if(/^\s*(```|~~~)/.test(lines[index])){fence=!fence;continue;}
      if(fence||!/^\s*[-*]\s+\S/.test(lines[index]))continue;
      const start=index,options=[];
      while(index<lines.length){
        const match=/^\s*[-*]\s+(.+?)\s*$/.exec(lines[index]);
        if(match){options.push(clean(match[1]));index++;continue;}
        if(!lines[index].trim()&&/^\s*[-*]\s+\S/.test(lines[index+1]||'')){index++;continue;}
        break;
      }
      const end=index;index--;
      if(!allowTail&&!lines.slice(end).some(line=>line.trim()))continue;
      if(options.length<2||options.length>8||options.some(option=>!option||option.length>120||/^(?:https?:|```|\$\$|<)/i.test(option))||new Set(options).size!==options.length)continue;
      let before=start-1;while(before>=0&&!lines[before].trim())before--;
      const paragraph=[];while(before>=0&&lines[before].trim()&&!/^\s*[-*#>`]/.test(lines[before]))paragraph.unshift(lines[before--]);
      const question=clean(paragraph.join('\n'));
      if(!question||question.length>800||/[<>]|\$\$/.test(question)||/(批准|授权|allow permission|approve|grant access)/i.test(question)||!isReplyPrompt(question))continue;
      questions.push({id:'text-'+hash(question+'\n'+options.join('\n')),question,options:options.map(label=>({label})),multiSelect:false});
    }
    return questions.slice(0,8);
  }
  function latest(state){
    const message=state.messages.findLast(row=>row.role==='assistant');
    if(!message||state.run?.approvals?.some(request=>request.kind==='question'))return {message,questions:[]};
    const sources=(message.details?.activity||[]).filter(row=>row.kind==='text'&&!row.scope&&row.status==='complete').map(row=>row.text||'');
    const rows=[...sources.flatMap(text=>extract(text)),...extract(message.content,{allowTail:message.status!=='running'})];
    const answered=new Set(state.messages.filter(row=>row.role==='user'&&row.details?.replyTo?.messageId===message.id&&['pending','complete'].includes(row.status)&&row.details?.guidance?.state!=='sending').flatMap(row=>row.details.replyTo.questions));
    for(const row of state.queue||[])if(row.details?.replyTo?.messageId===message.id)for(const id of row.details.replyTo.questions)answered.add(id);
    for(const id of message.details?.skippedQuestions||[])answered.add(id);
    const unique=new Map();for(const row of rows)if(!answered.has(row.id))unique.set(row.id,row);
    return {message,questions:[...unique.values()].slice(0,8)};
  }
  function answerText(questions,answers){return questions.map(q=>q.question+'\n'+[].concat(answers[q.id]||[]).join('、')).join('\n\n');}
  return {extract,latest,answerText};
})();
