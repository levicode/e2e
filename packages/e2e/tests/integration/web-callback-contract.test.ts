/** Public Web callbacks must not wait behind the action whose event they resolve. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutorNode, StepExecutor } from '../../src/agent/executor.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { retainSyntheticCallbackScreenshot } from '../helpers/synthetic-callback-screenshot.ts';

const CASES = [
  'route callback reads the live page while evaluate awaits fetch',
  'route removal keeps the paused fallback chain',
  'response subscription does not block its trigger',
  'dialog decisions settle an awaiting evaluation',
  'download subscription runs its trigger',
  'custom executor uses checked actions and the test verifies the response',
] as const;

/** Find the single Save control without depending on any engine-specific handle. */
function saveButtons(node: ExecutorNode): ExecutorNode[] {
  return [
    ...(node.role === 'button' && node.name === 'Save' ? [node] : []),
    ...(node.children ?? []).flatMap(saveButtons),
  ];
}

const executor: StepExecutor = {
  name: 'public-save-consumer', version: '1', cache: 'off',
  async runStep(ctx) {
    if (ctx.step.kind !== 'act' || ctx.step.instruction !== 'Save the form') {
      return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'Only Save the form is supported.' };
    }
    const observation = await ctx.observe({ tree: true });
    const matches = observation.tree === undefined ? [] : saveButtons(observation.tree);
    const save = matches.length === 1 ? matches[0] : undefined;
    if (save === undefined) return { status: 'failed', errorCode: 'LOCATOR_NOT_FOUND', summary: 'Expected one Save button.' };
    await ctx.actions.tap({ id: save.id });
    return { status: 'passed', summary: 'Tapped Save; the test checks the response.' };
  },
};

const syntheticEvidenceModule = new URL('../../../web/tests/helpers/synthetic-evidence.ts', import.meta.url).href;

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { beginSyntheticCase, callbackFailureFact } from ${JSON.stringify(syntheticEvidenceModule)};

test('${CASES[0]}', { timeout: 8_000 }, async ({ browser }) => {
  const evidence = beginSyntheticCase('C03');
  let body = 'incomplete';
  let setup = 'not-started';
  evidence.record({ kind: 'phase', section: 'body', phase: 'route', state: 'enter' });
  try {
  await browser.goto('/');
  await browser.setCookies([{ name: 'fixture', value: 'public-synthetic', url: '/' }]);
  await browser.route('**/read', async route => {
    let stageOrdinal = 0;
    try {
    expect(await browser.url()).toMatch(/\\/$/);
    stageOrdinal = 1; expect(await browser.title()).toBe('Callback fixture');
    stageOrdinal = 2; expect((await browser.cookies()).some(cookie => cookie.name === 'fixture')).toBe(true);
    stageOrdinal = 3; expect(await browser.locator('h1').textContent()).toBe('Ready');
    stageOrdinal = 4; expect(await browser.evaluate(() => document.querySelector('h1')?.textContent ?? '')).toBe('Ready');
    stageOrdinal = 5; await route.fulfill({ body: 'callback finished' });
    } catch (cause) { evidence.observe(() => callbackFailureFact(stageOrdinal, cause)); throw cause; }
  });
  setup = 'passed';
  expect(await browser.evaluate(() => fetch('/read').then(response => response.text()))).toBe('callback finished');
  body = 'passed';
  } catch (cause) { body = 'failed'; throw cause; }
  finally { evidence.finish({ setup, body, cleanup: 'not-started' }); }
});

test('${CASES[1]}', { timeout: 8_000 }, async ({ browser }) => {
  await browser.goto('/');
  await browser.route('**/chain', route => route.fulfill({ body: 'captured older handler' }));
  await browser.route('**/chain', async route => {
    await browser.unrouteAll();
    await route.fallback();
  });
  expect(await browser.evaluate(() => fetch('/chain').then(response => response.text()))).toBe('captured older handler');
  expect(await browser.evaluate(() => fetch('/chain').then(response => response.text()))).toBe('network');
});

test('${CASES[2]}', { timeout: 8_000 }, async ({ browser }) => {
  await browser.goto('/');
  const response = browser.waitForResponse('**/response', { timeout: 3_000 });
  const trigger = browser.evaluate(() => fetch('/response').then(reply => reply.text()));
  const [matched, body] = await Promise.all([response, trigger]);
  expect(body).toBe('network');
  expect(await matched.text()).toBe('network');
});

test('${CASES[3]}', { timeout: 8_000 }, async ({ browser }) => {
  await browser.goto('/');
  const remove = await browser.onDialog(dialog => dialog.accept('synthetic answer'));
  expect(await browser.evaluate(() => window.prompt('fixture'))).toBe('synthetic answer');
  await remove();
});

test('${CASES[4]}', { timeout: 8_000 }, async ({ browser }) => {
  await browser.goto('/');
  const download = await browser.waitForDownload(() => browser.locator('a').tap(), { timeout: 3_000 });
  expect(download.suggestedFilename).toBe('fixture.txt');
});

test('${CASES[5]}', { timeout: 8_000 }, async ({ browser, agent }) => {
  await browser.goto('/');
  const response = browser.waitForResponse('**/api/save', { timeout: 3_000 });
  await agent.act('Save the form');
  const matched = await response;
  expect(matched.status).toBe(200);
  expect(await matched.json()).toEqual({ saved: true, count: 1 });
});
`;

describe('public Web callback contract', () => {
  let server: Server | undefined;
  let project: FixtureProject | undefined;
  let outcome: RunOutcome;
  let saves = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Callback fixture</title><h1>Ready</h1><button onclick="fetch(&quot;/api/save&quot;, {method: &quot;POST&quot;})">Save</button><a href="/download" download>Download</a>');
      } else if (request.url === '/api/save' && request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ saved: true, count: ++saves }));
      } else if (request.url === '/download') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="fixture.txt"' });
        response.end('synthetic fixture');
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('network');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ outcome, project } = await runProject(
      { 'tests/callbacks.e2e.ts': SUITE },
      { appUrl: origin, config: { workers: 1, agents: { default: { executor } } } },
    ));
  }, 90_000);

  afterAll(async () => {
    retainSyntheticCallbackScreenshot(project?.dir, outcome);
    project?.cleanup();
    const current = server;
    if (current?.listening) await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  });

  it.each(CASES)('%s', title => {
    const result = resultByTitle(outcome, title);
    expect(result.status, JSON.stringify({ errors: outcome.report.run.errors, attempts: result.attempts })).toBe('passed');
  });
});
