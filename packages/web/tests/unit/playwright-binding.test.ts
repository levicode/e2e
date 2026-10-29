import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { OperationContext } from 'e2e/engine';
import { bindPersistentPlaywrightContext, createPlaywrightContext, disconnectedBindingMode } from '../../src/native/playwright-binding.ts';

const operation = (): OperationContext => ({ runId: 'binding', attemptId: 'one', origin: 'test', signal: new AbortController().signal, timeoutMs: 5000 });
function persistent(ids: readonly string[], actualContext = 'default-context') {
  const calls: string[] = [];
  const pages: Page[] = [];
  const guardedAtDetach: string[] = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    newCDPSession: async (page: Page) => { const events = new EventEmitter(); return Object.assign(events, {
      send: async () => ({ targetInfo: { type: 'page', targetId: ids[pages.indexOf(page)], browserContextId: actualContext } }),
      detach: async () => { calls.push('detach-page-session'); if ((page as unknown as EventEmitter).listenerCount('dialog') > 0) guardedAtDetach.push(ids[pages.indexOf(page)]!); events.emit('close'); },
    }); },
  }) as unknown as BrowserContext;
  for (let index = 0; index < ids.length; index++) pages.push(Object.assign(new EventEmitter(), { context: () => context, isClosed: () => false }) as unknown as Page);
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => true,
    newContext: () => { throw new Error('persistent bind must not create a context'); },
    close: () => { throw new Error('identity failure must not close a borrowed browser'); },
    newBrowserCDPSession: async () => { const events = new EventEmitter(); return Object.assign(events, {
      send: async () => ({ browserContextIds: [], defaultBrowserContextId: actualContext }),
      detach: async () => { calls.push('detach-browser-session'); events.emit('close'); },
    }); },
  }) as unknown as Browser;
  return { browser, context, pages, calls, guardedAtDetach };
}
describe('real persistent binding selection', () => {
  it('selects exact target, never the first or same-URL sibling, without allocation', async () => {
    const fixture = persistent(['other', 'exact']);
    const binding = await bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
    expect(binding.context).toBe(fixture.context);
    expect(binding.page).toBe(fixture.pages[1]);
    expect(binding.kind).toBe('persistent');
    expect(fixture.calls).toEqual(['detach-browser-session', 'detach-page-session', 'detach-page-session']);
    expect(fixture.guardedAtDetach).toEqual(['exact']);
  });
  it('refuses wrong context or missing exact target without replacing host data', async () => {
    for (const fixture of [persistent(['exact'], 'different-context'), persistent(['other'])]) {
      await expect(bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(fixture.context.pages()).toEqual(fixture.pages);
    }
  });
  it('does not describe a disposed isolated context as a persistent reconnect', async () => {
    const fixture = persistent(['exact']);
    const binding = await bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
    expect(disconnectedBindingMode(binding)).toBeUndefined();
    const disconnected = { isConnected: () => false } as Browser;
    expect(disconnectedBindingMode({ ...binding, browser: disconnected })).toBe('persistent-rebind');
    expect(disconnectedBindingMode({ ...binding, browser: disconnected, kind: 'isolated' })).toBe('isolated-context-lost');
  });
});


it('observes only the exact borrowed Page without deciding or replacing emitted objects', async () => {
  const fixture = persistent(['other', 'exact']);
  const page = fixture.pages[1]!;
  const observed: unknown[] = [];
  const listener = (dialog: unknown) => observed.push(dialog);
  page.on('dialog', listener);
  await bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
  await bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
  expect((page as unknown as EventEmitter).listenerCount('dialog')).toBe(2); // One user listener and one idempotent guard.
  expect((fixture.pages[0] as unknown as EventEmitter).listenerCount('dialog')).toBe(0);
  expect((fixture.context as unknown as EventEmitter).listenerCount('dialog')).toBe(0);
  let answered = false;
  const dialog = { accept: () => { answered = true; }, dismiss: () => { answered = true; } };
  (page as unknown as EventEmitter).emit('dialog', dialog);
  expect(observed).toEqual([dialog]); expect(observed[0]).toBe(dialog); expect(answered).toBe(false);
  (page as unknown as EventEmitter).emit('close');
  expect((page as unknown as EventEmitter).listeners('dialog')).toEqual([listener]);
  expect((fixture.browser as unknown as EventEmitter).listenerCount('disconnected')).toBe(0);
});
it('retires only its own borrowed listener on disconnect and reinstalls on a new client tenure', async () => {
  const first = persistent(['exact']);
  const listener = () => {};
  first.pages[0]!.on('dialog', listener);
  await bindPersistentPlaywrightContext(first.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
  (first.browser as unknown as EventEmitter).emit('disconnected');
  expect((first.pages[0] as unknown as EventEmitter).listeners('dialog')).toEqual([listener]);
  expect((first.pages[0] as unknown as EventEmitter).listenerCount('close')).toBe(0);
  const next = persistent(['exact']);
  const binding = await bindPersistentPlaywrightContext(next.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
  expect((binding.page as unknown as EventEmitter).listenerCount('dialog')).toBe(1);
  expect(binding.page).not.toBe(first.pages[0]);
});

it.each(['page', 'client'] as const)('does not register on an already-retired borrowed %s', async retired => {
  const fixture = persistent(['exact']);
  if (retired === 'page') Object.defineProperty(fixture.pages[0], 'isClosed', { value: () => true });
  else Object.defineProperty(fixture.browser, 'isConnected', { value: () => false });
  await expect(bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect((fixture.pages[0] as unknown as EventEmitter).listenerCount('dialog')).toBe(0);
  expect((fixture.pages[0] as unknown as EventEmitter).listenerCount('close')).toBe(0);
  expect((fixture.browser as unknown as EventEmitter).listenerCount('disconnected')).toBe(0);
});
it('subscribes on an isolated context before its first Page and removes only that observer on close', async () => {
  const events = new EventEmitter(); const browserEvents = new EventEmitter();
  let installedBeforePage = false;
  const page = { context: () => context, url: () => 'about:blank' } as Page;
  const context = Object.assign(events, {
    isClosed: () => false,
    newPage: async () => { installedBeforePage = events.listenerCount('dialog') === 1; return page; },
    newCDPSession: async () => ({ send: async () => ({ targetInfo: { type: 'page', targetId: 'own-page', browserContextId: 'own-context' } }), detach: async () => {} }),
    close: async () => { events.emit('close'); },
  }) as unknown as BrowserContext;
  const browser = Object.assign(browserEvents, { isConnected: () => true, newContext: async () => context }) as unknown as Browser;
  const binding = await createPlaywrightContext(browser, { blockServiceWorkers: false, viewport: null, media: {}, initScripts: [] }, operation());
  expect(installedBeforePage).toBe(true); expect(binding.page).toBe(page);
  const observer = () => {}; context.on('dialog', observer);
  await context.close();
  expect(events.listeners('dialog')).toEqual([observer]);
  expect(events.listenerCount('close')).toBe(0); expect(browserEvents.listenerCount('disconnected')).toBe(0);
});


it.each([false, true])('releases its observer after failed context acquisition without a close event (close rejects: %s)', async closeRejects => {
  const events = new EventEmitter(); const browserEvents = new EventEmitter();
  const creationFailure = new Error('Page acquisition failed');
  const closeFailure = new Error('actual context close rejection');
  const user = () => {}; events.on('dialog', user);
  let closes = 0;
  const context = Object.assign(events, {
    isClosed: () => false,
    newPage: async () => { throw creationFailure; },
    close: async () => { closes++; if (closeRejects) throw closeFailure; }, // No second close event.
  }) as unknown as BrowserContext;
  const browser = Object.assign(browserEvents, { isConnected: () => true, newContext: async () => context }) as unknown as Browser;
  await expect(createPlaywrightContext(browser, { blockServiceWorkers: false, viewport: null, media: {}, initScripts: [] }, operation())).rejects.toBe(closeRejects ? closeFailure : creationFailure);
  expect(closes).toBe(1);
  expect(events.listeners('dialog')).toEqual([user]);
  expect(events.listenerCount('close')).toBe(0); expect(browserEvents.listenerCount('disconnected')).toBe(0);
  events.emit('close'); browserEvents.emit('disconnected');
  expect(events.listeners('dialog')).toEqual([user]);
});


it('does not subscribe to a Context that closed before acquisition returned', async () => {
  const events = new EventEmitter(); const browserEvents = new EventEmitter();
  const user = () => {}; events.on('dialog', user);
  let pages = 0; let closes = 0;
  const context = Object.assign(events, {
    isClosed: () => true,
    newPage: async () => { pages++; throw new Error('must not create a Page'); },
    close: async () => { closes++; },
  }) as unknown as BrowserContext;
  const browser = Object.assign(browserEvents, { isConnected: () => true, newContext: async () => context }) as unknown as Browser;
  await expect(createPlaywrightContext(browser, { blockServiceWorkers: false, viewport: null, media: {}, initScripts: [] }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(pages).toBe(0); expect(closes).toBe(1);
  expect(events.listeners('dialog')).toEqual([user]);
  expect(events.listenerCount('close')).toBe(0); expect(browserEvents.listenerCount('disconnected')).toBe(0);
});
