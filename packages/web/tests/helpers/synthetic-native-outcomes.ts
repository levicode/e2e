/** Passive, synthetic-case-only observations of already validated public results. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { NativeClient } from '../../src/native/client.ts';
import { SYNTHETIC_COMMANDS, callbackFailureFact, syntheticKeys, syntheticObject, validSyntheticNativeResult, type SyntheticSelectedOperation, type SyntheticCleanupNative, type SyntheticOutcome, type SyntheticCommand, type SyntheticEvidence, type SyntheticNativeResult, type SyntheticPhase } from './synthetic-evidence.ts';

const current = new AsyncLocalStorage<SyntheticNativeObserver>();
const selected = new AsyncLocalStorage<{ owner: SyntheticNativeObserver; fact: SyntheticSelectedOperation }>();
type Request = NativeClient['request'];

/** Read only own data descriptors: neither payloads nor custom getters are diagnostic input. */
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw new Error('Invalid native evidence');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid native evidence');
  return descriptor.value;
}
function projectResult(value: unknown): SyntheticNativeResult {
  const ok = ownData(value, 'ok');
  const result: Record<string, unknown> = {
    operationSeq: ownData(value, 'operationSeq'), ok,
    code: ok === true ? null : ownData(ownData(value, 'error'), 'code'),
    effects: ownData(value, 'effects'), scopeState: ownData(value, 'scopeState'),
  };
  if (Object.hasOwn(value as object, 'retention')) {
    const retention = ownData(value, 'retention');
    if (!syntheticObject(retention) || !syntheticKeys(retention, ['version', 'retiredOperationSeq', 'producerState', 'inputDebt', 'objectDebt'])) throw new Error('Invalid native retention evidence');
    // Validate the closed keys before copying; never silently strip an extra field.
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(retention)) snapshot[key] = ownData(retention, key);
    result['retention'] = snapshot;
  }
  if (!validSyntheticNativeResult(result)) throw new Error('Invalid native evidence');
  return result;
}

/** Never wrap an operation's returned Promise, retry it, or inspect its payload. */
export class SyntheticNativeObserver {
  private closed = false;
  private refusalSeen = false;
  private terminalSeen = false;
  private rejectedSeen = false;
  private readonly operations = new Map<number, SyntheticSelectedOperation>();
  private cleanup: SyntheticCleanupNative | undefined;
  private readonly failures = new Set<keyof SyntheticOutcome>();
  private readonly installed = new Map<NativeClient, { wrapper: Request; descriptor: PropertyDescriptor | undefined }>();

  constructor(private readonly evidence: SyntheticEvidence, private readonly phase: () => SyntheticPhase) {}

  /** ALS only supplies ownership; the exact body return value/Promise and throws are preserved. */
  run<T>(body: () => T): T {
    return current.run(this, body);
  }

  /** Fixed ordinals select only the disputed public calls, never every operation. */
  select<T>(ordinal: number, command: SyntheticCommand, body: () => T): T {
    let fact: SyntheticSelectedOperation | undefined;
    this.safely(() => {
      if (this.closed || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 11 || this.operations.has(ordinal)) { this.evidence.invalidate(); return; }
      fact = { kind: 'selected-operation', ordinal, phase: this.phase(), command, invoked: true,
        requestCount: 0, requestPending: 0, firstResult: null, firstFailure: null, rejected: false,
        adapter: 'pending', code: null, causeCode: null, reason: null, causeReason: null, assertion: 'not-observed' };
      this.operations.set(ordinal, fact);
    });
    if (fact === undefined) return body();
    const entry = fact;
    return selected.run({ owner: this, fact: entry }, () => {
      let value: T;
      try { value = body(); } catch (cause) { this.publicResult(entry, cause); throw cause; }
      this.watch(value, () => { entry.adapter = 'fulfilled'; }, cause => this.publicResult(entry, cause));
      return value;
    });
  }

  /** Mark the actual matcher only; resolution of an API never implies assertion success. */
  assert<T>(ordinal: number, body: () => T): T {
    let fact = this.operations.get(ordinal);
    this.safely(() => { if (fact && !this.closed && fact.assertion !== 'failed') fact.assertion = 'pending'; });
    let value: T;
    try { value = body(); } catch (cause) {
      fact ??= this.operations.get(ordinal);
      this.safely(() => { if (fact && !this.closed) fact.assertion = 'failed'; });
      throw cause;
    }
    fact ??= this.operations.get(ordinal);
    this.safely(() => { if (fact && !this.closed && fact.assertion !== 'failed') fact.assertion = 'pending'; });
    this.watch(value, () => { if (fact && fact.assertion !== 'failed') fact.assertion = 'passed'; }, () => { if (fact) fact.assertion = 'failed'; });
    return value;
  }

  /** Preserve the first body cause even if the original finally later throws cleanup failure. */
  failure(section: keyof SyntheticOutcome, cause: unknown): void {
    this.safely(() => {
      if (this.closed || this.failures.has(section)) return;
      const projected = callbackFailureFact(0, cause);
      if (this.evidence.tryRecord({ kind: 'test-failure', section, phase: this.phase(), code: projected.code,
        causeCode: projected.causeCode, reason: projected.reason, causeReason: projected.causeReason })) this.failures.add(section);
    });
  }

  private publicResult(fact: SyntheticSelectedOperation, cause: unknown): void {
    this.safely(() => {
      if (this.closed) return;
      const projected = callbackFailureFact(0, cause);
      fact.adapter = 'rejected'; fact.code = projected.code; fact.causeCode = projected.causeCode; fact.reason = projected.reason; fact.causeReason = projected.causeReason;
    });
  }

  private watch<T>(value: T, passed: () => void, failed: (cause: unknown) => void): void {
    this.safely(() => {
      // Selected APIs and matchers return native Promises. Never inspect arbitrary then getters.
      if (value instanceof Promise) void value.then(() => this.safely(() => { if (!this.closed) passed(); }),
        cause => this.safely(() => { if (!this.closed) failed(cause); })).catch(() => this.safely(() => this.evidence.invalidate()));
      else if (!this.closed) passed();
    });
  }

  /** Direct composition also covers suites whose connection predates the test body. */
  connection(promise: Promise<NativeClient>): Promise<NativeClient> {
    void promise.then(client => this.attach(client), () => {}).catch(() => this.safely(() => this.evidence.invalidate()));
    return promise;
  }

  private safely(body: () => void): void {
    try { body(); } catch { try { this.evidence.invalidate(); } catch { /* Diagnostics never alter the operation. */ } }
  }

  private receipts(command: SyntheticCommand, phase: SyntheticPhase): Array<SyntheticSelectedOperation | SyntheticCleanupNative> {
    const receipts: Array<SyntheticSelectedOperation | SyntheticCleanupNative> = [];
    const active = selected.getStore();
    if (active?.owner === this && active.fact.command === command) receipts.push(active.fact);
    if (command === 'scope.end') {
      this.cleanup ??= { kind: 'cleanup-native', phase, command, requestCount: 0, requestPending: 0, firstResult: null, firstFailure: null, rejected: false };
      receipts.push(this.cleanup);
    }
    return receipts.filter(receipt => {
      if (receipt.requestCount >= 64) { this.evidence.invalidate(); return false; }
      receipt.requestCount++; receipt.requestPending++;
      return true;
    });
  }

  attach(client: NativeClient): void {
    if (this.closed || this.installed.has(client)) return;
    this.safely(() => {
      if (this.installed.size >= 64) { this.evidence.invalidate(); return; }
      // eslint-disable-next-line no-this-alias -- The observer must preserve the exact original method receiver.
      const owner = this;
      const original = client.request;
      const descriptor = Object.getOwnPropertyDescriptor(client, 'request');
      const wrapper: Request = function (this: NativeClient, ...args) {
        let phase: SyntheticPhase = 'dispatch';
        owner.safely(() => { phase = owner.phase(); });
        const command = SYNTHETIC_COMMANDS.find(value => value === args[0]) ?? 'other';
        const rejected = () => owner.safely(() => {
          if (!owner.closed && !owner.rejectedSeen) {
            owner.rejectedSeen = owner.evidence.tryRecord({ kind: 'request-rejected-without-result', phase, command });
          }
        });
        let promise: ReturnType<Request>;
        try { promise = original.apply(this, args); } catch (cause) {
          owner.safely(() => { for (const receipt of owner.receipts(command, phase)) { receipt.requestPending--; receipt.rejected = true; } });
          rejected(); throw cause;
        }
        owner.observePromise(command, phase, promise);
        return promise;
      };
      Object.defineProperty(client, 'request', { configurable: true, writable: true, value: wrapper });
      this.installed.set(client, { wrapper, descriptor });
    });
  }

  /** Observe an already-dispatched exact request without replacing its Promise. */
  observePromise(command: string, phase: SyntheticPhase, promise: ReturnType<Request>): void {
    const closedCommand = SYNTHETIC_COMMANDS.find(value => value === command) ?? 'other';
    let receipts: Array<SyntheticSelectedOperation | SyntheticCleanupNative> = [];
    this.safely(() => { if (!this.closed) receipts = this.receipts(closedCommand, phase); });
    const rejected = () => this.safely(() => {
      if (this.closed) return;
      for (const receipt of receipts) { receipt.requestPending--; receipt.rejected = true; }
      if (!this.closed && !this.rejectedSeen) this.rejectedSeen = this.evidence.tryRecord({ kind: 'request-rejected-without-result', phase, command: closedCommand });
    });
    // Both handlers and the observation branch are guarded. The original Promise
    // stays with the caller, so resolution/rejection identity is unchanged.
    void promise.then(result => this.safely(() => {
      if (this.closed) return;
      const projected = projectResult(result);
      for (const receipt of receipts) {
        receipt.requestPending--; receipt.firstResult ??= projected;
        if (!projected.ok) receipt.firstFailure ??= projected;
      }
      const fact = { kind: 'native-result', phase, command: closedCommand, result: projected } as const;
      if (!projected.ok && !this.refusalSeen) {
        this.refusalSeen = this.evidence.tryRecord({ ...fact, slot: 'first-refusal' });
      }
      if ((projected.effects === 'unknown' || projected.scopeState !== 'usable') && !this.terminalSeen) {
        this.terminalSeen = this.evidence.tryRecord({ ...fact, slot: 'first-terminal' });
      }
    }), rejected).catch(() => { this.safely(() => this.evidence.invalidate()); });
  }

  /** Called by the original test finally/afterEach, not by a production lifecycle hook. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.safely(() => {
      for (const fact of this.operations.values()) this.evidence.record(fact);
      if (this.cleanup) this.evidence.record(this.cleanup);
      const phase = this.phase();
      if (!this.refusalSeen) this.evidence.record({ kind: 'native-result', slot: 'first-refusal', phase, command: 'other', result: null });
      if (!this.terminalSeen) this.evidence.record({ kind: 'native-result', slot: 'first-terminal', phase, command: 'other', result: null });
    });
    this.detach();
  }

  /** Pause a shared fixture between cases; only its original afterAll may reattach for cleanup. */
  detach(): void {
    for (const [client, saved] of this.installed) this.safely(() => {
      if (client.request !== saved.wrapper) { this.evidence.invalidate(); return; }
      if (saved.descriptor) Object.defineProperty(client, 'request', saved.descriptor);
      else if (!Reflect.deleteProperty(client, 'request')) this.evidence.invalidate();
    });
    this.installed.clear();
  }
}

/** Compose inside an existing connect spy; never patch NativeClient.prototype. */
export function observeSyntheticConnection(promise: Promise<NativeClient>): Promise<NativeClient> {
  const owner = current.getStore();
  if (owner) void promise.then(client => owner.attach(client), () => {}).catch(() => {});
  return promise;
}

export type RecoverySection = 'setup' | 'body' | 'cleanup';
/** Test-local state only. It never owns or changes engine lifecycle/cleanup. */
export class SyntheticRecoveryEvidence {
  phase: SyntheticPhase = 'host';
  section: RecoverySection = 'setup';
  readonly outcome: Record<RecoverySection, 'not-started' | 'passed' | 'failed' | 'incomplete'> =
    { setup: 'incomplete', body: 'not-started', cleanup: 'not-started' };
  readonly observer: SyntheticNativeObserver;
  constructor(readonly evidence: SyntheticEvidence) {
    this.observer = new SyntheticNativeObserver(evidence, () => this.phase);
  }
  enter(phase: SyntheticPhase, section: RecoverySection = this.section): void {
    this.phase = phase; this.section = section;
    if (this.outcome[section] === 'not-started') this.outcome[section] = 'incomplete';
    this.evidence.record({ kind: 'phase', section, phase, state: 'enter' });
  }
  passed(section: RecoverySection): void {
    if (this.outcome[section] === 'failed') return;
    this.outcome[section] = 'passed';
    this.evidence.record({ kind: 'phase', section, phase: this.phase, state: 'passed' });
  }
  finishBackstop(failed: boolean): void {
    if (failed) this.failed('cleanup'); else this.passed('cleanup');
    this.observer.close();
    this.evidence.finish(this.outcome);
  }
  failed(section: RecoverySection = this.section, cause?: unknown): void {
    if (cause !== undefined) this.observer.failure(section, cause);
    this.outcome[section] = 'failed';
    this.evidence.record({ kind: 'phase', section, phase: this.phase, state: 'failed' });
  }
}
