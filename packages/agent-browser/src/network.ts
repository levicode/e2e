/** Concurrent HTTP interception and response events on the exact agent-browser target. */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  ConfigurationError, EngineError, TestError, validateJsonValue,
  type JsonValue, type OperationContext, type TextPattern,
} from 'e2e/engine';
import type { CdpConnection, CdpTarget } from './cdp.ts';

export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
} & (
  | { json: JsonValue; body?: never; path?: never }
  | { body: string; json?: never; path?: never }
  | { path: string; json?: never; body?: never }
  | { body?: never; json?: never; path?: never }
);

export interface RouteContinueOverrides {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
}

export interface WebRoute {
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
  fulfill(response: RouteFulfillResponse): Promise<void>;
  continue(overrides?: RouteContinueOverrides): Promise<void>;
  fallback(): Promise<void>;
  abort(): Promise<void>;
}

export interface WebResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface HttpCredentials {
  readonly username: string;
  readonly password: string;
}

export interface NetworkOptions {
  /** Exact browser context owned by this attempt; null restricts an exclusive default context. */
  readonly browserContextId?: string | null;
  /** Verified TargetInfo identity for a default context that Chromium reports with a concrete ID. */
  readonly defaultBrowserContextId?: string;
  /** Optional additional ownership boundary, evaluated before attaching user hooks or network interception. */
  includeTarget?(target: CdpTarget): boolean;
  /** A fresh harness budget for asynchronous handlers and body reads. */
  operation(): OperationContext;
  resolveUrl(url: string): string;
  resolvePath(path: string): string;
  /** Configured app-site headers, merged after an explicit request-header replacement. */
  siteHeaders?(url: string): Readonly<Record<string, string>> | undefined;
  /** Names owned by the protected-app controller, never arbitrary application request headers. */
  readonly configuredHeaderNames?: readonly string[];
  /** Resolved credentials only for an explicitly authorized destination. */
  authorization?(url: string): HttpCredentials | undefined;
}

type Pattern = string | RegExp | TextPattern;
type RouteHandler = (route: WebRoute) => void | Promise<void>;
type StoredRoute = { key: string; matches(url: string): boolean; handler: RouteHandler };
type AuthRequired = {
  requestId: string;
  request: { url: string };
  authChallenge: { source: string; origin: string; scheme: string; realm: string };
};
type NetworkProtection = { headers: Map<string, Set<string>>; basic: Set<string> };

type Paused = { requestId: string; request: WebRoute['request'] };
type ResponseReceived = { requestId: string; response: { url: string; status: number; headers: Record<string, string> } };
type RequestStarted = { requestId: string; request: { url: string }; redirectResponse?: ResponseReceived['response'] };
type ResponseWaiter = {
  matches(url: string): boolean;
  resolve(response: WebResponse): void;
  reject(error: Error): void;
  cleanup(): void;
};
type BodyRecord = {
  promise: Promise<string>;
  reading: boolean;
  resolve(body: string): void;
  reject(error: Error): void;
};

const ownErrors = new WeakSet<Error>();
// HTTP field values permit horizontal tab but no other control characters.
// oxlint-disable-next-line no-control-regex -- explicitly enforcing HTTP field-value safety
const FIELD_VALUE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** Marks locally generated diagnostics so arbitrary handler errors cannot leak request data. */
function problem(message: string, code: 'ACTION_FAILED' | 'INVALID_ARGUMENT' = 'ACTION_FAILED'): TestError {
  const error = new TestError(code, message);
  ownErrors.add(error);
  return error;
}

/** Bounds event and handler waits without serializing unrelated protocol operations. */
function bounded<T>(work: Promise<T>, context: OperationContext, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(new EngineError('CANCELLED', `${label} cancelled`, { retryable: false })); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false }));
    }, Math.max(0, context.timeoutMs));
    context.signal.addEventListener('abort', aborted, { once: true });
    work.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (context.signal.aborted) aborted();
  });
}

/** Snapshots the route grammar; a caller mutating a RegExp cannot alter a registered route. */
function patternOf(pattern: Pattern): { key: string; matches(url: string): boolean } {
  let source: string;
  let flags: string;
  let key: string;
  if (typeof pattern === 'string' || (!(pattern instanceof RegExp) && pattern.kind === 'string')) {
    const value = typeof pattern === 'string' ? pattern : pattern.value;
    key = `string:${value}`;
    source = '^';
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (char === '\\') {
        const next = value[++index];
        if (next !== undefined) source += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else if (char === '*') {
        if (value[index + 1] === '*') { index += 1; source += '.*'; }
        else source += '[^/]*';
      } else if (char === '?') source += '.';
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += '$';
    flags = '';
  } else {
    source = pattern.source;
    flags = pattern.flags;
    key = `regexp:${source}:${flags}`;
  }
  let regexp: RegExp;
  try { regexp = new RegExp(source, flags); } catch { throw problem('Invalid network URL pattern', 'INVALID_ARGUMENT'); }
  return { key, matches: (url) => { regexp.lastIndex = 0; return regexp.test(url); } };
}

/** Rejects unsupported options without serializing arbitrary caller values. */
function routeOptions(value: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (value === undefined && optional) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw problem('Unsupported route options', 'INVALID_ARGUMENT');
  return value as Record<string, unknown>;
}

/** Validates a header map and normalizes names before any protocol dispatch. */
function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw problem('Route headers must be string values', 'INVALID_ARGUMENT');
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof entry !== 'string' || FIELD_VALUE_CONTROL.test(entry)) {
      throw problem('Invalid route header', 'INVALID_ARGUMENT');
    }
    Object.defineProperty(result, name.toLowerCase(), { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Builds a CDP header array without modifying the caller's map. */
function headerEntries(value: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.entries(value).map(([name, entry]) => ({ name, value: entry }));
}

/** Normalizes received header names; Chromium can represent a repeated header with newlines. */
function responseHeaders(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), String(entry)])));
}

/** One event-driven companion per active target. No response wait holds the action transport. */
export class NetworkCompanion {
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #options: NetworkOptions;
  readonly #protection: NetworkProtection;
  readonly #authAttempts = new Set<string>();
  readonly #unsubscribers: (() => void)[] = [];
  readonly #routes: StoredRoute[] = [];
  readonly #waiters = new Set<ResponseWaiter>();
  readonly #requests = new Map<string, string>();
  readonly #bodies = new Map<string, BodyRecord>();
  readonly #handlers = new Set<Promise<void>>();
  readonly #errors: Error[] = [];
  #ready: Promise<void> | undefined;
  #fetchReady: Promise<void> | undefined;
  #closed = false;

  constructor(connection: CdpConnection, sessionId: string, options: NetworkOptions, protection?: NetworkProtection) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#options = options;
    this.#protection = protection ?? { headers: new Map(), basic: new Set() };
    this.#unsubscribers.push(
      connection.on<AuthRequired>('Fetch.authRequired', (event) => this.#authRequired(event), sessionId),
      connection.on<Paused>('Fetch.requestPaused', (event) => this.#paused(event), sessionId),
      connection.on<ResponseReceived>('Network.responseReceived', (event) => this.#received(event), sessionId),
      connection.on<RequestStarted>('Network.requestWillBeSent', (event) => this.#started(event), sessionId),
      connection.on<{ requestId: string }>('Network.loadingFinished', (event) => this.#finished(event.requestId), sessionId),
      connection.on<{ requestId: string }>('Network.loadingFailed', (event) => this.#failed(event.requestId), sessionId),
      connection.on<{ sessionId: string }>('Target.detachedFromTarget', (event) => {
        if (event.sessionId === sessionId) this.close();
      }),
      connection.onClose(() => this.close()),
    );
  }

  /** Enables response events once, before the caller starts an action that may issue requests. */
  start(context: OperationContext): Promise<void> {
    if (this.#closed) return Promise.reject(problem('Network companion is closed'));
    this.#ready ??= this.#connection.send('Network.enable', {}, context, this.#sessionId).then(async () => {
      if (this.#options.siteHeaders || this.#options.authorization) await this.#enableFetch(context);
    }).catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  /** Registers a handler; the most recently registered matching route runs first. */
  async route(pattern: Pattern, handler: RouteHandler, context: OperationContext): Promise<void> {
    if (typeof handler !== 'function') throw problem('A route handler is required', 'INVALID_ARGUMENT');
    const entry = { ...patternOf(pattern), handler };
    await this.start(context);
    this.#routes.push(entry);
    try {
      await this.#enableFetch(context);
    } catch (error) {
      const index = this.#routes.indexOf(entry);
      if (index >= 0) this.#routes.splice(index, 1);
      throw error;
    }
  }

  /** Removes every structurally equal pattern while keeping unrelated handlers and in-flight work intact. */
  async unroute(pattern: Pattern, context: OperationContext): Promise<void> {
    await this.start(context);
    const { key } = patternOf(pattern);
    for (let index = this.#routes.length - 1; index >= 0; index -= 1) {
      if (this.#routes[index]!.key === key) this.#routes.splice(index, 1);
    }
    // Keep Fetch enabled: disabling while an asynchronous handler owns a paused request races its decision.
  }

  /** Installs the response listener synchronously, then enables its domain without blocking later actions. */
  waitForResponse(pattern: Pattern, context: OperationContext): Promise<WebResponse> {
    if (this.#closed) return Promise.reject(problem('Network companion is closed'));
    if (context.signal.aborted) return Promise.reject(new EngineError('CANCELLED', 'Response wait cancelled', { retryable: false }));
    const { matches } = patternOf(pattern);
    return new Promise<WebResponse>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', aborted);
        this.#waiters.delete(waiter);
      };
      const aborted = () => { cleanup(); reject(new EngineError('CANCELLED', 'Response wait cancelled', { retryable: false })); };
      const timer = setTimeout(() => { cleanup(); reject(new EngineError('OPERATION_TIMEOUT', 'Response wait timed out', { retryable: false })); }, Math.max(0, context.timeoutMs));
      const waiter: ResponseWaiter = { matches, resolve: (response) => { cleanup(); resolve(response); }, reject: (error) => { cleanup(); reject(error); }, cleanup };
      this.#waiters.add(waiter);
      context.signal.addEventListener('abort', aborted, { once: true });
      void this.start(context).catch((error: unknown) => waiter.reject(error instanceof Error ? error : problem('Response observation could not start')));
      if (context.signal.aborted) aborted();
    });
  }

  /** Waits for already-dispatched handlers and surfaces the first latched contract or handler failure. */
  async settle(context: OperationContext): Promise<void> {
    const endsAt = Date.now() + context.timeoutMs;
    while (this.#handlers.size > 0) {
      await bounded(Promise.all(this.#handlers).then(() => undefined), { ...context, timeoutMs: Math.max(0, endsAt - Date.now()) }, 'Route handlers');
    }
    const error = this.#errors.shift();
    if (error) throw error;
  }

  /** Releases listeners and rejects unread bodies and outstanding waits; it never closes the browser. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    for (const waiter of this.#waiters) waiter.reject(problem('Network target closed during response wait'));
    for (const body of this.#bodies.values()) body.reject(problem('Network target closed before the response body finished'));
    this.#bodies.clear();
    this.#requests.clear();
    this.#authAttempts.clear();
    this.#routes.length = 0;
  }

  /** Auth and protected headers need interception even when user code registered no route. */
  #enableFetch(context: OperationContext): Promise<void> {
    this.#fetchReady ??= this.#connection.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      ...(this.#options.authorization === undefined ? {} : { handleAuthRequests: true }),
    }, context, this.#sessionId).then(() => undefined).catch((error: unknown) => {
      this.#fetchReady = undefined;
      throw error;
    });
    return this.#fetchReady;
  }

  /** Answers only a server Basic challenge whose origin is exactly the request's origin, once. */
  #authRequired(event: AuthRequired): void {
    if (this.#closed) return;
    const work = (async () => {
      let credential: HttpCredentials | undefined;
      let failed = false;
      try {
        const origin = new URL(event.request.url);
        const challenge = new URL(event.authChallenge.origin);
        if (!this.#authAttempts.has(event.requestId) && event.authChallenge.source === 'Server'
          && event.authChallenge.scheme.toLowerCase() === 'basic' && /^https?:$/.test(origin.protocol)
          && challenge.origin === origin.origin) credential = this.#options.authorization?.(event.request.url);
        if (credential && (typeof credential.username !== 'string' || typeof credential.password !== 'string')) {
          credential = undefined;
          failed = true;
        }
      } catch { failed = true; }
      this.#authAttempts.add(event.requestId);
      if (credential) this.#protection.basic.add(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`);
      await this.#connection.send('Fetch.continueWithAuth', {
        requestId: event.requestId,
        authChallengeResponse: credential
          ? { response: 'ProvideCredentials', username: credential.username, password: credential.password }
          : { response: 'CancelAuth' },
      }, this.#options.operation(), this.#sessionId);
      if (failed) throw problem('HTTP authorization could not be prepared');
    })().catch(() => { this.#errors.push(problem('HTTP authorization failed')); });
    this.#handlers.add(work);
    void work.finally(() => this.#handlers.delete(work));
  }

  /** Starts each handler independently so page actions can run while interception is paused. */
  #paused(event: Paused): void {
    if (this.#closed) return;
    const routes = this.#routes.filter((route) => route.matches(event.request.url)).toReversed();
    const work = this.#handle(event, routes).catch((error: unknown) => {
      const safe = error instanceof Error && ownErrors.has(error) ? error : problem('Asynchronous route handler failed');
      if (!this.#errors.includes(safe)) this.#errors.push(safe);
    });
    this.#handlers.add(work);
    void work.finally(() => this.#handlers.delete(work));
  }

  /** Runs one isolated LIFO chain, enforcing one decision per handler and bounded asynchronous work. */
  async #handle(event: Paused, routes: readonly StoredRoute[]): Promise<void> {
    const context = this.#options.operation();
    const endsAt = Date.now() + context.timeoutMs;
    let terminal = false;
    let expired = false;
    const remaining = (): OperationContext => {
      if (expired || this.#closed) throw problem('Route is no longer active');
      return { ...context, timeoutMs: Math.max(0, endsAt - Date.now()) };
    };
    const send = async (method: string, params: Record<string, unknown>): Promise<void> => {
      const budget = remaining();
      await this.#connection.send(method, { requestId: event.requestId, ...params }, budget, this.#sessionId);
      terminal = true;
    };
    const dispatch = async (index: number): Promise<void> => {
      const route = routes[index];
      if (!route) { await send('Fetch.continueRequest', this.#continue(undefined, event.request)); return; }
      let decided = false;
      let decision: Promise<void> | undefined;
      const choose = (action: () => Promise<void>): Promise<void> => {
        if (decided) {
          const error = problem('Route handler already decided; a request may only be handled once');
          this.#errors.push(error);
          const rejected = Promise.reject(error);
          void rejected.catch(() => undefined);
          return rejected;
        }
        remaining();
        decided = true;
        decision = action();
        void decision.catch(() => undefined);
        return decision;
      };
      const publicRoute: WebRoute = {
        request: Object.freeze({ ...event.request, headers: responseHeaders(event.request.headers) }),
        fulfill: (response) => {
          const parsed = this.#fulfill(response);
          return choose(async () => send('Fetch.fulfillRequest', await parsed));
        },
        continue: (overrides) => {
          const parsed = this.#continue(overrides, event.request);
          return choose(() => send('Fetch.continueRequest', parsed));
        },
        fallback: (...args: unknown[]) => {
          if (args.some((arg) => arg !== undefined)) throw problem('route.fallback takes no arguments', 'INVALID_ARGUMENT');
          return choose(() => dispatch(index + 1));
        },
        abort: (...args: unknown[]) => {
          if (args.some((arg) => arg !== undefined)) throw problem('route.abort takes no arguments', 'INVALID_ARGUMENT');
          return choose(() => send('Fetch.failRequest', { errorReason: 'Aborted' }));
        },
      };
      await route.handler(publicRoute);
      if (!decided) throw problem('Route handler returned without calling fulfill, continue, fallback, or abort');
      await decision;
    };
    try { await bounded(dispatch(0), context, 'Route handler'); }
    catch (error) {
      expired = true;
      if (!terminal) {
        try {
          await this.#connection.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }, this.#options.operation(), this.#sessionId);
        } catch { /* The attempt may already be cancelled or the target gone. */ }
      }
      throw error;
    } finally { expired = true; }
  }

  /** Validates synchronously and prepares body bytes without exposing a fixture's path in errors. */
  #fulfill(value: unknown): Promise<Record<string, unknown>> {
    const parsed = routeOptions(value, ['status', 'headers', 'contentType', 'json', 'body', 'path']);
    const sources = ['json', 'body', 'path'].filter((key) => parsed[key] !== undefined);
    if (sources.length > 1) throw problem('route.fulfill takes only one of json, body, or path', 'INVALID_ARGUMENT');
    const status = parsed.status ?? 200;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) throw problem('Invalid route response status', 'INVALID_ARGUMENT');
    const outgoingHeaders = headers(parsed.headers);
    if (parsed.contentType !== undefined) {
      if (typeof parsed.contentType !== 'string' || !parsed.contentType || FIELD_VALUE_CONTROL.test(parsed.contentType)) throw problem('Invalid route content type', 'INVALID_ARGUMENT');
      outgoingHeaders['content-type'] = parsed.contentType;
    }
    if (parsed.body !== undefined && typeof parsed.body !== 'string') throw problem('Route body must be a string', 'INVALID_ARGUMENT');
    if (parsed.path !== undefined && (typeof parsed.path !== 'string' || !parsed.path)) throw problem('Route path must be a nonempty string', 'INVALID_ARGUMENT');
    if (parsed.json !== undefined) {
      try { validateJsonValue(parsed.json, 'route.fulfill json'); } catch { throw problem('Route JSON must be a JSON value', 'INVALID_ARGUMENT'); }
      outgoingHeaders['content-type'] ??= 'application/json';
    }
    const prepare = async (): Promise<Record<string, unknown>> => {
      let bytes: Buffer;
      if (typeof parsed.path === 'string') {
        let path: string;
        try { path = this.#options.resolvePath(parsed.path); bytes = await readFile(path); }
        catch { throw problem('Route fixture file could not be read', 'INVALID_ARGUMENT'); }
        outgoingHeaders['content-type'] ??= fileContentType(path);
      } else {
        bytes = Buffer.from(parsed.json !== undefined ? JSON.stringify(parsed.json) : (parsed.body as string | undefined) ?? '', 'utf8');
        if (parsed.body !== undefined) outgoingHeaders['content-type'] ??= 'text/plain';
      }
      return { responseCode: status, responseHeaders: headerEntries(outgoingHeaders), body: bytes.toString('base64') };
    };
    const prepared = prepare();
    void prepared.catch(() => undefined);
    return prepared;
  }

  /** Applies the runner's navigation policy and encodes CDP's binary postData field. */
  #continue(value: unknown, request: WebRoute['request']): Record<string, unknown> {
    const parsed = routeOptions(value, ['url', 'method', 'headers', 'postData'], true);
    for (const key of ['url', 'method', 'postData']) {
      if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || (key !== 'postData' && !parsed[key]))) throw problem('Invalid route request override', 'INVALID_ARGUMENT');
    }
    let url: string | undefined;
    if (typeof parsed.url === 'string') {
      try { url = this.#options.resolveUrl(parsed.url); }
      catch (cause) {
        if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'POLICY_DENIED') {
          const denied = new ConfigurationError('POLICY_DENIED', 'Route request destination is not permitted');
          ownErrors.add(denied);
          throw denied;
        }
        throw problem('Invalid route request destination', 'INVALID_ARGUMENT');
      }
      let sameScheme = false;
      try { sameScheme = new URL(url).protocol === new URL(request.url).protocol; } catch { /* Invalid destinations never reach CDP. */ }
      if (!sameScheme) throw problem('Route URL override must keep the request scheme', 'INVALID_ARGUMENT');
    }
    const replaced = parsed.headers === undefined ? undefined : headers(parsed.headers);
    const destination = url ?? request.url;
    const site = this.#options.siteHeaders?.(destination);
    const outgoing = headers(replaced ?? request.headers);
    const configured = headers(site);
    const ownedNames = this.#options.configuredHeaderNames?.map((name) => name.toLowerCase());
    let stripped = false;
    for (const [name, ownedValues] of this.#protection.headers) {
      if (configured[name] === undefined && outgoing[name] !== undefined && ownedValues.has(outgoing[name]!)) {
        delete outgoing[name];
        stripped = true;
      }
    }
    if (outgoing.authorization !== undefined && this.#protection.basic.has(outgoing.authorization)
      && this.#options.authorization?.(destination) === undefined) {
      delete outgoing.authorization;
      stripped = true;
    }
    for (const [name, configuredValue] of Object.entries(configured)) {
      if (ownedNames === undefined || ownedNames.includes(name)) {
        let values = this.#protection.headers.get(name);
        if (!values) { values = new Set(); this.#protection.headers.set(name, values); }
        values.add(configuredValue);
      }
      outgoing[name] = configuredValue;
    }
    return {
      ...(url === undefined ? {} : { url }),
      ...(parsed.method === undefined ? {} : { method: parsed.method }),
      ...(parsed.postData === undefined ? {} : { postData: Buffer.from(parsed.postData as string).toString('base64') }),
      ...(replaced === undefined && site === undefined && !stripped ? {} : { headers: headerEntries(outgoing) }),
    };
  }

  /** Keeps a URL only until completion, including pre-response failures and reused redirect request ids. */
  #started(event: RequestStarted): void {
    if (event.redirectResponse) {
      this.#received({ requestId: event.requestId, response: event.redirectResponse });
      this.#bodies.get(event.requestId)?.reject(problem('Redirect response body is unavailable'));
      this.#bodies.delete(event.requestId);
    }
    this.#requests.set(event.requestId, event.request.url);
  }

  /** Resolves matched headers immediately; the body remains independently pending until loadingFinished. */
  #received(event: ResponseReceived): void {
    const matches = [...this.#waiters].filter((waiter) => waiter.matches(event.response.url));
    if (matches.length === 0) return;
    let resolveBody!: (value: string) => void;
    let rejectBody!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
    void promise.catch(() => undefined);
    this.#bodies.set(event.requestId, { promise, reading: false, resolve: resolveBody, reject: rejectBody });
    const text = (): Promise<string> => bounded(promise, this.#options.operation(), 'Response body');
    const response: WebResponse = Object.freeze({
      url: event.response.url,
      status: event.response.status,
      headers: responseHeaders(event.response.headers),
      text,
      json: async <T = unknown>(): Promise<T> => {
        const body = await text();
        try {
          // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
          return JSON.parse(body) as T;
        } catch { throw problem('Response body is not valid JSON'); }
      },
    });
    for (const waiter of matches) waiter.resolve(response);
  }

  /** Reads once only after completion; a protocol/body failure stays a failure on every future read. */
  #finished(requestId: string): void {
    this.#requests.delete(requestId);
    const body = this.#bodies.get(requestId);
    if (!body || body.reading) return;
    body.reading = true;
    try {
      void this.#connection.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }, this.#options.operation(), this.#sessionId)
        .then((response) => {
          if (typeof response.body !== 'string' || typeof response.base64Encoded !== 'boolean') throw problem('Response body could not be read');
          body.resolve(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
        }).catch(() => body.reject(problem('Response body could not be read'))).finally(() => {
          if (this.#bodies.get(requestId) === body) this.#bodies.delete(requestId);
        });
    } catch {
      body.reject(problem('Response body could not be read'));
      this.#bodies.delete(requestId);
    }
  }

  /** Distinguishes a failed matching request from a response that simply did not arrive in time. */
  #failed(requestId: string): void {
    const url = this.#requests.get(requestId);
    this.#requests.delete(requestId);
    const body = this.#bodies.get(requestId);
    this.#bodies.delete(requestId);
    body?.reject(problem('Request failed before its response body completed'));
    if (url !== undefined) {
      for (const waiter of this.#waiters) {
        if (waiter.matches(url)) waiter.reject(problem('Matching request failed before a response arrived'));
      }
    }
  }
}

/** Common fixture MIME types; unknown extensions are served as explicit binary bytes. */
function fileContentType(path: string): string {
  const types: Readonly<Record<string, string>> = {
    '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.txt': 'text/plain',
    '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.xml': 'application/xml',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

type TargetSession = {
  target: CdpTarget;
  sessionId: string;
  companion: NetworkCompanion;
  pageReady: Promise<void>;
  sync: Promise<void>;
  ready: Promise<void>;
  appliedVersion: number;
  appliedRoutes: { id: number; pattern: TextPattern; key: string }[];
  unsubscribe: (() => void)[];
  hooks: Map<TargetHook, Promise<void>>;
};

type TargetAttached = { sessionId: string; targetInfo: CdpTarget; waitingForDebugger: boolean };
type TargetHook = (target: CdpTarget, sessionId: string, context: OperationContext) => void | Promise<void>;

/** Copies the caller's pattern so later mutation cannot change newly attached targets' routes. */
function snapshotPattern(pattern: Pattern): TextPattern {
  if (typeof pattern === 'string') return { kind: 'string', value: pattern, exact: true };
  if (pattern instanceof RegExp) return { kind: 'regexp', source: pattern.source, flags: pattern.flags };
  return { ...pattern };
}

/**
 * Browser-wide route ownership, including popups and out-of-process frames. New targets pause until
 * interception is installed; response waits stay scoped to the page agent-browser has selected.
 */
export class NetworkHub {
  readonly #protection: NetworkProtection = { headers: new Map(), basic: new Set() };
  readonly #connection: CdpConnection;
  readonly #options: NetworkOptions;
  readonly #ownershipContextId: string | null | undefined;
  readonly #targets = new Map<string, TargetSession>();
  readonly #sessions = new Map<string, TargetSession>();
  readonly #routes: { id: number; pattern: TextPattern; handler: RouteHandler; key: string }[] = [];
  readonly #errors: Error[] = [];
  readonly #hooks = new Set<TargetHook>();
  readonly #probes = new Set<string>();
  readonly #probeSessions = new Map<string, string>();
  readonly #deferredAttachments = new Set<Promise<void>>();
  readonly #relatedTargets = new Map<string, Promise<void>>();
  #reservationCount = 0;
  #reservation: { promise: Promise<void>; release(): void } | undefined;
  readonly #unsubscribers: (() => void)[] = [];
  #version = 0;
  #routeId = 0;
  #active: TargetSession | undefined;
  #ready: Promise<void> | undefined;
  #closed = false;

  constructor(connection: CdpConnection, configuration: NetworkOptions) {
    if (configuration.defaultBrowserContextId !== undefined
      && (configuration.browserContextId !== null || typeof configuration.defaultBrowserContextId !== 'string'
        || !configuration.defaultBrowserContextId || /[\s\p{Cc}]/u.test(configuration.defaultBrowserContextId))) {
      throw problem('A verified default context identity requires exclusive default-context scope', 'INVALID_ARGUMENT');
    }
    this.#connection = connection;
    this.#options = { ...configuration };
    this.#ownershipContextId = configuration.defaultBrowserContextId ?? configuration.browserContextId;
    this.#unsubscribers.push(
      connection.on<TargetAttached>('Target.attachedToTarget', (event) => this.#attached(event)),
      connection.on<{ sessionId: string }>('Target.detachedFromTarget', (event) => this.#detached(event.sessionId)),
      connection.on<{ targetInfo: CdpTarget }>('Target.targetCreated', (event) => {
        if (this.#options.browserContextId !== undefined) void this.#watchRelated(event.targetInfo, this.#options.operation()).catch(() => undefined);
      }),
      connection.onClose(() => this.close()),
    );
  }

  /** Installs hooks before start to collect logs/dialogs on each target before it is resumed. */
  onTarget(handler: TargetHook): () => void {
    this.#hooks.add(handler);
    return () => { this.#hooks.delete(handler); };
  }

  /** Registers once-per-session setup for current and future documents, always before a new target resumes. */
  async registerSessionInitializer(
    initialize: (sessionId: string, targetId: string, context: OperationContext) => void | Promise<void>,
    context: OperationContext = this.#options.operation(),
  ): Promise<void> {
    if (this.#closed) throw problem('Network hub is closed');
    const hook: TargetHook = (target, sessionId, operation) => initialize(sessionId, target.targetId, operation);
    this.#hooks.add(hook);
    await bounded(Promise.all([...this.#targets.values()].map((target) => this.#applyHook(target, hook, context))).then(() => undefined), context, 'Target initialization');
  }

  /** Applies a configuration update to current documents; the registered initializer handles future ones. */
  async forEachSession(
    action: (sessionId: string, targetId: string, context: OperationContext) => void | Promise<void>,
    context: OperationContext,
  ): Promise<void> {
    if (this.#closed) throw problem('Network hub is closed');
    await bounded(Promise.all([...this.#targets.values()].map((target) => action(target.sessionId, target.target.targetId, context))).then(() => undefined), context, 'Target update');
  }

  /** Shared browsers discover first and attach only verified owned roots; foreign pages are never paused. */
  start(context: OperationContext): Promise<void> {
    if (this.#closed) return Promise.reject(problem('Network hub is closed'));
    this.#ready ??= (async () => {
      if (this.#options.browserContextId === undefined) {
        await this.#connection.send('Target.setAutoAttach', autoAttachOptions(), context);
      } else {
        await this.#connection.send('Target.setDiscoverTargets', { discover: true, filter: documentTargetFilter() }, context);
        const targets = await this.#connection.listTargets(context);
        await Promise.all(targets.map(target => this.#watchRelated(target, context)));
      }
      await this.#waitForTargets(context);
    })();
    return this.#ready;
  }

  /** Creates an exclusively owned blank state probe without user routes, scripts, diagnostics, or other initializers. */
  async createProbeTarget(context: OperationContext): Promise<string> {
    if (this.#closed) throw problem('Network hub is closed');
    await this.start(context);
    if (!this.#reservation) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      this.#reservation = { promise, release };
    }
    this.#reservationCount += 1;
    let targetId: string;
    try {
      const result = await this.#connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true, ...(this.#options.browserContextId ? { browserContextId: this.#options.browserContextId } : {}) }, context);
      if (typeof result.targetId !== 'string' || !result.targetId) throw problem('State probe target creation failed');
      targetId = result.targetId;
      this.#probes.add(targetId);
    } catch {
      // An unanswered create may still produce a target: never release it into user initialization.
      this.close();
      this.#connection.close();
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'State probe creation outcome is unknown; this attempt must end', { retryable: false });
    } finally {
      this.#reservationCount -= 1;
      if (this.#reservationCount === 0) {
        const reservation = this.#reservation;
        this.#reservation = undefined;
        reservation?.release();
      }
    }
    await bounded(Promise.all(this.#deferredAttachments).then(() => undefined), context, 'State probe attachment');
    return targetId;
  }

  /** Closes only a target this hub explicitly reserved for a state probe. */
  async releaseProbeTarget(targetId: string, context: OperationContext): Promise<void> {
    if (!this.#probes.has(targetId)) throw problem('Target is not an owned state probe', 'INVALID_ARGUMENT');
    const result = await this.#connection.send<{ success: boolean }>('Target.closeTarget', { targetId }, context);
    if (result.success !== true) throw problem('State probe target could not be closed');
    this.#probes.delete(targetId);
    this.#probeSessions.delete(targetId);
  }

  /** Finds the exact existing target's session without changing the selected response-wait target. */
  async sessionForTarget(targetId: string, context: OperationContext): Promise<string> {
    await this.start(context);
    if (this.#probes.has(targetId)) throw problem('State probes cannot become application targets');
    let target = this.#targets.get(targetId);
    if (!target) {
      const verified = (await this.#connection.listTargets(context)).find((entry) => entry.targetId === targetId);
      if (!verified || !this.#includes(verified)) throw problem('Selected target is outside this attempt');
      if (this.#options.browserContextId !== undefined) await this.#watchRelated(verified, context);
      target = this.#targets.get(targetId);
      if (!target) {
        const sessionId = await this.#connection.attachTarget(targetId, context);
        target = this.#targets.get(targetId);
        if (!target) {
          const info = (await this.#connection.listTargets(context)).find((entry) => entry.targetId === targetId);
          if (!info || !this.#includes(info)) throw problem('Selected target disappeared or is outside this attempt');
          target = this.#install({ sessionId, targetInfo: info, waitingForDebugger: false });
        }
      }
    }
    await bounded(target.ready, context, 'Network target attachment');
    if (this.#closed || this.#targets.get(targetId) !== target) throw problem('Selected network target is no longer available');
    return target.sessionId;
  }

  /** Binds new response waits to the exact page agent-browser selected. */
  async useTarget(targetId: string, context: OperationContext): Promise<string> {
    const sessionId = await this.sessionForTarget(targetId, context);
    this.#active = this.#sessions.get(sessionId);
    return sessionId;
  }

  /** Returns a currently attached session without any protocol work or target selection. */
  getSession(targetId: string): string | undefined { return this.#targets.get(targetId)?.sessionId; }

  /** Lists owned companion sessions for document metadata; never includes another client's sessions. */
  sessions(): readonly { targetId: string; sessionId: string; type: string }[] {
    return [...this.#targets.values()].map((target) => ({
      targetId: target.target.targetId, sessionId: target.sessionId, type: target.target.type,
    }));
  }

  /** Adds one route to all current and future page/frame sessions. */
  async route(pattern: Pattern, handler: RouteHandler, context: OperationContext): Promise<void> {
    if (typeof handler !== 'function') throw problem('A route handler is required', 'INVALID_ARGUMENT');
    const wire = snapshotPattern(pattern);
    const { key } = patternOf(wire);
    await this.start(context);
    this.#routes.push({ id: ++this.#routeId, pattern: wire, handler, key });
    this.#version += 1;
    await bounded(Promise.all([...this.#targets.values()].map((target) => this.#synchronize(target, context))).then(() => undefined), context, 'Route registration');
  }

  /** Removes matching registrations on every target, preserving already-running route chains. */
  async unroute(pattern: Pattern, context: OperationContext): Promise<void> {
    await this.start(context);
    const { key } = patternOf(pattern);
    for (let index = this.#routes.length - 1; index >= 0; index -= 1) {
      if (this.#routes[index]!.key === key) this.#routes.splice(index, 1);
    }
    this.#version += 1;
    await bounded(Promise.all([...this.#targets.values()].map((target) => this.#synchronize(target, context))).then(() => undefined), context, 'Route removal');
  }

  /** Matches the selected page only; switching tabs does not migrate an already registered wait. */
  waitForResponse(pattern: Pattern, context: OperationContext): Promise<WebResponse> {
    if (!this.#active || this.#closed) return Promise.reject(problem('An active network target is required'));
    return this.#active.companion.waitForResponse(pattern, context);
  }

  /** Drains event handlers across every target, including ones attached during an in-flight popup. */
  async settle(context: OperationContext): Promise<void> {
    await this.#waitForTargets(context);
    const settled = await Promise.allSettled([...this.#targets.values()].map((target) => target.companion.settle(context)));
    for (const outcome of settled) if (outcome.status === 'rejected') {
      this.#errors.push(outcome.reason instanceof Error ? outcome.reason : problem('Network handler failed'));
    }
    const error = this.#errors.shift();
    if (error) throw error;
  }

  /** Drops local subscriptions only; attempt teardown owns the browser process and connection. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    for (const target of this.#targets.values()) {
      target.companion.close();
      for (const unsubscribe of target.unsubscribe) unsubscribe();
    }
    this.#targets.clear();
    this.#sessions.clear();
    this.#active = undefined;
    this.#routes.length = 0;
    this.#hooks.clear();
    this.#probes.clear();
    this.#probeSessions.clear();
    this.#relatedTargets.clear();
    this.#reservation?.release();
    this.#reservation = undefined;
    this.#protection.headers.clear();
    this.#protection.basic.clear();
  }

  /** Target discovery is read-only; ownership and probe reservation precede every root attachment. */
  #watchRelated(target: CdpTarget, context: OperationContext): Promise<void> {
    if (this.#closed || (target.type !== 'page' && target.type !== 'webview') || !this.#includes(target)) return Promise.resolve();
    const existing = this.#relatedTargets.get(target.targetId);
    if (existing) return existing;
    const reserved = this.#reservation?.promise;
    const work = Promise.resolve().then(async () => {
      if (reserved) await reserved;
      if (this.#closed || this.#probes.has(target.targetId) || !this.#includes(target)) return;
      await this.#connection.send('Target.autoAttachRelated', {
        targetId: target.targetId, waitForDebuggerOnStart: true, filter: documentTargetFilter(),
      }, context);
    });
    this.#relatedTargets.set(target.targetId, work);
    this.#deferredAttachments.add(work);
    void work.catch(() => { if (!this.#closed) this.#errors.push(problem('Owned target could not be monitored safely')); })
      .finally(() => this.#deferredAttachments.delete(work));
    return work;
  }

  /** Captures attachment immediately so parent-target setup cannot race a child-target event. */
  #attached(event: TargetAttached): void {
    if (this.#closed || (event.targetInfo.type !== 'page' && event.targetInfo.type !== 'iframe' && event.targetInfo.type !== 'webview')) return;
    if (this.#sessions.has(event.sessionId)) return;
    if (!this.#includes(event.targetInfo)) {
      const work = this.#exclude(event);
      this.#deferredAttachments.add(work);
      void work.catch(() => { if (!this.#closed) this.#errors.push(problem('Foreign target could not be detached')); }).finally(() => this.#deferredAttachments.delete(work));
      return;
    }
    const existing = this.#targets.get(event.targetInfo.targetId);
    if (existing) {
      // State/pixel readers may explicitly attach an independent session to an owned target.
      // Do not detach their session or re-run user hooks; only release a duplicate auto-attach pause.
      if (event.waitingForDebugger) {
        const work = existing.ready.then(async () => {
          if (!this.#closed && this.#targets.get(event.targetInfo.targetId) === existing) await this.#connection.send('Runtime.runIfWaitingForDebugger', {}, this.#options.operation(), event.sessionId);
        });
        this.#deferredAttachments.add(work);
        void work.catch(() => { if (!this.#closed) this.#errors.push(problem('Additional target session could not resume')); }).finally(() => this.#deferredAttachments.delete(work));
      }
      return;
    }
    const reserved = this.#reservation?.promise;
    if (reserved || this.#probes.has(event.targetInfo.targetId)) {
      const work = (async () => {
        if (reserved) await reserved;
        if (this.#closed) return;
        if (this.#probes.has(event.targetInfo.targetId)) {
          this.#probeSessions.set(event.targetInfo.targetId, event.sessionId);
          if (event.waitingForDebugger) await this.#connection.send('Runtime.runIfWaitingForDebugger', {}, this.#options.operation(), event.sessionId);
        } else this.#install(event);
      })();
      this.#deferredAttachments.add(work);
      void work.catch(() => { if (!this.#closed) this.#errors.push(problem('Reserved target attachment failed')); }).finally(() => this.#deferredAttachments.delete(work));
      return;
    }
    this.#install(event);
  }

  /** Never enables page/network domains or invokes application hooks on an unowned context. */
  #includes(target: CdpTarget): boolean {
    if (this.#ownershipContextId !== undefined
      && (target.browserContextId ?? null) !== this.#ownershipContextId) return false;
    try { return this.#options.includeTarget?.(target) ?? true; }
    catch { return false; }
  }

  /** Releases only our auto-attach pause before dropping our foreign-target session. */
  async #exclude(event: TargetAttached): Promise<void> {
    const context = this.#options.operation();
    if (event.waitingForDebugger) await this.#connection.send('Runtime.runIfWaitingForDebugger', {}, context, event.sessionId);
    await this.#connection.send('Target.detachFromTarget', { sessionId: event.sessionId }, context);
  }

  /** Installs all interception and instrumentation before releasing a new renderer. */
  #install(event: TargetAttached): TargetSession {
    const existing = this.#targets.get(event.targetInfo.targetId);
    if (existing) return existing;
    const companion = new NetworkCompanion(this.#connection, event.sessionId, this.#options, this.#protection);
    const context = this.#options.operation();
    const target: TargetSession = {
      target: event.targetInfo,
      sessionId: event.sessionId,
      companion,
      pageReady: this.#connection.send<void>('Page.enable', {}, context, event.sessionId),
      sync: Promise.resolve(),
      ready: Promise.resolve(),
      appliedVersion: -1,
      appliedRoutes: [],
      unsubscribe: [],
      hooks: new Map(),
    };
    this.#targets.set(target.target.targetId, target);
    this.#sessions.set(target.sessionId, target);
    target.unsubscribe.push(
      this.#connection.on<TargetAttached>('Target.attachedToTarget', (child) => this.#attached(child), target.sessionId),
      this.#connection.on<{ sessionId: string }>('Target.detachedFromTarget', (child) => this.#detached(child.sessionId), target.sessionId),
    );
    target.ready = (async () => {
      await target.pageReady;
      if (!this.#live(target)) return;
      if (this.#options.browserContextId !== undefined) await this.#watchRelated(target.target, context);
      if (!this.#live(target)) return;
      await companion.start(context);
      if (!this.#live(target)) return;
      await this.#synchronize(target, context);
      if (!this.#live(target)) return;
      await this.#connection.send('Target.setAutoAttach', autoAttachOptions(), context, target.sessionId);
      // Routes and hooks can change while child attachment is awaiting its protocol reply.
      let initialized: Set<TargetHook>;
      do {
        await this.#synchronize(target, context);
        if (!this.#live(target)) return;
        initialized = new Set(this.#hooks);
        for (const hook of initialized) {
          if (!this.#live(target)) return;
          await this.#applyHook(target, hook, context);
        }
      } while (target.appliedVersion !== this.#version || [...this.#hooks].some((hook) => !initialized.has(hook)));
      if (this.#live(target) && event.waitingForDebugger) await this.#connection.send('Runtime.runIfWaitingForDebugger', {}, context, target.sessionId);
    })();
    void target.ready.catch(() => {
      if (!this.#closed && this.#sessions.has(target.sessionId)) this.#errors.push(problem('New network target could not be configured before resuming'));
    });
    return target;
  }

  /** Pending work belongs only to this hub generation and its original session. */
  #live(target: TargetSession): boolean { return !this.#closed && this.#sessions.get(target.sessionId) === target; }

  /** Shares one initialization promise when registration overlaps a still-attaching target. */
  #applyHook(target: TargetSession, hook: TargetHook, context: OperationContext): Promise<void> {
    let work = target.hooks.get(hook);
    if (!work) {
      work = target.pageReady.then(() => { if (this.#live(target) && this.#hooks.has(hook)) return hook(target.target, target.sessionId, context); });
      target.hooks.set(hook, work);
    }
    return work;
  }

  /** Serializes only short target configuration, never response waits or asynchronous route handlers. */
  #synchronize(target: TargetSession, context: OperationContext): Promise<void> {
    target.sync = target.sync.then(async () => {
      while (target.appliedVersion !== this.#version && !this.#closed && this.#sessions.has(target.sessionId)) {
        const version = this.#version;
        const routes = [...this.#routes];
        const desiredIds = new Set(routes.map((route) => route.id));
        const removedKeys = new Set<string>();
        for (const previous of target.appliedRoutes) {
          if (!desiredIds.has(previous.id) && !removedKeys.has(previous.key)) {
            await target.companion.unroute(previous.pattern, context);
            removedKeys.add(previous.key);
          }
        }
        target.appliedRoutes = target.appliedRoutes.filter((route) => !removedKeys.has(route.key));
        const appliedIds = new Set(target.appliedRoutes.map((route) => route.id));
        for (const route of routes) {
          if (!appliedIds.has(route.id)) {
            await target.companion.route(route.pattern, route.handler, context);
            target.appliedRoutes.push(route);
          }
        }
        target.appliedVersion = version;
      }
    });
    return target.sync;
  }

  /** Cleans a detached session without silently adopting a different active tab. */
  #detached(sessionId: string): void {
    const target = this.#sessions.get(sessionId);
    if (!target) return;
    target.companion.close();
    for (const unsubscribe of target.unsubscribe) unsubscribe();
    this.#sessions.delete(sessionId);
    this.#targets.delete(target.target.targetId);
    if (this.#active === target) this.#active = undefined;
  }

  /** Follows targets discovered while earlier targets initialize, bounded by the caller's deadline. */
  async #waitForTargets(context: OperationContext): Promise<void> {
    const endsAt = Date.now() + context.timeoutMs;
    let previous: Set<TargetSession>;
    do {
      await bounded(Promise.all(this.#deferredAttachments).then(() => undefined), {
        ...context, timeoutMs: Math.max(0, endsAt - Date.now()),
      }, 'Reserved target attachment');
      previous = new Set(this.#targets.values());
      await bounded(Promise.all([...previous].map((target) => target.ready)).then(() => undefined), {
        ...context, timeoutMs: Math.max(0, endsAt - Date.now()),
      }, 'Network target initialization');
    } while (this.#deferredAttachments.size > 0 || [...this.#targets.values()].some((target) => !previous.has(target)));
  }
}

/** Restricts auto-attachment to document targets; workers are outside browser.route's document contract. */
function autoAttachOptions(): Record<string, unknown> {
  return {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: documentTargetFilter(),
  };
}

function documentTargetFilter(): Record<string, unknown>[] {
  return [{ type: 'page', exclude: false }, { type: 'iframe', exclude: false }, { exclude: true }];
}
