import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from '../../src/index.ts';
import { nativeDocument } from '../helpers/native-browser.ts';

afterEach(() => { vi.unstubAllGlobals(); });

/** Exercise the real helper callback with explicit document lifecycle events, without a browser. */
function documentFixture(mode: 'deferred' | 'sync-load' | 'write-throw' | 'close-throw' = 'deferred') {
  const order: string[] = [];
  const listeners = new Set<() => void>();
  const failure = new Error('Synthetic document replacement failure');
  const html = '<iframe srcdoc="<p>Framed</p>"></iframe>';
  const load = () => {
    const currentListeners = Array.from(listeners);
    for (const listener of currentListeners) {
      listeners.delete(listener);
      listener();
    }
  };
  vi.stubGlobal('window', {
    addEventListener(event: string, listener: () => void, options: AddEventListenerOptions) {
      expect(event).toBe('load');
      expect(options).toEqual({ once: true });
      order.push('listen');
      listeners.add(listener);
    },
    removeEventListener(event: string, listener: () => void) {
      expect(event).toBe('load');
      order.push('remove');
      listeners.delete(listener);
    },
  });
  vi.stubGlobal('document', {
    open() { order.push('open'); listeners.clear(); },
    write(content: string) {
      order.push('write');
      expect(content).toBe(html);
      if (mode === 'write-throw') throw failure;
    },
    close() {
      order.push('close');
      if (mode === 'close-throw') throw failure;
      if (mode === 'sync-load') load();
    },
  });
  const evaluate = vi.fn(async (callback: (content: string) => unknown, content: string) => await callback(content));
  const browser = { evaluate } as unknown as Browser;
  return { start: () => nativeDocument(browser, html), load, order, listeners, failure, evaluate, html };
}

describe('native synthetic document load boundary', () => {
  it('arms after open and before write, and waits for load inside one evaluation', async () => {
    const fixture = documentFixture();
    let completed = false;
    const pending = fixture.start().then(() => { completed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.order).toEqual(['open', 'listen', 'write', 'close']);
    expect(completed).toBe(false);
    expect(fixture.evaluate).toHaveBeenCalledExactlyOnceWith(expect.any(Function), fixture.html);
    fixture.load();
    await pending;
    expect(completed).toBe(true);
    expect(fixture.listeners.size).toBe(0);
  });

  it('does not miss load fired synchronously by close', async () => {
    const fixture = documentFixture('sync-load');
    await expect(fixture.start()).resolves.toBeUndefined();
    expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(fixture.listeners.size).toBe(0);
  });

  it.each(['write-throw', 'close-throw'] as const)('preserves %s and removes the listener without retrying', async mode => {
    const fixture = documentFixture(mode);
    await expect(fixture.start()).rejects.toBe(fixture.failure);
    expect(fixture.order).toEqual(mode === 'write-throw'
      ? ['open', 'listen', 'write', 'remove']
      : ['open', 'listen', 'write', 'close', 'remove']);
    expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(fixture.listeners.size).toBe(0);
  });
});
