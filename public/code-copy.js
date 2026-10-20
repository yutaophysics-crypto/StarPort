'use strict';
// A quiet copy button on every code box: fenced code in replies, tool input and output.
globalThis.StarportCodeCopy = (() => {
  const t = (text, values) => globalThis.StarportI18n?.t(text, values) ?? text;
  const svg = body =>
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
    done: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>')
  };

  // Marked ends fenced code with one newline that was never part of the code.
  const source = pre => pre.textContent.replace(/\n$/, '');

  async function write(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    // Plain http from another device has no async clipboard; fall back to a hidden selection.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {}
    area.remove();
    return copied;
  }

  function button(pre) {
    const node = document.createElement('button');
    const label = document.createElement('span');
    let timer;
    const show = state => {
      node.dataset.state = state;
      node.innerHTML = state === 'done' ? ICONS.done : ICONS.copy;
      label.textContent = t(state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : '复制');
      node.append(label);
    };
    node.type = 'button';
    node.className = 'code-copy';
    node.title = t('复制代码');
    node.setAttribute('aria-label', t('复制代码'));
    show('idle');
    node.onclick = async () => {
      const ok = await write(source(pre));
      node.focus({ preventScroll: true });
      show(ok ? 'done' : 'failed');
      clearTimeout(timer);
      timer = setTimeout(() => show('idle'), ok ? 1600 : 2400);
    };
    return node;
  }

  function decorate(root) {
    for (const pre of root?.querySelectorAll?.('pre') || []) {
      if (pre.parentElement?.classList.contains('code-box')) continue;
      const box = document.createElement('div');
      box.className = 'code-box';
      pre.replaceWith(box);
      box.append(pre, button(pre));
    }
    return root;
  }

  return { decorate, source };
})();
