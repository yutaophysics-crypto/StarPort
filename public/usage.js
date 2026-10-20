'use strict';
globalThis.StarportUsage=(()=>{
  const dialog=$('#usage-dialog');let selected=null,result=null,busy=false,revision=0,error=null;
  const labels={rateLimits:'账号限额',rateLimitsByLimitId:'各模型限额',rateLimitResetCredits:'重置额度',availableCount:'可用数量',credits:'额外额度',
    hasCredits:'拥有额外额度',unlimited:'无限额',balance:'余额',planType:'套餐',primary:'主限额窗口',secondary:'次限额窗口',
    usedPercent:'已用百分比',remainingPercent:'剩余百分比',windowDurationMins:'窗口时长（分钟）',resetsAt:'重置时间',
    individualLimit:'个人支出限额',limit:'上限',used:'已用',ordinaryUsageAllowed:'允许使用套餐内额度',spendControlReached:'已达支出上限',
    rateLimitReachedType:'限额状态',limitName:'限额名称',limitId:'限额标识',normalModelSlug:'对应模型',
    rateLimitUpsell:'厂商限额提示',title:'标题',description:'说明',status:'状态',expiresAt:'到期时间',grantedAt:'发放时间',
    subscription_type:'套餐',rate_limits_available:'提供订阅限额',rate_limits:'订阅限额',five_hour:'5 小时限额',seven_day:'每周限额',
    seven_day_opus:'Opus · 每周限额',seven_day_sonnet:'Sonnet · 每周限额',seven_day_oauth_apps:'OAuth 应用 · 每周限额',
    utilization:'已用百分比',resets_at:'重置时间',model_scoped:'分模型限额',display_name:'名称',extra_usage:'额外用量',
    is_enabled:'已启用',monthly_limit:'月度上限（最小货币单位）',used_credits:'已用额度（最小货币单位）',currency:'货币',
    decimal_places:'小数位数',behaviors:'本机用量归因',daily:'过去 24 小时',weekly:'过去 7 天',
    skills:'技能',agents:'子代理',plugins:'插件',mcp_servers:'MCP 服务',name:'名称',pct:'占比（%）',count:'次数',
    limits:'原生限额条目',kind:'类型',group:'分组',percent:'已用百分比',severity:'状态',scope:'适用范围',is_active:'当前生效',
    spend:'用量额度支出',enabled:'已启用',disabled_reason:'不可用原因',cap:'支出限制',auto_reload:'自动充值设置',
    disclaimer:'厂商说明',amount_minor:'金额（最小货币单位）',exponent:'小数位数',user_disabled:'用户已停用',
    spend_limit_reached:'已达支出上限',credits_ever_enabled:'曾启用额外额度',is_available:'余额可用于调用',
    balance_infos:'余额明细',total_balance:'总余额',granted_balance:'赠送余额',topped_up_balance:'充值余额',
    limit_dollars:'金额上限（美元）',used_dollars:'已用金额（美元）',remaining_dollars:'剩余金额（美元）',locked_reason:'限制原因'};
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  function time(value){if(value==null)return t('厂商未提供');const date=new Date(typeof value==='number'?value*1000:value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString(i18n.language==='en'?'en-US':'zh-CN');}
  function valueText(value,key=''){
    if(value==null)return t('厂商未提供');
    if(typeof value==='boolean')return t(value?'是':'否');
    if(/(?:resets_at|resetsAt|expiresAt|grantedAt)$/.test(key))return time(value);
    return String(value);
  }
  function nativeTree(data){
    const root=el('div',{class:'usage-native-tree'});
    for(const [key,value]of Object.entries(data||{})){
      if(value&&typeof value==='object'){
        const details=el('details',{},[el('summary',{text:t(labels[key]||key)})]);
        details.addEventListener('toggle',()=>{if(details.open&&!details.dataset.built){details.dataset.built='1';details.append(nativeTree(value));}});
        root.append(details);
      }else root.append(el('div',{class:'usage-fact'},[el('span',{text:t(labels[key]||key)}),el('span',{text:valueText(value,key)})]));
    }
    return root;
  }
  function duration(minutes,slot){if(!numeric(minutes))return t(slot==='secondary'?'次限额窗口':'主限额窗口');if(minutes%1440===0)return t('{n} 天窗口',{n:minutes/1440});if(minutes%60===0)return t('{n} 小时窗口',{n:minutes/60});return t('{n} 分钟窗口',{n:minutes});}
  function windowRow(row){
    const block=el('section',{class:'usage-window'},[
      el('div',{class:'usage-window-heading'},[el('strong',{text:t(row.label)}),el('strong',{class:'usage-remaining',text:numeric(row.remainingPercent)?t('剩余 {n}%',{n:Math.round(row.remainingPercent*10)/10}):t('厂商未提供')})]),
      ...(row.slot?[el('small',{text:duration(row.durationMinutes,row.slot)})]:[])]);
    if(numeric(row.usedPercent))block.append(el('progress',{max:'100',value:Math.max(0,Math.min(100,row.usedPercent)),'aria-label':t('已用百分比')}));
    block.append(el('div',{class:'usage-window-meta'},[el('span',{text:numeric(row.usedPercent)?t('已用 {n}%',{n:row.usedPercent}):t('用量未知')}),el('span',{text:t('重置：{time}',{time:time(row.resetAt)})})]));return block;
  }
  function money(value){if(value?.amount_minor==null)return null;const exponent=numeric(value.exponent)?Math.min(6,Math.max(0,value.exponent)):2;return (Number(value.amount_minor)/10**exponent).toLocaleString(i18n.language==='en'?'en-US':'zh-CN',{maximumFractionDigits:exponent})+' '+(value.currency||'');}
  function highlights(data){
    const rows=[],native=data.native||{};
    const add=(label,value)=>{if(value!==undefined&&value!==null)rows.push(el('div',{class:'usage-fact'},[el('span',{text:t(label)}),el('strong',{text:String(value)})]));};
    if(data.provider==='codex'){
      const buckets=Object.values(native.rateLimitsByLimitId||{}),limits=buckets.length?buckets:[native.rateLimits];
      for(const bucket of limits.filter(Boolean)){
        const name=bucket.limitName||bucket.limitId||'Codex';
        if(bucket.credits)add(name+' · '+t('额外额度'),bucket.credits.unlimited?t('无限额'):bucket.credits.balance??(bucket.credits.hasCredits?t('可用'):t('无可用额度')));
        if(bucket.spendControlReached!=null)add(name+' · '+t('已达支出上限'),t(bucket.spendControlReached?'是':'否'));
      }
      add('可用重置次数',native.rateLimitResetCredits?.availableCount);
      if(native.ordinaryUsageAllowed!=null)add('允许使用套餐内额度',t(native.ordinaryUsageAllowed?'是':'否'));
    }
    if(data.provider==='claude'){
      add('套餐',native.subscription_type);
      const spend=native.rate_limits?.spend,extra=native.rate_limits?.extra_usage;
      if(spend){add('用量额度支出',t(spend.enabled?'已启用':'未启用'));add('已用金额',money(spend.used));add('支出上限',money(spend.limit));add('余额',money(spend.balance));}
      else if(extra){add('额外用量',t(extra.is_enabled?'已启用':'未启用'));const exponent=numeric(extra.decimal_places)?extra.decimal_places:2;
        for(const [key,label]of [['used_credits','已用金额'],['monthly_limit','支出上限']])if(extra[key]!=null)add(label,extra.currency?money({amount_minor:extra[key],currency:extra.currency,exponent}):String(extra[key])+' · '+t('厂商原始单位'));}
    }
    if(data.provider==='deepseek'){
      if(native.is_available!=null)add('余额可用于调用',t(native.is_available?'是':'否'));
      for(const balance of native.balance_infos||[])for(const [key,label]of [['total_balance','总余额'],['granted_balance','赠送余额'],['topped_up_balance','充值余额']])add(label,balance[key]==null?t('厂商未提供'):balance[key]+' '+balance.currency);
    }
    return rows.length?el('section',{class:'usage-highlights'},rows):null;
  }
  function render(){
    if(!dialog.open)return;
    const select=el('select',{'aria-label':t('查询哪个工具'),disabled:busy},state.providers.map(p=>el('option',{value:p.id,text:p.name})));select.value=selected;
    select.onchange=()=>{selected=select.value;result=null;query();};
    const refresh=el('button',{class:'secondary-button',text:t(busy?'查询中…':'刷新用量'),disabled:busy});refresh.onclick=query;
    const close=el('button',{class:'icon-button',text:'×','aria-label':t('关闭')});close.onclick=()=>dialog.close();
    const body=el('div',{class:'usage-body','aria-busy':String(busy)});
    if(busy)body.append(el('p',{role:'status',text:t('正在向原工具查询，通常需要几秒钟…')}));
    if(error)body.append(el('p',{class:'error',role:'alert',text:notice(error)}));
    if(result){
      body.append(el('div',{class:'usage-source'},[el('a',{href:result.source.url,target:'_blank',rel:'noreferrer',text:result.source.label}),el('small',{text:t('查询时间：{time}',{time:time(result.queriedAt)})})]));
      if(result.reason)body.append(el('p',{class:'usage-explanation',role:'status',text:t(result.reason)}));
      for(const row of result.windows||[])body.append(windowRow(row));
      const summary=highlights(result);if(summary)body.append(summary);
      for(const report of result.reports||[])body.append(el('section',{class:'usage-report'},[el('h3',{text:t(report.label)}),el('pre',{text:report.text})]));
      for(const note of result.notes||[])body.append(el('p',{class:'usage-explanation',text:t(note)}));
      if(result.native)body.append(el('details',{class:'usage-full-report'},[el('summary',{text:t('完整厂商报告')}),nativeTree(result.native)]));
    }
    dialog.replaceChildren(el('div',{class:'dialog-heading'},[el('h2',{id:'usage-heading',text:t('剩余用量')}),close]),el('div',{class:'usage-toolbar'},[select,refresh]),body,
      el('div',{class:'dialog-footer'},[el('small',{text:t('使用原工具当前登录；百分比、余额和重置时间分别保留原有口径。')})]));
  }
  async function query(){
    const request=++revision,id=selected,workspace=state.chat?.workspace||state.workspace;
    const service=id==='deepseek'?(state.chat?.options?.deepseek||state.options.deepseek||{}).provider||'':'';
    busy=true;error=null;result=null;render();
    try{const data=await api('/providers/'+id+'/usage?'+new URLSearchParams({workspace,service}));if(request===revision)result=data;}
    catch(e){if(request===revision)error=e.message;}
    finally{if(request===revision){busy=false;render();}}
  }
  function open(){selected=currentId();result=null;error=null;dialog.showModal();query();}
  dialog.onclose=()=>{revision++;busy=false;result=null;};
  $('#query-usage').onclick=open;
  return {open,render};
})();
