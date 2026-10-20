import { existsSync, readFileSync } from 'node:fs';
import { join,isAbsolute } from 'node:path';
import { accountUrl } from '../src/accounts/protocol.mjs';

// Machine-local deployment choices also apply when the native app starts Node.
export function readLocalServices(root, dataDir = process.env.HARNESS_HUB_DATA || join(root, '.data')) {
  const file = join(dataDir, 'local-services.json');
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const url = new URL(config.collaborationUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('本机群聊配置必须使用不含路径或密码的 HTTPS 服务地址');
  }
  if (config.server !== undefined && typeof config.server !== 'boolean') throw Error('本机群聊 server 配置必须为布尔值');
  if (config.events !== undefined && !['sse', 'poll'].includes(config.events)) throw Error('本机群聊 events 配置必须为 sse 或 poll');
  if(config.accountServer!==undefined&&typeof config.accountServer!=='boolean')throw Error('账号中心 accountServer 配置必须为布尔值');
  const accountCenter=config.accountCenter?accountUrl(config.accountCenter):null;
  if(config.accountServer&&(!config.server||!accountCenter||new URL(accountCenter).origin!==url.origin))throw Error('本机账号中心需与已部署群聊服务共用公网入口');
  for(const key of ['groupData','accountData'])if(config[key]!==undefined&&(typeof config[key]!=='string'||!isAbsolute(config[key])))throw Error('服务数据目录需为绝对路径');
  return { collaborationUrl: url.origin, server: config.server === true, events: config.events || 'sse',...accountCenter?{accountCenter,accountServer:config.accountServer===true}:{},...config.groupData?{groupData:config.groupData}:{},...config.accountData?{accountData:config.accountData}:{} };
}

export function localServicesEnvironment(config, environment = process.env) {
  if (!config) return {};
  const values = { STARPORT_COLLAB_URL: config.collaborationUrl,
    ...config.server ? { STARPORT_PUBLIC_URL: config.collaborationUrl, STARPORT_COLLAB_EVENTS: config.events } : {},
    ...config.accountCenter?{STARPORT_ACCOUNT_URL:config.accountCenter}:{},...config.accountServer?{STARPORT_ACCOUNT_BACKEND:'http://127.0.0.1:3217'}:{},...config.groupData?{STARPORT_COLLAB_DATA:config.groupData}:{},...config.accountData?{STARPORT_ACCOUNT_DATA:config.accountData}:{} };
  for (const [key, value] of Object.entries(values)) {
    if (environment[key] && environment[key] !== value) throw Error('本机群聊配置与已有环境变量冲突：' + key);
  }
  return values;
}
