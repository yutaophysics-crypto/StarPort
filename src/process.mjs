import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
export const exec = promisify(execFile);

export function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, NO_COLOR: '1' };
  // Child CLI sessions are independent; do not inherit the parent's nesting marker.
  delete env.CLAUDECODE;
  return env;
}
export function startProcess(command, args, options = {}) {
  if (/\.(cmd|bat|ps1)$/i.test(command)) throw new Error('请配置 .exe 可执行文件，或用 node.exe 加前置参数运行 JS 入口，避免 shell 转义问题。');
  return spawn(command, args, { stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false,
    detached: process.platform !== 'win32', ...options, env: childEnvironment(options.env) });
}
const stopping=new WeakMap();
const exited=child=>child.exitCode!=null||child.signalCode!=null;
function releaseProcess(child){
  for(const stream of [child?.stdin,child?.stdout,child?.stderr])stream?.destroy?.();
  child?.unref?.();
}
function killTree(child,runFile,timeoutMs){
  return new Promise(resolve=>{
    let helper,settled=false;
    const finish=ok=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(!ok){try{helper?.kill('SIGKILL');}catch{}releaseProcess(helper);}
      resolve();
    };
    // Keep an independent deadline: the helper's own timeout can also stall
    // while Windows or a native sandbox waits for process-tree termination.
    const timer=setTimeout(()=>finish(false),timeoutMs);
    try{helper=runFile('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,timeout:timeoutMs,killSignal:'SIGKILL'},error=>finish(!error));}
    catch{finish(false);}
  });
}
function waitForExit(child,timeoutMs){
  if(exited(child))return Promise.resolve(true);
  return new Promise(resolve=>{
    const finish=ok=>{clearTimeout(timer);child.removeListener('exit',onExit);resolve(ok);};
    const onExit=()=>finish(true),timer=setTimeout(()=>finish(exited(child)),timeoutMs);
    child.once('exit',onExit);
  });
}
async function terminateProcess(child,{platform=process.platform,runFile=execFile,treeTimeoutMs=2000,exitTimeoutMs=2000}={}){
  if(platform==='win32'){
    await killTree(child,runFile,treeTimeoutMs);
    if(!exited(child)){try{child.kill('SIGKILL');}catch{}}
    const stopped=await waitForExit(child,exitTimeoutMs);
    // Descendants may still hold inherited pipes. Do not leave adapters waiting
    // forever for a close event after the owned process has exited.
    releaseProcess(child);
    if(!stopped)throw Object.assign(new Error('工具进程清理超时；进程未确认退出，请检查原工具或沙箱权限。'),{code:'PROCESS_STOP_TIMEOUT',pid:child.pid});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    timer.unref();
  }
}
export function stopProcess(child,options){
  if(!child?.pid||exited(child))return Promise.resolve();
  if(stopping.has(child))return stopping.get(child);
  const pending=terminateProcess(child,options);stopping.set(child,pending);
  pending.then(()=>stopping.delete(child),()=>stopping.delete(child));return pending;
}
// Windows private files get an ACL for the signed-in user and SYSTEM only. The user's SID is
// looked up once: whoami starts in milliseconds, while PowerShell can take over ten seconds on
// a busy machine and time out a sign-in. PowerShell remains the fallback. whoami is called by
// its System32 path because Git for Windows and MSYS2 put a GNU whoami on PATH.
const SID=/^S-1-\d+(?:-\d+)+$/;
let userSid=null;
function currentUserSid(){
  userSid??=(async()=>{
    let sid='';
    const whoami=(process.env.SystemRoot||'C:\\Windows')+'\\System32\\whoami.exe';
    try{sid=(await exec(whoami,['/user','/fo','csv','/nh'],{windowsHide:true,timeout:10000})).stdout.trim().split(',').at(-1).replaceAll('"','');}catch{}
    if(!SID.test(sid))sid=(await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{windowsHide:true,timeout:30000})).stdout.trim();
    if(!SID.test(sid))throw Error('无法确认电脑登录用户');
    return sid;
  })().catch(error=>{userSid=null;throw error;});
  return userSid;
}
export async function restrictToCurrentUser(file){
  if(process.platform!=='win32')return;
  await exec('icacls.exe',[file,'/inheritance:r','/grant:r','*'+await currentUserSid()+':(F)','*S-1-5-18:(F)'],{windowsHide:true,timeout:10000});
}
// The file is created empty and locked down before any content is written.
export async function writePrivateFile(file,content=''){
  await writeFile(file,'',{mode:0o600});await restrictToCurrentUser(file);await writeFile(file,content,{mode:0o600});
}
export function redact(text) {
  return String(text).replace(/\b(sk-[\w-]{12,}|Bearer\s+[\w.\-]{12,})/gi, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]');
}
export class JsonRpc {
  constructor(command, args, { cwd, env, onEvent = () => {}, onRequest = () => {} } = {}) {
    this.nextId = 1; this.pending = new Map(); this.log = ''; this.onEvent = onEvent; this.onRequest = onRequest;
    this.child = startProcess(command, args, { cwd, env });
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      let data; try { data = JSON.parse(line); } catch { return; }
      if (data.id != null && !data.method) {
        const p = this.pending.get(data.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(data.id);
        data.error ? p.reject(new Error(data.error.message || JSON.stringify(data.error))) : p.resolve(data.result);
      } else if (data.id != null) { Promise.resolve(this.onRequest(data)).catch(() => this.respondError(data.id, '无法处理请求')); }
      else if (data.method) {
        try { this.onEvent(data.method, data.params || {}); } catch (error) { this.finish(error); }
      }
    });
    const decoder = new StringDecoder('utf8');
    this.child.stderr.on('data', chunk => { this.log = (this.log + redact(decoder.write(chunk))).slice(-12000); });
    this.child.stdin.on('error', error => this.connectionLost(new Error('工具输入连接已关闭：' + error.message)));
    this.child.stdout.on('error', error => this.finish(error));
    this.child.stdout.once('end', () => {
      // A resident process can lose stdout without exiting. Allow a normal exit
      // to report its code first, but never leave the RPC turn waiting forever.
      this.connectionLost(new Error('工具输出连接已关闭；已有输出已保留，请重新发送以继续。'));
    });
    this.child.stdout.once('close', () => this.connectionLost(new Error('工具输出连接已关闭；已有输出已保留，请重新发送以继续。')));
    this.child.on('error', e => this.finish(e));
    this.child.on('close', (code, signal) => this.finish(new Error(`工具进程已退出 (${code ?? signal})${this.log ? ': ' + this.log.slice(-2500) : ''}`)));
  }
  connectionLost(error) {
    if(this.ended||this.outputCloseTimer)return;
    this.outputCloseTimer=setTimeout(() => {
      this.finish(this.child.exitCode===null?error:new Error(`工具进程已退出 (${this.child.exitCode})${this.log?': '+this.log.slice(-2500):''}`));
    },100);
    this.outputCloseTimer.unref();
  }
  finish(error) {
    if (this.ended) return; this.ended = true;
    clearTimeout(this.outputCloseTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.resolveClosed(error);
  }
  send(data) { if (this.ended) throw new Error('工具连接已关闭'); this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',...data}) + '\n'); }
  request(method, params = {}, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 响应超时`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  respondError(id, message) { this.send({ id, error: { code: -32601, message } }); }
  notify(method, params = {}) { this.send({ method, params }); }
  async close() { await stopProcess(this.child); }
}
