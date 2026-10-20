// Catalog data is the authority. Presentation names must never replace wire values.
export function effortChoices(levels, {defaultLevel,source='native',labels={}}={}) {
  const seen=new Set(),choices=[];
  for(const row of levels||[]){
    const value=typeof row==='string'?row:row?.value;
    if(typeof value!=='string'||!value||value.length>100||seen.has(value))continue;
    seen.add(value);
    choices.push({value,label:labels[value]||row.label||value[0].toUpperCase()+value.slice(1),
      ...(typeof row.description==='string'?{description:row.description}:{}),
      ...(typeof row.warning==='string'?{warning:row.warning}:{})});
  }
  return {source,choices,...seen.has(defaultLevel)?{defaultLevel}:{}};
}

export function claudeEffort(model) {
  if(!Array.isArray(model.supportedEffortLevels))return model.supportsEffort===true?null:effortChoices([]);
  // SDK supplies capabilities, but not the model's baseline default. Only label
  // documented, resolved versions; leave custom and future models unspecified.
  const wire=(model.resolvedModel||'').replace(/\[1m\]$/,'');
  const defaults={'claude-opus-5-5':'medium','claude-opus-4-7':'xhigh',
    'claude-opus-5':'high','claude-opus-4-8':'high','claude-opus-4-6':'high',
    'claude-sonnet-5':'high','claude-sonnet-4-6':'high','claude-fable-5':'high','claude-fable-5-1':'high'};
  return effortChoices(model.supportedEffortLevels.map(value=>({value,...value==='max'?{warning:'用量可能显著增加'}:{}})),
    {defaultLevel:defaults[wire],labels:{xhigh:'Extra'}});
}

export function selectedEffort(catalog,options) {
  const model=options.model?catalog?.models?.find(m=>(m.id===options.model||m.resolvedModel===options.model)&&(!m.provider||m.provider===options.provider)):null;
  return model?.effort||catalog?.effort||null;
}

export function validateEffort(catalog,options) {
  if(!options.effort)return;
  const capability=selectedEffort(catalog,options);
  if(!capability)throw new Error('暂未确认当前模型的思考档位，请选择具体模型并刷新列表，或使用跟随工具默认');
  if(!capability.choices.some(c=>c.value===options.effort))throw new Error('当前模型不支持已选思考档位，请重新选择或使用跟随工具默认');
}
