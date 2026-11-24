'use strict';
// Text selected in the conversation: 翻译/解释 by a small model in a new hidden chat each time,
// or 朗读 with the browser's own voices. The explain model and prompt live in 设置 → 划词.
globalThis.StarportSelection = (() => {
  const ui = globalThis.StarportUI;
  const conversation = document.getElementById('conversation');
  const OFF_KEY = 'starport-selection-tools';
  const MAX_EXPLAIN = 4000;
  const svg = body =>
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    explain: svg('<path d="M4 5.5h9M8.5 4v1.5M6 5.5c.6 2.7 2.5 4.9 5 6M11 5.5c-.7 3.3-3 5.9-6 7"/><path d="m12.5 20 3.8-9 3.7 9M13.8 17h5"/>'),
    speak: svg('<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.6"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
    settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    retry: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    close: svg('<path d="M7 7l10 10M17 7 7 17"/>')
  };
  const el = (tag, attrs = {}, children = []) => ui.el(tag, attrs, children);
  const iconNode = name => {
    const node = el('span', { class: 'selection-icon', 'aria-hidden': 'true' });
    node.innerHTML = ICONS[name];
    return node;
  };
  const tool = (name, label, onclick, extra = {}) =>
    el('button', { type: 'button', class: 'selection-tool', title: t(label), 'aria-label': t(label), onclick, ...extra }, [iconNode(name)]);

  const enabled = () => localStorage.getItem(OFF_KEY) !== 'off';
  let bar = null, card = null, request = null, selection = null;

  // --- the small toolbar beside a selection -------------------------------------------------
  function currentSelection() {
    const native = getSelection();
    if (!native?.rangeCount || native.isCollapsed) return null;
    const range = native.getRangeAt(0), node = range.commonAncestorContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !conversation.contains(element) || element.closest('textarea, input, select, [contenteditable="true"]')) return null;
    const text = native.toString().replace(/ /g, ' ').trim();
    if (!text) return null;
    const rects = [...range.getClientRects()].filter(r => r.width || r.height);
    const box = range.getBoundingClientRect();
    return { text, box, first: rects[0] || box, last: rects.at(-1) || box };
  }
  function place(node, box, { gap = 8, prefer = 'above' } = {}) {
    const width = node.offsetWidth, height = node.offsetHeight, margin = 8;
    const above = box.top - gap - height, below = box.bottom + gap;
    const fitsAbove = above >= margin, fitsBelow = below + height <= innerHeight - margin;
    const top = prefer === 'above' ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above);
    const left = box.left + box.width / 2 - width / 2;
    node.style.top = Math.round(Math.max(margin, Math.min(innerHeight - height - margin, top))) + 'px';
    node.style.left = Math.round(Math.max(margin, Math.min(innerWidth - width - margin, left))) + 'px';
  }
  function hideBar() { bar?.remove(); bar = null; }
  function showBar() {
    const next = enabled() ? currentSelection() : null;
    if (!next) return hideBar();
    selection = next;
    hideBar();
    const long = next.text.length > MAX_EXPLAIN;
    bar = el('div', { class: 'chat-actions-menu selection-bar', role: 'toolbar', 'aria-label': t('选中的文字') }, [
      el('button', { type: 'button', class: 'selection-action', disabled: long, title: long ? t('选中的文字太长，最多 {count} 个字符', { count: MAX_EXPLAIN }) : null,
        onclick: () => explain(selection) }, [iconNode('explain'), el('span', { text: t('翻译/解释') })]),
      el('button', { type: 'button', class: 'selection-action', onclick: () => { hideBar(); speech.speak(selection.text); } },
        [iconNode('speak'), el('span', { text: t('朗读') })])
    ]);
    // Clicking the toolbar must not clear the selection it acts on.
    bar.addEventListener('mousedown', event => event.preventDefault());
    document.body.append(bar);
    place(bar, { top: next.first.top, bottom: next.last.bottom, left: next.box.left, width: next.box.width });
  }
  const later = () => setTimeout(showBar, 0);
  document.addEventListener('mouseup', event => { if (!bar?.contains(event.target) && !card?.contains(event.target)) later(); });
  document.addEventListener('keyup', event => { if (event.shiftKey || event.key === 'Shift') later(); });
  document.addEventListener('touchend', event => { if (!bar?.contains(event.target) && !card?.contains(event.target)) setTimeout(showBar, 350); });
  document.addEventListener('selectionchange', () => { if (bar && getSelection()?.isCollapsed) hideBar(); });
  conversation.addEventListener('scroll', hideBar, { passive: true });
  addEventListener('resize', () => { hideBar(); closeCard(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !(bar || card)) return;
    if (document.querySelector('dialog[open]')) return;
    hideBar(); closeCard();
  });
  document.addEventListener('pointerdown', event => {
    if (card && !card.contains(event.target) && !bar?.contains(event.target)) closeCard();
  }, true);

  // --- 翻译/解释 ----------------------------------------------------------------------------
  let settingsCache = null;
  const modelLabel = s => [ui.PROVIDER_LABELS[s.provider] || s.provider, s.model || t('默认模型')].join(' · ');
  function closeCard() {
    request?.abort(); request = null;
    card?.remove(); card = null;
  }
  async function post(path, data, signal, retried = false) {
    const response = await fetch('/api' + path, { method: 'POST', signal, headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await response.json().catch(() => ({}));
    if ([401, 403].includes(response.status) && !retried && TOKEN_REJECTED.test(body.error || '') && (await refreshLocalToken())) return post(path, data, signal, true);
    if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
    return body;
  }
  async function explain(target) {
    if (!target) return;
    hideBar(); closeCard();
    const controller = new AbortController();
    request = controller;
    const body = el('div', { class: 'selection-card-body', 'aria-live': 'polite' });
    const meta = el('span', { class: 'selection-card-model' });
    const speakButton = tool('speak', '朗读解释', () => speech.speak(body.innerText), { disabled: true });
    const copyButton = tool('copy', '复制解释', async () => {
      try { await navigator.clipboard.writeText(body.innerText.trim()); toast(t('已复制')); } catch { toast(t('复制失败')); }
    }, { disabled: true });
    card = el('section', { class: 'chat-actions-menu selection-card', role: 'dialog', 'aria-label': t('翻译/解释') }, [
      el('header', { class: 'selection-card-head' }, [
        el('q', { class: 'selection-card-source', text: target.text.replace(/\s+/g, ' '), title: target.text.slice(0, 500) }),
        el('div', { class: 'selection-card-tools' }, [speakButton, copyButton,
          tool('settings', '翻译/解释设置', () => { closeCard(); openSettings(); }),
          tool('close', '关闭', closeCard)])
      ]),
      body,
      el('footer', { class: 'selection-card-foot' }, [meta])
    ]);
    const thisCard = card;
    document.body.append(card);
    const loading = () => {
      body.replaceChildren(el('p', { class: 'selection-card-status' }, [el('span', { class: 'selection-pulse', 'aria-hidden': 'true' }), el('span', { text: t('正在解释…') }),
        el('button', { type: 'button', class: 'room-text-action', text: t('停止'), onclick: closeCard })]));
      place(thisCard, target.box, { gap: 10, prefer: 'below' });
    };
    loading();
    if (settingsCache) meta.textContent = modelLabel(settingsCache);
    else api('/explain/settings').then(s => { settingsCache = s; if (!meta.textContent) meta.textContent = modelLabel(s); }).catch(() => {});
    try {
      const result = await post('/explain', { text: target.text }, controller.signal);
      if (card !== thisCard) return;
      meta.textContent = modelLabel(result);
      body.replaceChildren(markdown(result.text));
      speakButton.disabled = copyButton.disabled = false;
    } catch (error) {
      if (controller.signal.aborted || card !== thisCard) return;
      body.replaceChildren(el('p', { class: 'selection-card-error', role: 'alert', text: notice(error.message) }),
        el('button', { type: 'button', class: 'room-text-action', onclick: () => explain(target) }, [iconNode('retry'), el('span', { text: t('重试') })]));
    } finally {
      if (request === controller) request = null;
    }
    if (card === thisCard) place(thisCard, target.box, { gap: 10, prefer: 'below' });
  }

  // --- 朗读 ----------------------------------------------------------------------------------
  const speech = (() => {
    const synth = globalThis.speechSynthesis;
    let voices = [], pill = null, session = 0;
    const load = () => { voices = synth?.getVoices() || []; };
    synth?.addEventListener?.('voiceschanged', load);
    load();
    // The script with the most characters decides the voice; mixed text reads well in either.
    function language(text) {
      const count = re => (text.match(re) || []).length;
      const kana = count(/[぀-ヿ]/g), hangul = count(/[가-힯]/g), han = count(/[一-鿿]/g), latin = count(/[A-Za-z]/g);
      if (kana && kana * 3 >= han) return 'ja';
      if (hangul && hangul * 4 >= latin) return 'ko';
      if (han && han * 4 >= latin) return 'zh';
      return 'en';
    }
    function voiceFor(lang) {
      const all = voices.filter(v => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
      const main = { zh: /zh-cn|cmn/i, en: /en-us/i }[lang];
      const pool = (main && all.filter(v => main.test(v.lang.replace('_', '-'))).length ? all.filter(v => main.test(v.lang.replace('_', '-'))) : all);
      return pool.find(v => /natural/i.test(v.name)) || pool.find(v => /online|neural/i.test(v.name)) || pool.find(v => v.localService) || pool[0] || null;
    }
    // Some voices stop after about 15 seconds of one utterance, so read sentence by sentence.
    function pieces(text, size = 220) {
      const out = [];
      for (const sentence of text.replace(/\s+/g, ' ').match(/[^。！？!?；;.\n]+[。！？!?；;.\n]*\s*/g) || []) {
        for (let rest = sentence; rest; rest = rest.slice(size)) {
          const part = rest.slice(0, size);
          if (out.length && (out.at(-1) + part).length <= size) out[out.length - 1] += part; else out.push(part);
        }
      }
      return out.map(part => part.trim()).filter(Boolean);
    }
    function hidePill() { pill?.remove(); pill = null; }
    function showPill() {
      hidePill();
      pill = el('div', { class: 'chat-actions-menu selection-speaking', role: 'status' }, [
        el('span', { class: 'selection-wave', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]),
        el('span', { text: t('正在朗读') }),
        el('button', { type: 'button', class: 'selection-action', onclick: stop }, [iconNode('stop'), el('span', { text: t('停止') })])
      ]);
      document.body.append(pill);
    }
    function stop() { session++; synth?.cancel(); hidePill(); }
    function speak(text) {
      if (!synth || !globalThis.SpeechSynthesisUtterance) { toast(t('这个浏览器不支持朗读')); return; }
      stop();
      const id = session, lang = language(text), voice = voiceFor(lang), parts = pieces(text);
      if (!parts.length) return;
      showPill();
      parts.forEach((part, index) => {
        const utterance = new SpeechSynthesisUtterance(part);
        utterance.lang = voice?.lang || { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' }[lang];
        if (voice) utterance.voice = voice;
        if (index === parts.length - 1) utterance.onend = () => { if (session === id) hidePill(); };
        utterance.onerror = event => {
          if (session !== id || ['interrupted', 'canceled'].includes(event.error)) return;
          stop(); toast(t('朗读失败：{error}', { error: event.error || '' }));
        };
        synth.speak(utterance);
      });
    }
    addEventListener('pagehide', () => synth?.cancel());
    return { speak, stop, get speaking() { return !!pill; } };
  })();

  // --- 设置 → 划词 --------------------------------------------------------------------------
  const field = (label, control, hint = '') => ui.field(t(label), control, hint ? t(hint) : '');
  async function openSettings() {
    let settings;
    try { settings = await api('/explain/settings'); } catch (error) { toast(error.message); return; }
    settingsCache = settings;
    let picker;
    const pickerRow = el('div', { class: 'selection-picker' });
    const drawPicker = ({ provider, model, effort, service }) => {
      picker = ui.modelPicker({ provider, model, effort, service });
      pickerRow.replaceChildren(picker.provider, picker.model, picker.effort);
    };
    drawPicker(settings);
    const prompt = el('textarea', { rows: '3', maxlength: '2000' });
    prompt.value = settings.prompt;
    ui.showDialog({
      eyebrow: t('划词'),
      title: t('翻译/解释'),
      body: [
        el('p', { class: 'room-dialog-note', text: t('每次点「翻译/解释」都会新开一个临时对话，只发送下面的提示词和选中的文字，用完即删。不带长期记忆、项目要求和对话历史；原工具自带的系统提示仍然生效。') }),
        el('div', { class: 'room-field' }, [
          el('div', { class: 'room-field-head' }, [
            el('span', { class: 'room-field-label', text: t('模型') }),
            ui.textAction(t('恢复默认'), () => drawPicker(settings.defaults))
          ]),
          pickerRow,
          el('span', { class: 'room-field-hint', text: t('默认：{model}。小模型更快，也更省额度。', { model: modelLabel(settings.defaults) }) })
        ]),
        el('div', { class: 'room-field' }, [
          el('div', { class: 'room-field-head' }, [
            el('span', { class: 'room-field-label', text: t('提示词') }),
            ui.textAction(t('恢复默认'), () => { prompt.value = settings.defaults.prompt; })
          ]),
          prompt,
          el('span', { class: 'room-field-hint', text: t('模型收到的是：提示词，空一行，再接选中的文字。') })
        ])
      ],
      footer: [
        el('button', { type: 'button', class: 'secondary-button', text: t('取消'), onclick: ui.closeDialog }),
        el('button', { type: 'submit', class: 'primary-button', text: t('保存') })
      ],
      onsubmit: async () => {
        settingsCache = await api('/explain/settings', 'PUT', { ...picker.value(), prompt: prompt.value });
        toast(t('已保存翻译/解释设置'));
        ui.closeDialog();
      }
    });
  }

  const toggle = document.getElementById('selection-tools-enabled');
  const sync = () => toggle?.setAttribute('aria-checked', String(enabled()));
  toggle?.addEventListener('click', () => {
    localStorage.setItem(OFF_KEY, enabled() ? 'off' : 'on');
    sync();
    if (!enabled()) hideBar();
  });
  sync();
  document.getElementById('open-explain-settings')?.addEventListener('click', () => {
    document.getElementById('settings-dialog')?.close();
    openSettings();
  });

  return { explain, speak: text => speech.speak(text), stop: () => speech.stop(), openSettings };
})();
