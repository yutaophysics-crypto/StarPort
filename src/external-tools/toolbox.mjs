import {existsSync,readdirSync,realpathSync} from 'node:fs';
import {join,dirname,basename,delimiter} from 'node:path';
import {homedir} from 'node:os';

const directories=path=>{try{return readdirSync(path,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>join(path,item.name)).sort().reverse();}catch{return [];}};
const texInstallation=exe=>{
  let path=dirname(exe);for(let i=0;i<5;i++){if(basename(path).toLowerCase()==='texlive')return path;path=dirname(path);}
  return dirname(dirname(dirname(exe)));
};
export function detectToolbox({env=process.env,home=homedir()}={}){
  if(process.platform!=='win32')return [];
  const paths=(env.PATH||env.Path||'').split(delimiter).filter(path=>path&&!/WindowsApps/i.test(path));
  const programFiles=env.ProgramFiles||'C:\\Program Files',local=env.LOCALAPPDATA||join(home,'AppData','Local');
  const texRoots=directories('C:\\texlive').concat(directories('D:\\texlive'));
  const pythonRoots=directories(join(local,'Programs','Python'));
  const definitions=[
    ...['xelatex','pdflatex','lualatex','latexmk','kpsewhich'].map(command=>({command,name:command==='latexmk'?'LaTeX 自动构建 · latexmk':`LaTeX · ${command}`,fallbacks:texRoots.map(root=>join(root,'bin','windows')),root:texInstallation})),
    {command:'git',name:'Git',fallbacks:[join(programFiles,'Git','cmd'),join(local,'Programs','Git','cmd')],root:exe=>/^(cmd|bin)$/i.test(basename(dirname(exe)))?dirname(dirname(exe)):dirname(exe)},
    {command:'python',name:'Python',fallbacks:pythonRoots,root:dirname}
  ];
  return definitions.flatMap(def=>{
    for(const path of [...paths,...def.fallbacks]){
      const executable=join(path,def.command+'.exe');if(!existsSync(executable))continue;
      const canonical=realpathSync.native(executable);return [{name:def.name,command:def.command,directory:def.root(canonical),executable:canonical}];
    }
    return [];
  });
}

// Installation roots make resources readable; executable folders make commands
// discoverable even when Starport was started before an installer changed PATH.
export function toolboxEnvironment(snapshot,workspace,env){
  const tools=snapshot.tools||[],bins=[...new Set(tools.filter(item=>item.scope==='global').map(item=>dirname(item.canonicalExecutable)))];
  const pathKey=Object.keys(env).find(key=>key.toUpperCase()==='PATH')||'PATH';
  return {...env,[pathKey]:[...bins,env[pathKey]||''].join(delimiter)};
}
