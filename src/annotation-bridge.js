import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT_START = 47871;
const PORT_END = 47890;
const BRIDGE_VERSION = 2;
const ANNOTATOR_PATH = `${dirname(fileURLToPath(import.meta.url))}/omp-session-annotator.js`;
const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const POLL_INTERVAL_MS = 650;
const CMUX_SEND_CHUNK_SIZE = 8000;
const SCREENSHOT_DIR = '/tmp/omp-annotation-screenshots';
const instanceId = crypto.randomUUID();

let server = null;
let bridgePort = null;
let bridgeToken = null;
let activePi = null;
let activeCtx = null;
const pollers = new Map();
export default function annotationBridge(pi) {
  pi.setLabel('Annotation Bridge');

  pi.on('session_start', async (_event, ctx) => {
    activePi = pi;
    activeCtx = ctx;
    await ensureServer();
    ctx.ui?.notify?.(`Annotation bridge listening on 127.0.0.1:${bridgePort}`, 'info');
  });

  pi.registerCommand?.('annotation-bridge', {
    description: 'Show the local browser annotation bridge endpoint.',
    handler: async (_args, ctx) => {
      activePi = pi;
      activeCtx = ctx;
      await ensureServer();
      return `Annotation bridge: http://127.0.0.1:${bridgePort}/v1/status`;
    }
  });

  pi.registerCommand?.('annotate', {
    description: 'Open a URL in the OMP browser and collect annotations in this session.',
    handler: async (args, ctx) => {
      activePi = pi;
      activeCtx = ctx;
      const target = String(args || '').trim();
      if (!target) return 'Usage: /annotate https://example.com';
      await ensureServer();
      const started = await startCmuxAnnotationSession(target, ctx);
      return `Annotation session ready on ${started.surfaceRef} in ${started.elapsedMs}ms.`;
    }
  });
}


async function ensureServer() {
  if (server) return;
  bridgeToken = crypto.randomUUID();
  for (let port = PORT_START; port <= PORT_END; port += 1) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: handleRequest
      });
      bridgePort = port;
      return;
    } catch (error) {
      if (port === PORT_END) throw error;
    }
  }
}

async function startCmuxAnnotationSession(target, ctx) {
  const startedAt = Date.now();
  const openArgs = ['--json', 'browser', 'open', target, '--focus', 'true'];
  if (process.env.CMUX_WORKSPACE_ID) openArgs.push('--workspace', process.env.CMUX_WORKSPACE_ID);
  const open = await runCmux(openArgs);
  const opened = parseJson(open.stdout, 'cmux browser open');
  const surfaceRef = opened.surface_ref;
  if (!surfaceRef) throw new Error(`cmux did not return a browser surface: ${open.stdout}`);
  await waitForNavigatedSurface(surfaceRef, target);
  await injectAnnotator(surfaceRef);
  startSurfacePoller(surfaceRef, ctx);
  ctx.ui?.notify?.(`Annotation session ready on ${surfaceRef}`, 'info');
  return { surfaceRef, elapsedMs: Date.now() - startedAt };
}

async function waitForNavigatedSurface(surfaceRef, target) {
  const deadline = Date.now() + 5000;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const urlResult = await runCmux(['browser', surfaceRef, 'get', 'url'], { allowFailure: true });
    lastUrl = urlResult.stdout.trim();
    if (urlResult.code === 0 && lastUrl && lastUrl !== 'about:blank') {
      const readyResult = await runCmux(['browser', surfaceRef, 'eval', 'JSON.stringify({ href: location.href, ready: document.readyState })'], { allowFailure: true });
      if (readyResult.code === 0) {
        const ready = parseJson(readyResult.stdout, 'cmux ready check');
        if (ready?.href && ready.href !== 'about:blank' && ready.ready !== 'loading') return;
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${target} to navigate. Last URL: ${lastUrl || 'none'}`);
}

async function injectAnnotator(surfaceRef) {
  const annotator = await Bun.file(ANNOTATOR_PATH).text();
  const script = `${annotator}
window.__ompSessionAnnotator.clear();
window.__ompSessionAnnotator.configureBridge({ port: ${bridgePort}, token: ${JSON.stringify(bridgeToken)} });
JSON.stringify({ ok: true, ready: Boolean(window.__ompSessionAnnotator), export: window.__ompSessionAnnotator.export() });`;
  const result = await runCmux(['browser', surfaceRef, 'eval', script]);
  const payload = parseJson(result.stdout, 'cmux browser eval');
  if (!payload?.ok || !payload?.ready) throw new Error(`annotator injection failed on ${surfaceRef}: ${result.stdout}`);
}

function startSurfacePoller(surfaceRef, ctx) {
  const previous = pollers.get(surfaceRef);
  if (previous) previous.stop();

  const poller = { stopped: false, stop() { this.stopped = true; } };
  pollers.set(surfaceRef, poller);

  const poll = async () => {
    if (poller.stopped) return;
    try {
      const script = 'JSON.stringify(window.__ompSessionAnnotator?.drainOutbox?.() || { done: false, annotations: [] })';
      const result = await runCmux(['browser', surfaceRef, 'eval', script], { allowFailure: true });
      if (result.code === 0 && result.stdout.trim()) {
        const drained = parseJson(result.stdout, 'cmux poll');
        if (Array.isArray(drained?.annotations) && drained.annotations.length) {
          await deliverAnnotations({
            token: bridgeToken,
            page: drained.export?.page,
            annotations: drained.annotations
          });
        }
        if (drained?.done) {
          poller.stop();
          pollers.delete(surfaceRef);
          ctx.ui?.notify?.(`Annotation session finished on ${surfaceRef}`, 'info');
          return;
        }
      }
    } catch (error) {
      ctx.ui?.notify?.(`Annotation polling stopped on ${surfaceRef}: ${error.message}`, 'error');
      poller.stop();
      pollers.delete(surfaceRef);
      return;
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  };

  setTimeout(poll, POLL_INTERVAL_MS);
}

async function runCmux(args, options = {}) {
  const proc = Bun.spawn([CMUX_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`cmux ${args.join(' ')} failed with ${code}: ${stderr || stdout}`);
  }
  return { stdout, stderr, code };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text, label) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} returned non-JSON output: ${trimmed || error.message}`);
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return corsResponse(null, 204);

  if (url.pathname === '/v1/status' && request.method === 'GET') {
    return corsResponse(await getStatus());
  }

  if (url.pathname === '/v1/annotations-beacon' && request.method === 'GET') {
    let body;
    try {
      body = JSON.parse(url.searchParams.get('payload') || '{}');
    } catch (_) {
      return tinyGif(400);
    }
    body.token = url.searchParams.get('token');
    const result = await deliverAnnotations(body);
    return tinyGif(result.ok ? 200 : 400);
  }

  if (url.pathname === '/v1/annotations' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return corsResponse({ ok: false, error: 'Invalid JSON.' }, 400);
    }
    const result = await deliverAnnotations(body);
    if (!result.ok) return corsResponse(result, result.status || 400);
    return corsResponse(result);
  }

  return corsResponse({ ok: false, error: 'Not found.' }, 404);
}

async function deliverAnnotations(body) {
  if (body?.token !== bridgeToken) return { ok: false, status: 403, error: 'Invalid bridge token.' };
  const annotations = normalizeAnnotations(body);
  if (!annotations.length) return { ok: false, status: 400, error: 'No annotations to send.' };
  if (body?.target?.surface_ref || body?.target?.surface_id) {
    await deliverAnnotationsToCmuxTarget(body, annotations);
    return { ok: true, delivered: annotations.length, target: body.target };
  }
  if (!activePi || !activeCtx) return { ok: false, status: 409, error: 'No active OMP session.' };
  const message = formatAnnotationsForChat(body, annotations);
  await activePi.sendUserMessage(message, { deliverAs: 'nextTurn', triggerTurn: true });
  return { ok: true, delivered: annotations.length };
}

async function deliverAnnotationsToCmuxTarget(body, annotations) {
  const target = body.target || {};
  const surface = target.surface_ref || target.surface_id;
  const workspace = target.workspace_ref || target.workspace_id;
  if (!surface) throw new Error('Missing target surface_ref or surface_id.');
  const materialized = await materializeAnnotationScreenshots(annotations);
  const message = formatAnnotationsForTargetedChat(body, materialized);
  for (const chunk of chunkTextForCmuxSend(message)) {
    const sendArgs = ['send'];
    if (workspace) sendArgs.push('--workspace', workspace);
    sendArgs.push('--surface', surface, chunk);
    await runCmux(sendArgs);
  }
  const enterArgs = ['send-key'];
  if (workspace) enterArgs.push('--workspace', workspace);
  enterArgs.push('--surface', surface, 'enter');
  await runCmux(enterArgs);
}

export function chunkTextForCmuxSend(text, size = CMUX_SEND_CHUNK_SIZE) {
  const value = String(text || '');
  const chunks = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

export function formatAnnotationsForTargetedChat(body, annotations) {
  const page = body?.page || body?.tab || {};
  const title = compactText(page.title || body?.title || annotations[0]?.title || 'Annotated page', 80);
  const url = compactUrl(page.url || body?.url || annotations[0]?.url || '');
  const lines = [
    'Brave annotations:',
    `Page: ${title}`,
    url ? `URL: ${url}` : null,
    ...annotations.flatMap((annotation, index) => formatCompactAnnotation(annotation, index + 1))
  ].filter(Boolean);
  return lines.join('\n');
}

function formatCompactAnnotation(annotation, fallbackNumber) {
  const number = annotation.number || fallbackNumber;
  const label = compactText(annotation.label || annotation.text || annotation.selector || annotation.xpath || annotation.kind || 'Annotation', 120);
  const note = compactText(String(annotation.note || '').trim(), 500);
  const selector = compactSelector(annotation.selector || '');
  const xpath = compactText(annotation.xpath || '', 220);
  const box = annotation.bbox ? `${Math.round(annotation.bbox.pageX ?? annotation.bbox.x ?? 0)},${Math.round(annotation.bbox.pageY ?? annotation.bbox.y ?? 0)} ${Math.round(annotation.bbox.width ?? 0)}x${Math.round(annotation.bbox.height ?? 0)}` : '';
  const viewport = formatViewport(annotation.viewport);
  const screenshotLines = formatScreenshotLines(annotation.screenshot, number, annotation.screenshotError);
  const target = [
    annotation.tagName ? `<${annotation.tagName}>` : null,
    annotation.role ? `role=${annotation.role}` : null,
    annotation.attributes ? `attrs=${formatAttributes(annotation.attributes)}` : null
  ].filter(Boolean).join(' ');
  return [
    '',
    `${number}. ${label}`,
    note ? `Note: ${note}` : null,
    target ? `Target: ${target}` : null,
    annotation.text ? `Text: ${compactText(annotation.text, 220)}` : null,
    selector ? `Selector: ${selector}` : null,
    xpath ? `XPath: ${xpath}` : null,
    box ? `Box: ${box}` : null,
    viewport ? `Viewport: ${viewport}` : null,
    ...screenshotLines,
    formatContextLine('Parent', annotation.context?.parent),
    formatContextLine('Container', annotation.context?.container),
    formatSiblingLine('Prev', annotation.context?.previous),
    formatSiblingLine('Next', annotation.context?.next),
    annotation.html ? `HTML: ${compactText(annotation.html, 420)}` : null
  ].filter(Boolean);
}

function formatViewport(viewport) {
  if (!viewport) return '';
  const width = Math.round(Number(viewport.width || 0));
  const height = Math.round(Number(viewport.height || 0));
  if (!width || !height) return '';
  const dpr = Number(viewport.devicePixelRatio || 0);
  return dpr > 0 ? `${width}x${height} @${formatNumber(dpr)}x` : `${width}x${height}`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatContextLine(label, context) {
  if (!context) return null;
  const selector = compactSelector(context.selector || '');
  const attrs = context.attributes ? ` attrs=${formatAttributes(context.attributes)}` : '';
  const text = context.text ? ` text="${compactText(context.text, 180)}"` : '';
  return `${label}: <${context.tagName || 'element'}>${attrs}${selector ? ` selector=${selector}` : ''}${text}`;
}

function formatSiblingLine(label, sibling) {
  if (!sibling?.text) return null;
  const selector = compactSelector(sibling.selector || '');
  const html = sibling.html ? ` html=${compactText(sibling.html, 220)}` : '';
  return `${label}: <${sibling.tagName || 'element'}>${selector ? ` selector=${selector}` : ''} text="${compactText(sibling.text, 140)}"${html}`;
}

function formatAttributes(attributes) {
  return Object.entries(attributes || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}="${compactText(value, 90)}"`)
    .join(' ');
}

function compactText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return compactText(value, 180);
  }
}

function compactSelector(selector) {
  return compactText(String(selector || ''), 300);
}

function formatScreenshotLines(screenshot, number, error) {
  if (!screenshot) return error ? [`Screenshot: unavailable (${compactText(error, 180)})`] : [];
  const mimeType = compactText(screenshot.mimeType || 'image/webp', 40);
  const width = Math.round(Number(screenshot.width || 0));
  const height = Math.round(Number(screenshot.height || 0));
  const originalWidth = Math.round(Number(screenshot.originalWidth || 0));
  const originalHeight = Math.round(Number(screenshot.originalHeight || 0));
  const scale = Number(screenshot.scale || 0);
  const dimensions = width && height ? `${width}x${height}` : 'unknown size';
  const original = originalWidth && originalHeight ? ` from ${originalWidth}x${originalHeight}` : '';
  const scaleText = scale ? ` scale=${scale.toFixed(2)}` : '';
  const lines = [`Screenshot: included ${mimeType} ${dimensions}${original}${scaleText}`];
  if (screenshot.filePath) {
    lines.push(`SCREENSHOT_PATH=${screenshot.filePath}`);
    lines.push(`Screenshot file: ${screenshot.filePath}`);
    lines.push(`![Annotation ${number} screenshot](file://${screenshot.filePath})`);
  }
  return lines;
}

export async function materializeAnnotationScreenshots(annotations) {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  return Promise.all(annotations.map(async (annotation, index) => {
    const screenshot = annotation?.screenshot;
    const dataUrl = String(screenshot?.dataUrl || '');
    if (!dataUrl.startsWith('data:image/')) return annotation;
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return annotation;
    const extension = mimeExtension(match[1]);
    const filename = `annotation-${Date.now()}-${index + 1}.${extension}`;
    const filePath = `${SCREENSHOT_DIR}/${filename}`;
    await writeFile(filePath, Buffer.from(match[2], 'base64'));
    return {
      ...annotation,
      screenshot: {
        ...screenshot,
        filePath
      }
    };
  }));
}

function mimeExtension(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'img';
}

function tinyGif(status = 200) {
  const bytes = Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

async function getStatus() {
  let sessionName = null;
  try {
    sessionName = await activePi?.getSessionName?.();
  } catch (_) {}
  return {
    ok: true,
    bridge: 'omp-annotation-bridge',
    version: BRIDGE_VERSION,
    instanceId,
    token: bridgeToken,
    port: bridgePort,
    hasSession: Boolean(activePi && activeCtx),
    sessionName: sessionName || null,
    cwd: activeCtx?.cwd || null,
    pid: typeof process !== 'undefined' ? process.pid : null
  };
}

function normalizeAnnotations(body) {
  const direct = Array.isArray(body?.annotations) ? body.annotations : null;
  const state = Array.isArray(body?.state?.annotations) ? body.state.annotations : null;
  return (direct || state || []).filter(Boolean);
}

function formatAnnotationsForChat(body, annotations) {
  const page = body?.page || body?.tab || {};
  const title = page.title || body?.title || 'Annotated page';
  const url = page.url || body?.url || annotations[0]?.url || '';
  const lines = [
    'Browser annotations received.',
    '',
    `Page: ${title}`,
    url ? `URL: ${url}` : null,
    '',
    'Annotations:',
    ...annotations.flatMap((annotation, index) => formatAnnotation(annotation, index + 1)),
    '',
    'Raw JSON:',
    '```json',
    JSON.stringify({ ...body, annotations }, null, 2),
    '```'
  ].filter((line) => line !== null);
  return lines.join('\n');
}

function formatAnnotation(annotation, fallbackNumber) {
  const number = annotation.number || fallbackNumber;
  return [
    `${number}. ${annotation.label || annotation.text || annotation.selector || annotation.xpath || annotation.kind || 'Annotation'}`,
    annotation.note ? `   Note: ${String(annotation.note).trim()}` : '   Note: ',
    annotation.selector ? `   Selector: ${annotation.selector}` : null,
    annotation.xpath ? `   XPath: ${annotation.xpath}` : null,
    annotation.bbox ? `   Box: ${Math.round(annotation.bbox.pageX ?? annotation.bbox.x ?? 0)}, ${Math.round(annotation.bbox.pageY ?? annotation.bbox.y ?? 0)}, ${Math.round(annotation.bbox.width ?? 0)} x ${Math.round(annotation.bbox.height ?? 0)}` : null,
    annotation.viewport ? `   Viewport: ${formatViewport(annotation.viewport)}` : null,
    ''
  ].filter((line) => line !== null);
}

function corsResponse(data, status = 200) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
