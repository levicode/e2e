import { afterEach, describe, expect, it } from 'vitest';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { captureFixtureSurface } from '../helpers/capture-fixture-surface.ts';

const descriptor = Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')!;
const facade = { identityScope: 'captured-attempt' } as NativeWebSurface;
afterEach(() => { Object.defineProperty(NativeSurface.prototype, 'fixtureSurface', descriptor); });

/** No browser, client or lifecycle is started by these descriptor-only tests. */
function method(value: (...args: unknown[]) => NativeWebSurface, flags = {}) {
  Object.defineProperty(NativeSurface.prototype, 'fixtureSurface', { ...descriptor, ...flags, value });
  return Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')!;
}

describe('synchronous native fixture facade capture', () => {
  it('forwards exact this/arguments, captures the returned facade and restores every descriptor field', () => {
    const receiver = new NativeSurface({});
    const args = [{ witness: true }, 'extra-test-argument'];
    const seenThis: { value?: unknown } = {};
    let seenArgs: unknown[] = [];
    const before = method(function (this: unknown, ...actual) { seenThis.value = this; seenArgs = actual; return facade; }, { enumerable: true, writable: false });
    const graph = { browser: 'synthetic-graph-witness' };
    const captured = captureFixtureSurface(() => {
      expect(Reflect.apply(receiver.fixtureSurface, receiver, args)).toBe(facade);
      return graph;
    });
    expect(captured).toEqual({ value: graph, surface: facade });
    expect(captured.surface).toBe(facade);
    expect(seenThis.value).toBe(receiver);
    expect(seenArgs).toEqual(args);
    expect(seenArgs[0]).toBe(args[0]);
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
  });

  it.each([0, 2])('rejects %i facade captures and restores the descriptor', count => {
    const before = method(() => facade);
    expect(() => captureFixtureSurface(() => {
      const receiver = new NativeSurface({});
      for (let index = 0; index < count; index += 1) receiver.fixtureSurface();
    })).toThrow(`captured ${count}`);
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
  });

  it.each(['graph', 'original'] as const)('restores the descriptor when the %s throws', source => {
    const failure = new Error('creation failed');
    const before = method(() => { if (source === 'original') throw failure; return facade; });
    expect(() => captureFixtureSurface(() => { new NativeSurface({}).fixtureSurface(); throw failure; })).toThrow(failure);
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
    if (source === 'graph') expect(captureFixtureSurface(() => new NativeSurface({}).fixtureSurface()).surface).toBe(facade);
  });

  it('rejects a nested capture even when its error was caught by graph creation', () => {
    const before = method(() => facade);
    expect(() => captureFixtureSurface(() => {
      expect(() => captureFixtureSurface(() => undefined)).toThrow('reentrant');
      new NativeSurface({}).fixtureSurface();
    })).toThrow('reentrant');
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
    expect(captureFixtureSurface(() => new NativeSurface({}).fixtureSurface()).surface).toBe(facade);
  });

  it('rejects reentrant facade calls even when the original method caught the error', () => {
    const before = method(function (this: NativeSurface) {
      expect(() => this.fixtureSurface()).toThrow('reentrant');
      return facade;
    });
    expect(() => captureFixtureSurface(() => new NativeSurface({}).fixtureSurface())).toThrow('reentrant');
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
  });

  it('never leaves the wrapper installed across a returned promise', async () => {
    const before = method(() => facade);
    let resumed = false;
    const pending = Promise.resolve().then(() => {
      resumed = true;
      expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
    });
    expect(() => captureFixtureSurface(() => { new NativeSurface({}).fixtureSurface(); return pending; })).toThrow('synchronously');
    expect(resumed).toBe(false);
    expect(Object.getOwnPropertyDescriptor(NativeSurface.prototype, 'fixtureSurface')).toEqual(before);
    await pending;
  });
});
