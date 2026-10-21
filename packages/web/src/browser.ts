/**
 * The `browser` fixture: the browser-shaped deterministic surface this engine
 * contributes. It lives here, not in core, because the harness knows the
 * engine contract and never a platform's fixture shape. Every async method
 * runs as a harness-recorded `browser.<method>` step; `expect(browser)` reaches the
 * matchers attached through `context.expectable`.
 *
 * Validation (`resolveUrl`, JSON checks, cookie URLs, and callback contracts)
 * stays here; the native surface owns transport decoding and error classification. The URL rule is
 * never re-implemented here: `context.app.resolveUrl` is the one place that
 * says which URLs a test may open.
 */

import { isRejectedDecision } from './native/decision-outcome.ts';
import { controllerKey } from './native/keyboard-contract.ts';
import { createHash } from 'node:crypto';
import { open as openFile, readFile, unlink } from 'node:fs/promises';
import { lookup as lookupMime } from 'mime-types';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap, NativeHeader, NativeWebSurface, NativeDecisionBody } from './native/browser-contract.ts';
import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch } from 'e2e';
import {
  ConfigurationError,
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  obj,
  pollCondition,
  raceAbort,
  rejectUnknownOptions,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  withTimeout,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
  type OperationContext,
  type TextPattern,
} from 'e2e/engine';
import type { DialogHandler } from './dialog-types.ts';
import { isClassified, isTestErrorCode, message as causeMessage } from './runtime-support.ts';
import { compileEvaluation, pageFunctionSource } from './evaluation.ts';
import { initScriptLabel, testInitScriptSource } from './init-scripts.ts';
import { MEDIA_KEYS, mediaLabel, mediaProblem, type WebMedia } from './media.ts';
import { lowercaseNames } from './protected-app.ts';
import { parseContinue, parseFulfill, requireNoArguments } from './route-options.ts';
import { routePatternMatches, routePatternsEqual } from './route-pattern.ts';

/**
 * One of `json`, `body`, or `path`, or none for an empty body. `path` names a
 * file relative to the project root; its `Content-Type` follows its
 * extension unless `contentType` or a `content-type` header sets one.
 */
export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** Sets the `Content-Type` response header. */
  contentType?: string;
} & (
  | { json: JsonValue; body?: never; path?: never }
  | { body: string; json?: never; path?: never }
  | { path: string; json?: never; body?: never }
  | { body?: never; json?: never; path?: never }
);

/** What `continue` changes about the request before it goes to the network. */
export interface RouteContinueOverrides {
  /** Resolved against the base URL like `goto`; must keep the request's scheme. */
  url?: string;
  /** Request method. */
  method?: string;
  /** Replaces every request header; the configured `headers` for the app's site are added on top. */
  headers?: Record<string, string>;
  /** Request body. */
  postData?: string;
}

export interface WebRoute {
  /** The intercepted request. */
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
  /** Fulfills the intercepted request once. */
  fulfill(response: RouteFulfillResponse): Promise<void>;
  /** Sends the intercepted request to the network once, skipping every other route. */
  continue(overrides?: RouteContinueOverrides): Promise<void>;
  /** Hands the intercepted request to the route registered before this one, or the network when none matches. */
  fallback(): Promise<void>;
  /** Aborts the intercepted request once. */
  abort(): Promise<void>;
}

export interface WebResponse {
  /** Response URL. */
  readonly url: string;
  /** HTTP status. */
  readonly status: number;
  /** Response headers, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Waits for the body and parses it as JSON; rejects with `ACTION_FAILED` when the body could not be read. */
  json<T = unknown>(): Promise<T>;
  /** Waits for the body and reads it as text; rejects with `ACTION_FAILED` when the body could not be read. */
  text(): Promise<string>;
}

export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

export interface BrowserExpectation {
  /** Inverts the matcher. */
  readonly not: BrowserExpectation;
  /** Waits for the current URL to match; `ignoreCase` compares a string case-insensitively and adds the `i` flag to a RegExp, `false` removes it. */
  toHaveURL(expected: string | RegExp, options?: { ignoreCase?: boolean; timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the target's `class` attribute to match: a string is the whole normalized class list, a RegExp is tested against it. */
  toHaveClass(target: Locator, expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

/**
 * The screen scope `browser.frameLocator` returns. Every `Screen` query answers
 * from inside the frame, and because the frame's document is resolved natively,
 * the web-only selectors follow it in: `locator` for a CSS or XPath
 * selector on a control with no accessible name, `frameLocator` for a frame
 * nested inside this one.
 */
export interface FrameScreen extends Screen {
  /** Creates a web-only CSS or XPath locator inside this frame. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside an iframe nested in this frame. */
  frameLocator(selector: string): FrameScreen;
}

/**
 * The browser the attempt drives, showing one active tab. Navigation, reads,
 * `locator`, `frameLocator`, `evaluate`, `waitForResponse`, `waitForDownload`,
 * the keyboard and mouse, `expect(browser)`, and `screen` act on the active
 * tab; cookies, routes, and dialog handlers cover the whole browser, every
 * tab included. A tab the app opens itself (a `target="_blank"` link,
 * `window.open`) is not followed: the active tab stays the one the attempt
 * opened.
 */
export interface Browser extends Expectable<BrowserExpectation> {
  /** Navigates to an allowed URL. */
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<void>;
  /** Reloads the current document. */
  reload(options?: ActionOptions): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: ActionOptions): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: ActionOptions): Promise<void>;
  /** Returns the current URL. */
  url(): Promise<string>;
  /** Returns the current title. */
  title(): Promise<string>;
  /** Waits for the current URL to match. */
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Creates a web-only CSS or XPath locator. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside one iframe. */
  frameLocator(selector: string): FrameScreen;
  /** Evaluates trusted test code in the page: a function, or a string expression whose value is returned, called first if it is a function. */
  evaluate<T extends JsonValue>(fn: string | (() => T | Promise<T>)): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
  /**
   * Adds a script every document runs before the page's own, from the next
   * navigation on: JavaScript source, a `{ path }` relative to the project
   * root, or a function.
   */
  addInitScript(script: string | { path: string } | (() => unknown)): Promise<void>;
  /** Adds an init script function called with one JSON argument. */
  addInitScript<Arg extends JsonValue>(script: (arg: Arg) => unknown, arg: Arg): Promise<void>;
  /** Adds an attempt-scoped network route. */
  route(
    pattern: string | RegExp,
    handler: (route: WebRoute) => void | Promise<void>,
  ): Promise<void>;
  /** Removes matching attempt-scoped routes. */
  unroute(pattern: string | RegExp): Promise<void>;
  /** Removes all routes registered by this browser fixture, preserving configured site headers. */
  unrouteAll(): Promise<void>;
  /** Waits for a matching response. */
  waitForResponse(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<WebResponse>;
  /** Returns cookies visible to the current context. */
  cookies(): Promise<Cookie[]>;
  /** Sets cookies after URL validation. */
  setCookies(cookies: readonly Cookie[]): Promise<void>;
  /** Sets the viewport size. */
  setViewport(size: { width: number; height: number }): Promise<void>;
  /**
   * Emulates CSS media features on every open tab and every tab opened after
   * them, the app's own included, for the rest of the attempt, as Playwright's
   * `page.emulateMedia` does: the page's `@media` rules and `matchMedia` both
   * read them. A feature left out keeps its value. Works before the first
   * navigation, so the page loads with them.
   */
  emulateMedia(media: WebMedia): Promise<void>;
  /** Registers an attempt-scoped dialog handler and returns an unsubscribe function. */
  onDialog(handler: DialogHandler): Promise<() => Promise<void>>;
  /** Runs a trigger and waits for its download. */
  waitForDownload(
    trigger: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<{ path: string; absolutePath: string; suggestedFilename: string }>;
  /** Viewport-level keyboard, for whatever has focus. */
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Holds one key until up; repeated down calls send a repeat event. */
    down(key: string): Promise<void>;
    /** Releases a held key. */
    up(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
  /**
   * Direct pointer input from test code, independent of agent observations.
   * After CDP recovery, test code can read current geometry with `evaluate`
   * before starting a pointer sequence.
   */
  readonly mouse: {
    /** Moves the pointer. */
    move(x: number, y: number): Promise<void>;
    /** Scrolls the pointer wheel. */
    wheel(deltaX: number, deltaY: number): Promise<void>;
    /** Presses the primary pointer button. */
    down(): Promise<void>;
    /** Releases the primary pointer button. */
    up(): Promise<void>;
  };
}

interface StoredRoute {
  readonly id: string;
  readonly pattern: TextPattern;
  readonly handler: (route: WebRoute) => void | Promise<void>;
}

/** Builds the public fixture over validated native commands and scope-bound events. */
export function createBrowserFixture(surface: NativeWebSurface, context: EngineFixtureContext): Browser {
  const responseBodies = new WeakMap<BrowserEventMap['network.response'], Promise<string>>();
  const snapshots = new Map<number, readonly StoredRoute[]>();
  const chains = new Map<string, { version: number; handlers: readonly StoredRoute[]; next: number }>();
  let routes: readonly StoredRoute[] = [];
  let nextRoute = 0;
  let registryTail: Promise<void> = Promise.resolve();
  const dialogs: { handler: DialogHandler }[] = [];
  snapshots.set(surface.routeRegistryVersion(), []);

  const command = <K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation = context.operation()) => {
    surface.latch.throwPending();
    return surface.command(name, args, operation);
  };
  const baseHref = (): string => context.app.resolveUrl('');
  const deadlineFor = (timeout: number | undefined): Deadline => new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs);
  const currentUrl = async (deadline?: Deadline) => (await command('page.url', {}, context.operation(deadline?.remaining()))).url;
  const currentTitle = async (deadline?: Deadline) => (await command('page.title', {}, context.operation(deadline?.remaining()))).title;
  const expectation = createBrowserExpectation({ currentUrl, currentTitle, baseHref, deadlineFor, context });

  /** Serialize atomic registration snapshots without holding a browser action lease. */
  const updateRoutes = (change: (current: readonly StoredRoute[]) => readonly StoredRoute[]): Promise<void> => {
    const work = registryTail.then(async () => {
      const next = change(routes);
      const nextVersion = surface.allocateRouteRegistryVersion();
      snapshots.set(nextVersion, next);
      await command('network.routes.replace', { version: nextVersion, registrationIds: next.map(route => route.id) });
      routes = next;
    });
    registryTail = work.catch(() => undefined);
    return work;
  };

  /** A fallback keeps the original matching list while native rotates the resource token. */
  const handleRequest = async (event: BrowserEventMap['network.request']): Promise<void> => {
    let selected = false;
    const operation = context.operation(event.timeoutMs);
    const deadline = new Deadline(operation.timeoutMs);
    const decide = async (decision: BrowserDecision): Promise<void> => {
      assertSurfaceScope(surface, event.identityScope);
      if (selected) throw new TestError('ACTION_FAILED', 'route handler already decided');
      selected = true;
      if (decision.kind !== 'fallback') chains.delete(event.token);
      await surface.decide(event.token, decision, { ...operation, timeoutMs: deadline.remaining() });
    };
    try {
      const snapshot = snapshots.get(event.version);
      if (snapshot === undefined || event.registrationIds.length !== snapshot.length || event.registrationIds.some((id, index) => id !== snapshot[index]?.id)) throw invalidateScope(surface, event.identityScope);
      let chain = event.fallbackOf === undefined ? undefined : chains.get(event.fallbackOf);
      if (event.fallbackOf !== undefined) {
        chains.delete(event.fallbackOf);
        if (chain === undefined || chain.version !== event.version) throw new TestError('INVALID_STATE', 'native fallback has no captured route chain');
      } else {
        chain = { version: event.version, next: 0, handlers: snapshot.filter(route => routePatternMatches(route.pattern, event.request.url)).toReversed() };
      }
      if (chain === undefined) throw new TestError('INVALID_STATE', 'native request has no route chain');
      chains.set(event.token, chain);
      const stored = chain.handlers[chain.next++];
      let postData = event.request.postData;
      if (event.request.postDataBase64 !== undefined) postData = Buffer.from(event.request.postDataBase64, 'base64').toString('utf8');
      if (event.request.postDataHandle !== undefined) {
        // Native owns this read-only alias through the terminal request decision.
        const chunks: Buffer[] = [];
        await readNativeChunks(surface, 'network.body.read', event.request.postDataHandle, { ...operation, timeoutMs: deadline.remaining() }, bytes => { chunks.push(bytes); }, event.identityScope);
        postData = Buffer.concat(chunks).toString('utf8');
      }
      const request = {
        url: event.request.url, method: event.request.method, headers: { ...event.request.headers },
        ...(postData === undefined ? {} : { postData }),
      };
      if (stored === undefined) {
        const site = surface.siteHeaders(request.url);
        await decide({ kind: 'continue', overrides: site === undefined ? {} : { headers: headerPairs({ ...lowercaseNames(request.headers), ...site }) } });
        return;
      }
      const route: WebRoute = {
        request,
        fulfill: async response => {
          const parsed = parseFulfill(response, file => surface.projectPath(file));
          const body = parsed.path !== undefined ? await readFile(parsed.path)
            : Buffer.from(parsed.json !== undefined ? JSON.stringify(parsed.json) : parsed.body ?? '');
          const headers = { ...lowercaseNames(parsed.headers) };
          const contentType = parsed.contentType ?? (parsed.json !== undefined ? 'application/json' : parsed.path === undefined ? undefined : lookupMime(parsed.path) || 'application/octet-stream');
          if (contentType !== undefined) headers['content-type'] = contentType;
          await withDecisionBody(surface, body, operation, payload => decide({ kind: 'fulfill', status: parsed.status, headers: headerPairs(headers), ...payload }), event.identityScope);
        },
        continue: async overrides => {
          const parsed = parseContinue(overrides, request.url, context.app.resolveUrl);
          const site = surface.siteHeaders(parsed.url ?? request.url);
          const headers = parsed.headers === undefined && site === undefined ? undefined : headerPairs({ ...lowercaseNames(parsed.headers ?? request.headers), ...site });
          const continueWith = (payload: NativeDecisionBody | { bodyBase64?: never; bodyHandle?: never }): Promise<void> => decide({ kind: 'continue', overrides: {
            ...(parsed.url === undefined ? {} : { url: parsed.url }),
            ...(parsed.method === undefined ? {} : { method: parsed.method }),
            ...(headers === undefined ? {} : { headers }),
            ...payload,
          } });
          if (parsed.postData === undefined) await continueWith({});
          else await withDecisionBody(surface, Buffer.from(parsed.postData), operation, continueWith, event.identityScope);
        },
        fallback: async (...args: unknown[]) => { requireNoArguments('route.fallback', args); await decide({ kind: 'fallback', overrides: {} }); },
        abort: async (...args: unknown[]) => { requireNoArguments('route.abort', args); await decide({ kind: 'abort' }); },
      };
      await raceAbort(withTimeout(Promise.resolve().then(() => stored.handler(route)), deadline.remaining(),
        () => new TestError('ACTION_FAILED', 'route handler exceeded its decision deadline')), operation.signal, 'route handler');
      if (!selected) throw new TestError('ACTION_FAILED', 'route handler returned without calling fulfill, continue, fallback, or abort');
    } catch (cause) {
      chains.delete(event.token);
      surface.latchCallbackFailure(event.identityScope, cause instanceof Error ? cause : new TestError('ACTION_FAILED', `route handler failed: ${causeMessage(cause)}`));
      if (!surfaceScopeActive(surface, event.identityScope)) return;
      if (!selected) await surface.decide(event.token, { kind: 'abort' }, operation).catch(() => undefined);
    }
  };

  surface.subscribe('network.request', event => {
      const work = handleRequest(event);
      surface.latch.track('route', work);
      return work;
  });
  surface.subscribe('registry-released', event => {
      snapshots.delete(event.registryVersion);
      for (const [token, chain] of chains) if (chain.version === event.registryVersion) chains.delete(token);
  });
  surface.subscribe('dialog.opened', async event => {
      const operation = context.operation(event.timeoutMs);
      let selected = false;
      let answerWork: Promise<void> | undefined;
      const answer = (accept: boolean, text?: string): Promise<void> => {
        assertSurfaceScope(surface, event.identityScope);
        if (selected) throw new TestError('INVALID_STATE', 'dialog handler already decided');
        selected = true;
        answerWork = surface.decide(event.token, { kind: 'dialog', accept, ...(text === undefined ? {} : { promptText: text }) }, operation).catch(cause => {
          if (isRejectedDecision(cause)) selected = false;
          throw cause;
        });
        void answerWork.catch(() => undefined);
        return answerWork;
      };
      const work = (async () => {
        try {
          const handler = dialogs.at(-1)?.handler;
          if (handler === undefined) throw new TestError('INVALID_STATE', `unhandled ${event.type} dialog: ${event.message}`);
          if (handler === 'accept') await answer(true);
          else if (handler === 'dismiss') await answer(false);
          else await raceAbort(withTimeout(Promise.resolve().then(() => handler({ type: event.type, message: event.message, accept: text => answer(true, text), dismiss: () => answer(false) })), operation.timeoutMs,
            () => new TestError('ACTION_FAILED', 'dialog handler exceeded its decision deadline')), operation.signal, 'dialog handler');
          await answerWork;
          if (!selected) throw new TestError('INVALID_STATE', `dialog handler returned without calling accept or dismiss for ${event.type} dialog: ${event.message}`);
        } catch (cause) {
          surface.latchCallbackFailure(event.identityScope, isClassified(cause) ? cause : new EngineError('ENGINE_FAILURE', `dialog handler failed: ${causeMessage(cause)}`, { retryable: false, cause }));
          // An unawaited answer may still be settling when its handler throws.
          // Preserve that primary failure, but never compete with an uncertain accept.
          await answerWork?.catch(() => undefined);
          if (!surfaceScopeActive(surface, event.identityScope)) return;
          if (!selected) await surface.decide(event.token, { kind: 'dialog', accept: false }, operation).catch(() => undefined);
        }
      })();
      surface.latch.track('dialog', work);
      await work;
  });

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto: async (url, options) => { await command('page.navigate', { url: context.app.resolveUrl(url), waitUntil: options?.waitUntil ?? 'load' }, context.operation(options?.timeout ?? context.timeouts.test)); },
    reload: async options => { await command('page.reload', {}, context.operation(options?.timeout ?? context.timeouts.test)); },
    back: async options => { await command('page.back', {}, context.operation(options?.timeout ?? context.timeouts.test)); },
    forward: async options => { await command('page.forward', {}, context.operation(options?.timeout ?? context.timeouts.test)); },
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL: (url, options) => { rejectUnknownOptions('browser.waitForURL', options, ['timeout']); return expectation.toHaveURL(url, options); },
    locator: selector => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: selector => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    async evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      const source = typeof fn === 'string' ? fn : pageFunctionSource(fn);
      validateJsonValue(arg, 'evaluate argument');
      const evaluate = compileEvaluation(source, arg !== undefined);
      const { value } = await command('page.evaluate', { source: evaluate.toString(), argument: arg ?? null });
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw surface.invalidate();
      const envelope = value as { readonly [key: string]: JsonValue };
      if (typeof envelope['ok'] !== 'boolean') throw surface.invalidate();
      if (!envelope['ok']) {
        if (typeof envelope['message'] !== 'string') throw surface.invalidate();
        throw new TestError('EVALUATE_FAILED', envelope['message']);
      }
      const result = envelope['value'];
      validateJsonValue(result, 'evaluate result');
      return result as T;
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, file => surface.projectPath(file));
      await command('context.init-script', { source });
    },
    route(pattern, handler) {
      const wirePattern = toTextPattern(pattern);
      const stored = { id: `route-${++nextRoute}`, pattern: wirePattern, handler };
      return updateRoutes(current => [...current, stored]);
    },
    unroute(pattern) { const wirePattern = toTextPattern(pattern); return updateRoutes(current => current.filter(route => !routePatternsEqual(route.pattern, wirePattern))); },
    unrouteAll: () => updateRoutes(() => []),
    async waitForResponse(pattern, options) {
      const wirePattern = toTextPattern(pattern);
      const operation = context.operation(options?.timeout);
      const scope = surface.identityScope;
      const waiter = waitNativeEvent(surface, 'network.response', event => event.activePage && routePatternMatches(wirePattern, event.url), operation, response => {
        let body = responseBodies.get(response);
        if (body === undefined) {
          body = readNativeBody(surface, response.handle, context.operation(context.timeouts.test), response.identityScope);
          responseBodies.set(response, body);
        }
        // The channel retains this event's handle until every subscriber's capture settles.
        return body.then(() => undefined, () => undefined);
      });
      let subscriptionId: string | undefined;
      let failed = false;
      try {
        ({ subscriptionId } = await command('network.responses.subscribe', {}, operation));
        const response = await waiter.promise;
        const cached = responseBodies.get(response)!;
        const text = (): Promise<string> => {
          const bodyOperation = context.operation();
          return raceAbort(withTimeout(cached, bodyOperation.timeoutMs, () => new TestError('ACTION_FAILED', `waitForResponse: response body did not finish within ${bodyOperation.timeoutMs}ms`)), bodyOperation.signal, 'response body');
        };
        return { url: response.url, status: response.status, headers: { ...response.headers }, text,
          // oxlint-disable-next-line e2e/no-unchecked-json -- public API: caller names T, unknown by default
          json: async <T = unknown>() => JSON.parse(await text()) as T };
      } catch (cause) { failed = true; throw cause; } finally {
        waiter.cancel();
        if (subscriptionId !== undefined) {
          const id = subscriptionId;
          await cleanupResource(surface, failed, () => surface.command('network.responses.unsubscribe', { subscriptionId: id }, context.operation()), scope);
        }
      }
    },
    cookies: async () => (await command('context.cookies.get', {})).cookies,
    setCookies(cookies) {
      const scheme = new URL(baseHref()).protocol === 'https:' ? 'https' : 'http';
      const targets = cookies.map(cookie => {
        const target = context.app.resolveUrl(cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url);
        if (!/^https?:/.test(target)) throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
        return cookie.url === undefined ? { domain: cookie.domain, path: cookie.path ?? '/' } : { url: target };
      });
      return command('context.cookies.set', { cookies: cookies.map((cookie, index) => ({
        name: cookie.name, value: cookie.value, ...targets[index]!,
        ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
        ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
        ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
      })) }).then(() => undefined);
    },
    async setViewport(size) { await command('context.viewport', size); context.attachViewport({ ...size, scale: 1 }); },
    async emulateMedia(media) {
      if (typeof media !== 'object' || media === null) throw new TestError('INVALID_ARGUMENT', 'browser.emulateMedia takes { colorScheme?, reducedMotion? }');
      rejectUnknownOptions('browser.emulateMedia', media, MEDIA_KEYS);
      for (const key of MEDIA_KEYS) {
        const problem = mediaProblem(name => `browser.emulateMedia({ ${name} })`, key, media[key]);
        if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
      }
      await command('context.media', obj({ colorScheme: media.colorScheme, reducedMotion: media.reducedMotion }));
    },
    async onDialog(handler) {
      const registration = { handler };
      dialogs.push(registration);
      try { await command('dialog.register', { enabled: true }); }
      catch (cause) { dialogs.splice(dialogs.indexOf(registration), 1); throw cause; }
      return async () => {
        const index = dialogs.indexOf(registration);
        if (index >= 0) dialogs.splice(index, 1);
        await command('dialog.register', { enabled: dialogs.length > 0 });
      };
    },
    async waitForDownload(trigger, options) {
      const scope = surface.identityScope;
      const operation = context.operation(options?.timeout);
      const deadline = new Deadline(operation.timeoutMs);
      let saved: Promise<{ path: string; absolutePath: string; suggestedFilename: string }> | undefined;
      const waiter = waitNativeEvent(surface, 'download.started', event => event.activePage, operation, download => {
        saved = (async () => {
          const { relative, absolute } = surface.artifactPath('downloads', download.suggestedFilename, '');
          const file = await openFile(absolute, 'wx');
          try {
            try {
              await readNativeChunks(surface, 'download.read', download.handle, { ...operation, timeoutMs: deadline.remaining() }, async bytes => { await file.writeFile(bytes); }, download.identityScope);
            } finally { await file.close(); }
            assertSurfaceScope(surface, download.identityScope);
            context.attachArtifact('download', relative);
            return { path: relative, absolutePath: absolute, suggestedFilename: download.suggestedFilename };
          } catch (cause) { await unlink(absolute).catch(() => undefined); throw cause; }
        })();
        return saved.then(() => undefined, () => undefined);
      });
      let subscriptionId: string | undefined;
      let failed = false;
      try {
        ({ subscriptionId } = await command('download.subscribe', {}, operation));
        await trigger();
        await waiter.promise;
        return await saved!;
      } catch (cause) { failed = true; throw cause; } finally {
        waiter.cancel();
        if (subscriptionId !== undefined) {
          const id = subscriptionId;
          await cleanupResource(surface, failed, () => surface.command('download.unsubscribe', { subscriptionId: id }, context.operation()), scope);
        }
      }
    },
    keyboard: {
      press: async key => { await command('input.keyboard', { action: 'press', value: controllerKey(key) }); },
      down: async key => { await command('input.keyboard', { action: 'down', value: controllerKey(key) }); },
      up: async key => { await command('input.keyboard', { action: 'up', value: controllerKey(key) }); },
      type: async text => { await command('input.keyboard', { action: 'type', value: text }); },
    },
    mouse: {
      move: async (x, y) => { await command('input.mouse', { action: 'move', x, y }); },
      wheel: async (deltaX, deltaY) => { await command('input.mouse', { action: 'wheel', deltaX, deltaY }); },
      down: async () => { await command('input.mouse', { action: 'down' }); },
      up: async () => { await command('input.mouse', { action: 'up' }); },
    },
  };

  const action: FixtureOperation = { kind: 'resource' };
  const navigationCall = { kind: 'resource', timeout: false } as const;
  const matchers: FixtureOperations<BrowserExpectation> = {
    toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveClass: { kind: 'assertion', timeout: false, label: (_target, expected) => String(expected) },
    get not() { return matchers; },
  };
  return context.fixture('browser', context.expectable(browser, () => context.fixture('expect', expectation, matchers)), {
    goto: { ...navigationCall, label: (url) => url },
    reload: navigationCall,
    back: navigationCall,
    forward: navigationCall,
    url: action,
    title: action,
    waitForURL: { ...navigationCall, verifies: true, label: (url) => String(url) },
    evaluate: action,
    addInitScript: { ...action, label: (script) => initScriptLabel(script) },
    route: { ...action, label: (pattern) => String(pattern) },
    unroute: { ...action, label: (pattern) => String(pattern) },
    unrouteAll: action,
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout, label: (pattern) => String(pattern) },
    cookies: action,
    setCookies: action,
    setViewport: action,
    emulateMedia: { ...action, label: (media) => mediaLabel(media) },
    onDialog: action,
    waitForDownload: { ...action, timeout: (_trigger, options) => options?.timeout },
    keyboard: { down: { ...action, label: (key) => key }, up: { ...action, label: (key) => key }, press: { ...action, label: (key) => key }, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
  });
}

interface ExpectationDeps {
  currentUrl(deadline: Deadline): Promise<string>;
  currentTitle(deadline: Deadline): Promise<string>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined): Deadline;
  readonly context: EngineFixtureContext;
}

/** One read of a browser matcher poll: whether the condition holds (undefined: not evaluable yet), and what was seen. */
interface BrowserSample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/**
 * `expect(browser)` matchers: URL, title, and class polling against the
 * assertion budget. Every read is bounded by the poll's deadline, so a page
 * that stops answering ends the assertion at its own timeout, and the
 * failure reports the last read instead of reading a hung page again.
 */
function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  const poll = async (
    api: string,
    label: string,
    read: (deadline: Deadline) => Promise<BrowserSample>,
    timeout: number | undefined,
  ): Promise<void> => {
    const deadline = deps.deadlineFor(timeout);
    // pollCondition calls onTimeout only after a read completed, so a sample is always there.
    let last: BrowserSample | undefined;
    await pollCondition({
      deadline,
      signal: deps.context.signal,
      negated,
      evaluate: async () => {
        last = await read(deadline);
        return last.matches;
      },
      onTimeout: (cause) =>
        new TestError(
          'ASSERTION_FAILED',
          `expect.${negated ? 'not.' : ''}${api} failed\nexpected: ${negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`,
          cause === undefined ? undefined : { cause },
        ),
    });
  };
  const validate = (api: string, options: object | undefined, keys: readonly string[] = ['timeout']): void =>
    rejectUnknownOptions(`expect.${negated ? 'not.' : ''}${api}`, options, keys);
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      validate('toHaveURL', options, ['ignoreCase', 'timeout']);
      const ignoreCase = options?.ignoreCase;
      if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
        throw new TestError('INVALID_ARGUMENT', `expect.${negated ? 'not.' : ''}toHaveURL option ignoreCase must be a boolean`);
      }
      const label = typeof expected === 'string' ? expected : String(expected);
      const target = deps.baseHref();
      return poll(
        'toHaveURL',
        `URL ${label}${ignoreCase === true ? ' (ignoring case)' : ''}`,
        async (deadline) => {
          const url = await deps.currentUrl(deadline);
          return { matches: urlMatches(url, expected, target, ignoreCase), observed: `URL ${url}` };
        },
        options?.timeout,
      );
    },
    toHaveTitle(expected, options) {
      validate('toHaveTitle', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveTitle',
        `title ${describePattern(pattern)}`,
        async (deadline) => {
          const title = await deps.currentTitle(deadline);
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        },
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      validate('toHaveClass', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        async (deadline) => {
          let value: string | null | undefined;
          try {
            // A locator read takes the action timeout; the poll's deadline is the tighter bound.
            value = await withTimeout(
              readClass(target),
              deadline.remaining(),
              () => new EngineError('OPERATION_TIMEOUT', 'class read timed out', { retryable: false }),
            );
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return { matches: undefined, observed: 'no node' };
            throw error;
          }
          if (value === undefined) return { matches: undefined, observed: 'no node' };
          if (value === null) return { matches: false, observed: 'no class attribute' };
          return {
            matches: matchesText(value.trim().split(/\s+/).join(' '), pattern),
            observed: `class ${JSON.stringify(value)}`,
          };
        },
        options?.timeout,
      );
    },
  };
}

/**
 * The class attribute of one match, `undefined` while nothing matches. A
 * read waits for its match until the action timeout, so the poll samples
 * absence first: a node that never arrives stays an assertion failure.
 */
async function readClass(target: Locator): Promise<string | null | undefined> {
  if ((await target.count()) === 0) return undefined;
  return target.getAttribute('class');
}

function requireSelector(method: string, selector: unknown): string {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', `${method}() requires a nonempty selector`);
  }
  return selector;
}

/**
 * The scope for the innermost of `frames` (outermost first). Every query and
 * both escape hatches compile through the same `frame` chain, so a `locator`
 * inside it resolves against the innermost document.
 */
function frameScreen(context: EngineFixtureContext, frames: readonly string[]): FrameScreen {
  const scope = (expression: LocatorExpression): LocatorExpression =>
    frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), expression);
  return Object.assign(context.screen(scope), {
    locator: (selector: string) =>
      context.locator(scope({ kind: 'selector', selector: requireSelector('locator', selector) })),
    frameLocator: (selector: string) =>
      frameScreen(context, [...frames, requireSelector('frameLocator', selector)]),
  });
}

/** Keep the native header representation ordered and explicit. */
function headerPairs(headers: Readonly<Record<string, string>>): NativeHeader[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/** Subscribe synchronously, then wait without retaining any native action lock. */
function waitNativeEvent<K extends keyof BrowserEventMap>(
  surface: NativeWebSurface,
  name: K,
  matches: (event: BrowserEventMap[K]) => boolean,
  operation: OperationContext,
  onMatch?: (event: BrowserEventMap[K]) => Promise<void>,
): { promise: Promise<BrowserEventMap[K]>; cancel(): void } {
  const scope = surface.identityScope;
  let stop = (): void => undefined;
  let done = false;
  let cancel = (): void => undefined;
  const promise = new Promise<BrowserEventMap[K]>((resolve, reject) => {
    const finish = (event: BrowserEventMap[K] | undefined, cause?: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
      stop();
      if (event !== undefined) resolve(event);
      else reject(cause);
    };
    const abort = () => finish(undefined, new EngineError('CANCELLED', `${name} wait was cancelled`, { retryable: false }));
    const timer = setTimeout(() => finish(undefined, new TestError('ACTION_FAILED', `${name} did not arrive within ${operation.timeoutMs}ms`)), operation.timeoutMs);
    cancel = () => finish(undefined, new TestError('ACTION_FAILED', `${name} wait was cancelled`));
    stop = surface.subscribe(name, event => {
      if (done || event.identityScope !== scope || !matches(event)) return;
      const work = onMatch?.(event);
      finish(event);
      return work;
    });
    if (operation.signal.aborted) abort();
    else operation.signal.addEventListener('abort', abort, { once: true });
  });
  // A trigger or subscription may fail before the wait's own deadline.
  void promise.catch(() => undefined);
  return { promise, cancel: () => cancel() };
}

/** Stream opaque native data with exact offsets and one shared deadline. */
async function readNativeChunks(
  surface: NativeWebSurface,
  name: 'network.body.read' | 'download.read',
  handle: string,
  operation: OperationContext,
  accept: (bytes: Buffer) => void | Promise<void>,
  scope = surface.identityScope,
): Promise<void> {
  const deadline = new Deadline(operation.timeoutMs);
  let offset = 0;
  for (;;) {
    assertSurfaceScope(surface, scope);
    const maxBytes = 64 * 1024;
    const chunk = await surface.command(name, { handle, offset, maxBytes }, { ...operation, timeoutMs: deadline.remaining() });
    const bytes = Buffer.from(chunk.base64, 'base64');
    if (bytes.length > maxBytes || chunk.nextOffset !== offset + bytes.length || (!chunk.eof && bytes.length === 0)) {
      throw invalidateScope(surface, scope);
    }
    assertSurfaceScope(surface, scope);
    await accept(bytes);
    assertSurfaceScope(surface, scope);
    if (chunk.eof) return;
    offset = chunk.nextOffset;
  }
}

/** Cache response-body failures as failures, never an empty successful body. */
async function readNativeBody(surface: NativeWebSurface, handle: string, operation: OperationContext, scope = surface.identityScope): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    await readNativeChunks(surface, 'network.body.read', handle, operation, bytes => { chunks.push(bytes); }, scope);
    return Buffer.concat(chunks).toString('utf8');
  } catch (cause) {
    throw new TestError('ACTION_FAILED', `waitForResponse: response body could not be read: ${causeMessage(cause)}`);
  }
}

/** Large fixture bodies use the native scoped blob primitive, not a raised frame limit. */
async function withDecisionBody(
  surface: NativeWebSurface,
  bytes: Buffer,
  operation: OperationContext,
  decide: (payload: NativeDecisionBody) => Promise<void>,
  scope = surface.identityScope,
): Promise<void> {
  assertSurfaceScope(surface, scope);
  if (bytes.length <= 256 * 1024) return decide({ bodyBase64: bytes.toString('base64') });
  const deadline = new Deadline(operation.timeoutMs);
  const current = (): OperationContext => { assertSurfaceScope(surface, scope); return { ...operation, timeoutMs: deadline.remaining() }; };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await surface.command('blob.create', { size: bytes.length, sha256 }, current());
  let consumed = false;
  try {
    if (created.size !== bytes.length || created.sha256 !== sha256) throw invalidateScope(surface, scope);
    for (let offset = 0; offset < bytes.length;) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + created.maxChunkBytes));
      const result = await surface.command('blob.write', { handle: created.handle, offset, base64: chunk.toString('base64') }, current());
      if (result.nextOffset !== offset + chunk.length) throw invalidateScope(surface, scope);
      offset = result.nextOffset;
    }
    const sealed = await surface.command('blob.seal', { handle: created.handle }, current());
    if (sealed.handle !== created.handle || sealed.size !== bytes.length || sealed.sha256 !== sha256) throw invalidateScope(surface, scope);
    await decide({ bodyHandle: created.handle });
    consumed = true;
  } finally {
    if (!consumed) await cleanupResource(surface, true, () => surface.command('blob.release', { handle: created.handle }, current()), scope);
  }
}

/** Failed cleanup poisons this scope, but cannot overwrite a primary operation error. */
async function cleanupResource(surface: NativeWebSurface, failed: boolean, cleanup: () => Promise<unknown>, scope: string): Promise<void> {
  if (!surfaceScopeActive(surface, scope)) return;
  try { await cleanup(); }
  catch {
    const failure = invalidateScope(surface, scope);
    if (!failed) throw failure;
    // The poisoned transport retains cleanup failure; do not preempt the primary callback error in its latch.
  }
}

function surfaceScopeActive(surface: NativeWebSurface, scope: string): boolean {
  try { return surface.identityScope === scope; } catch { return false; }
}
function assertSurfaceScope(surface: NativeWebSurface, scope: string): void {
  if (!surfaceScopeActive(surface, scope)) throw new EngineError('INVALID_STATE', 'The browser resource belongs to a retired scope', { retryable: false });
}
function invalidateScope(surface: NativeWebSurface, scope: string): EngineError {
  return surfaceScopeActive(surface, scope) ? surface.invalidate() : new EngineError('INVALID_STATE', 'The browser resource belongs to a retired scope', { retryable: false });
}
