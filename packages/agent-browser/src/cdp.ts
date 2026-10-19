/** Public Chromium CDP transport for capabilities absent from the agent-browser CLI. */
import { EngineError, type OperationContext } from 'e2e/engine';

type Pending = {
  method: string;
  resolve(value: unknown): void;
  reject(error: EngineError): void;
  cleanup(): void;
};

type Subscription = {
  method: string;
  sessionId: string | undefined;
  handler: (params: Record<string, unknown>) => void;
};

export interface CdpTarget {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly browserContextId?: string;
}

const existingOverrides = new WeakMap<Error, 'locale' | 'timezone'>();

/** Recognizes two fixed Chromium responses without retaining arbitrary protocol error text. */
export function isExistingEmulationOverride(error: unknown, kind: 'locale' | 'timezone'): boolean {
  return error instanceof Error && existingOverrides.get(error) === kind;
}

/** Locale and timezone overrides can already belong to another page in the same renderer. */
function protocolFailure(method: string, payload: unknown): EngineError {
  const error = failure('CDP command failed');
  const message = typeof payload === 'object' && payload !== null && 'message' in payload ? payload.message : undefined;
  if (method === 'Emulation.setLocaleOverride' && message === 'Another locale override is already in effect') existingOverrides.set(error, 'locale');
  if (method === 'Emulation.setTimezoneOverride' && message === 'Timezone override is already in effect') existingOverrides.set(error, 'timezone');
  return error;
}

/** Fixed diagnostics deliberately omit endpoint, protocol payload, and browser-supplied text. */
function failure(message: string): EngineError {
  return new EngineError('ENGINE_FAILURE', message, { retryable: false });
}

/** An expired operation and caller cancellation keep distinct public error codes. */
function cancellation(): EngineError {
  return new EngineError('CANCELLED', 'CDP operation cancelled', { retryable: false });
}

/** Resolves a public discovery endpoint without giving discovery a fresh connection budget. */
async function websocketEndpoint(endpoint: string, context: OperationContext): Promise<string> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw failure('Invalid CDP endpoint'); }
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('Unsupported CDP endpoint scheme');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, context.timeoutMs));
  try {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/json/version`;
    const response = await fetch(url, { signal: AbortSignal.any([context.signal, controller.signal]) });
    if (!response.ok) throw failure('CDP discovery failed');
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null || !('webSocketDebuggerUrl' in value)
      || typeof value.webSocketDebuggerUrl !== 'string') throw failure('CDP discovery returned no WebSocket endpoint');
    const discovered = new URL(value.webSocketDebuggerUrl);
    if (discovered.protocol !== 'ws:' && discovered.protocol !== 'wss:') throw failure('Invalid CDP discovery endpoint');
    return discovered.href;
  } catch {
    if (context.signal.aborted) throw cancellation();
    if (controller.signal.aborted) throw new EngineError('OPERATION_TIMEOUT', 'CDP connection timed out', { retryable: false });
    throw failure('CDP discovery failed');
  } finally { clearTimeout(timer); }
}

/** One multiplexed socket, never a command queue: events and concurrent commands remain independent. */
export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #subscriptions = new Set<Subscription>();
  readonly #closeHandlers = new Set<() => void>();
  #nextId = 0;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event: MessageEvent<unknown>) => this.#message(event.data));
    socket.addEventListener('close', () => this.#terminate());
    socket.addEventListener('error', () => this.#terminate());
  }

  /** Rejects non-Chromium CDP emulators before context creation, rendering, or other capability use. */
  async verifyChromium(context: OperationContext): Promise<void> {
    let version: { product?: unknown; protocolVersion?: unknown };
    try { version = await this.send('Browser.getVersion', {}, context); }
    catch (error) {
      if (error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT')) throw error;
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'The remote browser does not expose the required Chromium protocol', { retryable: false });
    }
    if (typeof version.product !== 'string' || !/^(?:Chrome|HeadlessChrome|Chromium)\/\d+(?:\.\d+){1,3}$/.test(version.product)
      || typeof version.protocolVersion !== 'string' || !/^\d+\.\d+$/.test(version.protocolVersion)) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'The agent-browser engine requires an actual Chromium browser', { retryable: false });
    }
  }

  /** Connects to a browser WebSocket or its public HTTP discovery endpoint. */
  static async connect(endpoint: string, context: OperationContext): Promise<CdpConnection> {
    if (context.signal.aborted) throw cancellation();
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'CDP connection timed out before dispatch', { retryable: false });
    const endsAt = Date.now() + context.timeoutMs;
    const address = await websocketEndpoint(endpoint, context);
    if (context.signal.aborted) throw cancellation();
    const remaining = endsAt - Date.now();
    if (remaining <= 0) throw new EngineError('OPERATION_TIMEOUT', 'CDP connection timed out', { retryable: false });
    let socket: WebSocket;
    try { socket = new WebSocket(address); } catch { throw failure('CDP connection failed'); }
    const connection = new CdpConnection(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          context.signal.removeEventListener('abort', aborted);
          socket.removeEventListener('open', opened);
          socket.removeEventListener('error', failed);
          socket.removeEventListener('close', failed);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(failure('CDP connection failed')); };
        const aborted = () => { cleanup(); reject(cancellation()); };
        const timer = setTimeout(() => {
          cleanup();
          reject(new EngineError('OPERATION_TIMEOUT', 'CDP connection timed out', { retryable: false }));
        }, remaining);
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('close', failed, { once: true });
        context.signal.addEventListener('abort', aborted, { once: true });
        if (context.signal.aborted) aborted();
      });
      return connection;
    } catch (error) { connection.close(); throw error; }
  }

  /** Sends one independently bounded protocol command on the browser or a flattened target session. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    context: OperationContext,
    sessionId?: string,
  ): Promise<T> {
    if (context.signal.aborted) return Promise.reject(cancellation());
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) return Promise.reject(new EngineError('OPERATION_TIMEOUT', 'CDP operation timed out', { retryable: false }));
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(failure('CDP connection is closed'));
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const rejectPending = (error: EngineError) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const aborted = () => rejectPending(cancellation());
      const timer = setTimeout(() => rejectPending(new EngineError(
        'OPERATION_TIMEOUT', 'CDP operation timed out; the command may have been dispatched', { retryable: false },
      )), Math.min(context.timeoutMs, 2_147_483_647));
      this.#pending.set(id, {
        method,
        // The type parameter is a caller-owned protocol contract; no browser value enters diagnostics.
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => { clearTimeout(timer); context.signal.removeEventListener('abort', aborted); },
      });
      context.signal.addEventListener('abort', aborted, { once: true });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })); }
      catch { rejectPending(failure('CDP command could not be sent')); }
    });
  }

  /** Subscribes to one exact session; omitting the session subscribes to browser-level events only. */
  on<T extends object = Record<string, unknown>>(method: string, handler: (params: T) => void, sessionId?: string): () => void {
    const subscription: Subscription = { method, sessionId, handler: (params) => handler(params as T) };
    this.#subscriptions.add(subscription);
    return () => { this.#subscriptions.delete(subscription); };
  }

  /** Lets event-based waiters fail immediately when their transport ends. */
  onClose(handler: () => void): () => void {
    if (this.#closed) { handler(); return () => undefined; }
    this.#closeHandlers.add(handler);
    return () => { this.#closeHandlers.delete(handler); };
  }

  /** Lists existing targets on this browser; never creates or adopts a different browser. */
  async listTargets(context: OperationContext): Promise<readonly CdpTarget[]> {
    const result = await this.send<{ targetInfos: CdpTarget[] }>('Target.getTargets', {}, context);
    if (!Array.isArray(result.targetInfos)) throw failure('CDP target listing was invalid');
    return result.targetInfos;
  }

  /** Attaches the exact page id from agent-browser, or a verified iframe id from that page's frame tree. */
  async attachTarget(targetId: string, context: OperationContext): Promise<string> {
    if (!targetId) throw failure('The active agent-browser target is required');
    const endsAt = Date.now() + context.timeoutMs;
    const targets = await this.listTargets(context);
    if (!targets.some((target) => target.targetId === targetId && (target.type === 'page' || target.type === 'webview' || target.type === 'iframe'))) {
      throw new EngineError('INVALID_STATE', 'The active agent-browser target is no longer available', { retryable: false });
    }
    const result = await this.send<{ sessionId: string }>(
      'Target.attachToTarget', { targetId, flatten: true },
      { ...context, timeoutMs: Math.max(0, endsAt - Date.now()) },
    );
    if (typeof result.sessionId !== 'string' || !result.sessionId) throw failure('CDP target attachment failed');
    return result.sessionId;
  }

  /** Closes only this companion socket; the owner controls browser and agent-browser lifecycle. */
  close(): void {
    this.#terminate();
    try { this.#socket.close(); } catch { /* Already disconnected or still connecting. */ }
  }

  /** Delivers responses by id and events by session without blocking either channel. */
  #message(data: unknown): void {
    if (this.#closed) return;
    let message: Record<string, unknown>;
    try {
      if (typeof data !== 'string') throw new Error();
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { this.close(); return; }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error !== undefined) pending.reject(protocolFailure(pending.method, message.error));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = typeof message.params === 'object' && message.params !== null
      ? message.params as Record<string, unknown> : {};
    // Snapshot: a callback may add/remove listeners while this event is being delivered.
    // oxlint-disable-next-line unicorn/no-useless-spread -- subscriptions added mid-event start with the next event
    for (const entry of [...this.#subscriptions]) {
      if (entry.method === message.method && entry.sessionId === message.sessionId) {
        try { entry.handler(params); } catch { /* Event consumers own and report their asynchronous failures. */ }
      }
    }
  }

  /** Rejects pending commands and notifies all waiters exactly once. */
  #terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(failure('CDP connection closed during an operation'));
    }
    this.#pending.clear();
    this.#subscriptions.clear();
    for (const handler of this.#closeHandlers) {
      try { handler(); } catch { /* Closing must still release the remaining listeners. */ }
    }
    this.#closeHandlers.clear();
  }
}
