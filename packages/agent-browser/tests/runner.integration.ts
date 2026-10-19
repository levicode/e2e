/** Public runner and hosted-session acceptance, using real Chromium and a deterministic executor. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { expect, type E2EConfig, type ExecutorNode, type Report, type StepExecutor } from 'e2e';
import { defineEngine, type Engine, type EngineHandle } from 'e2e/engine';
import { openHost, run, type RunResult } from 'e2e/runner';
import { agentBrowser, ENGINE_NAME, ENGINE_VERSION, type Browser } from '../dist/index.js';

let server: Server;
let origin: string;
let committedClicks = 0;
let showGlyph = true;

before(async () => {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'The exact-ref binary is mandatory; browser acceptance must not silently skip');
  server = createServer((request, response) => {
    if (request.url === '/commit') { committedClicks++; response.end('ok'); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:white}.font-icon{width:40px;height:40px;cursor:pointer;background:#ddd}
      .font-icon::before{content:'\\e000';font-family:Arial}
      </style><p data-testid="result">waiting</p><div style="height:1800px"></div>
      ${showGlyph ? '<div id="glyph" class="font-icon"></div>' : ''}
      <script>window.clicks=0;document.getElementById('glyph')?.addEventListener('click',()=>{
        window.clicks++;document.querySelector('[data-testid=result]').textContent='clicked once';
        navigator.sendBeacon('/commit');
      })</script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function engine(): EngineHandle {
  return agentBrowser({
    executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE!,
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
    args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    viewport: { width: 640, height: 480 },
  });
}
function* walk(node: ExecutorNode): Generator<ExecutorNode> { yield node; for (const child of node.children ?? []) yield* walk(child); }

function scriptedExecutor(): { executor: StepExecutor; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    executor: {
      name: 'independent-unnamed-icon', version: '1',
      async runStep(context) {
        calls++;
        const observation = await context.observe({ tree: true });
        assert.ok(observation.tree);
        const target = [...walk(observation.tree)].find((node) => node.attributes?.id === 'glyph');
        assert.ok(target, 'The executor must receive the unnamed icon from default observation, without a locator or prior scroll');
        assert.equal(target.name ?? '', '');
        assert.equal(target.attributes?.['aria-label'], undefined);
        assert.equal(target.attributes?.role, undefined);
        assert.notEqual(target.role, 'button');
        assert.ok(target.rect && target.rect.y >= observation.viewport.height);
        await context.actions.tap({ id: target.id });
        await context.observe();
        return { status: 'passed', summary: 'The unnamed font icon was clicked once' };
      },
    },
  };
}

function config(selected: EngineHandle, executor: StepExecutor): E2EConfig {
  return {
    projectId: 'independent-agent-browser-runner-audit',
    targets: [{ name: 'browser', platform: 'web', engine: selected, app: { url: origin } }],
    agents: { default: { executor } }, tests: 'tests/**/*.e2e.ts',
    workers: 1, retries: 0, timeout: 120_000, launchTimeout: 90_000, actionTimeout: 30_000,
    trace: 'on', video: 'off', cache: 'off',
  };
}
function actStep(report: Report) {
  const steps = report.run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.steps)).filter((step) => step.api === 'agent.act');
  assert.equal(steps.length, 1, 'The report must retain the actual agent.act step');
  return steps[0]!;
}
function passed(result: RunResult): void {
  assert.equal(result.exitCode, 0, JSON.stringify(result.report.run.results));
  assert.equal(result.report.run.usage.modelTokens, 0, 'This acceptance suite makes no model calls');
  assert.equal(actStep(result.report).metrics?.modelCalls, 0);
}
async function cacheEntries(cwd: string): Promise<Array<{ payload: { keyedBy?: { engineName?: string }; actions: unknown[] } }>> {
  const directory = path.join(cwd, '.e2e', 'cache');
  const files = (await readdir(directory)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
}
async function waitForCommits(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (committedClicks >= expected) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(committedClicks, expected, 'Every successful browser action must produce exactly one external fixture side effect');
}

test('public openHost preserves default icon observation through agent action and closed trace/report', { timeout: 240_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'e2e-agent-browser-host-'));
  const brain = scriptedExecutor();
  const priorCommits = committedClicks;
  const host = await openHost<{ browser: Browser }>({ cwd, env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' }, config: config(engine(), brain.executor) });
  try {
    const session = await host.openSession({ name: 'unnamed default icon reaches real agent action' });
    try {
      await session.fixtures.app.open('/glyph');
      await session.fixtures.agent.act('Tap the unnamed font icon once');
      await expect(session.fixtures.screen.getByTestId('result')).toHaveText('clicked once');
      assert.deepEqual(await session.fixtures.browser.evaluate('({clicks:window.clicks,scrolled:window.scrollY>0})'), { clicks: 1, scrolled: true });
      assert.equal(brain.calls(), 1);
      assert.equal(session.report(), undefined);
      assert.deepEqual(await session.close(), []);
      const report = session.report();
      assert.ok(report);
      assert.equal(report.run.status, 'passed');
      assert.equal(report.run.targets[0]?.engine.name, ENGINE_NAME);
      assert.equal(report.run.targets[0]?.engine.version, ENGINE_VERSION);
      assert.equal(report.run.usage.modelTokens, 0);
      assert.equal(actStep(report).status, 'passed');
      const trace = await readFile(session.tracePath, 'utf8');
      assert.match(trace, /agent\.act/);
      assert.match(trace, /Tap the unnamed font icon once/);
      assert.ok(session.steps().some((step) => step.api === 'agent.act' && step.status === 'passed'));
      await waitForCommits(priorCommits + 1);
    } finally { await session.close(); }
  } finally { await host.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('public run records/replays the real icon action and refuses incompatible engine identity or missing target', { timeout: 600_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'e2e-agent-browser-runner-'));
  const brain = scriptedExecutor();
  const priorCommits = committedClicks;
  await mkdir(path.join(cwd, 'tests'));
  // Absolute public entrypoints keep this temporary consumer independent of workspace-relative source imports.
  await writeFile(path.join(cwd, 'tests', 'icon.e2e.ts'), `
    import { expect } from ${JSON.stringify(import.meta.resolve('e2e'))};
    import { test } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    test('unnamed font icon', async ({ app, agent, screen, browser }) => {
      await app.open('/glyph');
      await agent.act('Tap the unnamed font icon once');
      await expect(screen.getByTestId('result')).toHaveText('clicked once');
      expect(await browser.evaluate('window.clicks')).toBe(1);
    });`);
  try {
    // Identity simulation only: production browser hooks create a valid recording under the old name.
    // This proves cross-name cache refusal; it does not pretend to be a Playwright-generated recording.
    const legacy = defineEngine(Object.create(engine(), { name: { value: 'web', enumerable: true } }) as Engine);
    const legacyRecorded = await run({ cwd, config: { ...config(legacy, brain.executor), cache: 'read-write' } });
    passed(legacyRecorded);
    assert.equal(brain.calls(), 1);
    await waitForCommits(priorCommits + 1);
    const oldEntries = await cacheEntries(cwd);
    assert.equal(oldEntries.length, 1);
    assert.equal(oldEntries[0]?.payload.keyedBy?.engineName, 'web');

    const refused = await run({ cwd, config: { ...config(engine(), brain.executor), cache: { mode: 'read-only', strict: true } } });
    assert.equal(refused.exitCode, 2);
    assert.equal(actStep(refused.report).error?.code, 'REPLAY_STALE');
    assert.equal(brain.calls(), 1, 'An incompatible existing recording must not silently fall back to live execution in strict mode');
    assert.equal(committedClicks, priorCommits + 1, 'Cross-engine replay refusal must occur before input');

    let tracePaths: string[] = [];
    const recorded = await run({ cwd, config: {
      ...config(engine(), brain.executor), cache: 'read-write',
      reporters: [{ name: 'independent-trace-audit', async onRunFinished(finished) { tracePaths = [...finished.traces.values()]; } }],
    } });
    passed(recorded);
    assert.equal(brain.calls(), 2);
    assert.equal(recorded.report.run.targets[0]?.engine.name, ENGINE_NAME);
    assert.equal(recorded.report.run.targets[0]?.engine.version, ENGINE_VERSION);
    assert.ok(recorded.reportPath);
    assert.deepEqual(JSON.parse(await readFile(recorded.reportPath, 'utf8')), recorded.report);
    assert.equal(tracePaths.length, 1);
    const trace = await readFile(path.join(cwd, tracePaths[0]!), 'utf8');
    assert.match(trace, /agent\.act/);
    assert.match(trace, /Tap the unnamed font icon once/);
    const currentEntries = (await cacheEntries(cwd)).filter((entry) => entry.payload.keyedBy?.engineName === ENGINE_NAME);
    assert.equal(currentEntries.length, 1);
    assert.equal(currentEntries[0]?.payload.actions.length, 1);
    await waitForCommits(priorCommits + 2);

    const replayed = await run({ cwd, config: { ...config(engine(), brain.executor), cache: { mode: 'read-only', strict: true } } });
    passed(replayed);
    assert.equal(brain.calls(), 2, 'Replay must execute the browser action without invoking the scripted executor again');
    assert.equal(actStep(replayed.report).cache?.mode, 'self-finalized');
    assert.equal(actStep(replayed.report).cache?.replayedActions, 1);
    await waitForCommits(priorCommits + 3);

    showGlyph = false;
    const stale = await run({ cwd, config: { ...config(engine(), brain.executor), cache: { mode: 'read-only', strict: true } } });
    assert.equal(stale.exitCode, 2);
    assert.equal(actStep(stale.report).error?.code, 'REPLAY_STALE');
    assert.equal(brain.calls(), 2);
    assert.equal(committedClicks, priorCommits + 3, 'A missing replay target must not be replaced by an arbitrary click');
  } finally { showGlyph = true; await rm(cwd, { recursive: true, force: true }); }
});
