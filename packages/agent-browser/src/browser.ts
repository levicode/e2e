/** Deterministic browser fixture backed by agent-browser and its public CDP companion. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigurationError, Deadline, describePattern, EngineError, matchesText, pollCondition,
  rejectUnknownOptions, TestError, toTextPattern, urlMatches, validateJsonValue, withTimeout,
  type EngineFixtureContext, type Expectable, type FixtureOperation, type FixtureOperations,
  type JsonValue, type Locator, type LocatorExpression, type OperationContext, type Screen, type TextMatch,
} from 'e2e/engine';
import type { WebResponse, WebRoute } from './network.ts';
import { AgentBrowserSurface, unsupported } from './surface.ts';

export interface Dialog {
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  readonly message: string;
  accept(text?: string): Promise<void>;
  dismiss(): Promise<void>;
}
export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);
export interface WebMedia {
  readonly colorScheme?: 'light' | 'dark' | 'no-preference';
  readonly reducedMotion?: 'reduce' | 'no-preference';
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
 * from inside the frame, and because the frame's document is Playwright's,
 * the web-only escape hatches follow it in: `locator` for a CSS or XPath
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
  reload(options?: { timeout?: number }): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: { timeout?: number }): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: { timeout?: number }): Promise<void>;
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
            if (error instanceof TestError && error.code === 'LOCATOR_NOT_FOUND') return { matches: undefined, observed: 'no node' };
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

/** Serialize trusted test functions without executing them in the runner process. */
function functionSource(fn: (...args: never[]) => unknown): string {
  const source = fn.toString().trim();
  for (const candidate of [source, `function ${source}`, ...(source.startsWith('async ') ? [`async function ${source.slice(6)}`] : [])]) {
    try { const parsed = new Function(`return (${candidate}\n);`); void parsed; return candidate; } catch { /* Try method shorthand. */ }
  }
  throw new TestError('EVALUATE_FAILED', 'The page function cannot be serialized');
}

/** Keep a JSON argument's __proto__ key as data when inserting it into page source. */
function argumentSource(value: unknown): string {
  return value === undefined ? 'undefined' : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

/** Check before CDP's JSON encoder can turn NaN into null or silently drop functions. */
const RESULT_CHECK = `
  const ancestors = new Set();
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) throw new Error();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error();
    ancestors.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child);
    ancestors.delete(item);
  };
  try { if (result !== undefined) visit(result); } catch { return { json: false }; }
  return { json: true, value: result };
`;

/** Build an init script from the supported trusted-code forms, with static errors. */
async function initScriptSource(script: unknown, rest: readonly unknown[], projectRoot: string): Promise<string> {
  if (rest.length > 1 || (rest.length > 0 && typeof script !== 'function')) throw new TestError('INVALID_ARGUMENT', 'An init-script argument requires a function script');
  validateJsonValue(rest[0], 'addInitScript argument');
  if (typeof script === 'function') {
    return `(() => { const __name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true }); (${functionSource(script as (...args: never[]) => unknown)}\n)(${argumentSource(rest[0])}); })();`;
  }
  if (typeof script === 'string') return script;
  if (typeof script !== 'object' || script === null || Array.isArray(script) || !('path' in script) || typeof script.path !== 'string' || script.path === '' || Object.keys(script).length !== 1) {
    throw new TestError('INVALID_ARGUMENT', 'An init script must be source text, a function, or { path }');
  }
  try { return await readFile(path.resolve(projectRoot, script.path), 'utf8'); }
  catch { throw new TestError('INVALID_ARGUMENT', 'The init-script file could not be read'); }
}

/** Builds the public browser fixture and records every asynchronous operation. */
export function createBrowserFixture(surface: AgentBrowserSurface, context: EngineFixtureContext): Browser {
  const originalOperation = context.operation.bind(context);
  context = { ...context, operation: (timeoutMs) => { const operation = originalOperation(timeoutMs); surface.guardOperation(operation); return operation; } };
  const baseHref = () => context.app.resolveUrl('');
  const currentUrl = (deadline?: Deadline) => surface.evaluate<string>('location.href', context.operation(deadline?.remaining()), false);
  const currentTitle = (deadline?: Deadline) => surface.evaluate<string>('document.title', context.operation(deadline?.remaining()), false);
  const expectation = createBrowserExpectation({
    currentUrl, currentTitle, baseHref, context,
    deadlineFor: (timeout) => new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs),
  });
  const navigation = (options?: { timeout?: number }) => context.operation(options?.timeout ?? context.timeouts.test);
  const companion = new FixtureCompanion(surface, context);
  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    async goto(url, options) {
      rejectUnknownOptions('browser.goto', options, ['timeout', 'waitUntil']);
      const wait = options?.waitUntil ?? 'load';
      if (!['load', 'domcontentloaded', 'networkidle'].includes(wait)) throw new TestError('INVALID_ARGUMENT', 'Unknown navigation wait condition');
      await surface.open(context.app.resolveUrl(url), navigation(options), wait);
    },
    async reload(options) { rejectUnknownOptions('browser.reload', options, ['timeout']); await surface.command(['reload'], navigation(options), true); },
    async back(options) { rejectUnknownOptions('browser.back', options, ['timeout']); await surface.back(navigation(options)); },
    async forward(options) { rejectUnknownOptions('browser.forward', options, ['timeout']); await surface.command(['forward'], navigation(options), true); },
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL(expected, options) { rejectUnknownOptions('browser.waitForURL', options, ['timeout']); return expectation.toHaveURL(expected, options); },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    async evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      if (typeof fn !== 'string' && typeof fn !== 'function') throw new TestError('INVALID_ARGUMENT', 'browser.evaluate requires trusted source or a function');
      validateJsonValue(arg, 'evaluate argument');
      const source = typeof fn === 'string' ? fn : functionSource(fn);
      const encoded = await surface.evaluate<{ json: boolean; value?: T }>(`(async () => { const __name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true }); const value = (${source}\n); const result = typeof value === 'function' ? await value(${argumentSource(arg)}) : await value; ${RESULT_CHECK} })()`, context.operation());
      if (!encoded || encoded.json !== true) throw new TestError('INVALID_ARGUMENT', 'evaluate result must be JSON-safe');
      const result = encoded.value;
      validateJsonValue(result, 'evaluate result');
      return result as T;
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      await companion.addInitScript(await initScriptSource(script, rest, surface.projectRoot), context.operation());
    },
    route: (pattern, handler) => companion.route(pattern, handler, context.operation()),
    unroute: (pattern) => companion.unroute(pattern, context.operation()),
    waitForResponse(pattern, options) {
      rejectUnknownOptions('browser.waitForResponse', options, ['timeout']);
      return surface.routes.waitForResponse(pattern, context.operation(options?.timeout));
    },
    async cookies() {
      surface.assertUsable();
      const result = await surface.cdp.send<{ cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; partitionKey?: unknown }> }>('Storage.getCookies', surface.browserContextId === undefined ? {} : { browserContextId: surface.browserContextId }, context.operation());
      if (!Array.isArray(result.cookies)) throw new EngineError('ENGINE_FAILURE', 'Chromium returned an invalid cookie list', { retryable: false });
      if (result.cookies.some((cookie) => cookie.partitionKey !== undefined)) unsupported('Partitioned cookies cannot be represented by the browser cookie API');
      return result.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        ...(cookie.expires >= 0 ? { expires: Math.floor(cookie.expires) } : {}), httpOnly: cookie.httpOnly, secure: cookie.secure,
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
      }));
    },
    async setCookies(cookies) {
      if (!Array.isArray(cookies)) throw new TestError('INVALID_ARGUMENT', 'browser.setCookies requires an array');
      const scheme = new URL(baseHref()).protocol === 'https:' ? 'https' : 'http';
      const values = cookies.map((cookie: Cookie) => {
        if (typeof cookie !== 'object' || cookie === null) throw new TestError('INVALID_ARGUMENT', 'Each cookie must be an object');
        rejectUnknownOptions('browser.setCookies', cookie, ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);
        if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || (cookie.url === undefined) === (cookie.domain === undefined)) throw new TestError('INVALID_ARGUMENT', 'A cookie requires a name, value, and exactly one URL or domain');
        if (cookie.url !== undefined && cookie.path !== undefined) throw new TestError('INVALID_ARGUMENT', 'A URL cookie cannot specify path');
        const target = context.app.resolveUrl(cookie.url ?? `${scheme}://${cookie.domain!.replace(/^\./, '')}`);
        if (!/^https?:/.test(target)) throw new ConfigurationError('POLICY_DENIED', 'Cookie URLs must use HTTP or HTTPS');
        if (cookie.expires !== undefined && (!Number.isInteger(cookie.expires) || cookie.expires < -1)) throw new TestError('INVALID_ARGUMENT', 'Cookie expiry must be an integer timestamp');
        for (const value of [cookie.httpOnly, cookie.secure]) if (value !== undefined && typeof value !== 'boolean') throw new TestError('INVALID_ARGUMENT', 'Cookie flags must be boolean');
        if (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) throw new TestError('INVALID_ARGUMENT', 'Unknown cookie SameSite value');
        return { name: cookie.name, value: cookie.value,
          ...(cookie.url === undefined ? { domain: cookie.domain, path: cookie.path ?? '/' } : { url: target }),
          ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
          ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
          ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
          ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        };
      });
      await companion.mutate('Storage.setCookies', { cookies: values, ...(surface.browserContextId === undefined ? {} : { browserContextId: surface.browserContextId }) }, context.operation());
    },
    async setViewport(size) {
      if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) throw new TestError('INVALID_ARGUMENT', 'Viewport dimensions must be positive integers');
      rejectUnknownOptions('browser.setViewport', size, ['width', 'height']);
      await surface.setViewport(size, context.operation());
      context.operation();
      context.attachViewport({ ...size, scale: 1 });
    },
    async emulateMedia(media) {
      if (typeof media !== 'object' || media === null || Array.isArray(media)) throw new TestError('INVALID_ARGUMENT', 'Media preferences must be an object');
      rejectUnknownOptions('browser.emulateMedia', media, ['colorScheme', 'reducedMotion']);
      if (media.colorScheme !== undefined && !['light', 'dark', 'no-preference'].includes(media.colorScheme)) throw new TestError('INVALID_ARGUMENT', 'Unknown color-scheme preference');
      if (media.reducedMotion !== undefined && !['reduce', 'no-preference'].includes(media.reducedMotion)) throw new TestError('INVALID_ARGUMENT', 'Unknown reduced-motion preference');
      await companion.emulateMedia(media, context.operation());
    },
    onDialog: (handler) => companion.onDialog(handler, context.operation()),
    waitForDownload: (trigger, options) => companion.waitForDownload(trigger, options),
    keyboard: {
      press: (key) => surface.pressKey(key, context.operation()),
      down: (key) => surface.input.keyDown(key, context.operation()),
      up: (key) => surface.input.keyUp(key, context.operation()),
      type: (text) => surface.typeText(text, false, context.operation()),
    },
    mouse: {
      move: (x, y) => surface.input.mouseMove(x, y, context.operation()),
      wheel: (deltaX, deltaY) => surface.input.mouseWheel(deltaX, deltaY, context.operation()),
      down: () => surface.input.mouseDown('left', context.operation()),
      up: () => surface.input.mouseUp('left', context.operation()),
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
    goto: { ...navigationCall, label: (url) => url }, reload: navigationCall, back: navigationCall, forward: navigationCall,
    url: action, title: action, waitForURL: { ...navigationCall, verifies: true, label: (url) => String(url) }, evaluate: action,
    addInitScript: { ...action, label: () => 'trusted script' }, route: action, unroute: action,
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout }, cookies: action, setCookies: action,
    setViewport: action, emulateMedia: action, onDialog: action,
    waitForDownload: { ...action, timeout: (_trigger, options) => options?.timeout },
    keyboard: { down: action, up: action, press: action, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
  });
}

interface SessionConfiguration {
  scripts: number;
  mediaVersion: number;
  pending: Promise<void>;
}

/** Shares the hub's paused-target initialization instead of owning another auto-attach controller. */
class FixtureCompanion {
  private readonly surface: AgentBrowserSurface;
  private readonly context: EngineFixtureContext;
  private readonly sources: string[] = [];
  private readonly media = new Map<string, string>();
  private mediaVersion = 0;
  private readonly sessions = new Map<string, SessionConfiguration>();
  private readonly subscriptions: Array<() => void> = [];
  private readonly dialogs: Array<{ handler: DialogHandler }> = [];
  private readonly registeredRoutes: Array<{ pattern: string | RegExp; handler: (route: WebRoute) => void | Promise<void> }> = [];
  private ready: Promise<void> | undefined;
  private downloading = false;
  private closed = false;

  constructor(surface: AgentBrowserSurface, context: EngineFixtureContext) {
    this.surface = surface;
    this.context = context;
    const defaults = surface.options as WebMedia | undefined;
    if (defaults?.colorScheme !== undefined) this.media.set('prefers-color-scheme', defaults.colorScheme);
    if (defaults?.reducedMotion !== undefined) this.media.set('prefers-reduced-motion', defaults.reducedMotion);
    surface.registerCleanup(() => {
      this.closed = true;
      for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
      this.sessions.clear();
    });
    surface.registerRestart(async (operation) => {
      for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
      this.closed = false;
      this.ready = undefined;
      this.sessions.clear();
      for (const route of this.registeredRoutes) await this.surface.routes.route(route.pattern, route.handler, operation);
      await this.start(operation);
    });
  }

  /** Keep route registrations across an owned context replacement. */
  async route(pattern: string | RegExp, handler: (route: WebRoute) => void | Promise<void>, operation: OperationContext): Promise<void> {
    this.surface.guardOperation(operation);
    const snapshot = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags) : pattern;
    await this.surface.routes.route(snapshot, handler, operation);
    this.registeredRoutes.push({ pattern: snapshot, handler });
  }

  /** Remove matching patterns from the current hub and the restart registry together. */
  async unroute(pattern: string | RegExp, operation: OperationContext): Promise<void> {
    this.surface.guardOperation(operation);
    const key = JSON.stringify(toTextPattern(pattern));
    await this.surface.routes.unroute(pattern, operation);
    for (let index = this.registeredRoutes.length - 1; index >= 0; index -= 1) {
      if (JSON.stringify(toTextPattern(this.registeredRoutes[index]!.pattern)) === key) this.registeredRoutes.splice(index, 1);
    }
  }

  /** A lost mutation acknowledgement ends the attempt, never a retry of the same input. */
  async mutate(method: string, params: Record<string, unknown>, operation: OperationContext, sessionId?: string): Promise<void> {
    this.surface.guardOperation(operation);
    this.surface.assertUsable();
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Browser operation cancelled before dispatch', { retryable: false });
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Browser operation timed out before dispatch', { retryable: false });
    try { await this.surface.cdp.send(method, params, operation, sessionId); }
    catch { this.surface.guardOperation(operation); this.surface.markUncertain(); }
  }

  /** New targets receive accumulated configuration before the hub resumes their renderer. */
  private start(operation: OperationContext): Promise<void> {
    this.surface.guardOperation(operation);
    this.surface.assertUsable();
    this.ready ??= this.surface.routes.registerSessionInitializer(
      (sessionId, _targetId, context) => this.configure(sessionId, context), operation,
    );
    return this.ready;
  }

  /** Applies script and media revisions once per target, including overlapping registrations. */
  private configure(sessionId: string, operation: OperationContext): Promise<void> {
    this.surface.guardOperation(operation);
    const deadline = new Deadline(operation.timeoutMs);
    const budget = () => ({ ...operation, timeoutMs: deadline.remaining() });
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { scripts: 0, mediaVersion: -1, pending: Promise.resolve() };
      this.sessions.set(sessionId, state);
      this.subscriptions.push(this.surface.cdp.on<{ type: string; message: string }>('Page.javascriptDialogOpening', (event) => {
        this.surface.registerBackground(this.dispatchDialog(sessionId, event));
      }, sessionId));
    }
    const current = state;
    current.pending = current.pending.then(async () => {
      if (this.closed) return;
      this.surface.guardOperation(operation);
      await this.surface.cdp.send('Page.enable', {}, budget(), sessionId);
      while (current.scripts < this.sources.length) {
        const source = this.sources[current.scripts];
        if (source === undefined) break;
        await this.mutate('Page.addScriptToEvaluateOnNewDocument', { source }, budget(), sessionId);
        current.scripts += 1;
      }
      if (current.mediaVersion !== this.mediaVersion && this.media.size > 0) {
        await this.mutate('Emulation.setEmulatedMedia', { features: [...this.media].map(([name, value]) => ({ name, value })) }, budget(), sessionId);
        current.mediaVersion = this.mediaVersion;
      }
    });
    return current.pending;
  }

  /** Register against existing targets as well as future paused targets. */
  async addInitScript(source: string, operation: OperationContext): Promise<void> {
    this.sources.push(source);
    await this.start(operation);
    this.surface.guardOperation(operation);
    await this.surface.routes.forEachSession((sessionId, _targetId, context) => this.configure(sessionId, context), operation);
  }

  /** Omitted features retain their prior values across every document target. */
  async emulateMedia(media: WebMedia, operation: OperationContext): Promise<void> {
    if (media.colorScheme !== undefined) this.media.set('prefers-color-scheme', media.colorScheme);
    if (media.reducedMotion !== undefined) this.media.set('prefers-reduced-motion', media.reducedMotion);
    this.mediaVersion += 1;
    await this.start(operation);
    this.surface.guardOperation(operation);
    await this.surface.routes.forEachSession((sessionId, _targetId, context) => this.configure(sessionId, context), operation);
  }

  /** The newest dialog registration wins; removal is idempotent and identity-based. */
  async onDialog(handler: DialogHandler, operation: OperationContext): Promise<() => Promise<void>> {
    if (handler !== 'accept' && handler !== 'dismiss' && typeof handler !== 'function') throw new TestError('INVALID_ARGUMENT', 'A dialog handler must accept, dismiss, or be a function');
    const registration = { handler };
    this.dialogs.push(registration);
    await this.start(operation);
    return async () => {
      const index = this.dialogs.indexOf(registration);
      if (index !== -1) this.dialogs.splice(index, 1);
    };
  }

  /** Dialog work uses the companion channel, so it can unblock a pending CLI action. */
  private async dispatchDialog(sessionId: string, event: { type: string; message: string }): Promise<void> {
    if (this.closed) return;
    const handler = this.dialogs.at(-1)?.handler;
    const operation = this.context.operation();
    const connection = this.surface.cdp;
    let decided = false;
    let responded = false;
    const answer = async (accept: boolean, text?: string): Promise<void> => {
      if (decided) throw new TestError('ACTION_FAILED', 'The dialog handler already made a decision');
      if (text !== undefined && (typeof text !== 'string' || event.type !== 'prompt')) throw new TestError('INVALID_ARGUMENT', 'Only a prompt dialog accepts text');
      decided = true;
      await this.mutate('Page.handleJavaScriptDialog', { accept, ...(text === undefined ? {} : { promptText: text }) }, operation, sessionId);
      responded = true;
    };
    try {
      if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(event.type)) throw new EngineError('ENGINE_FAILURE', 'Chromium reported an unknown dialog type', { retryable: false });
      if (handler === undefined) throw new EngineError('INVALID_STATE', 'The page opened an unhandled native dialog', { retryable: false });
      if (handler === 'accept') await answer(true);
      else if (handler === 'dismiss') await answer(false);
      else {
        const work = Promise.resolve(handler({
          type: event.type as Dialog['type'], message: event.message,
          accept: (text) => answer(true, text), dismiss: () => answer(false),
        }));
        await withTimeout(work, operation.timeoutMs, () => new TestError('ACTION_FAILED', 'The dialog handler exceeded its budget'));
        if (!responded) throw new TestError('ACTION_FAILED', 'The dialog handler returned without accepting or dismissing');
      }
    } catch (error) {
      if (!responded) await connection.send('Page.handleJavaScriptDialog', { accept: false }, operation, sessionId).catch(() => undefined);
      if (error instanceof EngineError || error instanceof TestError) throw error;
      throw new TestError('ACTION_FAILED', 'The dialog handler failed');
    }
  }

  /** Captures one active-document download using validated GUIDs and generated artifact names. */
  async waitForDownload(trigger: () => Promise<void>, options?: { timeout?: number }): Promise<{ path: string; absolutePath: string; suggestedFilename: string }> {
    rejectUnknownOptions('browser.waitForDownload', options, ['timeout']);
    if (typeof trigger !== 'function') throw new TestError('INVALID_ARGUMENT', 'A download trigger function is required');
    if (this.downloading) unsupported('Overlapping download waits are unsupported');
    this.surface.assertUsable();
    const operation = this.context.operation(options?.timeout);
    const connection = this.surface.cdp;
    const sessionId = this.surface.cdpSession;
    const artifactsDir = this.surface.artifactsDir;
    const downloads = this.surface.downloads;
    if (this.surface.remote && downloads === undefined) unsupported('This remote browser has no provider download transfer capability');
    const browserContext = this.surface.browserContextId === undefined ? {} : { browserContextId: this.surface.browserContextId };
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Download wait cancelled', { retryable: false });
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Download wait timed out before dispatch', { retryable: false });
    this.downloading = true;
    const deadline = new Deadline(operation.timeoutMs);
    const budget = () => ({ ...operation, timeoutMs: deadline.remaining() });
    const remotePath = downloads !== undefined && path.win32.isAbsolute(downloads.dir) && !path.posix.isAbsolute(downloads.dir) ? path.win32 : path.posix;
    const directory = downloads?.dir ?? path.join(artifactsDir, `.download-${randomUUID()}`);
    let unsubscribeStart = () => {};
    let unsubscribeProgress = () => {};
    let unsubscribeClose = () => {};
    let cancelWait = () => {};
    let timer: NodeJS.Timeout | undefined;
    let triggerFinished = false;
    let enabled = false;
    try {
      if (downloads === undefined) await mkdir(directory, { recursive: true, mode: 0o700 });
      const tree = await connection.send<{ frameTree: unknown }>('Page.getFrameTree', {}, budget(), sessionId);
      const frames = new Set<string>();
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null || !('frame' in value) || typeof value.frame !== 'object' || value.frame === null || !('id' in value.frame) || typeof value.frame.id !== 'string') return;
        frames.add(value.frame.id);
        if ('childFrames' in value && Array.isArray(value.childFrames)) for (const child of value.childFrames) visit(child);
      };
      visit(tree.frameTree);
      if (frames.size === 0) throw new EngineError('ENGINE_FAILURE', 'The active document frame could not be identified for download', { retryable: false });
      let captured: { guid: string; suggestedFilename: string } | undefined;
      const waited = new Promise<{ guid: string; suggestedFilename: string }>((resolve, reject) => {
        const fail = () => reject(new EngineError('CANCELLED', 'Download wait cancelled', { retryable: false }));
        cancelWait = () => { operation.signal.removeEventListener('abort', fail); };
        operation.signal.addEventListener('abort', fail, { once: true });
        timer = setTimeout(() => reject(new TestError('ACTION_FAILED', 'The triggered download did not complete within its budget')), deadline.remaining());
        unsubscribeClose = connection.onClose(() => reject(new EngineError('ENGINE_FAILURE', 'The browser closed during a download', { retryable: false })));
        unsubscribeStart = connection.on<{ guid: string; frameId: string; suggestedFilename: string }>('Browser.downloadWillBegin', (event) => {
          if (captured !== undefined || !frames.has(event.frameId)) return;
          if (!/^[a-f\d-]{36}$/i.test(event.guid) || typeof event.suggestedFilename !== 'string') {
            reject(new EngineError('ENGINE_FAILURE', 'Chromium returned invalid download metadata', { retryable: false }));
            return;
          }
          captured = { guid: event.guid, suggestedFilename: event.suggestedFilename };
        });
        unsubscribeProgress = connection.on<{ guid: string; state: string }>('Browser.downloadProgress', (event) => {
          if (captured === undefined || captured.guid !== event.guid) return;
          if (event.state === 'completed') resolve(captured);
          else if (event.state === 'canceled') reject(new TestError('ACTION_FAILED', 'The triggered download was cancelled by the browser'));
        });
      });
      void waited.catch(() => undefined);
      await this.mutate('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true, ...browserContext }, budget());
      enabled = true;
      const triggering = Promise.resolve().then(() => { this.surface.guardOperation(operation); return trigger(); }).finally(() => { triggerFinished = true; });
      const [, completed] = await Promise.all([
        withTimeout(triggering, deadline.remaining(), () => new TestError('ACTION_FAILED', 'The download trigger exceeded its budget')),
        waited,
      ]);
      this.surface.guardOperation(operation);
      const relative = `download-${randomUUID()}.bin`;
      const absolutePath = path.join(artifactsDir, relative);
      try {
        if (downloads === undefined) await rename(path.join(directory, completed.guid), absolutePath);
        else {
          if (deadline.remaining() <= 0) throw new Error('Expired transfer budget');
          const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline.remaining())))]);
          const bytes = await withTimeout(downloads.read(remotePath.join(directory, completed.guid), signal), deadline.remaining(), () => new TestError('ACTION_FAILED', 'The download transfer exceeded its budget'));
          if (!(bytes instanceof Uint8Array)) throw new Error('Invalid provider download data');
          await writeFile(absolutePath, bytes, { flag: 'wx', mode: 0o600, signal });
        }
      }
      catch { throw new TestError('ACTION_FAILED', 'The completed download could not be saved'); }
      this.surface.guardOperation(operation);
      this.context.attachArtifact('download', relative);
      return { path: relative, absolutePath, suggestedFilename: completed.suggestedFilename };
    } catch (error) {
      if (enabled && !triggerFinished) { this.surface.guardOperation(operation); this.surface.markUncertain(); }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      cancelWait(); unsubscribeStart(); unsubscribeProgress(); unsubscribeClose();
      let permissionUnknown = false;
      let filesRemain = false;
      if (enabled) {
        try { await connection.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false, ...browserContext }, { ...operation, signal: new AbortController().signal, timeoutMs: 1_000 }); }
        catch { permissionUnknown = true; }
      }
      if (downloads === undefined) {
        try { await rm(directory, { recursive: true, force: true }); }
        catch { filesRemain = true; }
      }
      this.downloading = false;
      if (permissionUnknown) { this.surface.guardOperation(operation); this.surface.markUncertain(); }
      // oxlint-disable-next-line no-unsafe-finally -- Cleanup failure invalidates success, with no provider or filesystem details exposed.
      if (filesRemain) throw new EngineError('ENGINE_FAILURE', 'Temporary download files could not be removed', { retryable: false });
    }
  }
}
