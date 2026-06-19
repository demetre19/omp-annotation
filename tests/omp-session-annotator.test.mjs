import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../src/omp-session-annotator.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

try {
  await page.setContent(`<!doctype html>
    <style>
      body { height: 1600px; font: 16px sans-serif; }
      .target { display: block; margin: 120px 20px; padding: 24px; background: #eee; border: 1px solid #ccc; }
    </style>
    <button id="one" class="target">First target</button>
    <button id="two" class="target">Second target</button>
  `);
  await page.addScriptTag({ content: source });
  await page.click('#one', { force: true });
  await page.locator('.note textarea').fill('save only');
  await dispatchNoteEnter(page, { metaKey: true });
  let drained = await page.evaluate(() => window.__ompSessionAnnotator.drainOutbox());
  assert.equal(drained.annotations.length, 0, 'Command+Enter should save without sending');
  let exported = await page.evaluate(() => window.__ompSessionAnnotator.export());
  assert.equal(exported.annotations[0].note, 'save only', 'Command+Enter should persist note text');
  assert.equal(Boolean(exported.annotations[0].queuedAt), false, 'Command+Enter should not queue annotation');

  await dispatchNoteEnter(page);
  drained = await page.evaluate(() => window.__ompSessionAnnotator.drainOutbox());
  assert.equal(drained.annotations.length, 1, 'Enter should send the current annotation');
  assert.equal(drained.annotations[0].note, 'save only', 'Enter should send saved note text');
  assert.equal(drained.done, false, 'Single Enter should not finish the session');

  await page.evaluate(() => window.__ompSessionAnnotator.clear());
  await page.click('#one', { force: true });
  await page.locator('.note textarea').fill('delete me');
  await page.locator('button.delete').click();
  exported = await page.evaluate(() => window.__ompSessionAnnotator.export());
  assert.equal(exported.annotations.length, 0, 'delete button should remove annotation');

  await page.click('#one', { force: true });
  await page.locator('.note textarea').fill('first saved');
  await dispatchNoteEnter(page, { metaKey: true });
  await page.click('#two', { force: true });
  await page.locator('.note textarea').last().fill('second saved');
  await dispatchNoteEnter(page, { metaKey: true, index: 1 });
  await dispatchNoteEnter(page, { index: 1 });
  await dispatchNoteEnter(page, { index: 1 });
  drained = await page.evaluate(() => window.__ompSessionAnnotator.drainOutbox());
  assert.equal(drained.done, true, 'double Enter should finish the session');
  assert.equal(drained.annotations.length, 2, 'double Enter should send every saved annotation');
  assert.deepEqual(drained.annotations.map((annotation) => annotation.note), ['first saved', 'second saved']);

  console.log('omp session annotator test passed');
} finally {
  await browser.close();
}

async function dispatchNoteEnter(page, options = {}) {
  const locator = page.locator('.note textarea').nth(options.index || 0);
  await locator.dispatchEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true,
    metaKey: Boolean(options.metaKey),
    ctrlKey: Boolean(options.ctrlKey),
    shiftKey: Boolean(options.shiftKey)
  });
}
