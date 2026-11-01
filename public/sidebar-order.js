'use strict';

// Rooms and the conversations in a room can be dragged into the order you want: a room by its
// name, a conversation by its row. Alt+↑/↓ moves the focused one a step. A conversation stays in
// its room while dragged; moving it to another room is the chat menu's job.
globalThis.StarportSidebarOrder = (() => {
  const root = $('#groups');
  const indicator = el('div', { class: 'sort-indicator', 'aria-hidden': 'true' });
  // { kind, id, groupId, node, from, y, active, spot } while the pointer is down on an item.
  let drag = null;
  let scrollFrame = 0;

  // Every id of this kind of item, in the order the list shows them, hidden ones included.
  function listed(item) {
    return item.kind === 'group'
      ? state.groups.filter(g => g.name !== '__DELETED_ROOM__').map(g => g.id)
      : chatsInRoom(item.groupId).map(c => c.id);
  }

  function find(kind, id) {
    const node = [...root.querySelectorAll(kind === 'group' ? '.group-heading' : '.chat-row')].find(node =>
      kind === 'group' ? node.dataset.groupId === id : node.dataset.chatId === id
    );
    return kind === 'group' ? node?.closest('.group') : node;
  }

  function itemOf(target) {
    if (!(target instanceof Element) || target.closest('.chat-more, .icon-button, .room-presence')) return null;
    const row = target.closest('.chat-row');
    if (row) {
      const chat = state.chats.find(c => c.id === row.dataset.chatId);
      return chat ? { kind: 'chat', id: chat.id, groupId: chat.group_id, node: row } : null;
    }
    const id = target.closest('.group-heading')?.dataset.groupId;
    return id ? { kind: 'group', id, node: find('group', id) } : null;
  }

  // The items on screen the dragged one can land between, top to bottom, without itself.
  // `node` is measured to choose the slot, `mark` is where the line is drawn.
  function slots(item) {
    if (item.kind === 'chat') {
      return [...item.node.closest('.group').querySelectorAll('.chat-row')]
        .filter(row => !row.hidden && row !== item.node)
        .map(row => ({ id: row.dataset.chatId, node: row, mark: row }));
    }
    return [...root.querySelectorAll('.group-heading')]
      .filter(heading => heading.dataset.groupId && heading.dataset.groupId !== item.id)
      .map(heading => ({ id: heading.dataset.groupId, node: heading, mark: heading.closest('.group') }));
  }

  // The item placed after `id` once the moved item is taken out (null: `id` is the last).
  function successor(item, id) {
    const others = listed(item).filter(other => other !== item.id);
    return others[others.indexOf(id) + 1] ?? null;
  }

  // Where a drop at height y puts the item: before `before` (null: at the end), with the line at
  // `edge`. Null when it would stay where it is.
  function spotAt(item, y) {
    const places = slots(item);
    if (!places.length) return null;
    const index = places.filter(place => {
      const box = place.node.getBoundingClientRect();
      return box.top + box.height / 2 < y;
    }).length;
    const below = places[index];
    const before = below ? below.id : successor(item, places.at(-1).id);
    const all = listed(item);
    if (before === (all[all.indexOf(item.id) + 1] ?? null)) return null;
    const edge = below ? below.mark.getBoundingClientRect().top - 2 : places.at(-1).mark.getBoundingClientRect().bottom + 1;
    return { before, edge };
  }

  function show() {
    drag.spot = spotAt(drag, drag.y);
    indicator.hidden = !drag.spot;
    if (!drag.spot) return;
    // Kept inside the list, so the line before the first item or after the last is not cut off.
    const top = drag.spot.edge - root.getBoundingClientRect().top + root.scrollTop;
    indicator.style.top = Math.max(0, Math.min(root.scrollHeight - 2, top)) + 'px';
  }

  // Near the list's top or bottom edge, the list scrolls so far-away places can be reached.
  function autoScroll() {
    if (!drag?.active) return;
    const box = root.getBoundingClientRect();
    const zone = 36;
    const over = drag.y < box.top + zone ? drag.y - box.top - zone : drag.y > box.bottom - zone ? drag.y - box.bottom + zone : 0;
    if (over) {
      const previous = root.scrollTop;
      root.scrollTop += Math.max(-14, Math.min(14, over / 2));
      if (root.scrollTop !== previous) show();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function begin() {
    // The list may have been redrawn since the press; carry on with the item's new row.
    if (!drag.node.isConnected) drag.node = find(drag.kind, drag.id);
    if (!drag.node) {
      finish();
      return;
    }
    drag.active = true;
    globalThis.StarportChatActions?.closeMenu();
    getSelection()?.removeAllRanges();
    drag.node.classList.add('sort-source');
    document.body.classList.add('sorting-sidebar');
    root.append(indicator);
    autoScroll();
  }

  function onMove(event) {
    drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.from.x, event.clientY - drag.from.y) < 5) return;
      begin();
      if (!drag) return;
    }
    show();
  }

  // The press that ends a drag is not also a click on the row under the pointer.
  const swallowClick = event => {
    event.preventDefault();
    event.stopPropagation();
  };

  function onUp() {
    const item = drag;
    finish();
    if (!item.active) return;
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, true));
    if (item.spot) place(item, item.spot.before);
  }

  function onKey(event) {
    if (event.key !== 'Escape' || !drag?.active) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }

  function finish() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', finish);
    cancelAnimationFrame(scrollFrame);
    const active = drag?.active;
    drag = null;
    if (!active) return;
    document.body.classList.remove('sorting-sidebar');
    indicator.remove();
    // Whatever arrived while the list was held still, and the item back at full strength.
    renderGroups();
  }

  // Shown at once; the server's broadcast then brings every window the saved order.
  async function place(item, before, focus = false) {
    const ids = listed(item).filter(id => id !== item.id);
    const at = before === null ? ids.length : ids.indexOf(before);
    if (at < 0) return refreshList().catch(() => {});
    ids.splice(at, 0, item.id);
    if (item.kind === 'group') {
      const byId = new Map(state.groups.map(g => [g.id, g]));
      state.groups = [...ids.map(id => byId.get(id)), ...state.groups.filter(g => !ids.includes(g.id))];
    } else {
      ids.forEach((id, index) => {
        for (const chat of [state.chats.find(c => c.id === id), state.chat?.id === id ? state.chat : null])
          if (chat) chat.sort_order = index;
      });
    }
    renderGroups();
    if (focus) {
      const node = find(item.kind, item.id);
      node?.querySelector(item.kind === 'group' ? '.group-toggle' : '.chat-link')?.focus();
      node?.scrollIntoView({ block: 'nearest' });
    }
    try {
      await api(`/${item.kind === 'group' ? 'groups' : 'chats'}/${item.id}/move`, 'POST', { before });
    } catch (error) {
      toast(error.message);
      refreshList().catch(() => {});
    }
  }

  root.addEventListener('pointerdown', event => {
    // Touch keeps scrolling the list; mouse and pen can drag.
    if (event.button !== 0 || event.pointerType === 'touch' || drag) return;
    const item = itemOf(event.target);
    if (!item?.node) return;
    drag = { ...item, from: { x: event.clientX, y: event.clientY }, y: event.clientY, active: false, spot: null };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', finish);
  });

  // Nothing in the list is dragged as browser data (selected text, avatar images).
  root.addEventListener('dragstart', event => event.preventDefault());

  root.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !event.altKey) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || drag) return;
    const item = itemOf(event.target);
    if (!item?.node) return;
    event.preventDefault();
    // Rows for a conversation, whole room sections for a room, in screen order.
    const shown = [item.node, ...slots(item).map(place => place.mark)].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const at = shown.indexOf(item.node);
    const next = shown[at + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!next) return;
    const nextId = item.kind === 'group' ? next.querySelector('.group-heading').dataset.groupId : next.dataset.chatId;
    place(item, event.key === 'ArrowUp' ? nextId : successor(item, nextId), true);
  });

  return { holding: () => !!drag?.active };
})();
