import assert from 'node:assert/strict';
import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agentBrowser, ENGINE_NAME, ENGINE_VERSION, test } from '@e2e-dev/agent-browser';
import { expect } from 'e2e';
import { EngineError } from 'e2e/engine';
import { list, run, openHost } from 'e2e/runner';

const modules = await realpath(path.join(process.cwd(), 'node_modules'));
const resolved = {};
for (const specifier of ['e2e', 'e2e/engine', 'e2e/runner', '@e2e-dev/agent-browser']) {
  const entry = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  assert.ok(entry.startsWith(`${modules}${path.sep}`), `${specifier} must resolve inside the fresh consumer, never the workspace`);
  resolved[specifier] = entry;
}
assert.equal(agentBrowser().name, ENGINE_NAME);
assert.equal(typeof ENGINE_VERSION, 'string');
for (const value of [test, expect, EngineError, list, run, openHost]) assert.equal(typeof value, 'function');
await mkdir('consumer-results', { recursive: true });
await writeFile('consumer-results/resolution.json', `${JSON.stringify({ engine: ENGINE_NAME, version: ENGINE_VERSION, resolved }, null, 2)}\n`);
process.stdout.write('Public imports resolve only to the installed consumer packages.\n');
