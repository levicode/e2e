/** Test-only synchronous interception of the existing attempt-bound fixture facade. */
import { NativeSurface } from '../../src/native-surface.ts';
import type { NativeWebSurface } from '../../src/native/browser-contract.ts';

let active: { reentered: boolean } | undefined;

/** Restore the complete descriptor before returning, including every failure path. */
export function captureFixtureSurface<T>(create: () => T): { value: T; surface: NativeWebSurface } {
  if (active !== undefined) {
    active.reentered = true;
    throw new Error('Native fixture capture cannot be reentrant');
  }
  const prototype = NativeSurface.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'fixtureSurface');
  if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Native fixture facade method is unavailable');
  const original = descriptor.value as NativeSurface['fixtureSurface'];
  const state = { reentered: false };
  active = state;
  let surface: NativeWebSurface | undefined;
  let calls = 0;
  let invoking = false;
  try {
    Object.defineProperty(prototype, 'fixtureSurface', {
      ...descriptor,
      value: function (this: NativeSurface, ...args: Parameters<NativeSurface['fixtureSurface']>): NativeWebSurface {
        if (invoking) {
          state.reentered = true;
          throw new Error('Native fixture facade capture cannot be reentrant');
        }
        calls += 1;
        invoking = true;
        try {
          const result = Reflect.apply(original, this, args) as NativeWebSurface;
          surface = result;
          return result;
        } finally { invoking = false; }
      },
    });
    const value = create();
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof Reflect.get(value, 'then') === 'function') throw new Error('Native fixture capture must finish synchronously');
    if (state.reentered) throw new Error('Native fixture capture cannot be reentrant');
    if (calls !== 1 || surface === undefined) throw new Error(`Expected one native fixture facade, captured ${calls}`);
    return { value, surface };
  } finally {
    try { Object.defineProperty(prototype, 'fixtureSurface', descriptor); }
    finally { active = undefined; }
  }
}
