import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { connectNativeProcess } from '../../src/native/process.ts';

describe('native process startup diagnostics', () => {
  it('redacts synchronous process creation failures', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('synthetic-private-endpoint-and-env'); });
    const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' };
    const result = connectNativeProcess({ executable: '/verified/native', cwd: '/synthetic', env: {}, capabilities: [] }, operation, () => {});
    await expect(result).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser process could not start', retryable: false });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isNativeProcessCleanupUnresolved } from '../../src/native/process-cleanup.ts';
function processFixture(exitOn: 'SIGTERM' | 'SIGKILL' | 'never' | 'already', cancel = false) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: exitOn === 'already' ? 1 : null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
  child.kill.mockImplementation((signal: NodeJS.Signals) => {
    if (signal === exitOn) { child.signalCode = signal; child.emit('exit', null, signal); }
    return true;
  });
  spawn.mockReturnValueOnce(child);
  const controller = new AbortController();
  const operation: OperationContext = { signal: controller.signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' };
  const pending = connectNativeProcess({ executable: '/verified/native', cwd: '/synthetic', env: {}, capabilities: [] }, operation, () => {});
  const result = pending.then(() => ({ failure: undefined }), failure => ({ failure }));
  if (cancel) controller.abort(); else child.stdout.write('{invalid-protocol}\n');
  return { child, result };
}
describe('failed native startup retains bounded process cleanup', () => {
  it('preserves the primary failure after an already exited child without signals', async () => {
    const f = processFixture('already'); const { failure } = await f.result;
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (frame)' });
    expect(f.child.kill).not.toHaveBeenCalled(); expect(isNativeProcessCleanupUnresolved(failure)).toBe(false);
  });
  it('waits for TERM-confirmed exit and preserves the original negotiation failure', async () => {
    const f = processFixture('SIGTERM'); const { failure } = await f.result;
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (frame)' });
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM']]); expect(isNativeProcessCleanupUnresolved(failure)).toBe(false);
  });
  it('does not reject startup before KILL-confirmed exit after the TERM grace period', async () => {
    vi.useFakeTimers();
    try {
      const f = processFixture('SIGKILL'); let settled = false; void f.result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); const { failure } = await f.result;
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (frame)' });
      expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]); expect(isNativeProcessCleanupUnresolved(failure)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('continues owned cleanup after the original startup signal was cancelled', async () => {
    vi.useFakeTimers();
    try {
      const f = processFixture('SIGKILL', true); let settled = false; void f.result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); const { failure } = await f.result;
      expect(failure).toMatchObject({ code: 'CANCELLED', retryable: false });
      expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      expect(isNativeProcessCleanupUnresolved(failure)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('retains an unresolved exact child and primary failure when bounded termination cannot be proved', async () => {
    vi.useFakeTimers();
    try {
      const f = processFixture('never'); let settled = false; void f.result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); const { failure } = await f.result;
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (frame)', retryable: false });
      expect(isNativeProcessCleanupUnresolved(failure)).toBe(true);
      expect(failure.cause).toBeInstanceOf(AggregateError);
      expect(failure.cause.errors[1]).toMatchObject({ message: 'The failed native browser proxy could not be confirmed stopped' });
      expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    } finally { vi.useRealTimers(); }
  });
});

import { AcceptanceTrace, type AcceptanceRecord } from '../../src/native/acceptance-trace.ts';
describe('acceptance-only actual process observer seam', () => {
  it('links the original child and observes existing end, destroy, exit and close without payloads', async () => {
    const records: AcceptanceRecord[] = []; const trace = new AcceptanceTrace(record => { records.push(record); });
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
    const writes: Record<string, unknown>[] = [];
    child.stdin.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as Record<string, unknown>; writes.push(message);
      if (message['type'] === 'hello') child.stdout.write(JSON.stringify({ type: 'ready', id: message['id'], protocol: 'agent-browser-session/1', sessionId: 'private-session', generation: 1, capabilities: ['acceptance.faults/1'], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' }) + '\n');
      else if (message['type'] === 'close') child.stdout.write(JSON.stringify({ type: 'closed', id: message['id'], generation: 1, scopeState: 'closed' }) + '\n');
    });
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
    spawn.mockReturnValueOnce(child);
    const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' };
    const client = await connectNativeProcess({ executable: '/verified/native', cwd: '/synthetic', env: { PRIVATE: 'private-env' }, capabilities: [], acceptanceTrace: trace }, operation, () => {});
    await client.close(operation); trace.finish();
    expect(writes.map(message => message['type'])).toEqual(['hello', 'close']);
    expect(records.find(record => record.phase === 'ProcessSpawned')).toMatchObject({ proxyPid: 123 });
    expect(records.map(record => record.phase)).toEqual(expect.arrayContaining(['StdinEndEntered', 'StreamsDestroyEntered', 'ProcessExit', 'ProcessClose', 'CaptureFinished']));
    expect(child.kill).not.toHaveBeenCalled(); expect(JSON.stringify(records)).not.toMatch(/private-session|private-env|verified|synthetic/);
  });
});
