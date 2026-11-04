/** In-memory framed peer for native adapter unit tests. It does not implement a browser. */
import { PassThrough, Writable } from 'node:stream';
import { withTimeout, type JsonValue, type OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import type { Effects, NativeEvent, ScopeState } from '../../src/native/protocol.ts';

interface PeerRequest {
  readonly type: 'request'; readonly id: string; readonly generation: number;
  readonly operationSeq: number; readonly command: string; readonly args: Record<string, JsonValue>;
}
type PeerOutcome = { readonly data: JsonValue; readonly scopeState?: ScopeState } | {
  readonly error: string; readonly frameSelection?: unknown; readonly effects?: Effects; readonly scopeState?: ScopeState;
};

/** Keeps the real NativeClient parser, sequence checks, cancellation, and result decoding in the test. */
class NativeProtocolPeer {
  readonly frames: Record<string, unknown>[] = [];
  readonly requests: PeerRequest[] = [];
  private readonly output = new PassThrough();
  private readonly input: Writable;
  private eventSequence = 0;
  private closeWait: Promise<void> | undefined;
  private settleHook: (() => Promise<void>) | undefined;
  settleAfterCloseWith(work: () => Promise<void>): void { this.settleHook = work; }
  holdCloseUntil(wait: Promise<void>): void { this.closeWait = wait; }
  private readonly handled = new Map<number, () => void>();

  constructor(private readonly capabilities: readonly string[], request: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome>, lifecycle: { readonly close?: () => void } = {}) {
    this.input = new Writable({ write: (chunk: Buffer, _encoding, done) => {
      try {
        const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
        this.frames.push(frame);
        if (frame['type'] === 'hello') this.send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic-provider-peer', generation: 1,
          capabilities: this.capabilities, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
        else if (frame['type'] === 'decision') this.send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
        // Native's control lane ACKs cancellation independently of retained work.
        else if (frame['type'] === 'cancel') this.send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
        else if (frame['type'] === 'close') void (this.closeWait ?? Promise.resolve()).then(() => { lifecycle.close?.(); this.send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' }); }).catch(error => this.output.destroy(error instanceof Error ? error : new Error('Synthetic close failed')));
        else if (frame['type'] === 'request') {
          const call = frame as unknown as PeerRequest;
          this.requests.push(call);
          void Promise.resolve().then(() => request(call)).then(outcome => this.send({
            type: 'result', id: call.id, generation: call.generation, operationSeq: call.operationSeq,
            ...('data' in outcome ? { ok: true, data: outcome.data, effects: 'completed', scopeState: outcome.scopeState ?? 'usable' }
              : { ok: false, error: { code: outcome.error, ...(outcome.frameSelection === undefined ? {} : { frameSelection: outcome.frameSelection }) }, effects: outcome.effects ?? 'not-dispatched', scopeState: outcome.scopeState ?? 'usable' }),
          })).catch(error => this.output.destroy(error instanceof Error ? error : new Error('Synthetic peer failed')));
        } else throw new Error(`Unexpected synthetic peer frame ${String(frame['type'])}`);
        done();
      } catch (cause) { done(cause instanceof Error ? cause : new Error('Invalid synthetic peer frame')); }
    } });
  }

  connect(operation: OperationContext, onEvent: (event: NativeEvent) => void | Promise<void>): Promise<NativeClient> {
    return NativeClient.connect({ readable: this.output, writable: this.input, dispose: () => this.dispose(), settle: () => this.settleHook?.() ?? Promise.resolve() }, this.capabilities, operation, async event => {
      try { await onEvent(event); } finally { this.handled.get(event.sequence)?.(); this.handled.delete(event.sequence); }
    });
  }

  async event(event: string, payload: Record<string, JsonValue>, decision?: { token: string; timeoutMs: number }): Promise<void> {
    const sequence = ++this.eventSequence;
    const handled = new Promise<void>(resolve => this.handled.set(sequence, resolve));
    this.send({ type: 'event', generation: 1, sequence, event, payload, ...(decision === undefined ? {} : { decision }) });
    try { await withTimeout(handled, 1_000, () => new Error('Synthetic native event was not consumed')); } finally { this.handled.delete(sequence); }
  }

  /** Malformed transport input is never evidence that the leased browser died. */
  protocolFailure(): void { this.output.write('{not a native frame}\n'); }
  dispose(): void { this.input.destroy(); this.output.destroy(); }
  private send(message: unknown): void { queueMicrotask(() => { if (!this.output.destroyed) this.output.write(`${JSON.stringify(message)}\n`); }); }
}

export { NativeProtocolPeer as RetirementProtocolPeer };
export type { PeerRequest as RetirementPeerRequest, PeerOutcome as RetirementPeerOutcome };
