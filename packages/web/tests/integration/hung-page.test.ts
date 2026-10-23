/**
 * Every operation ends at its budget, whatever the page does: a server that
 * never answers a navigation, which Playwright's own timeout ends, and a
 * renderer stuck in a script a button started. Playwright cannot answer an
 * evaluate or a point tap there at all, so the engine's own deadline ends
 * the call: `OPERATION_TIMEOUT`, or `ACTION_MAY_HAVE_COMMITTED`
 * for input, which may have reached the page. Native point admission instead
 * waits for the older unknown input: if it never settles, the new point times
 * out without dispatch. The independent Playwright baseline is unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import type { Locator } from 'e2e';
import type { EngineFixtureContext, EngineHandle, LocatorExpression, NodeRef, OperationContext } from 'e2e/engine';
import { web, type BrowserExpectation } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { NativeClient } from '../../src/native/client.ts';
import { isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { beginSyntheticCase, type SyntheticCaseId, type SyntheticEvidence, type SyntheticOutcome, type SyntheticPhase } from '../helpers/synthetic-evidence.ts';
import { observeSyntheticConnection, SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';

/** Test-only boundaries. A missing footer remains unknown, including a hard test timeout. */
class CaseEvidence {
  readonly evidence: SyntheticEvidence;
  readonly outcome: SyntheticOutcome = { setup: 'not-started', body: 'not-started', cleanup: 'not-started' };
  readonly observer: SyntheticNativeObserver;
  currentPhase: SyntheticPhase = 'init';
  section: keyof SyntheticOutcome = 'setup';
  private active: { section: keyof SyntheticOutcome; phase: SyntheticPhase } | undefined;
  constructor(id: SyntheticCaseId) {
    this.evidence = beginSyntheticCase(id);
    this.observer = new SyntheticNativeObserver(this.evidence, () => this.currentPhase);
  }
  phase(section: keyof SyntheticOutcome, phase: SyntheticPhase): void {
    // A different hook may start after a hard timeout; that is not a returned phase.
    if (this.active?.section === section) this.returned();
    else this.active = undefined;
    this.section = section; this.currentPhase = phase;
    if (this.outcome[section] !== 'failed') this.outcome[section] = 'incomplete';
    this.active = { section, phase };
    this.evidence.record({ kind: 'phase', section, phase, state: 'enter' });
  }
  returned(): void {
    if (this.active !== undefined) this.evidence.record({ kind: 'phase', ...this.active, state: 'passed' });
    this.active = undefined;
  }
  passed(section: keyof SyntheticOutcome): void {
    if (this.active?.section === section) this.returned();
    else this.active = undefined;
    if (this.outcome[section] !== 'failed') this.outcome[section] = 'passed';
  }
  failed(section: keyof SyntheticOutcome = this.section, cause?: unknown): void {
    if (cause !== undefined) this.observer.failure(section, cause);
    if (this.active?.section === section) this.evidence.record({ kind: 'phase', ...this.active, state: 'failed' });
    this.active = undefined;
    this.outcome[section] = 'failed';
  }
  finish(): void { this.observer.close(); this.evidence.finish(this.outcome); }
}

const currentEvidence = new AsyncLocalStorage<CaseEvidence>();
const caseTasks = new WeakMap<object, { evidence: CaseEvidence; restore: () => void }>();
function diagnosticCase(id: SyntheticCaseId, body: (evidence: CaseEvidence) => Promise<void>) {
  return (context: TestContext): Promise<void> => {
    const evidence = new CaseEvidence(id);
    let restore = () => {};
    try {
      const connect = NativeClient.connect;
      const connection = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => observeSyntheticConnection(connect(...args)));
      restore = () => { try { connection.mockRestore(); } catch { evidence.evidence.invalidate(); } };
    } catch { evidence.evidence.invalidate(); }
    caseTasks.set(context.task, { evidence, restore });
    return evidence.observer.run(() => currentEvidence.run(evidence, async () => {
      try { await body(evidence); evidence.passed('body'); }
      catch (cause) { evidence.failed(evidence.section, cause); throw cause; }
      // The footer belongs to the original afterEach, not successful body return.
    }));
  };
}

const BUDGET_MS = 1_000;
/** The action timeout a read left to the harness's default budget takes. */
const ACTION_TIMEOUT_MS = 30_000;
/** How long past its budget a call may still be pending before the test calls it unbounded. */
const SLACK_MS = 1_000;
/** How much sooner than the budget a call may fail: Playwright's own timeout is set 250 ms short of it. */
const EARLY_MS = 300;

const BUSY_PAGE = `<!doctype html><title>Busy</title>
<button onclick="while (true) {}">Freeze</button>
<button>Next</button>`;

const COVERED_PAGE = `<!doctype html><title>Covered</title>
<button>Pay</button>
<div id="overlay" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3)"></div>`;

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: BUDGET_MS, runId: 'run-hung', attemptId: 'hung', origin: 'test' };
}

function button(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

/**
 * Settles one call, or gives up on it a while after its budget: a call
 * still pending then is reported as such, so an unbounded one fails the test
 * at once instead of holding it to the vitest timeout. A call that failed
 * well before its budget fails the test too: the budget must bound it, not
 * cut it short.
 */
async function bounded(call: () => Promise<unknown>, selected?: { ordinal: number; command: 'page.title' | 'fixture.query' | 'browser.query' | 'browser.pointer' | 'page.navigate' }): Promise<{ error: unknown }> {
  const started = Date.now();
  const pending = Symbol('pending');
  let timer: NodeJS.Timeout | undefined;
  const observer = currentEvidence.getStore()?.observer;
  const original = selected && observer ? observer.select(selected.ordinal, selected.command, call) : call();
  const outcome = await Promise.race([
    original.then(() => undefined, (error: unknown) => error),
    new Promise<typeof pending>((resolve) => { timer = setTimeout(() => resolve(pending), BUDGET_MS + SLACK_MS); }),
  ]);
  clearTimeout(timer);
  if (outcome === pending) throw new Error(`still pending ${BUDGET_MS + SLACK_MS}ms into a ${BUDGET_MS}ms budget`);
  const timing = () => expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - EARLY_MS);
  if (selected && observer) observer.assert(selected.ordinal, timing); else timing();
  return { error: outcome };
}

describe('operations on a hung page', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;
  let engine: EngineHandle;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/never') return;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/covered' ? COVERED_PAGE : BUSY_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-hung-page-'));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  afterEach((context) => {
    const diagnostic = caseTasks.get(context.task);
    const evidence = diagnostic?.evidence;
    const close = async () => {
      const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000 };
      try {
        evidence?.phase('cleanup', 'end');
        await engine.endAttempt!(cleanup);
        evidence?.phase('cleanup', 'dispose');
        await engine.dispose!(cleanup);
        evidence?.passed('cleanup');
      } catch (cause) { evidence?.failed('cleanup', cause); throw cause; }
      finally { diagnostic?.restore(); evidence?.finish(); }
    };
    return evidence === undefined ? close() : evidence.observer.run(close);
  });

  /** Boots a fresh engine and attempt. */
  async function start(): Promise<void> {
    engine = web();
    const evidence = currentEvidence.getStore();
    evidence?.phase('setup', 'init');
    await engine.init!({
      runId: 'run-hung',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { site: '127.0.0.1' },
      env: process.env,
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      signal: new AbortController().signal,
    });
    evidence?.phase('setup', 'start');
    await engine.startAttempt!({ attemptId: 'hung', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    evidence?.passed('setup');
  }

  /** Opens the busy page, observes it, and taps the button that starts the endless script. */
  async function freeze(): Promise<void> {
    const evidence = currentEvidence.getStore();
    evidence?.phase('setup', 'open');
    await engine.session!.open!(`${origin}/`, operation());
    evidence?.phase('setup', 'initial-observe');
    await engine.observe!(operation());
    evidence?.phase('setup', 'initial-locate');
    const [target] = await engine.locate!(button('Freeze'), operation());
    evidence?.phase('setup', 'freeze-renderer');
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    evidence?.phase('setup', 'assertion');
    expect(tap.error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    evidence?.passed('setup');
  }

  /**
   * `expect(browser)` over the attempt, through a fixture context with the
   * harness's budgets: an operation with no explicit timeout gets the action
   * timeout.
   */
  function browserExpectation(): BrowserExpectation {
    let expectation: (() => unknown) | undefined;
    const context = {
      targetName: 'web',
      timeouts: { test: 60_000, action: ACTION_TIMEOUT_MS, assertion: BUDGET_MS },
      signal: new AbortController().signal,
      operation: (timeoutMs?: number) => ({ ...operation(), timeoutMs: Math.max(1, timeoutMs ?? ACTION_TIMEOUT_MS) }),
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      fixture: (_name: string, target: object) => target,
      expectable: (target: object, factory: () => unknown) => {
        expectation = factory;
        return target;
      },
    } as unknown as EngineFixtureContext;
    engine.fixtures!.browser!(context);
    return expectation!() as BrowserExpectation;
  }

  it('ends a browser assertion on a stuck page at its own timeout, not the action timeout', diagnosticCase('P19', async (evidence) => {
    await start();
    await freeze();
    evidence.phase('setup', 'fixture-create');
    const expectation = browserExpectation();
    evidence.passed('setup');
    evidence.phase('body', 'assertion');
    const title = await bounded(() => expectation.toHaveTitle('Other', { timeout: BUDGET_MS }), { ordinal: 0, command: 'page.title' });
    evidence.observer.assert(0, () => expect(title.error).toMatchObject({ code: 'OPERATION_TIMEOUT' }));
    // A locator read waits out the action timeout, as the harness's does.
    const card = {
      count: async () => 1,
      getAttribute: async () => {
        await engine.locate!(button('Next'), { ...operation(), timeoutMs: ACTION_TIMEOUT_MS });
        return 'card';
      },
    } as unknown as Locator;
    evidence.phase('body', 'assertion');
    const negated = await bounded(() => expectation.not.toHaveClass(card, 'card', { timeout: BUDGET_MS }), { ordinal: 1, command: 'browser.query' });
    evidence.observer.assert(1, () => expect(negated.error).toMatchObject({ code: 'OPERATION_TIMEOUT' }));
  }));

  it('times out a navigation to a server that never answers', diagnosticCase('P20', async (evidence) => {
    await start();
    evidence.phase('body', 'navigate');
    const open = await bounded(() => engine.session!.open!(`${origin}/never`, operation()), { ordinal: 0, command: 'page.navigate' });
    evidence.phase('body', 'assertion');
    evidence.observer.assert(0, () => expect(open.error).toMatchObject({ code: 'OPERATION_TIMEOUT' }));
  }));

  it('times out a locate and a point tap on a page whose renderer is stuck in a script', diagnosticCase('P21', async (evidence) => {
    await start();
    await freeze();
    evidence.phase('body', 'locate');
    const locate = await bounded(() => engine.locate!(button('Next'), operation()), { ordinal: 0, command: 'browser.query' });
    evidence.phase('body', 'assertion');
    evidence.observer.assert(0, () => expect(locate.error).toMatchObject({ code: 'OPERATION_TIMEOUT' }));
    evidence.phase('body', 'point-perform');
    const tap = await bounded(() => engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation()), { ordinal: 1, command: 'browser.pointer' });
    evidence.phase('body', 'assertion');
    evidence.observer.assert(1, () => {
      expect(tap.error).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
      expect(isNativeNotDispatched(tap.error)).toBe(true);
    });
  }));

  it('keeps the reason Playwright gives for a tap that cannot land, ahead of the deadline', async () => {
    await start();
    await engine.session!.open!(`${origin}/covered`, operation());
    const [target] = await engine.locate!(button('Pay'), operation());
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('intercepts pointer events') });
  });
});
