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
    noteTimers: new Map(),
    selectedElement: null,
    navigationHistory: [],
    annotationNavigationHistory: new Map()
  };
  const lifecycle = new AbortController();
  let disposed = false;

  const ui = createOverlay();
  wirePageEvents();
  chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_CONTENT_READY' }).catch(() => {});

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === 'OMP_ANNOTATION_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (disposed) return false;
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
    if (message?.type === 'OMP_ANNOTATION_FLASH_SENT') {
      flashSent();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'OMP_ANNOTATION_DISPOSE') {
      disposeOverlay();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }

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
      .outline { position: fixed; display: none; border: 2px solid #f59e0b; background: rgba(245,158,11,.12); border-radius: 6px; pointer-events: none; box-shadow: 0 0 0 99999px rgba(0,0,0,.12); }
      .outline.visible { display: block; }
      .outline.selected { border-color: #38bdf8; background: rgba(56,189,248,.14); }
      .target-label { position: fixed; display: none; max-width: min(520px, calc(100vw - 18px)); padding: 4px 7px; border-radius: 7px; background: rgba(8,11,18,.94); color: #f8fafc; border: 1px solid rgba(56,189,248,.5); font: 700 11px ui-sans-serif, system-ui; pointer-events: none; box-shadow: 0 8px 26px rgba(0,0,0,.28); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .target-label.visible { display: block; }
      .drag { position: fixed; display: none; border: 2px dashed #38bdf8; background: rgba(56,189,248,.14); border-radius: 6px; pointer-events: none; }
      .drag.visible { display: block; }
      .pin { position: fixed; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: #f59e0b; color: #111827; font: 800 12px ui-sans-serif, system-ui; border: 2px solid #fff7ed; box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer; transform: translate(-50%, -50%); }
      .pin.sent { background: #22c55e; color: #052e16; }
      .box { position: fixed; border: 2px solid #f59e0b; background: rgba(245,158,11,.08); border-radius: 6px; pointer-events: none; }
      .note { position: fixed; display: grid; grid-template-columns: 1fr; width: min(300px, calc(100vw - 24px)); padding: 6px 8px; border-radius: 8px; background: rgba(8,11,18,.94); border: 1px solid rgba(209,213,219,.62); box-shadow: 0 10px 28px rgba(0,0,0,.24); pointer-events: auto; }
      .note:focus-within { border-color: rgba(229,231,235,.88); box-shadow: 0 10px 28px rgba(0,0,0,.24), 0 0 0 2px rgba(209,213,219,.16); }
      .note textarea { all: unset; display: block; height: 18px; min-height: 18px; max-height: 150px; overflow: hidden; resize: none; padding: 0 2px; color: #f9fafb; font: 12px ui-sans-serif, system-ui; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; }
      .note.expanded textarea, .note textarea:focus { white-space: pre-wrap; overflow-wrap: anywhere; text-overflow: clip; }
      .note textarea::placeholder { color: #9ca3af; }
      .note-meta { display: none; }
      .sent-flash { position: fixed; inset: 0; background: #22c55e; opacity: 0; pointer-events: none; }
      .sent-flash.visible { animation: sent-flash 650ms ease-in-out; }
      @keyframes sent-flash {
        0% { opacity: 0; }
        18% { opacity: .1; }
        100% { opacity: 0; }
      }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: none; max-width: min(560px, calc(100vw - 32px)); padding: 12px 16px; border-radius: 12px; background: rgba(14,17,23,.95); color: #86efac; font: 700 14px ui-sans-serif, system-ui; box-shadow: 0 14px 44px rgba(0,0,0,.38); border: 1px solid rgba(34,197,94,.38); pointer-events: none; }
      .toast.visible { display: block; }
    `;

    const outline = document.createElement('div');
    outline.className = 'outline';

    const targetLabel = document.createElement('div');
    targetLabel.className = 'target-label';
    const drag = document.createElement('div');
    drag.className = 'drag';
    const layer = document.createElement('div');
    const sentFlash = document.createElement('div');
    sentFlash.className = 'sent-flash';
    const toast = document.createElement('div');
    toast.className = 'toast';

    shadow.append(style, outline, targetLabel, drag, layer, sentFlash, toast);
    return {
      root,
      outline,
      targetLabel,
      drag,
      layer,
      sentFlash,
      toast
    };
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
    clearTargetSelection();
  }

  function disposeOverlay() {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
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
    if (mode === 'box') clearTargetSelection();
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
    document.documentElement.style.cursor = state.enabled ? 'crosshair' : '';
    if (!state.enabled) clearOverlay();
  }

  function wirePageEvents() {
    const handleShortcut = (event) => {
      if (event.type === 'keydown' && state.enabled && state.mode === 'element' && handleTargetNavigation(event)) return;
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
    const captureOptions = { capture: true, signal: lifecycle.signal };
    window.addEventListener('keydown', handleShortcut, captureOptions);
    window.addEventListener('keyup', handleShortcut, captureOptions);
    document.addEventListener('keydown', handleShortcut, captureOptions);
    document.addEventListener('keyup', handleShortcut, captureOptions);

    document.addEventListener('mousemove', (event) => {
      if (!state.enabled || isOverlayEvent(event)) return;
      if (state.isDragging) {
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
        return;
      }
      if (state.mode === 'element' && !state.selectedElement) drawTarget(inspectElementAt(event.clientX, event.clientY), false);
    }, captureOptions);

    document.addEventListener('mousedown', (event) => {
      if (!state.enabled || event.button !== 0 || isOverlayEvent(event)) return;
      if (event.shiftKey || state.mode === 'box') {
        clearTargetSelection();
        state.isDragging = true;
        state.dragStart = { x: event.clientX, y: event.clientY };
        updateDrag(event.clientX, event.clientY);
        stopEvent(event);
      }
    }, captureOptions);

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
    }, captureOptions);

    document.addEventListener('click', (event) => {
      if (!state.enabled || state.mode !== 'element' || event.shiftKey || isOverlayEvent(event)) return;
      const element = inspectElementAt(event.clientX, event.clientY);
      if (!element) return;
      selectTargetElement(element);
      stopEvent(event);
    }, captureOptions);

    window.addEventListener('scroll', () => { drawAnnotations(); redrawSelectedTarget(); }, { passive: true, signal: lifecycle.signal });
    window.addEventListener('resize', () => { drawAnnotations(); redrawSelectedTarget(); }, { passive: true, signal: lifecycle.signal });
  }

  function isOverlayEvent(event) {
    return event.composedPath().includes(ui.layer);
  }

  function inspectElementAt(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element || element === document.documentElement || element === document.body) return null;
    if (ui.root.contains(element)) return null;
    return element;
  }

  function handleTargetNavigation(event) {
    if (isTypingTarget(event.target)) return false;
    if (!state.selectedElement || !state.selectedElement.isConnected) return false;
    const element = state.selectedElement;
    if (event.key === 'Enter') {
      stopEvent(event);
      captureElement(element);
      clearTargetSelection();
      return true;
    }
    if (event.key === 'ArrowUp') {
      stopEvent(event);
      const parent = navigableParent(element);
      if (parent) {
        state.navigationHistory.push(element);
        selectTargetElement(parent, false);
      }
      return true;
    }
    if (event.key === 'ArrowDown') {
      stopEvent(event);
      const previous = state.navigationHistory.pop();
      if (previous?.isConnected && previous.parentElement === element) {
        selectTargetElement(previous, false);
        return true;
      }
      const child = firstNavigableChild(element);
      if (child) selectTargetElement(child, false);
      return true;
    }
    if (event.key === 'ArrowLeft') {
      stopEvent(event);
      const sibling = navigableSibling(element, -1);
      if (sibling) selectTargetElement(sibling, false);
      return true;
    }
    if (event.key === 'ArrowRight') {
      stopEvent(event);
      const sibling = navigableSibling(element, 1);
      if (sibling) selectTargetElement(sibling, false);
      return true;
    }
    return false;
  }

  function selectTargetElement(element, resetHistory = true) {
    if (!isNavigableElement(element)) return;
    state.selectedElement = element;
    if (resetHistory) state.navigationHistory = [];
    drawTarget(element, true);
  }

  function clearTargetSelection() {
    state.selectedElement = null;
    state.navigationHistory = [];
    ui.outline.classList.remove('visible', 'selected');
    ui.targetLabel.classList.remove('visible');
  }

  function redrawSelectedTarget() {
    if (!state.selectedElement || !state.selectedElement.isConnected) return;
    drawTarget(state.selectedElement, true);
  }

  function navigableParent(element) {
    const parent = element.parentElement;
    return isNavigableElement(parent) ? parent : null;
  }

  function firstNavigableChild(element) {
    return Array.from(element.children || []).find(isNavigableElement) || null;
  }

  function navigableSibling(element, direction) {
    const siblings = Array.from(element.parentElement?.children || []).filter(isNavigableElement);
    const index = siblings.indexOf(element);
    if (index < 0) return null;
    return siblings[index + direction] || null;
  }

  function isNavigableElement(element) {
    if (!(element instanceof Element)) return false;
    if (element === document.documentElement || element === document.body) return false;
    if (ui.root.contains(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function drawTarget(element, selected) {
    if (!element) {
      ui.outline.classList.remove('visible', 'selected');
      ui.targetLabel.classList.remove('visible');
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      ui.outline.classList.remove('visible', 'selected');
      ui.targetLabel.classList.remove('visible');
      return;
    }
    setRect(ui.outline, rect.left, rect.top, rect.width, rect.height);
    ui.outline.classList.toggle('selected', Boolean(selected));
    ui.outline.classList.add('visible');
    drawTargetLabel(element, rect, selected);
  }

  function drawTargetLabel(element, rect, selected) {
    ui.targetLabel.textContent = selected
      ? `${shortSelector(element)}  ↑ parent  ↓ child  ←/→ sibling  Enter capture`
      : shortSelector(element);
    const top = rect.top > 34 ? rect.top - 28 : rect.bottom + 6;
    ui.targetLabel.style.top = `${Math.round(Math.max(6, Math.min(window.innerHeight - 28, top)))}px`;
    ui.targetLabel.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - 16, rect.left)))}px`;
    ui.targetLabel.classList.add('visible');
  }

  function updateDrag(x, y) {
    const box = dragBox(state.dragStart.x, state.dragStart.y, x, y);
    setRect(ui.drag, box.x, box.y, box.width, box.height);
    ui.drag.classList.add('visible');
  }

  function captureElement(element) {
    addAnnotation(annotationFromElement(element));
  }

  function annotationFromElement(element, base = {}) {
    const rect = element.getBoundingClientRect();
    return {
      ...base,
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
      capturedAt: base.capturedAt || new Date().toISOString()
    };
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
        state.editingNoteId = response.annotation.id;
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
    note.className = state.editingNoteId === annotation.id ? 'note expanded' : 'note';
    note.dataset.annotationId = annotation.id;
    const top = Math.max(44, Math.min(window.innerHeight - 80, y + 28));
    const left = Math.max(8, Math.min(window.innerWidth - 308, x));
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;

    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = `${annotation.number}. ${annotation.label || annotation.text || annotation.tagName || annotation.kind}`.slice(0, 80);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a comment…';
    textarea.value = annotation.note || '';
    textarea.rows = 1;
    textarea.addEventListener('focus', () => {
      state.editingNoteId = annotation.id;
      note.classList.add('expanded');
      resizeInlineNote(textarea, true);
    });
    textarea.addEventListener('blur', () => {
      if (!annotation.sentAt) state.editingNoteId = null;
      note.classList.remove('expanded');
      resizeInlineNote(textarea, false);
    });
    textarea.addEventListener('input', () => {
      updateInlineNote(annotation.id, textarea.value);
      resizeInlineNote(textarea, true);
    });
    textarea.addEventListener('keydown', (event) => handleNoteKeydown(event, annotation.id, textarea));
    note.append(meta, textarea);
    ui.layer.appendChild(note);
    resizeInlineNote(textarea, state.editingNoteId === annotation.id);
  }

  function focusInlineNote(id) {
    const textarea = ui.layer.querySelector(`[data-annotation-id="${cssString(id)}"] textarea`);
    if (!textarea) return;
    textarea.focus();
    resizeInlineNote(textarea, true);
  }

  function resizeInlineNote(textarea, expanded) {
    if (!expanded) {
      textarea.style.height = '18px';
      textarea.style.overflowY = 'hidden';
      textarea.scrollTop = 0;
      return;
    }
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${Math.max(18, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? 'auto' : 'hidden';
  }

  function handleNoteKeydown(event, id, textarea) {
    if (isModifierArrow(event)) {
      stopEvent(event);
      retargetInlineAnnotation(id, event.key, textarea.value);
      return;
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.metaKey || event.ctrlKey || event.altKey) {
      stopEvent(event);
      sendInlineNote(id, textarea.value, 'queue');
      return;
    }
    stopEvent(event);
  }

  function isModifierArrow(event) {
    return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
  }

  function retargetInlineAnnotation(id, key, note) {
    const annotation = state.annotations.find((item) => item.id === id);
    if (!annotation || annotation.kind !== 'element') return;
    const current = elementForAnnotation(annotation);
    if (!current) {
      showToast('Could not find selected element on the page.');
      return;
    }
    const next = navigatedElementForAnnotation(id, current, key);
    if (!next) return;
    const updated = annotationFromElement(next, { ...annotation, note });
    delete updated.sentAt;
    state.annotations = state.annotations.map((item) => item.id === id ? updated : item);
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_UPDATE_ELEMENT', id, annotation: updated }).catch(() => {});
    state.editingNoteId = id;
    drawAnnotations();
    updateToolbar();
    focusInlineNote(id);
    showToast(`Target: ${shortSelector(next)}`);
  }

  function navigatedElementForAnnotation(id, current, key) {
    if (key === 'ArrowUp') {
      const parent = navigableParent(current);
      if (parent) {
        pushAnnotationHistory(id, current);
        return parent;
      }
      return null;
    }
    if (key === 'ArrowDown') {
      const previous = popAnnotationHistory(id);
      if (previous?.isConnected && previous.parentElement === current) return previous;
      return firstNavigableChild(current);
    }
    if (key === 'ArrowLeft') return navigableSibling(current, -1);
    if (key === 'ArrowRight') return navigableSibling(current, 1);
    return null;
  }

  function pushAnnotationHistory(id, element) {
    const history = state.annotationNavigationHistory.get(id) || [];
    history.push(element);
    state.annotationNavigationHistory.set(id, history);
  }

  function popAnnotationHistory(id) {
    const history = state.annotationNavigationHistory.get(id) || [];
    const element = history.pop() || null;
    if (history.length) state.annotationNavigationHistory.set(id, history);
    else state.annotationNavigationHistory.delete(id);
    return element;
  }

  function elementForAnnotation(annotation) {
    const selector = annotation.selector;
    if (selector) {
      try {
        const element = document.querySelector(selector);
        if (isNavigableElement(element)) return element;
      } catch (_) {}
    }
    const xpath = annotation.xpath;
    if (xpath) {
      try {
        const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (isNavigableElement(element)) return element;
      } catch (_) {}
    }
    return null;
  }

  function sendInlineNote(id, note, deliveryMode = 'send') {
    updateInlineNote(id, note, true);
    const item = state.annotations.find((annotation) => annotation.id === id);
    if (item) item.sentAt = new Date().toISOString();
    chrome.runtime.sendMessage({ type: 'OMP_ANNOTATION_SEND_ONE_TO_OMP', id, note, deliveryMode }).then((response) => {
      if (response?.state) state.annotations = response.state.annotations || state.annotations;
      state.editingNoteId = null;
      drawAnnotations();
      updateToolbar();
      if (response?.ok) flashSent();
      const successText = response?.queued ? 'Queued in OMP.' : 'Sent to OMP.';
      showToast(response?.ok ? successText : (response?.error || 'Send failed.'));
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
        flashSent();
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

  function shortSelector(element) {
    if (!(element instanceof Element)) return '';
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const classes = Array.from(element.classList || [])
      .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name))
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join('');
    const selector = `${tag}${id}${classes}` || tag;
    return selector.length > 70 ? `${selector.slice(0, 69)}…` : selector;
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

  let flashTimer = 0;
  function flashSent() {
    ui.sentFlash.classList.remove('visible');
    void ui.sentFlash.offsetWidth;
    ui.sentFlash.classList.add('visible');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ui.sentFlash.classList.remove('visible'), 690);
  }
})();
