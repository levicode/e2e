import { EngineError } from 'e2e/engine';
import type { CdpTarget } from './cdp.ts';

export interface BrowserContexts {
  readonly browserContextIds: readonly string[];
  readonly defaultBrowserContextId?: string;
}

/** TargetInfo may expose the default context's concrete ID even when no incognito context exists. */
export function defaultContextIdentity(contexts: BrowserContexts, targets: readonly CdpTarget[]): string | undefined {
  const fail = (): never => { throw new EngineError('ENGINE_FAILURE', 'The default browser context could not be identified safely', { retryable: false }); };
  if (!Array.isArray(contexts.browserContextIds) || contexts.browserContextIds.some(id => typeof id !== 'string' || !id)) return fail();
  if (contexts.defaultBrowserContextId !== undefined) {
    if (typeof contexts.defaultBrowserContextId !== 'string' || !contexts.defaultBrowserContextId || contexts.browserContextIds.includes(contexts.defaultBrowserContextId)) return fail();
    return contexts.defaultBrowserContextId;
  }
  // Target.getBrowserContexts enumerates all created contexts, explicitly excluding default.
  // A single remaining page-context identity is therefore the default, never an arbitrary page.
  const candidates = new Set(targets.filter(target => target.type === 'page' && (target.browserContextId === undefined || !contexts.browserContextIds.includes(target.browserContextId))).map(target => target.browserContextId));
  if (candidates.size > 1 || candidates.has('')) return fail();
  return candidates.values().next().value;
}
