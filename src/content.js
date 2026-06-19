(() => {
  if (window.__ompAnnotationContentLoaded) {
    document.getElementById('omp-annotation-root')?.remove();
  }
  window.__ompAnnotationContentLoaded = true;

  const state = {
    enabled: false,
    mode: 'element',
    annotations: [],
    isDragging: false,
    dragStart: null,
    editingNoteId: null,
    noteTimers: new Map()
  };

  const ui = createOverlay();
  wireToolbar();
  wirePageEvents();
  chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'OMP_ANNOTATION_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_SYNC') {
      syncState(message.state || {});
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_SET_ENABLED') {
      setEnabled(Boolean(message.enabled));
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_TOGGLE') {
      setEnabled(!state.enabled);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_SET_MODE') {
      setMode(message.mode === 'box' ? 'box' : 'element');
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_DISPOSE') {
      disposeOverlay();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function createOverlay() {
    const root = document.createElement('div');
    root.id = 'omp-annotation-root';
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
      .bar { position: fixed; left: 6px; right: 6px; top: 6px; display: none; align-items: center; gap: 5px; height: 30px; padding: 3px 5px; border-radius: 10px; background: rgba(8,11,18,.88); color: #f5f7fb; font: 11px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 26px rgba(0,0,0,.28); pointer-events: auto; border: 1px solid rgba(255,255,255,.12); backdrop-filter: blur(14px); }
      .brand { display: inline-flex; align-items: center; gap: 5px; font-weight: 800; white-space: nowrap; }
      .dot { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); }
      button { all: unset; display: inline-flex; align-items: center; justify-content: center; height: 22px; min-width: 22px; padding: 0 6px; border-radius: 7px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: #f5f7fb; cursor: pointer; white-space: nowrap; }
      button:hover { border-color: rgba(245,158,11,.55); }
      button.active { background: #f59e0b; color: #111827; font-weight: 800; }
      .spacer { flex: 1 1 auto; }
      .count { color: #fbbf24; font-weight: 800; min-width: 24px; text-align: right; }
      .outline { position: fixed; display: none; border: 2px solid #f59e0b; background: rgba(245,158,11,.12); border-radius: 6px; pointer-events: none; box-shadow: 0 0 0 99999px rgba(0,0,0,.12); }
      .outline.visible { display: block; }
      .drag { position: fixed; display: none; border: 2px dashed #38bdf8; background: rgba(56,189,248,.14); border-radius: 6px; pointer-events: none; }
      .drag.visible { display: block; }
      .pin { position: fixed; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: #f59e0b; color: #111827; font: 800 12px ui-sans-serif, system-ui; border: 2px solid #fff7ed; box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer; transform: translate(-50%, -50%); }
      .pin.sent { background: #22c55e; color: #052e16; }
      .box { position: fixed; border: 2px solid #f59e0b; background: rgba(245,158,11,.08); border-radius: 6px; pointer-events: none; }
      .note { position: fixed; display: grid; grid-template-columns: 1fr; width: min(280px, calc(100vw - 24px)); padding: 3px 5px; border-radius: 999px; background: rgba(8,11,18,.94); border: 1px solid rgba(245,158,11,.65); box-shadow: 0 12px 34px rgba(0,0,0,.32); pointer-events: auto; }
      .note textarea { all: unset; height: 18px; overflow: hidden; resize: none; padding: 1px 8px; color: #fff; font: 12px ui-sans-serif, system-ui; line-height: 18px; white-space: nowrap; }
      .note textarea::placeholder { color: #9ca3af; }
      .note-meta { display: none; }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: none; max-width: min(520px, calc(100vw - 32px)); padding: 10px 12px; border-radius: 12px; background: rgba(14,17,23,.95); color: #f8fafc; font: 12px ui-sans-serif, system-ui; box-shadow: 0 14px 44px rgba(0,0,0,.38); border: 1px solid rgba(255,255,255,.16); pointer-events: none; }
      .toast.visible { display: block; }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<span class="brand"><span class="dot"></span>Annotate</span><button data-mode="element" class="active" title="Element mode, Alt+Shift+E">E</button><button data-mode="box" title="Box mode, Alt+Shift+B">B</button><span class="spacer"></span><span class="count">0</span><button data-action="send">Send</button><button data-action="copy">Copy</button><button data-action="clear">Clear</button><button data-action="close">Esc</button>';

    const outline = document.createElement('div');
    outline.className = 'outline';
    const drag = document.createElement('div');
    drag.className = 'drag';
    const layer = document.createElement('div');
    const toast = document.createElement('div');
    toast.className = 'toast';

    shadow.append(style, bar, outline, drag, layer, toast);
    return {
      root,
      bar,
      outline,
      drag,
      layer,
      toast,
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
        const mode = modeButton.dataset.mode === 'box' ? 'box' : 'element';
        chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SET_MODE', mode }).catch(() => setMode(mode));
        setMode(mode);
        return;
      }
      const actionButton = target.closest('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'send') sendToOmp();
      if (action === 'copy') copyAnnotations();
      if (action === 'clear') clearAnnotations();
      if (action === 'close') stopAnnotating();
    });
    ui.bar.addEventListener('mousedown', stopEvent, true);
    ui.bar.addEventListener('mouseup', stopEvent, true);
  }

  function syncState(next) {
    state.enabled = Boolean(next.enabled);
    state.mode = next.mode === 'box' ? 'box' : 'element';
    state.annotations = Array.isArray(next.annotations) ? next.annotations : [];
    updateToolbar();
    if (state.enabled && !state.editingNoteId) drawAnnotations();
    if (!state.enabled) clearOverlay();
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_GET_STATE' }).then((response) => {
      const current = response?.state || {};
      syncState({ ...current, enabled });
    }).catch(() => updateToolbar());
  }

  function clearOverlay() {
    state.isDragging = false;
    state.dragStart = null;
    state.editingNoteId = null;
    ui.layer.textContent = '';
    ui.outline.classList.remove('visible');
    ui.drag.classList.remove('visible');
  }

  function disposeOverlay() {
    state.enabled = false;
    state.annotations = [];
    clearOverlay();
    for (const timer of state.noteTimers.values()) clearTimeout(timer);
    state.noteTimers.clear();
    document.documentElement.style.cursor = '';
    ui.root.remove();
    window.__ompAnnotationContentLoaded = false;
  }

  function setMode(mode) {
    state.mode = mode;
    updateToolbar();
  }

  function toggleMode() {
    const mode = state.mode === 'box' ? 'element' : 'box';
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SET_MODE', mode }).catch(() => setMode(mode));
    setMode(mode);
  }

  function stopAnnotating() {
    state.enabled = false;
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SET_ENABLED', enabled: false }).catch(() => {});
    updateToolbar();
  }

  function updateToolbar() {
    ui.bar.style.display = state.enabled ? 'flex' : 'none';
    ui.count.textContent = String(state.annotations.length);
    for (const button of ui.modeButtons) button.classList.toggle('active', button.dataset.mode === state.mode);
    document.documentElement.style.cursor = state.enabled ? 'crosshair' : '';
    if (!state.enabled) clearOverlay();
  }

  function wirePageEvents() {
    const handleShortcut = (event) => {
      if (event.key === 'Escape' && state.enabled) {
        stopAnnotating();
        stopEvent(event);
        return;
      }
      if (event.type === 'keydown' && state.enabled && isModeToggleShortcut(event)) {
        toggleMode();
        stopEvent(event);
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    window.addEventListener('keyup', handleShortcut, true);
    document.addEventListener('keydown', handleShortcut, true);
    document.addEventListener('keyup', handleShortcut, true);

    document.addEventListener('mousemove', (event) => {
      if (!state.enabled || isOverlayEvent(event)) return;
      if (state.isDragging) {
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
        return;
      }
      if (state.mode === 'element') drawHover(inspectElementAt(event.clientX, event.clientY));
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (!state.enabled || event.button !== 0 || isOverlayEvent(event)) return;
      if (event.shiftKey || state.mode === 'box') {
        state.isDragging = true;
        state.dragStart = { x: event.clientX, y: event.clientY };
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
      }
    }, true);

    document.addEventListener('mouseup', (event) => {
      if (!state.enabled || event.button !== 0 || isOverlayEvent(event)) return;
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
      if (!state.enabled || state.mode !== 'element' || event.shiftKey || isOverlayEvent(event)) return;
      const element = inspectElementAt(event.clientX, event.clientY);
      if (!element) return;
      captureElement(element);
      stopEvent(event);
    }, true);

    window.addEventListener('scroll', drawAnnotations, { passive: true });
    window.addEventListener('resize', drawAnnotations, { passive: true });
  }

  function isOverlayEvent(event) {
    return event.composedPath().includes(ui.bar) || event.composedPath().includes(ui.layer);
  }

  function inspectElementAt(x, y) {
    const element = document.elementFromPoint(x, y);
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
      url: location.href,
      frameUrl: location.href,
      title: document.title,
      selector: buildSelector(element),
      xpath: buildXPath(element),
      role: inferRole(element),
      label: inferLabel(element),
      text: visibleText(element),
      tagName: element.tagName.toLowerCase(),
      attributes: elementAttributes(element),
      html: htmlSnippet(element, 520),
      context: elementContext(element),
      bbox: toBox(rect),
      viewport: viewport(),
      scroll: scrollPosition(),
      capturedAt: new Date().toISOString()
    });
  }

  function captureBox(box) {
    addAnnotation({
      kind: 'box',
      url: location.href,
      frameUrl: location.href,
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
      devicePixelRatio: window.devicePixelRatio || 1,
      capturedAt: new Date().toISOString()
    });
  }

  function addAnnotation(annotation) {
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_ADDED', annotation }).then((response) => {
      if (response?.annotation) {
        state.annotations = state.annotations.concat(response.annotation);
        drawAnnotations();
        updateToolbar();
        focusInlineNote(response.annotation.id);
      }
    }).catch(() => showToast('Annotation failed. Extension message was blocked.'));
  }

  function drawAnnotations() {
    ui.layer.textContent = '';
    for (const annotation of state.annotations) drawAnnotation(annotation);
  }

  function drawAnnotation(annotation) {
    if (!annotation?.bbox) return;
    const x = Number(annotation.bbox.pageX || annotation.bbox.x || 0) - window.scrollX;
    const y = Number(annotation.bbox.pageY || annotation.bbox.y || 0) - window.scrollY;
    const width = Number(annotation.bbox.width || 0);
    const height = Number(annotation.bbox.height || 0);

    if (annotation.kind === 'box') {
      const box = document.createElement('div');
      box.className = 'box';
      setRect(box, x, y, width, height);
      ui.layer.appendChild(box);
    }

    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = annotation.number || '?';
    if (annotation.sentAt) pin.classList.add('sent');
    pin.style.left = `${Math.max(14, Math.min(window.innerWidth - 14, x))}px`;
    pin.style.top = `${Math.max(44, Math.min(window.innerHeight - 14, y))}px`;
    pin.addEventListener('click', (event) => {
      stopEvent(event);
      state.editingNoteId = annotation.id;
      drawAnnotations();
      focusInlineNote(annotation.id);
    });
    pin.title = annotation.sentAt ? 'Sent. Click to edit.' : 'Click to edit note.';

    if (annotation.sentAt && state.editingNoteId !== annotation.id) return;

    const note = document.createElement('label');
    note.className = 'note';
    note.dataset.annotationId = annotation.id;
    const top = Math.max(44, Math.min(window.innerHeight - 80, y + 28));
    const left = Math.max(8, Math.min(window.innerWidth - 288, x));
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;

    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = `${annotation.number}. ${annotation.label || annotation.text || annotation.tagName || annotation.kind}`.slice(0, 80);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a comment…';
    textarea.value = annotation.note || '';
    textarea.addEventListener('focus', () => { state.editingNoteId = annotation.id; });
    textarea.addEventListener('blur', () => { if (!annotation.sentAt) state.editingNoteId = null; });
    textarea.addEventListener('input', () => updateInlineNote(annotation.id, textarea.value));
    textarea.addEventListener('keydown', (event) => handleNoteKeydown(event, annotation.id, textarea));
    note.append(meta, textarea);
    ui.layer.appendChild(note);
  }

  function focusInlineNote(id) {
    const textarea = ui.layer.querySelector(`[data-annotation-id="${cssString(id)}"] textarea`);
    if (textarea) textarea.focus();
  }

  function handleNoteKeydown(event, id, textarea) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.metaKey || event.ctrlKey) {
      stopEvent(event);
      sendInlineNote(id, textarea.value);
      return;
    }
    stopEvent(event);
  }

  function sendInlineNote(id, note) {
    updateInlineNote(id, note, true);
    const item = state.annotations.find((annotation) => annotation.id === id);
    if (item) item.sentAt = new Date().toISOString();
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SEND_ONE_TO_OMP', id, note }).then((response) => {
      if (response?.state) state.annotations = response.state.annotations || state.annotations;
      state.editingNoteId = null;
      drawAnnotations();
      updateToolbar();
      showToast(response?.ok ? 'Sent to OMP.' : (response?.error || 'Send failed.'));
    }).catch((error) => showToast(String(error?.message || error || 'Send failed.')));
  }

  function updateInlineNote(id, note, flush = false) {
    const item = state.annotations.find((annotation) => annotation.id === id);
    if (item) {
      item.note = note;
      if (!flush) delete item.sentAt;
    }
    clearTimeout(state.noteTimers.get(id));
    const sendUpdate = () => chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_UPDATE_NOTE', id, note }).catch(() => {});
    if (flush) sendUpdate();
    else state.noteTimers.set(id, setTimeout(sendUpdate, 250));
  }

  function exportPayload() {
    return {
      source: 'omp-annotation-panel',
      exportedAt: new Date().toISOString(),
      page: { title: document.title, url: location.href },
      annotations: state.annotations
    };
  }

  function sendToOmp() {
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SEND_TO_OMP' }).then((response) => {
      if (response?.ok) {
        showToast(`Sent ${response.delivered || state.annotations.length} annotation${state.annotations.length === 1 ? '' : 's'} to OMP.`);
        return;
      }
      showToast(response?.error || 'Send to OMP failed.');
    }).catch(() => showToast('Send to OMP failed.'));
  }

  function copyAnnotations() {
    navigator.clipboard.writeText(JSON.stringify(exportPayload(), null, 2)).then(() => showToast(`Copied ${state.annotations.length} annotation${state.annotations.length === 1 ? '' : 's'}.`)).catch(() => showToast('Copy failed.'));
  }

  function clearAnnotations() {
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_CLEAR' }).then((response) => {
      if (response?.state) syncState(response.state);
      showToast('Annotations cleared.');
    }).catch(() => showToast('Clear failed.'));
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

  function elementAttributes(element) {
    const attributes = {};
    for (const name of ['id', 'class', 'name', 'type', 'href', 'src', 'alt', 'title', 'aria-label', 'role', 'data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute?.(name);
      if (value) attributes[name] = compactDomText(value, 180);
    }
    return Object.keys(attributes).length ? attributes : null;
  }

  function htmlSnippet(element, max) {
    if (!(element instanceof Element)) return null;
    return compactDomText(element.outerHTML, max);
  }

  function elementContext(element) {
    const parent = summarizeContextNode(element.parentElement, 220);
    const container = summarizeContextNode(nearestContextContainer(element), 320);
    const previous = summarizeSibling(element.previousElementSibling);
    const next = summarizeSibling(element.nextElementSibling);
    return { parent, container, previous, next };
  }

  function nearestContextContainer(element) {
    if (!(element instanceof Element)) return null;
    const selector = 'article, section, main, form, li, tr, [role="row"], [role="article"], [role="region"], [class*="card"], [class*="item"], [class*="row"], [class*="section"], [class*="panel"]';
    const container = element.closest(selector);
    return container && container !== element ? container : null;
  }

  function summarizeContextNode(element, textMax) {
    if (!(element instanceof Element) || element === document.body || element === document.documentElement) return null;
    return {
      tagName: element.tagName.toLowerCase(),
      selector: buildSelector(element),
      attributes: elementAttributes(element),
      text: compactDomText(element.innerText || element.textContent || '', textMax)
    };
  }

  function summarizeSibling(element) {
    if (!(element instanceof Element)) return null;
    const text = compactDomText(element.innerText || element.textContent || '', 140);
    if (!text) return null;
    return {
      tagName: element.tagName.toLowerCase(),
      selector: buildSelector(element),
      html: htmlSnippet(element, 220),
      text
    };
  }

  function compactDomText(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text || null;
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
        const unique = document.querySelectorAll(selector).length === 1;
        const lastAvailableAncestor = node.parentElement === document.body || node.parentElement === document.documentElement;
        if (unique && (testId || (parts.length > 1 && (hasSelectorAnchor(parts) || lastAvailableAncestor)))) return selector;
      } catch (_) {}
      node = node.parentElement;
    }
    return parts.join(' > ') || element.tagName.toLowerCase();
  }

  function hasSelectorAnchor(parts) {
    return parts.some((part) => part.includes('.') || part.includes('[') || part.includes('#'));
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

  function isModeToggleShortcut(event) {
    return event.altKey && event.shiftKey && (event.code === 'Backquote' || event.key === '`' || event.key === '~');
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  let toastTimer = 0;
  function showToast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 1600);
  }
})();
