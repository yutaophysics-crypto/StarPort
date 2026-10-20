'use strict';

// One-time import of the companions, rosters and routines older builds kept in this browser's
// localStorage. agents-room.js calls maybeMigrate() whenever it redraws; it does nothing once the
// server has them.
globalThis.StarportRoomMigration = (() => {
  const W = globalThis.StarportWorkflows;
  const LEGACY_KEYS = ['starport-agents-v3', 'starport-agents-v2', 'starport-agents-v1'];
  const LEGACY_ROSTERS = {
    lounge: ['liv', 'steward', 'auditor'],
    trading: ['scout', 'watcher', 'auditor', 'quartermaster'],
    physics: ['emergence', 'verifier', 'liv']
  };
  let migrating = false;

  function legacyStore() {
    for (const key of LEGACY_KEYS) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        if (raw && Array.isArray(raw.agents) && raw.agents.length) return { key, raw };
      } catch {}
    }
    return null;
  }

  // The same room inference the old panel used, so each room keeps the companions it showed.
  function legacyRoomKey(raw, group) {
    if (raw.groupBindings?.[group.id]) return raw.groupBindings[group.id];
    const name = (group.name || '').toLowerCase();
    if (/交易|量化|股|投/.test(name)) return 'trading';
    if (/物理|科研|书房|论文/.test(name)) return 'physics';
    if (/客厅|日常|生活/.test(name)) return 'lounge';
    return group.id;
  }

  async function maybeMigrate() {
    if (migrating || W.status !== 'ready' || W.data.migrated || !(state.providers || []).length) return;
    const legacy = legacyStore();
    if (!legacy) return;
    migrating = true;
    const { key, raw } = legacy;
    const rooms = {};
    const routines = {};
    const usedRoutines = new Set();
    for (const group of (state.groups || []).filter(g => g.name !== '__DELETED_ROOM__')) {
      const roomKey = legacyRoomKey(raw, group);
      rooms[group.id] = raw.roomAgents?.[group.id] ||
        raw.roomAgents?.[roomKey] ||
        LEGACY_ROSTERS[roomKey] || ['liv', 'steward'];
      const own = raw.roomRoutines?.[group.id];
      const shared = raw.roomRoutines?.[roomKey];
      if (own) routines[group.id] = own;
      else if (shared && !usedRoutines.has(roomKey)) {
        routines[group.id] = shared;
        usedRoutines.add(roomKey);
      }
    }
    try {
      const result = await api('/workflows/migrate', 'POST', {
        companions: raw.agents,
        rooms,
        routines,
        workspace: state.workspace
      });
      raw.migratedToServer = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(raw));
      await W.load();
      const report = result.report;
      if (report) {
        const parts = [`${report.companions} 位伙伴`];
        if (report.workflows) parts.push(`${report.workflows} 个定时分工（已转成工作流，定时先关着）`);
        toast(
          `已把这个浏览器里的 ${parts.join('、')} 搬到星港本机${report.cleared?.length ? `；${report.cleared.length} 个找不到的模型已改回默认` : ''}`
        );
      }
    } catch (error) {
      toast('搬迁伙伴失败：' + error.message);
    } finally {
      migrating = false;
    }
  }

  return { maybeMigrate };
})();
