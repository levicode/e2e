/** A new output code per navigation must never become a literal replay input. No model or pixels. */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { ExecutorNode, ReplayedPrefix, StepExecutor } from '../../src/agent/executor.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';
import { onlyActStep, readEntries } from '../helpers/trace-cache.ts';

const TITLE = 'copies the current output code';
const SUITE = `import { test, expect } from 'e2e';
test('${TITLE}', async ({ app, agent, screen }) => {
  await app.open('/code');
  const current = await screen.getByLabel('Fresh code').textContent();
  await agent.act('copy the current code into the entry and submit');
  await expect(screen.getByLabel('Result')).toHaveText('accepted');
  const typed = JSON.parse(await screen.getByLabel('Typed history').textContent());
  expect(typed.at(-1)).toBe(current);
  expect(typed.every((value) => current.startsWith(value))).toBe(true);
});`;

function allNodes(nodes: readonly ExecutorNode[]): ExecutorNode[] {
  return nodes.flatMap((node) => [node, ...allNodes(node.children ?? [])]);
}

it('records a whole-node gap, reads a fresh code on replay, and preserves the entry when the handoff is cancelled', async () => {
  const issued: string[] = [];
  const server = createServer((request, response) => {
    if (request.url !== '/code') { response.writeHead(404).end(); return; }
    const code = `TK-${randomBytes(8).toString('hex')}`;
    issued.push(code);
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><body>
      <output aria-label="Fresh code">${code}</output>
      <label>Entry<input id="entry"></label><button id="submit">Submit</button>
      <output aria-label="Result" id="result">waiting</output>
      <output aria-label="Typed history" id="history">[]</output>
      <script>
        const typed = [];
        document.querySelector('#entry').addEventListener('input', (event) => {
          typed.push(event.target.value);
          document.querySelector('#history').textContent = JSON.stringify(typed);
        });
        document.querySelector('#submit').onclick = () => {
          document.querySelector('#result').textContent = document.querySelector('#entry').value === ${JSON.stringify(code)} ? 'accepted' : 'rejected';
        };
      </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture address');
  const project = createProject({ 'tests/output.e2e.ts': SUITE });
  const copied: string[] = [];
  const prefixes: (ReplayedPrefix | undefined)[] = [];
  const cancellation = new AbortController();
  let cancelAtHandoff = false;
  const executor: StepExecutor = {
    name: 'fresh-output-copy', version: '1',
    async runStep(context) {
      prefixes.push(context.replayedPrefix);
      const observation = await context.observe({ tree: true, pixels: false });
      expect(observation.treeUnavailable).toBeUndefined();
      expect(observation.pixels).toBeUndefined();
      const nodes = allNodes(observation.tree === undefined ? [] : [observation.tree]);
      const output = nodes.find((node) => node.role === 'status' && node.name === 'Fresh code');
      expect(output?.value).toBeUndefined();
      expect(output?.text).toBe(issued.at(-1));
      const input = nodes.find((node) => node.role === 'textbox' && node.name === 'Entry');
      const submit = nodes.find((node) => node.role === 'button' && node.name === 'Submit');
      if (output?.text === undefined || input === undefined || submit === undefined) throw new Error('missing semantic controls');
      if (cancelAtHandoff) {
        cancellation.abort();
        // Cancellation must end this pending executor and must not evict the entry.
        await new Promise<never>(() => undefined);
      }
      copied.push(output.text);
      await context.actions.type({ id: input.id }, output.text);
      await context.actions.tap({ id: submit.id });
      return { status: 'passed', summary: 'copied this run\'s visible output' };
    },
  };
  const config = { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } }, retries: 0, workers: 1, cache: 'read-write' as const };
  const appUrl = `http://127.0.0.1:${String(address.port)}`;
  try {
    const first = await runExisting(project, { appUrl, config });
    expect(first.exitCode).toBe(0);
    const entries = readEntries(project);
    expect(entries).toHaveLength(1);
    const { entry, file } = entries[0]!;
    expect(entry.payload.actions[0]).toEqual({ name: 'tool', summary: 'tool type (run-time value)', derived: 'whole-node' });
    expect(entry.payload.actions.map((action) => action.name)).toEqual(['tool', 'tap']);
    expect(entry.payload.actions.some((action) => action.name === 'type')).toBe(false);
    const frozen = { bytes: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs };

    const second = await runExisting(project, { appUrl, config: { ...config, cache: { mode: 'read-only', strict: true } } });
    expect(second.exitCode).toBe(0);
    expect(issued).toHaveLength(2);
    expect(new Set(issued).size).toBe(2);
    expect(copied).toEqual(issued);
    expect(prefixes).toEqual([undefined, undefined]); // gap is action zero, not a replayed prefix
    const replay = onlyActStep(second, TITLE);
    expect(replay.cache).toMatchObject({ mode: 'missed', reason: 'gap', derived: 'whole-node', replayedActions: 0, totalActions: 2 });
    expect(replay.metrics?.modelCalls).toBe(0);
    expect({ bytes: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs }).toEqual(frozen);

    cancelAtHandoff = true;
    const cancelled = await runExisting(project, { appUrl, config, runOptions: { interruptSignal: cancellation.signal } });
    expect(cancelled.exitCode).toBe(130);
    expect(copied).toHaveLength(2); // cancelling at the gap never types either the old or new code
    expect(issued).toHaveLength(3);
    expect(new Set(issued).size).toBe(3);
    expect({ bytes: readFileSync(file, 'utf8'), mtime: statSync(file, { bigint: true }).mtimeNs }).toEqual(frozen);
  } finally {
    project.cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}, 240_000);
