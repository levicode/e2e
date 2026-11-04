/** Framed adapter fixture only. It does not produce or validate a native recording. */
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import type { OperationContext } from 'e2e/engine';
import { NativeClient, type NativeChannel } from '../../src/native/client.ts';
import { ISOLATED_PAGE_REOPEN_CAPABILITY, PAGE_IDENTITY_FENCE_CAPABILITY, REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';
export interface ArtifactRequest { type: 'request'; id: string; generation: number; operationSeq: number; timeoutMs: number; command: string; args: Record<string, unknown> }
export interface ArtifactReply { ok: boolean; data?: unknown; error?: { code: string }; effects: 'completed' | 'not-dispatched' | 'unknown'; scopeState: 'usable' | 'quarantined' }
export const artifactOperation = (): OperationContext => ({ runId: 'run', attemptId: 'attempt', origin: 'test', timeoutMs: 1000, signal: new AbortController().signal });
export class FinalizedRecordingPeer {
  readonly frames: Record<string, unknown>[] = [];
  readonly requests: ArtifactRequest[] = [];
  readonly bytes: Buffer;
  private readonly output = new PassThrough();
  private readonly input: Writable;
  readonly scope = 'attempt-scope';
  readonly token = 'opaque-frozen-batch';
  failedSequence = 0;
  eventsSeen = 0;
  constructor(readonly override: (request: ArtifactRequest) => ArtifactReply | undefined | Promise<ArtifactReply | undefined> = () => undefined, bytes: Buffer = Buffer.from('adapter-only immutable artifact bytes'), lifecycle: { readonly close?: () => void } = {}) {
    this.bytes = bytes;
    this.input = new Writable({ write: (chunk: Buffer, _encoding, done) => {
      try {
        const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; this.frames.push(frame);
        if (frame['type'] === 'hello') this.send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'artifact-peer', generation: 1,
          capabilities: this.advertised, scopeState: 'usable', limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } });
        else if (frame['type'] === 'close') { lifecycle.close?.(); this.send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' }); }
        else if (frame['type'] === 'cancel') this.send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'quarantined' });
        else if (frame['type'] === 'request') {
          const request = frame as unknown as ArtifactRequest; this.requests.push(request);
          void Promise.resolve().then(async () => (await this.override(request)) ?? this.reply(request)).then(reply => {
            this.send({ type: 'result', id: request.id, generation: 1, operationSeq: request.operationSeq, ...reply });
          }).catch(() => this.output.destroy(new Error('artifact peer fixture failed')));
        } else throw new Error('unexpected artifact fixture frame');
        done();
      } catch (error) { done(error as Error); }
    } });
  }
  advertised: readonly string[] = [...REQUIRED_CAPABILITIES, PAGE_IDENTITY_FENCE_CAPABILITY, ISOLATED_PAGE_REOPEN_CAPABILITY];
  manifest(): Record<string, unknown> { return { identityScope: this.scope, failedOperationSeq: this.failedSequence, token: this.token, segments: [{ handle: 'frozen-handle', size: this.bytes.length,
    sha256: createHash('sha256').update(this.bytes).digest('hex'), mediaType: 'video/webm', startedAt: '2026-10-26T00:00:00.000Z', ordinal: 1 }] }; }
  private reply(request: ArtifactRequest): ArtifactReply {
    const success = (data: unknown, terminal = false): ArtifactReply => ({ ok: true, data, effects: 'completed', scopeState: terminal ? 'quarantined' : 'usable' });
    if (request.command === 'scope.open') return success({ identityScope: this.scope, recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' } });
    if (request.command === 'scope.reset' || request.command === 'state.restore') {
      this.failedSequence = request.operationSeq;
      return { ok: false, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined' };
    }
    if (request.command === 'recording.finalized.collect') return success(this.manifest(), true);
    if (request.command === 'recording.finalized.read') {
      const offset = request.args['offset'] as number; const bytes = this.bytes.subarray(offset, offset + (request.args['maxBytes'] as number));
      return success({ base64: bytes.toString('base64'), nextOffset: offset + bytes.length, eof: offset + bytes.length === this.bytes.length }, true);
    }
    if (request.command === 'recording.finalized.release') return success({ released: true }, true);
    if (request.command === 'page.title') return success({ title: 'working' });
    return success(null);
  }
  async connect(capabilities: readonly string[] = REQUIRED_CAPABILITIES, onEvent: (event: NativeEvent) => void | Promise<void> = () => {}, context = artifactOperation()): Promise<NativeClient> {
    const channel: NativeChannel = { readable: this.output, writable: this.input, dispose: () => this.dispose() };
    return NativeClient.connect(channel, capabilities, context, async event => { try { await onEvent(event); } finally { this.eventsSeen++; } });
  }
  send(message: unknown): void { queueMicrotask(() => { if (!this.output.destroyed) this.output.write(`${JSON.stringify(message)}\n`); }); }
  eof(): void { this.output.end(); }
  dispose(): void { this.input.destroy(); this.output.destroy(); }
}
