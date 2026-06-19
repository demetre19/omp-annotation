(() => {
  if (window.__ompSessionAnnotator) {
    window.__ompSessionAnnotator.show();
    return window.__ompSessionAnnotator;
  }

  hydrateEmptyStylesheets();
  const storageKey = `omp-session-annotator:${location.origin}${location.pathname}`;
  const storedState = loadStoredState();
  const BRIDGE_PORT_START = 47871;
  const BRIDGE_PORT_END = 47890;
  const bridge = {
    port: Number(storedState?.bridge?.port || 0) || null,
    token: storedState?.bridge?.token || null
  };


  const state = {
    active: true,
    done: false,
    mode: storedState?.mode === 'box' ? 'box' : 'element',
    annotations: Array.isArray(storedState?.annotations) ? storedState.annotations : [],
    isDragging: false,
    dragStart: null,
    editingNoteId: null,
    noteTimers: new Map(),
    lastEnterId: null,
    lastEnterAt: 0
  };

  let toastTimer = 0;
  const ui = createOverlay();
  const api = {
    get active() { return state.active; },
    get done() { return state.done; },
    get annotations() { return state.annotations.slice(); },
    show,
    stop,
    finish,
    clear,
    configureBridge,
    drainOutbox,
    export() { return exportPayload(); },
    destroy() { ui.root.remove(); delete window.__ompSessionAnnotator; }
  };

  window.__ompSessionAnnotator = api;
  wireToolbar();
  wirePageEvents();
  updateUi();
  return api;

  function show() {
    state.active = true;
    state.done = false;
    updateUi();
    drawAnnotations();
  }

  function stop() {
    state.active = false;
    updateUi();
  }

  function finish() {
    queueAllAnnotations();
    state.active = false;
    state.done = true;
    persistState();
    updateUi();
    showToast(state.annotations.length ? 'Done queued. OMP can drain these annotations.' : 'Done saved. No annotations to send.');
    maybeNotifyBridge();
  }

  function clear() {
    state.annotations = [];
    state.editingNoteId = null;
    state.lastEnterId = null;
    state.lastEnterAt = 0;
    persistState();
    drawAnnotations();
    updateUi();
  }

  function configureBridge(config) {
    bridge.port = Number(config?.port || 0) || null;
    bridge.token = config?.token || null;
    persistState();
    if (bridge.port && bridge.token) showToast(`Bridge connected on ${bridge.port}.`);
  }

  function drainOutbox() {
    const queued = state.annotations.filter((annotation) => annotation.queuedAt && !annotation.deliveredAt);
    if (queued.length) {
      const deliveredAt = new Date().toISOString();
      for (const annotation of queued) annotation.deliveredAt = deliveredAt;
      persistState();
    }
    return {
      done: state.done,
      annotations: queued,
      export: exportPayload()
    };
  }

  async function hydrateEmptyStylesheets() {
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
    for (const link of links) {
      if (link.dataset.ompHydratedCss === '1') continue;
      let shouldHydrate = false;
      try {
        shouldHydrate = Boolean(link.sheet && link.sheet.cssRules && link.sheet.cssRules.length === 0);
      } catch (_) {
        shouldHydrate = false;
      }
      if (!shouldHydrate) continue;
      try {
        const response = await fetch(link.href, { cache: 'no-store', credentials: 'include' });
        if (!response.ok) continue;
        const css = await response.text();
        if (!css.trim()) continue;
        const style = document.createElement('style');
        style.dataset.ompHydratedFrom = link.href;
        style.textContent = css;
        link.after(style);
        link.dataset.ompHydratedCss = '1';
      } catch (_) {}
    }
  }

  function createOverlay() {
    const root = document.createElement('div');
    root.id = 'omp-session-annotation-root';
    root.style.all = 'initial';
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483647';
    document.documentElement.appendChild(root);

    const shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bar { position: fixed; left: 8px; right: 8px; top: 8px; display: flex; align-items: center; gap: 4px; height: 25px; padding: 2px 4px; border-radius: 8px; background: rgba(8, 11, 18, .86); color: #f8fafc; font: 10px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.12); backdrop-filter: blur(14px); pointer-events: auto; }
      .brand { display: inline-flex; align-items: center; gap: 4px; font-weight: 800; max-width: 72px; overflow: hidden; white-space: nowrap; }
      .dot { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); flex: none; }
      .spacer { flex: 1 1 auto; }
      .count { color: #fbbf24; font-weight: 900; min-width: 18px; text-align: right; }
      button { all: unset; display: inline-grid; place-items: center; height: 19px; min-width: 19px; padding: 0 5px; border-radius: 6px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1); color: #f8fafc; cursor: pointer; white-space: nowrap; font-weight: 700; }
      button:hover { border-color: rgba(245,158,11,.65); }
      button.active { background: #f59e0b; color: #111827; border-color: #fbbf24; }
      .outline { position: fixed; display: none; border: 2px solid #f59e0b; background: rgba(245,158,11,.12); border-radius: 6px; pointer-events: none; box-shadow: 0 0 0 99999px rgba(0,0,0,.1); }
      .outline.visible { display: block; }
      .drag { position: fixed; display: none; border: 2px dashed #38bdf8; background: rgba(56,189,248,.14); border-radius: 6px; pointer-events: none; }
      .drag.visible { display: block; }
      .pin { position: fixed; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; background: #f59e0b; color: #111827; font: 900 11px ui-sans-serif, system-ui; border: 2px solid #fff7ed; box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: none; transform: translate(-50%, -50%); }
      .box { position: fixed; border: 2px solid #f59e0b; background: rgba(245,158,11,.08); border-radius: 6px; pointer-events: none; }
      .note { position: fixed; display: grid; gap: 4px; width: min(320px, calc(100vw - 24px)); padding: 6px; border-radius: 10px; background: rgba(8,11,18,.94); border: 1px solid rgba(245,158,11,.7); box-shadow: 0 12px 34px rgba(0,0,0,.34); pointer-events: auto; }
      .note-head { display: grid; grid-template-columns: 1fr 18px; align-items: center; gap: 4px; }
      .note textarea { all: unset; min-height: 42px; max-height: 150px; overflow: auto; resize: vertical; color: #fff; font: 12px ui-sans-serif, system-ui; line-height: 1.35; }
      .note textarea::placeholder { color: #9ca3af; }
      .meta { color: #fbbf24; font: 800 11px ui-sans-serif, system-ui; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button.delete { width: 18px; min-width: 18px; height: 18px; padding: 0; border-radius: 999px; background: rgba(239,68,68,.18); color: #fecaca; border-color: rgba(248,113,113,.7); font: 900 12px ui-sans-serif, system-ui; }
      button.delete:hover { background: #ef4444; color: #fff; border-color: #fca5a5; }
      .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: none; max-width: min(520px, calc(100vw - 32px)); padding: 9px 11px; border-radius: 12px; background: rgba(14,17,23,.95); color: #f8fafc; font: 12px ui-sans-serif, system-ui; box-shadow: 0 14px 44px rgba(0,0,0,.38); border: 1px solid rgba(255,255,255,.16); pointer-events: none; }
      .fab { position: fixed; right: 12px; bottom: 12px; display: none; height: 24px; padding: 0 8px; border-radius: 999px; background: #f59e0b; color: #111827; font: 900 11px ui-sans-serif, system-ui; border: 1px solid #fbbf24; box-shadow: 0 10px 30px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer; }
      .toast.visible { display: block; }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<span class="brand"><span class="dot"></span>Ann</span><button data-mode="element" class="active" title="Element mode, E">E</button><button data-mode="box" title="Box mode, B">B</button><span class="spacer"></span><span class="count">0</span><button data-action="copy" title="Copy, C">C</button><button data-action="clear" title="Clear">Clr</button><button data-action="done" title="Done, D">Done</button><button data-action="stop" title="Stop, Esc">Esc</button>';

    const outline = document.createElement('div');
    outline.className = 'outline';
    const drag = document.createElement('div');
    drag.className = 'drag';
    const layer = document.createElement('div');
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.dataset.action = 'done';
    fab.title = 'Done, D';
    fab.textContent = 'Done';
    const toast = document.createElement('div');
    toast.className = 'toast';

    shadow.append(style, bar, outline, drag, layer, fab, toast);
    return {
      root,
      bar,
      outline,
      drag,
      layer,
      toast,
      fab,
      count: bar.querySelector('.count'),
      modeButtons: Array.from(bar.querySelectorAll('[data-mode]'))
    };
  }

  function wireToolbar() {
    ui.bar.addEventListener('click', (event) => {
      stopEvent(event);
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const modeButton = target.closest('[data-mode]');
      if (modeButton) {
        state.mode = modeButton.dataset.mode === 'box' ? 'box' : 'element';
        updateUi();
        return;
      }
      const actionButton = target.closest('[data-action]');
      if (actionButton) handleAction(actionButton.dataset.action);
    });
    const finishFromFab = (event) => {
      stopEvent(event);
      api.finish();
    };
    ui.fab.addEventListener('pointerdown', finishFromFab, true);
    ui.fab.addEventListener('mousedown', finishFromFab, true);
    ui.fab.addEventListener('click', finishFromFab, true);
    ui.bar.addEventListener('mousedown', stopEvent, true);
    ui.bar.addEventListener('mouseup', stopEvent, true);
  }

  function handleAction(action) {
    if (action === 'copy') copyAnnotations();
    if (action === 'clear') api.clear();
    if (action === 'done') api.finish();
    if (action === 'stop') api.stop();
  }

  function wirePageEvents() {
    document.addEventListener('keydown', (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape' && state.active) { api.stop(); stopEvent(event); return; }
      if (!state.active) return;
      const key = event.key.toLowerCase();
      if (key === 'e') { state.mode = 'element'; updateUi(); stopEvent(event); return; }
      if (key === 'b') { state.mode = 'box'; updateUi(); stopEvent(event); return; }
      if (key === 'c') { copyAnnotations(); stopEvent(event); return; }
      if (key === 'd') { api.finish(); stopEvent(event); }
    }, true);

    document.addEventListener('mousemove', (event) => {
      if (!state.active || isOverlayEvent(event)) return;
      if (state.isDragging) {
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
        return;
      }
      if (state.mode === 'element') drawHover(inspectElementAt(event.clientX, event.clientY));
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (!state.active || event.button !== 0 || isOverlayEvent(event)) return;
      if (event.shiftKey || state.mode === 'box') {
        state.isDragging = true;
        state.dragStart = { x: event.clientX, y: event.clientY };
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
      }
    }, true);

    document.addEventListener('mouseup', (event) => {
      if (!state.active || event.button !== 0 || isOverlayEvent(event)) return;
      if (state.isDragging) {
        const box = dragBox(state.dragStart.x, state.dragStart.y, event.clientX, event.clientY);
        state.isDragging = false;
        state.dragStart = null;
        ui.drag.classList.remove('visible');
        if (box.width > 8 && box.height > 8) captureBox(box);
        stopEvent(event);
      }
    }, true);

    document.addEventListener('click', (event) => {
      if (!state.active || state.mode !== 'element' || event.shiftKey || isOverlayEvent(event)) return;
      const element = inspectElementAt(event.clientX, event.clientY);
      if (!element) return;
      captureElement(element);
      stopEvent(event);
    }, true);

    document.addEventListener('scroll', drawAnnotations, true);
    window.addEventListener('resize', drawAnnotations, { passive: true });
  }

  function isTypingTarget(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  }

  function isOverlayEvent(event) {
    const path = event.composedPath();
    return path.includes(ui.bar) || path.includes(ui.layer);
  }

  function inspectElementAt(x, y) {
    const previousDisplay = ui.root.style.display;
    ui.root.style.display = 'none';
    const element = document.elementFromPoint(x, y);
    ui.root.style.display = previousDisplay;
    if (!element || element === document.documentElement || element === document.body) return null;
    if (ui.root.contains(element)) return null;
    return element;
  }

  function drawHover(element) {
    if (!element) {
      ui.outline.classList.remove('visible');
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      ui.outline.classList.remove('visible');
      return;
    }
    setRect(ui.outline, rect.left, rect.top, rect.width, rect.height);
    ui.outline.classList.add('visible');
  }

  function updateDrag(x, y) {
    const box = dragBox(state.dragStart.x, state.dragStart.y, x, y);
    setRect(ui.drag, box.x, box.y, box.width, box.height);
    ui.drag.classList.add('visible');
  }

  function captureElement(element) {
    const rect = element.getBoundingClientRect();
    addAnnotation({
      kind: 'element',
      note: '',
      url: location.href,
      title: document.title,
      selector: buildSelector(element),
      xpath: buildXPath(element),
      role: inferRole(element),
      label: inferLabel(element),
      text: visibleText(element),
      tagName: element.tagName.toLowerCase(),
      bbox: toBox(rect),
      viewport: viewport(),
      scroll: scrollPosition(),
      capturedAt: new Date().toISOString()
    });
  }

  function captureBox(box) {
    addAnnotation({
      kind: 'box',
      note: '',
      url: location.href,
      title: document.title,
      selector: null,
      xpath: null,
      role: null,
      label: null,
      text: null,
      tagName: null,
      bbox: { x: box.x, y: box.y, width: box.width, height: box.height, pageX: box.x + window.scrollX, pageY: box.y + window.scrollY },
      viewport: viewport(),
      scroll: scrollPosition(),
      capturedAt: new Date().toISOString()
    });
  }

  function addAnnotation(annotation) {
    const next = { ...annotation, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, number: state.annotations.length + 1 };
    state.annotations.push(next);
    persistState();
    drawAnnotations();
    updateUi();
    focusInlineNote(next.id);
  }

  function drawAnnotations() {
    if (state.editingNoteId) return;
    ui.layer.textContent = '';
    for (const annotation of state.annotations) drawAnnotation(annotation);
  }

  function drawAnnotation(annotation) {
    const boxData = currentAnnotationBox(annotation);
    if (!boxData) return;
    const { x, y, width, height } = boxData;

    if (annotation.kind === 'box') {
      const box = document.createElement('div');
      box.className = 'box';
      setRect(box, x, y, width, height);
      ui.layer.appendChild(box);
    }

    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = annotation.number || '?';
    pin.style.left = `${Math.max(14, Math.min(window.innerWidth - 14, x))}px`;
    pin.style.top = `${Math.max(40, Math.min(window.innerHeight - 14, y))}px`;
    ui.layer.appendChild(pin);

    const note = document.createElement('label');
    note.className = 'note';
    note.dataset.annotationId = annotation.id;
    const top = Math.max(40, Math.min(window.innerHeight - 80, y + 28));
    const left = Math.max(8, Math.min(window.innerWidth - 328, x));
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;

    const head = document.createElement('span');
    head.className = 'note-head';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${annotation.number}. ${annotation.label || annotation.text || annotation.tagName || annotation.kind}`.slice(0, 90);
    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete';
    deleteButton.type = 'button';
    deleteButton.title = 'Delete annotation';
    deleteButton.textContent = 'x';
    deleteButton.addEventListener('pointerdown', stopEvent, true);
    deleteButton.addEventListener('mousedown', stopEvent, true);
    deleteButton.addEventListener('click', (event) => {
      stopEvent(event);
      deleteAnnotation(annotation.id);
    }, true);
    head.append(meta, deleteButton);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type note here...';
    textarea.value = annotation.note || '';
    textarea.addEventListener('focus', () => { state.editingNoteId = annotation.id; });
    textarea.addEventListener('blur', () => { state.editingNoteId = null; drawAnnotations(); });
    textarea.addEventListener('input', () => updateInlineNote(annotation.id, textarea.value));
    textarea.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      updateInlineNote(annotation.id, textarea.value);
      if (event.metaKey || event.ctrlKey) {
        saveAnnotation(annotation.id, textarea.value);
        textarea.blur();
        state.editingNoteId = null;
        drawAnnotations();
        showToast('Saved. Press Enter twice to send saved notes.');
      } else if (isDoubleEnter(annotation.id)) {
        api.finish();
      } else {
        await sendAnnotationToOmp(annotation);
        showToast('Sent to OMP. Press Enter again to send all.');
      }
      stopEvent(event);
    });
    note.append(head, textarea);
    ui.layer.appendChild(note);
  }

  function currentAnnotationBox(annotation) {
    if (annotation.kind === 'element' && annotation.selector) {
      const element = document.querySelector(annotation.selector);
      if (element) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          annotation.bbox = toBox(rect);
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          };
        }
      }
    }
    if (!annotation.bbox) return null;
    return {
      x: Number(annotation.bbox.pageX || annotation.bbox.x || 0) - window.scrollX,
      y: Number(annotation.bbox.pageY || annotation.bbox.y || 0) - window.scrollY,
      width: Number(annotation.bbox.width || 0),
      height: Number(annotation.bbox.height || 0)
    };
  }

  function focusInlineNote(id) {
    const textarea = ui.layer.querySelector(`[data-annotation-id="${cssString(id)}"] textarea`);
    if (textarea) textarea.focus();
  }

  function updateInlineNote(id, note) {
    const item = state.annotations.find((annotation) => annotation.id === id);
    if (item && item.note !== note) {
      item.note = note;
      delete item.queuedAt;
      delete item.deliveredAt;
      delete item.beaconAttemptedAt;
    }
    persistState();
    clearTimeout(state.noteTimers.get(id));
    state.noteTimers.set(id, setTimeout(() => {}, 250));
  }

  function saveAnnotation(id, note) {
    updateInlineNote(id, note);
    state.lastEnterId = null;
    state.lastEnterAt = 0;
    persistState();
  }

  function deleteAnnotation(id) {
    state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
    renumberAnnotations();
    state.editingNoteId = null;
    state.lastEnterId = null;
    state.lastEnterAt = 0;
    persistState();
    drawAnnotations();
    updateUi();
    showToast('Annotation deleted.');
  }

  function renumberAnnotations() {
    state.annotations.forEach((annotation, index) => {
      annotation.number = index + 1;
    });
  }

  function isDoubleEnter(id) {
    const now = Date.now();
    const doubleEnter = state.lastEnterId === id && now - state.lastEnterAt < 850;
    state.lastEnterId = id;
    state.lastEnterAt = now;
    return doubleEnter;
  }

  async function sendAnnotationToOmp(annotation) {
    const queuedAt = new Date().toISOString();
    annotation.queuedAt = queuedAt;
    delete annotation.deliveredAt;
    annotation.sendRequestedAt = queuedAt;
    maybeNotifyBridge({
      page: exportPayload().page,
      annotations: [annotation]
    }, [annotation]);
    persistState();
    return true;
  }

  async function sendAllToOmp() {
    queueAllAnnotations();
    maybeNotifyBridge();
    persistState();
    showToast(`Sent ${state.annotations.length} annotation${state.annotations.length === 1 ? '' : 's'} to OMP.`);
    return true;
  }

  function queueAllAnnotations() {
    const queuedAt = new Date().toISOString();
    for (const annotation of state.annotations) {
      annotation.queuedAt = queuedAt;
      delete annotation.deliveredAt;
      annotation.sendRequestedAt = queuedAt;
    }
  }

  function maybeNotifyBridge(payload = exportPayload(), annotations = state.annotations) {
    ensureBridge().then((target) => {
      if (!target) return;
      const attemptedAt = new Date().toISOString();
      for (const annotation of annotations) annotation.beaconAttemptedAt ||= attemptedAt;
      sendBeaconPayload(target, payload);
      persistState();
    }).catch(() => {});
  }

  function sendBeaconPayload(target, payload) {
    const query = new URLSearchParams({
      token: target.token,
      payload: JSON.stringify(payload),
      _: String(Date.now())
    });
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
    image.onload = image.onerror = () => setTimeout(() => image.remove(), 1000);
    document.documentElement.appendChild(image);
    image.src = `http://127.0.0.1:${target.port}/v1/annotations-beacon?${query}`;
  }

  async function ensureBridge() {
    if (bridge.port && bridge.token) return bridge;
    for (let port = BRIDGE_PORT_START; port <= BRIDGE_PORT_END; port += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/status`);
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.bridge !== 'omp-annotation-bridge' || !data.token) continue;
        bridge.port = port;
        bridge.token = data.token;
        persistState();
        return bridge;
      } catch (_) {}
    }
    return null;
  }

  function updateUi() {
    ui.bar.style.display = state.active ? 'flex' : 'none';
    ui.count.textContent = String(state.annotations.length);
    for (const button of ui.modeButtons) button.classList.toggle('active', button.dataset.mode === state.mode);
    document.documentElement.style.cursor = state.active ? 'crosshair' : '';
    ui.fab.style.display = state.active ? 'block' : 'none';
    if (!state.active) {
      ui.outline.classList.remove('visible');
      ui.drag.classList.remove('visible');
    }
  }

  function persistState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(exportPayload()));
    } catch (_) {}
  }

  function loadStoredState() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function exportPayload() {
    return {
      source: 'omp-session-annotator',
      exportedAt: new Date().toISOString(),
      done: state.done,
      active: state.active,
      mode: state.mode,
      bridge: { port: bridge.port, token: bridge.token },
      page: { url: location.href, title: document.title, viewport: viewport(), scroll: scrollPosition() },
      annotations: state.annotations.slice()
    };
  }

  function copyAnnotations() {
    navigator.clipboard.writeText(JSON.stringify(exportPayload(), null, 2)).then(() => showToast(`Copied ${state.annotations.length} annotation${state.annotations.length === 1 ? '' : 's'}.`)).catch(() => showToast('Copy failed.'));
  }

  function setRect(node, x, y, width, height) {
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    node.style.width = `${Math.round(width)}px`;
    node.style.height = `${Math.round(height)}px`;
  }

  function dragBox(x1, y1, x2, y2) {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  function toBox(rect) {
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), pageX: Math.round(rect.left + window.scrollX), pageY: Math.round(rect.top + window.scrollY) };
  }

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
  }

  function scrollPosition() {
    return { x: window.scrollX, y: window.scrollY };
  }

  function visibleText(element) {
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 240) || null;
  }

  function inferLabel(element) {
    return element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || visibleText(element);
  }

  function inferRole(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return element.type || 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    return null;
  }

  function buildSelector(element) {
    if (!(element instanceof Element)) return null;
    if (element.id && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) return `#${cssEscape(element.id)}`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-cy');
      if (testId) {
        part += `[${testIdAttribute(node)}="${cssString(testId)}"]`;
      } else {
        const classes = Array.from(node.classList || []).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).slice(0, 2);
        if (classes.length) part += classes.map((name) => `.${cssEscape(name)}`).join('');
        const siblings = Array.from(node.parentElement?.children || []).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      try {
        if (document.querySelectorAll(selector).length === 1) return selector;
      } catch (_) {}
      node = node.parentElement;
    }
    return parts.join(' > ') || element.tagName.toLowerCase();
  }

  function testIdAttribute(node) {
    if (node.hasAttribute('data-testid')) return 'data-testid';
    if (node.hasAttribute('data-test')) return 'data-test';
    return 'data-cy';
  }

  function buildXPath(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const siblings = Array.from(node.parentElement?.children || []).filter((child) => child.tagName === node.tagName);
      const index = siblings.length > 1 ? `[${siblings.indexOf(node) + 1}]` : '';
      parts.unshift(`${tag}${index}`);
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  function cssEscape(value) {
    return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function showToast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 1600);
  }
})();
