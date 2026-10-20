import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeControl } from './claude-control.mjs';
import { claudeEffort } from './effort.mjs';

const aliases=[['sonnet','Claude Sonnet'],['opus','Claude Opus'],['haiku','Claude Haiku'],['sonnet[1m]','Claude Sonnet · 1M'],['opus[1m]','Claude Opus · 1M'],['opusplan','Opus → Sonnet · Plan']];
export const claudeAliases=()=>({source:'aliases',models:aliases.map(([id,label])=>({id,label}))});

export function claudeModelLabel(model){
  const wire=model.resolvedModel||model.value||'';
  const match=/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(wire);
  if(!match)return model.resolvedModel?`${model.displayName||model.value} · ${model.resolvedModel}`:model.displayName||model.value;
  const family=match[1][0].toUpperCase()+match[1].slice(1).toLowerCase();
  return `Claude ${family} ${match[2]}${match[3]?'.'+match[3]:''}${/\[1m\]$/i.test(model.value)||/\[1m\]$/i.test(wire)?' · 1M':''}`;
}

export function claudeModelCatalog(rows){
  const models=rows.filter(m=>m.value!=='default').map(m=>({id:m.value,label:claudeModelLabel(m),effort:claudeEffort(m),...(m.resolvedModel?{resolvedModel:m.resolvedModel}:{})}));
  const byId=new Map(models.map(m=>[m.id,m]));
  // Keep the existing mixed plan mode; its two component versions come from the native catalog.
  if(!byId.has('opusplan')&&byId.has('opus')&&byId.has('sonnet')){
    const opus=byId.get('opus'),sonnet=byId.get('sonnet');
    const effort=opus.effort&&sonnet.effort?{source:'native',choices:opus.effort.choices.filter(c=>sonnet.effort.choices.some(s=>s.value===c.value))}:null;
    models.push({id:'opusplan',label:`${opus.label} → ${sonnet.label} · Plan`,effort});
  }
  // Native "default" clears overrides; Starport's empty selection instead inherits CLI settings.
  return {source:'native',models};
}

// Initialize the native model picker only: no user prompt, tools, hooks or saved session.
export async function claudeModels(runtime,cwd,makeQuery=query,timeoutMs=15000){
  if(!runtime)return claudeAliases();
  try{
    const rows=await claudeControl(runtime,cwd,session=>session.supportedModels(),makeQuery,timeoutMs);
    if(!Array.isArray(rows)||!rows.length)throw new Error('No native models');
    return claudeModelCatalog(rows);
  }catch{return claudeAliases();}
}
