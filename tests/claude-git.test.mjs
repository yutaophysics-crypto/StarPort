import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {runWorkspaceCommand,quotePowerShell} from '../src/external-tools/terminal.mjs';
import {stopProcess} from '../src/process.mjs';

const sandboxExecutable=process.env.STARPORT_MXC_TEST_EXECUTABLE;
const gitExecutable=process.env.STARPORT_GIT_TEST_EXECUTABLE||join(process.env.ProgramFiles||'C:\\Program Files','Git','cmd','git.exe');
const skip=process.platform!=='win32'||!sandboxExecutable?'Set STARPORT_MXC_TEST_EXECUTABLE to a native codex.exe to test real Windows MXC Git access':false;
const identity=['-c','user.name=Starport Git Test','-c','user.email=git-test@example.invalid'];
const git=(cwd,...args)=>execFileSync(gitExecutable,args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();

async function fixture(t){
 const temporary=realpathSync.native(tmpdir()),root=realpathSync.native(await mkdtemp(join(temporary,'starport-mxc-git-')));
 const children=[],servers=[];
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(ok=>server.close(ok));}for(const child of children)await stopProcess(child);assert.equal(dirname(root),temporary);await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
 const workspace=join(root,'project'),dataDir=join(workspace,'private-data'),runtimeDir=join(root,'runtime'),client=join(runtimeDir,'git-client'),sdk=join(root,'sdk');
 for(const dir of [workspace,dataDir,client,sdk,...['.codex','.agents','.aws'].map(name=>join(workspace,name))])await mkdir(dir,{recursive:true});
 await writeFile(join(client,'git-askpass.exe'),'unused for the local test remote');
 await writeFile(join(client,'gitconfig'),'');
 await writeFile(join(workspace,'.gitignore'),'/.starport-claude-runtime/\n/private-data/\n/remote.git/\n/.codex/\n/.agents/\n/.aws/\n');
 const protectedFiles=[join(root,'outside.txt'),join(dataDir,'private.txt'),join(sdk,'readonly.txt'),...['.codex','.agents','.aws'].map(name=>join(workspace,name,'protected.txt'))];
 for(const file of protectedFiles)await writeFile(file,'unchanged');
 const normalPolicy={root,dataDir,runtimeDir,gitExecutable};
 const snapshot={workspace,tools:[{id:'sdk',name:'SDK',directory:sdk,canonical:sdk,access:'read'}]};
 const run=async command=>{
  const result=await runWorkspaceCommand({workspace,snapshot,sandboxExecutable,normalPolicy,command,timeoutMs:30000});
  assert.equal(result.timedOut,false,JSON.stringify(result));assert.equal(result.exitCode,0,JSON.stringify(result));return result;
 };
 return {root,workspace,protectedFiles,run,children,servers};
}

async function remoteServer(f){
 git(f.root,'--git-dir=remote.git','config','http.receivepack','true');
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const child=spawn(gitExecutable,['http-backend'],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:f.root,GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method,PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:req.headers['content-length']||'',REMOTE_USER:'test',REMOTE_ADDR:'127.0.0.1'},stdio:['pipe','pipe','pipe']});f.children.push(child);
  let buffer=Buffer.alloc(0),headers=false;
  child.stdout.on('data',chunk=>{
   if(headers){res.write(chunk);return;}
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
   let status=200;const values={};
   for(const line of buffer.subarray(0,end).toString().split('\r\n')){const colon=line.indexOf(':');if(colon<0)continue;const name=line.slice(0,colon),value=line.slice(colon+1).trim();if(name.toLowerCase()==='status')status=Number(value.split(' ')[0]);else values[name]=value;}
   res.writeHead(status,values);headers=true;res.write(buffer.subarray(end+4));buffer=Buffer.alloc(0);
  });
  child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',error=>res.destroy(error));child.stdout.on('end',()=>{if(!headers)res.writeHead(502);res.end();});req.pipe(child.stdin);
 });
 f.servers.push(server);await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
 return `http://127.0.0.1:${server.address().port}/remote.git`;
}

test('real MXC terminal can add, commit, push and fetch without widening other file permissions',{skip,timeout:90000},async t=>{
 const f=await fixture(t);
 git(f.workspace,'init','-b','main');git(f.root,'init','--bare','remote.git');
 await writeFile(join(f.workspace,'tracked.txt'),'initial\n');
 git(f.workspace,'add','.gitignore','tracked.txt');git(f.workspace,...identity,'commit','-m','initial');
 git(f.workspace,'remote','add','origin',await remoteServer(f));
 await f.run("Set-Content -LiteralPath tracked.txt -Value updated; git add -A; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git -c user.name='Starport Git Test' -c user.email=git-test@example.invalid commit -m updated; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git push -u origin main; exit $LASTEXITCODE");
 const head=git(f.workspace,'rev-parse','HEAD');assert.equal(git(f.root,'--git-dir=remote.git','rev-parse','main'),head);
 const peer=join(f.root,'peer');git(f.root,'clone',join(f.root,'remote.git'),peer);git(peer,'checkout','main');
 await writeFile(join(peer,'from-remote.txt'),'remote change\n');git(peer,'add','from-remote.txt');git(peer,...identity,'commit','-m','remote update');git(peer,'push','origin','main');
 const remoteHead=git(peer,'rev-parse','HEAD');
 const fetched=await f.run(`git -C ${quotePowerShell(f.workspace)} fetch origin; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git rev-parse origin/main; exit $LASTEXITCODE`);
 assert.ok(fetched.stdout.includes(remoteHead),JSON.stringify(fetched));assert.ok((await readFile(join(f.workspace,'.git','FETCH_HEAD'),'utf8')).includes(remoteHead));
 const attempts=f.protectedFiles.map(file=>`try {[IO.File]::WriteAllText(${quotePowerShell(file)},'changed'); throw 'Unexpected writable path'} catch [System.UnauthorizedAccessException] {Write-Output BLOCKED}`).join('; ');
 const denied=await f.run(attempts+'; exit 0');assert.equal(denied.stdout.match(/BLOCKED/g)?.length,f.protectedFiles.length);
 for(const file of f.protectedFiles)assert.equal(await readFile(file,'utf8'),'unchanged',file);
});

test('real MXC terminal can initialize and commit a new project repository',{skip,timeout:60000},async t=>{
 const f=await fixture(t);
 await f.run("git init -b main; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git add .gitignore; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git -c user.name='Starport Git Test' -c user.email=git-test@example.invalid commit -m initial; exit $LASTEXITCODE");
 assert.equal(git(f.workspace,'log','-1','--format=%s'),'initial');
});

test('real MXC terminal does not grant write access through a .git junction outside the project',{skip,timeout:60000},async t=>{
 const f=await fixture(t),outside=join(f.root,'outside-repository');await mkdir(outside);git(outside,'init','-b','main');
 await symlink(join(outside,'.git'),join(f.workspace,'.git'),'junction');
 const result=await f.run("git add .gitignore; if($LASTEXITCODE -eq 0){throw 'External Git directory unexpectedly writable'}; exit 0");
 assert.match(result.stderr,/Permission denied|Access is denied/i);
 assert.throws(()=>git(outside,'rev-parse','--verify','HEAD'));
});

test('real MXC terminal does not make protected project settings writable through a .git junction',{skip,timeout:60000},async t=>{
 const f=await fixture(t);await symlink(join(f.workspace,'.codex'),join(f.workspace,'.git'),'junction');
 const result=await f.run(`try {[IO.File]::WriteAllText(${quotePowerShell(join(f.workspace,'.git','protected.txt'))},'changed'); throw 'Protected settings unexpectedly writable'} catch [System.UnauthorizedAccessException] {Write-Output BLOCKED}; exit 0`);
 assert.match(result.stdout,/BLOCKED/);assert.equal(await readFile(join(f.workspace,'.codex','protected.txt'),'utf8'),'unchanged');
});
