import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable, Writable } from 'node:stream';
import { EngineError, type JsonValue, type OperationContext } from 'e2e/engine';
import { rejectedDecision } from './decision-outcome.ts';
import { NativeFrames } from './frames.ts';
import { MAX_FRAME_BYTES, MAX_TIMEOUT_MS, NATIVE_PROTOCOL, serverMessage, type NativeEvent, type NativeReady, type NativeResult, type ServerMessage } from './protocol.ts';

/** The native CLI proxy owns the actual daemon connection and browser lifecycle. */
export interface NativeChannel {
  readonly readable: Readable;
  readonly writable: Writable;
  dispose(): void;
  settle?(context: OperationContext): Promise<void>;
}
interface CallbackOwner { generation: number; identityScope: string | undefined; sequence: number; revoked: boolean; token: string; active: boolean; selected: boolean; expiresAt: number; epoch: number; timer?: ReturnType<typeof setTimeout> }
interface Pending {
  readonly kind: 'hello' | 'request' | 'decision' | 'cancel' | 'close';
  readonly operationSeq?: number;
  readonly callbackTransition?: number;
  readonly command?: string;
  readonly generation?: number;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: EngineError) => void;
  readonly clear: () => void;
  draining?: boolean;
}

/** One negotiated native client. No automatic reconnect, command replay, or engine-specific browser calls. */
export class NativeClient {
  private readonly frames = new NativeFrames(MAX_FRAME_BYTES);
  private readonly callback = new AsyncLocalStorage<CallbackOwner>();
  private callbackEpoch = 0;
  private transitionEpoch: number | undefined;
  private publishingEpoch: number | undefined;
  private publishingCommand: string | undefined;
  private readonly stagedEvents: { event: NativeEvent; bytes: number; arrived: number }[] = [];
  private readonly callbacks = new Set<CallbackOwner>();
  private readonly retiredCallbackScopes = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private ready: NativeReady | undefined;
  private failure: EngineError | undefined;
  private closed = false;
  private disposed = false;
  private nextId = 0;
  private operationSeq = 0;
  private eventSequence = 0;
  private activeEvents = 0;
  private eventBytes = 0;
  private settlingRequests = 0;

  private constructor(private readonly channel: NativeChannel, private readonly requiredCapabilities: readonly string[], private readonly onEvent: (event: NativeEvent) => void | Promise<void>) {
    channel.readable.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.frames.read(chunk)) this.receive(serverMessage(frame));
      } catch { this.fail('The native browser protocol became invalid'); }
    });
    channel.readable.on('end', () => {
      try { this.frames.end(); } catch { this.fail('The native browser response was incomplete'); }
      if (!this.closed) this.fail('The native browser connection ended before scope settlement');
    });
    channel.readable.on('error', () => this.fail('The native browser connection failed'));
    channel.writable.on('error', () => this.fail('The native browser connection failed'));
  }

  /** Negotiates capabilities before the caller is allowed to issue browser commands. */
  static async connect(channel: NativeChannel, capabilities: readonly string[], context: OperationContext, onEvent: (event: NativeEvent) => void | Promise<void>): Promise<NativeClient> {
    const client = new NativeClient(channel, capabilities, onEvent);
    const message = await client.exchange('hello', { type: 'hello', protocol: NATIVE_PROTOCOL, requiredCapabilities: capabilities }, context);
    if (message.type !== 'ready' || message.scopeState !== 'usable' || capabilities.some(item => !message.capabilities.includes(item))) {
      client.fail('The native browser does not satisfy the requested protocol capabilities', 'UNSUPPORTED_CAPABILITY');
      throw client.failure!;
    }
    client.ready = message;
    return client;
  }

  /** A capability-specific decoder found invalid data; the transport cannot be reused. */
  invalidate(): EngineError {
    return this.fail('The native browser response violated its capability contract');
  }

  /** Actual validated handshake evidence, not a manifest's claimed capability list. */
  negotiation(): Pick<NativeReady, 'protocol' | 'capabilities' | 'limits'> {
    this.assertUsable();
    return { protocol: this.ready!.protocol, capabilities: [...this.ready!.capabilities], limits: { ...this.ready!.limits } };
  }

  /** Captures only this invocation's native revocation state; does not grant new scope authority. */
  callbackRevocationGuard(): () => boolean {
    const owner = this.callback.getStore();
    return () => owner?.revoked !== true;
  }

  /** Captures callback ownership before a native lifecycle transition. */
  callbackCheckpoint(): number { this.assertUsable(); return this.callbackEpoch; }

  /** Called only after native settlement drained the old scope's decision tokens. */
  retireCallbacks(epoch: number, proof: 'selected' | 'scope-ended' | 'scope-reconnected' = 'selected'): void {
    this.assertUsable();
    if (epoch !== this.callbackEpoch || epoch === Number.MAX_SAFE_INTEGER || (proof !== 'selected' && this.publishingEpoch !== epoch)) throw this.invalidate();
    if ((proof === 'scope-ended' && this.publishingCommand !== 'scope.end') || (proof === 'scope-reconnected' && this.publishingCommand !== 'scope.reconnect')) throw this.invalidate();
    const retiring = [...this.callbacks].filter(callback => callback.epoch === epoch && callback.active);
    if (proof === 'selected' && retiring.some(callback => !callback.selected)) throw this.invalidate();
    for (const callback of retiring) {
      callback.active = false;
      if (callback.timer !== undefined) clearTimeout(callback.timer);
    }
    this.callbackEpoch++;
    if (this.publishingEpoch !== undefined && this.publishingEpoch !== epoch) throw this.invalidate();
    this.publishingEpoch = undefined; this.publishingCommand = undefined; this.transitionEpoch = undefined;
    for (const staged of this.stagedEvents.splice(0)) this.dispatchEvent(staged.event, staged.bytes, staged.arrived);
  }

  /** Dispatches exactly once; a transport timeout cannot turn an uncertain effect into a retry. */
  async request(command: string, args: Readonly<Record<string, JsonValue>>, context: OperationContext, callbackTransition?: number): Promise<NativeResult> {
    this.assertUsable();
    if (this.settlingRequests > 0) throw new EngineError('INVALID_STATE', 'The native browser is settling a cancelled operation', { retryable: false });
    if (this.pending.size >= Math.min(this.ready!.limits.maxPendingOperations, 64)) throw new EngineError('ENGINE_FAILURE', 'The native browser operation capacity was exceeded', { retryable: false });
    if (this.operationSeq === Number.MAX_SAFE_INTEGER) {
      this.fail('The native browser operation sequence was exhausted');
      throw this.failure!;
    }
    const callback = this.callback.getStore();
    if (callback !== undefined && !callback.active) throw new EngineError('INVALID_STATE', 'The native callback has already completed', { retryable: false });
    if (callback !== undefined) {
      context = { ...context, timeoutMs: Math.min(context.timeoutMs, callback.expiresAt - performance.now()) };
    }
    if (callbackTransition !== undefined) {
      if (callbackTransition !== this.callbackEpoch || this.transitionEpoch !== undefined) throw this.invalidate();
      this.transitionEpoch = callbackTransition;
    }
    const sequence = ++this.operationSeq;
    let message: ServerMessage;
    try {
      message = await this.exchange('request', { type: 'request', generation: this.ready!.generation, operationSeq: sequence, timeoutMs: this.timeout(context), command, args, ...(callback === undefined || callback.selected ? {} : { callbackToken: callback.token }) }, context, sequence, callbackTransition);
    } catch (cause) {
      if (callbackTransition !== undefined && this.publishingEpoch === undefined && this.transitionEpoch === callbackTransition) this.transitionEpoch = undefined;
      throw cause;
    }
    if (message.type !== 'result') throw this.fail('The native browser returned an unexpected operation response');
    return message;
  }

  /** Answers a native decision token on the independent control lane, even while an action is pending. */
  async decide(token: string, decision: Readonly<Record<string, JsonValue>>, context: OperationContext): Promise<void> {
    this.assertUsable();
    const owner = this.callback.getStore();
    if (owner !== undefined && !owner.active) throw new EngineError('INVALID_STATE', 'The native callback has already completed', { retryable: false });
    if (Array.from(this.pending.values()).filter(item => item.kind === 'decision').length >= Math.min(this.ready!.limits.maxPendingDecisions, 256)) throw new EngineError('ENGINE_FAILURE', 'The native browser decision capacity was exceeded', { retryable: false });
    const message = await this.exchange('decision', { type: 'decision', generation: this.ready!.generation, token, decision }, context);
    if (message.type !== 'control-result') throw this.invalidate();
    if (!message.accepted) throw rejectedDecision(new EngineError('ENGINE_FAILURE', 'The native browser rejected an expired or invalid decision', { retryable: false }));
    const callback = this.callback.getStore();
    if (callback?.token === token) callback.selected = true;
  }

  /** Requires explicit native scope closure; killing a proxy alone is not successful browser cleanup. */
  async close(context: OperationContext): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed) return;
    const started = performance.now();
    this.assertUsable();
    const message = await this.exchange('close', { type: 'close', generation: this.ready!.generation }, context);
    if (message.type !== 'closed') throw this.fail('The native browser did not confirm scope closure');
    this.closed = true;
    try {
      await this.channel.settle?.({ ...context, timeoutMs: Math.max(0, context.timeoutMs - (performance.now() - started)) });
    } catch {
      throw this.fail('The native browser proxy did not finish acknowledged cleanup');
    } finally { this.dispose(); }
  }

  private assertUsable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.closed || this.ready === undefined) throw new EngineError('INVALID_STATE', 'The native browser session is not available', { retryable: false });
  }

  private timeout(context: OperationContext): number {
    if (context.signal.aborted) throw new EngineError('CANCELLED', 'The native browser operation was cancelled before dispatch', { retryable: false });
    if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'The native browser operation budget expired before dispatch', { retryable: false });
    return Math.min(Math.ceil(context.timeoutMs), this.ready?.limits.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  }

  private exchange(kind: Pending['kind'], message: Readonly<Record<string, unknown>>, context: OperationContext, operationSeq?: number, callbackTransition?: number): Promise<ServerMessage> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.pending.size >= 322) return Promise.reject(new EngineError('ENGINE_FAILURE', 'The native browser protocol capacity was exceeded', { retryable: false }));
    let timeout: number;
    let bytes: Buffer;
    if (this.nextId === Number.MAX_SAFE_INTEGER) return Promise.reject(this.fail('The native browser request identity was exhausted'));
    const id = `c${++this.nextId}`;
    try {
      timeout = this.timeout(context);
      bytes = Buffer.from(`${JSON.stringify({ ...message, id })}\n`);
      if (bytes.length - 1 > Math.min(MAX_FRAME_BYTES, this.ready?.limits.maxFrameBytes ?? MAX_FRAME_BYTES) || this.channel.writable.writableLength + bytes.length > 4 * MAX_FRAME_BYTES) throw new Error('bounded write');
    } catch (cause) {
      return Promise.reject(cause instanceof EngineError ? cause : new EngineError('ENGINE_FAILURE', 'The native browser request exceeded its protocol bounds', { retryable: false }));
    }
    return new Promise((resolve, reject) => {
      let settlementTimer: ReturnType<typeof setTimeout> | undefined;
      let cancellation: 'CANCELLED' | 'OPERATION_TIMEOUT' | undefined;
      let settled: ServerMessage | undefined;
      let cancelAcknowledged = false;
      let finished = false;
      const complete = () => {
        if (finished || settled === undefined || (cancellation !== undefined && !cancelAcknowledged && !(settled.type === 'result' && settled.effects === 'unknown'))) return;
        finished = true;
        this.pending.delete(id); clear();
        if (cancellation !== undefined) this.settlingRequests--;
        // A local deadline may race the native cancellation signal. Only a reusable,
        // definitive failure can preserve the caller's original timeout reason.
        if (cancellation === 'OPERATION_TIMEOUT' && settled.type === 'result' && !settled.ok && settled.effects !== 'unknown' && settled.scopeState === 'usable' && (settled.error?.code === 'cancelled' || settled.error?.code === 'deadline-exceeded')) {
          settled = { ...settled, error: { code: 'deadline-exceeded' } };
        }
        resolve(settled);
      };
      const abandon = (code: 'CANCELLED' | 'OPERATION_TIMEOUT') => {
        const pending = this.pending.get(id);
        if (pending === undefined || cancellation !== undefined) return;
        if (kind !== 'request' || operationSeq === undefined || this.ready === undefined) {
          this.fail('The native browser operation ended without a settled outcome', code); return;
        }
        cancellation = code; pending.draining = true; this.settlingRequests++;
        clearTimeout(timer); context.signal.removeEventListener('abort', abort);
        // Cleanup/settlement only: the original native deadline is never extended.
        settlementTimer = setTimeout(() => this.fail('The native browser operation ended without a settled outcome', code), 5000);
        void this.exchange('cancel', { type: 'cancel', generation: this.ready.generation, operationSeq }, { ...context, signal: new AbortController().signal, timeoutMs: 5000 }).then(() => {
          cancelAcknowledged = true; complete();
        }).catch(() => { if (!finished) this.fail('The native browser cancellation did not settle', code); });
      };
      const abort = () => abandon('CANCELLED');
      const timer = setTimeout(() => abandon('OPERATION_TIMEOUT'), timeout);
      const clear = () => { clearTimeout(timer); if (settlementTimer !== undefined) clearTimeout(settlementTimer); context.signal.removeEventListener('abort', abort); };
      const accept = (reply: ServerMessage) => {
        if (settled !== undefined) throw new Error('duplicate operation result');
        settled = reply; complete();
      };
      this.pending.set(id, { kind, ...(typeof message['command'] === 'string' ? { command: message['command'] } : {}), ...(callbackTransition === undefined ? {} : { callbackTransition }), ...(operationSeq === undefined ? {} : { operationSeq }), ...(this.ready === undefined ? {} : { generation: this.ready.generation }), resolve: accept, reject, clear });
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) { abort(); return; }
      try { this.channel.writable.write(bytes); } catch { this.fail('The native browser request could not be delivered'); }
    });
  }

  private receive(message: ServerMessage): void {
    if (this.failure !== undefined || this.closed) return;
    if (message.type === 'event') {
      if (this.ready === undefined || message.generation !== this.ready.generation || message.sequence !== this.eventSequence + 1) throw new Error('event order');
      this.eventSequence = message.sequence;
      if (message.event === 'scope.callbacks-retired') { this.retireProvenCallbacks(message); return; }
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (++this.activeEvents > Math.min(this.ready.limits.maxPendingDecisions, 256) || this.eventBytes + bytes > 4 * MAX_FRAME_BYTES) throw new Error('event capacity');
      this.eventBytes += bytes;
      const arrived = performance.now();
      if (this.publishingEpoch !== undefined) this.stagedEvents.push({ event: message, bytes, arrived });
      else this.dispatchEvent(message, bytes, arrived);
      return;
    }
    if (message.type === 'error') throw new Error('native protocol refusal');
    const pending = this.pending.get(message.id);
    if (pending === undefined || (pending.generation !== undefined && message.generation !== pending.generation)) throw new Error('response correlation');
    const expected = pending.kind === 'hello' ? 'ready' : pending.kind === 'request' ? 'result' : pending.kind === 'close' ? 'closed' : 'control-result';
    if (message.type !== expected || (message.type === 'result' && message.operationSeq !== pending.operationSeq)) throw new Error('response kind');
    if (message.type === 'ready') {
      if (message.scopeState !== 'usable') throw new Error('capability scope');
      if (this.requiredCapabilities.some(item => !message.capabilities.includes(item))) { this.fail('The native browser does not satisfy the requested protocol capabilities', 'UNSUPPORTED_CAPABILITY'); return; }
      this.frames.limit(Math.min(MAX_FRAME_BYTES, message.limits.maxFrameBytes));
      this.ready = message;
    }
    if (!pending.draining) { this.pending.delete(message.id); pending.clear(); }
    if (message.type === 'closed') {
      this.closed = true;
      for (const other of this.pending.values()) { other.clear(); other.reject(new EngineError('CANCELLED', 'The native browser scope closed', { retryable: false })); }
      this.pending.clear();
    }
    if (pending.callbackTransition !== undefined && message.type === 'result') {
      if (message.ok) { this.publishingEpoch = pending.callbackTransition; this.publishingCommand = pending.command; }
      else this.transitionEpoch = undefined;
    }
    pending.resolve(message);
    if (message.scopeState === 'quarantined' || (message.scopeState === 'closed' && message.type !== 'closed')) this.fail('The native browser scope is no longer reusable');
  }

  /** Terminal proof is consumed on the framing stack, before queued user callbacks can run. */
  private retireProvenCallbacks(message: NativeEvent): void {
    const payload = message.payload;
    if (message.decision !== undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || !('identityScope' in payload) || !('throughEventSequence' in payload) || typeof payload['identityScope'] !== 'string' || payload['identityScope'].length === 0 || Buffer.byteLength(payload['identityScope']) > 128
      || !Number.isSafeInteger(payload['throughEventSequence']) || payload['throughEventSequence'] !== message.sequence - 1) throw new Error('invalid callback retirement proof');
    const scope = payload['identityScope']; const through = message.sequence - 1;
    if (this.retiredCallbackScopes.has(scope) || this.retiredCallbackScopes.size >= 4096) throw new Error('callback retirement capacity or duplicate');
    this.retiredCallbackScopes.set(scope, through);
    for (const owner of this.callbacks) {
      if (owner.generation !== message.generation || owner.identityScope !== scope || owner.sequence > through) continue;
      owner.revoked = true; owner.active = false;
      if (owner.timer !== undefined) clearTimeout(owner.timer);
    }
  }

  /** Post-ACK events wait for adapter publication, without delaying pre-ACK decisions. */
  private dispatchEvent(message: NativeEvent, bytes: number, arrived: number): void {
    const identityScope = message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload) && 'identityScope' in message.payload && typeof message.payload['identityScope'] === 'string' ? message.payload['identityScope'] : undefined;
    if (message.decision !== undefined && identityScope !== undefined && this.retiredCallbackScopes.has(identityScope)) {
      this.activeEvents--; this.eventBytes -= bytes;
      if (message.sequence > this.retiredCallbackScopes.get(identityScope)!) this.fail('The native browser emitted a callback after terminal retirement');
      return;
    }
    const callback: CallbackOwner | undefined = message.decision === undefined ? undefined : { generation: message.generation, identityScope, sequence: message.sequence, revoked: false, token: message.decision.token, active: true, selected: false, expiresAt: arrived + message.decision.timeoutMs, epoch: this.callbackEpoch };
    if (callback !== undefined) this.callbacks.add(callback);
    const callbackTimer = callback === undefined ? undefined : setTimeout(() => {
      if (!callback.active) return;
      callback.active = false;
      if (!this.closed) this.fail('The native browser callback exceeded its operation budget', 'OPERATION_TIMEOUT');
    }, Math.max(0, callback.expiresAt - performance.now()));
    if (callback !== undefined && callbackTimer !== undefined) callback.timer = callbackTimer;
    callbackTimer?.unref();
    void Promise.resolve().then(() => {
      if (this.failure !== undefined || this.closed || this.ready?.generation !== message.generation || callback?.revoked) return;
      if (callback !== undefined && callback.expiresAt <= performance.now()) {
        callback.active = false; this.fail('The native browser callback exceeded its operation budget', 'OPERATION_TIMEOUT'); return;
      }
      return callback === undefined ? this.onEvent(message) : this.callback.run(callback, () => this.onEvent(message));
    }).catch(() => { if (callback === undefined || (!callback.revoked && callback.epoch === this.callbackEpoch)) this.fail('The native browser event handler failed'); }).finally(() => { if (callbackTimer !== undefined) clearTimeout(callbackTimer); if (callback !== undefined) { callback.active = false; this.callbacks.delete(callback); } this.activeEvents--; this.eventBytes -= bytes; });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.channel.dispose(); } catch { /* The scope remains unusable; never interpret proxy failure as browser settlement. */ }
  }

  private fail(message: string, code: 'ENGINE_FAILURE' | 'CANCELLED' | 'OPERATION_TIMEOUT' | 'UNSUPPORTED_CAPABILITY' = 'ENGINE_FAILURE'): EngineError {
    this.failure ??= new EngineError(code, message, { retryable: false });
    this.stagedEvents.length = 0; this.publishingEpoch = undefined; this.publishingCommand = undefined; this.transitionEpoch = undefined;
    for (const pending of this.pending.values()) { pending.clear(); pending.reject(this.failure); }
    this.pending.clear();
    this.dispose();
    return this.failure;
  }
}
