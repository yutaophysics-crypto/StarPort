// Shared by the composer and server. Never accept arbitrary browser/API URLs.
export function parseVideoReference(value){
  if(typeof value!=='string'||value.length>4000)throw new Error('请输入 B 站视频链接或 BV 号');
  const text=value.trim();let bvid,part=1;
  if(/^BV[0-9A-Za-z]{10}$/.test(text))bvid=text;
  else{
    let url;try{url=new URL(text);}catch{throw new Error('请输入 B 站视频链接或 BV 号');}
    const match=url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    if(!['https:','http:'].includes(url.protocol)||!['bilibili.com','www.bilibili.com','m.bilibili.com'].includes(url.hostname)||url.port||url.username||url.password||!match)throw new Error('仅支持 B 站视频链接或 BV 号');
    bvid=match[1];const parts=url.searchParams.getAll('p');
    if(parts.length>1||parts.length&& !/^[1-9]\d{0,3}$/.test(parts[0]))throw new Error('视频分 P 编号无效');
    part=parts.length?Number(parts[0]):1;
  }
  if(part>1000)throw new Error('视频分 P 编号无效');
  return {bvid,part,url:`https://www.bilibili.com/video/${bvid}/`+(part===1?'':`?p=${part}`)};
}
export function findVideoReferences(text){
  const rows=[],spans=[];
  for(const match of String(text).matchAll(/https?:\/\/[^\s<>"'，。；、）)\]]+/g)){
    spans.push([match.index,match.index+match[0].length]);
    if(!/bilibili\.com\/video\//.test(match[0]))continue;
    // Ignore trailing prose punctuation, preserving query parameters.
    rows.push(parseVideoReference(match[0].replace(/[.!?,;:]+$/,'')));
  }
  for(const match of String(text).matchAll(/\bBV[0-9A-Za-z]{10}\b/g))if(!spans.some(([a,b])=>match.index>=a&&match.index<b))rows.push(parseVideoReference(match[0]));
  const unique=[...new Map(rows.map(row=>[row.url,row])).values()];
  if(unique.length>3)throw new Error('每条消息最多读取 3 个视频');
  return unique;
}
