/** Public-object fakes prove event/identity/receipt handling, not Chromium behavior. */
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import { bindExistingPlaywrightPage, type PlaywrightBinding } from '../../src/native/playwright-binding.ts';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const operation = (signal = new AbortController().signal, timeoutMs = 1000): OperationContext => ({ signal, timeoutMs, runId: 'replacement', attemptId: 'one', origin: 'test' });
function fixture() {
  const contextEvents = new EventEmitter(); const browserEvents = new EventEmitter();
  const pages: Page[] = []; const ids = new Map<Page, string>(); const closed = new Set<Page>();
  const sessions: string[] = []; let identityGate: Promise<void> | undefined; let detachGate: Promise<void> | undefined;
  const detaching = deferred<void>(); const reading = deferred<void>(); const identityFailures = new Map<string, unknown>();
  const context = Object.assign(contextEvents, {
    pages: () => [...pages],
    newCDPSession: async (page: Page) => {
      const id = ids.get(page)!; sessions.push(`open:${id}`);
      return { send: async () => { reading.resolve(); await identityGate; if (identityFailures.has(id)) throw identityFailures.get(id); return { targetInfo: { type: 'page', targetId: id, browserContextId: 'context' } }; }, detach: async () => { sessions.push(`detach:${id}`); detaching.resolve(); await detachGate; } };
    },
  }) as unknown as BrowserContext;
  const browser = Object.assign(browserEvents, { isConnected: () => true }) as unknown as Browser;
  const page = (id: string, announce = true) => {
    const next = { context: () => context, isClosed: () => closed.has(next) } as Page;
    pages.push(next); ids.set(next, id);
    if (announce) contextEvents.emit('page', next);
    return next;
  };
  const old = page('old', false); closed.add(old);
  const binding: PlaywrightBinding = { kind: 'isolated', browser, context, page: old, contextId: 'context', targetId: 'old' };
  const assertNoListeners = () => {
    expect(contextEvents.listenerCount('page')).toBe(0); expect(contextEvents.listenerCount('close')).toBe(0); expect(browserEvents.listenerCount('disconnected')).toBe(0);
  };
  return { binding, page, closed, sessions, contextEvents, assertNoListeners, detaching: detaching.promise, reading: reading.promise,
    holdIdentity: (gate: Promise<void>) => { identityGate = gate; }, holdDetach: (gate: Promise<void>) => { detachGate = gate; },
    failIdentity: (id: string, cause: unknown) => { identityFailures.set(id, cause); } };
}
const expected = { contextId: 'context', targetId: 'exact' };
it('binds the exact existing Page without choosing a sibling', async () => {
  const f = fixture(); f.page('popup'); const exact = f.page('exact');
  const rebound = await bindExistingPlaywrightPage(f.binding, expected, operation());
  expect(rebound.page).toBe(exact); expect(rebound.context).toBe(f.binding.context); expect(rebound.browser).toBe(f.binding.browser);
  expect(f.sessions).toEqual(['open:popup', 'detach:popup', 'open:exact', 'detach:exact']); f.assertNoListeners();
});
it('waits for a lagging target event and never selects a popup', async () => {
  const f = fixture(); const binding = bindExistingPlaywrightPage(f.binding, expected, operation());
  f.page('popup'); const exact = f.page('exact');
  expect((await binding).page).toBe(exact); f.assertNoListeners();
});
it('removes listeners after cancellation while awaiting an event', async () => {
  const f = fixture(); const cancel = new AbortController();
  const binding = bindExistingPlaywrightPage(f.binding, expected, operation(cancel.signal));
  cancel.abort(); await expect(binding).rejects.toMatchObject({ code: 'CANCELLED' }); f.assertNoListeners();
});
it('uses the original finite deadline when the exact Page never arrives', async () => {
  const f = fixture();
  await expect(bindExistingPlaywrightPage(f.binding, expected, operation(undefined, 10))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  f.assertNoListeners();
});
it('retains an in-flight identity session through cancellation until detach settles', async () => {
  const f = fixture(); const cancel = new AbortController(); const gate = deferred<void>();
  f.page('exact'); f.holdIdentity(gate.promise);
  let settled = false;
  const binding = bindExistingPlaywrightPage(f.binding, expected, operation(cancel.signal));
  void binding.then(() => { settled = true; }, () => { settled = true; });
  await f.reading; cancel.abort(); await Promise.resolve();
  expect(settled).toBe(false); expect(f.sessions).toEqual(['open:exact']);
  gate.resolve(); await expect(binding).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.sessions).toEqual(['open:exact', 'detach:exact']); f.assertNoListeners();
});
it('refuses context replacement without allocating or touching sibling Pages', async () => {
  const f = fixture(); f.page('exact');
  await expect(bindExistingPlaywrightPage(f.binding, { ...expected, contextId: 'different' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(f.sessions).toEqual([]); f.assertNoListeners();
});
it('refuses a context close while waiting instead of reporting a selected Page', async () => {
  const f = fixture(); const binding = bindExistingPlaywrightPage(f.binding, expected, operation());
  f.contextEvents.emit('close'); await expect(binding).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); f.assertNoListeners();
});


it.each(['CANCELLED', 'ENGINE_FAILURE'] as const)('preserves a real %s detach rejection after cancellation instead of relabeling it local', async code => {
  for (const alsoClosed of [false, true]) {
    const f = fixture(); const cancel = new AbortController(); const detach = deferred<void>();
    const page = f.page('exact'); f.holdDetach(detach.promise);
    const binding = bindExistingPlaywrightPage(f.binding, expected, operation(cancel.signal));
    await f.detaching; cancel.abort(); if (alsoClosed) f.closed.add(page);
    const failure = new EngineError(code, 'actual identity session detach rejected', { retryable: false });
    detach.reject(failure); await expect(binding).rejects.toBe(failure); f.assertNoListeners();
  }
});
it('skips a positively retired candidate query only after its session detach has settled', async () => {
  const f = fixture(); const lookup = deferred<void>(); const popup = f.page('popup'); const exact = f.page('exact');
  f.holdIdentity(lookup.promise); f.failIdentity('popup', new Error('old page closed during lookup'));
  const binding = bindExistingPlaywrightPage(f.binding, expected, operation());
  await f.reading; f.closed.add(popup); lookup.resolve();
  expect((await binding).page).toBe(exact);
  expect(f.sessions).toEqual(['open:popup', 'detach:popup', 'open:exact', 'detach:exact']); f.assertNoListeners();
});
