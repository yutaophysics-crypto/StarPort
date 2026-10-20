'use strict';

// Deleting a room: its chats move to 未分组, are exported first, or are deleted with it.
// The server does the work; companions are kept. Part of StarportAgentsRoom (agents-room.js).
(() => {
  const Room = globalThis.StarportAgentsRoom;
  const { el, showDialog } = globalThis.StarportUI;

  async function executeRoomDeletion(group, mode, exportDir) {
    const result = await api('/groups/' + encodeURIComponent(group.id) + '/delete', 'POST', { mode, exportDir });
    const exportedCount = result?.exportedCount || 0;
    const exportedPath = result?.exportedPath || '';
    if (mode === 'export' && exportedPath) api('/folders/open', 'POST', { path: exportedPath }).catch(() => {});

    if (state.draftGroup === group.id) {
      state.draftGroup = null;
    }
    if (state.chat && state.chat.group_id === group.id) {
      if (mode === 'move') {
        state.chat.group_id = null;
      } else {
        state.chat = null;
        state.messages = [];
        renderMessages();
        renderHeader();
      }
    }

    await refresh();
    Room.renderAll();

    if (mode === 'move') {
      toast(`已删除房间「${group.name}」，原房间内对话已全部移动到「未分组」`);
    } else if (mode === 'export') {
      toast(`已导出 ${exportedCount} 个对话至 ${exportedPath || exportDir}，并删除房间「${group.name}」`);
    } else {
      toast(`已删除房间「${group.name}」及其中的全部对话`);
    }
  }

  function openDeleteRoomModal(group) {
    if (!group || !group.id) return;
    const userChats = (state.chats || []).filter(
      c => c.group_id === group.id && !String(c.title || '').startsWith('[工位]')
    );
    const chatCount = userChats.length;
    let selectedMode = 'move';
    const defaultExportDir = state.chat?.workspace || state.workspace || '';

    const exportDirInput = el('input', { type: 'text', value: defaultExportDir, placeholder: '导出到哪个文件夹' });
    const browse = el('button', { type: 'button', class: 'secondary-button', text: '浏览…' });
    const folderRow = el('div', { class: 'room-delete-folder', hidden: true }, [
      el('div', { class: 'room-delete-folder-controls' }, [exportDirInput, browse]),
      el('span', {
        class: 'room-field-hint',
        text: `会在其中新建「${group.name}_导出_${new Date().toISOString().slice(0, 10)}」，每个对话一份 .md`
      })
    ]);

    const optionsSpec = [
      { mode: 'move', title: '移到「未分组」', desc: `保留全部 ${chatCount} 个对话，只解散房间。` },
      { mode: 'export', title: '导出后删除', desc: `先把 ${chatCount} 个对话导出到文件夹，再删除房间和对话。` },
      { mode: 'delete', title: '全部删除', desc: `${chatCount} 个对话会被永久删除，无法恢复。` }
    ];
    const confirmBtn = el('button', { type: 'submit', class: 'primary-button' });
    const optionCards = optionsSpec.map(opt => {
      const radio = el('input', { type: 'radio', name: 'delete-room-mode', value: opt.mode });
      radio.onchange = () => syncModeUI(opt.mode);
      const card = el('label', { class: 'room-delete-option' + (opt.mode === 'delete' ? ' danger' : '') }, [
        radio,
        el('span', { class: 'room-delete-option-text' }, [
          el('strong', { text: opt.title }),
          el('span', { text: opt.desc })
        ])
      ]);
      return { mode: opt.mode, card, radio };
    });

    function syncModeUI(mode) {
      selectedMode = mode;
      folderRow.hidden = mode !== 'export';
      for (const item of optionCards) {
        item.card.classList.toggle('selected', item.mode === mode);
        item.radio.checked = item.mode === mode;
      }
      confirmBtn.className = mode === 'delete' ? 'danger-button' : 'primary-button';
      confirmBtn.textContent =
        mode === 'delete' ? `删除房间和 ${chatCount} 个对话` : mode === 'export' ? '导出并删除' : '删除房间';
    }
    syncModeUI('move');

    const cancel = el('button', { type: 'button', class: 'secondary-button', text: '取消' });

    const { dialog } = showDialog({
      eyebrow: group.name,
      title: '删除房间',
      body: [
        el('p', { class: 'room-dialog-note', text: `房间里有 ${chatCount} 个对话，要怎么处理？伙伴本身不会被删除。` }),
        el(
          'div',
          { class: 'room-delete-options' },
          optionCards.map(item => item.card)
        ),
        folderRow
      ],
      footer: [cancel, confirmBtn],
      onsubmit: async () => {
        const chosenDir = exportDirInput.value.trim();
        if (selectedMode === 'export' && !chosenDir) {
          toast('先选一个导出文件夹');
          exportDirInput.focus();
          return;
        }
        confirmBtn.disabled = true;
        confirmBtn.textContent = '正在处理…';
        try {
          await executeRoomDeletion(group, selectedMode, chosenDir);
          dialog.close();
        } catch (err) {
          confirmBtn.disabled = false;
          syncModeUI(selectedMode);
          toast(err.message || '删除房间失败');
        }
      }
    });
    cancel.onclick = () => dialog.close();
    browse.onclick = () => {
      dialog.close();
      const folderDialog = document.getElementById('folder-dialog');
      const restoreModal = () => {
        folderDialog?.removeEventListener('close', restoreModal);
        if (!dialog.open) dialog.showModal();
      };
      folderDialog?.addEventListener('close', restoreModal);
      openFolderPicker(
        exportDirInput.value.trim() || defaultExportDir,
        pickedPath => {
          exportDirInput.value = pickedPath;
        },
        `选择「${group.name}」对话导出的目标文件夹`,
        { projects: false }
      );
    };
  }

  Object.assign(Room, { openDeleteRoomModal });
})();
