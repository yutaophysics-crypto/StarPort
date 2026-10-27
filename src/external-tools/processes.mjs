// Process plumbing shared by the sandbox terminal, one-shot host runs and
// persistent applications.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, stopProcess, redact } from '../process.mjs';

const LAUNCHER=fileURLToPath(new URL('../../scripts/run-external-application.ps1',import.meta.url));
const OUTPUT_LIMIT=128*1024;
const SECRET=/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i;

// Programs started for the model never inherit Starport's credentials.
export function externalEnvironment(){
  const env=childEnvironment();
  for(const key of Object.keys(env))if(SECRET.test(key))delete env[key];
  return env;
}
export const windowsPowerShell=()=>join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');

// Starts the fixed launcher, which owns the program tree in a Windows Job. The
// specification is sent as JSON data on stdin; it is never evaluated as code.
export function spawnLauncher(spec,options){
  const child=spawn(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',LAUNCHER],
    {env:externalEnvironment(),windowsHide:true,shell:false,...options});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(spec));
  return child;
}

// Waits for the child with bounded, redacted output. Timeout or cancellation
// stops the whole process tree; exitCode is then null.
export async function collectOutput(child,{timeoutMs,signal}){
  let stdout='',stderr='',timedOut=false,canceled=false,outputTruncated=false,stopError='',stopped;
  const append=(text,chunk)=>{if(text.length+chunk.length>OUTPUT_LIMIT)outputTruncated=true;return (text+chunk).slice(0,OUTPUT_LIMIT);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>stdout=append(stdout,chunk));child.stderr.on('data',chunk=>stderr=append(stderr,chunk));
  const stopDone=new Promise(resolve=>stopped=resolve);
  const stop=()=>stopProcess(child).catch(error=>{stopError=error.message;}).finally(()=>stopped(null));
  const cancel=()=>{canceled=true;void stop();};
  signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;void stop();},timeoutMs);
  try{
    const exitCode=await Promise.race([stopDone,new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);if(signal?.aborted)cancel();})]);
    return {exitCode,stdout:redact(stdout),stderr:redact(stderr),timedOut,canceled,outputTruncated,...stopError?{stopError}:{}};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
