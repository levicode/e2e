import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser as HostBrowser } from 'playwright-core';
import type { EngineFixtureContext, EngineHandle } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { NativeClient } from '../../src/native/client.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

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
  it.each(['page closure', 'owned browser termination'] as const)('reports the uncertain outcome after %s without replaying evaluation', async (fault) => {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-loss-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 10_000, runId: 'evaluate-loss', attemptId: 'loss', origin: 'test' as const };
    const cleanup = { signal, timeoutMs: 5_000 };
    let remote: RemoteChrome | undefined;
    let control: HostBrowser | undefined;
    let engine: EngineHandle | undefined;
    const failures: unknown[] = [];
    const settle = async (work: readonly Promise<unknown>[]) => {
      for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') failures.push(result.reason);
    };
    let faultInjected = false;
    let evaluations = 0;
    const request = NativeClient.prototype.request;
    const commands = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, name, args, context) {
      if (name === 'page.evaluate') evaluations += 1;
      return request.call(this, name, args, context);
    });
    try {
      remote = await launchRemoteChrome();
      const endpoint = remote.endpoint;
      engine = web({ connect: { cdpEndpoint: () => endpoint } });
      await engine.init!({ runId: operation.runId, targetName: 'web', projectRoot: process.cwd(),
        app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: operation.attemptId, artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!('about:blank', operation);
      const browser = nativeBrowser(engine, () => operation);
      const identity = randomUUID();
      await browser.evaluate(value => { document.body.dataset.evaluationTarget = value; return null; }, identity);
      // This connection only locates and destroys the actual target; all app operations use Browser.
      control = await chromium.connectOverCDP(endpoint);
      const pages = control.contexts().flatMap(context => context.pages());
      const matches = [];
      for (const page of pages) {
        if (await page.evaluate(() => document.body?.dataset.evaluationTarget).catch(() => undefined) === identity) matches.push(page);
      }
      expect(matches).toHaveLength(1);
      const original = matches[0]!;
      const before = evaluations;
      const rejected = browser.evaluate(async value => {
        document.body.dataset.evaluationCount = String(Number(document.body.dataset.evaluationCount ?? 0) + 1);
        document.body.dataset.evaluationReady = value;
        return await new Promise<null>(() => {});
      }, identity).catch((cause: unknown) => cause);
      await original.waitForFunction(value => document.body.dataset.evaluationReady === value, identity, { timeout: 5_000 });
      expect(await original.getAttribute('body', 'data-evaluation-count')).toBe('1');
      faultInjected = true;
      if (fault === 'page closure') {
        await original.close();
        expect(original.isClosed()).toBe(true);
        expect(remote.proc.exitCode).toBeNull();
        expect(remote.proc.signalCode).toBeNull();
      } else {
        // Host termination destroys the context too; this is not isolated context.close conformance.
        await closeRemoteChrome(remote);
        expect(remote.proc.exitCode !== null || remote.proc.signalCode !== null).toBe(true);
      }
      // Arbitrary evaluation has already mutated the page. A lost result cannot prove it did not commit.
      expect(await rejected).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(evaluations).toBe(before + 1);
      await expect(engine.endAttempt!(cleanup)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    } catch (cause) { failures.push(cause); } finally {
      commands.mockRestore();
      if (engine !== undefined) await settle([engine.dispose!(cleanup).catch((cause: unknown) => {
        if (!faultInjected) throw cause;
        expect(cause).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      })]);
      if (control !== undefined) await settle([control.close()]);
      if (remote !== undefined) await settle([closeRemoteChrome(remote)]);
      rmSync(artifactsDir, { recursive: true, force: true });
    }
    if (failures.length > 0) throw new AggregateError(failures, 'External evaluation fault test failed');
  });
});
