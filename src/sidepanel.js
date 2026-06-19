let activeTab = null;
let state = { enabled: false, mode: 'element', targetText: '', target: null, annotations: [] };
const noteTimers = new Map();
let targetTimer = 0;
let lastBootstrappedTargetText = '';

const els = {
  status: document.getElementById('status'),
  pageTitle: document.getElementById('pageTitle'),
  pageUrl: document.getElementById('pageUrl'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  elementMode: document.getElementById('elementMode'),
  boxMode: document.getElementById('boxMode'),
  sendButton: document.getElementById('sendButton'),
  copyButton: document.getElementById('copyButton'),
  downloadButton: document.getElementById('downloadButton'),
  clearButton: document.getElementById('clearButton'),
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  targetInput: document.getElementById('targetInput'),
  targetStatus: document.getElementById('targetStatus')
};

init();

async function init() {
  await refresh();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'OMP_ANNOTATION_STATE_CHANGED') return;
    if (!activeTab?.id || message.tabId === activeTab.id) {
      activeTab = activeTab?.id ? activeTab : { id: message.tabId, title: 'Annotated page', url: '' };
      state = message.state;
      render();
      bootstrapFromClipboard();
    }
  });
  els.startButton.addEventListener('click', () => setEnabled(true));
  els.stopButton.addEventListener('click', () => setEnabled(false));
  els.elementMode.addEventListener('click', () => setMode('element'));
  els.boxMode.addEventListener('click', () => setMode('box'));
  els.sendButton.addEventListener('click', sendToOmp);
  els.copyButton.addEventListener('click', copyJson);
  els.downloadButton.addEventListener('click', downloadJson);
  els.clearButton.addEventListener('click', clearAnnotations);
  els.targetInput.addEventListener('input', () => {
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => updateTarget(els.targetInput.value), 200);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.enabled) {
      event.preventDefault();
      event.stopPropagation();
      setEnabled(false);
      return;
    }
    if (state.enabled && isModeToggleShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      setMode(state.mode === 'box' ? 'element' : 'box');
    }
  }, true);
  window.addEventListener('focus', refreshAndBootstrap);
  window.addEventListener('pageshow', refreshAndBootstrap);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAndBootstrap();
  });
  await bootstrapFromClipboard();
}

async function refresh() {
  const tabResponse = await send({ type: 'OMP_ANNOTATION_GET_ACTIVE_TAB' });
  activeTab = tabResponse?.tab || null;
  if (!activeTab?.id) {
    render();
    return;
  }
  const stateResponse = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: activeTab.id });
  state = stateResponse?.state || state;
  render();
}

async function refreshAndBootstrap() {
  await refresh();
  await bootstrapFromClipboard();
}

async function setEnabled(enabled) {
  if (!activeTab?.id) return;
  const response = await send({ type: 'OMP_ANNOTATION_SET_ENABLED', tabId: activeTab.id, enabled });
  if (response?.state) state = response.state;
  state.enabled = enabled;
  render();
}

async function setMode(mode) {
  if (!activeTab?.id) return;
  const response = await send({ type: 'OMP_ANNOTATION_SET_MODE', tabId: activeTab.id, mode });
  if (response?.state) state = response.state;
  state.mode = mode;
  render();
}

async function updateNote(id, note) {
  if (!activeTab?.id) return;
  const response = await send({ type: 'OMP_ANNOTATION_UPDATE_NOTE', tabId: activeTab.id, id, note });
  if (response?.state) {
    state = response.state;
    render(false);
  }
}

async function deleteAnnotation(id) {
  if (!activeTab?.id) return;
  const response = await send({ type: 'OMP_ANNOTATION_DELETE', tabId: activeTab.id, id });
  if (response?.state) state = response.state;
  render();
}

async function clearAnnotations() {
  if (!activeTab?.id || !state.annotations.length) return;
  const response = await send({ type: 'OMP_ANNOTATION_CLEAR', tabId: activeTab.id });
  if (response?.state) state = response.state;
  render();
}

async function updateTarget(targetText) {
  if (!activeTab?.id) return;
  const response = await send({ type: 'OMP_ANNOTATION_SET_TARGET', tabId: activeTab.id, targetText });
  if (response?.state) state = response.state;
  render(false);
}
async function bootstrapFromClipboard() {
  if (!activeTab?.id) return;
  const clipboardText = (await readClipboardText()).trim();
  if (!looksLikeTargetBlock(clipboardText)) return;
  const alreadyApplied = clipboardText === lastBootstrappedTargetText || state.targetText === clipboardText;
  if (alreadyApplied) return;
  const response = await send({ type: 'OMP_ANNOTATION_BOOTSTRAP_FROM_TARGET', tabId: activeTab.id, targetText: clipboardText });
  if (response?.state) {
    state = response.state;
    lastBootstrappedTargetText = clipboardText;
    render();
    els.targetInput.value = state.targetText || '';
  }
}

async function readClipboardText() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return text;
  } catch (_) {
    // Fall through to the extension-page paste path below.
  }
  return readClipboardTextViaPasteTarget();
}

function readClipboardTextViaPasteTarget() {
  const previous = els.targetInput.value;
  els.targetInput.focus();
  els.targetInput.select();
  try {
    if (!document.execCommand('paste')) return '';
    return els.targetInput.value;
  } catch (_) {
    return '';
  } finally {
    els.targetInput.value = previous;
    els.targetInput.setSelectionRange(previous.length, previous.length);
  }
}

function looksLikeTargetBlock(text) {
  return /\bsurface_(ref|id)\s*=/.test(text || '');
}



async function sendToOmp() {
  if (!activeTab?.id || !state.annotations.length) return;
  const response = await send({ type: 'OMP_ANNOTATION_SEND_TO_OMP', tabId: activeTab.id });
  if (response?.ok) {
    flashButton(els.sendButton, 'Sent');
    return;
  }
  flashButton(els.sendButton, 'Failed');
  console.warn(response?.error || 'Send to OMP failed.');
}

function render(rebuildList = true) {
  els.status.textContent = state.enabled ? 'Live' : 'Idle';
  els.status.classList.toggle('live', state.enabled);
  els.pageTitle.textContent = activeTab?.title || 'No active page';
  els.pageUrl.textContent = activeTab?.url || 'Open a website tab, then start annotating.';
  els.startButton.disabled = !activeTab?.id || state.enabled;
  els.stopButton.disabled = !activeTab?.id || !state.enabled;
  els.elementMode.classList.toggle('active', state.mode !== 'box');
  els.boxMode.classList.toggle('active', state.mode === 'box');
  els.count.textContent = String(state.annotations.length);
  els.sendButton.disabled = !state.annotations.length;
  els.copyButton.disabled = !state.annotations.length;
  els.downloadButton.disabled = !state.annotations.length;
  els.clearButton.disabled = !state.annotations.length;
  if (document.activeElement !== els.targetInput || !els.targetInput.value) els.targetInput.value = state.targetText || '';
  els.targetStatus.textContent = targetStatusText();
  els.targetStatus.classList.toggle('paired', Boolean(state.target?.surface_ref || state.target?.surface_id));
  if (rebuildList) renderList();
}

function renderList() {
  els.list.textContent = '';
  if (!state.annotations.length) {
    els.list.className = 'list empty';
    const p = document.createElement('p');
    p.textContent = 'No annotations yet.';
    els.list.appendChild(p);
    return;
  }
  els.list.className = 'list';
  for (const annotation of state.annotations) {
    els.list.appendChild(renderAnnotation(annotation));
  }
}

function renderAnnotation(annotation) {
  const card = document.createElement('article');
  card.className = 'annotation';

  const head = document.createElement('div');
  head.className = 'annotation-head';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = annotation.number || '?';

  const titleWrap = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'annotation-title';
  title.textContent = annotationTitle(annotation);
  const meta = document.createElement('p');
  meta.className = 'annotation-meta';
  meta.textContent = annotation.selector || annotation.xpath || `${annotation.kind} region`;
  titleWrap.append(title, meta);

  const del = document.createElement('button');
  del.className = 'delete';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteAnnotation(annotation.id));

  head.append(badge, titleWrap, del);

  const note = document.createElement('textarea');
  note.placeholder = 'Add a note for the agent...';
  note.value = annotation.note || '';
  note.addEventListener('input', () => {
    clearTimeout(noteTimers.get(annotation.id));
    noteTimers.set(annotation.id, setTimeout(() => updateNote(annotation.id, note.value), 250));
  });

  const details = document.createElement('div');
  details.className = 'details';
  details.append(
    detailLine(`Type: ${annotation.kind}`),
    detailLine(`Box: ${Math.round(annotation.bbox?.width || 0)} x ${Math.round(annotation.bbox?.height || 0)} at ${Math.round(annotation.bbox?.pageX || 0)}, ${Math.round(annotation.bbox?.pageY || 0)}`),
    detailLine(`Viewport: ${formatViewport(annotation.viewport)}`),
    detailLine(`Role: ${annotation.role || 'none'}`)
  );

  card.append(head, note, details);
  return card;
}

function formatViewport(viewport) {
  const width = Math.round(Number(viewport?.width || 0));
  const height = Math.round(Number(viewport?.height || 0));
  if (!width || !height) return 'unknown';
  const dpr = Number(viewport?.devicePixelRatio || 0);
  return dpr > 0 ? `${width} x ${height} @ ${formatNumber(dpr)}x` : `${width} x ${height}`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function annotationTitle(annotation) {
  if (annotation.label) return annotation.label;
  if (annotation.text) return annotation.text;
  if (annotation.tagName) return `<${annotation.tagName}>`;
  return annotation.kind === 'box' ? 'Visual region' : 'Element';
}

function detailLine(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

async function copyJson() {
  const json = JSON.stringify(exportPayload(), null, 2);
  await navigator.clipboard.writeText(json);
  flashButton(els.copyButton, 'Copied');
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `annotations-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  flashButton(els.downloadButton, 'Saved');
}

function exportPayload() {
  return {
    source: 'omp-annotation-panel',
    exportedAt: new Date().toISOString(),
    tab: activeTab,
    state: {
      mode: state.mode,
      enabled: state.enabled,
      target: state.target,
      annotations: state.annotations
    }
  };
}

function targetStatusText() {
  const target = state.target;
  if (target?.surface_ref) return `Paired to ${target.surface_ref}`;
  if (target?.surface_id) return `Paired to ${target.surface_id}`;
  if ((state.targetText || '').trim()) return 'Target block needs a surface_ref or surface_id.';
  return 'No OMP target paired. Send uses the active bridge session.';
}

function flashButton(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = old; }, 900);
}

function isModeToggleShortcut(event) {
  return event.altKey && event.shiftKey && (event.code === 'Backquote' || event.key === '`' || event.key === '~');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}
