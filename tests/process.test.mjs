import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {stopProcess} from '../src/process.mjs';

const fixture=fileURLToPath(new URL('./fixtures/process-resident.mjs',import.meta.url));
async function resident(t,mode='leaf'){
  const child=spawn(process.execPath,[fixture,mode],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;});
  const [line]=await once(child.stdout,'data');return {child,closed,info:JSON.parse(String(line))};
}
function fakeProcess(killWorks){
  const child=new EventEmitter();Object.assign(child,{pid:123,exitCode:null,signalCode:null,kills:0,released:0});
  child.stdin=child.stdout=child.stderr={destroy:()=>child.released++};child.unref=()=>child.released++;
  child.kill=()=>{child.kills++;if(killWorks)queueMicrotask(()=>{child.signalCode='SIGKILL';child.emit('exit',null,'SIGKILL');});return killWorks;};return child;
}

test('Windows cleanup falls back from a hung helper and closes a real owned child',{timeout:4000},async t=>{
  const owned=await resident(t),helper=await resident(t);let calls=0;
  const started=Date.now();
  await stopProcess(owned.child,{platform:'win32',treeTimeoutMs:40,exitTimeoutMs:300,runFile:(command,args,options)=>{
    calls++;assert.equal(command,'taskkill.exe');assert.deepEqual(args,['/pid',String(owned.child.pid),'/t','/f']);
    assert.equal(options.timeout,40);assert.equal(options.windowsHide,true);
    // A sandbox helper that never calls back, even when given a timeout.
    return helper.child;
  }});
  await owned.closed;await helper.closed;
  assert.equal(calls,1);assert.ok(Date.now()-started<1500);assert.equal(owned.child.signalCode,'SIGKILL');
});

test('Windows cleanup tolerates a helper launch error and shares concurrent stop requests',{timeout:2000},async()=>{
  const child=fakeProcess(true);let calls=0;
  const options={platform:'win32',treeTimeoutMs:40,exitTimeoutMs:40,runFile:()=>{calls++;throw Error('sandbox denied');}};
  const first=stopProcess(child,options),second=stopProcess(child,options);assert.equal(first,second);await first;
  assert.equal(calls,1);assert.equal(child.kills,1);assert.equal(child.released,4);
  await stopProcess(child,options);assert.equal(calls,1);
});

test('an unkillable child reports a bounded cleanup failure instead of hanging or claiming success',{timeout:2000},async()=>{
  const child=fakeProcess(false),helper=fakeProcess(false),started=Date.now();
  await assert.rejects(stopProcess(child,{platform:'win32',treeTimeoutMs:30,exitTimeoutMs:30,runFile:()=>helper}),error=>error.code==='PROCESS_STOP_TIMEOUT'&&error.pid===child.pid);
  assert.ok(Date.now()-started<1000);assert.equal(child.kills,1);assert.equal(helper.kills,1);
  assert.equal(child.released,4);assert.equal(helper.released,4);assert.equal(child.listenerCount('exit'),0);
});

test('a successful helper does not leave cleanup waiting on a missing close event',{timeout:2000},async()=>{
  const child=fakeProcess(false);let calls=0;
  await stopProcess(child,{platform:'win32',treeTimeoutMs:40,exitTimeoutMs:40,runFile:(_command,_args,_options,callback)=>{
    calls++;queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);callback(null);});return fakeProcess(true);
  }});
  assert.equal(calls,1);assert.equal(child.kills,0);assert.equal(child.released,4);
});

test('ordinary Windows cleanup terminates the owned process tree',{skip:process.platform!=='win32',timeout:7000},async t=>{
  const {child,closed,info}=await resident(t,'tree');
  t.after(()=>{try{process.kill(info.childPid,'SIGKILL');}catch{}});
  await stopProcess(child);await closed;
  assert.throws(()=>process.kill(info.childPid,0),error=>error.code==='ESRCH');
});
