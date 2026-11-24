// Drag a box over the PDF to attach that region to the conversation's input box as a picture.
// The scissors in the PDF bar arm one drag; holding Alt draws a box at any time. Esc lets go.
export function createSnip({ container, viewerEl, button, pdf, onSnip, onError }) {
  let armed = false, drag = null, scrollFrame = 0, swallowClick = false;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function arm(on) {
    armed = on;
    button.setAttribute('aria-pressed', String(on));
    container.classList.toggle('snipping', on);
  }
  const altHeld = on => container.classList.toggle('snipping-alt', on);

  function point(event, pageEl) {
    const r = pageEl.getBoundingClientRect();
    return {
      x: clamp(event.clientX - r.left - pageEl.clientLeft, 0, pageEl.clientWidth),
      y: clamp(event.clientY - r.top - pageEl.clientTop, 0, pageEl.clientHeight)
    };
  }
  function draw() {
    const { origin, at, box } = drag;
    drag.rect = { x: Math.min(origin.x, at.x), y: Math.min(origin.y, at.y), width: Math.abs(at.x - origin.x), height: Math.abs(at.y - origin.y) };
    Object.assign(box.style, { left: drag.rect.x + 'px', top: drag.rect.y + 'px', width: drag.rect.width + 'px', height: drag.rect.height + 'px' });
  }
  // Near the pane's top or bottom edge the PDF scrolls, so a tall figure can be taken in one drag.
  function edgeScroll() {
    scrollFrame = 0;
    if (!drag) return;
    const r = container.getBoundingClientRect(), y = drag.clientY, edge = 28;
    const step = y < r.top + edge ? -(r.top + edge - y) : y > r.bottom - edge ? y - (r.bottom - edge) : 0;
    if (!step) return;
    container.scrollTop += clamp(step, -24, 24);
    drag.at = point({ clientX: drag.clientX, clientY: drag.clientY }, drag.pageEl);
    draw();
    scrollFrame = requestAnimationFrame(edgeScroll);
  }
  function stop() {
    cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    document.body.classList.remove('dragging');
    const done = drag; drag = null;
    return done;
  }
  function cancel() { stop()?.box.remove(); }

  viewerEl.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !(armed || event.altKey) || !pdf()?.loaded) return;
    const pageEl = event.target.closest?.('.page'), number = Number(pageEl?.dataset.pageNumber);
    if (!pageEl || !number) return;
    event.preventDefault(); event.stopPropagation();
    getSelection()?.removeAllRanges();
    container.focus({ preventScroll: true });
    const origin = point(event, pageEl), box = document.createElement('div');
    box.className = 'snip-box';
    pageEl.append(box);
    drag = { pageEl, number, origin, at: origin, box, clientX: event.clientX, clientY: event.clientY };
    draw();
    viewerEl.setPointerCapture(event.pointerId);
    document.body.classList.add('dragging');
  }, true);
  viewerEl.addEventListener('pointermove', event => {
    if (!drag) return;
    drag.clientX = event.clientX; drag.clientY = event.clientY;
    drag.at = point(event, drag.pageEl);
    draw();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(edgeScroll);
  });
  viewerEl.addEventListener('pointerup', async () => {
    const done = stop();
    if (!done) return;
    // A click, not a box: nothing is taken and the scissors stay ready.
    if (done.rect.width < 6 || done.rect.height < 6) { done.box.remove(); return; }
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 0);
    arm(false);
    done.box.classList.add('taking');
    try {
      const canvas = await pdf().snip(done.number, done.rect);
      if (canvas) await onSnip({ page: done.number, canvas });
      done.box.classList.replace('taking', 'taken');
      setTimeout(() => done.box.remove(), 650);
    } catch (error) {
      done.box.remove();
      onError(error);
    }
  });
  viewerEl.addEventListener('pointercancel', cancel);
  // The click that ends a drag must not follow a link under the pointer.
  viewerEl.addEventListener('click', event => { if (swallowClick) { event.preventDefault(); event.stopPropagation(); } }, true);

  button.addEventListener('click', () => arm(!armed));
  addEventListener('keydown', event => {
    if (event.key === 'Alt') altHeld(true);
    if (event.key === 'Escape' && (drag || armed)) { cancel(); arm(false); event.preventDefault(); }
  });
  addEventListener('keyup', event => { if (event.key === 'Alt') altHeld(false); });
  addEventListener('blur', () => { altHeld(false); cancel(); });
  return { arm, get armed() { return armed; } };
}
