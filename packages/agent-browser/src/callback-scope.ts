import { AsyncLocalStorage } from 'node:async_hooks';
import { EngineError, type OperationContext } from 'e2e/engine';
import { beforeDispatch, bounded } from './budget.ts';

type CallbackGuard = () => void;
const scopes = new AsyncLocalStorage<ReadonlyMap<object, CallbackGuard>>();

/** Bind callback continuations to the originating browser, independent of fixture creation. */
export function runCallbackScope<T>(owner: object, guard: CallbackGuard, callback: () => T): T {
  const current = new Map(scopes.getStore());
  const inherited = current.get(owner);
  current.set(owner, inherited ? () => { inherited(); guard(); } : guard);
  return scopes.run(current, callback);
}

/** Retired or expired callbacks cannot acquire fresh fixture operations on the same browser. */
export function callbackLifetime(context: OperationContext): { guard(): void; retire(): void } {
  const budget = bounded(context);
  let active = true;
  return {
    guard() {
      if (!active) throw new EngineError('INVALID_STATE', 'The browser callback has finished or expired', { retryable: false });
      beforeDispatch(budget);
    },
    retire() { active = false; },
  };
}

/** Called at the surface boundary so harness-created locator operations are covered too. */
export function guardCallbackScope(owner: object): void {
  scopes.getStore()?.get(owner)?.();
}
