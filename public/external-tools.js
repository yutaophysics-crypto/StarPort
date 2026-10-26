'use strict';
globalThis.StarportExternalTools = (() => {
  const panel=document.getElementById('external-tools-panel'),dialog=document.getElementById('external-tools-dialog'),button=document.getElementById('workspace-tools-button');
  let request=0,selected=null;
  const text=(tag,label,attrs={})=>el(tag,{...attrs,text:t(label),'data-i18n':label});
  function sync(){
    const project=currentProject(),workspace=state.chat?.workspace||state.workspace;
    button.disabled=!workspace;
    button.title=workspace?t('外部开发工具：{project}',{project:project?.name||workspace}):t('请先选择项目文件夹');
    if(dialog.open&&(project?.id!==selected?.id||folderKey(project?.workspace||'')!==folderKey(selected?.workspace||'')))dialog.close();
  }
  async function open(){
    const workspace=state.chat?.workspace||state.workspace,version=++request;
    let project=currentProject();
    if(!workspace){toast('请先选择项目文件夹');return;}
    // A draft folder becomes a project before its first message, too.
    if(!project){
      button.disabled=true;
      try{
        project=await api('/projects','POST',{workspace});
        if(version!==request||folderKey(workspace)!==folderKey(state.chat?.workspace||state.workspace))return;
        state.projects=[...(state.projects||[]).filter(p=>p.id!==project.id),project];
      }catch(error){toast(error.message);return;}finally{sync();}
    }
    selected={...project};
    if(!dialog.open)dialog.showModal();
    button.setAttribute('aria-expanded','true');
    render();
  }
  button.onclick=open;
  for(const id of ['external-tools-close','external-tools-done'])document.getElementById(id).onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{request++;button.setAttribute('aria-expanded','false');});
  function commonTools(data,path,disabled,version,status){
    const rows=data.catalog,section=el('details',{class:'common-tools',id:'external-common-tools'},[
      el('summary',{},[text('span','常用工具'),' ',el('small',{text:Array.isArray(rows)?String(rows.length):'…'})])
    ]);
    if(!Array.isArray(rows)){section.append(text('p','后台更新后可查看常用工具。',{class:'settings-note'}));return section;}
    section.open=!data.tools.length&&!!rows.length;
    if(!rows.length){section.append(text('p','添加工具后会自动保存在这里，其他项目也可以选用。',{class:'settings-note'}));return section;}
    section.append(text('p','选择后仅授权给当前项目。',{class:'settings-note'}));
    const list=el('div',{class:'common-tools-list',role:'list'});section.append(list);
    for(const tool of rows){
      const added=data.tools.some(current=>folderKey(current.canonical)===folderKey(tool.canonical));
      const use=text('button',added?'已添加':'添加到当前项目',{type:'button',class:'secondary-button',disabled:disabled||added||!!tool.error});
      use.onclick=async()=>{
        use.disabled=true;
        try{await api(path,'POST',{catalogId:tool.id});if(version===request)render();}
        catch(error){if(version===request){status.textContent=error.message;use.disabled=disabled||added||!!tool.error;}}
      };
      const item=el('div',{class:'common-tool',role:'listitem'},[
        el('div',{class:'common-tool-heading'},[el('strong',{text:tool.name}),use]),
        el('code',{text:tool.canonical}),
        ...tool.executable?[el('code',{text:tool.executable})]:[],
        ...tool.error?[el('p',{class:'common-tools-error',text:t(tool.error)})]:[]
      ]);
      list.append(item);
    }
    return section;
  }
  async function render(){
    const version=++request;
    const project=selected;
    if(!project)return;
    const reload=text('button','刷新项目状态',{type:'button',class:'secondary-button'});reload.onclick=render;
    panel.replaceChildren(el('div',{class:'external-tools-toolbar'},[el('div',{class:'external-tools-scope'},[el('h3',{text:project.name}),el('code',{text:project.workspace})]),reload]),text('p','仅为当前项目授权。工具安装目录只读，缓存和构建输出写入项目。',{class:'settings-note'}));
    const status=el('p',{id:'external-tools-status',role:'status',class:'settings-note'}),list=el('div',{class:'external-tools-list'});panel.append(status,list);
    const path='/projects/'+project.id+'/external-tools';
    let data;
    try{data=await api(path);}catch(error){if(version!==request)return;status.textContent=/404|没有这个接口/.test(error.message)?t('后台待更新；所有任务结束并加载更新后，可以配置外部工具。'):error.message;return;}
    if(version!==request)return;
    status.textContent=data.busy?t('此项目有任务在运行，结束后可以修改或验证授权。'):data.supported?t('更改从下一轮任务生效。'):t(data.reason);
    const disabled=data.busy||!data.supported;
    for(const tool of data.tools){
      const verify=text('button','验证访问',{type:'button',class:'secondary-button',disabled}),remove=text('button','移除授权',{type:'button',class:'secondary-button',disabled});
      const result=el('div',{role:'status',text:tool.error?t(tool.error):''});result.hidden=!tool.error;
      verify.onclick=async()=>{verify.disabled=true;remove.disabled=true;result.hidden=false;result.textContent=t('正在隔离终端中验证读取…');try{const proof=await api(path+'/'+tool.id+'/verify','POST',{});if(version!==request)return;result.replaceChildren(text('p',proof.ok?'读取验证通过':'读取验证失败'),el('details',{},[text('summary','验证输出'),el('pre',{class:'external-tools-result',text:(proof.result.stdout||'')+(proof.result.stderr||'')})]));}catch(error){result.textContent=error.message;}finally{verify.disabled=disabled;remove.disabled=disabled;}};
      remove.onclick=async()=>{remove.disabled=true;try{await api(path+'/'+tool.id,'DELETE');if(version===request)render();}catch(error){status.textContent=error.message;remove.disabled=disabled;}};
      list.append(el('article',{class:'external-tool'},[el('div',{class:'external-tool-heading'},[el('strong',{text:tool.name}),text('small','只读 · 可运行')]),el('code',{text:tool.canonical}),...tool.executable?[el('code',{text:tool.executable})]:[],el('div',{class:'external-tool-actions'},[verify,remove]),result]));
    }
    if(!data.tools.length)list.append(text('p','此项目尚未授权外部工具。',{class:'settings-note'}));
    const name=el('input',{id:'external-tool-name',required:'',maxlength:'80',placeholder:t('例如：Cocos Creator')}),directory=el('input',{id:'external-tool-directory',required:'','aria-label':t('安装文件夹'),placeholder:t('工具安装文件夹的完整路径')}),executable=el('input',{id:'external-tool-executable',placeholder:t('可选：程序完整路径')}),browse=text('button','选择文件夹',{type:'button',class:'secondary-button',disabled}),save=text('button','添加工具',{type:'submit',class:'primary-button',disabled});
    browse.onclick=()=>openFolderPicker(directory.value||state.workspace||state.defaultWorkspace,path=>directory.value=path,'选择工具安装文件夹',{projects:false});
    const field=(label,input)=>el('label',{class:'external-tools-field'},[text('span',label),input]);
    const form=el('form',{class:'external-tools-form'},[field('工具名称',name),field('安装文件夹',el('div',{class:'external-tools-path'},[directory,browse])),field('程序路径',executable),text('p','验证访问只读取安装目录和程序信息；不会启动构建。',{class:'settings-note'}),save]);
    form.prepend(text('h3','手动添加工具'));
    for(const input of [name,directory,executable])input.disabled=disabled;
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api(path,'POST',{name:name.value,directory:directory.value,executable:executable.value});if(version===request)render();}catch(error){status.textContent=error.message;save.disabled=disabled;}};
    panel.append(commonTools(data,path,disabled,version,status),form,text('p','目前接入 Windows 上的 Claude Code 隔离终端；其他工具仍遵循各自的原生权限配置。',{class:'settings-note'}));
  }
  sync();
  return {open,sync};
})();
