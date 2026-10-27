import { DISCONNECTED_RECOVERY_CAPABILITY, TERMINAL_RECORDING_CAPABILITY } from './capabilities.ts';
import { collectFinalizedRecording, type FinalizedRecordingIdentity, type FinalizedVideoBytes, type FinalizedVideoSnapshot, type FinalizedRecordingCommand } from './finalized-recording.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable, Writable } from 'node:stream';
import { EngineError, type JsonValue, type OperationContext } from 'e2e/engine';
import { connectionCancellation, connectionDeadline } from '../operation-budget.ts';
import { rejectedDecision } from './decision-outcome.ts';
import { NativeFrameError, NativeFrames } from './frames.ts';
import { acceptanceIo, type AcceptanceTrace, type AcceptanceReason } from './acceptance-trace.ts';
import { MAX_FRAME_BYTES, MAX_TIMEOUT_MS, NATIVE_PROTOCOL, serverMessage, type NativeEvent, type NativeReady, type NativeResult, type ServerMessage } from './protocol.ts';

// Only a validated closed frame can mint this local cancellation. It is not
// an actual failed operation receipt, nor proof of transport/lease settlement.
const closedFrameCancellations = new WeakSet<EngineError>();
export function isClosedFrameCancellation(cause: unknown): boolean {
  return cause instanceof EngineError && closedFrameCancellations.has(cause);
}

/** The native CLI proxy owns the actual daemon connection and browser lifecycle. */
export interface NativeChannel {
  readonly readable: Readable;
  readonly writable: Writable;
  /** Internal acceptance seam, never exported from the engine entry point. */
  readonly acceptanceTrace?: AcceptanceTrace;
  dispose(): void;
  settle?(context: OperationContext): Promise<void>;
}
interface CallbackOwner { generation: number; identityScope: string | undefined; sequence: number; revoked: boolean; token: string; active: boolean; selected: boolean; expiresAt: number; epoch: number; timer?: ReturnType<typeof setTimeout> }
interface Pending {
  readonly kind: 'hello' | 'request' | 'artifact' | 'decision' | 'cancel' | 'close';
  readonly operationSeq?: number;
  readonly cancelTarget?: number;
  readonly callbackToken?: string;
  readonly callbackTransition?: number;
  readonly command?: string;
  readonly identityScope?: string;
  readonly generation?: number;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: EngineError) => void;
  readonly clear: () => void;
  readonly settlement: Promise<void>;
  draining?: boolean;
  quarantined?: boolean;
}

interface CallbackTransition {
  readonly epoch: number;
  readonly scope: string | undefined;
  readonly command: string;
  readonly retired: Promise<boolean>;
  complete(retired: boolean): void;
}

type ReceiveFailureKind = 'event-order' | 'response-correlation' | 'response-kind' | 'callback-proof' | 'capacity' | 'native-refusal';
/** Local closed classification only. Native refusal codes have already passed serverMessage validation. */
class ReceiveFailure extends Error {
  constructor(readonly kind: ReceiveFailureKind, readonly code?: string) { super(kind); }
}

/** One negotiated native client. No automatic reconnect, command replay, or engine-specific browser calls. */
export class NativeClient {
  private readonly frames = new NativeFrames(MAX_FRAME_BYTES);
  private readonly callback = new AsyncLocalStorage<CallbackOwner>();
  private callbackEpoch = 0;
  private publicationEpoch = 0;
  private retirementHandler: (() => void) | undefined;
  private transition: CallbackTransition | undefined;
  private publishingEpoch: number | undefined;
  private publishingCommand: string | undefined;
  private readonly stagedEvents: { event: NativeEvent; bytes: number; arrived: number }[] = [];
  private readonly callbacks = new Set<CallbackOwner>();
  private readonly retiredCallbackScopes = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private ready: NativeReady | undefined;
  private failure: EngineError | undefined;
  private closed = false;
  private terminal = false;
  private terminalCleanupStarted: number | undefined;
  private explicitClose = false;
  private terminalArtifactSeq = 0;
  private finalizedRecordingHandler: ((owner: FinalizedRecordingIdentity, bytes: Promise<readonly FinalizedVideoBytes[]>, endsAt: number, snapshot: () => FinalizedVideoSnapshot) => void) | undefined;
  private recovery: { readonly scope: string; readonly operationSeq: number; claimed: boolean } | undefined;
  // Historical local handle fence only, never native admission authority.
  // Unlike callbackEpoch, ordinary same-scope restart does not change it.
  private recoveryRetirementSequence = 0;
  private closing: Promise<void> | undefined;
  private disposed = false;
  private nextId = 0;
  private operationSeq = 0;
  private eventSequence = 0;
  private activeEvents = 0;
  private eventBytes = 0;
  private settlingRequests = 0;

  private constructor(private readonly channel: NativeChannel, private readonly requiredCapabilities: readonly string[], private readonly onEvent: (event: NativeEvent) => void | Promise<void>) {
    channel.readable.on('data', (chunk: Buffer) => {
      channel.acceptanceTrace?.observe('ReceiveChunk', { length: chunk.length, failed: this.failure !== undefined });
      try {
        for (const frame of this.frames.read(chunk)) {
          channel.acceptanceTrace?.observe('FrameComplete');
          let message: ServerMessage;
          try { message = serverMessage(frame, this.requiredCapabilities.filter(capability => this.ready?.capabilities.includes(capability))); }
          catch { channel.acceptanceTrace?.observe('FrameRefused', { reason: 'schema' }); this.fail('The native browser protocol became invalid (schema)'); return; }
          try { this.receive(message); }
          catch (cause) {
            channel.acceptanceTrace?.observe('FrameRefused', { reason: cause instanceof ReceiveFailure ? cause.kind : 'receive' });
            const reason = cause instanceof ReceiveFailure ? `${cause.kind}${cause.code === undefined ? '' : `:${cause.code}`}` : 'receive';
            this.fail(`The native browser protocol became invalid (${reason})`); return;
          }
        }
      } catch (cause) { channel.acceptanceTrace?.observe('FrameRefused', { reason: cause instanceof NativeFrameError ? cause.kind : 'parse' }); this.fail('The native browser protocol became invalid (frame)'); }
    });
    channel.readable.on('end', () => {
      const framing = this.frames.acceptanceState();
      channel.acceptanceTrace?.observe('ReceiveEof', { ...framing, clean: !framing.failed && framing.pendingBytes === 0 });
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

  /** Snapshot local publication freshness without changing native owner identity or admission. */
  publicationCheckpoint(): number { return this.publicationEpoch; }

  /** Installs the owning surface's synchronous cache invalidation, before result resolution. */
  onOperationRetired(handler: () => void): void { this.retirementHandler = handler; }

  /** Installs synchronous same-attempt ownership before the original failure is observed. */
  onFinalizedRecording(handler: (owner: FinalizedRecordingIdentity, bytes: Promise<readonly FinalizedVideoBytes[]>, endsAt: number, snapshot: () => FinalizedVideoSnapshot) => void): void { this.finalizedRecordingHandler = handler; }

  /** Captures only this invocation's native revocation state; does not grant new scope authority. */
  callbackRevocationGuard(): () => boolean {
    const owner = this.callback.getStore();
    const ownsRecovery = this.recoveryRevocationGuard();
    return () => ownsRecovery() && owner?.revoked !== true;
  }

  /** Keep handle cleanup through ordinary restart, but never across an EOF recovery. */
  recoveryRevocationGuard(): () => boolean {
    const sequence = this.recoveryRetirementSequence;
    return () => this.recoveryRetirementSequence === sequence && this.recovery === undefined && !this.awaitingQuarantinedResult();
  }

  /** Captures callback ownership before a native lifecycle transition. */
  callbackCheckpoint(): number { this.assertUsable(); return this.callbackEpoch; }

  recoveryScope(): string | undefined { return this.recovery?.scope; }

  /** Restricted lifecycle checkpoint; it does not restore ordinary commands. */
  reconnectCheckpoint(scope: string): number {
    if (this.recovery === undefined) return this.callbackCheckpoint();
    if (this.failure !== undefined) throw this.failure;
    if (this.terminal || this.closed || this.closing !== undefined || this.recovery.claimed || this.recovery.scope !== scope || this.callback.getStore() !== undefined) throw new EngineError('INVALID_STATE', 'The native recovery authority is not available', { retryable: false });
    return this.callbackEpoch;
  }

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
    const replacementPublished = this.publishingEpoch === epoch && (this.publishingCommand === 'scope.reset' || this.publishingCommand === 'state.restore');
    this.publishingEpoch = undefined; this.publishingCommand = undefined; this.completeTransition(replacementPublished);
    for (const staged of this.stagedEvents.splice(0)) this.dispatchEvent(staged.event, staged.bytes, staged.arrived);
  }

  /** Only successful whole-scope replacement can retire old download resources. */
  scopeReplacementRetirement(scope: string): Promise<boolean> | undefined {
    const transition = this.transition;
    if (this.callback.getStore() !== undefined || (transition?.command !== 'scope.reset' && transition?.command !== 'state.restore') || transition.scope !== scope) return undefined;
    return transition.retired;
  }

  /** End the existing publication barrier without creating new lifecycle authority. */
  private completeTransition(retired: boolean): void {
    const transition = this.transition;
    this.transition = undefined;
    transition?.complete(retired);
  }

  /** Captures only existing exact-scope cancellation proofs, never live work or a new request. */
  cancelledSettlement(identityScope: string): Promise<void> | undefined {
    this.assertUsable();
    // A decision callback may be required to settle its cancelled parent. Its
    // child requests must fail admission instead of waiting on that parent.
    if (this.callback.getStore() !== undefined) return undefined;
    const draining = [...this.pending.values()].filter(pending => pending.draining && pending.identityScope === identityScope);
    return draining.length === 0 ? undefined : Promise.all(draining.map(pending => pending.settlement)).then(() => undefined);
  }

  /** Dispatches exactly once; a transport timeout cannot turn an uncertain effect into a retry. */
  async request(command: string, args: Readonly<Record<string, JsonValue>>, context: OperationContext, callbackTransition?: number): Promise<NativeResult> {
    const recovery = this.recovery;
    if (recovery === undefined) this.assertUsable();
    else {
      if (command !== 'scope.reconnect' || args['identityScope'] !== recovery.scope || callbackTransition !== this.reconnectCheckpoint(recovery.scope)) throw new EngineError('INVALID_STATE', 'Only explicit exact-scope recovery is available', { retryable: false });
    }
    if (this.settlingRequests > 0) throw new EngineError('INVALID_STATE', 'The native browser is settling a cancelled operation', { retryable: false });
    if (this.pending.size >= Math.min(this.ready!.limits.maxPendingOperations, 64)) throw new EngineError('ENGINE_FAILURE', 'The native browser operation capacity was exceeded', { retryable: false });
    if (this.operationSeq === Number.MAX_SAFE_INTEGER) {
      this.fail('The native browser operation sequence was exhausted');
      throw this.failure!;
    }
    const callback = this.callback.getStore();
    if (callback !== undefined && (!callback.active || callback.selected)) throw new EngineError('INVALID_STATE', 'The native callback has already completed', { retryable: false });
    if (callback !== undefined) {
      context = { ...context, timeoutMs: Math.min(context.timeoutMs, callback.expiresAt - performance.now()) };
    }
    if (callbackTransition !== undefined) {
      if (callbackTransition !== this.callbackEpoch || this.transition !== undefined) throw this.invalidate();
      let complete!: (retired: boolean) => void;
      const retired = new Promise<boolean>(resolve => { complete = resolve; });
      this.transition = { epoch: callbackTransition, scope: typeof args['identityScope'] === 'string' ? args['identityScope'] : undefined, command, retired, complete };
    }
    const sequence = ++this.operationSeq;
    if (recovery !== undefined) recovery.claimed = true;
    let message: ServerMessage;
    try {
      message = await this.exchange('request', { type: 'request', generation: this.ready!.generation, operationSeq: sequence, timeoutMs: this.timeout(context), command, args, ...(callback === undefined ? {} : { callbackToken: callback.token }) }, context, sequence, callbackTransition);
    } catch (cause) {
      if (callbackTransition !== undefined && this.publishingEpoch === undefined && this.transition?.epoch === callbackTransition) this.completeTransition(false);
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
  close(context: OperationContext): Promise<void> {
    // Explicit close never waits for artifacts or permits another frozen read.
    this.explicitClose = true;
    return this.startClose(context, this.terminalCleanupStarted ?? performance.now());
  }

  private startClose(context: OperationContext, started: number): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    // Mandatory retirement has independent authority and a single fixed budget.
    // Never spread an operation context: its deadline getter may already throw.
    const cleanup: OperationContext = { runId: context.runId, attemptId: context.attemptId, origin: context.origin, signal: new AbortController().signal, timeoutMs: Math.max(0, 15000 - (performance.now() - started)) };
    this.closing = this.finishClose(cleanup, started);
    void this.closing.catch(() => {});
    return this.closing;
  }

  /** Validated terminal state revokes commands, but retains exact cleanup authority. */
  isTerminal(): boolean { return this.terminal; }

  private async finishClose(context: OperationContext, started: number): Promise<void> {
    try {
      if (this.ready === undefined) throw this.fail('The native browser session is not available');
      const message = await this.exchange('close', { type: 'close', generation: this.ready.generation }, context);
      if (message.type !== 'closed') throw this.fail('The native browser did not confirm scope closure');
      await this.channel.settle?.({ runId: context.runId, attemptId: context.attemptId, origin: context.origin, signal: context.signal, timeoutMs: Math.max(0, 15000 - (performance.now() - started)) });
      if (this.failure !== undefined) throw this.failure;
    } catch (cause) {
      throw this.failure ?? this.fail(cause instanceof EngineError ? cause.message : 'The native browser proxy did not finish acknowledged cleanup');
    } finally { this.dispose(); }
  }

  private beginTerminalCleanup(failed?: Pending): void {
    if (this.terminal) return;
    this.terminal = true;
    const started = this.terminalCleanupStarted = performance.now();
    this.terminalArtifactSeq = this.operationSeq;
    this.recovery = undefined;
    for (const callback of this.callbacks) {
      callback.revoked = true; callback.active = false;
      if (callback.timer !== undefined) clearTimeout(callback.timer);
    }
    this.stagedEvents.length = 0;
    this.publishingEpoch = undefined; this.publishingCommand = undefined; this.completeTransition(false);
    // The one cleanup exchange bounds remaining correlation bookkeeping.
    for (const pending of this.pending.values()) if (pending.kind !== 'close') pending.clear();
    const cleanup: OperationContext = { runId: 'native-cleanup', attemptId: 'native-cleanup', origin: 'test', signal: new AbortController().signal, timeoutMs: 15000 };
    let collected: Promise<unknown> | undefined;
    if (!this.explicitClose && this.closing === undefined && failed?.kind === 'request' && failed.callbackToken === undefined
      && failed.identityScope !== undefined && failed.operationSeq !== undefined
      && this.requiredCapabilities.includes(TERMINAL_RECORDING_CAPABILITY) && this.ready?.capabilities.includes(TERMINAL_RECORDING_CAPABILITY)) {
      const owner = { identityScope: failed.identityScope, failedOperationSeq: failed.operationSeq };
      const verified: FinalizedVideoBytes[] = [];
      let failure: { value: unknown } | undefined;
      const bytes = collectFinalizedRecording(owner, (command, args) => this.finalizedRecordingExchange(command, args, started), segment => {
        if (performance.now() < started + 15000) verified.push(segment);
      }, cause => { if (performance.now() < started + 15000) failure ??= { value: cause }; });
      // Register the owning promise synchronously. No artifact work delays or
      // replaces the original business failure or reopens ordinary admission.
      void bytes.catch(() => {});
      try { this.finalizedRecordingHandler?.(owner, bytes, started + 15000, () => ({ segments: verified, ...(failure === undefined ? {} : { failure }) })); } catch { /* Collection cannot replace the original operation failure. */ }
      collected = bytes;
    }
    if (collected === undefined) void this.startClose(cleanup, started).catch(() => {});
    else void collected.catch(() => {}).then(() => this.startClose(cleanup, started)).catch(() => {});
  }

  private async finalizedRecordingExchange(command: FinalizedRecordingCommand, args: Readonly<Record<string, JsonValue>>, started: number): Promise<unknown> {
    if (!this.terminal || this.explicitClose || this.closing !== undefined || this.closed || this.ready === undefined || this.failure !== undefined) throw new EngineError('INVALID_STATE', 'The finalized recording collection has retired', { retryable: false });
    if (this.terminalArtifactSeq === Number.MAX_SAFE_INTEGER) throw new EngineError('ENGINE_FAILURE', 'The finalized recording sequence was exhausted', { retryable: false });
    const sequence = ++this.terminalArtifactSeq;
    const context: OperationContext = { runId: 'native-cleanup', attemptId: 'native-cleanup', origin: 'test', signal: new AbortController().signal, timeoutMs: 15000 - (performance.now() - started) };
    const result = await this.exchange('artifact', { type: 'request', generation: this.ready.generation, operationSeq: sequence, timeoutMs: this.timeout(context), command, args }, context, sequence);
    if (result.type !== 'result' || result.scopeState !== 'quarantined' || result.retention !== undefined || result.recovery !== undefined
      || (result.ok ? result.effects !== 'completed' : result.effects !== 'not-dispatched')) throw this.invalidate();
    if (!result.ok) throw new EngineError('ENGINE_FAILURE', 'The native finalized recording could not be collected', { retryable: false });
    if (this.explicitClose || this.closed || this.failure !== undefined) throw new EngineError('INVALID_STATE', 'The finalized recording collection has retired', { retryable: false });
    return result.data;
  }

  private awaitingQuarantinedResult(): boolean { return [...this.pending.values()].some(pending => pending.kind === 'request' && pending.quarantined); }

  private assertUsable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.terminal || this.recovery !== undefined || this.awaitingQuarantinedResult() || this.closing !== undefined || this.closed || this.ready === undefined) throw new EngineError('INVALID_STATE', 'The native browser session is not available', { retryable: false });
  }

  private timeout(context: OperationContext): number {
    if (context.signal.aborted) throw connectionCancellation('The native browser operation was cancelled before dispatch');
    if (!Number.isFinite(context.timeoutMs)) throw new EngineError('OPERATION_TIMEOUT', 'The native browser operation budget expired before dispatch', { retryable: false });
    if (context.timeoutMs <= 0) throw connectionDeadline('The native browser operation budget expired before dispatch');
    return Math.min(Math.ceil(context.timeoutMs), this.ready?.limits.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  }

  private exchange(kind: Pending['kind'], message: Readonly<Record<string, unknown>>, context: OperationContext, operationSeq?: number, callbackTransition?: number, cancelTarget?: number): Promise<ServerMessage> {
    const trace = this.channel.acceptanceTrace;
    const target = operationSeq ?? cancelTarget;
    // Artifact controls reuse request framing; diagnostics describe the wire kind.
    const wireKind: Exclude<Pending['kind'], 'artifact'> = kind === 'artifact' ? 'request' : kind;
    const facts = { kind: wireKind, ...(target === undefined ? {} : { operationSeq: target }) };
    if (this.failure !== undefined) { trace?.observe('ExchangeRefused', { ...facts, reason: 'already-failed' }); return Promise.reject(this.failure); }
    if (this.pending.size >= 322) { trace?.observe('ExchangeRefused', { ...facts, reason: 'capacity' }); return Promise.reject(new EngineError('ENGINE_FAILURE', 'The native browser protocol capacity was exceeded', { retryable: false })); }
    let timeout: number;
    let bytes: Buffer;
    if (this.nextId === Number.MAX_SAFE_INTEGER) { trace?.observe('ExchangeRefused', { ...facts, reason: 'identity-exhausted' }); return Promise.reject(this.fail('The native browser request identity was exhausted')); }
    const id = `c${++this.nextId}`;
    let refusal: AcceptanceReason = 'timeout';
    try {
      timeout = this.timeout(context);
      refusal = 'serialization';
      bytes = Buffer.from(`${JSON.stringify({ ...message, id })}\n`);
      refusal = 'frame-bound';
      if (bytes.length - 1 > Math.min(MAX_FRAME_BYTES, this.ready?.limits.maxFrameBytes ?? MAX_FRAME_BYTES) || this.channel.writable.writableLength + bytes.length > 4 * MAX_FRAME_BYTES) throw new Error('bounded write');
    } catch (cause) {
      trace?.observe('ExchangeRefused', { ...facts, reason: refusal });
      return Promise.reject(cause instanceof EngineError ? cause : new EngineError('ENGINE_FAILURE', 'The native browser request exceeded its protocol bounds', { retryable: false }));
    }
    let retire!: () => void;
    const settlement = new Promise<void>(resolve => { retire = resolve; });
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
        retire();
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
        trace?.observe('LocalCancelSelected', { operationSeq, reason: code === 'CANCELLED' ? 'abort' : 'deadline' });
        cancellation = code; pending.draining = true; this.settlingRequests++;
        clearTimeout(timer); context.signal.removeEventListener('abort', abort);
        // Cleanup/settlement only: the original native deadline is never extended.
        settlementTimer = setTimeout(() => {
          trace?.observe('SettlementExpired', { operationSeq, resultSeen: settled !== undefined, cancelAckSeen: cancelAcknowledged });
          // Instrumented acceptance binary only: closed booleans, never frames,
          // commands, operation identities, token values, or native error text.
          const diagnostic = this.ready?.capabilities.includes('acceptance.faults/1')
            ? ` (settlement:result-seen=${settled !== undefined};cancel-ack-seen=${cancelAcknowledged})` : '';
          this.fail(`The native browser operation ended without a settled outcome${diagnostic}`, code);
        }, 5000);
        // The work context may expose an expired deadline getter. Settlement
        // has its own budget and must not read that getter while copying metadata.
        const cancelContext: OperationContext = { runId: context.runId, attemptId: context.attemptId, origin: context.origin, signal: new AbortController().signal, timeoutMs: 5000 };
        void this.exchange('cancel', { type: 'cancel', generation: this.ready.generation, operationSeq }, cancelContext, undefined, undefined, operationSeq).then(() => {
          trace?.observe('CancelExchangeResolved', { operationSeq });
          cancelAcknowledged = true; complete();
        }).catch(() => { if (!finished && !this.closed) this.fail('The native browser cancellation did not settle', code); });
      };
      const abort = () => abandon('CANCELLED');
      const timer = setTimeout(() => abandon('OPERATION_TIMEOUT'), timeout);
      const clear = () => { clearTimeout(timer); if (settlementTimer !== undefined) clearTimeout(settlementTimer); context.signal.removeEventListener('abort', abort); };
      const accept = (reply: ServerMessage) => {
        if (settled !== undefined) throw new ReceiveFailure('response-correlation');
        settled = reply; complete();
      };
      const args = message['args'];
      const scope = args !== null && typeof args === 'object' && 'identityScope' in args && typeof args.identityScope === 'string' ? args.identityScope : undefined;
      this.pending.set(id, { kind, ...(scope === undefined ? {} : { identityScope: scope }), ...(kind === 'request' && typeof message['callbackToken'] === 'string' ? { callbackToken: message['callbackToken'] } : {}), ...(cancelTarget === undefined ? {} : { cancelTarget }), ...(typeof message['command'] === 'string' ? { command: message['command'] } : {}), ...(callbackTransition === undefined ? {} : { callbackTransition }), ...(operationSeq === undefined ? {} : { operationSeq }), ...(this.ready === undefined ? {} : { generation: this.ready.generation }), resolve: accept, reject: cause => { retire(); reject(cause); }, clear, settlement });
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) { abort(); return; }
      if (trace === undefined) {
        try { this.channel.writable.write(bytes); } catch { this.fail('The native browser request could not be delivered'); }
      } else {
        const span = trace.span(bytes.length);
        const writeFacts = { ...facts, ...span, length: bytes.length };
        trace.observeComputed('WriteEntered', () => ({ ...writeFacts, writableLength: this.channel.writable.writableLength, writableEnded: this.channel.writable.writableEnded, destroyed: this.channel.writable.destroyed }));
        const observer = trace.active ? trace.writeObserver(writeFacts) : undefined;
        try {
          // Same Buffer, exactly one write. Callback captures only scalar facts and trace state.
          const returned = observer === undefined
            ? this.channel.writable.write(bytes)
            : this.channel.writable.write(bytes, observer.complete);
          trace.observe('WriteReturned', { ...writeFacts, returned });
        } catch (error) {
          observer?.threw();
          trace.observe('WriteThrew', { ...writeFacts, io: acceptanceIo(error) });
          this.fail('The native browser request could not be delivered');
        }
      }
    });
  }

  private receive(message: ServerMessage): void {
    if (this.failure !== undefined || this.closed) return;
    if (message.type === 'event') {
      if (this.ready === undefined || message.generation !== this.ready.generation || message.sequence !== this.eventSequence + 1) throw new ReceiveFailure('event-order');
      this.eventSequence = message.sequence;
      if (this.terminal) return;
      if (message.event === 'scope.callbacks-retired') { this.retireProvenCallbacks(message); return; }
      if (this.recovery !== undefined || this.awaitingQuarantinedResult()) return;
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (++this.activeEvents > Math.min(this.ready.limits.maxPendingDecisions, 256) || this.eventBytes + bytes > 4 * MAX_FRAME_BYTES) throw new ReceiveFailure('capacity');
      this.eventBytes += bytes;
      const arrived = performance.now();
      if (this.publishingEpoch !== undefined) this.stagedEvents.push({ event: message, bytes, arrived });
      else this.dispatchEvent(message, bytes, arrived);
      return;
    }
    if (message.type === 'error') throw new ReceiveFailure('native-refusal', message.error.code);
    const pending = this.pending.get(message.id);
    if (pending === undefined || (pending.generation !== undefined && message.generation !== pending.generation)) throw new ReceiveFailure('response-correlation');
    const expected = pending.kind === 'hello' ? 'ready' : (pending.kind === 'request' || pending.kind === 'artifact') ? 'result' : pending.kind === 'close' ? 'closed' : 'control-result';
    if (message.type !== expected || (message.type === 'result' && message.operationSeq !== pending.operationSeq)) throw new ReceiveFailure('response-kind');
    if (message.type === 'ready') {
      if (message.scopeState !== 'usable') throw new ReceiveFailure('response-kind');
      if (this.requiredCapabilities.some(item => !message.capabilities.includes(item))) { this.fail('The native browser does not satisfy the requested protocol capabilities', 'UNSUPPORTED_CAPABILITY'); return; }
      this.frames.limit(Math.min(MAX_FRAME_BYTES, message.limits.maxFrameBytes));
      this.ready = message;
      if (message.capabilities.includes('acceptance.faults/1')) this.channel.acceptanceTrace?.enable();
    }
    // The independent control lane may flush this acknowledgement first.
    // Hold only its still-pending original receipt, never enable new business.
    const quarantinedRequest = message.type === 'control-result' && message.scopeState === 'quarantined'
      && pending.kind === 'cancel' && this.requiredCapabilities.includes(DISCONNECTED_RECOVERY_CAPABILITY)
      ? [...this.pending.values()].find(request => request.kind === 'request' && request.draining && request.operationSeq === pending.cancelTarget)
      : undefined;
    if (quarantinedRequest !== undefined) {
      quarantinedRequest.quarantined = true;
      for (const callback of this.callbacks) {
        callback.revoked = true; callback.active = false;
        if (callback.timer !== undefined) clearTimeout(callback.timer);
      }
    }
    if (message.type === 'result' && message.recovery !== undefined) {
      if (this.recovery !== undefined || pending.callbackToken !== undefined || pending.identityScope !== message.recovery.identityScope) throw new ReceiveFailure('response-correlation');
      this.recovery = { scope: message.recovery.identityScope, operationSeq: message.operationSeq, claimed: false };
      this.recoveryRetirementSequence = message.operationSeq;
      for (const control of this.pending.values()) if (control.kind === 'cancel' && control.cancelTarget === message.operationSeq) control.quarantined = true;
      this.retireOperation(pending);
      if (this.callbackEpoch === Number.MAX_SAFE_INTEGER) throw new ReceiveFailure('capacity');
      this.callbackEpoch++;
      for (const callback of this.callbacks) {
        callback.revoked = true; callback.active = false;
        if (callback.timer !== undefined) clearTimeout(callback.timer);
      }
      for (const staged of this.stagedEvents.splice(0)) { this.activeEvents--; this.eventBytes -= staged.bytes; }
      this.publishingEpoch = undefined; this.publishingCommand = undefined; this.completeTransition(false);
    }
    if (message.type === 'result' && pending.command === 'scope.reconnect' && this.recovery?.claimed && message.ok) {
      if (message.scopeState !== 'usable' || message.effects !== 'completed') throw new ReceiveFailure('response-kind');
      this.recovery = undefined;
    }
    if (message.type === 'result' && message.retention !== undefined) this.retireOperation(pending);
    if (!pending.draining) { this.pending.delete(message.id); pending.clear(); }
    if (message.type === 'closed') {
      this.closed = true; this.completeTransition(false);
      for (const other of this.pending.values()) {
        other.clear();
        const cancelled = new EngineError('CANCELLED', 'The native browser scope closed', { retryable: false });
        closedFrameCancellations.add(cancelled);
        other.reject(cancelled);
      }
      this.pending.clear();
    }
    if (pending.callbackTransition !== undefined && message.type === 'result') {
      if (message.ok) { this.publishingEpoch = pending.callbackTransition; this.publishingCommand = pending.command; }
      else this.completeTransition(false);
    }
    pending.resolve(message);
    if (message.type === 'result') this.channel.acceptanceTrace?.observe('ResultValidated', { operationSeq: message.operationSeq, generation: message.generation });
    if (pending.kind === 'cancel' && message.type === 'control-result') this.channel.acceptanceTrace?.observe('CancelAckValidated', { ...(pending.cancelTarget === undefined ? {} : { operationSeq: pending.cancelTarget }), generation: message.generation, accepted: message.accepted });
    const recoveryControl = quarantinedRequest !== undefined
      || (message.type === 'control-result' && pending.kind === 'cancel' && pending.quarantined === true)
      || this.recovery !== undefined && ((message.type === 'result' && message.recovery !== undefined)
      || (message.type === 'control-result' && pending.kind === 'cancel' && pending.cancelTarget === this.recovery.operationSeq));
    if (pending.kind !== 'artifact' && !recoveryControl && (message.scopeState === 'quarantined' || (message.scopeState === 'closed' && message.type !== 'closed'))) {
      if ((message.type === 'result' || message.type === 'control-result') && this.requiredCapabilities.includes('terminal.close/1') && this.ready?.capabilities.includes('terminal.close/1')) this.beginTerminalCleanup(message.type === 'result' && !message.ok ? pending : undefined);
      else if (!this.terminal) this.fail('The native browser scope is no longer reusable');
    }
  }

  /** Revoke the exact callback source and its children, never unrelated scope services. */
  private retireOperation(pending: Pending): void {
    if (this.publicationEpoch === Number.MAX_SAFE_INTEGER) throw new ReceiveFailure('capacity');
    // CallbackOwner.sequence is an event sequence, not an operation sequence.
    if (pending.callbackToken !== undefined) for (const owner of this.callbacks) {
      if (owner.generation !== pending.generation || owner.token !== pending.callbackToken) continue;
      owner.revoked = true; owner.active = false;
      if (owner.timer !== undefined) clearTimeout(owner.timer);
    }
    this.publicationEpoch++;
    this.retirementHandler?.();
  }

  /** Terminal proof is consumed on the framing stack, before queued user callbacks can run. */
  private retireProvenCallbacks(message: NativeEvent): void {
    const payload = message.payload;
    if (message.decision !== undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || !('identityScope' in payload) || !('throughEventSequence' in payload) || typeof payload['identityScope'] !== 'string' || payload['identityScope'].length === 0 || Buffer.byteLength(payload['identityScope']) > 128
      || !Number.isSafeInteger(payload['throughEventSequence']) || payload['throughEventSequence'] !== message.sequence - 1) throw new ReceiveFailure('callback-proof');
    const scope = payload['identityScope']; const through = message.sequence - 1;
    if (this.retiredCallbackScopes.has(scope) || this.retiredCallbackScopes.size >= 4096) throw new ReceiveFailure('callback-proof');
    this.retiredCallbackScopes.set(scope, through);
    for (const owner of this.callbacks) {
      if (owner.generation !== message.generation || owner.identityScope !== scope || owner.sequence > through) continue;
      owner.revoked = true; owner.active = false;
      if (owner.timer !== undefined) clearTimeout(owner.timer);
    }
  }

  /** Post-ACK events wait for adapter publication, without delaying pre-ACK decisions. */
  private dispatchEvent(message: NativeEvent, bytes: number, arrived: number): void {
    const ownsRecovery = this.recoveryRevocationGuard();
    const publication = this.publicationEpoch;
    const payload = message.payload;
    const disconnected = message.event === 'browser.disconnected' && message.decision === undefined
      && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === 1 && 'reason' in payload && payload['reason'] === 'browser-connection-closed';
    // Preserve a validated preceding lifecycle notice through exactly this
    // recovery retirement, never through a claimed/new owner or business callback.
    const ownsDelivery = () => ownsRecovery() || (disconnected
      && this.recovery?.claimed === false && this.publicationEpoch === publication + 1);
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
      if (this.failure !== undefined || this.terminal || !ownsDelivery() || this.closing !== undefined || this.closed || this.ready?.generation !== message.generation || callback?.revoked) return;
      if (callback !== undefined && callback.expiresAt <= performance.now()) {
        callback.active = false; this.fail('The native browser callback exceeded its operation budget', 'OPERATION_TIMEOUT'); return;
      }
      return callback === undefined ? this.onEvent(message) : this.callback.run(callback, () => this.onEvent(message));
    }).catch(() => { if (ownsDelivery() && (callback === undefined || (!callback.revoked && callback.epoch === this.callbackEpoch))) this.fail('The native browser event handler failed'); }).finally(() => { if (callbackTimer !== undefined) clearTimeout(callbackTimer); if (callback !== undefined) { callback.active = false; this.callbacks.delete(callback); } this.activeEvents--; this.eventBytes -= bytes; });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.acceptanceTrace?.observe('DisposeEntered');
    try { this.channel.dispose(); } catch { /* The scope remains unusable; never interpret proxy failure as browser settlement. */ }
  }

  private fail(message: string, code: 'ENGINE_FAILURE' | 'CANCELLED' | 'OPERATION_TIMEOUT' | 'UNSUPPORTED_CAPABILITY' = 'ENGINE_FAILURE'): EngineError {
    this.channel.acceptanceTrace?.observe('ClientFail', { reason: code === 'OPERATION_TIMEOUT' ? 'deadline' : code === 'CANCELLED' ? 'cancelled' : code === 'UNSUPPORTED_CAPABILITY' ? 'unsupported-capability' : 'engine-failure' });
    this.failure ??= new EngineError(code, message, { retryable: false });
    this.stagedEvents.length = 0; this.publishingEpoch = undefined; this.publishingCommand = undefined; this.completeTransition(false);
    for (const pending of this.pending.values()) { pending.clear(); pending.reject(this.failure); }
    this.pending.clear();
    this.dispose();
    return this.failure;
  }
}
