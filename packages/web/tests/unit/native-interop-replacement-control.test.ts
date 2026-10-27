/** Exact framed private decisions; not a Chromium conformance substitute. */
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient, type InteropReplacementHandler } from '../../src/native/client.ts';

const operation = (timeoutMs = 1000): OperationContext => ({ runId: 'replacement', attemptId: 'one', origin: 'test', timeoutMs, signal: new AbortController().signal });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const peers: Peer[] = [];
class Peer {
  readonly output = new PassThrough();
  readonly frames: Record<string, any>[] = [];
  holdDecisionAcks = false;
  readonly heldDecisionAcks: Record<string, any>[] = [];
  readonly input = new Writable({ write: (chunk, _encoding, done) => {
    const frame = JSON.parse(chunk.toString()); this.frames.push(frame);
    if (frame.type === 'hello') this.send({ type: 'ready', id: frame.id, protocol: 'agent-browser-session/1', sessionId: 'replacement-peer', generation: 1, capabilities: ['terminal.close/1'], scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
    else if (frame.type === 'decision' && this.holdDecisionAcks) this.heldDecisionAcks.push(frame);
    else if (frame.type === 'decision' || frame.type === 'cancel') this.send({ type: 'control-result', id: frame.id, generation: 1, accepted: true, scopeState: 'usable' });
    else if (frame.type === 'close') this.send({ type: 'closed', id: frame.id, generation: 1, scopeState: 'closed' });
    else if (frame.type !== 'request') throw new Error(`Unexpected frame ${frame.type}`);
    done();
  } });
  private sequence = 0;
  constructor() { peers.push(this); }
  async connect(): Promise<NativeClient> { return NativeClient.connect({ readable: this.output, writable: this.input, dispose: () => this.dispose() }, ['terminal.close/1'], operation(), async () => { throw new Error('private decision escaped into public event handler'); }); }
  send(message: unknown): void { queueMicrotask(() => { if (!this.output.destroyed) this.output.write(`${JSON.stringify(message)}\n`); }); }
  async request(): Promise<Record<string, any>> { for (let n = 0; n < 30; n++) { const frame = this.frames.find(candidate => candidate.type === 'request'); if (frame) return frame; await tick(); } throw new Error('request not dispatched'); }
  event(request: Record<string, any>, phase: 'retire' | 'create', override: Record<string, unknown> = {}): void {
    this.send({ type: 'event', generation: 1, sequence: ++this.sequence, event: 'scope.interop.replacement', payload: { version: 1, identityScope: 'old-scope', operationSeq: request.operationSeq, phase, ...(phase === 'retire' ? { contextId: 'old-context' } : {}), ...override }, decision: { token: `replacement-${this.sequence}`, timeoutMs: 1000 } });
  }
  result(request: Record<string, any>, unknown = false): void { this.send({ type: 'result', id: request.id, operationSeq: request.operationSeq, generation: 1, ...(unknown ? { ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'cleanup-failed' } } : { ok: true, effects: 'completed', scopeState: 'usable', data: { identityScope: 'new-scope', activatePage: true } }) }); }
  dispose(): void { this.input.destroy(); this.output.destroy(); }
}
afterEach(() => { for (const peer of peers.splice(0)) peer.dispose(); });

describe('private exact replacement control', () => {
  it.each(['scope.reset', 'state.restore'])('keeps %s in one sequence and joins both exact control receipts before publication', async command => {
    const peer = new Peer(); const client = await peer.connect(); const phases: string[] = [];
    const handler: InteropReplacementHandler = async (notice, respond) => { phases.push(notice.phase); await respond(notice.phase === 'retire' ? { kind: 'interop-retired' } : { kind: 'interop-created', contextId: 'new-context', targetId: 'new-page' }); };
    const epoch = client.callbackCheckpoint(); const pending = client.request(command, { identityScope: 'old-scope' }, operation(), epoch, handler);
    const request = await peer.request(); peer.event(request, 'retire');
    await expect.poll(() => peer.frames.filter(frame => frame.type === 'decision').length).toBe(1);
    peer.event(request, 'create');
    await expect.poll(() => peer.frames.filter(frame => frame.type === 'decision').length).toBe(2);
    peer.result(request); await pending; await client.interopDecisionSettlement(epoch); client.retireCallbacks(epoch);
    expect(phases).toEqual(['retire', 'create']); expect(peer.frames.filter(frame => frame.type === 'request')).toHaveLength(1);
    await client.close(operation()); expect(peer.frames.filter(frame => frame.type === 'close')).toHaveLength(1);
  });
  it.each([{ identityScope: 'foreign' }, { operationSeq: 999 }, { phase: 'create' }])('rejects non-exact replacement metadata %j before invoking PW work', async override => {
    const peer = new Peer(); const client = await peer.connect(); let calls = 0;
    const pending = client.request('scope.reset', { identityScope: 'old-scope' }, operation(), client.callbackCheckpoint(), async () => { calls++; });
    const result = pending.catch(error => error); const request = await peer.request(); peer.event(request, 'retire', override);
    expect((await result).code).toBe('ENGINE_FAILURE'); expect(calls).toBe(0); expect(peer.frames.filter(frame => frame.type === 'decision')).toHaveLength(0);
  });
  it('does not let deadline departure replace the dispatched mutation actual Unknown', async () => {
    const peer = new Peer(); const client = await peer.connect(); let settled = false;
    const pending = client.request('scope.reset', { identityScope: 'old-scope' }, operation(20), client.callbackCheckpoint(), async () => {});
    void pending.finally(() => { settled = true; }).catch(() => {});
    const request = await peer.request(); await new Promise(resolve => setTimeout(resolve, 45));
    expect(settled).toBe(false); expect(peer.frames.some(frame => frame.type === 'cancel')).toBe(true);
    peer.result(request, true); expect((await pending).effects).toBe('unknown');
    await client.close(operation()); expect(peer.frames.filter(frame => frame.type === 'request')).toHaveLength(1);
  });
  it('refuses invalid private handler registration without occupying the transition slot', async () => {
    const peer = new Peer(); const client = await peer.connect(); const epoch = client.callbackCheckpoint();
    await expect(client.request('scope.restart', { identityScope: 'old-scope' }, operation(), epoch, async () => {})).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const pending = client.request('scope.restart', { identityScope: 'old-scope' }, operation(), epoch);
    const request = await peer.request(); peer.result(request); await pending; client.retireCallbacks(epoch); await client.close(operation());
  });
  it.each(['expired', 'cancelled'])('does not strand a transition when private admission is already %s', async mode => {
    const peer = new Peer(); const client = await peer.connect(); const epoch = client.callbackCheckpoint();
    const invalid = mode === 'expired' ? operation(0) : { ...operation(), signal: AbortSignal.abort() };
    await expect(client.request('scope.reset', { identityScope: 'old-scope' }, invalid, epoch, async () => {})).rejects.toMatchObject({ code: mode === 'expired' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
    expect(peer.frames.some(frame => frame.type === 'request')).toBe(false);
    const pending = client.request('scope.restart', { identityScope: 'old-scope' }, operation(), epoch);
    const request = await peer.request(); peer.result(request); await pending; client.retireCallbacks(epoch); await client.close(operation());
  });

});


it('REVIEW clears publication owner when an expiring getter throws after private admission', async () => {
  const peer = new Peer(); const client = await peer.connect(); const epoch = client.callbackCheckpoint();
  let reads = 0;
  const invalid = { ...operation(), get timeoutMs() { if (++reads > 3) throw new Error('original getter expired'); return 1000; } };
  await expect(client.request('scope.reset', { identityScope: 'old-scope' }, invalid, epoch, async () => {})).rejects.toThrow('original getter expired');
  expect(peer.frames.some(frame => frame.type === 'request')).toBe(false);
  const pending = client.request('scope.restart', { identityScope: 'old-scope' }, operation(), epoch);
  const request = await peer.request(); peer.result(request); await pending; client.retireCallbacks(epoch); await client.close(operation());
});

it('REVIEW joins both private ACKs after original result and cancellation without new effect permission', async () => {
  const peer = new Peer(); peer.holdDecisionAcks = true;
  const client = await peer.connect(); const cancel = new AbortController(); const epoch = client.callbackCheckpoint();
  const pending = client.request('scope.reset', { identityScope: 'old-scope' }, { ...operation(60), signal: cancel.signal }, epoch, async (notice, respond) => {
    await respond(notice.phase === 'retire' ? { kind: 'interop-retired' } : { kind: 'interop-created', contextId: 'new-context', targetId: 'new-page' });
  });
  const request = await peer.request(); peer.event(request, 'retire');
  await expect.poll(() => peer.heldDecisionAcks.length).toBe(1);
  peer.event(request, 'create');
  await expect.poll(() => peer.heldDecisionAcks.length).toBe(2);
  peer.result(request); await pending;
  let settled = false; const join = client.interopDecisionSettlement(epoch).then(() => { settled = true; });
  cancel.abort(); await new Promise(resolve => setTimeout(resolve, 90)); expect(settled).toBe(false);
  for (const frame of peer.heldDecisionAcks) peer.send({ type: 'control-result', id: frame.id, generation: 1, accepted: true, scopeState: 'usable' });
  await join; client.retireCallbacks(epoch);
  expect(peer.frames.filter(frame => frame.type === 'request')).toHaveLength(1);
  await client.close(operation());
});
