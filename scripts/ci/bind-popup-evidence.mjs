#!/usr/bin/env node
/**
 * Bind the opt-in popup evidence to the exact run, attempt, matrix slot and
 * Chromium build that produced it. The evidence files stay byte-identical;
 * this writes one `binding.json` beside them that names their digests, so an
 * uploaded artifact can be attributed to one slot of one run.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 256;
const MAX_HASHED_BYTES = 16 * 1024 * 1024;

/** The two opt-in popup evidence roots this repository uploads from the test job. */
export const EVIDENCE_DIRS = [
  'packages/e2e/.e2e/popup-init-order/runner',
  'packages/e2e/.e2e/popup-init-order-borrowed',
  'packages/e2e/.e2e/popup-swipe-borrowed-pair',
];

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory).toSorted()) {
    if (files.length >= MAX_FILES) break;
    const file = path.join(directory, entry);
    const info = lstatSync(file);
    if (info.isDirectory()) { files.push(...walk(file)); continue; }
    if (!info.isFile() || entry === 'binding.json' || entry === 'evidence.binding.json') continue;
    files.push(file);
  }
  return files;
}

/**
 * Write the binding for every evidence root that exists. A root that the run
 * never produced is skipped, not invented; a root that exists without the
 * Chromium identity is an error, because that evidence could not be attributed.
 */
export function bind({ root, slot, node, chromeVersion, chromeSha256, sourceCommit, sourceTree, run, attempt, dirs = EVIDENCE_DIRS }) {
  const written = [];
  for (const relative of dirs) {
    const directory = path.join(root, relative);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    const files = walk(directory);
    if (files.length === 0) continue;
    if (typeof chromeVersion !== 'string' || chromeVersion.trim() === '' || typeof chromeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chromeSha256)) {
      throw new Error(`popup evidence in ${relative} cannot be bound without the installed Chromium version and sha256`);
    }
    const binding = {
      schemaVersion: 1,
      kind: 'popup-evidence-binding',
      sourceCommit,
      sourceTree,
      run,
      attempt,
      slot,
      node,
      chromeVersion: chromeVersion.trim(),
      chromeSha256,
      files: files.map(file => {
        const info = statSync(file);
        const relativeFile = path.relative(directory, file).split(path.sep).join('/');
        return info.size > MAX_HASHED_BYTES
          ? { path: relativeFile, bytes: info.size, sha256: null, tooLarge: true }
          : { path: relativeFile, bytes: info.size, sha256: hash(file) };
      }),
    };
    const output = path.join(directory, 'binding.json');
    writeFileSync(output, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    written.push({ output, files: binding.files.length });
  }
  return written;
}

function main(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) options.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  const written = bind({
    root: options.get('root') ?? process.cwd(),
    slot: options.get('slot') ?? '',
    node: options.get('node') ?? process.version,
    chromeVersion: options.get('chrome-version') ?? '',
    chromeSha256: options.get('chrome-sha256') ?? '',
    sourceCommit: options.get('source-commit') ?? '',
    sourceTree: options.get('source-tree') ?? '',
    run: options.get('run') ?? '',
    attempt: options.get('attempt') ?? '',
  });
  if (written.length === 0) {
    process.stdout.write('popup evidence: no evidence directory was produced by this slot\n');
    return;
  }
  for (const { output, files } of written) process.stdout.write(`popup evidence: bound ${files} file(s) in ${path.dirname(output)}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
