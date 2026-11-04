/** Internal scalar-only seam. No environment lookup, payload inspection, or filesystem I/O. */
export type AcceptanceMessageKind = 'hello' | 'request' | 'decision' | 'cancel' | 'close';
export type AcceptanceIo = 'ok' | 'interrupted' | 'would-block' | 'broken-pipe' | 'connection-reset' | 'connection-aborted' | 'not-connected' | 'timed-out' | 'unexpected-eof' | 'write-zero' | 'other';
export type AcceptanceReason = 'deadline' | 'abort' | 'already-failed' | 'capacity' | 'timeout' | 'frame-bound' | 'serialization' | 'identity-exhausted' | 'schema' | 'parse' | 'oversize' | 'event-order' | 'response-correlation' | 'response-kind' | 'callback-proof' | 'native-refusal' | 'receive' | 'stream' | 'settlement' | 'delivery' | 'engine-failure' | 'cancelled' | 'unsupported-capability';
export type AcceptancePhase = 'CaptureStarted' | 'CaptureFinished' | 'CaptureLimitReached' | 'ProcessSpawned' | 'LocalCancelSelected' | 'ExchangeRefused' | 'WriteEntered' | 'WriteReturned' | 'WriteThrew' | 'WriteCallback' | 'ReceiveChunk' | 'FrameComplete' | 'FrameRefused' | 'ReceiveEof' | 'ResultValidated' | 'CancelAckValidated' | 'CancelExchangeResolved' | 'SettlementExpired' | 'ClientFail' | 'DisposeEntered' | 'StdinEndEntered' | 'StreamsDestroyEntered' | 'ProcessExit' | 'ProcessClose';
export interface AcceptanceFacts {
  readonly initialSubmittedBytes?: number;
  readonly submittedBytes?: number;
  readonly pendingWriteCallbacks?: number;
  readonly seedKnown?: boolean;
  readonly operationSeq?: number;
  readonly generation?: number;
  readonly proxyPid?: number;
  readonly kind?: AcceptanceMessageKind;
  readonly reason?: AcceptanceReason;
  readonly io?: AcceptanceIo;
  readonly length?: number;
  readonly start?: number;
  readonly end?: number;
  readonly writableLength?: number;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  readonly returned?: boolean;
  readonly accepted?: boolean;
  readonly resultSeen?: boolean;
  readonly cancelAckSeen?: boolean;
  readonly pendingBytes?: number;
  readonly failed?: boolean;
  readonly clean?: boolean;
  readonly codeKnown?: boolean;
  readonly exitCode?: number;
  readonly signalled?: boolean;
}
export interface AcceptanceRecord extends AcceptanceFacts {
  readonly schemaVersion: 2;
  readonly source: 'ts';
  readonly pid: number;
  readonly record: number;
  readonly phase: AcceptancePhase;
  readonly droppedBefore: number;
  readonly emittedBefore: number;
  readonly suppressedBefore: number;
  readonly overflow: boolean;
}
export type AcceptanceObserver = (record: Readonly<AcceptanceRecord>) => boolean | void;

/** Opt-in alone never emits: only validated acceptance.faults/1 negotiation opens the gate. */
export class AcceptanceTrace {
  private enabled = false;
  private finished = false;
  // Scalar occurrence order is retained, not wall-clock time. Retrospective
  // startup emission after ready is not evidence of when I/O occurred.
  private readonly startup: { phase: AcceptancePhase; facts: AcceptanceFacts }[] = [];
  private attempted = 0;
  private emitted = 0;
  private dropped = 0;
  private suppressed = 0;
  private overflow = false;
  private submitted = 0;
  private pendingWriteCallbacks = 0;
  constructor(private readonly observer: AcceptanceObserver) { this.observe('CaptureStarted', { initialSubmittedBytes: 0, seedKnown: true }); }
  get active(): boolean { return this.enabled && !this.finished; }
  private safe(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) { this.overflow = true; return Number.isNaN(value) || value < 0 ? 0 : Number.MAX_SAFE_INTEGER; }
    return value;
  }
  enable(): void {
    if (this.enabled || this.finished) return;
    this.enabled = true;
    for (const item of this.startup) this.emit(item.phase, item.facts);
    this.startup.length = 0;
  }
  /** Byte coordinates include the hello and count submissions, not peer acceptance. */
  span(length: number): { start: number; end: number } {
    const start = this.submitted;
    this.submitted = this.safe(start + length);
    return { start, end: this.submitted };
  }
  observe(phase: AcceptancePhase, facts: AcceptanceFacts = {}): void {
    if (this.finished) return;
    if (!this.enabled) {
      if (this.startup.length < 64) this.startup.push({ phase, facts });
      else this.suppressed = this.safe(this.suppressed + 1);
      return;
    }
    this.emit(phase, facts);
  }
  /** This closure scope contains only the trace and scalar facts, never a frame Buffer. */
  writeObserver(facts: AcceptanceFacts): { complete(error?: Error | null): void; threw(): void } {
    this.pendingWriteCallbacks = this.safe(this.pendingWriteCallbacks + 1);
    let pending = true;
    const finish = () => { if (pending) { pending = false; this.pendingWriteCallbacks = Math.max(0, this.pendingWriteCallbacks - 1); } };
    return {
      complete: error => { finish(); this.observe('WriteCallback', { ...facts, io: acceptanceIo(error) }); },
      threw: finish,
    };
  }
  /** Diagnostic-only getters must not add a new exception to the I/O path. */
  observeComputed(phase: AcceptancePhase, facts: () => AcceptanceFacts): void {
    try { this.observe(phase, facts()); } catch {
      if (this.enabled) { this.attempted = this.safe(this.attempted + 1); this.dropped = this.safe(this.dropped + 1); }
      else this.suppressed = this.safe(this.suppressed + 1);
    }
  }
  finish(): void {
    if (this.finished) return;
    if (this.enabled) this.emit('CaptureFinished', { submittedBytes: this.submitted, pendingWriteCallbacks: this.pendingWriteCallbacks });
    this.finished = true; this.startup.length = 0;
  }
  private emit(phase: AcceptancePhase, facts: AcceptanceFacts): void {
    // Never retain an exception or let an observer participate in settlement.
    try {
      const scalars = Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, typeof value === 'number' ? this.safe(value) : value]));
      const record = Object.freeze({ ...scalars, schemaVersion: 2 as const, source: 'ts' as const, pid: process.pid, record: this.attempted, phase, droppedBefore: this.dropped, emittedBefore: this.emitted, suppressedBefore: this.suppressed, overflow: this.overflow });
      this.attempted = this.safe(this.attempted + 1);
      if (this.observer(record) === false) this.dropped = this.safe(this.dropped + 1);
      else this.emitted = this.safe(this.emitted + 1);
    } catch { this.dropped = this.safe(this.dropped + 1); }
  }
}

/** Closed Node error-code classes. The error/message is never retained or serialized. */
export function acceptanceIo(error: unknown): AcceptanceIo {
  if (error == null) return 'ok';
  try {
    const code = typeof error === 'object' && 'code' in error ? error.code : undefined;
    switch (code) {
      case 'EINTR': return 'interrupted';
      case 'EAGAIN': case 'EWOULDBLOCK': return 'would-block';
      case 'EPIPE': case 'ERR_STREAM_DESTROYED': case 'ERR_STREAM_WRITE_AFTER_END': return 'broken-pipe';
      case 'ECONNRESET': return 'connection-reset';
      case 'ECONNABORTED': return 'connection-aborted';
      case 'ENOTCONN': return 'not-connected';
      case 'ETIMEDOUT': return 'timed-out';
      default: return 'other';
    }
  } catch { return 'other'; }
}
