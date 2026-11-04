/** Real NativeClient protocol and producer -> helper, in-memory transports only. */
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createUnservedModelCapture, withUnservedModelDiagnostics } from '../helpers/unserved-model-diagnostics.ts';

beforeEach(() => {
  vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '1'); vi.stubEnv('NODE_SELECTOR', process.versions.node);
  vi.stubEnv('E2E_CAPTURE_SOURCE_COMMIT', 'a'.repeat(40)); vi.stubEnv('E2E_CAPTURE_SOURCE_TREE', 'b'.repeat(40));
  vi.stubEnv('E2E_UNSERVED_MODEL_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', ''); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const clean = { nativeRetired: true, finalizedCleanupProven: true, recordingsRetired: true, released: true, connectingCleanupFailurePresent: false, retiringAttemptCleared: true, reason: 'complete' as const, dirty: 'unknown' as const };
it.each(['closed', 'native-error', 'settle-error'] as const)('preserves actual close result and collector phase for %s with cancelled caller', async fault => {
  const lines: string[] = []; let forward: ((line: string) => void) | undefined;
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { const line = String(chunk); lines.push(line); forward?.(line); return true; });
  const results = ['judges', 'acts'].map((title, n) => ({ declarationIndex: 0, titlePath: [title], file: n === 0 ? 'tests/one.e2e.ts' : 'tests/two.e2e.ts', targetId: 'web', testId: `test-${n}`, agent: 'default', repeat: 0, selected: true, kind: 'test', status: 'interrupted', attempts: [{ index: 0, status: 'interrupted', cleanup: n === 1 && fault !== 'closed' ? 'failed' : 'complete', secondaryErrors: n === 1 && fault !== 'closed' ? [{ code: 'ENGINE_FAILURE', phase: 'cleanup' }] : [] }] }));
  const sentinel = { outcome: { report: { run: { targets: [{ id: 'web' }], errors: [{ code: 'MODEL_UNAVAILABLE', phase: 'body' }], results } } } };
  let workCalls = 0;
  const result = await withUnservedModelDiagnostics(async sink => {
    workCalls++;
    for (let n = 0; n < 2; n++) {
      vi.resetModules();
      const producer = await import('../../../web/src/native/secrets-diagnostics.ts');
      const { NativeClient } = await import('../../../web/src/native/client.ts');
      forward = line => sink!({ type: 'output', seq: 1, at: '2026-11-02T00:00:00.000Z', target: 'web', pair: { testId: `test-${n}`, agent: 'default', repeat: 0 }, stream: 'stderr', text: line });
      const surface = producer.createSecretsSurface()!; const owner = surface.start()!;
      const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
      const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
      const send = (value: unknown) => output.write(JSON.stringify(value) + '\n');
      const caller = new AbortController();
      const context = { signal: caller.signal, timeoutMs: 1000, runId: 'test', attemptId: `attempt-${n}`, origin: 'test' as const };
      const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
      const settle = vi.fn(async () => { if (n === 1 && fault === 'settle-error') throw new Error('synthetic proxy settle failure'); });
      const connecting = NativeClient.connect({ readable: output, writable: input, dispose, settle }, ['terminal.close/1'], context, () => {});
      send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'fixture', generation: 1, capabilities: ['terminal.close/1'], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      const client = await connecting; caller.abort();
      const closing = producer.withSecretsContext(owner, () => client.close(context));
      expect(producer.withSecretsContext(owner, () => client.close(context))).toBe(closing);
      const outcome = closing.then(() => undefined, cause => cause);
      const close = requests.at(-1)!; expect(close['type']).toBe('close');
      if (n === 1 && fault === 'native-error') send({ type: 'error', id: close['id'], error: { code: 'cleanup-failed' }, scopeState: 'quarantined' });
      else send({ type: 'closed', id: close['id'], generation: 1, scopeState: 'closed' });
      const failure = await outcome;
      if (n === 1 && fault !== 'closed') {
        expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
        surface.emit(owner, { kind: 'retirement', stage: 'native-close', before: 'undefined', after: 'value' });
      } else expect(failure).toBeUndefined();
      expect(requests.filter(request => request['type'] === 'close')).toHaveLength(1);
      expect(dispose).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledTimes(n === 1 && fault === 'native-error' ? 0 : 1);
      surface.emit(owner, { kind: 'cleanup', ...clean, nativeRetired: failure === undefined, retiringAttemptCleared: failure === undefined, reason: failure === undefined ? 'complete' : 'receipt-failed' });
      forward = undefined;
    }
    return sentinel;
  });
  expect(result).toBe(sentinel); expect(workCalls).toBe(1);
  const captured = lines.filter(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC ')).map(line => JSON.parse(line.slice('UNSERVED_MODEL_DIAGNOSTIC '.length)) as Record<string, unknown>);
  const closed = captured.filter(row => row['kind'] === 'close' && row['caseOrdinal'] === 2 && row['outcome'] !== 'observed');
  expect(closed).toEqual([expect.objectContaining({ stage: fault === 'native-error' ? 'close-exchange' : fault === 'settle-error' ? 'channel-settle' : 'post-settle', outcome: fault === 'closed' ? 'completed' : 'failed', closedFrameConfirmed: fault !== 'native-error', origin: 'unjoined', code: 'unknown' })]);
  const custody = lines.find(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC_CUSTODY '))!;
  expect(JSON.parse(custody.slice('UNSERVED_MODEL_DIAGNOSTIC_CUSTODY '.length))).toMatchObject({ invalidRecords: 0, workerBindings: 2, lifecycle: 'observed', nativeOrigin: 'unknown' });
  expect(lines.some(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC '))).toBe(false);
});


function diagnosticReport() {
  return { run: { targets: [{ id: 'web' }], errors: [], results: ['judges', 'acts'].map((title, n) => ({ declarationIndex: 0, titlePath: [title], file: n === 0 ? 'tests/one.e2e.ts' : 'tests/two.e2e.ts', targetId: 'web', testId: `test-${n}`, agent: 'default', repeat: 0, selected: true, kind: 'test', status: 'interrupted', attempts: [{ index: 0, status: 'interrupted', cleanup: 'complete', secondaryErrors: [] }] })) } };
}
it.each(['preconditions', 'decision-receipts', 'close-exchange', 'channel-settle', 'post-settle', 'existing-client-failure', 'reuse-existing-close'])('accepts only the existing closed phase vocabulary: %s', stage => {
  const nonce = 'a'.repeat(64); const capture = createUnservedModelCapture(nonce);
  const base = { v: 1, captureNonce: nonce, workerToken: 'b'.repeat(64), surface: 1, attempt: 1 };
  const send = (value: unknown) => capture.onEvent({ type: 'output', seq: 1, at: '2026-11-02T00:00:00.000Z', target: 'web', pair: { testId: 'test-0', agent: 'default', repeat: 0 }, stream: 'stderr', text: 'UNSERVED_MODEL_DIAGNOSTIC ' + JSON.stringify(value) + '\n' });
  send({ ...base, kind: 'start' });
  send({ ...base, kind: 'close', client: 1, stage, outcome: 'failed', closedFrameConfirmed: false, code: 'unknown', origin: 'unjoined' });
  expect(capture.finish(diagnosticReport()).rows).toContainEqual(expect.objectContaining({ kind: 'close', stage, workerOrdinal: 1 }));
});
it.each([{ stage: 'CANARY' }, { code: 'CANARY' }, { origin: 'native' }, { client: 17 }, { captureNonce: 'c'.repeat(64) }, { workerToken: 'c'.repeat(64) }, { surface: 2 }, { rawMessage: 'CANARY' }])('rejects invalid close attribution or undeclared data %j', change => {
  const nonce = 'a'.repeat(64); const capture = createUnservedModelCapture(nonce);
  const base = { v: 1, captureNonce: nonce, workerToken: 'b'.repeat(64), surface: 1, attempt: 1 };
  const send = (value: unknown) => capture.onEvent({ type: 'output', seq: 1, at: '2026-11-02T00:00:00.000Z', target: 'web', pair: { testId: 'test-0', agent: 'default', repeat: 0 }, stream: 'stderr', text: 'UNSERVED_MODEL_DIAGNOSTIC ' + JSON.stringify(value) + '\n' });
  send({ ...base, kind: 'start' });
  send({ ...base, kind: 'close', client: 1, stage: 'close-exchange', outcome: 'failed', closedFrameConfirmed: false, code: 'unknown', origin: 'unjoined', ...change });
  const evidence = capture.finish(diagnosticReport());
  expect(evidence.rows.some(value => value['kind'] === 'close')).toBe(false);
  expect(evidence.custody.lifecycle).toBe('incomplete');
  expect(JSON.stringify(evidence)).not.toContain('CANARY');
});
