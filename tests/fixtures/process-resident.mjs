import {spawn} from 'node:child_process';
const child=process.argv[2]==='tree'?spawn(process.execPath,[import.meta.filename,'leaf'],{stdio:'ignore',windowsHide:true}):null;
console.log(JSON.stringify({pid:process.pid,childPid:child?.pid}));
setInterval(()=>{},1000);
