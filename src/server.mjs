import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './storage.mjs';
import { ProviderRegistry, PROVIDERS, validateOptions } from './providers.mjs';
import { Runner } from './runner.mjs';
import { redact } from './process.mjs';
import { browseFolders, createFolder, directoryPath } from './folders.mjs';
import { ProjectFolders } from './projects.mjs';
import { Attachments } from './attachments.mjs';
import { ChatTransfer } from './chat-transfer.mjs';
import { EdgeBridge } from './edge.mjs';
import {parseVideoReference,videoAttachment} from './videos.mjs';
import { HistoryImporter } from './history.mjs';
import { FileActions } from './files.mjs';
import { MemorySync } from './memory-sync.mjs';
import { DesktopLink } from './collaboration/desktop.mjs';
import { DesktopAccount } from './accounts/desktop.mjs';
import { defaultAccountCenter } from '../scripts/account-config.mjs';
import { GroupWindowLauncher } from './window-launcher.mjs';
import { DesktopProfiles } from './accounts/profiles.mjs';
import { GroupWindows } from './group-windows.mjs';
import { StarportHosting } from './hosting.mjs';
import { Workflows } from './workflows.mjs';
import { Compactor } from './compaction.mjs';
import { PromptSnippets } from './prompt-snippets.mjs';
import { Notifications, chimeWav } from './notifications.mjs';
import { WindowsNotifier } from './notifier-windows.mjs';
import { ExternalTools } from './external-tools/grants.mjs';
import { externalApplicationManager } from './external-tools/applications.mjs';
import { handleExternalToolRoutes } from './external-tools/routes.mjs';

export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
async function body(req,limit=20*1024*1024){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error(`文件超过 ${limit/1024/1024} MB`),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new Error('请求内容不是有效 JSON');}
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};

export function createHub({root=ROOT,dataDir=process.env.HARNESS_HUB_DATA || join(root,'.data'),port=Number(process.env.HARNESS_HUB_PORT||3210),registry:customRegistry,implementations,historyConnect,claudeHistory,antigravityHistory,deepseekHistory,fileActions:customFileActions,windowLauncher:customWindowLauncher,accountCenter=null,notifier:customNotifier=null,nativeNotifications=false,examRoot=process.env.STARPORT_EXAM_ROOT||null}={}) {
  mkdirSync(dataDir,{recursive:true});
  // The launcher compares this with the code on disk to find a server still running old code.
  const startedAt=Date.now();
  const store=new Store(join(dataDir,'hub.sqlite'));
  const registry=customRegistry||new ProviderRegistry(root,dataDir,store);
  const attachments=new Attachments(store,dataDir);
  const chatTransfer=new ChatTransfer(store,attachments);
  const fileActions=customFileActions||new FileActions();
  const windowLauncher=customWindowLauncher||new GroupWindowLauncher();
  const edge=new EdgeBridge(store);
  const history=new HistoryImporter(store,registry,root,historyConnect,claudeHistory,{...antigravityHistory?{antigravity:antigravityHistory}:{},...deepseekHistory?{deepseek:deepseekHistory}:{}});
  const token=randomBytes(32).toString('hex');const clients=new Set();
  const broadcast=(event,data)=>{
    const payload=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for(const client of clients){if(client.writableLength>2*1024*1024){client.destroy();clients.delete(client);}else client.write(payload);}
  };
  const runner=new Runner(store,registry,broadcast,implementations,attachments,history);
  const workflows=new Workflows({store,runner,broadcast,dataDir,registry,defaultWorkspace:dirname(root),examRoot});
  const compactor=new Compactor({store,runner,broadcast});runner.compactor=compactor;
  const snippets=new PromptSnippets(store);
  // Native popups only for the real desktop server; tests and fixtures pass their own notifier or none.
  const notifier=customNotifier||(nativeNotifications?new WindowsNotifier({root,dataDir,url:()=>`http://127.0.0.1:${server.address()?.port||port}/`}):null);
  const notifications=new Notifications({store,notifier,broadcast});
  runner.onFinished=workflows.onFinished=info=>notifications.finished(info);
  let chime=null;
  let remoteVerification='';
  const desktopLink=new DesktopLink({registry,dataDir,implementations,onChange:status=>{broadcast('collaboration',status);const verification=registry.verifications?.()||{},encoded=JSON.stringify(verification);if(encoded!==remoteVerification){remoteVerification=encoded;broadcast('message',{providerVerifications:verification});}}});
  const desktopAccount=new DesktopAccount({issuer:accountCenter,dataDir,desktopLink});
  const hosting=new StarportHosting({root,dataDir});
  desktopLink.request=(base,path,options)=>hosting.request(base,path,{method:'POST',...options});
  const profiles=new DesktopProfiles({dataDir,registry,implementations,legacyLink:desktopLink,request:hosting.request.bind(hosting),onChange:status=>broadcast('collaboration',status)});
  const groupWindows=new GroupWindows({root,dataDir,profiles,defaultServer:()=>hosting.config.enabled?hosting.origin():''});
  const memorySync=new MemorySync(store,{dataDir,onChange:()=>broadcast('memory-sync',memorySync.status())});
  // Every conversation's exact working folder is its project, including existing records.
  const projectFolders=new ProjectFolders(store,{protectedPaths:()=>[root,dataDir,memorySync.config().folder]});store.projectFolders=projectFolders;
  projectFolders.sync();
  const archiveRepair=store.archives.reconcile();
  if(archiveRepair.errors.length)console.warn('部分历史存档等待迁移：',archiveRepair.errors);
  const isBusy=id=>runner.active.has(id)||workflows.busy(id);
  const externalRoutes={store,registry,isBusy,tools:registry.externalTools||new ExternalTools({root,dataDir}),applications:externalApplicationManager(dataDir)};
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const server=createServer(async(req,res)=>{
    const address=server.address(), currentPort=typeof address==='object'?address?.port:port;
    const hosts=[`127.0.0.1:${currentPort}`,`localhost:${currentPort}`];
    if(!hosts.includes(req.headers.host)){json(res,{error:'非法访问地址'},403);return;}
    const base=`http://${req.headers.host}`,url=new URL(req.url,base),path=url.pathname;
    if(['/bridge/pair','/bridge/poll','/bridge/result'].includes(path)){
      const origin=req.headers.origin,extensionId=req.headers['x-starport-extension'];
      if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)){json(res,{error:'拒绝跨站请求'},403);return;}
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type,X-Starport-Key,X-Starport-Extension'});res.end();return;}
      if(req.method!=='POST'||!edge.validId(extensionId)||(origin&&origin!=='chrome-extension://'+extensionId)){json(res,{error:'无效的扩展请求'},403);return;}
      try{
        if(path==='/bridge/pair'){json(res,edge.pairClient((await body(req)).code,extensionId));return;}
        if(!edge.authorize(req.headers['x-starport-key'],extensionId)){json(res,{error:'扩展需要重新配对'},401);return;}
        if(path==='/bridge/poll'){json(res,await edge.poll());return;}
        edge.result(await body(req));json(res,{ok:true});return;
      }catch(error){json(res,{error:error.message},400);return;}
    }
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.headers.origin && req.headers.origin!==base){json(res,{error:'拒绝跨站请求'},403);return;}
    if(req.headers['sec-fetch-site']==='cross-site' && path.startsWith('/api/')){json(res,{error:'拒绝跨站请求'},403);return;}
    try{
      if(path==='/health' && req.method==='GET'){json(res,{app:'harness-hub',version:'0.2.0',port:currentPort,root,pid:process.pid,startedAt});return;}
      const groupWindowRoute=/^\/group-windows\/([A-Za-z0-9_-]{43})(?:\/api(\/.*))?$/.exec(path);
      if(groupWindowRoute){const[,windowId,route]=groupWindowRoute;if(!route){if(req.method!=='GET')throw Object.assign(Error('请求方法无效'),{status:405});res.writeHead(200,{'Content-Type':mime['.html'],'Cache-Control':'no-store'});res.end(await groupWindows.html(windowId));return;}if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==base)throw Object.assign(Error('操作需要同源来源'),{status:403});const result=await groupWindows.api(windowId,req.headers['x-starport-group-window'],route+url.search,req.method,['GET','HEAD'].includes(req.method)?undefined:await body(req,200000));if(route==='/windows'&&windowLauncher.mode==='windows'){await windowLauncher.openLocal(base+'/group-windows/'+result.windowId);result.opened=true;}json(res,result);return;}
      if(path.startsWith('/api/')) {
        const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('hub='))?.slice(4);
        if(!equal(req.headers['x-hub-token'],token)&&!equal(cookie,token)){json(res,{error:'请从首页重新打开应用'},401);return;}
        if(!['GET','HEAD'].includes(req.method)&&!equal(req.headers['x-hub-token'],token)){json(res,{error:'请求令牌无效，请刷新页面'},403);return;}
        if(path==='/api/events'&&req.method==='GET'){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': connected\n\n');clients.add(res);
          const timer=setInterval(()=>res.write(': ping\n\n'),15000),page=url.searchParams.get('client');notifications.connect(page);
          res.on('close',()=>{clearInterval(timer);clients.delete(res);notifications.disconnect(page);});return;
        }
        if(path==='/api/state'&&req.method==='GET'){const providers=await registry.list();json(res,{...store.list(),providers,defaultWorkspace:dirname(root),active:[...runner.active.keys()],collaboration:desktopLink.status(),magi:{version:'2.8.0',commit:'e95f14a4a1601008cee9a00aa2b5e78c49842794',modules:['宿主注册表','Markdown 渲染','KaTeX 公式资源']}});return;}
        if(path==='/api/notifications/chime.wav'&&req.method==='GET'){chime??=chimeWav();res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'max-age=86400'});res.end(chime);return;}
        const notificationResult=await notifications.handle(req.method,path,()=>body(req,16384));
        if(notificationResult){json(res,notificationResult.data,notificationResult.status);return;}
        const workflowResult=await workflows.handle(req.method,path,()=>body(req,400000));
        if(workflowResult){json(res,workflowResult.data,workflowResult.status);return;}
        const contextResult=await compactor.handle(req.method,path,()=>body(req,16384));
        if(contextResult){json(res,contextResult.data,contextResult.status);return;}
        const snippetResult=await snippets.handle(req.method,path,()=>body(req,4*1024*1024));
        if(snippetResult){json(res,snippetResult.data,snippetResult.status);return;}
        if(path==='/api/collaboration/profiles'&&req.method==='GET'){json(res,{...profiles.status(),windowMode:windowLauncher.mode});return;}
        if(['/api/collaboration/profiles/login','/api/collaboration/profiles/register'].includes(path)&&req.method==='POST'){json(res,await profiles.login(await body(req,4096),path.endsWith('/register')));return;}
        if(path==='/api/collaboration/profiles/forget'&&req.method==='POST'){json(res,await profiles.forget((await body(req,4096)).profileId));return;}
        if(path==='/api/collaboration/windows'&&req.method==='POST'){const input=await body(req,4096),result=await groupWindows.create(Object.hasOwn(input,'profileId')?input.profileId:profiles.lastProfile);json(res,{...result,url:base+'/group-windows/'+result.windowId,windowMode:windowLauncher.mode});return;}
        if(path==='/api/collaboration/hosting'&&req.method==='GET'){json(res,await hosting.status());return;}
        if(path==='/api/collaboration/hosting'&&req.method==='PATCH'){json(res,await hosting.configure(await body(req,4096)));return;}
        if(path==='/api/collaboration/hosting/start'&&req.method==='POST'){await body(req,4096);json(res,await hosting.start());return;}
        if(path==='/api/collaboration/hosting/stop'&&req.method==='POST'){await body(req,4096);json(res,await hosting.stop());return;}
        if(path==='/api/collaboration/hosting/accounts'&&req.method==='GET'){json(res,{accounts:hosting.accounts()});return;}
        if(path==='/api/collaboration/hosting/accounts'&&req.method==='POST'){json(res,await hosting.accountAction('create',await body(req,4096)));return;}
        if(['/api/collaboration/hosting/accounts/password','/api/collaboration/hosting/accounts/disabled'].includes(path)&&req.method==='POST'){json(res,await hosting.accountAction(path.endsWith('/password')?'password':'disabled',await body(req,4096)));return;}
        if(path==='/api/collaboration/status'&&req.method==='GET'){json(res,{...desktopLink.status(),accountCenter:desktopAccount.status(),windowMode:windowLauncher.mode});return;}
        if(path==='/api/collaboration/account/login'&&req.method==='POST'){json(res,await desktopAccount.login(await body(req,4096)));return;}
        if(path==='/api/collaboration/account/register'&&req.method==='POST'){json(res,await desktopAccount.login(await body(req,4096),true));return;}
        if(path==='/api/collaboration/account/logout'&&req.method==='POST'){json(res,await desktopAccount.logout());return;}
        if(path==='/api/collaboration/groups'&&req.method==='GET'){json(res,{servers:await desktopAccount.groups()});return;}
        if(path==='/api/collaboration/last-group'&&req.method==='GET'){json(res,await desktopAccount.lastGroup());return;}
        if(path==='/api/collaboration/join'&&req.method==='POST'){json(res,await desktopAccount.join(await body(req,4096)));return;}
        if(path==='/api/collaboration/create'&&req.method==='POST'){json(res,await desktopAccount.create(await body(req,4096)));return;}
        if(path==='/api/collaboration/invite'&&req.method==='POST'){json(res,await desktopAccount.invite(await body(req,4096)));return;}
        if(path==='/api/collaboration/window-ticket'&&req.method==='POST'){json(res,await desktopAccount.window(await body(req,4096)));return;}
        if(path==='/api/collaboration/window'&&req.method==='POST'){const input=await body(req,4096);if(input.windowId){groupWindows.view(input.windowId);json(res,await windowLauncher.openLocal(base+'/group-windows/'+input.windowId));}else json(res,await windowLauncher.open(input.hubUrl,input.launchCode,input.roomId));return;}
        if(path==='/api/collaboration/connect'&&req.method==='POST'){const input=await body(req,20000);json(res,desktopAccount.issuer?await desktopAccount.bind(input):await desktopLink.connect(input));return;}
        if(path==='/api/collaboration/disconnect'&&req.method==='POST'){json(res,await desktopLink.disconnect((await body(req,4096)).server));return;}
        if(path==='/api/live'&&req.method==='GET'){
          const id=url.searchParams.get('chatId');
          if(id&&(!/^[\w-]{1,100}$/.test(id)||!store.chat(id)))throw Object.assign(new Error('对话不存在'),{status:404});
          if(id)runner.refreshContext(id).catch(()=>{});
          json(res,{...runner.live(id),chatStatuses:store.chatStatus.summaries()});return;
        }
        if(path==='/api/memory-sync'&&req.method==='GET'){json(res,memorySync.status());return;}
        if(path==='/api/memory-sync'&&req.method==='PATCH'){json(res,await memorySync.configure(await body(req,4096)));return;}
        if(path==='/api/memory-sync/run'&&req.method==='POST'){json(res,await memorySync.sync());return;}
        if(path==='/api/memory-sync/resolve'&&req.method==='POST'){const data=await body(req,16384);json(res,await memorySync.resolve(data.key,data));return;}
        if(path==='/api/memories'&&req.method==='GET'){
          json(res,store.memory.list({view:url.searchParams.get('view')||'confirmed',search:url.searchParams.get('search')||'',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50),projectId:url.searchParams.has('project')?(url.searchParams.get('project')||null):undefined}));return;
        }
        if(path==='/api/context/preferences'&&req.method==='GET'){json(res,store.instructions.get());return;}
        if(path==='/api/context/preferences'&&req.method==='PATCH'){json(res,store.instructions.update(null,await body(req,30000)));broadcast('refresh',{});return;}
        const requirementRoute=path.match(/^\/api\/projects\/([\w-]+)\/requirements$/);
        if(requirementRoute&&req.method==='GET'){json(res,store.instructions.get(requirementRoute[1]));return;}
        if(requirementRoute&&req.method==='PATCH'){json(res,store.instructions.update(requirementRoute[1],await body(req,30000)));broadcast('refresh',{});return;}
        if(path==='/api/context/history/search'&&req.method==='POST'){json(res,store.search.search(await body(req,4096)));return;}
        if(path==='/api/context/history/read'&&req.method==='POST'){const data=await body(req,4096),projectId=data.projectId||null;delete data.projectId;const all=data.all===true;delete data.all;json(res,store.search.read(data,projectId,{all}));return;}
        if(path==='/api/memories'&&req.method==='POST'){
          const data=await body(req,16384);if(data.confirmed!==undefined&&typeof data.confirmed!=='boolean')throw new Error('确认状态无效');
          json(res,store.memory.create(data,{confirmed:data.confirmed===true}),201);broadcast('refresh',{});return;
        }
        if(path==='/api/memories/config'&&req.method==='PATCH'){
          json(res,store.memory.configure(await body(req,1024)));broadcast('refresh',{});return;
        }
        const memoryRoute=path.match(/^\/api\/memories\/([\w-]+)$/);
        if(memoryRoute&&req.method==='GET'){json(res,store.memory.get(memoryRoute[1]));return;}
        if(memoryRoute&&req.method==='PATCH'){json(res,store.memory.update(memoryRoute[1],await body(req,16384)));broadcast('refresh',{});return;}
        if(memoryRoute&&req.method==='DELETE'){json(res,store.memory.remove(memoryRoute[1],(await body(req,1024)).revision));broadcast('refresh',{});return;}
        if(path==='/api/providers/refresh'&&req.method==='POST'){json(res,await registry.list(true));return;}
        if(path==='/api/edge/status'&&req.method==='GET'){json(res,{...edge.status(),extensionPath:join(root,'extensions','edge')});return;}
        if(path==='/api/edge/pair'&&req.method==='POST'){json(res,edge.createPair());return;}
        if(path==='/api/edge/tabs'&&req.method==='GET'){json(res,await edge.tabs());return;}
        if(path==='/api/edge/attach'&&req.method==='POST'){json(res,attachments.web(await edge.capture((await body(req)).tabId)),201);return;}
        if(path==='/api/videos/read'&&req.method==='POST'){
          const reference=parseVideoReference((await body(req,16384)).reference);
          const caption=videoAttachment(reference,await edge.video(reference.url));
          json(res,{attachment:attachments.web(caption),bvid:reference.bvid,part:reference.part},201);return;
        }
        if(path==='/api/attachments'&&req.method==='POST'){json(res,await attachments.upload(await body(req)),201);return;}
        if(path==='/api/attachments/folder'&&req.method==='POST'){json(res,await attachments.folder((await body(req)).path),201);return;}
        const fileActionRoute=path.match(/^\/api\/files\/(resolve|open|reveal|open-with)$/);
        if(fileActionRoute&&req.method==='POST'){
          const data=await body(req,16384),chat=data.chatId?store.chat(data.chatId):null;
          if(data.chatId&&!chat)throw Object.assign(new Error('对话不存在'),{status:404});
          const workspace=chat?.workspace||dirname(root),action=fileActionRoute[1];
          json(res,action==='resolve'?await fileActions.resolve(data.reference,workspace):await fileActions.perform(action,data.reference,workspace));return;
        }
        const attachmentRoute=path.match(/^\/api\/attachments\/([\w-]+)(?:\/(preview|download))?$/);
        if(attachmentRoute&&req.method==='GET'){
          const row=attachments.raw(attachmentRoute[1]);if(!row)throw new Error('附件不存在，请重新选择');
          if(!attachmentRoute[2]){json(res,attachments.metadata(row));return;}
          if(['folder','web'].includes(row.kind)){json(res,{...attachments.metadata(row),text:row.kind==='web'?row.data:''});return;}
          const inline=attachmentRoute[2]==='preview'&&row.mime.startsWith('image/');
          res.writeHead(200,{'Content-Type':inline?row.mime:'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,'Cache-Control':'private, no-store'});res.end(Buffer.from(row.data,'base64'));return;
        }
        const externalResult=await handleExternalToolRoutes(externalRoutes,req.method,path,limit=>body(req,limit));
        if(externalResult){json(res,externalResult.data,externalResult.status);return;}
        if(path==='/api/projects'&&req.method==='GET'){json(res,projectFolders.list());return;}
        // Explicitly adding a folder remains available before starting its first chat.
        if(path==='/api/projects'&&req.method==='POST'){
          const data=await body(req,16384),result=await projectFolders.mark(data.workspace);
          json(res,{...result.project,created:result.created,warning:result.warning},result.created?201:200);broadcast('refresh',{});return;
        }
        const projectRoute=path.match(/^\/api\/projects\/([\w-]+)\/(unmark|attach)$/);
        if(projectRoute&&req.method==='POST'){
          const data=await body(req,16384),result=projectRoute[2]==='unmark'?projectFolders.unmark(projectRoute[1]):await projectFolders.attach(projectRoute[1],data.workspace);
          json(res,result);broadcast('refresh',{});return;
        }
        if(path==='/api/folders'&&req.method==='GET'){json(res,projectFolders.describe(await browseFolders(url.searchParams.get('path'),dirname(root))));return;}
        if(path==='/api/folders'&&req.method==='POST'){const data=await body(req,16384);json(res,await createFolder(data.parent,data.name),201);return;}
        // Renames the folder on disk together with every Starport reference to it.
        if(path==='/api/folders/rename'&&req.method==='POST'){const data=await body(req,16384);json(res,await projectFolders.renameFolder(data.path,data.name,{isBusy}));broadcast('refresh',{});return;}
        if(path==='/api/folders/open'&&req.method==='POST'){json(res,await fileActions.openFolder(await directoryPath((await body(req,16384)).path)));return;}
        const modelsRoute=path.match(/^\/api\/providers\/(codex|claude|antigravity|deepseek)\/models$/);
        if(modelsRoute&&req.method==='GET'){
          const cwd=await directoryPath(url.searchParams.get('workspace')||dirname(root));
          json(res,await registry.models(modelsRoute[1],cwd,url.searchParams.get('refresh')==='1'));return;
        }
        const providerRoute=path.match(/^\/api\/providers\/(codex|claude|antigravity|deepseek)$/);
        const usageRoute=path.match(/^\/api\/providers\/(codex|claude|antigravity|deepseek)\/usage$/);
        if(usageRoute&&req.method==='GET'){
          const cwd=await directoryPath(url.searchParams.get('workspace')||dirname(root)),service=url.searchParams.get('service')||'';
          if(service.length>500)throw new Error('模型服务名称过长');
          json(res,await registry.usage(usageRoute[1],cwd,{provider:service}));return;
        }
        if(providerRoute&&req.method==='PUT'){registry.configure(providerRoute[1],await body(req));json(res,await registry.probe(providerRoute[1],true));return;}
        if(path==='/api/groups'&&req.method==='POST'){const data=await body(req);if(typeof data.name!=='string'||!data.name.trim()||data.name.length>120)throw new Error('分组名称应为 1–120 字符');json(res,store.group(data.name.trim()),201);broadcast('refresh',{});return;}
        const groupRoute=path.match(/^\/api\/groups\/([\w-]+)(?:\/(delete))?$/);
        if(groupRoute&&!groupRoute[2]&&req.method==='PATCH'){const data=await body(req);if(typeof data.name!=='string'||!data.name.trim()||data.name.length>120)throw new Error('分组名称无效');store.renameGroup(groupRoute[1],data.name.trim());json(res,{ok:true});broadcast('refresh',{});return;}
        if(groupRoute&&(req.method==='DELETE'||(groupRoute[2]==='delete'&&req.method==='POST'))){
          const gid=groupRoute[1],data=req.method==='POST'?await body(req,16384):{mode:url.searchParams.get('mode')||'move',exportDir:url.searchParams.get('exportDir')||''};
          const groupChats=store.list().chats.filter(c=>c.group_id===gid);
          for(const c of groupChats){await workflows.stopChat(c.id);if(runner.active.has(c.id))await runner.stop(c.id).catch(()=>{});}
          let exportedCount=0,exportedPath='';
          if(data.mode==='export'){
            if(!data.exportDir||typeof data.exportDir!=='string')throw new Error('请选择导出文件夹路径');
            const baseDir=await directoryPath(data.exportDir);
            const groupObj=store.list().groups.find(g=>g.id===gid);
            const safeGroup=((groupObj?.name||'room').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').trim().slice(0,60))||'room';
            const roomExportDir=join(baseDir,`${safeGroup}_导出_${new Date().toISOString().slice(0,10)}`);
            mkdirSync(roomExportDir,{recursive:true});
            exportedPath=roomExportDir;
            for(const c of groupChats){
              if(c.title.startsWith('[工位]'))continue;
              const safeTitle=(c.title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').trim().slice(0,70)||'conversation')+'_'+c.id.slice(0,6);
              const md=`# ${c.title}\n\n`+store.messages(c.id).map(m=>`## ${m.role==='user'?'用户':m.provider||'助手'} · ${m.created}\n\n${m.content}\n${m.details.error?'\n> '+m.details.error+'\n':''}`).join('\n');
              writeFileSync(join(roomExportDir,`${safeTitle}.md`),md,'utf8');
              try{writeFileSync(join(roomExportDir,`${safeTitle}.starport.json`),JSON.stringify(chatTransfer.export(c.id),null,2),'utf8');}catch{}
              exportedCount++;
            }
          }
          store.deleteGroup(gid,{mode:data.mode==='move'?'move':'delete'});
          json(res,{ok:true,exportedCount,exportedPath});broadcast('refresh',{});return;
        }
        if(path==='/api/chats'&&req.method==='POST'){
          const data=await body(req);if(!PROVIDERS[data.provider||'codex'])throw new Error('未知工具');
          const project=data.project_id?store.project(data.project_id):null;if(data.project_id&&!project)throw new Error('项目不存在');
          const workspace=await directoryPath(typeof data.workspace==='string'?data.workspace:project?.workspace||dirname(root));
          const created=store.newChat({group_id:data.group_id||null,provider:data.provider||'codex',workspace});
          projectFolders.sync([created.id]);const chat=store.chat(created.id);
          json(res,chat,201);broadcast('refresh',{chatId:chat.id});return;
        }
        const queueRoute=path.match(/^\/api\/chats\/([\w-]+)\/queue(?:\/([\w-]+)(?:\/(steer|send|edit|cancel-edit))?)?$/);
        if(queueRoute){
          const[,id,item,action]=queueRoute;if(!store.chat(id))throw Object.assign(new Error('对话不存在'),{status:404});
          if(!item&&req.method==='GET'){json(res,store.queue.snapshot(id));return;}
          if(!item&&req.method==='POST'){json(res,runner.enqueue(id,await body(req)),202);return;}
          if(item&&!action&&req.method==='PATCH'){json(res,runner.editQueued(id,item,await body(req)));return;}
          if(item&&!action&&req.method==='DELETE'){json(res,runner.deleteQueued(id,item,await body(req)));return;}
          if(item&&action==='edit'&&req.method==='POST'){json(res,runner.beginQueuedEdit(id,item,await body(req)));return;}
          if(item&&action==='cancel-edit'&&req.method==='POST'){json(res,runner.cancelQueuedEdit(id,item,await body(req)));return;}
          if(item&&action==='steer'&&req.method==='POST'){json(res,await runner.steerQueued(id,item,await body(req)));return;}
          if(item&&action==='send'&&req.method==='POST'){const data=await body(req);await runner.dispatchQueue(id,item,data.revision);json(res,store.queue.snapshot(id));return;}
        }
        const route=path.match(/^\/api\/chats\/([\w-]+)(?:\/(messages|guidance|stop|approval|goal|export|reset-session|read|question-skip|branch|context))?$/);
        if(route){
          const[,id,action]=route,chat=store.chat(id);if(!chat)throw Object.assign(new Error('对话不存在'),{status:404});
          if(action==='context'&&req.method==='GET'){json(res,await runner.refreshContext(id,url.searchParams.get('refresh')==='1'));return;}
          if(!action&&req.method==='GET'){await runner.messages(id);json(res,runner.snapshot(id));return;}
          if(!action&&req.method==='DELETE'){
            if(runner.active.has(id))throw Object.assign(new Error('请先停止当前任务再删除对话'),{status:409});
            if(workflows.busy(id))throw Object.assign(new Error('这个对话的工作流正在运行，请先停止'),{status:409});
            store.deleteChat(id);
            json(res,{ok:true});broadcast('refresh',{deletedChatId:id});return;
          }
          if(!action&&req.method==='PATCH'){
            const raw=await body(req),patch={};
            const groupOnly=Object.keys(raw).length===1&&Object.hasOwn(raw,'group_id');
            if(runner.active.has(id)&&!groupOnly)throw Object.assign(new Error('请先停止当前任务再修改对话设置'),{status:409});
            for(const key of ['title','workspace','provider','group_id'])if(key in raw)patch[key]=raw[key];
            if('title' in patch&&(typeof patch.title!=='string'||!patch.title.trim()||patch.title.length>300))throw new Error('标题无效');
            if('workspace' in patch&&(typeof patch.workspace!=='string'||patch.workspace.length>2000))throw new Error('工作目录无效');
            if('workspace' in patch){if(workflows.busy(id))throw Object.assign(new Error('这个对话的工作流正在运行，请等它结束后更换文件夹'),{status:409});patch.workspace=await directoryPath(patch.workspace);}
            if('provider' in patch&&!PROVIDERS[patch.provider])throw new Error('未知工具');
            if(raw.options){const provider=patch.provider||chat.provider;patch.options={...chat.options,[provider]:validateOptions(provider,raw.options)};}
            store.updateChat(id,patch);projectFolders.sync([id]);if('group_id' in patch)workflows.chatMoved(id);
            const updated=store.chat(id);json(res,updated);broadcast('refresh',{chatId:id});return;
          }
          if(action==='messages'&&req.method==='POST'){const data=await body(req);json(res,await runner.start(id,data.text,data.attachments||[],{replyTo:data.replyTo,disableContextTools:data.disableContextTools===true,...data.runRef!=null?{runRef:data.runRef}:{}}),202);return;}
          if(action==='guidance'&&req.method==='POST'){const data=await body(req);json(res,await runner.guidance(id,data),202);return;}
          if(action==='stop'&&req.method==='POST'){await runner.stop(id);json(res,{ok:true});return;}
          if(action==='approval'&&req.method==='POST'){const data=await body(req);await runner.answer(id,data.id,data);json(res,{ok:true});return;}
          if(action==='read'&&req.method==='POST'){const data=await body(req,1024);json(res,store.chatStatus.read(id,data.messageId));broadcast('message',runner.live(id));return;}
          if(action==='branch'&&req.method==='POST'){const data=await body(req,4096);const branch=store.branchChat(id,data.messageId);json(res,branch,201);broadcast('refresh',{chatId:branch.id});return;}
          if(action==='question-skip'&&req.method==='POST'){const data=await body(req,4096);json(res,runner.skipQuestions(id,data.replyTo));return;}
          if(action==='goal'&&req.method==='POST'){await runner.goal(id,(await body(req)).action);json(res,{ok:true});return;}
          if(action==='reset-session'&&req.method==='POST'){if(runner.active.has(id))throw new Error('请先停止当前任务');store.clearSession(id,chat.provider);json(res,{ok:true});broadcast('refresh',{chatId:id});return;}
          if(action==='export'&&req.method==='GET'){
            if(url.searchParams.get('format')==='starport'){
              const filename=(chat.title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').slice(0,80)||'conversation')+'.starport.json';
              res.setHeader('Content-Disposition',`attachment; filename="conversation.starport.json"; filename*=UTF-8''${encodeURIComponent(filename)}`);
              json(res,chatTransfer.export(id));return;
            }
            const md=`# ${chat.title}\n\n`+store.messages(id).map(m=>`## ${m.role==='user'?'用户':m.provider||'助手'} · ${m.created}\n\n${m.content}\n${m.details.error?'\n> '+m.details.error+'\n':''}`).join('\n');
            res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="conversation.md"`});res.end(md);return;
          }
        }
        if(path==='/api/export'&&req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="harness-hub-backup.json"');json(res,store.export());return;}
        const historyRoute=/^\/api\/history\/([^/]+)(?:\/(preview|import))?$/.exec(path);
        if(historyRoute){
          const [,provider,action]=historyRoute;
          if(!action&&req.method==='GET'){json(res,await history.list(provider,{cursor:url.searchParams.get('cursor'),search:url.searchParams.get('search')||'',archived:url.searchParams.get('archived')==='true'}));return;}
          if(action==='preview'&&req.method==='GET'){json(res,await history.read(provider,url.searchParams.get('id'),{preview:true}));return;}
          if(action==='import'&&req.method==='POST'){const result=await history.import(provider,await body(req));projectFolders.sync();json(res,result);broadcast('refresh',{});return;}
        }
        if(path==='/api/import'&&req.method==='POST'){const result=store.import(await body(req,128*1024*1024),attachments);projectFolders.sync();json(res,result);broadcast('refresh',{});return;}
        if(path==='/api/chat-transfer/preview'&&req.method==='POST'){json(res,chatTransfer.preview(await body(req,128*1024*1024)));return;}
        if(path==='/api/chat-transfer/import'&&req.method==='POST'){
          const input=await body(req,128*1024*1024);
          const workspace=await directoryPath(input.workspace||dirname(root));
          const result=await chatTransfer.import(input.conversation,{group_id:input.group_id??null,group_name:input.group_name??'',workspace});
          projectFolders.sync();json(res,result,201);broadcast('refresh',{chatId:result.chatId});return;
        }
        json(res,{error:'没有这个接口'},404);return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){json(res,{error:'不支持的请求'},405);return;}
      let file;
      if(path==='/'||path==='/index.html'){
        const html=(await readFile(join(root,'public','index.html'),'utf8')).replace('__HUB_TOKEN__',token);
        res.setHeader('Set-Cookie',`hub=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200,{'Content-Type':mime['.html'],'Cache-Control':'no-store'});res.end(html);return;
      }
      const vendor='/vendor/';
      if(path==='/vendor/purify.min.js')file=join(root,'node_modules','dompurify','dist','purify.min.js');
      else if(path.startsWith(vendor)){
        const name=decodeURIComponent(path.slice(vendor.length));
        if(!/^(marked\.min\.js|katex\.min\.(js|css)|katex-LICENSE\.txt|katex-fonts\/[\w.-]+|fonts\/[\w.-]+)$/.test(name))throw Object.assign(new Error('资源不存在'),{status:404});
        file=join(root,'public','vendor',name);
      }else{
        const publicRoot=join(root,'public');file=resolve(publicRoot,'.'+decodeURIComponent(path));
        if(!file.startsWith(publicRoot+sep))throw Object.assign(new Error('非法路径'),{status:403});
      }
      const info=await stat(file);if(!info.isFile())throw Object.assign(new Error('资源不存在'),{status:404});
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(await readFile(file));
    }catch(e){if(!res.headersSent)json(res,{error:redact(e.code==='ENOENT'?'资源不存在':e.message)},e.status||(e.code==='ENOENT'?404:400));else res.end();}
  });
  return {server,store,registry,runner,workflows,notifications,attachments,edge,token,memorySync,desktopLink,profiles,groupWindows,hosting,
    async listen(){await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});memorySync.start();workflows.start();await hosting.resume();await desktopLink.resume();await profiles.resume();return server.address().port;},
    async close(){notifications.close();edge.close();await profiles.close();await desktopLink.close();await hosting.close();await workflows.close();await runner.close();await memorySync.close();await history.close();for(const c of clients)c.end();server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();}
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const hub=createHub({accountCenter:defaultAccountCenter(ROOT),nativeNotifications:process.platform==='win32'});
  try {const port=await hub.listen();writeFileSync(join(process.env.HARNESS_HUB_DATA||join(ROOT,'.data'),'server.json'),JSON.stringify({pid:process.pid,port,root:ROOT}));console.log(`Harness Hub: http://127.0.0.1:${port}`);}
  catch(e){console.error(e.message);process.exit(1);}
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await hub.close();process.exit(0);});
}
