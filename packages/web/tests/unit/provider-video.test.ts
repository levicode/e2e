/** Public provider recording ownership through the production native transport, not a fake Page. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle, OperationContext, ProviderRecording } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { NativeClient } from '../../src/native/client.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const operation = (signal = new AbortController().signal): OperationContext => ({ signal, timeoutMs: 1000, runId: 'provider-video', attemptId: 'a1', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });

let activation: 'success' | 'reject' | 'cancel' = 'success';
const setupEvents: string[] = [];
beforeEach(() => {
  activation = 'success'; setupEvents.length = 0;
  vi.mocked(connectNativeProcess).mockImplementation(async (options, context, onEvent) => {
    const output = new PassThrough();
    const send = (message: unknown) => queueMicrotask(() => output.write(JSON.stringify(message) + '\n'));
    const input = new Writable({ write(chunk: Buffer, _encoding, done) {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'provider-peer', generation: 1, capabilities: options.capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      else if (frame['type'] === 'close') send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
      else if (frame['command'] === 'page.activate') {
        setupEvents.push('activate');
        send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ...(activation === 'success' ? { ok: true, data: { activated: true }, effects: 'completed' } : { ok: false, error: { code: activation === 'cancel' ? 'cancelled' : 'browser-failure' }, effects: 'not-dispatched' }), scopeState: 'usable' });
      }
      else send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: true, data: frame['command'] === 'scope.open' ? { identityScope: 'scope-1', recoveryIdentity: { browser: 'browser-1', context: 'context-1', page: 'page-1' } } : null, effects: 'completed', scopeState: 'usable' });
      done();
    } });
    return NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, options.capabilities, context, onEvent);
  });
});

describe('provider recording lifecycle', () => {
  const dirs: string[] = [];
  const engines: EngineHandle[] = [];
  afterEach(async () => {
    try { for (const engine of engines.splice(0)) await engine.dispose!(cleanup()); }
    finally { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }
  });
  async function start(record: () => Promise<ProviderRecording>, release = async () => {}) {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-video-')); dirs.push(artifactsDir);
    const engine = web({ browser: { name: 'cloud', scope: 'attempt', acquire: async () => ({ id: 'lease-0', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record } });
    engines.push(engine);
    const common = { runId: 'provider-video', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, signal: new AbortController().signal, log: () => {} };
    const prepared = await engine.prepare!({ ...common, slots: 1 }); await engine.init!({ ...common, env: prepared?.env ?? {}, workerSlot: 0 });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: common.signal, resolveSecret: noSecrets, ...ignoreTrace });
    return engine;
  }
  const recording = (name: string, stopped: string[], failures = 0): ProviderRecording => {
    let left = failures;
    return { startedAt: '2026-09-28T10:00:00.000Z', async stop({ dir }) {
      stopped.push(name); if (left-- > 0) throw new Error('recorder unreachable');
      writeFileSync(path.join(dir, `${name}.mp4`), 'mp4'); return { file: `${name}.mp4` };
    } };
  };

  it('stops a start that landed after its budget ran out, and keeps the recording started after it', async () => {
    const stopped: string[] = []; let land!: (started: ProviderRecording) => void;
    const starts = [() => new Promise<ProviderRecording>(resolve => { land = resolve; }), async () => recording('second', stopped)];
    const record = vi.fn(async () => starts.shift()!()); const engine = await start(record);
    const timedOut = new AbortController();
    const first = engine.artifacts!.startVideo!(operation(timedOut.signal)).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1)); timedOut.abort();
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    const second = engine.artifacts!.startVideo!(operation()); void second.catch(() => undefined);
    try { await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2), { timeout: 100 }); }
    finally { land(recording('first', stopped)); }
    await second;
    await vi.waitFor(() => expect(stopped).toEqual(['first']));
    expect((await engine.artifacts!.stopVideo!(operation())).map(segment => 'path' in segment ? segment.path : segment.url)).toEqual(['video/second.mp4']);
  });

  it('keeps the handle of a recording whose stop failed, so a later stop still ends it', async () => {
    const stopped: string[] = []; const engine = await start(async () => recording('clip', stopped, 1));
    await engine.artifacts!.startVideo!(operation());
    // Public collection reports the failure; unlike the old private abandon helper it does not swallow it.
    await expect(engine.artifacts!.stopVideo!(operation())).rejects.toBeDefined();
    expect(stopped).toEqual(['clip']);
    expect(await engine.artifacts!.stopVideo!(operation())).toHaveLength(1);
    expect(stopped).toEqual(['clip', 'clip']);
  });

  it('retains failed late cleanup alongside the newer recording after independent lease release', async () => {
    const stopped: string[] = []; let land!: (started: ProviderRecording) => void;
    const starts = [() => new Promise<ProviderRecording>(resolve => { land = resolve; }), async () => recording('second', stopped)];
    const record = vi.fn(async () => starts.shift()!()); const released = vi.fn(async () => {});
    const engine = await start(record, released); const controller = new AbortController();
    const first = engine.artifacts!.startVideo!(operation(controller.signal)).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1)); controller.abort();
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    await engine.artifacts!.startVideo!(operation()); land(recording('first', stopped, 2));
    await vi.waitFor(() => expect(stopped).toEqual(['first']));
    await expect(engine.settleAttempt!(cleanup())).rejects.toMatchObject({ message: expect.stringContaining('cloud') });
    const failure = await engine.endAttempt!(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ message: expect.stringContaining('cloud') });
    expect(stopped).toEqual(['first', 'first']); expect(released).toHaveBeenCalledTimes(1);
    await expect(engine.endAttempt!(cleanup())).rejects.toBe(failure);
    expect(stopped).toEqual(['first', 'first', 'first', 'second']); expect(released).toHaveBeenCalledTimes(1);
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    // Reaping succeeded, but a real cleanup failure can never make this worker reusable.
    await expect(engine.dispose!(cleanup())).rejects.toBe(failure);
    engines.splice(engines.indexOf(engine), 1);
  });

  it("does not detach another caller's live recording start when only a shared waiter cancels", async () => {
    let land!: (started: ProviderRecording) => void; const stopped: string[] = [];
    const record = vi.fn(() => new Promise<ProviderRecording>(resolve => { land = resolve; }));
    const engine = await start(record); const first = engine.artifacts!.startVideo!(operation());
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const waiter = engine.artifacts!.startVideo!(operation(controller.signal)).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    expect(await waiter).toMatchObject({ code: 'CANCELLED' });
    const third = engine.artifacts!.startVideo!(operation());
    await new Promise(resolve => setImmediate(resolve)); expect(record).toHaveBeenCalledTimes(1);
    land(recording('shared', stopped)); await Promise.all([first, third]);
    expect(await engine.artifacts!.stopVideo!(operation())).toHaveLength(1); expect(stopped).toEqual(['shared']);
  });


  it('joins one late stop after cleanup timeout rather than issuing a duplicate stop', async () => {
    let land!: (recording: ProviderRecording) => void; let finish!: () => void;
    const stopped = vi.fn(() => new Promise<{ url: string; mediaType: string }>(resolve => { finish = () => resolve({ url: 'https://synthetic.test/late.mp4', mediaType: 'video/mp4' }); }));
    const record = vi.fn(() => new Promise<ProviderRecording>(resolve => { land = resolve; }));
    const released = vi.fn(async () => {}); const engine = await start(record, released);
    const controller = new AbortController();
    const first = engine.artifacts!.startVideo!(operation(controller.signal)).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1)); controller.abort();
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    land({ startedAt: '2026-09-28T10:00:00.000Z', stop: stopped });
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
    await expect(engine.endAttempt!({ ...cleanup(), timeoutMs: 10 })).resolves.toBeUndefined();
    expect(released).not.toHaveBeenCalled();
    const retry = engine.endAttempt!(cleanup()); await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toHaveBeenCalledTimes(1); finish(); await retry;
    expect(stopped).toHaveBeenCalledTimes(1); expect(released).toHaveBeenCalledTimes(1);
  });


  it('activates the app page before asking the provider to record it', async () => {
    const engine = await start(async () => { setupEvents.push('record'); return recording('ordered', []); });
    await engine.artifacts!.startVideo!(operation());
    expect(setupEvents).toEqual(['activate', 'record']);
  });

  it('does not start the provider recorder when native page activation fails', async () => {
    const record = vi.fn(async () => recording('never', [])); const engine = await start(record); activation = 'reject';
    await expect(engine.artifacts!.startVideo!(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(record).not.toHaveBeenCalled(); expect(setupEvents).toEqual(['activate']);
  });


  it('does not invoke a provider after cancelled native activation', async () => {
    const record = vi.fn(async () => recording('never', [])); const engine = await start(record); activation = 'cancel';
    await expect(engine.artifacts!.startVideo!(operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(record).not.toHaveBeenCalled();
  });

  it('does not dispatch activation for an already cancelled recording request', async () => {
    const record = vi.fn(async () => recording('never', [])); const engine = await start(record);
    const controller = new AbortController(); controller.abort();
    await expect(engine.artifacts!.startVideo!(operation(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(setupEvents).toEqual([]); expect(record).not.toHaveBeenCalled();
  });

});
