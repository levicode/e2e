/** Genuine Playwright objects on the existing native-owned Chromium transport.
 * No browser launch, engine fallback, private Playwright fields, or URL selection.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { EngineError, type OperationContext } from 'e2e/engine';
import type { ScopeCreationOptions } from './engine-contract.ts';
import { connectionDeadline, connectionWaitDeparture } from '../operation-budget.ts';

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
  if (operation.signal.aborted) throw connectionWaitDeparture(operation.signal, 'Native Playwright binding');
  if (operation.timeoutMs <= 0) throw connectionDeadline('Native Playwright binding exhausted its original deadline');
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
// Native owns the dialog decision, including its no-handler dismissal/error.
// PW otherwise automatically dismisses a dialog with no PW subscribers. This
// observer prevents that competing default; it never answers, wraps a Dialog,
// replaces a method, or removes another consumer's listener. As with the legacy
// harness router, independent deciding handlers on both surfaces are unsupported.
const dialogObservers = new WeakMap<BrowserContext | Page, () => void>();
function observeNativeDialogs(owner: BrowserContext | Page, browser: Browser): () => void {
  // A late identity continuation must not subscribe after its retirement event.
  if (!browser.isConnected() || owner.isClosed()) invalid('the dialog owner retired before subscription');
  const existing = dialogObservers.get(owner);
  if (existing !== undefined) return existing;
  const observe = () => {};
  // Both public owner types expose this lifecycle event with different payloads.
  const lifecycle: { on(event: 'close', listener: () => void): unknown; off(event: 'close', listener: () => void): unknown } = owner;
  let disposed = false;
  const retired = () => {
    if (disposed) return;
    disposed = true;
    owner.off('dialog', observe);
    lifecycle.off('close', retired);
    browser.off('disconnected', retired);
    dialogObservers.delete(owner);
  };
  dialogObservers.set(owner, retired);
  owner.on('dialog', observe);
  lifecycle.on('close', retired);
  browser.on('disconnected', retired);
  return retired;
}
interface PageIdentity { readonly contextId: string; readonly targetId: string }
type IdentifiedPage = (ids: PageIdentity) => void;
async function identity(page: Page, operation: OperationContext, candidate?: false, persistent?: boolean, identified?: IdentifiedPage): Promise<PageIdentity>;
async function identity(page: Page, operation: OperationContext, candidate: true, persistent?: false, identified?: IdentifiedPage): Promise<PageIdentity | undefined>;
async function identity(page: Page, operation: OperationContext, candidate = false, persistent = false, identified?: IdentifiedPage): Promise<PageIdentity | undefined> {
  check(operation);
  const session = await page.context().newCDPSession(page).catch(cause => {
    // A candidate can disappear before we acquire any session. This is not
    // permission to ignore cleanup of a session that was actually returned.
    if (candidate && page.isClosed()) return undefined;
    throw cause;
  });
  if (session === undefined) return undefined;
  // Only this exact acquired session's public close event proves its detach
  // authority already retired. Page/browser closure alone is insufficient.
  let sessionClosed = false;
  const closed = () => { sessionClosed = true; };
  if (candidate || persistent) session.on('close', closed);
  try {
    check(operation);
    const result = await session.send('Target.getTargetInfo').catch(cause => {
      if (candidate && page.isClosed()) return undefined;
      throw cause;
    });
    if (result === undefined) return undefined;
    check(operation);
    const { targetInfo } = result;
    if (targetInfo.type !== 'page' || targetInfo.subtype !== undefined || !targetInfo.targetId || !targetInfo.browserContextId) invalid('the Page has no exact context/target identity');
    const ids = { contextId: targetInfo.browserContextId, targetId: targetInfo.targetId };
    identified?.(ids);
    return ids;
  } finally {
    try {
      // Do not issue a second release after the exact session closed. Once
      // detach is dispatched, its actual rejection survives any later close.
      if (!sessionClosed) await session.detach();
    } finally { if (candidate || persistent) session.off('close', closed); }
  }
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
  let disposeDialogs: (() => void) | undefined;
  try {
    // This context is exclusively ours. Subscribe before the first Page exists,
    // so first-document scripts and owned popups have no PW default dismissor.
    // newPage's public receipt also orders the PW subscription before adoption.
    disposeDialogs = observeNativeDialogs(context, browser);
    check(operation);
    const page = await context.newPage();
    check(operation);
    const ids = await identity(page, operation);
    if (page.context() !== context || page.url() !== 'about:blank') invalid('the reserved own Page changed before adoption');
    return { kind: 'isolated', browser, context, page, ...ids };
  } catch (error) {
    // This function has not dispatched adoption; its own exact context is still
    // bridge-owned. Never close a sibling/default context or the remote browser.
    // Release the subscription independently of close-event delivery, even
    // when the owned close is already settled or reports a real failure.
    try { await context.close(); } finally { disposeDialogs?.(); }
    throw error;
  }
}
/** Persistent recovery binds the same dedicated default context and exact Page.
 * It never substitutes a newly-created incognito context or another same-URL tab.
 */
export async function bindPersistentPlaywrightContext(browser: Browser, expected: { readonly contextId: string; readonly targetId: string }, operation: OperationContext): Promise<PlaywrightBinding> {
  check(operation);
  const session = await browser.newBrowserCDPSession();
  let sessionClosed = false;
  const closed = () => { sessionClosed = true; };
  session.on('close', closed);
  try {
    const inventory = await session.send('Target.getBrowserContexts');
    check(operation);
    if (inventory.browserContextIds.length !== 0 || inventory.defaultBrowserContextId !== expected.contextId) invalid('the dedicated default context identity changed');
  } finally {
    // Exact session retirement, not browser.isConnected(), proves no second
    // detach is needed. A detach already dispatched must still settle itself.
    try { if (!sessionClosed) await session.detach(); }
    finally { session.off('close', closed); }
  }
  // A successful detach may settle after this publication's deadline/retirement.
  // Do not reinterpret the resulting empty client inventory as identity failure.
  check(operation);
  const contexts = browser.contexts();
  if (contexts.length !== 1) invalid('the dedicated default context is not unique');
  const context = contexts[0]!;
  for (const page of context.pages()) {
    const ids = await identity(page, operation, false, true, identified => {
      if (identified.targetId !== expected.targetId) return;
      if (identified.contextId !== expected.contextId) invalid('the exact target belongs to a different context');
      // Never subscribe on a borrowed Context: unrelated host Pages retain
      // their original PW behavior. The already-owned identity detach below
      // is a public PW receipt after subscription, before native navigation.
      observeNativeDialogs(page, browser);
    });
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

/** Bind a native-created replacement inside an already-known real PW context.
 * A separate CDP client's target event may lag native publication. Subscribe
 * before taking the snapshot, and select only the exact native target identity.
 * This promise owns any in-flight identity session until its detach settles;
 * callers must retain it when their own wait departs.
 */
export async function bindExistingPlaywrightPage(binding: PlaywrightBinding, expected: { readonly contextId: string; readonly targetId: string }, operation: OperationContext): Promise<PlaywrightBinding> {
  check(operation);
  if (expected.contextId !== binding.contextId || expected.targetId.length === 0) invalid('replacement changed its exact context');
  const { browser, context } = binding;
  const deadline = performance.now() + operation.timeoutMs;
  let expired = false;
  const current: OperationContext = { ...operation, get timeoutMs() { return expired ? 0 : Math.max(0, deadline - performance.now()); } };
  const pending: Page[] = [];
  const seen = new Set<Page>();
  let wake: (() => void) | undefined;
  let closed = false;
  const changed = () => { const notify = wake; wake = undefined; notify?.(); };
  const enqueue = (page: Page) => {
    if (!seen.has(page)) { seen.add(page); pending.push(page); }
    changed();
  };
  const retired = () => { closed = true; changed(); };
  context.on('page', enqueue);
  context.on('close', retired);
  browser.on('disconnected', retired);
  operation.signal.addEventListener('abort', changed);
  const expiry = setTimeout(() => { expired = true; changed(); }, Math.ceil(current.timeoutMs));
  try {
    for (const page of context.pages()) enqueue(page);
    for (;;) {
      check(current);
      if (closed || !browser.isConnected()) invalid('replacement context disconnected before binding');
      const page = pending.shift();
      if (page === undefined) {
        await new Promise<void>(resolve => { wake = resolve; });
        continue;
      }
      if (page.isClosed()) continue;
      const ids = await identity(page, current, true, false, identified => {
        if (binding.kind !== 'persistent' || identified.targetId !== expected.targetId) return;
        if (identified.contextId !== expected.contextId || page.context() !== context || page.isClosed()) invalid('the replacement target changed ownership');
        observeNativeDialogs(page, browser);
      });
      check(current);
      if (ids === undefined || ids.targetId !== expected.targetId) continue;
      if (ids.contextId !== expected.contextId || page.context() !== context || page.isClosed()) invalid('the replacement target changed ownership');
      return { ...binding, page, ...ids };
    }
  } finally {
    clearTimeout(expiry);
    operation.signal.removeEventListener('abort', changed);
    context.off('page', enqueue);
    context.off('close', retired);
    browser.off('disconnected', retired);
  }
}
