/** Genuine Playwright objects on the existing native-owned Chromium transport.
 * No browser launch, engine fallback, private Playwright fields, or URL selection.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { EngineError, type OperationContext } from 'e2e/engine';
import type { ScopeCreationOptions } from './engine-contract.ts';

export interface PlaywrightBinding {
  readonly kind: 'isolated' | 'persistent';
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly contextId: string;
  readonly targetId: string;
}
function invalid(detail: string): never {
  throw new EngineError('ENGINE_FAILURE', `Native Playwright binding failed: ${detail}`, { retryable: false });
}
function check(operation: OperationContext): void {
  if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native Playwright binding was cancelled', { retryable: false });
  if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native Playwright binding exhausted its original deadline', { retryable: false });
}
/** The caller snapshots one original deadline and exposes decreasing timeoutMs. */
export async function connectPlaywrightClient(endpoint: string, operation: OperationContext, headers?: Readonly<Record<string, string>>): Promise<Browser> {
  check(operation);
  // noDefaults protects a borrowed host's default context. Explicit newContext
  // options below still apply to our isolated context only.
  const browser = await chromium.connectOverCDP(endpoint, {
    timeout: operation.timeoutMs, noDefaults: true,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
  });
  try { check(operation); return browser; }
  catch (error) { await browser.close(); throw error; }
}
async function identity(page: Page, operation: OperationContext): Promise<{ contextId: string; targetId: string }> {
  check(operation);
  const session = await page.context().newCDPSession(page);
  try {
    check(operation);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    check(operation);
    if (targetInfo.type !== 'page' || targetInfo.subtype !== undefined || !targetInfo.targetId || !targetInfo.browserContextId) invalid('the Page has no exact context/target identity');
    return { contextId: targetInfo.browserContextId, targetId: targetInfo.targetId };
  } finally { await session.detach(); }
}
/** One actual PW context and one reserved own blank Page. User scripts are not
 * registered until native adoption and harness network policy have settled, so
 * no configured script can navigate/fetch before native ownership is ready.
 * The owning attempt retains this entire promise through cancellation/cleanup.
 */
export async function createPlaywrightContext(browser: Browser, options: ScopeCreationOptions, operation: OperationContext): Promise<PlaywrightBinding> {
  check(operation);
  const context = await browser.newContext({
    viewport: options.viewport,
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId }),
    ...(options.media.colorScheme === undefined ? {} : { colorScheme: options.media.colorScheme }),
    ...(options.media.reducedMotion === undefined ? {} : { reducedMotion: options.media.reducedMotion }),
    serviceWorkers: options.blockServiceWorkers ? 'block' : 'allow',
  });
  try {
    check(operation);
    const page = await context.newPage();
    check(operation);
    const ids = await identity(page, operation);
    if (page.context() !== context || page.url() !== 'about:blank') invalid('the reserved own Page changed before adoption');
    return { kind: 'isolated', browser, context, page, ...ids };
  } catch (error) {
    // This function has not dispatched adoption; its own exact context is still
    // bridge-owned. Never close a sibling/default context or the remote browser.
    await context.close();
    throw error;
  }
}
/** Persistent recovery binds the same dedicated default context and exact Page.
 * It never substitutes a newly-created incognito context or another same-URL tab.
 */
export async function bindPersistentPlaywrightContext(browser: Browser, expected: { readonly contextId: string; readonly targetId: string }, operation: OperationContext): Promise<PlaywrightBinding> {
  check(operation);
  const session = await browser.newBrowserCDPSession();
  try {
    const inventory = await session.send('Target.getBrowserContexts');
    check(operation);
    if (inventory.browserContextIds.length !== 0 || inventory.defaultBrowserContextId !== expected.contextId) invalid('the dedicated default context identity changed');
  } finally { await session.detach(); }
  const contexts = browser.contexts();
  if (contexts.length !== 1) invalid('the dedicated default context is not unique');
  const context = contexts[0]!;
  for (const page of context.pages()) {
    const ids = await identity(page, operation);
    if (ids.targetId !== expected.targetId) continue;
    if (ids.contextId !== expected.contextId) invalid('the exact target belongs to a different context');
    return { kind: 'persistent', browser, context, page, ...ids };
  }
  return invalid('the original persistent Page no longer exists');
}
/** Raw CDP-client close destroys PW-created isolated contexts (disposeOnDetach),
 * but does not destroy a borrowed default context. Never infer one from the other.
 */
export function disconnectedBindingMode(binding: PlaywrightBinding): 'isolated-context-lost' | 'persistent-rebind' | undefined {
  if (binding.browser.isConnected()) return undefined;
  return binding.kind === 'persistent' ? 'persistent-rebind' : 'isolated-context-lost';
}
