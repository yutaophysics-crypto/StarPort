import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { collaborationUrl } from './collaboration/server.mjs';

export function windowsAppCommand(url, { environment = process.env, fileExists = existsSync } = {}) {
  const parsed = new URL(url), fragment = parsed.hash;
  parsed.hash = '';
  const value = collaborationUrl(parsed.href) + (fragment && /^#connect=[A-Za-z0-9_-]{43}(?:&room=[a-f0-9-]{36})?$/.test(fragment) ? '/' + fragment : '');
  if (fragment && !/^#connect=[A-Za-z0-9_-]{43}(?:&room=[a-f0-9-]{36})?$/.test(fragment)) throw Error('窗口登录凭证无效');
  const command = [
    join(environment['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(environment.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe')
  ].find(fileExists);
  return command ? { command, args: ['--new-window', '--app=' + value] } : null;
}

export class GroupWindowLauncher {
  constructor({ platform = process.platform, environment = process.env, fileExists = existsSync, spawnProcess = spawn } = {}) {
    Object.assign(this, { platform, environment, fileExists, spawnProcess });
  }
  get mode() { return this.platform === 'win32' ? 'windows' : 'browser'; }
  async openLocal(value){const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!/^\/group-windows\/[A-Za-z0-9_-]{43}$/.test(url.pathname))throw Error('本机群聊窗口地址无效');if(this.platform!=='win32')throw Error('请从星港桌面应用打开群聊窗口');const window=windowsAppCommand(url.origin,this);if(!window)throw Error('打开独立群聊窗口需要 Microsoft Edge');const child=this.spawnProcess(window.command,['--new-window','--app='+url.href],{detached:true,stdio:'ignore',windowsHide:false});await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});child.unref();return {opened:true};}
  async open(value,launchCode,roomId) {
    const url = collaborationUrl(value);
    if (launchCode !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(launchCode)) throw Error('窗口登录凭证无效');
    if (this.platform !== 'win32') throw Error('请从星港桌面应用中打开群聊窗口');
    if(roomId!==undefined&&!/^[a-f0-9-]{36}$/.test(roomId))throw Error('群聊标识无效');
    const command = windowsAppCommand(url+(launchCode?'/#connect='+launchCode+(roomId?'&room='+roomId:''):''), this);
    if (!command) throw Error('打开独立群聊窗口需要 Microsoft Edge，请先安装 Edge');
    const child = this.spawnProcess(command.command, command.args, { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { opened: true };
  }
}
