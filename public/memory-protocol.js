'use strict';
// Reserved, trailing metadata from a Starport assistant; never applied to user text.
globalThis.StarportMemoryProtocol=(()=>{
  const marker=/(?:^|\n)```starport-memory(?:\r?\n|$)/g;
  function split(value){
    const text=String(value||'');let match,last;
    marker.lastIndex=0;while((match=marker.exec(text)))last=match;
    if(!last)return {text,proposals:[]};
    const tail=text.slice(last.index+last[0].length),end=tail.match(/\r?\n```[ \t]*(?=\r?\n|$)/);
    if(end&&tail.slice(end.index+end[0].length).trim())return {text,proposals:[]};
    if(!end)return {text:text.slice(0,last.index).trimEnd(),proposals:[]};
    let proposals=[];
    if(tail.length<=24000)try{const data=JSON.parse(tail.slice(0,end.index));if(Array.isArray(data))proposals=data.slice(0,6);}catch{}
    return {text:text.slice(0,last.index).trimEnd(),proposals};
  }
  return {split};
})();
