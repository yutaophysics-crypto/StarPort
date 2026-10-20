// User-facing presets map to native Codex policies, never prompt instructions.
export const CODEX_PERMISSIONS = [
  {value:'ask',label:'请求批准',description:'在工作目录内执行；需要额外权限时，由你批准或拒绝。'},
  {value:'auto-review',label:'帮我批准',description:'保持相同的工作目录与网络限制；由 Codex 自动审核额外权限请求，可批准或拒绝。'},
  {value:'full-access',label:'完全访问权限',description:'可修改本机可访问的文件并联网；不再请求 Codex 执行审批。仍受系统与组织策略限制。'}
];

export function codexPermissionSelection(raw={}) {
  const permissionMode=raw.permissionMode??'ask';
  if(!CODEX_PERMISSIONS.some(profile=>profile.value===permissionMode)||
    (raw.sandbox!==undefined&&!['read-only','workspace-write','danger-full-access'].includes(raw.sandbox)))throw new Error('权限选项无效');
  // Preserve legacy read-only conversations until an explicit permission selection.
  const legacyReadonly=raw.sandbox==='read-only'||(raw.permissionMode==null&&raw.sandbox==null);
  const sandbox=permissionMode==='full-access'?'danger-full-access':legacyReadonly?'read-only':'workspace-write';
  return {permissionMode,sandbox};
}
export function codexPermissions(options={},cwd) {
  const {permissionMode,sandbox}=codexPermissionSelection(options);
  const approvalPolicy=permissionMode==='full-access'?'never':'on-request';
  const sandboxPolicy=sandbox==='danger-full-access'?{type:'dangerFullAccess'}:
    sandbox==='workspace-write'?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false}:
      {type:'readOnly',networkAccess:false};
  return {sandbox,approvalPolicy,approvalsReviewer:permissionMode==='auto-review'?'auto_review':'user',sandboxPolicy};
}
