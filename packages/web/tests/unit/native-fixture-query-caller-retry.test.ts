/** Caller-only control: real web/locator/assertion code over an in-memory framed
 * native peer. No native executable, browser, CDP socket or substitute retry loop.
 * Native 8add's sufficient-condition proof is tested separately in Rust. */
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { expect as expectLocator } from 'e2e';
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { createEngineSession } from '../../../e2e/dist/engine/session.js';
import { Deadline, POLL_INTERVAL_MS } from '../../../e2e/dist/internal/time.js';
import { LocatorEngine } from '../../../e2e/dist/locator/engine.js';
import { createScreen } from '../../../e2e/dist/locator/screen.js';
import { AttemptBudget } from '../../../e2e/dist/run/budget.js';
import { StepRecorder } from '../../../e2e/dist/run/steps.js';
import { web } from '../../src/engine.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { NativeInteropResources } from '../helpers/native-interop-resources.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const scope = 'synthetic-login-scope';
const pauseMs = 40;
const assertionMs = 500;
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
type Mode = 'clean-query' | 'unknown-query' | 'completed-query' | 'unknown-submit' | 'completed-submit';
let peer: NativeProtocolPeer | undefined;
let engine: EngineHandle | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setTimerTickMode('nextTimerAsync');
});
afterEach(async () => {
  try { await engine?.dispose?.({ timeoutMs: 1000, signal: new AbortController().signal }); }
  finally { peer?.dispose(); peer = undefined; engine = undefined; vi.useRealTimers(); vi.restoreAllMocks(); }
});

async function fixture(mode: Mode) {
  const resources = new NativeInteropResources({ allocateScopeIdentity: () => scope });
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  const queries: { request: PeerRequest; at: number; monotonicAt: number }[] = [];
  // Call-through spy only: never replace EngineChannel, resultError or retry.
  const commands = vi.spyOn(EngineChannel.prototype, 'command');
  const failures = async (): Promise<unknown[]> => {
    const settled = await Promise.allSettled(commands.mock.results
      .filter(result => result.type === 'return').map(result => result.value));
    return settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  };
  let submitted = 0;
  vi.mocked(connectNativeProcess).mockImplementationOnce(async (settings, budget, onEvent) => {
    peer = new NativeProtocolPeer(settings.capabilities, request => resources.respond(request, async (call): Promise<PeerOutcome> => {
      if (['scope.configure', 'network.routes.replace'].includes(call.command)) return { data: null };
      if (call.command === 'session.environment') return { data: { identityScope: scope, browser: 'synthetic' } };
      if (call.command === 'page.title') return { data: { title: 'synthetic' } };
      if (call.command === 'recording.finalized.collect') return { error: 'scope-unavailable', effects: 'not-dispatched', scopeState: 'quarantined' };
      if (call.command === 'fixture.query' || call.command === 'browser.query') {
        const expression = call.args['expression'];
        expect(expression).toMatchObject({ kind: 'query', query: { kind: 'role' } });
        const role = (expression as { query: { value: { value: string } } }).query.value.value;
        if (role === 'button') return { data: { identityScope: scope, revision: '1', nodes: [{ ref: { id: '@e1', revision: '1' }, role: 'button', name: 'Sign in' }] } };
        expect(role).toBe('alert'); expect(submitted).toBe(1);
        expect(call.command).toBe('fixture.query');
        queries.push({ request: call, at: Date.now(), monotonicAt: performance.now() });
        if (queries.length === 1) {
          await new Promise<void>(resolve => setTimeout(resolve, pauseMs));
          return { error: 'stale-reference', effects: mode === 'unknown-query' ? 'unknown' : mode === 'completed-query' ? 'completed' : 'not-dispatched', scopeState: mode === 'unknown-query' ? 'quarantined' : 'usable' };
        }
        expect(mode).toBe('clean-query'); expect(queries).toHaveLength(2);
        return { data: { identityScope: scope, revision: '2', nodes: [{ ref: { id: '@e2', revision: '2' }, role: 'alert', name: 'Invalid credentials', text: 'Invalid credentials' }] } };
      }
      if (call.command === 'browser.perform') {
        expect(call.args).toMatchObject({ identityScope: scope, action: { kind: 'tap' } });
        submitted++;
        if (mode.endsWith('-submit')) return { error: 'stale-reference', effects: mode === 'unknown-submit' ? 'unknown' : 'completed', scopeState: mode === 'unknown-submit' ? 'quarantined' : 'usable' };
        return { data: null };
      }
      throw new Error(`Unexpected caller-control command ${call.command}`);
    }), { close: () => resources.closeNative() });
    return peer.connect(budget, onEvent);
  });
  engine = web();
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
  // No automatic success trace callback: this control counts only the requested
  // locator action and the original scalar assertion, not optional screenshots.
  await engine.startAttempt!({ attemptId: 'attempt', artifactsDir: tmpdir(), signal: operation().signal,
    resolveSecret: async () => { throw new Error('no secrets'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
  const budget = new AttemptBudget(operation().signal, new Deadline(5000));
  const steps = new StepRecorder('attempt');
  const locator = new LocatorEngine({ session: createEngineSession({ engine, targetName: 'web' }), budget,
    runId: 'run', attemptId: 'attempt', actionTimeout: 1000, assertionTimeout: assertionMs, readPurpose: 'fixture' });
  const screen = createScreen({ engine: locator, steps, secrets: { resolve: async () => { throw new Error('no secrets'); } }, renderTree: () => '' });
  return { screen, queries, failures, steps, budget, submitted: () => submitted };
}

it('retries one clean native stale query through the original scalar assertion, same scope and remaining deadline, without replaying submit', async () => {
  const f = await fixture('clean-query');
  await f.screen.getByRole('button', 'Sign in').tap();
  const before = peer!.requests.length;
  const started = Date.now(); const monotonicStarted = performance.now();
  const phaseDeadline = f.budget.deadline;
  await expectLocator(f.screen.getByRole('alert')).toHaveText('Invalid credentials', { timeout: assertionMs });
  const mapped = await f.failures();
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({ code: 'NODE_STALE', retryable: true });
  expect(f.queries).toHaveLength(2); expect(f.submitted()).toBe(1);
  expect(peer!.requests.slice(before).map(request => request.command)).toEqual(['fixture.query', 'fixture.query']);
  const requests = f.queries.map(call => call.request);
  expect(requests[0]!.operationSeq).toBeLessThan(requests[1]!.operationSeq);
  expect(new Set(requests.map(request => request.operationSeq)).size).toBe(2);
  expect(requests.map(request => request.generation)).toEqual([1, 1]);
  expect(requests.map(request => request.args['identityScope'])).toEqual([scope, scope]);
  const budgets = requests.map(request => Number(peer!.frames.find(frame => frame['id'] === request.id && frame['type'] === 'request')!['timeoutMs']));
  expect(budgets[0]).toBe(assertionMs);
  expect(budgets[1]).toBe(assertionMs - pauseMs - POLL_INTERVAL_MS);
  for (const [index, call] of f.queries.entries()) {
    expect(call.at - started + budgets[index]!).toBe(assertionMs);
    expect(call.monotonicAt - monotonicStarted + budgets[index]!).toBe(assertionMs);
  }
  expect(f.budget.deadline).toBe(phaseDeadline);
  expect(peer!.requests.filter(request => request.command === 'browser.perform')).toHaveLength(1);
  expect(f.steps.completed().filter(step => step.api === 'expect.toHaveText')).toHaveLength(1);
});

it.each(['unknown-query', 'completed-query'] as const)('%s cannot enter assertion retry or replay the settled submit', async mode => {
  const f = await fixture(mode);
  await f.screen.getByRole('button', 'Sign in').tap();
  const before = peer!.requests.length;
  await expect(expectLocator(f.screen.getByRole('alert')).toHaveText('Invalid credentials', { timeout: assertionMs })).rejects.toBeDefined();
  const mapped = await f.failures();
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({ code: mode === 'unknown-query' ? 'ACTION_MAY_HAVE_COMMITTED' : 'NODE_STALE', retryable: false });
  expect(f.queries).toHaveLength(1); expect(f.submitted()).toBe(1);
  const tail = peer!.requests.slice(before);
  expect(tail.map(request => request.command)).toEqual(mode === 'unknown-query'
    ? ['fixture.query', 'recording.finalized.collect'] : ['fixture.query']);
  if (mode === 'unknown-query') expectTerminalCollection(tail[0]!, tail[1]!);
});

it.each(['unknown-submit', 'completed-submit'] as const)('%s mutation refusal cannot relocate/retry the original input', async mode => {
  const f = await fixture(mode);
  const before = peer!.requests.length;
  await expect(f.screen.getByRole('button', 'Sign in').tap()).rejects.toBeDefined();
  const mapped = await f.failures();
  expect(mapped).toHaveLength(1);
  expect(mapped[0]).toMatchObject({ code: mode === 'unknown-submit' ? 'ACTION_MAY_HAVE_COMMITTED' : 'NODE_STALE', retryable: false });
  expect(f.submitted()).toBe(1); expect(f.queries).toHaveLength(0);
  const tail = peer!.requests.slice(before);
  expect(tail.map(request => request.command)).toEqual(mode === 'unknown-submit'
    ? ['fixture.query', 'browser.perform', 'recording.finalized.collect'] : ['fixture.query', 'browser.perform']);
  if (mode === 'unknown-submit') expectTerminalCollection(tail[1]!, tail[2]!);
});

// NativeClient's quarantined-result path synchronously starts terminal-only
// recording collection. It cannot reopen ordinary browser/query admission.
function expectTerminalCollection(failed: PeerRequest, collection: PeerRequest): void {
  expect(failed.args['identityScope']).toBe(scope);
  expect(collection.command).toBe('recording.finalized.collect');
  expect(collection.args).toEqual({ identityScope: scope, failedOperationSeq: failed.operationSeq });
  expect(collection.generation).toBe(failed.generation);
  expect(collection.operationSeq).toBeGreaterThan(failed.operationSeq);
}
