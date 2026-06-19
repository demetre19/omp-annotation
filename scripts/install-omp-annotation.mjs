import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.HOME || '/Users/apple';
const bridgeSource = `${root}/src/annotation-bridge.js`;
const agentDir = `${home}/.omp/agent`;
const extensionDir = `${agentDir}/extensions`;
const bridgeTarget = `${extensionDir}/annotation-bridge.js`;
const configTarget = `${agentDir}/config.yml`;
const binTarget = `${home}/.local/bin/omp-annotation-install`;
const staleLaunchAgentTarget = `${home}/Library/LaunchAgents/com.apple.omp-annotation-bridge.plist`;
const staleAnnotatorTarget = `${extensionDir}/omp-session-annotator.js`;
const staleCommandTarget = `${agentDir}/commands/annotate.md`;

await mkdir(extensionDir, { recursive: true });
await mkdir(dirname(binTarget), { recursive: true });

await copyFileIfChanged(bridgeSource, bridgeTarget);
await ensureConfig(configTarget, bridgeTarget);
await writeFileIfChanged(binTarget, wrapperText(), 'utf8');
await chmod(binTarget, 0o755);
await rm(staleLaunchAgentTarget, { force: true });
await rm(staleAnnotatorTarget, { force: true });
await rm(staleCommandTarget, { force: true });

await assertReadable(bridgeTarget);

console.log(`Installed OMP annotation bridge at ${bridgeTarget}`);
console.log(`Installed repair command at ${binTarget}`);
console.log('Run this installer manually after OMP updates if needed.');

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


