'use strict';
// Protect TeX before Markdown block rules see it (notably setext headings and tables).
// Source messages stay unchanged. Every parse gets its own collision-free placeholders.
globalThis.StarportMarkdown = (() => {
  const escape=text=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const escaped=(text,index)=>{let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;};
  const lineEnd=(text,index)=>{const end=text.indexOf('\n',index);return end<0?text.length:end+1;};
  function protect(source) {
    const text=source.replace(/\r\n?/g,'\n'),math=[];
    let prefix='\uE000STARPORTMATH';while(text.includes(prefix))prefix+='X';
    const suffix='\uE001';let output='',i=0;
    const add=(raw,tex,display,pending=false)=>{output+=prefix+math.length+suffix;math.push({raw,tex,display,pending});};
    while(i<text.length){
      // Fenced code wins over math, including fences in lists and blockquotes.
      if(i===0||text[i-1]==='\n'){
        const line=text.slice(i,lineEnd(text,i));
        const fence=/^(?: {0,3}>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})([^\n]*)/.exec(line);
        if(fence&&!(fence[1][0]==='`'&&fence[2].includes('`'))){
          let end=i+line.length;
          const close=new RegExp('^(?: {0,3}>[ \\t]?)*[ \\t]*'+fence[1][0]+'{'+fence[1].length+',}[ \\t]*(?:\\n|$)');
          while(end<text.length){const next=lineEnd(text,end),line=text.slice(end,next);end=next;if(close.test(line))break;}
          output+=text.slice(i,end);i=end;continue;
        }
      }
      // Code spans can contain dollars and backslashes literally.
      if(text[i]==='`'&&!escaped(text,i)){
        const run=/^`+/.exec(text.slice(i))[0];let end=i+run.length,found=-1;
        while((end=text.indexOf(run,end))>=0){if(text[end-1]!=='`'&&text[end+run.length]!=='`'){found=end+run.length;break;}end+=run.length;}
        if(found>=0){output+=text.slice(i,found);i=found;continue;}
        output+=run;i+=run.length;continue;
      }
      // Do not turn attributes, raw HTML code, comments or URLs into formulas.
      if(text[i]==='<'){
        const tail=text.slice(i),html=/^(?:<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-zA-Z][^<>]*>|<https?:\/\/[^>]+>)/i.exec(tail);
        if(html){output+=html[0];i+=html[0].length;continue;}
      }
      if(text.startsWith('https://',i)||text.startsWith('http://',i)){
        const url=/^https?:\/\/[^\s<>]+/.exec(text.slice(i))[0];output+=url;i+=url.length;continue;
      }
      let open,close,display=false;
      if(!escaped(text,i)){
        if(text.startsWith('$$',i)){open=close='$$';display=true;}
        else if(text.startsWith('\\[',i)){open='\\[';close='\\]';display=true;}
        else if(text.startsWith('\\(',i)){open='\\(';close='\\)';}
        else if(text[i]==='$'&&text[i-1]!=='$'&&text[i+1]&&!/\s|\$/.test(text[i+1]))open=close='$';
      }
      if(open){
        let end=i+open.length,found=-1;
        while((end=text.indexOf(close,end))>=0){
          if(!escaped(text,end)){
            // A currency-like or doubled dollar boundary cannot be skipped to steal a later formula.
            if(close==='$'&&(text[end-1]==='$'||text[end+1]==='$'||/\s/.test(text[end-1])||/\d/.test(text[end+1]||'')))break;
            found=end;break;
          }
          end+=close.length;
        }
        if(!display&&found>=0&&/\n[ \t]*\n/.test(text.slice(i+open.length,found)))found=-1;
        if(found>=0){
          const raw=text.slice(i,found+close.length),linePrefix=text.slice(text.lastIndexOf('\n',i-1)+1,i);
          const quote=/^((?: {0,3}>[ \t]?)+)[ \t]*$/.exec(linePrefix)?.[1];
          let tex=text.slice(i+open.length,found);
          if(quote)tex=tex.split('\n').map((line,n)=>n&&line.startsWith(quote)?line.slice(quote.length):line).join('\n');
          add(raw,tex.trim(),display);i=found+close.length;continue;
        }
        if(display){add(text.slice(i),text.slice(i+open.length),true,true);break;}
        // An unfinished inline formula is ordinary text, never paired with a display delimiter.
      }
      output+=text[i++];
    }
    return {text:output,math,prefix,suffix};
  }
  function render(source,{errorLabel='Formula could not be rendered',pendingLabel='Waiting for the rest of the formula',localLink}={}) {
    const protectedText=protect(String(source||'')),{math,prefix,suffix}=protectedText;
    const pattern=new RegExp(prefix+'(\\d+)'+suffix,'g');
    const raw=text=>text.replace(pattern,(_,index)=>escape(math[Number(index)]?.raw||''));
    const renderMath=token=>{
      const entry=math[token.index];if(!entry)return '';
      if(!entry.pending)try{return katex.renderToString(entry.tex,{displayMode:entry.display,throwOnError:true,trust:false,strict:'ignore',maxExpand:1000,maxSize:50});}catch{}
      return '<code class="math-source '+(entry.display?'math-block ':'')+(entry.pending?'math-pending':'math-error')+'" title="'+escape(entry.pending?pendingLabel:errorLabel)+'">'+escape(entry.raw)+'</code>';
    };
    const renderer=new marked.Renderer(),originalLink=renderer.link;
    renderer.link=function(token){const href=localLink?.(token.href);return originalLink.call(this,href?{...token,href}:token);};
    const parser=new marked.Marked({renderer,extensions:[{
      name:'protectedMath',level:'inline',start:src=>src.indexOf(prefix),
      tokenizer(src){if(!src.startsWith(prefix))return;const end=src.indexOf(suffix,prefix.length),index=Number(src.slice(prefix.length,end));if(end<0||!Number.isInteger(index)||!math[index])return;return {type:'protectedMath',raw:src.slice(0,end+suffix.length),index};},
      renderer:renderMath
    }]});
    // Placeholders inside indented code, HTML attributes and link destinations are literal.
    return raw(parser.parse(protectedText.text));
  }
  return {render,protect};
})();
