const DEFAULT_STATE = {
  enabled: false,
  mode: 'element',
  targetText: '',
  target: null,
  annotations: []
};
const BRIDGE_PORT_START = 47871;
const MIN_BRIDGE_VERSION = 2;
const BRIDGE_PORT_END = 47890;
const BRIDGE_CACHE_KEY = 'ompAnnotationBridge';
const BOX_SCREENSHOT_MAX_WIDTH = 1920;
const BOX_SCREENSHOT_SCALE = 0.5;
const BOX_SCREENSHOT_QUALITY = 0.85;



let lastAnnotatableTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  rememberTab(tab);
  await openPanelAndStart(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  rememberTab(tab);
  if (command === 'toggle-annotating') {
    await openPanelAndToggle(tab.id);
    return;
  }
  if (command === 'element-mode') {
    await openPanelAndSetMode(tab.id, 'element');
    return;
  }
  if (command === 'box-mode') {
    await openPanelAndSetMode(tab.id, 'box');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  rememberTab(tab);
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
  rememberTab(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

async function openPanelAndStart(tabId) {
  await openSidePanel(tabId);
  await ensureContentScript(tabId);
  const state = await patchState(tabId, { enabled: true, mode: 'element' });
  await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state });
  broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state });
}

async function openPanelAndToggle(tabId) {
  await openSidePanel(tabId);
  await ensureContentScript(tabId);
  const current = await getState(tabId);
  const state = await patchState(tabId, { enabled: !current.enabled });
  await sendToTab(tabId, { type: 'OMP_ANNOTATION_SET_ENABLED', enabled: state.enabled });
  broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state });
}

async function openPanelAndSetMode(tabId, mode) {
  await openSidePanel(tabId);
  await ensureContentScript(tabId);
  const state = await patchState(tabId, { enabled: true, mode });
  await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state });
  broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state });
}

async function openSidePanel(tabId) {
  await chrome.sidePanel.open({ tabId }).catch(() => {});
}

async function handleMessage(message, sender) {
  const type = message?.type;
  if (type === 'OMP_ANNOTATION_GET_ACTIVE_TAB') {
    const tab = await getActiveTab();
    if (tab) rememberTab(tab);
    return { ok: true, tab: tab ? serializeTab(tab) : null };
  }

  if (type === 'OMP_ANNOTATION_GET_STATE') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    return { ok: true, state: await getState(tabId), tabId };
  }

  if (type === 'OMP_ANNOTATION_SET_ENABLED') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const state = await patchState(tabId, { enabled: Boolean(message.enabled) });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SET_ENABLED', enabled: state.enabled });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state });
    return { ok: true, state };
  }

  if (type === 'OMP_ANNOTATION_SET_MODE') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const mode = message.mode === 'box' ? 'box' : 'element';
    const state = await patchState(tabId, { mode });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SET_MODE', mode });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state });
    return { ok: true, state };
  }

  if (type === 'OMP_ANNOTATION_ADDED') {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: false, error: 'Annotation did not include a tab.' };
    const state = await getState(tabId);
    const annotation = await enrichAnnotationWithScreenshot(tabId, normalizeAnnotation(message.annotation, state.annotations.length + 1, tabId));
    const annotations = state.annotations.concat(annotation);
    const next = await patchState(tabId, { annotations });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, annotation };
  }

  if (type === 'OMP_ANNOTATION_UPDATE_NOTE') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const state = await getState(tabId);
    const annotations = state.annotations.map((annotation) => annotation.id === message.id ? { ...annotation, note: String(message.note || '') } : annotation);
    const next = await patchState(tabId, { annotations });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state: next });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next };
  }

  if (type === 'OMP_ANNOTATION_DELETE') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const state = await getState(tabId);
    const annotations = renumber(state.annotations.filter((annotation) => annotation.id !== message.id));
    const next = await patchState(tabId, { annotations });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state: next });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next };
  }

  if (type === 'OMP_ANNOTATION_CLEAR') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const next = await patchState(tabId, { annotations: [] });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state: next });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next };
  }

  if (type === 'OMP_ANNOTATION_SET_TARGET') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const targetText = String(message.targetText || '');
    const target = parseCmuxTarget(targetText);
    const next = await patchState(tabId, { targetText, target });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next, target };
  }

  if (type === 'OMP_ANNOTATION_BOOTSTRAP_FROM_TARGET') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const targetText = String(message.targetText || '');
    const target = parseCmuxTarget(targetText);
    if (!target) return { ok: false, error: 'Clipboard did not contain an OMP target.' };
    await ensureContentScript(tabId);
    const next = await patchState(tabId, { targetText, target, enabled: true, mode: 'element' });
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state: next });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next, target };
  }
  if (type === 'OMP_ANNOTATION_SEND_ONE_TO_OMP') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const state = await getState(tabId);
    const annotation = state.annotations.find((item) => item.id === message.id);
    if (!annotation) return { ok: false, error: 'Annotation not found.' };
    const note = String(message.note ?? annotation.note ?? '');
    const sentAt = new Date().toISOString();
    const annotations = state.annotations.map((item) => item.id === annotation.id ? { ...item, note, sentAt } : item);
    const next = await patchState(tabId, { annotations });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const result = await sendAnnotationsToOmp({
      tab: tab ? serializeTab(tab) : null,
      state: { ...next, annotations: [{ ...annotation, note, sentAt }] },
      target: next.target
    });
    if (!result.ok) return result;
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state: next });
    broadcast({ type: 'OMP_ANNOTATION_STATE_CHANGED', tabId, state: next });
    return { ok: true, state: next, delivered: result.delivered };
  }


  if (type === 'OMP_ANNOTATION_SEND_TO_OMP') {
    const tabId = message.tabId ?? sender.tab?.id ?? (await getActiveTab())?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const state = await getState(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return sendAnnotationsToOmp({ tab: tab ? serializeTab(tab) : null, state, target: state.target });
  }

  if (type === 'OMP_ANNOTATION_CONTENT_READY') {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: true };
    rememberTab(sender.tab);
    const state = await getState(tabId);
    await sendToTab(tabId, { type: 'OMP_ANNOTATION_SYNC', state }).catch(() => {});
    return { ok: true, state };
  }

  return { ok: false, error: `Unknown message type: ${type}` };
}

async function getActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isAnnotatableTab(active)) return active;
  if (lastAnnotatableTabId) {
    const remembered = await chrome.tabs.get(lastAnnotatableTabId).catch(() => null);
    if (isAnnotatableTab(remembered)) return remembered;
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.active && isAnnotatableTab(tab)) || tabs.find(isAnnotatableTab) || active || null;
}

function rememberTab(tab) {
  if (isAnnotatableTab(tab)) lastAnnotatableTabId = tab.id;
}

function isAnnotatableTab(tab) {
  return Boolean(tab?.id && /^(https?|file):/i.test(tab.url || ''));
}

function serializeTab(tab) {
  return { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl };
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'OMP_ANNOTATION_PING' });
    return;
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] });
  }
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function getState(tabId) {
  const result = await chrome.storage.session.get(tabKey(tabId));
  return { ...DEFAULT_STATE, ...(result[tabKey(tabId)] || {}) };
}
async function sendAnnotationsToOmp(payload) {
  const bridge = await discoverBridge();
  if (!bridge?.ok) return bridge;
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: bridge.token,
      target: payload.target || payload.state?.target || null,
      tab: payload.tab ? { title: payload.tab.title, url: payload.tab.url } : null,
      annotations: compactAnnotations(payload.state?.annotations || [])
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) return { ok: false, error: data.error || `Bridge HTTP ${response.status}` };
  return { ok: true, delivered: data.delivered || 0, port: bridge.port };
}

function compactAnnotations(annotations) {
  return annotations.map((annotation) => ({
    number: annotation.number,
    kind: annotation.kind,
    label: annotation.label,
    note: annotation.note,
    tagName: annotation.tagName,
    role: annotation.role,
    text: annotation.text,
    selector: annotation.selector,
    xpath: annotation.xpath,
    url: annotation.url,
    frameUrl: annotation.frameUrl,
    attributes: annotation.attributes,
    html: annotation.html,
    context: annotation.context,
    bbox: annotation.bbox ? {
      pageX: annotation.bbox.pageX,
      pageY: annotation.bbox.pageY,
      width: annotation.bbox.width,
      height: annotation.bbox.height
    } : null,
    viewport: annotation.viewport ? {
      width: annotation.viewport.width,
      height: annotation.viewport.height
    } : null,
    scroll: annotation.scroll ? {
      x: annotation.scroll.x,
      y: annotation.scroll.y
    } : null,
    screenshot: annotation.screenshot ? {
      mimeType: annotation.screenshot.mimeType,
      dataUrl: annotation.screenshot.dataUrl,
      width: annotation.screenshot.width,
      height: annotation.screenshot.height,
      originalWidth: annotation.screenshot.originalWidth,
      originalHeight: annotation.screenshot.originalHeight,
      scale: annotation.screenshot.scale
    } : null,
    screenshotError: annotation.screenshotError || null
  }));
}

async function discoverBridge() {
  const cached = await chrome.storage.local.get(BRIDGE_CACHE_KEY);
  const cachedBridge = cached[BRIDGE_CACHE_KEY];
  if (cachedBridge && await probeBridge(cachedBridge.port, cachedBridge.token)) return cachedBridge;

  for (let port = BRIDGE_PORT_START; port <= BRIDGE_PORT_END; port += 1) {
    const bridge = await fetchBridgeStatus(port);
    if (bridge?.ok && bridge.token) {
      await chrome.storage.local.set({ [BRIDGE_CACHE_KEY]: bridge });
      return bridge;
    }
  }
  return { ok: false, error: 'No active OMP annotation bridge v2 found. Start or restart OMP after installing annotation-bridge.js.' };
}

async function probeBridge(port, token) {
  const bridge = await fetchBridgeStatus(port);
  return Boolean(bridge?.ok && bridge.token === token && bridge.version >= MIN_BRIDGE_VERSION);
}

async function fetchBridgeStatus(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { method: 'GET' });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.bridge !== 'omp-annotation-bridge') return null;
    if ((data.version || 0) < MIN_BRIDGE_VERSION) return null;
    return { ok: true, port, token: data.token, version: data.version, sessionName: data.sessionName || null };
  } catch (_) {
    return null;
  }
}


async function patchState(tabId, patch) {
  const state = { ...(await getState(tabId)), ...patch };
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
  return state;
}

function tabKey(tabId) {
  return `tab:${tabId}`;
}

function parseCmuxTarget(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const target = { raw };
  const pairs = raw.matchAll(/\b(workspace_ref|workspace_id|pane_ref|pane_id|surface_ref|surface_id)\s*=\s*([^\s]+)/gi);
  for (const match of pairs) {
    target[match[1].toLowerCase()] = match[2].trim();
  }
  if (!target.surface_ref && !target.surface_id) return null;
  return target;
}

function normalizeAnnotation(input, number, tabId) {
  const id = input?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    number,
    tabId,
    kind: input?.kind === 'box' ? 'box' : 'element',
    note: String(input?.note || ''),
    url: String(input?.url || ''),
    frameUrl: String(input?.frameUrl || ''),
    title: String(input?.title || ''),
    selector: input?.selector || null,
    xpath: input?.xpath || null,
    role: input?.role || null,
    label: input?.label || null,
    text: input?.text || null,
    tagName: input?.tagName || null,
    attributes: input?.attributes && typeof input.attributes === 'object' ? input.attributes : null,
    html: input?.html || null,
    context: input?.context && typeof input.context === 'object' ? input.context : null,
    bbox: sanitizeBox(input?.bbox),
    viewport: sanitizeViewport(input?.viewport),
    scroll: sanitizeScroll(input?.scroll),
    devicePixelRatio: Number(input?.devicePixelRatio || 1),
    screenshot: sanitizeScreenshot(input?.screenshot),
    screenshotError: input?.screenshotError ? String(input.screenshotError) : null,
    capturedAt: input?.capturedAt || new Date().toISOString()
  };
}

async function enrichAnnotationWithScreenshot(tabId, annotation) {
  if (annotation.kind !== 'box' || !annotation.bbox?.width || !annotation.bbox?.height) return annotation;
  try {
    const screenshot = await captureBoxScreenshot(tabId, annotation);
    return screenshot ? { ...annotation, screenshot, screenshotError: null } : { ...annotation, screenshotError: 'captureVisibleTab returned no image.' };
  } catch (error) {
    return { ...annotation, screenshotError: String(error?.message || error) };
  }
}

async function captureBoxScreenshot(tabId, annotation) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const dataUrl = await captureVisibleTabDataUrl(tab?.windowId);
  if (!dataUrl) return null;
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  try {
    const viewportWidth = Math.max(1, annotation.viewport?.width || bitmap.width);
    const viewportHeight = Math.max(1, annotation.viewport?.height || bitmap.height);
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    const sourceX = clamp(Math.round(annotation.bbox.x * scaleX), 0, bitmap.width - 1);
    const sourceY = clamp(Math.round(annotation.bbox.y * scaleY), 0, bitmap.height - 1);
    const sourceWidth = clamp(Math.round(annotation.bbox.width * scaleX), 1, bitmap.width - sourceX);
    const sourceHeight = clamp(Math.round(annotation.bbox.height * scaleY), 1, bitmap.height - sourceY);
    const halfWidth = Math.max(1, Math.floor(sourceWidth * BOX_SCREENSHOT_SCALE));
    const targetWidth = Math.min(BOX_SCREENSHOT_MAX_WIDTH, halfWidth);
    const targetHeight = Math.max(1, Math.round(sourceHeight * (targetWidth / sourceWidth)));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: BOX_SCREENSHOT_QUALITY });
    return {
      mimeType: 'image/webp',
      dataUrl: await blobToDataUrl(webp),
      width: targetWidth,
      height: targetHeight,
      originalWidth: sourceWidth,
      originalHeight: sourceHeight,
      scale: targetWidth / sourceWidth
    };
  } finally {
    bitmap.close();
  }
}

function captureVisibleTabDataUrl(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      resolve(chrome.runtime.lastError ? null : dataUrl);
    });
  });
}

async function dataUrlToBlob(dataUrl) {
  return await fetch(dataUrl).then((response) => response.blob());
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function sanitizeScreenshot(screenshot) {
  if (!screenshot || typeof screenshot !== 'object') return null;
  const dataUrl = String(screenshot.dataUrl || '');
  if (!dataUrl.startsWith('data:image/')) return null;
  return {
    mimeType: String(screenshot.mimeType || 'image/webp'),
    dataUrl,
    width: Number(screenshot.width || 0),
    height: Number(screenshot.height || 0),
    originalWidth: Number(screenshot.originalWidth || 0),
    originalHeight: Number(screenshot.originalHeight || 0),
    scale: Number(screenshot.scale || 0)
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renumber(annotations) {
  return annotations.map((annotation, index) => ({ ...annotation, number: index + 1 }));
}

function sanitizeBox(box) {
  return {
    x: Number(box?.x || 0),
    y: Number(box?.y || 0),
    width: Number(box?.width || 0),
    height: Number(box?.height || 0),
    pageX: Number(box?.pageX || 0),
    pageY: Number(box?.pageY || 0)
  };
}

function sanitizeViewport(viewport) {
  return {
    width: Number(viewport?.width || 0),
    height: Number(viewport?.height || 0),
    devicePixelRatio: Number(viewport?.devicePixelRatio || 1)
  };
}

function sanitizeScroll(scroll) {
  return {
    x: Number(scroll?.x || 0),
    y: Number(scroll?.y || 0)
  };
}
