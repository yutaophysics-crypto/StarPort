'use strict';
(()=>{
  function parse(value,origin){
    if(typeof value!=='string'||!value.trim())throw Error('请粘贴完整邀请链接或邀请码');
    let token=value.trim(),url;
    const formatted=/^\[[^\]\r\n]*\]\((https?:\/\/[^\s()]+)\)$/.exec(token)||/^<(https?:\/\/[^\s<>]+)>$/.exec(token);
    if(formatted)token=formatted[1];
    try{url=new URL(token);}catch{}
    if(url){
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/')throw Error('邀请链接格式不正确，请重新复制完整邀请链接');
      const values=url.searchParams.getAll('invite');
      if(values.length!==1||!values[0])throw Error('这是群聊服务地址，不含邀请码。请复制「成员与邀请」中生成的完整邀请链接');
      if(url.origin!==new URL(origin).origin)throw Error('这份邀请来自另一个群聊服务。请群主在当前公网服务重新创建邀请，再复制完整链接');
      token=values[0].trim();
    }
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('邀请码不完整或格式有误，请重新复制完整邀请链接，不要手动改写');
    return token;
  }
  globalThis.StarportInvitation={parse};
})();
