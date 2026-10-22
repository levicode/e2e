import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser as HostBrowser } from 'playwright-core';
import { EngineError, TestError, type EngineFixtureContext, type EngineHandle } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { NativeClient } from '../../src/native/client.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
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
  failed(section: keyof SyntheticOutcome = this.section): void {
    if (this.active?.section === section) this.evidence.record({ kind: 'phase', ...this.active, state: 'failed' });
    this.active = undefined;
    this.outcome[section] = 'failed';
  }
  finish(): void { this.observer.close(); this.evidence.finish(this.outcome); }
}

describe('browser.evaluate error boundaries', () => {
  const surface = new NativeSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-'));
  const signal = new AbortController().signal;
  let browser: Browser;

  beforeAll(async () => {
    await surface.init({ runId: 'evaluate', targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'evaluate', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    // These cases test an opened page, not the separate lazy-activation refusal contract.
    await surface.open('about:blank', { signal, timeoutMs: 5_000, runId: 'evaluate', attemptId: 'evaluate', origin: 'test' });
    browser = createBrowserFixture(surface.fixtureSurface(), {
      operation: () => ({ signal, timeoutMs: 1_000, runId: 'evaluate', attemptId: 'evaluate', origin: 'test' }),
      expectable: (target: object) => target,
      // The recorder is the harness's concern; these tests exercise evaluate's error boundaries only.
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it.each([
    ['() => { throw new Error("cart is empty"); }', 'cart is empty'],
    ['() => { throw "cart is empty"; }', 'cart is empty'],
    ['() => { throw { message: "cart is empty" }; }', 'cart is empty'],
    ['() => { throw Object.create(null); }', 'Page evaluation threw an unprintable value'],
    ['() => { throw null; }', 'null'],
    ['() => { throw new Error("page.evaluate: Target closed"); }', 'page.evaluate: Target closed'],
  ])('preserves the message of a page exception: %s', async (source, message) => {
    await expect(browser.evaluate(source)).rejects.toMatchObject({ code: 'EVALUATE_FAILED', message });
  });

  it('preserves JSON results, explicit arguments, and zero-argument invocation', async () => {
    await expect(browser.evaluate((value: { count: number }) => ({ count: value.count + 1 }), { count: 4 }))
      .resolves.toEqual({ count: 5 });
    await expect(browser.evaluate('async () => ({ success: false, message: "ordinary data" })'))
      .resolves.toEqual({ success: false, message: 'ordinary data' });
    await expect(browser.evaluate('function () { return arguments.length; }')).resolves.toBe(0);
    await expect(browser.evaluate('function () { return arguments.length; }', null)).resolves.toBe(1);
  });

  it('evaluates a string as an expression and calls a function it evaluates to', async () => {
    await browser.evaluate(() => { document.title = 'Cart'; return null; });
    await expect(browser.evaluate('document.title')).resolves.toBe('Cart');
    await expect(browser.evaluate('(() => document.title)()')).resolves.toBe('Cart');
    await expect(browser.evaluate('fetch("data:text/plain,ok").then((response) => response.text())')).resolves.toBe('ok');
    await expect(browser.evaluate('(name) => document[name]', 'title')).resolves.toBe('Cart');
  });

  it('rejects invalid JSON results and syntax as test errors', async () => {
    await expect(browser.evaluate('() => Infinity')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(browser.evaluate('() => {')).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
    await expect(browser.evaluate('() => {', null)).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
  });
});


describe('native evaluation interrupted by external target loss', () => {
  it.each(['page closure', 'owned browser termination'] as const)('reports the uncertain outcome after %s without replaying evaluation', (fault) => {
    const evidence = new CaseEvidence(fault === 'page closure' ? 'P17' : 'P18');
    return evidence.observer.run(async () => {
      const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-loss-'));
      const signal = new AbortController().signal;
      const operation = { signal, timeoutMs: 10_000, runId: 'evaluate-loss', attemptId: 'loss', origin: 'test' as const };
      const cleanup = { signal, timeoutMs: 5_000 };
      let remote: RemoteChrome | undefined;
      let control: HostBrowser | undefined;
      let engine: EngineHandle | undefined;
      const failures: unknown[] = [];
      const settle = async (work: readonly Promise<unknown>[]) => {
        for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') {
          failures.push(result.reason);
          evidence.failed('cleanup');
        }
        evidence.returned();
      };
      let faultInjected = false;
      let evaluations = 0;
      const request = NativeClient.prototype.request;
      const commands = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, name, args, context) {
        if (name === 'page.evaluate') evaluations += 1;
        return request.call(this, name, args, context);
      });
      let restoreConnection = () => {};
      try {
        const connect = NativeClient.connect;
        const connection = vi.spyOn(NativeClient, 'connect').mockImplementation((...args) => observeSyntheticConnection(connect(...args)));
        restoreConnection = () => { try { connection.mockRestore(); } catch { evidence.evidence.invalidate(); } };
      } catch { evidence.evidence.invalidate(); }
      try {
        evidence.phase('setup', 'host');
        remote = await launchRemoteChrome();
        const endpoint = remote.endpoint;
        engine = web({ connect: { cdpEndpoint: () => endpoint } });
        evidence.phase('setup', 'init');
        await engine.init!({ runId: operation.runId, targetName: 'web', projectRoot: process.cwd(),
          app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
        evidence.phase('setup', 'start');
        await engine.startAttempt!({ attemptId: operation.attemptId, artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
        evidence.phase('setup', 'open');
        await engine.session!.open!('about:blank', operation);
        evidence.phase('setup', 'fixture-create');
        const browser = nativeBrowser(engine, () => operation);
        const identity = randomUUID();
        evidence.phase('setup', 'witness');
        await browser.evaluate(value => { document.body.dataset.evaluationTarget = value; return null; }, identity);
        // This connection only locates and destroys the actual target; all app operations use Browser.
        control = await chromium.connectOverCDP(endpoint);
        const pages = control.contexts().flatMap(context => context.pages());
        const matches = [];
        for (const page of pages) {
          if (await page.evaluate(() => document.body?.dataset.evaluationTarget).catch(() => undefined) === identity) matches.push(page);
        }
        evidence.phase('setup', 'assertion');
        expect(matches).toHaveLength(1);
        evidence.passed('setup');
        const original = matches[0]!;
        const before = evaluations;
        evidence.phase('body', 'dispatch');
        const rejected = browser.evaluate(async value => {
          document.body.dataset.evaluationCount = String(Number(document.body.dataset.evaluationCount ?? 0) + 1);
          document.body.dataset.evaluationReady = value;
          return await new Promise<null>(() => {});
        }, identity).catch((cause: unknown) => cause);
        // This marks invocation only; the pending evaluation is settled below.
        evidence.phase('body', 'readiness');
        await original.waitForFunction(value => document.body.dataset.evaluationReady === value, identity, { timeout: 5_000 });
        evidence.phase('body', 'assertion');
        expect(await original.getAttribute('body', 'data-evaluation-count')).toBe('1');
        faultInjected = true;
        if (fault === 'page closure') {
          evidence.phase('body', 'target-close');
          await original.close();
          evidence.phase('body', 'assertion');
          expect(original.isClosed()).toBe(true);
          expect(remote.proc.exitCode).toBeNull();
          expect(remote.proc.signalCode).toBeNull();
        } else {
          // Host termination destroys the context too; this is not isolated context.close conformance.
          evidence.phase('body', 'browser-close');
          await closeRemoteChrome(remote);
          evidence.phase('body', 'assertion');
          expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true);
        }
        // Arbitrary evaluation has already mutated the page. A lost result cannot prove it did not commit.
        evidence.phase('body', 'evaluate');
        const failure = await rejected;
        expect(failure).toBeInstanceOf(TestError);
        expect(failure).toMatchObject({ code: 'ACTION_FAILED', retryable: false });
        expect((failure as TestError).cause).toBeInstanceOf(EngineError);
        expect((failure as TestError).cause).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
        expect(evaluations).toBe(before + 1);
        evidence.phase('body', 'end');
        await expect(engine.endAttempt!(cleanup)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
        evidence.passed('body');
      } catch (cause) { evidence.failed(); failures.push(cause); } finally {
        // Restore per-instance wrappers before the original prototype counter restore.
        evidence.observer.close();
        try {
          commands.mockRestore();
          if (engine !== undefined) {
            evidence.phase('cleanup', 'dispose');
            await settle([engine.dispose!(cleanup).catch((cause: unknown) => {
              if (!faultInjected) throw cause;
              expect(cause).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
            })]);
          }
          if (control !== undefined) {
            evidence.phase('cleanup', 'browser-close');
            await settle([control.close()]);
          }
          if (remote !== undefined) {
            evidence.phase('cleanup', 'close-host');
            await settle([closeRemoteChrome(remote)]);
          }
          rmSync(artifactsDir, { recursive: true, force: true });
          evidence.passed('cleanup');
        } catch (cause) {
          evidence.failed('cleanup');
          // Preserve the original finally's cleanup exception precedence.
          // eslint-disable-next-line no-unsafe-finally
          throw cause;
        }
        finally { restoreConnection(); evidence.finish(); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'External evaluation fault test failed');
    });
  });
});
