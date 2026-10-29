import { AsyncResource } from 'node:async_hooks';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type EngineFixtureContext, type OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { FixtureRecorder } from '../../../e2e/dist/run/fixture-recording.js';
import { StepRecorder } from '../../../e2e/dist/run/steps.js';
import type { AttemptEnvironment } from '../../../e2e/dist/run/fixtures.js';
import { ErrorLatch } from '../../src/runtime-support.ts';
import type { BrowserCommandMap, BrowserEventMap, NativeWebSurface } from '../../src/native/browser-contract.ts';

const directories: string[] = [];
const cleanups: (() => void)[] = [];
const emissions: Promise<void>[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.allSettled(emissions.splice(0));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Gates ordering without sleeps, including a deliberately late native read. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  cleanups.push(() => reject(new Error('test cleanup')));
  return { promise, resolve, reject };
}

/** Real core fixture/step recorders over a fake native byte source and detached transport. */
async function fixture(options: { omitTimeouts?: boolean; operationTimeout?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-download-waiter-'));
  directories.push(directory);
  const transport = new AsyncResource('download-test-native-transport');
  cleanups.push(() => transport.emitDestroy());
  const steps = new StepRecorder('attempt');
  const latch = new ErrorLatch();
  let scope = 'scope-1';
  let sequence = 0;
  let subscription = 0;
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const listeners = new Set<(event: BrowserEventMap['download.started']) => void | Promise<void>>();
  const attached: string[] = [];
  const recorder = new FixtureRecorder({ steps, budget: { signal: controller.signal }, config: { actionTimeout: 1000 } } as AttemptEnvironment);
  const commands: { name: keyof BrowserCommandMap; args: unknown; timeoutMs: number; signal: AbortSignal; identityScope: string }[] = [];
  const retired = new Set<string>();
  const responders = new Map<keyof BrowserCommandMap, (args: unknown, operation: OperationContext) => unknown | Promise<unknown>>();
  const operation = (timeoutMs = options.operationTimeout ?? 1000): OperationContext => ({ signal: controller.signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
  const step = <T>(name: string, work: () => Promise<T>): Promise<T> => steps.run('resource', name, '', work);
  const surface: NativeWebSurface = {
    retainDownloadFile: () => ({ publish: () => {}, retire: work => latch.track('download file cleanup', work.catch(cause => { latch.latch(cause as Error); })) }),
    latch, get identityScope() { return scope; },
    latchCallbackFailure: () => undefined,
    routeRegistryVersion: () => 0,
    allocateRouteRegistryVersion: () => 1,
    invalidate: () => new EngineError('ENGINE_FAILURE', 'invalidated', { retryable: false }),
    async command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], current: OperationContext): Promise<BrowserCommandMap[K]['result']> {
      commands.push({ name, args, timeoutMs: current.timeoutMs, signal: current.signal, identityScope: scope });
      const responder = responders.get(name);
      if (responder !== undefined) return await responder(args, current) as BrowserCommandMap[K]['result'];
      if (name === 'download.subscribe') return { subscriptionId: `subscription-${++subscription}`, identityScope: scope } as BrowserCommandMap[K]['result'];
      if (name === 'download.read') {
        const { handle, offset, maxBytes } = args as BrowserCommandMap['download.read']['args'];
        if (retired.has(handle)) throw new Error('native handle was retired');
        const body = Buffer.from('name,value\nfixture,42\n');
        const bytes = body.subarray(offset, offset + maxBytes);
        return { base64: bytes.toString('base64'), nextOffset: offset + bytes.length, eof: offset + bytes.length === body.length } as BrowserCommandMap[K]['result'];
      }
      return null as BrowserCommandMap[K]['result'];
    },
    subscribe(name, callback) {
      if (name !== 'download.started') return () => undefined;
      const listener = callback as (event: BrowserEventMap['download.started']) => void | Promise<void>;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    decide: async () => undefined,
    projectPath: file => file,
    siteHeaders: () => ({}),
    artifactPath: () => { const relative = `download-${++sequence}.csv`; return { relative, absolute: join(directory, relative) }; },
  };
  const context = {
    operation, signal: controller.signal,
    ...(options.omitTimeouts === true ? {} : { timeouts: { action: 1000, test: 5000, assertion: 1000 } }),
    fixture: recorder.fixture.bind(recorder),
    expectable: (target: object) => target,
    attachArtifact: (_kind: string, path: string) => { attached.push(path); steps.attachArtifact(path); },
    app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
  } as unknown as EngineFixtureContext;
  const browser = createBrowserFixture(surface, context);
  const waitForDownload = browser.waitForDownload.bind(browser);
  browser.waitForDownload = (...args) => {
    const pending = waitForDownload(...args);
    void pending.catch(() => undefined);
    return pending;
  };
  const emit = (overrides: Partial<BrowserEventMap['download.started']> = {}) => {
    const work = transport.runInAsyncScope(async () => {
      const event = { identityScope: scope, activePage: true, handle: 'download-1', suggestedFilename: 'report.csv', ...overrides };
      try { await Promise.all([...listeners].map(callback => callback(event))); }
      finally { retired.add(event.handle); }
    });
    emissions.push(work);
    return work;
  };
  return {
    browser, commands, responders, directory, emit, controller, retired, step, steps, listeners,
    settle: () => latch.settle({ signal: new AbortController().signal, timeoutMs: 1000 }),
    get attachments() {
      const waiters = steps.all().filter(record => record.api === 'browser.waitForDownload');
      return attached.map(path => {
        const record = steps.all().find(candidate => candidate.artifacts.includes(path));
        const index = waiters.findIndex(waiter => waiter.id === record?.id);
        return { path, owner: index < 0 ? record?.api : `waiter-${index + 1}` };
      });
    },
    reset: () => { scope = 'scope-2'; },
  };
}

/** Flushes async native subscription before advancing a fake clock. */
async function subscribed() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

/** File I/O stays real; only deadline clocks and timers are deterministic. */
function fakeClock() { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(0); }

describe('download waiter contract', () => {
  it('reports the resolved trigger duration before the generic fixture timeout', async () => {
    fakeClock();
    const f = await fixture();
    const result = f.browser.waitForDownload(() => new Promise(resolve => setTimeout(resolve, 30)), { timeout: 100 }).catch(cause => cause);
    await subscribed();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'ACTION_FAILED', message: 'no download started within 100ms; the trigger resolved after 30ms' });
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
  });

  it('keeps the step timeout for a running trigger and never publishes its late download', async () => {
    fakeClock();
    const f = await fixture();
    const trigger = deferred();
    const result = f.browser.waitForDownload(() => trigger.promise, { timeout: 100 }).catch(cause => cause);
    await subscribed();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'ACTION_FAILED', message: 'browser.waitForDownload exceeded its timeout of 100ms' });
    await f.emit();
    trigger.resolve();
    await subscribed();
    expect(f.attachments).toEqual([]);
    expect(f.commands.filter(command => command.name === 'download.read')).toHaveLength(0);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
  });

  it('preserves the original trigger error over an earlier capture error and cleanup failure', async () => {
    const f = await fixture();
    const original = new TestError('ASSERTION_FAILED', 'trigger assertion');
    f.responders.set('download.read', () => { throw new Error('capture failed'); });
    f.responders.set('download.unsubscribe', () => { throw new Error('cleanup failed'); });
    await expect(f.browser.waitForDownload(async () => { await f.emit(); throw original; })).rejects.toBe(original);
    expect(f.attachments).toEqual([]);
    await f.settle();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('copies bytes before callback handle retirement but attaches after the nested trigger returns', async () => {
    const f = await fixture();
    const trigger = deferred();
    const entered = deferred();
    const pending = f.browser.waitForDownload(() => f.step('nested-tap', async () => { entered.resolve(); await trigger.promise; }));
    await entered.promise;
    await f.emit();
    expect(f.retired.has('download-1')).toBe(true);
    expect(await readFile(join(f.directory, 'download-1.csv'), 'utf8')).toBe('name,value\nfixture,42\n');
    expect(f.attachments).toEqual([]);
    await f.step('unrelated-concurrent-step', async () => undefined);
    trigger.resolve();
    const file = await pending;
    expect(f.attachments).toEqual([{ owner: 'waiter-1', path: file.path }]);
  });

  it('attributes concurrent waiters independently after one shared native callback retires', async () => {
    const f = await fixture();
    const first = deferred();
    const second = deferred();
    const one = f.browser.waitForDownload(() => first.promise);
    const two = f.browser.waitForDownload(() => second.promise);
    await subscribed();
    await f.emit();
    expect(f.attachments).toEqual([]);
    second.resolve();
    const secondFile = await two;
    first.resolve();
    const firstFile = await one;
    expect(f.attachments).toEqual([{ owner: 'waiter-2', path: secondFile.path }, { owner: 'waiter-1', path: firstFile.path }]);
    expect(firstFile.path).not.toBe(secondFile.path);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(2);
  });

  it('discards a captured file when its trigger fails instead of attaching it to the tap', async () => {
    const f = await fixture();
    const original = new Error('trigger failed after download');
    await expect(f.browser.waitForDownload(async () => { await f.emit(); throw original; })).rejects.toBe(original);
    expect(f.attachments).toEqual([]);
    await f.settle();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('does not publish captured bytes after their attempt scope retires', async () => {
    const f = await fixture();
    const trigger = deferred();
    const result = f.browser.waitForDownload(() => trigger.promise).catch(cause => cause);
    await subscribed();
    await f.emit();
    f.reset();
    trigger.resolve();
    expect(await result).toMatchObject({ code: 'APP_NOT_OPEN' });
    expect(f.attachments).toEqual([]);
    await f.settle();
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(0);
  });

  it('cancels immediately while a trigger and native read are still pending and discards late bytes', async () => {
    const f = await fixture();
    const read = deferred<BrowserCommandMap['download.read']['result']>();
    const reading = deferred();
    const trigger = deferred();
    f.responders.set('download.read', () => { reading.resolve(); return read.promise; });
    const result = f.browser.waitForDownload(() => trigger.promise).catch(cause => cause);
    await subscribed();
    const event = f.emit();
    await reading.promise;
    f.controller.abort();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    expect(f.listeners.size).toBe(0);
    let settled = false;
    const settling = f.settle().then(() => { settled = true; });
    await subscribed();
    expect(settled).toBe(false);
    read.resolve({ base64: Buffer.from('late').toString('base64'), nextOffset: 4, eof: true });
    await event;
    trigger.resolve();
    await settling;
    expect(f.attachments).toEqual([]);
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.retired.has('download-1')).toBe(true);
  });

  it('does not trigger or subscribe locally after subscription admission settles past cancellation', async () => {
    const f = await fixture();
    const admission = deferred<BrowserCommandMap['download.subscribe']['result']>();
    const trigger = vi.fn(async () => undefined);
    f.responders.set('download.subscribe', () => admission.promise);
    const result = f.browser.waitForDownload(trigger).catch(cause => cause);
    f.controller.abort();
    expect(await result).toMatchObject({ code: 'CANCELLED' });
    let settled = false;
    const settling = f.settle().then(() => { settled = true; });
    await subscribed();
    expect(settled).toBe(false);
    admission.resolve({ subscriptionId: 'late-subscription', identityScope: 'scope-1' });
    await settling;
    expect(trigger).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
  });

  it('charges subscription and trigger time to the same transfer budget', async () => {
    fakeClock();
    const f = await fixture();
    const admission = deferred<BrowserCommandMap['download.subscribe']['result']>();
    const entered = deferred();
    const trigger = deferred();
    f.responders.set('download.subscribe', () => admission.promise);
    const pending = f.browser.waitForDownload(async () => { entered.resolve(); await trigger.promise; }, { timeout: 100 });
    await vi.advanceTimersByTimeAsync(20);
    admission.resolve({ subscriptionId: 'slow-subscription', identityScope: 'scope-1' });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30);
    trigger.resolve();
    await f.emit();
    await pending;
    const read = f.commands.find(command => command.name === 'download.read');
    expect(read?.timeoutMs).toBe(50);
    expect(f.attachments).toHaveLength(1);
  });

  it.each([0, -1, NaN, Infinity, null, '100'])('retains public validation for timeout %s with its owned deadline', async timeout => {
    const f = await fixture();
    await expect(f.browser.waitForDownload(async () => undefined, { timeout: timeout as number })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', message: 'browser.waitForDownload timeout must be positive and finite',
    });
    expect(f.commands).toEqual([]);
  });

  it('never admits a subscription for an already cancelled operation', async () => {
    const f = await fixture();
    f.controller.abort();
    await expect(f.browser.waitForDownload(async () => undefined)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.commands).toEqual([]);
  });

  it('keeps the resolved-trigger diagnostic when unsubscribe itself outlives the deadline', async () => {
    fakeClock();
    const f = await fixture();
    const cleanup = deferred();
    f.responders.set('download.unsubscribe', () => cleanup.promise);
    const result = f.browser.waitForDownload(async () => undefined, { timeout: 100 }).catch(cause => cause);
    await subscribed();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
    let outcome: unknown;
    void result.then(value => { outcome = value; });
    await subscribed();
    expect(outcome).toMatchObject({ code: 'ACTION_FAILED', message: 'no download started within 100ms; the trigger resolved after 0ms' });
    let settled = false;
    const settling = f.settle().then(() => { settled = true; });
    await subscribed();
    expect(settled).toBe(false);
    cleanup.resolve();
    await settling;
    expect(settled).toBe(true);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
  });

  it('keeps a trigger error primary even if cleanup crosses the waiter deadline', async () => {
    fakeClock();
    const f = await fixture();
    const cleanup = deferred();
    const original = new TestError('ASSERTION_FAILED', 'trigger assertion near deadline');
    f.responders.set('download.unsubscribe', () => cleanup.promise);
    const result = f.browser.waitForDownload(async () => { await new Promise(resolve => setTimeout(resolve, 99)); throw original; }, { timeout: 100 }).catch(cause => cause);
    await subscribed();
    await vi.advanceTimersByTimeAsync(100);
    let outcome: unknown;
    void result.then(value => { outcome = value; });
    await subscribed();
    expect(outcome).toBe(original);
    cleanup.resolve();
    await f.settle();
  });

  it('stops the transfer at the original deadline and retires late callback bytes without publication', async () => {
    fakeClock();
    const f = await fixture();
    const read = deferred<BrowserCommandMap['download.read']['result']>();
    const reading = deferred();
    f.responders.set('download.read', () => { reading.resolve(); return read.promise; });
    const result = f.browser.waitForDownload(async () => undefined, { timeout: 100 }).catch(cause => cause);
    await subscribed();
    const event = f.emit();
    await reading.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'ACTION_FAILED', message: 'download did not complete within 100ms' });
    expect(f.commands.find(command => command.name === 'download.read')?.signal.aborted).toBe(true);
    read.resolve({ base64: Buffer.from('late').toString('base64'), nextOffset: 4, eof: true });
    await event;
    expect(f.attachments).toEqual([]);
    await f.settle();
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.retired.has('download-1')).toBe(true);
  });

  it('ignores inactive-page and retired-scope events without capturing or publishing their bytes', async () => {
    const f = await fixture();
    const trigger = deferred();
    const pending = f.browser.waitForDownload(() => trigger.promise);
    await subscribed();
    await f.emit({ handle: 'inactive', activePage: false });
    await f.emit({ handle: 'old', identityScope: 'old-scope' });
    expect(f.commands.filter(command => command.name === 'download.read')).toHaveLength(0);
    await f.emit({ handle: 'current' });
    trigger.resolve();
    await pending;
    expect(f.attachments).toHaveLength(1);
    expect([...f.retired]).toEqual(['inactive', 'old', 'current']);
  });


  it('keeps success-path unsubscribe inside the original deadline and joins its late retirement', async () => {
    fakeClock();
    const f = await fixture();
    const cleanup = deferred();
    f.responders.set('download.unsubscribe', () => cleanup.promise);
    const result = f.browser.waitForDownload(async () => undefined, { timeout: 100 }).catch(cause => cause);
    let outcome: unknown;
    void result.then(value => { outcome = value; });
    await subscribed();
    await f.emit();
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome).toMatchObject({ code: 'ACTION_FAILED', message: 'download did not complete within 100ms' });
    expect(f.attachments).toEqual([]);
    let settled = false;
    const settling = f.settle().then(() => { settled = true; });
    await subscribed();
    expect(settled).toBe(false);
    cleanup.resolve();
    await settling;
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toHaveLength(1);
  });

  it('preserves separate ownership when one download waiter triggers another', async () => {
    const f = await fixture();
    const entered = deferred();
    const pending = f.browser.waitForDownload(() => f.browser.waitForDownload(async () => { entered.resolve(); }).then(() => undefined));
    await entered.promise;
    await f.emit();
    const outer = await pending;
    expect(f.attachments.map(attachment => attachment.owner)).toEqual(['waiter-2', 'waiter-1']);
    expect(f.attachments.at(-1)?.path).toBe(outer.path);
    expect(f.steps.all().map(step => [step.api, step.status, step.artifacts.length])).toEqual([
      ['browser.waitForDownload', 'passed', 1], ['browser.waitForDownload', 'passed', 1],
    ]);
  });

  it('retains exact binary bytes and sequential chunk offsets before handle retirement', async () => {
    const f = await fixture();
    const body = Buffer.alloc(150000, 0xa5);
    f.responders.set('download.read', args => {
      const { handle, offset, maxBytes } = args as BrowserCommandMap['download.read']['args'];
      expect(f.retired.has(handle)).toBe(false);
      const bytes = body.subarray(offset, offset + maxBytes);
      return { base64: bytes.toString('base64'), nextOffset: offset + bytes.length, eof: offset + bytes.length === body.length };
    });
    const file = await f.browser.waitForDownload(() => f.emit());
    expect(await readFile(file.absolutePath)).toEqual(body);
    expect(f.commands.filter(command => command.name === 'download.read').map(command => command.args)).toEqual([
      { handle: 'download-1', offset: 0, maxBytes: 65536 },
      { handle: 'download-1', offset: 65536, maxBytes: 65536 },
      { handle: 'download-1', offset: 131072, maxBytes: 65536 },
    ]);
    expect(f.retired.has('download-1')).toBe(true);
  });

  it('removes partial bytes and preserves the read failure after a successful trigger', async () => {
    const f = await fixture();
    const failure = new Error('second chunk failed');
    f.responders.set('download.read', args => {
      const { offset } = args as BrowserCommandMap['download.read']['args'];
      if (offset > 0) throw failure;
      return { base64: Buffer.from('partial').toString('base64'), nextOffset: 7, eof: false };
    });
    await expect(f.browser.waitForDownload(() => f.emit())).rejects.toBe(failure);
    await f.settle();
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.attachments).toEqual([]);
    expect(f.retired.has('download-1')).toBe(true);
  });


  it('rejects a late old-scope subscription instead of binding its reused ID to the replacement scope', async () => {
    const f = await fixture();
    const admission = deferred<BrowserCommandMap['download.subscribe']['result']>();
    const trigger = vi.fn(async () => undefined);
    f.responders.set('download.subscribe', () => admission.promise);
    const result = f.browser.waitForDownload(trigger).catch(cause => cause);
    f.reset();
    admission.resolve({ subscriptionId: 'reused-id', identityScope: 'scope-1' });
    expect(await result).toMatchObject({ code: 'APP_NOT_OPEN' });
    await f.settle();
    expect(trigger).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toEqual([]);
    f.responders.set('download.subscribe', () => ({ subscriptionId: 'reused-id', identityScope: 'scope-2' }));
    await f.browser.waitForDownload(() => f.emit());
    expect(f.commands.filter(command => command.name === 'download.unsubscribe').map(command => [command.identityScope, command.args])).toEqual([
      ['scope-2', { subscriptionId: 'reused-id' }],
    ]);
  });

  it('accepts the recovered scope that actually admitted its subscription', async () => {
    const f = await fixture();
    f.responders.set('download.subscribe', () => {
      f.reset();
      return { subscriptionId: 'recovered-id', identityScope: 'scope-2' };
    });
    const file = await f.browser.waitForDownload(() => f.emit());
    expect(await readFile(file.absolutePath, 'utf8')).toBe('name,value\nfixture,42\n');
    expect(f.commands.filter(command => command.name === 'download.unsubscribe').map(command => [command.identityScope, command.args])).toEqual([
      ['scope-2', { subscriptionId: 'recovered-id' }],
    ]);
  });

  it('does not let cancellation clean a reused subscription ID in a replacement scope', async () => {
    fakeClock();
    const f = await fixture();
    const oldAdmission = deferred<BrowserCommandMap['download.subscribe']['result']>();
    f.responders.set('download.subscribe', () => oldAdmission.promise);
    const old = f.browser.waitForDownload(async () => undefined, { timeout: 100 }).catch(cause => cause);
    await vi.advanceTimersByTimeAsync(100);
    expect(await old).toMatchObject({ code: 'ACTION_FAILED' });
    f.reset();
    f.responders.set('download.subscribe', () => ({ subscriptionId: 'reused-id', identityScope: 'scope-2' }));
    const trigger = deferred();
    const newer = f.browser.waitForDownload(() => trigger.promise);
    await subscribed();
    oldAdmission.resolve({ subscriptionId: 'reused-id', identityScope: 'scope-1' });
    await f.settle();
    expect(f.commands.filter(command => command.name === 'download.unsubscribe')).toEqual([]);
    await f.emit();
    trigger.resolve();
    await newer;
    expect(f.commands.filter(command => command.name === 'download.unsubscribe').map(command => [command.identityScope, command.args])).toEqual([
      ['scope-2', { subscriptionId: 'reused-id' }],
    ]);
  });


  it('uses the operation budget without requiring separate fixture timeout defaults', async () => {
    const f = await fixture({ omitTimeouts: true });
    const file = await f.browser.waitForDownload(() => f.emit());
    expect(await readFile(file.absolutePath, 'utf8')).toBe('name,value\nfixture,42\n');
  });

  it('uses the already resolved operation timeout instead of resolving the default twice', async () => {
    fakeClock();
    const f = await fixture({ operationTimeout: 120 });
    const trigger = deferred();
    let outcome: unknown;
    void f.browser.waitForDownload(() => trigger.promise).catch(cause => { outcome = cause; });
    await subscribed();
    await vi.advanceTimersByTimeAsync(120);
    expect(outcome).toMatchObject({ code: 'ACTION_FAILED', message: 'browser.waitForDownload exceeded its timeout of 120ms' });
    expect(f.commands.find(command => command.name === 'download.subscribe')?.timeoutMs).toBe(120);
    trigger.resolve();
    await f.settle();
  });

});
