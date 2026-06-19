import { readFile } from 'node:fs/promises';

const ANNOTATOR_PATH = '/Users/apple/Documents/UNCLUTTER-NEW/CLAUDE-DEV/Annotations/src/omp-session-annotator.js';

export async function installOmpSessionAnnotator(page) {
  const source = await readFile(ANNOTATOR_PATH, 'utf8');
  await page.evaluate(source);
}

export async function waitForOmpSessionAnnotations(page, timeoutMs = 0) {
  return page.evaluate(async (timeout) => {
    const startedAt = Date.now();
    while (!window.__ompSessionAnnotator?.done) {
      if (timeout && Date.now() - startedAt > timeout) throw new Error('Timed out waiting for annotation Done.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return window.__ompSessionAnnotator.export();
  }, timeoutMs);
}
