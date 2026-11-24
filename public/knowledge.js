'use strict';

// Knowledge folders (src/knowledge.mjs): read-only reference folders hung on a room, a conversation
// or a companion. Rooms and conversations manage theirs in a dialog; a companion's settings embed
// the same list. Every change saves at once and applies from the next turn.
globalThis.StarportKnowledge = (() => {
  const { el, icon, showDialog, closeDialog, textAction } = globalThis.StarportUI;
  const tr = (text, values) => globalThis.StarportI18n?.t(text, values) || text;
  const READ_ONLY =
    '资料留在原处，不会复制。模型自己的工具只能读：Claude 和 Codex（完全访问权限除外）由工具本身挡住写入，Antigravity 和 DeepSeek 靠提示要求不写；Ollama 读不了文件。你在对话里明确要求“存进知识库”时，模型可以请星港把下载的文件或工作目录里的文件存进来。';
  const NOTES = {
    room: '这个房间里的每个对话，以及在这里干活的伙伴，都会读这些文件夹。',
    chat: '这个对话和为它干活的伙伴会读这些文件夹。',
    companion: '这位伙伴在任何房间干活时都会读这些文件夹，别的伙伴看不到。'
  };

  function folderRow(folder, onRemove) {
    return el('li', { class: 'knowledge-folder' + (folder.missing ? ' missing' : '') }, [
      icon('folder'),
      el('span', { class: 'knowledge-folder-text' }, [
        el('strong', { text: folder.name }),
        el('span', { text: folder.missing ? tr('找不到这个文件夹：') + folder.path : folder.path, title: folder.path })
      ]),
      onRemove ? textAction(tr('移除'), onRemove) : null
    ]);
  }

  // The folders of one room, conversation or companion, with 添加文件夹… and 移除.
  function editor(scope, owner) {
    const list = el('ul', { class: 'room-duty-list knowledge-list' });
    const inherited = el('div', { class: 'knowledge-inherited' });
    const add = el('button', { type: 'button', class: 'secondary-button knowledge-add', text: tr('添加文件夹…') });
    async function load() {
      let data;
      try {
        data = await api('/knowledge?scope=' + encodeURIComponent(scope) + '&owner=' + encodeURIComponent(owner));
      } catch (error) {
        list.replaceChildren(el('li', { class: 'knowledge-empty', text: notice(error.message) }));
        return;
      }
      list.replaceChildren(
        ...data.folders.map(folder =>
          folderRow(folder, async () => {
            try {
              await api('/knowledge/' + folder.id, 'DELETE');
              await load();
            } catch (error) {
              toast(notice(error.message));
            }
          })
        )
      );
      if (!data.folders.length) list.append(el('li', { class: 'knowledge-empty', text: tr('还没有知识库文件夹。') }));
      inherited.replaceChildren(
        ...(data.inherited?.folders.length
          ? [
              el('span', { class: 'room-field-hint', text: tr('也会读房间「{name}」的知识库：', { name: data.inherited.name }) }),
              el('ul', { class: 'room-duty-list knowledge-list' }, data.inherited.folders.map(folder => folderRow(folder, null)))
            ]
          : [])
      );
    }
    add.onclick = () =>
      openFolderPicker(
        state.chat?.workspace || state.workspace,
        async path => {
          try {
            await api('/knowledge', 'POST', { scope, owner, path });
            await load();
          } catch (error) {
            toast(notice(error.message));
          }
        },
        tr('选择知识库文件夹'),
        { projects: false }
      );
    load();
    return el('div', { class: 'knowledge-editor' }, [list, add, inherited]);
  }

  const note = scope => tr(NOTES[scope]) + ' ' + tr(READ_ONLY);

  function open(scope, owner, title) {
    showDialog({
      eyebrow: title,
      title: tr('知识库'),
      body: [el('p', { class: 'room-dialog-note', text: note(scope) }), editor(scope, owner)],
      footer: [el('button', { type: 'button', class: 'primary-button', text: tr('完成'), onclick: closeDialog })]
    });
  }

  return { open, editor, note };
})();
