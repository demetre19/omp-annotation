import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import bridge, { chunkTextForCmuxSend, formatAnnotationsForTargetedChat, materializeAnnotationScreenshots } from '../src/annotation-bridge.js';

let command;
const sent = [];
const pi = {
  setLabel() {},
  on() {},
  registerCommand(name, spec) {
    if (name === 'annotate') command = spec;
  },
  async sendUserMessage(message) {
    sent.push(message);
  }
};

bridge(pi);
assert(command, 'bridge should register annotate command');

const statusResponse = await fetch('http://127.0.0.1:47890/v1/status').catch(() => null);
assert.equal(statusResponse, null, 'test should not depend on a fixed live port');


const targeted = formatAnnotationsForTargetedChat({
  tab: { title: 'Protected Videos - Learn', url: 'https://learn.seotimemachines.com/admin/videos' }
}, [{
  number: 1,
  label: 'STM Protected Video',
  note: 'this is a test',
  tagName: 'h1',
  role: 'heading',
  text: 'STM Protected Video',
  selector: 'div.stm-pv-hero:nth-of-type(1) > div:nth-of-type(1) > h1',
  xpath: '/html/body/main/section[1]/div/h1',
  bbox: { pageX: 48, pageY: 120, width: 420, height: 54 },
  html: '<h1>STM Protected Video</h1>',
  screenshot: {
    mimeType: 'image/webp',
    dataUrl: 'data:image/webp;base64,TEST_IMAGE_BYTES',
    width: 210,
    height: 27,
    originalWidth: 420,
    originalHeight: 54,
    scale: 0.5,
    filePath: '/tmp/omp-annotation-screenshots/annotation-test.webp'
  },
  context: {
    previous: {
      tagName: 'p',
      selector: 'div.stm-pv-hero:nth-of-type(1) > div:nth-of-type(1) > p.stm-pv-kicker:nth-of-type(1)',
      text: 'Protected video hosting',
      html: '<p class="stm-pv-kicker">Protected video hosting</p>'
    }
  }
}]);
assert(targeted.includes('Page: Protected Videos - Learn'), 'targeted formatter should include page title');
assert(targeted.includes('Selector: div.stm-pv-hero:nth-of-type(1) > div:nth-of-type(1) > h1'), 'targeted formatter should keep specific selectors');
assert(targeted.includes('<p class="stm-pv-kicker">Protected video hosting</p>'), 'targeted formatter should include nearby sibling HTML');
assert(!targeted.includes('Raw JSON'), 'targeted formatter should not send raw JSON');
assert(targeted.includes('Screenshot: included image/webp 210x27 from 420x54 scale=0.50'), 'targeted formatter should include screenshot metadata');
assert(targeted.includes('Screenshot file: /tmp/omp-annotation-screenshots/annotation-test.webp'), 'targeted formatter should include screenshot file path');
assert(targeted.includes('![Annotation 1 screenshot](file:///tmp/omp-annotation-screenshots/annotation-test.webp)'), 'targeted formatter should include file markdown image');
assert(!targeted.includes('TEST_IMAGE_BYTES'), 'targeted formatter should not include raw screenshot data');
const chunks = chunkTextForCmuxSend(`prefix ${'x'.repeat(17000)} suffix`);
assert(chunks.length === 3, `long targeted messages should be split into cmux-safe chunks, got ${chunks.length}`);
assert(chunks.join('') === `prefix ${'x'.repeat(17000)} suffix`, 'chunking should preserve full image markdown payload');
const materialized = await materializeAnnotationScreenshots([{ screenshot: { mimeType: 'image/webp', dataUrl: 'data:image/webp;base64,VEVTVA==' } }]);
assert(materialized[0].screenshot.filePath.startsWith('/tmp/omp-annotation-screenshots/annotation-'), 'materializer should write screenshot to a local file path');
assert.equal(await readFile(materialized[0].screenshot.filePath, 'utf8'), 'TEST', 'materialized screenshot file should contain decoded bytes');
// Exercise formatter through the public HTTP handler is not practical without owning the port.
// This test keeps the module importable after compact-delivery changes.
console.log('compact bridge import test passed');
