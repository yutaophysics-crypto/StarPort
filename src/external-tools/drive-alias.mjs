import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const subst=join(process.env.SystemRoot||'C:\\Windows','System32','subst.exe');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const query=()=>execFileSync(subst,[],{encoding:'utf8',windowsHide:true});
function matches(drive,workspace){return query().split(/\r?\n/).some(line=>line.trim().toLowerCase()===`${drive}\\: => ${workspace}`.toLowerCase());}

// The alias changes only cwd spelling. MXC grants remain on the physical
// project. A lease prevents our concurrent commands from sharing a drive.
export function projectDrive(workspace,directory){
 mkdirSync(directory,{recursive:true});
 // A force-terminated runner cannot run finally. Reclaim only our own dead
 // leases whose current mapping still matches, never another application's drive.
 for(const letter of 'ZYXWVUTSRQPONMLKJIHG'){
  const file=join(directory,letter+'.json');
  try{const old=JSON.parse(readFileSync(file,'utf8'));if(alive(old.pid)||old.drive!==letter+':')continue;
   if(typeof old.workspace==='string'&&matches(old.drive,old.workspace))execFileSync(subst,[old.drive,'/D'],{windowsHide:true});
   unlinkSync(file);
  }catch{}
 }
 for(const letter of 'ZYXWVUTSRQPONMLKJIHG'){
  const drive=letter+':',file=join(directory,letter+'.json');let handle;
  try{handle=openSync(file,'wx');}catch(error){
   if(error.code!=='EEXIST')throw error;
   try{const old=JSON.parse(readFileSync(file,'utf8'));if(alive(old.pid))continue;
    if(old.drive===drive&&typeof old.workspace==='string'&&matches(drive,old.workspace))execFileSync(subst,[drive,'/D'],{windowsHide:true});
    unlinkSync(file);
   }catch{continue;}
   try{handle=openSync(file,'wx');}catch{continue;}
  }
  const owner={pid:process.pid,id:randomUUID(),drive,workspace};writeFileSync(handle,JSON.stringify(owner));closeSync(handle);
  let created=false;
  const release=()=>{
   try{const current=JSON.parse(readFileSync(file,'utf8'));if(current.id!==owner.id)return;
    if(created&&matches(drive,workspace))execFileSync(subst,[drive,'/D'],{windowsHide:true});
    unlinkSync(file);
   }catch{}
  };
  if(existsSync(drive+'\\')){release();continue;}
  try{execFileSync(subst,[drive,workspace],{windowsHide:true});created=true;
   if(!matches(drive,workspace))throw Error('Project drive identity mismatch');
   return {root:drive+'\\',release};
  }catch(error){release();throw error;}
 }
 throw Error('No free project drive; refusing an unrestricted filesystem fallback.');
}
