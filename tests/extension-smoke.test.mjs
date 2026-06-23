import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const extensionPath = root;
const userDataDir = await mkdtemp(resolve(tmpdir(), 'omp-annotation-test-'));
const headless = process.env.HEADLESS === 'true';
const browserArgs = [
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`
];
if (!headless && process.env.FOREGROUND !== 'true') {
  browserArgs.push('--start-minimized', '--window-position=-10000,-10000');
}


let context;
let server;
let bridgeServer;
const bridgeRequests = [];
try {
  server = await startFixtureServer();
  const pageUrl = `http://127.0.0.1:${server.address().port}/page.html`;

  context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: browserArgs
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const extensionOrigin = `chrome-extension://${extensionId}`;

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.waitForLoadState('domcontentloaded');
  const [tab] = await worker.evaluate((url) => chrome.tabs.query({ url }), pageUrl);
  assert(tab?.id, 'test page tab id should be available');

  const targetText = [
    'workspace_ref=workspace:24',
    'workspace_id=1E7EB829-4715-4C13-A38E-8CD9C160FC2A',
    'pane_ref=pane:31',
    'pane_id=91FA6352-690D-47CB-A988-A61037958B86',
    'surface_ref=surface:31',
    'surface_id=507384C1-817B-4258-95A9-E4DAFB61D39E'
  ].join('\n');
  const panel = await context.newPage();
  await panel.goto(`${extensionOrigin}/src/sidepanel.html`);
  await panel.evaluate((text) => navigator.clipboard.writeText(text), targetText);
  await panel.reload();
  const seoLink = panel.locator('.brand-footer a');
  await seoLink.waitFor();
  assert(await seoLink.textContent() === 'SEO Time Machines', 'side panel footer should link SEO Time Machines');
  assert(await seoLink.getAttribute('href') === 'https://seotimemachines.com/', 'SEO Time Machines footer link should point to the site');
  assert(await panel.locator('#queueButton').textContent() === 'Queue', 'side panel should expose a queue action');
  const send = (message) => panel.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  assert(commands.some((command) => command.name === 'toggle-annotating' && command.shortcut), 'toggle shortcut should be registered');
  assert(commands.some((command) => command.name === 'element-mode' && command.shortcut), 'element shortcut should be registered');
  assert(commands.some((command) => command.name === 'box-mode' && command.shortcut), 'box shortcut should be registered');

  const bootstrapped = await waitForBootstrap(send, tab.id);
  assert(bootstrapped.target.surface_ref === 'surface:31', 'clipboard bootstrap should capture surface_ref');
  assert(bootstrapped.target.workspace_ref === 'workspace:24', 'clipboard bootstrap should capture workspace_ref');
  assert(bootstrapped.enabled === true, 'clipboard bootstrap should start annotation mode');
  assert(bootstrapped.mode === 'element', 'clipboard bootstrap should choose element mode');
  const renderedTarget = await panel.locator('#targetInput').inputValue();
  assert(renderedTarget === targetText, 'side panel target textarea should render the clipboard target');
  await page.bringToFront();
  await page.keyboard.press('Escape');
  await waitForEnabled(send, tab.id, false);
  await waitForOverlayEmpty(page);
  await send({ type: 'OMP_ANNOTATION_SET_ENABLED', tabId: tab.id, enabled: true });
  await waitForEnabled(send, tab.id, true);
  await pressModeToggle(page);
  await waitForMode(send, tab.id, 'box');
  await pressModeToggle(page);
  await waitForMode(send, tab.id, 'element');
  await page.locator('#cta').click({ force: true });
  await page.keyboard.press('ArrowUp');
  const parentTargetLabel = await targetLabelText(page);
  assert(parentTargetLabel.includes('section'), `ArrowUp should target the parent element, got ${parentTargetLabel}`);
  await page.keyboard.press('ArrowDown');
  const childTargetLabel = await targetLabelText(page);
  assert(childTargetLabel.includes('button#cta'), `ArrowDown should return to the child element, got ${childTargetLabel}`);
  await page.keyboard.press('Enter');

  await waitForAnnotationCount(send, tab.id, 1);

  const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: tab.id }).then((response) => response.state);
  assert(state.enabled === true, 'annotation mode should be enabled');
  assert(state.annotations.length === 1, 'one annotation should be captured');
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }));
  const annotation = state.annotations[0];
  assert(annotation.selector === '#cta', `expected stable id selector, got ${annotation.selector}`);
  assert(annotation.role === 'button', `expected button role, got ${annotation.role}`);
  assert(annotation.label === 'Play Week 1 video', `expected aria label, got ${annotation.label}`);
  assert(annotation.bbox.width > 20, 'expected non-empty bounding box');
  assert(annotation.viewport?.width === viewport.width && annotation.viewport?.height === viewport.height && annotation.viewport?.devicePixelRatio === viewport.devicePixelRatio, `element annotation should include current viewport dimensions, got ${JSON.stringify(annotation.viewport)} expected ${JSON.stringify(viewport)}`);
  assert(annotation.html.includes('<button id="cta"'), 'annotation should include target outer HTML');
  assert(annotation.context?.parent?.selector === 'section[data-testid="hero-card"]', `expected parent context selector, got ${annotation.context?.parent?.selector}`);
  assert(annotation.context?.previous?.html?.includes('<p>Start here'), 'annotation should include previous sibling HTML context');

  const longNote = 'Make this play button more obvious and explain that the copied target should remain readable even when the annotation text is long enough to wrap across several visible lines.';
  await page.evaluate(() => {
    const textarea = document.querySelector('#omp-annotation-root').shadowRoot.querySelector('.note textarea');
    textarea.focus();
  });
  await page.keyboard.down('Meta');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Meta');
  await waitForAnnotationSelector(send, tab.id, annotation.id, 'section[data-testid="hero-card"]');
  await page.keyboard.down('Meta');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Meta');
  await waitForAnnotationSelector(send, tab.id, annotation.id, '#cta');
  await page.keyboard.type(longNote);
  await waitForAnnotationNote(send, tab.id, annotation.id, longNote);
  const expandedInline = await page.evaluate(() => {
    const note = document.querySelector('#omp-annotation-root').shadowRoot.querySelector('.note');
    const textarea = note.querySelector('textarea');
    const noteStyle = getComputedStyle(note);
    return {
      height: textarea.getBoundingClientRect().height,
      collapsedClass: note.classList.contains('expanded'),
      borderRadius: noteStyle.borderRadius,
      borderColor: noteStyle.borderColor,
      backgroundColor: noteStyle.backgroundColor
    };
  });
  assert(expandedInline.height > 18, `inline note should expand beyond one line, got ${expandedInline.height}`);
  assert(expandedInline.collapsedClass, 'focused inline note should be marked expanded');
  assert(expandedInline.borderRadius === '8px', `inline note should have 8px radius, got ${expandedInline.borderRadius}`);
  assert(!expandedInline.borderColor.includes('245, 158, 11'), `inline note border should not be orange, got ${expandedInline.borderColor}`);
  assert(expandedInline.backgroundColor.includes('8, 11, 18'), `inline note should stay dark, got ${expandedInline.backgroundColor}`);
  const focusedInline = await page.evaluate(() => document.querySelector('#omp-annotation-root').shadowRoot.activeElement?.tagName === 'TEXTAREA');
  assert(focusedInline, 'inline note textarea should keep focus while typing');

  await page.locator('header h1').click({ force: true });
  await page.keyboard.press('Enter');
  await waitForAnnotationCount(send, tab.id, 2);
  const withHeading = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: tab.id }).then((response) => response.state);
  const heading = withHeading.annotations[1];
  assert(heading.selector === 'header > h1', `heading selector should include parent specificity, got ${heading.selector}`);
  assert(heading.context?.previous?.html?.includes('stm-pv-kicker'), 'heading context should include the preceding kicker HTML');
  const collapsedAfterSecondAnnotation = await page.evaluate(() => {
    const notes = [...document.querySelector('#omp-annotation-root').shadowRoot.querySelectorAll('.note')];
    const firstTextarea = notes[0]?.querySelector('textarea');
    return {
      noteCount: notes.length,
      firstHeight: firstTextarea?.getBoundingClientRect().height || 0,
      firstExpanded: notes[0]?.classList.contains('expanded') || false,
      secondExpanded: notes[1]?.classList.contains('expanded') || false
    };
  });
  assert(collapsedAfterSecondAnnotation.noteCount === 2, `expected two visible inline notes, got ${collapsedAfterSecondAnnotation.noteCount}`);
  assert(collapsedAfterSecondAnnotation.firstHeight === 18, `previous inline note should collapse to one line after a nearby annotation, got ${collapsedAfterSecondAnnotation.firstHeight}`);
  assert(!collapsedAfterSecondAnnotation.firstExpanded, 'previous inline note should no longer be marked expanded');
  assert(collapsedAfterSecondAnnotation.secondExpanded, 'new inline note should be the expanded note');

  await send({ type: 'OMP_ANNOTATION_SET_MODE', tabId: tab.id, mode: 'box' });
  const modeState = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: tab.id }).then((response) => response.state);
  assert(modeState.mode === 'box', 'box mode should persist');

  await page.mouse.move(420, 320);
  await page.mouse.down();
  await page.mouse.move(620, 430);
  await page.mouse.up();
  await waitForAnnotationCount(send, tab.id, 3);

  const withBox = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: tab.id }).then((response) => response.state);
  assert(withBox.annotations[2].kind === 'box', 'box annotation should be captured');
  assert(withBox.annotations[2].bbox.width === 200, `expected 200px wide box, got ${withBox.annotations[2].bbox.width}`);
  assert(withBox.annotations[2].viewport?.width === viewport.width && withBox.annotations[2].viewport?.height === viewport.height && withBox.annotations[2].viewport?.devicePixelRatio === viewport.devicePixelRatio, `box annotation should include current viewport dimensions, got ${JSON.stringify(withBox.annotations[2].viewport)} expected ${JSON.stringify(viewport)}`);
  const boxScreenshot = withBox.annotations[2].screenshot;
  assert(boxScreenshot?.dataUrl?.startsWith('data:image/webp;base64,'), 'box annotation should include a compact WebP screenshot');
  assert(boxScreenshot.width <= 1920, `box screenshot width should be capped at 1920, got ${boxScreenshot.width}`);
  assert(boxScreenshot.scale <= 0.5, `box screenshot should be at least 2x compressed, got scale ${boxScreenshot.scale}`);
  await send({ type: 'OMP_ANNOTATION_SET_ENABLED', tabId: tab.id, enabled: false });
  await waitForEnabled(send, tab.id, false);
  await waitForOverlayEmpty(page);

  const renderedCount = await panel.locator('#count').textContent();
  assert(renderedCount === '3', `side panel should render three annotations, got ${renderedCount}`);
  assert(await panel.locator('.details').first().textContent().then((text) => text.includes(`Viewport: ${viewport.width} x ${viewport.height}`)), 'side panel should render viewport dimensions');
  bridgeServer = await startBridgeServer(bridgeRequests);
  await worker.evaluate((port) => chrome.storage.local.set({
    ompAnnotationBridge: { ok: true, port, token: 'test-token', version: 2 }
  }), bridgeServer.address().port);
  await panel.locator('#queueButton').click();
  const queueRequest = await waitForBridgeRequest(bridgeRequests);
  assert(queueRequest.deliveryMode === 'queue', `queue button should request queued delivery, got ${queueRequest.deliveryMode}`);
  assert(queueRequest.token === 'test-token', 'queue delivery should use the cached bridge token');
  assert(queueRequest.annotations.length === 3, `queue delivery should send all annotations, got ${queueRequest.annotations.length}`);


  await send({ type: 'OMP_ANNOTATION_CLEAR', tabId: tab.id });
  const cleared = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId: tab.id }).then((response) => response.state);
  assert(cleared.annotations.length === 0, 'clear should remove annotations');


  console.log('extension smoke test passed');
} finally {
  if (context) await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (bridgeServer) await new Promise((resolve) => bridgeServer.close(resolve));
  await rm(userDataDir, { recursive: true, force: true });
}

async function waitForBootstrap(send, tabId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    if (state.enabled && state.mode === 'element' && state.target?.surface_ref) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('side panel did not bootstrap from clipboard');
}

async function waitForAnnotationCount(send, tabId, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    if (state.annotations.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected ${count} annotations`);
}

async function waitForEnabled(send, tabId, enabled) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    if (state.enabled === enabled) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected annotation enabled=${enabled}`);
}

async function waitForMode(send, tabId, mode) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    if (state.mode === mode) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected annotation mode=${mode}`);
}

async function waitForOverlayEmpty(page) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => {
      const root = document.querySelector('#omp-annotation-root');
      const shadow = root?.shadowRoot;
      if (!shadow) return 0;
      return shadow.querySelectorAll('.box, .pin, .note, .outline.visible, .drag.visible').length;
    });
    if (count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('annotation overlay did not clean up');
}

async function pressModeToggle(page) {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Backquote');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
}

async function targetLabelText(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#omp-annotation-root');
    return root?.shadowRoot?.querySelector('.target-label')?.textContent || '';
  });
}

async function waitForAnnotationNote(send, tabId, id, note) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    const annotation = state.annotations.find((item) => item.id === id);
    if (annotation?.note === note) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('inline note did not persist');
}

async function waitForAnnotationSelector(send, tabId, id, selector) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await send({ type: 'OMP_ANNOTATION_GET_STATE', tabId }).then((response) => response.state);
    const annotation = state.annotations.find((item) => item.id === id);
    if (annotation?.selector === selector) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`annotation did not retarget to ${selector}`);
}


async function startFixtureServer() {
  const body = await readFile(resolve(__dirname, 'fixtures/page.html'));
  const server = createServer((request, response) => {
    if (request.url === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function startBridgeServer(requests) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/status') {
      sendJson(response, 200, { ok: true, bridge: 'omp-annotation-bridge', version: 2, token: 'test-token' });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/annotations') {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}');
        requests.push(body);
        sendJson(response, 200, { ok: true, delivered: body.annotations?.length || 0, queued: body.deliveryMode === 'queue' });
      });
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json'
  });
  response.end(JSON.stringify(data));
}

async function waitForBridgeRequest(requests) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (requests.length) return requests[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('queue delivery did not reach the bridge');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
