// A read-scoped, ephemeral bridge; never opens a database or native account state.
const [name,...flags]=process.argv.slice(2),args={};
try{
  for(let i=0;i<flags.length;i+=2){if(!/^--[a-zA-Z]+$/.test(flags[i])||flags[i+1]===undefined)throw Error('参数必须为 --name value');const key=flags[i].slice(2);args[key]=['ids','seats','knowledge'].includes(key)?JSON.parse(flags[i+1]):['start','offset','limit','maxChars','minutes','seconds'].includes(key)?Number(flags[i+1]):flags[i+1];}
  const url=new URL(process.env.STARPORT_CONTEXT_URL||'');if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.pathname!=='/tool'||!process.env.STARPORT_CONTEXT_TOKEN)throw Error('没有当前星港任务的工具连接');
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Starport-Context':process.env.STARPORT_CONTEXT_TOKEN},body:JSON.stringify({name,arguments:args}),signal:AbortSignal.timeout(name==='starport_companion_wait'?130000:20000)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'工具请求失败');console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}
