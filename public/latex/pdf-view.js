// The PDF pane: pdf.js's page viewer, with text selection and working links. A new build replaces
// the document in place, keeping the zoom and the scroll position; SyncTeX boxes light briefly.
let lib = null, components = null;
async function libraries() {
  if (!lib) {
    lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    // The viewer components read the core library from this global.
    globalThis.pdfjsLib = lib;
    components = await import('/vendor/pdfjs/pdf_viewer.min.mjs');
  }
  return { lib, components };
}

// The first page of a small PDF (one picture) as an image, on the white it was drawn for.
export async function pdfToImage(data, scale = 2.5) {
  const { lib } = await libraries();
  const doc = await lib.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
  try {
    const page = await doc.getPage(1), viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { src: canvas.toDataURL('image/png'), width: viewport.width / scale, height: viewport.height / scale };
  } finally { doc.destroy(); }
}

export async function createPdf({ container, viewerEl, zoomLabel, token, onPoint }) {
  const { lib, components } = await libraries();
  const eventBus = new components.EventBus();
  const linkService = new components.PDFLinkService({ eventBus, externalLinkTarget: components.LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
  const viewer = new components.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, textLayerMode: 1, removePageBorders: false });
  linkService.setViewer(viewer);
  // generation: each open or close supersedes the ones before it, so a document that is still
  // loading when another arrives (or the pane is emptied) is dropped instead of left half shown.
  // A loading task destroyed early never settles, so a superseded open is let go through `dropped`.
  let doc = null, task = null, shownTask = null, generation = 0, supersede = () => {}, mode = 'page-width', pendingBoxes = null, pendingScale = null;

  eventBus.on('scalechanging', event => { zoomLabel.textContent = Math.round(event.scale * 100) + '%'; });
  // A hidden pane (the other view, or a frame being taken down) has no size to fit.
  // A document opened while the pane was hidden is fitted once it shows.
  new ResizeObserver(() => {
    if (!doc || !container.offsetParent) return;
    if (pendingScale) { viewer.currentScaleValue = pendingScale; pendingScale = null; }
    else if (mode === 'page-width') viewer.currentScaleValue = 'page-width';
  }).observe(container);
  container.addEventListener('wheel', event => {
    if (!event.ctrlKey || !doc) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  // Double-click a word in the PDF to find the source line that made it.
  viewerEl.addEventListener('dblclick', event => {
    const pageEl = event.target.closest?.('.page');
    if (!pageEl || !doc) return;
    const number = Number(pageEl.dataset.pageNumber), page = viewer.getPageView(number - 1);
    if (!page?.viewport) return;
    const rect = pageEl.getBoundingClientRect(), [x, y] = page.viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
    const [left, , , top] = page.pdfPage.view;
    getSelection()?.removeAllRanges();
    onPoint({ page: number, x: x - left, y: top - y });
  });

  function zoom(factor) {
    mode = 'custom';
    viewer.currentScale = Math.min(5, Math.max(0.25, viewer.currentScale * factor));
  }
  function showBoxes(boxes) {
    if (!doc || !boxes?.length) return;
    const first = boxes[0], page = viewer.getPageView(first.page - 1);
    if (!page) return;
    if (!page.viewport || !page.div.isConnected) { pendingBoxes = boxes; return; }
    const [left, , , top] = page.pdfPage.view;
    viewer.scrollPageIntoView({ pageNumber: first.page, destArray: [null, { name: 'XYZ' }, left + Math.max(0, first.left - 24), top - Math.max(0, first.top - 60), null], allowNegativeOffset: true });
    for (const box of boxes.filter(b => b.page === first.page)) {
      const [x1, y1] = page.viewport.convertToViewportPoint(left + box.left, top - box.top);
      const [x2, y2] = page.viewport.convertToViewportPoint(left + box.left + box.width, top - box.top - box.height);
      const div = document.createElement('div');
      div.className = 'sync-box';
      Object.assign(div.style, { left: Math.min(x1, x2) - 2 + 'px', top: Math.min(y1, y2) - 2 + 'px', width: Math.abs(x2 - x1) + 4 + 'px', height: Math.abs(y2 - y1) + 4 + 'px' });
      page.div.append(div);
      setTimeout(() => div.remove(), 2600);
    }
  }
  eventBus.on('pagesinit', () => { if (pendingBoxes) { const boxes = pendingBoxes; pendingBoxes = null; requestAnimationFrame(() => showBoxes(boxes)); } });

  return {
    get loaded() { return !!doc; },
    // True once the document is on show; false when something newer came first.
    async open(url) {
      const mine = ++generation;
      supersede();
      const dropped = new Promise(resolve => { supersede = () => resolve(null); });
      if (task && task !== shownTask) task.destroy();
      const loading = (task = lib.getDocument({ url, httpHeaders: { 'X-Hub-Token': token() }, isEvalSupported: false, enableXfa: false }));
      let next;
      try { next = await Promise.race([loading.promise, dropped]); }
      catch (error) { if (mine !== generation) return false; throw error; }
      if (mine !== generation || !next) { loading.destroy(); return false; }
      const keep = doc ? { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft } : null;
      const old = doc;
      doc = next; shownTask = loading;
      // pdf.js says when the pages are laid out; a document dropped meanwhile never says so.
      const ready = new Promise(resolve => { eventBus.on('pagesinit', resolve, { once: true }); setTimeout(resolve, 10000); });
      viewer.setDocument(next);
      linkService.setDocument(next, null);
      old?.destroy();
      await Promise.race([ready, dropped]);
      if (mine !== generation) return false;
      if (container.offsetParent) {
        viewer.currentScaleValue = keep?.scale || 'page-width';
        if (keep) { container.scrollTop = keep.top; container.scrollLeft = keep.left; }
      } else pendingScale = keep?.scale || 'page-width';
      return true;
    },
    // A box of the built PDF (points from the page's top left) as an image.
    async crop(box, scale = 2.5) {
      if (!doc) return null;
      const page = await doc.getPage(box.page), viewport = page.getViewport({ scale }), full = document.createElement('canvas');
      full.width = Math.ceil(viewport.width); full.height = Math.ceil(viewport.height);
      await page.render({ canvas: full, canvasContext: full.getContext('2d'), viewport }).promise;
      const pad = 3, cut = document.createElement('canvas');
      cut.width = Math.ceil((box.width + 2 * pad) * scale); cut.height = Math.ceil((box.height + 2 * pad) * scale);
      cut.getContext('2d').drawImage(full, (box.left - pad) * scale, (box.top - pad) * scale, cut.width, cut.height, 0, 0, cut.width, cut.height);
      return { src: cut.toDataURL('image/png'), width: box.width + 2 * pad, height: box.height + 2 * pad };
    },
    // A box drawn on a page (CSS pixels from the page's top left, as shown now) as a sharp picture:
    // the region is drawn again from the PDF at about 3000 pixels on its long side, on white.
    async snip(number, rect) {
      const view = viewer.getPageView(number - 1);
      if (!doc || !view?.viewport) return null;
      const a = view.viewport.convertToPdfPoint(rect.x, rect.y), b = view.viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height);
      const size = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      const scale = Math.min(4, Math.max(2, 3000 / size));
      const page = await doc.getPage(number), viewport = page.getViewport({ scale, rotation: view.viewport.rotation });
      const [x1, y1] = viewport.convertToViewportPoint(...a), [x2, y2] = viewport.convertToViewportPoint(...b);
      const left = Math.floor(Math.min(x1, x2)), top = Math.floor(Math.min(y1, y2));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(Math.max(x1, x2)) - left); canvas.height = Math.max(1, Math.ceil(Math.max(y1, y2)) - top);
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -left, -top] }).promise;
      return canvas;
    },
    // Nothing shown: the main file changed and its PDF is not built yet.
    close() {
      generation++;
      supersede();
      if (task && task !== shownTask) task.destroy();
      task = null; pendingBoxes = null;
      if (!doc) return;
      const old = doc;
      doc = null; shownTask = null;
      viewer.setDocument(null);
      linkService.setDocument(null, null);
      old.destroy();
    },
    zoomIn: () => zoom(1.15),
    zoomOut: () => zoom(1 / 1.15),
    fit() { mode = 'page-width'; if (doc) viewer.currentScaleValue = 'page-width'; },
    showBoxes
  };
}
