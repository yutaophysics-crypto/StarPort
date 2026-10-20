'use strict';
globalThis.StarportMemorySync=(()=>{
  Object.assign(i18n.english,{
    '跨电脑同步':'Device sync','你的记忆，随你换一台电脑。':'Your memory, on every computer.',
    '两台电脑各选同一个网盘或同步文件夹。文件传输由你已有的同步工具完成。':'Choose the same cloud or shared folder on each computer. Your existing sync app transfers the files.',
    '同步目录':'Sync folder','选择同步文件夹':'Choose a sync folder','选择你已有的同步文件夹':'Choose an existing synced folder',
    '星港会在所选目录内创建 StarportMemory 子文件夹。':'Starport creates a StarportMemory subfolder in the selected folder.',
    '共同记忆、候选、用户画像、已保存的个人偏好与项目要求会同步；候选仍须确认。':'Shared memories, candidates, your profile, saved preferences and project requirements are synced. Candidates still need confirmation.',
    '同步文件包含记忆正文和修改历史。请选择仅你自己能访问的目录；聊天全文、附件、登录凭据和本机工作路径不包含在其中。':'Sync files contain memory text and its change history. Use a private folder. Chat transcripts, attachments, login credentials and local work paths are excluded.',
    '不需要注册星港账号或填写厂商密码。':'No Starport account or provider password is needed.',
    '开启同步':'Enable sync','连接此文件夹':'Connect this folder','立即同步':'Sync now','停用同步':'Disable sync',
    '已停用；本地记忆和同步文件均保留。':'Disabled. Local memory and sync files are retained.',
    '同步尚未开启':'Sync is off','已连接同步文件夹':'Connected to the sync folder','正在同步…':'Syncing…',
    '其他电脑收到的时间取决于网盘或同步工具的传输进度。':'Delivery to other computers depends on your cloud or file sync app.',
    '本机设备':'This device','最近本机检查':'Last local check','尚未检查':'Not checked yet','待写入变更':'Changes waiting to be written',
    '等待同步文件':'Waiting for sync files','记忆冲突':'Memory conflicts','暂无冲突':'No conflicts',
    '同时修改的版本会保留在这里；解决之前，冲突内容暂停提供给助手。':'Concurrent versions are kept here. Conflicting content is withheld from assistants until you resolve it.',
    '选择保留版本':'Choose a version','确认保留这个版本':'Confirm this version','确认删除这条记忆':'Confirm deletion of this memory',
    '此版本已删除这条记忆。':'This version deletes the memory.','来自 {device}':'From {device}',
    '不同电脑同时修改了这项内容，请选择保留版本':'Different computers edited this item. Choose a version to keep.',
    '等待完整的同步变更':'Waiting for complete sync changes',
    '同步文件夹暂时无法访问，保留本地内容并稍后重试':'The sync folder is temporarily unavailable. Local content is retained and will be retried.',
    '同步空间标识已改变，暂停同步；请核对文件夹后重新连接':'The sync space identity changed. Sync is paused; check the folder and reconnect.',
    '请选择星港数据库目录以外的同步文件夹':'Choose a sync folder outside Starport’s database directory.',
    '同步空间标识无法读取，请等待目录同步完成':'The sync space identity is not ready. Wait for the folder to finish syncing.',
    '这不是有效的星港记忆同步空间':'This is not a valid Starport memory sync space.',
    '冲突已改变，请刷新后重新选择':'The conflict changed. Refresh and choose again.',
    '另一条本地记忆已有相同内容，请核对后修改或删除重复条目':'Another local memory has the same content. Review and edit or remove the duplicate.',
    '等待项目记忆同步':'Waiting for project memory sync','请先开启记忆同步':'Enable memory sync first.',
    '请选择一个现有版本':'Choose an existing version.','同步变更文件已改变，未覆盖原文件':'A sync change file was altered. The original was not overwritten.',
    '同步子目录不能是符号链接':'The sync subfolder cannot be a symbolic link.','同步变更目录不能是符号链接':'The sync changes directory cannot be a symbolic link.',
    '同步变更过多，请先备份并整理同步空间':'There are too many sync changes. Back up and reorganize the space first.',
    '重新检查':'Check again'
  });
  const dialog=el('dialog',{id:'memory-sync-dialog',class:'memory-dialog memory-sync-dialog','aria-labelledby':'memory-sync-heading'});
  document.body.append(dialog);let snapshot=null,busy=false,lastEpoch,conflictSignature='',sequence=0;
  const tr=(tag,label,attrs={})=>el(tag,{...attrs,text:t(label),'data-i18n':label});
  const field=(label,input)=>el('label',{class:'memory-field'},[tr('span',label),input]);
  function mount(root){const nav=root.querySelector('.context-nav');if(!nav||nav.querySelector('#context-sync'))return;
    const button=tr('button','跨电脑同步',{type:'button',id:'context-sync'});button.onclick=()=>open();nav.append(button);}
  function build(){
    const close=tr('button','关闭',{type:'button',class:'secondary-button'});close.onclick=()=>dialog.close();
    const path=el('input',{id:'memory-sync-folder',type:'text',maxlength:'2000',placeholder:t('选择你已有的同步文件夹'),'aria-label':t('同步目录')});
    const browse=tr('button','浏览…',{type:'button',class:'secondary-button'});browse.onclick=()=>openFolderPicker(path.value,value=>{path.value=value;},'选择同步文件夹',{projects:false});
    const enable=tr('button','开启同步',{id:'memory-sync-enable',type:'submit',class:'memory-confirm'});
    const sync=tr('button','立即同步',{id:'memory-sync-run',type:'button',class:'secondary-button'});sync.onclick=()=>act(()=>api('/memory-sync/run','POST',{}));
    const disable=tr('button','停用同步',{id:'memory-sync-disable',type:'button',class:'secondary-button'});disable.onclick=()=>act(()=>api('/memory-sync','PATCH',{enabled:false}));
    const form=el('form',{class:'memory-sync-form'},[
      field('同步目录',el('div',{class:'memory-sync-path'},[path,browse])),tr('p','星港会在所选目录内创建 StarportMemory 子文件夹。',{class:'muted'}),
      el('div',{class:'memory-actions'},[enable,sync,disable])]);form.onsubmit=event=>{event.preventDefault();act(()=>api('/memory-sync','PATCH',{enabled:true,folder:path.value}),true);};
    dialog.replaceChildren(el('div',{class:'dialog-heading'},[el('div',{},[el('p',{class:'eyebrow',text:'STARPORT / SYNC'}),tr('h2','跨电脑同步',{id:'memory-sync-heading'}),tr('p','你的记忆，随你换一台电脑。',{class:'memory-intro'})]),close]),
      el('section',{class:'memory-sync-body'},[
        tr('p','两台电脑各选同一个网盘或同步文件夹。文件传输由你已有的同步工具完成。',{class:'memory-sync-lead'}),
        tr('p','不需要注册星港账号或填写厂商密码。',{class:'muted'}),form,
        el('section',{class:'memory-sync-state','aria-live':'polite'},[el('strong',{id:'memory-sync-status'}),el('p',{id:'memory-sync-error',class:'memory-error',role:'alert'}),el('dl',{id:'memory-sync-details'})]),
        tr('p','其他电脑收到的时间取决于网盘或同步工具的传输进度。',{class:'muted'}),
        tr('p','共同记忆、候选、用户画像、已保存的个人偏好与项目要求会同步；候选仍须确认。',{class:'memory-sync-scope'}),
        tr('p','同步文件包含记忆正文和修改历史。请选择仅你自己能访问的目录；聊天全文、附件、登录凭据和本机工作路径不包含在其中。',{class:'muted'}),
        el('section',{id:'memory-sync-conflicts'})]));
    dialog.onclose=()=>{sequence++;};
  }
  function conflicts(){
    const root=$('#memory-sync-conflicts'),items=snapshot?.conflicts||[],signature=JSON.stringify(items);
    if(signature===conflictSignature&&root.childElementCount)return;conflictSignature=signature;
    root.replaceChildren(tr('h3','记忆冲突'),tr('p',items.length?'同时修改的版本会保留在这里；解决之前，冲突内容暂停提供给助手。':'暂无冲突',{class:'muted'}));
    for(const item of items){
      const title=item.versions.find(version=>version.value?.title||version.value?.name)?.value;
      const name=title?.title||title?.name||(item.key==='instructions:global'?t('个人偏好'):t('项目要求'));
      const legend=el('legend',{text:name}),select=tr('button','确认保留这个版本',{type:'submit',class:'memory-confirm',disabled:true});
      const group=el('fieldset',{class:'memory-sync-conflict'},[legend,el('p',{class:'memory-error',text:notice(item.issue)})]);let selected=null;
      for(const version of item.versions){
        const radio=el('input',{type:'radio',name:'version',value:version.id,'aria-label':t('来自 {device}',{device:version.deviceName})});
        radio.onchange=()=>{selected=version;select.disabled=busy;select.textContent=t(version.value===null?'确认删除这条记忆':'确认保留这个版本');};
        const status=version.value?.status?el('span',{class:'memory-sync-version-status',text:t(version.value.status==='confirmed'?'已确认':'候选记忆')}):null;
        group.append(el('label',{class:'memory-sync-version'},[
          el('span',{class:'memory-sync-version-heading'},[radio,el('strong',{text:t('来自 {device}',{device:version.deviceName})}),...(status?[status]:[])]),
          el('small',{text:new Date(version.created).toLocaleString(i18n.locale)}),
          el('pre',{text:version.value===null?t('此版本已删除这条记忆。'):version.value.content||version.value.name||''})]));
      }
      group.append(select);const form=el('form',{class:'memory-sync-conflict-form'},[group]);
      form.onsubmit=event=>{event.preventDefault();if(selected)act(()=>api('/memory-sync/resolve','POST',{key:item.key,version:selected.id,heads:item.versions.map(version=>version.id)}));};root.append(form);
    }
  }
  function render(){
    if(!dialog.childElementCount)return;const enabled=!!snapshot?.enabled;
    $('#memory-sync-status').textContent=t(busy?'正在同步…':enabled?'已连接同步文件夹':'同步尚未开启');
    $('#memory-sync-error').textContent=notice(snapshot?.error||'');
    const enable=$('#memory-sync-enable');enable.textContent=t(enabled?'连接此文件夹':'开启同步');enable.disabled=busy;
    $('#memory-sync-run').disabled=busy||!enabled;$('#memory-sync-disable').hidden=!enabled;$('#memory-sync-disable').disabled=busy;
    $('#memory-sync-folder').disabled=busy;dialog.querySelector('.memory-sync-path button').disabled=busy;
    for(const button of dialog.querySelectorAll('.memory-sync-conflict button'))button.disabled=busy||!button.closest('fieldset').querySelector('input:checked');
    const details=$('#memory-sync-details');details.replaceChildren();
    for(const [label,value]of [['本机设备',snapshot?.deviceName||'—'],['最近本机检查',snapshot?.lastRun?new Date(snapshot.lastRun).toLocaleString(i18n.locale):t('尚未检查')],['待写入变更',snapshot?.pending||0],['等待同步文件',snapshot?.waiting||0]])details.append(tr('dt',label),el('dd',{text:String(value)}));
    conflicts();
  }
  function receive(data){
    snapshot=data;if(dialog.open)render();if(lastEpoch!==undefined&&lastEpoch!==data.epoch)refresh().catch(()=>{});lastEpoch=data.epoch;
  }
  async function act(action,updatePath=false){
    if(busy)return;busy=true;render();try{const data=await action();receive(data);if(updatePath)$('#memory-sync-folder').value=data.folder||'';}
    catch(error){if(snapshot)snapshot={...snapshot,error:error.message};else snapshot={enabled:false,error:error.message};try{const data=await api('/memory-sync');snapshot={...data,error:error.message};}catch{}}
    finally{busy=false;render();}
  }
  async function open(){
    if(!dialog.childElementCount)build();$('#memory-dialog').close();$('#shared-context-dialog')?.close();if(!dialog.open)dialog.showModal();
    const current=++sequence;busy=true;render();try{const data=await api('/memory-sync');if(current!==sequence)return;receive(data);$('#memory-sync-folder').value=data.folder||'';}
    catch(error){if(current===sequence)snapshot={enabled:false,error:error.message};}finally{if(current===sequence){busy=false;render();dialog.querySelector('.memory-sync-body').scrollTop=0;}}
  }
  function translate(){
    for(const node of document.querySelectorAll('#context-sync,[data-i18n]'))if(dialog.contains(node)||node.id==='context-sync')node.textContent=t(node.dataset.i18n);
    const path=$('#memory-sync-folder');if(path){path.placeholder=t('选择你已有的同步文件夹');path.setAttribute('aria-label',t('同步目录'));}
    conflictSignature='';render();
  }
  return {mount,open,receive,translate};
})();
