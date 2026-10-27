'use strict';
globalThis.StarportExternalTools = (() => {
  const panel=document.getElementById('external-tools-panel'),dialog=document.getElementById('external-tools-dialog'),button=document.getElementById('workspace-tools-button');
  const LIVE=['running','starting','unknown'];
  let request=0,selected=null;
  const text=(tag,label,attrs={})=>el(tag,{...attrs,text:t(label),'data-i18n':label});
  const note=label=>text('p',label,{class:'settings-note'});
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

  // Each piece below receives the view of one render pass. current() turns
  // false once a newer render starts, so late callbacks do not redraw it.
  function toolCard(tool,{path,disabled,status,current,refresh}){
    const verify=text('button','验证访问',{type:'button',class:'secondary-button',disabled}),remove=text('button','移除授权',{type:'button',class:'secondary-button',disabled});
    const permission=el('select',{'aria-label':t('本机运行授权'),disabled:disabled||!/\.exe$/i.test(tool.canonicalExecutable||'')},[
      text('option','每次询问',{value:'ask'}),text('option','此项目始终允许',{value:'always'})]);
    permission.value=tool.hostApproval==='always'?'always':'ask';
    permission.onchange=async()=>{permission.disabled=true;try{await api(path+'/'+tool.id,'PATCH',{hostApproval:permission.value});refresh();}catch(error){status.textContent=error.message;permission.value=tool.hostApproval||'ask';permission.disabled=disabled;}};
    const result=el('div',{role:'status',text:tool.error?t(tool.error):''});result.hidden=!tool.error;
    verify.onclick=async()=>{
      verify.disabled=true;remove.disabled=true;result.hidden=false;result.textContent=t('正在隔离终端中验证读取…');
      try{
        const proof=await api(path+'/'+tool.id+'/verify','POST',{});if(!current())return;
        result.replaceChildren(text('p',proof.ok?'读取验证通过':'读取验证失败'),el('details',{},[text('summary','验证输出'),el('pre',{class:'external-tools-result',text:(proof.result.stdout||'')+(proof.result.stderr||'')})]));
      }catch(error){result.textContent=error.message;}finally{verify.disabled=disabled;remove.disabled=disabled;}
    };
    remove.onclick=async()=>{remove.disabled=true;try{await api(path+'/'+tool.id,'DELETE');refresh();}catch(error){status.textContent=error.message;remove.disabled=disabled;}};
    return el('article',{class:'external-tool'},[
      el('div',{class:'external-tool-heading'},[el('strong',{text:tool.name}),text('small','隔离访问')]),
      el('code',{text:tool.canonical}),...tool.executable?[el('code',{text:tool.executable})]:[],
      el('label',{class:'external-tools-field'},[text('span','本机运行授权'),permission]),
      note('本机运行使用当前 Windows 用户权限，可访问项目外文件及网络。始终允许仅对本项目的此程序生效，可随时改回询问。'),
      el('div',{class:'external-tool-actions'},[verify,remove]),result]);
  }
  function applicationsSection(applications,{project,status,refresh}){
    const live=applications.filter(item=>LIVE.includes(item.state));
    if(!live.length)return [];
    const section=el('section',{class:'external-applications'},[text('h3','常驻程序'),note('任务结束或重启星港后仍保持运行。关闭前请保存编辑器中的修改。')]);
    for(const item of live){
      const close=text('button','关闭程序',{type:'button',class:'secondary-button'});
      close.onclick=async()=>{close.disabled=true;try{await api('/projects/'+project.id+'/external-applications/'+item.id+'/stop','POST',{});refresh();}catch(error){status.textContent=error.message;close.disabled=false;}};
      const label=item.state==='running'?'正在运行':item.state==='starting'?'正在启动':'状态待确认';
      section.append(el('article',{class:'external-tool'},[el('div',{class:'external-tool-heading'},[el('strong',{text:item.tool}),text('small',label)]),el('code',{text:item.cwd}),close]));
    }
    return [section];
  }
  function commonTools(data,{path,disabled,status,current,refresh}){
    const rows=data.catalog,section=el('details',{class:'common-tools',id:'external-common-tools'},[
      el('summary',{},[text('span','常用工具'),' ',el('small',{text:Array.isArray(rows)?String(rows.length):'…'})])
    ]);
    if(!Array.isArray(rows)){section.append(note('后台更新后可查看常用工具。'));return section;}
    section.open=!data.tools.length&&!!rows.length;
    if(!rows.length){section.append(note('添加工具后会自动保存在这里，其他项目也可以选用。'));return section;}
    section.append(note('选择后仅授权给当前项目。'));
    const list=el('div',{class:'common-tools-list',role:'list'});section.append(list);
    for(const tool of rows){
      const added=data.tools.some(item=>folderKey(item.canonical)===folderKey(tool.canonical));
      const use=text('button',added?'已添加':'添加到当前项目',{type:'button',class:'secondary-button',disabled:disabled||added||!!tool.error});
      use.onclick=async()=>{
        use.disabled=true;
        try{await api(path,'POST',{catalogId:tool.id});refresh();}
        catch(error){if(current()){status.textContent=error.message;use.disabled=disabled||added||!!tool.error;}}
      };
      list.append(el('div',{class:'common-tool',role:'listitem'},[
        el('div',{class:'common-tool-heading'},[el('strong',{text:tool.name}),use]),
        el('code',{text:tool.canonical}),
        ...tool.executable?[el('code',{text:tool.executable})]:[],
        ...tool.error?[el('p',{class:'common-tools-error',text:t(tool.error)})]:[]
      ]));
    }
    return section;
  }
  function addForm({path,disabled,status,refresh}){
    const name=el('input',{id:'external-tool-name',required:'',maxlength:'80',placeholder:t('例如：Cocos Creator')}),directory=el('input',{id:'external-tool-directory',required:'','aria-label':t('安装文件夹'),placeholder:t('工具安装文件夹的完整路径')}),executable=el('input',{id:'external-tool-executable',placeholder:t('可选：程序完整路径')});
    const browse=text('button','选择文件夹',{type:'button',class:'secondary-button',disabled}),save=text('button','添加工具',{type:'submit',class:'primary-button',disabled});
    browse.onclick=()=>openFolderPicker(directory.value||state.workspace||state.defaultWorkspace,folder=>directory.value=folder,'选择工具安装文件夹',{projects:false});
    for(const input of [name,directory,executable])input.disabled=disabled;
    const field=(label,input)=>el('label',{class:'external-tools-field'},[text('span',label),input]);
    const form=el('form',{class:'external-tools-form'},[text('h3','手动添加工具'),field('工具名称',name),field('安装文件夹',el('div',{class:'external-tools-path'},[directory,browse])),field('程序路径',executable),note('验证访问只读取安装目录和程序信息；不会启动构建。'),save]);
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api(path,'POST',{name:name.value,directory:directory.value,executable:executable.value});refresh();}catch(error){status.textContent=error.message;save.disabled=disabled;}};
    return form;
  }
  async function render(){
    const version=++request,project=selected;
    if(!project)return;
    const reload=text('button','刷新项目状态',{type:'button',class:'secondary-button'});reload.onclick=render;
    const status=el('p',{id:'external-tools-status',role:'status',class:'settings-note'}),list=el('div',{class:'external-tools-list'});
    panel.replaceChildren(
      el('div',{class:'external-tools-toolbar'},[el('div',{class:'external-tools-scope'},[el('h3',{text:project.name}),el('code',{text:project.workspace})]),reload]),
      note('隔离终端中，工具安装目录只读，缓存和构建输出写入项目。程序能否启动需另行验证。'),status,list);
    const path='/projects/'+project.id+'/external-tools',current=()=>version===request;
    let data;
    try{data=await api(path);}catch(error){if(!current())return;status.textContent=/404|没有这个接口/.test(error.message)?t('后台待更新；所有任务结束并加载更新后，可以配置外部工具。'):error.message;return;}
    if(!current())return;
    status.textContent=data.busy?t('此项目有任务在运行，结束后可以修改或验证授权。'):data.supported?t('更改从下一轮任务生效。'):t(data.reason);
    const view={project,path,status,disabled:data.busy||!data.supported,current,refresh:()=>{if(current())render();}};
    list.append(...data.tools.map(tool=>toolCard(tool,view)));
    if(!data.tools.length)list.append(note('此项目尚未授权外部工具。'));
    panel.append(...applicationsSection(data.applications||[],view),
      note('让 Claude 保持编辑器打开时，它会使用常驻运行；可在这里查看和关闭。'),commonTools(data,view),addForm(view),
      note('目前接入 Windows 上的 Claude Code 隔离终端；其他工具仍遵循各自的原生权限配置。'));
  }
  sync();
  return {open,sync};
})();
