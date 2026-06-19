import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.HOME || '/Users/apple';
const bridgeSource = `${root}/src/annotation-bridge.js`;
const annotatorSource = `${root}/src/omp-session-annotator.js`;
const agentDir = `${home}/.omp/agent`;
const extensionDir = `${agentDir}/extensions`;
const commandDir = `${agentDir}/commands`;
const bridgeTarget = `${extensionDir}/annotation-bridge.js`;
const annotatorTarget = `${extensionDir}/omp-session-annotator.js`;
const commandTarget = `${commandDir}/annotate.md`;
const configTarget = `${agentDir}/config.yml`;
const binTarget = `${home}/.local/bin/omp-annotation-install`;
const staleLaunchAgentTarget = `${home}/Library/LaunchAgents/com.apple.omp-annotation-bridge.plist`;

await mkdir(extensionDir, { recursive: true });
await mkdir(commandDir, { recursive: true });
await mkdir(dirname(binTarget), { recursive: true });

await copyFileIfChanged(bridgeSource, bridgeTarget);
await copyFileIfChanged(annotatorSource, annotatorTarget);
await writeFileIfChanged(commandTarget, commandText(), 'utf8');
await ensureConfig(configTarget, bridgeTarget);
await writeFileIfChanged(binTarget, wrapperText(), 'utf8');
await chmod(binTarget, 0o755);
await rm(staleLaunchAgentTarget, { force: true });

await assertReadable(bridgeTarget);
await assertReadable(commandTarget);
await assertReadable(annotatorTarget);

console.log(`Installed OMP annotation bridge at ${bridgeTarget}`);
console.log(`Installed OMP session annotator at ${annotatorTarget}`);
console.log(`Installed /annotate fallback command at ${commandTarget}`);
console.log(`Installed repair command at ${binTarget}`);
console.log('No macOS Login Item is installed. Run this installer manually after OMP updates if needed.');

async function copyFileIfChanged(source, target) {
  const next = await readFile(source);
  let current = null;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current && Buffer.compare(current, next) === 0) return false;
  await writeFile(target, next);
  return true;
}

async function writeFileIfChanged(path, content, encoding) {
  let current = null;
  try {
    current = await readFile(path, encoding);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === content) return false;
  await writeFile(path, content, encoding);
  return true;
}

async function ensureConfig(path, extensionPath) {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const normalized = extensionPath.replaceAll('\\', '/');
  if (text.includes(normalized)) return;

  if (/^extensions:\s*$/m.test(text)) {
    text = text.replace(/^extensions:\s*$/m, `extensions:\n  - ${normalized}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `extensions:\n  - ${normalized}\n`;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function assertReadable(path) {
  const text = await readFile(path, 'utf8');
  if (!text.trim()) throw new Error(`${path} is empty`);
}

function wrapperText() {
  return `#!/bin/zsh\nexec /opt/homebrew/bin/node ${JSON.stringify(`${root}/scripts/install-omp-annotation.mjs`)}\n`;
}

function commandText() {
  return `---
description: Open a URL in the OMP browser and collect Codex-style annotations in this chat.
---
Start an OMP-browser annotation session for this chat.

URL: $ARGUMENTS

Requirements:
- Use the OMP browser tool, not the external Chrome extension.
- Open the URL above in a cmux/default browser tab named \`annotate-session\`.
- Inject \`${annotatorTarget}\` into that tab.
- If \`window.__ompSessionAnnotator\` already exists, call \`window.__ompSessionAnnotator.start()\`.
- Poll \`window.__ompSessionAnnotator.drainOutbox()\` on the same browser tab about once per second.
- When \`drainOutbox()\` returns annotations, post them in this chat immediately and keep polling.
- Enter inside an inline note sends that annotation. Press Enter twice to send every saved or queued annotation.
- Cmd+Enter or Ctrl+Enter saves the note without sending. Shift+Enter inserts a newline. Done sends all and finishes.
- When \`drainOutbox().done\` is true, read \`window.__ompSessionAnnotator.export()\` once, post any remaining annotations, and stop polling.

If no URL was supplied, ask me for the URL before opening the browser.
`;
}

