/** Passive, synthetic-case-only observations of already validated public results. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { NativeClient } from '../../src/native/client.ts';
import { SYNTHETIC_COMMANDS, type SyntheticEvidence, type SyntheticFact, type SyntheticPhase } from './synthetic-evidence.ts';

const current = new AsyncLocalStorage<SyntheticNativeObserver>();
type Request = NativeClient['request'];

/** Never wrap an operation's returned Promise, retry it, or inspect its payload. */
export class SyntheticNativeObserver {
  private closed = false;
  private refusalSeen = false;
  private terminalSeen = false;
  private rejectedSeen = false;
  private readonly installed = new Map<NativeClient, { wrapper: Request; descriptor: PropertyDescriptor | undefined }>();

  constructor(private readonly evidence: SyntheticEvidence, private readonly phase: () => SyntheticPhase) {}

  /** ALS only supplies ownership; the exact body return value/Promise and throws are preserved. */
  run<T>(body: () => T): T {
    return current.run(this, body);
  }

  private safely(body: () => void): void {
    try { body(); } catch { try { this.evidence.invalidate(); } catch { /* Diagnostics never alter the operation. */ } }
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
            owner.rejectedSeen = true;
            owner.evidence.record({ kind: 'request-rejected-without-result', phase, command });
          }
        });
        let promise: ReturnType<Request>;
        try { promise = original.apply(this, args); } catch (cause) { rejected(); throw cause; }
        // Both handlers and the observation branch are guarded. The original Promise
        // is returned below, so caller-visible resolution/rejection identity is intact.
        void promise.then(result => owner.safely(() => {
          if (owner.closed) return;
          if (!result.ok && result.error === undefined) { owner.evidence.invalidate(); return; }
          const fact = {
            kind: 'native-result', phase, command,
            result: { operationSeq: result.operationSeq, ok: result.ok,
              code: result.ok ? null : result.error!.code,
              effects: result.effects, scopeState: result.scopeState },
          } as const;
          if (!result.ok && !owner.refusalSeen) {
            owner.refusalSeen = true;
            owner.evidence.record({ ...fact, slot: 'first-refusal' } as SyntheticFact);
          }
          if ((result.effects === 'unknown' || result.scopeState !== 'usable') && !owner.terminalSeen) {
            owner.terminalSeen = true;
            owner.evidence.record({ ...fact, slot: 'first-terminal' } as SyntheticFact);
          }
        }), rejected).catch(() => { owner.safely(() => owner.evidence.invalidate()); });
        return promise;
      };
      Object.defineProperty(client, 'request', { configurable: true, writable: true, value: wrapper });
      this.installed.set(client, { wrapper, descriptor });
    });
  }

  /** Called by the original test finally/afterEach, not by a production lifecycle hook. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.safely(() => {
      const phase = this.phase();
      if (!this.refusalSeen) this.evidence.record({ kind: 'native-result', slot: 'first-refusal', phase, command: 'other', result: null });
      if (!this.terminalSeen) this.evidence.record({ kind: 'native-result', slot: 'first-terminal', phase, command: 'other', result: null });
    });
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
  failed(section: RecoverySection = this.section): void {
    this.outcome[section] = 'failed';
    this.evidence.record({ kind: 'phase', section, phase: this.phase, state: 'failed' });
  }
}
