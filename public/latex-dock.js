'use strict';

// The LaTeX editor beside a conversation (the page itself is public/latex). Per conversation it is
// closed, docked left or right of the conversation in a frame, or in its own window; the top bar's
// TeX button opens and closes it. Text selected in the editor becomes a quote card above the
// composer, and the next message carries it in front of what the user wrote; a box dragged over
// the PDF arrives as a picture attachment.
globalThis.StarportLatexDock = (() => {
  const PREFS = 'starport-latex-dock', PLACE = 'starport-latex-place', WIDTH = 'starport-latex-width', KEPT = 'starport-latex-kept:';
  const MAX_KEPT = 12, MAX_KEPT_CHARS = 60000;
  const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('starport-latex') : null;
  const quotes = new Map();
  let prefs = {}, frameChat = null;
  try { prefs = JSON.parse(localStorage.getItem(PREFS)) || {}; } catch {}
  const save = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch {} };
  const covered = () => typeof coverOpen !== 'undefined' && coverOpen;
  const chatId = () => (covered() ? null : state.chat?.id || null);
  const lastPlace = () => (['left', 'right', 'window'].includes(localStorage.getItem(PLACE)) ? localStorage.getItem(PLACE) : 'right');
  const url = (id, place) => '/latex/?chat=' + encodeURIComponent(id) + (place === 'window' ? '' : '&embed=1&place=' + place);
  const post = message => channel?.postMessage(message);

  function setPref(id, value) {
    if (value) prefs[id] = value; else delete prefs[id];
    // Only the most recent conversations keep a remembered editor.
    const ids = Object.keys(prefs);
    if (ids.length > 200) for (const old of ids.slice(0, ids.length - 200)) delete prefs[old];
    save();
  }

  // A window of this name is reused: opening it again only brings it forward.
  function openWindow(id) {
    const name = 'starport-latex-' + id;
    const win = window.open('', name, 'popup=yes,width=1280,height=860');
    if (!win) { toast('浏览器拦截了新窗口'); return false; }
    let blank = true;
    try { blank = win.location.href === 'about:blank'; } catch {}
    if (blank) win.location.href = url(id, 'window');
    win.focus();
    return true;
  }

  function toggle() {
    const id = chatId();
    if (!id) return;
    const pref = prefs[id];
    if (pref?.open && pref.place === 'window') { openWindow(id); return; }
    const place = pref?.place || lastPlace();
    if (!pref?.open && place === 'window' && !openWindow(id)) return;
    setPref(id, { open: !pref?.open, place });
    sync();
  }

  function sync() {
    const id = chatId(), pref = id ? prefs[id] : null, button = $('#latex-toggle');
    if (button) {
      button.hidden = !state.chat || covered();
      button.setAttribute('aria-pressed', String(!!pref?.open));
      const detached = pref?.open && pref.place === 'window';
      const label = detached ? '切回 LaTeX 窗口' : 'LaTeX 编辑器';
      const title = detached ? label : 'LaTeX 编辑器：源码、PDF 预览，选中的源码可以直接引用';
      button.dataset.i18nAriaLabel = label;
      button.dataset.i18nTitle = title;
      button.setAttribute('aria-label', t(label));
      button.title = t(title);
    }
    show(pref?.open && pref.place !== 'window' ? id : null, pref?.place);
    renderQuote();
  }

  function show(id, place) {
    const dock = $('#latex-dock'), area = $('#workarea'), frame = $('#latex-frame');
    if (!dock || !area || !frame) return;
    area.classList.toggle('latex-left', !!id && place === 'left');
    area.classList.toggle('latex-right', !!id && place !== 'left');
    dock.hidden = !id;
    if (!id) {
      if (frameChat) { frame.src = 'about:blank'; frameChat = null; }
      return;
    }
    if (frameChat !== id) { frame.src = url(id, place === 'left' ? 'left' : 'right'); frameChat = id; frame.dataset.place = place; }
    else if (frame.dataset.place !== place) { frame.dataset.place = place; post({ type: 'placed', chatId: id, place }); }
    fit();
  }

  // --- width -----------------------------------------------------------------------------------
  const MIN = 360, CHAT_MIN = 340;
  function limit() { return Math.max(MIN, $('#workarea').getBoundingClientRect().width - CHAT_MIN); }
  function setWidth(value, remember = true) {
    const width = Math.round(Math.max(MIN, Math.min(limit(), value)));
    $('#workarea').style.setProperty('--latex-width', width + 'px');
    if (remember) localStorage.setItem(WIDTH, String(width));
  }
  function fit() {
    const saved = Number(localStorage.getItem(WIDTH));
    if (saved) setWidth(saved, false);
  }
  function setupResizer() {
    const handle = $('#latex-resizer'), dock = $('#latex-dock');
    if (!handle || !dock) return;
    handle.addEventListener('dblclick', () => { $('#workarea').style.removeProperty('--latex-width'); localStorage.removeItem(WIDTH); });
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowLeft') === $('#workarea').classList.contains('latex-right');
      setWidth(dock.getBoundingClientRect().width + (grow ? 24 : -24));
    });
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || innerWidth <= 650) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add('dragging');
      // The frame would swallow the pointer while it passes over it.
      document.body.classList.add('resizing-panels', 'latex-resizing');
      const box = $('#workarea').getBoundingClientRect(), right = $('#workarea').classList.contains('latex-right');
      const move = m => setWidth(right ? box.right - m.clientX : m.clientX - box.left);
      const up = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-panels', 'latex-resizing');
        handle.removeEventListener('pointermove', move);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    addEventListener('resize', () => { if (!$('#latex-dock').hidden) fit(); });
  }

  // --- the quote card --------------------------------------------------------------------------
  function lines(quote) {
    const name = quote.path.split('/').pop();
    return quote.fromLine === quote.toLine
      ? t('{path} 第 {line} 行', { path: name, line: quote.fromLine })
      : t('{path} 第 {from}–{to} 行', { path: name, from: quote.fromLine, to: quote.toLine });
  }
  // A conversation's quotes: the live one follows what is selected in the editor and leaves with the
  // selection; the kept ones stay until they are sent or removed, also across a page reload.
  const sameQuote = (a, b) => a.path === b.path && a.fromLine === b.fromLine && a.toLine === b.toLine && a.text === b.text;
  function quotesOf(id) {
    if (!quotes.has(id)) {
      let pinned = [];
      try { pinned = JSON.parse(localStorage.getItem(KEPT + id)) || []; } catch {}
      quotes.set(id, { live: null, pinned: Array.isArray(pinned) ? pinned.filter(q => typeof q?.path === 'string' && typeof q?.text === 'string') : [] });
    }
    return quotes.get(id);
  }
  function saveKept(id) {
    const { pinned } = quotesOf(id);
    try { if (pinned.length) localStorage.setItem(KEPT + id, JSON.stringify(pinned)); else localStorage.removeItem(KEPT + id); } catch {}
  }
  // The selection is not shown a second time when that very passage is already kept.
  function shown(id) {
    const { live, pinned } = quotesOf(id);
    return { pinned, live: live && !pinned.some(quote => sameQuote(quote, live)) ? live : null };
  }
  function keep(id, quote) {
    const entry = quotesOf(id);
    if (!entry.pinned.some(item => sameQuote(item, quote))) {
      if (entry.pinned.length >= MAX_KEPT) { toast('最多保留 {count} 段引用', { count: MAX_KEPT }); return; }
      if (entry.pinned.reduce((sum, item) => sum + item.text.length, quote.text.length) > MAX_KEPT_CHARS) { toast('保留的引用太长了，先移除一些'); return; }
      entry.pinned.push(quote);
      saveKept(id);
    }
    if (entry.live && sameQuote(entry.live, quote)) entry.live = null;
    if (id === state.chat?.id) renderQuote();
  }
  const readQuote = data => ({ path: data.path, fromLine: Number(data.fromLine) || 1, toLine: Number(data.toLine) || Number(data.fromLine) || 1, text: data.text.slice(0, 20000) });
  const PIN_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 4H6l3-4z"/></svg>';
  const keepKey = () => (/Mac/.test(globalThis.navigator?.platform || '') ? '⌘ L' : 'Ctrl L');
  function quoteChip(id, quote, kept) {
    const open = el('button', { type: 'button', class: 'quote-open', title: t('在编辑器里显示') + '\n' + quote.path }, [
      el('span', { class: 'quote-mark', 'aria-hidden': 'true', text: 'TeX' }),
      el('span', { class: 'quote-label', text: lines(quote) }),
      el('span', { class: 'quote-preview', text: quote.text.trim().split('\n')[0].slice(0, 120) })
    ]);
    open.onclick = () => {
      const pref = prefs[id];
      if (!pref?.open) { setPref(id, { open: true, place: pref?.place || lastPlace() }); if (prefs[id].place === 'window') openWindow(id); sync(); }
      post({ type: 'reveal', chatId: id, path: quote.path, line: quote.fromLine });
    };
    const remove = el('button', { type: 'button', class: 'attachment-remove', text: '×', 'aria-label': t('移除引用') });
    remove.onclick = () => {
      const entry = quotesOf(id);
      if (kept) { entry.pinned = entry.pinned.filter(item => item !== quote); saveKept(id); } else entry.live = null;
      renderQuote();
      $('#prompt').focus();
    };
    const parts = [open];
    if (!kept) {
      const pin = el('button', { type: 'button', class: 'quote-keep', title: t('保留这段引用，可以继续框选别处 · {key}', { key: keepKey() }), 'aria-label': t('保留这段引用') });
      pin.innerHTML = PIN_ICON;
      pin.append(el('kbd', { text: keepKey() }));
      pin.onclick = () => { keep(id, quote); $('#prompt').focus(); };
      parts.push(pin);
    }
    parts.push(remove);
    return el('div', { class: 'attachment-chip quote-chip' + (kept ? ' kept' : ' live') }, parts);
  }
  function renderQuote() {
    const box = $('#composer-quote');
    if (!box) return;
    const id = state.chat?.id, { live, pinned } = id ? shown(id) : { live: null, pinned: [] };
    box.hidden = !live && !pinned.length;
    box.replaceChildren(...pinned.map(quote => quoteChip(id, quote, true)), ...(live ? [quoteChip(id, live, false)] : []));
  }

  // What the message says in front of the user's own words. A fence longer than any backtick run
  // in the selection keeps it intact.
  function quoteText(quote) {
    const longest = Math.max(2, ...(quote.text.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    const where = quote.fromLine === quote.toLine ? t('第 {line} 行', { line: quote.fromLine }) : t('第 {from}–{to} 行', { from: quote.fromLine, to: quote.toLine });
    return `> ${t('引用')} \`${quote.path}\` ${where}\n\n${fence}latex\n${quote.text.replace(/\n+$/, '')}\n${fence}\n\n`;
  }
  // Called by the senders (app-send.js, workflows.js): the text to send, with the cards in front,
  // the kept ones first and then what is selected now.
  function withQuote(id, text) {
    const { live, pinned } = shown(id), all = live ? [...pinned, live] : pinned;
    return all.length ? all.map(quoteText).join('') + (text.trim() ? text : t(all.length > 1 ? '请看这几段源码。' : '请看这段源码。')) : text;
  }
  function has(id) { const { live, pinned } = shown(id); return !!live || pinned.length > 0; }
  function sent(id) {
    const entry = quotesOf(id), had = !!entry.live || entry.pinned.length > 0;
    entry.live = null; entry.pinned = [];
    saveKept(id);
    if (had) renderQuote();
  }

  channel?.addEventListener('message', ({ data }) => {
    const id = data?.chatId;
    if (!id || typeof id !== 'string') return;
    if (data.type === 'selection' && typeof data.text === 'string' && typeof data.path === 'string') {
      quotesOf(id).live = readQuote(data);
      if (id === state.chat?.id) renderQuote();
    } else if (data.type === 'selection-clear') {
      quotesOf(id).live = null;
      if (id === state.chat?.id) renderQuote();
    } else if (data.type === 'keep' && typeof data.text === 'string' && typeof data.path === 'string') {
      keep(id, readQuote(data));
    } else if (data.type === 'attachment' && typeof data.attachment?.id === 'string' && data.attachment.kind === 'image') {
      try {
        if (globalThis.StarportComposer?.attach(data.attachment, draftKey(id)) && id === state.chat?.id && document.hasFocus()) $('#prompt')?.focus({ preventScroll: true });
      } catch (error) { toast(error.message); }
    } else if (data.type === 'dock' && ['left', 'right', 'window'].includes(data.place)) {
      localStorage.setItem(PLACE, data.place);
      setPref(id, { open: true, place: data.place });
      if (data.place === 'window') { sync(); return; }
      // Docking from the window brings its conversation up here first.
      const ready = state.chat?.id === id ? Promise.resolve() : openChat(id);
      ready.then(() => { sync(); post({ type: 'docked', chatId: id }); }).catch(error => toast(error.message));
    } else if (data.type === 'close') {
      if (prefs[id]) setPref(id, { ...prefs[id], open: false });
      sync();
    } else if (data.type === 'opened' && data.place === 'window') {
      setPref(id, { open: true, place: 'window' });
      sync();
    } else if (data.type === 'closed' && data.place === 'window' && prefs[id]?.place === 'window') {
      setPref(id, { ...prefs[id], open: false });
      sync();
    }
  });

  // Ctrl L from the input box keeps what is selected; inside the editor its page handles the key.
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'l') return;
    const id = state.chat?.id, live = id ? shown(id).live : null;
    if (!live) return;
    event.preventDefault();
    keep(id, live);
  });
  document.addEventListener('DOMContentLoaded', () => {
    $('#latex-toggle')?.addEventListener('click', toggle);
    setupResizer();
    sync();
  });
  return { sync, toggle, withQuote, has, sent, quoteText };
})();
