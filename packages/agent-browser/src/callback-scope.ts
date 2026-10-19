import { AsyncLocalStorage } from 'node:async_hooks';

type CallbackGuard = () => void;
const scopes = new AsyncLocalStorage<ReadonlyMap<object, CallbackGuard>>();

/** Bind callback continuations to the originating browser, independent of fixture creation. */
export function runCallbackScope<T>(owner: object, guard: CallbackGuard, callback: () => T): T {
  const current = new Map(scopes.getStore());
  current.set(owner, guard);
  return scopes.run(current, callback);
}

/** Called at the surface boundary so harness-created locator operations are covered too. */
export function guardCallbackScope(owner: object): void {
  scopes.getStore()?.get(owner)?.();
}
