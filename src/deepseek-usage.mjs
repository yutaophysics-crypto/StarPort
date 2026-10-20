import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {isDeepseekDesktop,deepseekDesktopMetadata} from './deepseek-desktop.mjs';

const optional=async path=>{try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}};

// Credentials remain in memory for a single request to DeepSeek's official host.
export async function deepseekBalance(runtime,cwd,root,options={},request=fetch,loadNative){
  if(isDeepseekDesktop(runtime)){
    const provider=options.provider||(await deepseekDesktopMetadata(runtime,cwd)).selection.provider;
    return {status:'unsupported',reason:provider==='deepseek-account'?
      '当前使用 DeepSeek 账号登录，请在 DeepSeek Harness 桌面版查看账号用量；该账号额度与 API 余额不同':
      '当前桌面运行时的余额查询暂未接入，请在 DeepSeek 官方平台查看用量'};
  }
  const entry=runtime.prefixArgs.find(arg=>/\.[cm]?js$/i.test(arg))||join(root,'.runtime/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const require=createRequire(entry),load=loadNative||(async name=>import(pathToFileURL(require.resolve(name)).href));
  const yaml=await load('js-yaml'),home=process.env.DSH_HOME||join(homedir(),'.dsh');
  const settings=yaml.load(await optional(join(home,'settings.yaml')))||{};
  const provider=options.provider||settings['agent-default-model']?.provider||'deepseek-official';
  if(provider!=='deepseek-official')return {status:'unsupported',reason:'当前 DeepSeek Harness 使用第三方模型服务，请在该服务的官方页面查询用量'};
  const envModule=await load('@deepseek-ai/dsh-launch-environment');
  const environment=envModule.createLaunchEnvironmentSnapshot([
    {source:'process',values:process.env},
    {source:'project-env',path:join(cwd,'.env'),values:parseEnv(await optional(join(cwd,'.env')))},
    {source:'user-env',path:join(home,'.env'),values:parseEnv(await optional(join(home,'.env')))}]);
  const adapter=await load('@deepseek-ai/dsh-llm-deepseek');
  const connection=adapter.resolveAdapterOptions(settings['llm-deepseek']||{},environment);
  const endpoint=new URL(connection.baseURL);
  if(endpoint.origin!=='https://api.deepseek.com'||endpoint.username||endpoint.password||!['/','/v1','/v1/','/beta','/beta/'].includes(endpoint.pathname))
    return {status:'unsupported',reason:'当前配置使用自定义服务地址，星港不会将其凭据发送到其他服务'};
  const credentials=await load('@deepseek-ai/dsh-credentials-local');
  const spec=credentials.resolveSpec({...settings['credentials-local'],dshHome:home});
  const raw=await optional(spec.filename);
  // Parse legacy layout in memory only. Querying must not migrate credential files.
  const document=credentials.parseCredentialsDocument(credentials.renderFlatLayoutMigration(raw)||raw,spec.filename);
  const ref=connection.apiKeyEnv;
  const key=environment.getFrom(ref,['process'])?.value||document.refs.get(ref)||environment.getFrom(ref,['project-env','user-env'])?.value;
  if(!key)return {status:'login_required',reason:'请先在 DeepSeek Harness 中配置官方服务的 API Key'};
  const response=await request('https://api.deepseek.com/user/balance',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){if([401,403].includes(response.status))return {status:'login_required',reason:'DeepSeek 官方服务未接受当前凭据，请在原工具中检查配置'};throw new Error('DeepSeek 用量查询失败 (HTTP '+response.status+')');}
  const native=await response.json();
  if(typeof native.is_available!=='boolean'||!Array.isArray(native.balance_infos))throw new Error('厂商返回了无法识别的用量格式');
  return {status:'ok',native};
}
