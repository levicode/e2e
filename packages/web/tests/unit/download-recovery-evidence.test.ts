import { expect, it } from 'vitest';
import { downloadRecoveryEvidence, DOWNLOAD_RECOVERY_SOURCE_FILES } from '../helpers/download-recovery-evidence.ts';
import { SyntheticNativeObserver } from '../helpers/synthetic-native-outcomes.ts';
import type { NativeClient } from '../../src/native/client.ts';
import type { SyntheticEvidence } from '../helpers/synthetic-evidence.ts';
const sink: SyntheticEvidence = { available: false, record() {}, tryRecord() { return false; }, observe() {}, finish() {}, invalidate() {} };
const validIdentity = () => ({ claimedCommit: null, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), worktreeDirty: false, declaredNativeCommit: 'c'.repeat(40), runtimeIdentity: 'unavailable', nodeVersion: 'v24.22.1', nativeBinarySha256: null, sources: DOWNLOAD_RECOVERY_SOURCE_FILES.map(file => ({ file, sha256: 'd'.repeat(64) })) });
const outcome = { setup: 'passed', body: 'failed', cleanup: 'passed' } as const;

it('retains exact download command, cancellation and arming boundaries without synthetic batch', async () => {
  const meta: Record<string, unknown> = {}; const lines: string[] = [];
  const evidence = downloadRecoveryEvidence(sink, meta, line => { lines.push(line); }, validIdentity);
  const observer = new SyntheticNativeObserver(evidence, () => 'download-arm');
  const result = { operationSeq: 7, ok: false, error: { code: 'cancelled' }, effects: 'not-dispatched', scopeState: 'usable' } as const;
  const pending = Promise.resolve(result);
  observer.observePromise('download.subscribe', 'download-arm', pending as ReturnType<NativeClient['request']>);
  expect(await pending).toBe(result);
  evidence.record({ kind: 'download-boundaries', registrations: 0, deliveries: 0, triggers: 0, tap: 'not-observed' });
  observer.close(); evidence.finish(outcome);
  expect(lines).toHaveLength(1);
  const report = JSON.parse(lines[0]!.slice('DOWNLOAD_RECOVERY_DIAGNOSTIC '.length));
  expect(report).toMatchObject({ caseId: 'P12', invalid: false, finished: true, outcome });
  expect(report.facts).toContainEqual(expect.objectContaining({ kind: 'native-result', command: 'download.subscribe', result: expect.objectContaining({ code: 'cancelled', effects: 'not-dispatched', scopeState: 'usable' }) }));
});

it('collector failures preserve original operation Promise, single invocation and rejection identity', async () => {
  const broken = () => { throw new Error('collector unavailable'); };
  const badSink: SyntheticEvidence = { available: false, record: broken, tryRecord: broken, observe: broken, finish: broken, invalidate: broken };
  const evidence = downloadRecoveryEvidence(badSink, Object.freeze({}), broken, broken);
  const observer = new SyntheticNativeObserver(evidence, () => 'perform');
  const failure = new Error('original cancellation');
  const pending = Promise.reject(failure); let calls = 0;
  const observed = observer.select(0, 'browser.perform', () => { calls++; return pending; });
  expect(observed).toBe(pending);
  await expect(observed).rejects.toBe(failure);
  observer.close(); expect(() => evidence.finish(outcome)).not.toThrow();
  expect(calls).toBe(1);
});

it('does not infer absent observations and marks overflow or missing identity invalid', () => {
  const meta: Record<string, unknown> = {};
  const evidence = downloadRecoveryEvidence(sink, meta, () => {}, () => { throw new Error('missing identity'); });
  evidence.finish(outcome);
  expect(meta['downloadRecoveryDiagnostic']).toMatchObject({ invalid: true, identity: null, facts: [], finished: true });
  const next: Record<string, unknown> = {};
  const bounded = downloadRecoveryEvidence(sink, next, () => {}, validIdentity);
  for (let i = 0; i < 33; i++) bounded.record({ kind: 'download-boundaries', registrations: 0, deliveries: 0, triggers: 0, tap: 'not-observed' });
  expect(next['downloadRecoveryDiagnostic']).toMatchObject({ invalid: true, facts: expect.any(Array) });
  expect((next['downloadRecoveryDiagnostic'] as { facts: unknown[] }).facts).toHaveLength(32);
});

it('binds the real checkout identity and relevant source bytes without claiming a missing binary', () => {
  const meta: Record<string, unknown> = {};
  const evidence = downloadRecoveryEvidence(sink, meta, () => {});
  evidence.finish(outcome);
  expect(meta['downloadRecoveryDiagnostic']).toMatchObject({ invalid: false, identity: {
    sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/), sourceTree: expect.stringMatching(/^[a-f0-9]{40}$/),
    worktreeDirty: expect.any(Boolean), declaredNativeCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
    sources: expect.arrayContaining([expect.objectContaining({ file: '../integration/cdp-recovery.test.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]),
  } });
});

it.each(['extra', 'getter', 'toJSON', 'source-extra', 'source-getter', 'bad-commit', 'bad-node', 'bad-runtime', 'symbol', 'prototype'] as const)('rejects %s identity without exposing unvalidated data', mode => {
  const value = validIdentity(); let invoked = 0;
  const fail = () => { invoked++; return 'SECRET'; };
  if (mode === 'extra') Object.assign(value, { secret: 'SECRET' });
  if (mode === 'getter') Object.defineProperty(value, 'nodeVersion', { enumerable: true, get: fail });
  if (mode === 'toJSON') Object.assign(value, { toJSON: fail });
  if (mode === 'source-extra') Object.assign(value.sources[0]!, { secret: 'SECRET' });
  if (mode === 'source-getter') Object.defineProperty(value.sources, '0', { enumerable: true, get: fail });
  if (mode === 'bad-commit') value.sourceCommit = 'SECRET';
  if (mode === 'bad-node') value.nodeVersion = 'SECRET';
  if (mode === 'bad-runtime') value.runtimeIdentity = 'binary-hashed';
  if (mode === 'symbol') Object.assign(value, { [Symbol('secret')]: 'SECRET' });
  if (mode === 'prototype') Object.setPrototypeOf(value, { toJSON: fail });
  const lines: string[] = []; const meta = {};
  const evidence = downloadRecoveryEvidence(sink, meta, line => { lines.push(line); }, () => value);
  evidence.finish(outcome);
  expect(JSON.parse(lines[0]!.slice('DOWNLOAD_RECOVERY_DIAGNOSTIC '.length))).toMatchObject({ invalid: true, identity: null });
  expect(lines[0]).not.toContain('SECRET'); expect(invoked).toBe(0);
});

it.each(['extra', 'getter', 'toJSON', 'unknown'] as const)('rejects %s outcome without masking business failure', mode => {
  const value = { ...outcome } as Record<string, unknown>; let invoked = 0;
  if (mode === 'extra') value['secret'] = 'SECRET';
  if (mode === 'getter') Object.defineProperty(value, 'body', { enumerable: true, get: () => { invoked++; return 'SECRET'; } });
  if (mode === 'toJSON') value['toJSON'] = () => { invoked++; return 'SECRET'; };
  if (mode === 'unknown') value['body'] = 'SECRET';
  const lines: string[] = [];
  const evidence = downloadRecoveryEvidence(sink, {}, line => { lines.push(line); }, validIdentity);
  expect(() => evidence.finish(value as unknown as Parameters<SyntheticEvidence['finish']>[0])).not.toThrow();
  expect(JSON.parse(lines[0]!.slice('DOWNLOAD_RECOVERY_DIAGNOSTIC '.length))).toMatchObject({ invalid: true, outcome: null });
  expect(lines[0]).not.toContain('SECRET'); expect(invoked).toBe(0);
});
