import { describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { OperationContext } from 'e2e/engine';
import { bindPersistentPlaywrightContext, disconnectedBindingMode } from '../../src/native/playwright-binding.ts';

const operation = (): OperationContext => ({ runId: 'binding', attemptId: 'one', origin: 'test', signal: new AbortController().signal, timeoutMs: 5000 });
function persistent(ids: readonly string[], actualContext = 'default-context') {
  const calls: string[] = [];
  const pages: Page[] = [];
  const context = {
    pages: () => pages,
    newCDPSession: async (page: Page) => ({
      send: async () => ({ targetInfo: { type: 'page', targetId: ids[pages.indexOf(page)], browserContextId: actualContext } }),
      detach: async () => { calls.push('detach-page-session'); },
    }),
  } as unknown as BrowserContext;
  for (const _id of ids) pages.push({ context: () => context } as unknown as Page);
  const browser = {
    contexts: () => [context],
    isConnected: () => true,
    newContext: () => { throw new Error('persistent bind must not create a context'); },
    close: () => { throw new Error('identity failure must not close a borrowed browser'); },
    newBrowserCDPSession: async () => ({
      send: async () => ({ browserContextIds: [], defaultBrowserContextId: actualContext }),
      detach: async () => { calls.push('detach-browser-session'); },
    }),
  } as unknown as Browser;
  return { browser, context, pages, calls };
}
describe('real persistent binding selection', () => {
  it('selects exact target, never the first or same-URL sibling, without allocation', async () => {
    const fixture = persistent(['other', 'exact']);
    const binding = await bindPersistentPlaywrightContext(fixture.browser, { contextId: 'default-context', targetId: 'exact' }, operation());
    expect(binding.context).toBe(fixture.context);
    expect(binding.page).toBe(fixture.pages[1]);
    expect(binding.kind).toBe('persistent');
    expect(fixture.calls).toEqual(['detach-browser-session', 'detach-page-session', 'detach-page-session']);
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
