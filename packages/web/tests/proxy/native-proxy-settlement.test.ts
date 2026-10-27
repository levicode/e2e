/** Actual NativeClient -> child pipes -> production proxy_client_session -> private Unix peer.
 * This is not daemon startup, browser execution, or the semantic-fault acceptance test.
 * Result timers are scheduled relative to dispatch. Observed ordering is authoritative:
 * a result consumed before the TS timer legitimately needs no cancel or ACK.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { NativeFrames } from '../../src/native/frames.ts';
import { serverMessage, type NativeResult } from '../../src/native/protocol.ts';
import { observeProxyWrites, ProxyDiagnostics, proxyFact } from '../helpers/native-proxy-diagnostics.ts';

const REQUEST_MS = 2_000;
const SETTLEMENT_MS = 5_000;
const PREFACE = 'AGENT_BROWSER_SESSION/1';
const scenarios = ['early-result', 'scheduled-before', 'scheduled-same-tick', 'scheduled-after', 'explicit-abort-ack-first', 'missing-ack', 'unknown-result'] as const;
type Frame = Record<string, unknown>;

/** No timer mocks: all deadlines and child-pipe scheduling are real. */
function context(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: REQUEST_MS, runId: 'proxy-contract', attemptId: 'proxy-contract', origin: 'test' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(scenarios)('retains authoritative settlement through the production byte proxy: %s', async scenario => {
  const executable = process.env['E2E_AGENT_BROWSER_PROXY_FIXTURE'];
  if (!executable || !isAbsolute(executable)) throw new Error('An explicit absolute E2E_AGENT_BROWSER_PROXY_FIXTURE is required; this hosted proof cannot silently skip');
  if (process.platform === 'win32') throw new Error('This explicit proxy fixture requires Unix sockets');
  const directory = mkdtempSync(join(tmpdir(), 'ab-proxy-'));
  chmodSync(directory, 0o700);
  const diagnostics = new ProxyDiagnostics();
  const broken = deferred<never>();
  void broken.promise.catch(() => {});
  let failed = false;
  const fail = () => { if (!failed) { failed = true; broken.reject(new Error('Closed proxy fixture observation failed')); } };
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, broken.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Proxy fixture observation exceeded the existing settlement budget')), SETTLEMENT_MS);
      })]);
    } finally { clearTimeout(timer); }
  };
  const cancelReceived = deferred<void>();
  const resultReceived = deferred<void>();
  const ackReceived = deferred<void>();
  const exited = deferred<void>();
  let socket: Socket | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: NativeClient | undefined;
  let restoreWrite: (() => void) | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let target: Frame | undefined;
  let cancel: Frame | undefined;
  let targetCount = 0;
  let statusCount = 0;
  let freshCount = 0;
  let cancelCount = 0;
  let ackCount = 0;
  let tsAckCount = 0;
  let resultCount = 0;
  let disposalCount = 0;
  let requestSettled = false;
  let observed: 'result-before-cancel' | 'cancel-before-result' | undefined;
  let closing = false;

  const checkDelivery = (): void => {
    const snapshot = diagnostics.snapshot();
    expect(snapshot.dropped).toBe(0);
    for (const leg of ['stdin-read', 'socket-write', 'socket-read', 'stdout-write']) expect(snapshot.records.some(record => record.source === 'proxy' && record.phase === leg && record.bytes > 0)).toBe(true);
    const writes = snapshot.records.filter(record => record.source === 'ts' && record.kind === 'cancel');
    for (const phase of ['write-enter', 'write-return', 'write-callback']) expect(writes.filter(record => record.phase === phase)).toHaveLength(cancelCount);
    expect(writes.some(record => record.error !== undefined)).toBe(false);
    expect(failed).toBe(false);
  };
  const send = (frame: Frame): void => {
    if (socket === undefined || socket.destroyed) { fail(); return; }
    socket.write(`${JSON.stringify(frame)}\n`, error => { if (error && !closing) fail(); });
  };
  const result = (request: Frame, fields: Frame) => ({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ...fields });
  const sendResult = (kind: 'known' | 'unknown' | 'aborted' | 'success' = 'known'): void => {
    if (target === undefined || ++resultCount !== 1 || statusCount !== 1) { fail(); return; }
    diagnostics.add({ source: 'peer', phase: 'peer-result' });
    send(result(target, kind === 'success'
      ? { ok: true, data: { early: true }, effects: 'completed', scopeState: 'usable' }
      : { ok: false, error: { code: kind === 'aborted' ? 'cancelled' : 'deadline-exceeded' }, effects: kind === 'unknown' ? 'unknown' : 'not-dispatched', scopeState: kind === 'unknown' ? 'quarantined' : 'usable' }));
  };
  const sendAck = (): void => {
    if (cancel === undefined || ++ackCount !== 1) { fail(); return; }
    diagnostics.add({ source: 'peer', phase: 'peer-ack' });
    // A completion-first native broker can reject a late cancel. A correlated
    // rejection is still a real ACK, never a substitute for the execute result.
    send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: resultCount === 0,
      ...(resultCount === 0 ? {} : { error: { code: 'invalid-arguments' } }), scopeState: 'usable' });
  };
  const peer = createServer(connection => {
    if (socket !== undefined) { connection.destroy(); fail(); return; }
    socket = connection;
    let input = Buffer.alloc(0);
    let preface = false;
    connection.on('error', () => { if (!closing && disposalCount === 0) fail(); });
    connection.on('data', (chunk: Buffer) => {
      try {
        input = Buffer.concat([input, chunk]);
        if (input.length > 1_048_576) throw new Error('Bounded peer frame');
        while (input.includes(10)) {
          const end = input.indexOf(10);
          const line = input.subarray(0, end);
          input = input.subarray(end + 1);
          if (!preface) { if (line.toString() !== PREFACE) throw new Error('Invalid preface'); preface = true; continue; }
          const frame = JSON.parse(line.toString()) as Frame;
          if (frame['type'] === 'hello') {
            send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'private-proxy-fixture', generation: 1, capabilities: ['acceptance.faults/1'], scopeState: 'usable',
              limits: { maxFrameBytes: 1_048_576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3_600_000 } });
          } else if (frame['type'] === 'request' && frame['command'] === 'fixture.hold') {
            if (++targetCount !== 1 || frame['timeoutMs'] !== REQUEST_MS) throw new Error('Invalid held request');
            target = frame; diagnostics.add({ source: 'peer', phase: 'peer-request', bytes: line.length + 1 });
          } else if (frame['type'] === 'request' && frame['command'] === 'fixture.status') {
            if (++statusCount !== 1 || target === undefined || resultCount !== 0) throw new Error('Status was not concurrent');
            diagnostics.add({ source: 'peer', phase: 'peer-status', bytes: line.length + 1 });
            send(result(frame, { ok: true, data: { pending: true }, effects: 'completed', scopeState: 'usable' }));
          } else if (frame['type'] === 'request' && frame['command'] === 'fixture.fresh') {
            if (++freshCount !== 1 || !requestSettled || (cancelCount !== 0 && (ackCount !== 1 || tsAckCount !== 1))) throw new Error('Fresh request crossed settlement');
            diagnostics.add({ source: 'peer', phase: 'fresh-request', bytes: line.length + 1 });
            send(result(frame, { ok: true, data: { fresh: true }, effects: 'completed', scopeState: 'usable' }));
          } else if (frame['type'] === 'cancel') {
            if (++cancelCount !== 1 || target === undefined || frame['operationSeq'] !== target['operationSeq'] || frame['generation'] !== 1) throw new Error('Invalid complete cancel');
            cancel = frame;
            diagnostics.add({ source: 'peer', phase: 'peer-cancel', bytes: line.length + 1 });
            cancelReceived.resolve();
          } else if (frame['type'] === 'close') {
            send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
          } else throw new Error('Unexpected fixture frame');
        }
      } catch { fail(); }
    });
    connection.on('end', () => { if (input.length !== 0) fail(); connection.end(); });
  });
  peer.on('error', fail);

  /** Retire resources with the existing cleanup-failure precedence. */
  async function cleanup(): Promise<void> {
    closing = true; clearTimeout(scheduled); restoreWrite?.();
    let cleanupFailed = false;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.stdin.destroy(); child.kill('SIGTERM');
      // Match the existing native-process cleanup policy: SIGKILL after 2s,
      // definitive exit proof within 3s. This is not an operation extension.
      const kill = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited.promise, new Promise<void>(resolve => { deadline = setTimeout(() => { cleanupFailed = true; resolve(); }, 3_000); })]);
      } finally { clearTimeout(kill); clearTimeout(deadline); }
    }
    socket?.destroy();
    await new Promise<void>(resolve => peer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    if (cleanupFailed) throw new Error('Proxy fixture child exit was not proven');
  }

  try {
    await wait(new Promise<void>(resolve => peer.listen(join(directory, 'fixture.sock'), resolve)));
    child = spawn(executable, ['--proxy-session', 'fixture'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { AGENT_BROWSER_SOCKET_DIR: directory } });
    child.once('error', fail);
    child.once('close', () => exited.resolve());
    const processChild = child;
    restoreWrite = observeProxyWrites(child.stdin, diagnostics);
    let stderr = '';
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 32_768) { fail(); return; }
      stderr += chunk.toString();
      for (;;) {
        const end = stderr.indexOf('\n');
        if (end < 0) break;
        const line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
        try { const fact = proxyFact(line); diagnostics.add(fact); if (fact.captureLimit) fail(); } catch { fail(); }
      }
    });
    const frames = new NativeFrames(1_048_576);
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of frames.read(chunk)) {
          const message = serverMessage(frame);
          if (message.type === 'result' && target !== undefined && message.operationSeq === target['operationSeq']) {
            observed ??= diagnostics.snapshot().records.some(record => record.source === 'ts' && record.phase === 'write-enter' && record.kind === 'cancel') ? 'cancel-before-result' : 'result-before-cancel';
            diagnostics.add({ source: 'ts', phase: 'ts-result', bytes: Buffer.byteLength(JSON.stringify(frame)) + 1 });
            resultReceived.resolve();
          } else if (message.type === 'control-result') {
            if (cancel === undefined || message.id !== cancel['id'] || ++tsAckCount !== 1) throw new Error('Uncorrelated ACK');
            diagnostics.add({ source: 'ts', phase: 'ts-ack', accepted: message.accepted }); ackReceived.resolve();
          }
        }
      } catch { fail(); }
    });
    client = await wait(NativeClient.connect({ readable: child.stdout, writable: child.stdin, dispose: () => {
      disposalCount++; diagnostics.add({ source: 'ts', phase: 'disposed' });
      processChild.stdin.destroy(); processChild.stdout.destroy();
      if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGTERM');
    }, settle: async operation => {
      if (operation.signal.aborted || operation.timeoutMs <= 0) throw new Error('Proxy fixture close budget expired');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        processChild.stdin.end();
        await Promise.race([exited.promise, broken.promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Proxy fixture did not close within the original budget')), operation.timeoutMs);
        })]);
        if (processChild.exitCode !== 0) throw new Error('Proxy fixture close was not clean');
      } finally { clearTimeout(timer); }
    } }, ['acceptance.faults/1'], context(), () => {}));
    const controller = new AbortController();
    const pending = client.request('fixture.hold', {}, context(controller.signal));
    const originalDeadlinePassedAfter = performance.now() + REQUEST_MS;
    const outcome = pending.then(value => { requestSettled = true; diagnostics.add({ source: 'ts', phase: 'settled' }); return { value }; }, error => ({ error: error as { code?: string; message?: string } }));
    if (scenario !== 'early-result' && scenario !== 'explicit-abort-ack-first' && scenario !== 'unknown-result') {
      const offset = scenario === 'scheduled-before' ? -1 : scenario === 'scheduled-same-tick' ? 0 : 1;
      scheduled = setTimeout(() => sendResult(), REQUEST_MS + offset);
    }
    expect((await wait(client.request('fixture.status', {}, context()))).data).toEqual({ pending: true });
    if (scenario === 'early-result') sendResult('success');

    if (scenario === 'explicit-abort-ack-first') {
      controller.abort(); await wait(cancelReceived.promise); sendAck(); await wait(ackReceived.promise);
      expect(requestSettled).toBe(false);
      await expect(client.request('fixture.fresh', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      sendResult('aborted');
    } else if (scenario === 'unknown-result') {
      // Quarantine is allowed to destroy the transport immediately. Establish
      // complete cancel delivery first rather than demanding bytes after death.
      await wait(cancelReceived.promise); sendResult('unknown');
      const settled = await outcome;
      expect('value' in settled ? settled.value : undefined).toMatchObject({ effects: 'unknown', scopeState: 'quarantined' });
      await expect(client.request('fixture.fresh', {}, context())).rejects.toMatchObject({ retryable: false });
      expect([cancelCount, ackCount, tsAckCount, freshCount, disposalCount]).toEqual([1, 0, 0, 0, 1]);
      checkDelivery();
      return;
    } else {
      const first = await wait(Promise.race([outcome.then(() => 'settled' as const), cancelReceived.promise.then(() => 'cancel' as const)]));
      if (first === 'cancel') {
        expect(scenario).not.toBe('early-result');
        await wait(resultReceived.promise);
        expect(requestSettled).toBe(false);
        await expect(client.request('fixture.fresh', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
        if (scenario === 'missing-ack') {
          const settled = await outcome;
          expect('error' in settled ? settled.error : undefined).toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'The native browser operation ended without a settled outcome (settlement:result-seen=true;cancel-ack-seen=false)' });
          await expect(client.request('fixture.fresh', {}, context())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
          expect([cancelCount, ackCount, tsAckCount, freshCount, disposalCount]).toEqual([1, 0, 0, 0, 1]);
          checkDelivery();
          return;
        }
        sendAck();
      } else {
        expect(['early-result', 'scheduled-before']).toContain(scenario);
        expect(observed).toBe('result-before-cancel');
        // Do not close early and hide an uncleared original request timer.
        await delay(Math.max(0, originalDeadlinePassedAfter - performance.now()) + 5);
        expect(cancelCount).toBe(0);
      }
    }
    const settled = await outcome;
    expect('value' in settled ? settled.value : undefined).toMatchObject(scenario === 'early-result'
      ? { ok: true, data: { early: true }, effects: 'completed', scopeState: 'usable' } satisfies Partial<NativeResult>
      : { ok: false, error: { code: scenario === 'explicit-abort-ack-first' ? 'cancelled' : 'deadline-exceeded' }, effects: 'not-dispatched', scopeState: 'usable' } satisfies Partial<NativeResult>);
    if (cancelCount !== 0) expect([cancelCount, ackCount, tsAckCount]).toEqual([1, 1, 1]);
    else {
      expect(['early-result', 'scheduled-before']).toContain(scenario);
      expect([ackCount, tsAckCount]).toEqual([0, 0]);
    }
    expect((await wait(client.request('fixture.fresh', {}, context()))).data).toEqual({ fresh: true });
    expect([targetCount, statusCount, resultCount, freshCount, disposalCount]).toEqual([1, 1, 1, 1, 0]);
    await wait(client.close(context()));
    processChild.stdin.end();
    await wait(exited.promise);
    expect(processChild.exitCode).toBe(0);
    checkDelivery();
    const snapshot = diagnostics.snapshot();
    const proxyRecords = snapshot.records.filter(record => record.source === 'proxy');
    expect(proxyRecords.every(record => record.error === null)).toBe(true);
    const total = (phase: string) => proxyRecords.filter(record => record.phase === phase).reduce((sum, record) => sum + record.bytes, 0);
    const written = snapshot.records.filter(record => record.source === 'ts' && record.phase === 'write-enter');
    expect(total('stdin-read')).toBe(written.reduce((sum, record) => sum + (record.bytes ?? 0), 0));
    expect(total('socket-write')).toBe(total('stdin-read'));
    expect(total('stdout-write')).toBe(total('socket-read'));
    expect(written.length).toBe(snapshot.records.filter(record => record.source === 'ts' && record.phase === 'write-callback').length);
    expect(stderr).toBe('');
  } catch (error) {
    // Vitest prints only our closed observations alongside its normal assertion.
    // Never append child stderr, frame contents, argv, request IDs or args.
    console.error(JSON.stringify({ scenario, observed, targetCount, statusCount, cancelCount, ackCount, tsAckCount, resultCount, freshCount, disposalCount, trace: diagnostics.snapshot() }));
    throw error;
  } finally {
    await cleanup();
  }
});
