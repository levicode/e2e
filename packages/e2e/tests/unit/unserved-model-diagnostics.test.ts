import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUnservedModelCapture, projectUnservedModelIdentity, withUnservedModelDiagnostics } from '../helpers/unserved-model-diagnostics.ts';

const nonce = 'a'.repeat(64), worker = 'b'.repeat(64), other = 'c'.repeat(64);
const prefix = 'UNSERVED_MODEL_DIAGNOSTIC ';
const pair = (n: number) => ({ testId: `test-${n}`, agent: 'default', repeat: 0 });
const clean = { nativeRetired: true, finalizedCleanupProven: true, recordingsRetired: true, released: true, connectingCleanupFailurePresent: false, retiringAttemptCleared: true, reason: 'complete', dirty: 'unknown' };
const report = () => ({ run: { targets: [{ id: 'web' }], errors: [{ code: 'MODEL_UNAVAILABLE', phase: 'body' }], results: ['judges', 'acts'].map((title, n) => ({ declarationIndex: 0, titlePath: [title], file: n === 0 ? 'tests/one.e2e.ts' : 'tests/two.e2e.ts', targetId: 'web', testId: `test-${n}`, agent: 'default', repeat: 0, selected: true, kind: 'test', status: 'interrupted', attempts: [{ index: 0, status: 'interrupted', cleanup: 'complete', secondaryErrors: [] as unknown[] }] })) } });
type Capture = ReturnType<typeof createUnservedModelCapture>;
const row = (n: number, kind = 'start', fields: Record<string, unknown> = {}, token = worker) => ({ v: 1, kind, captureNonce: nonce, workerToken: token, surface: 1, attempt: n + 1, ...fields });
function output(c: Capture, n: number | undefined, text: string) { c.onEvent({ type: 'output', seq: 1, at: '2026-10-31T00:00:00.000Z', target: 'web', pair: n === undefined ? undefined : pair(n), stream: 'stderr', text }); }
function emit(c: Capture, n: number | undefined, value: unknown) { output(c, n, prefix + JSON.stringify(value) + '\n'); }
function complete(c: Capture) { for (let n = 0; n < 2; n++) { emit(c, n, row(n)); emit(c, n, row(n, 'cleanup', clean)); } }
function failure(c: Capture, n: number) { emit(c, n, row(n, 'retirement', { stage: 'native-close', before: 'undefined', after: 'value' })); emit(c, n, row(n, 'first-cause', { stage: 'native-close', code: 'unknown', category: 'unknown' })); }
beforeEach(() => {
  vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '1'); vi.stubEnv('NODE_SELECTOR', process.versions.node);
  vi.stubEnv('E2E_CAPTURE_SOURCE_COMMIT', 'd'.repeat(40)); vi.stubEnv('E2E_CAPTURE_SOURCE_TREE', 'e'.repeat(40));
  vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', ''); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('dedicated observed-only unavailable-model capture', () => {
  it('accepts two exact cases even on one worker with distinct attempts; model failure needs no false retirement', () => {
    const c = createUnservedModelCapture(nonce); complete(c); const value = c.finish(report());
    expect(value.custody).toMatchObject({ projection: 'complete', lifecycle: 'observed', workerBindings: 1, attemptBindings: 2, exhaustive: false, noAbsenceInference: true });
    expect(value.rows.filter(r => r['kind'] === 'case')).toHaveLength(2);
  });
  it('binds interleaved two-worker chunks and late original-owner cleanup', () => {
    const c = createUnservedModelCapture(nonce); const a = prefix + JSON.stringify(row(0)) + '\n'; const b = prefix + JSON.stringify(row(0, 'start', {}, other)) + '\n';
    output(c, 0, a.slice(0, 40)); output(c, 1, b.slice(0, 70)); output(c, 0, a.slice(40)); output(c, 1, b.slice(70));
    emit(c, undefined, row(0, 'cleanup', clean)); emit(c, undefined, row(0, 'cleanup', clean, other));
    expect(c.finish(report()).custody).toMatchObject({ lifecycle: 'observed', workerBindings: 2 });
  });
  it.each(['file','title','declaration','repeat','target','missing','duplicate','attempt'])('rejects report identity fault %s', fault => {
    const c = createUnservedModelCapture(nonce); complete(c); const r = report(); const one = r.run.results[0]!;
    if (fault === 'file') one.file = 'tests/basic-auth.e2e.ts'; if (fault === 'title') one.titlePath = ['CANARY'];
    if (fault === 'declaration') one.declarationIndex = 1; if (fault === 'repeat') one.repeat = 1; if (fault === 'target') one.targetId = 'other';
    if (fault === 'missing') r.run.results.pop(); if (fault === 'duplicate') r.run.results[1] = one; if (fault === 'attempt') one.attempts = [];
    const value = c.finish(r); expect(value.custody.projection).toBe('incomplete'); expect(JSON.stringify(value)).not.toContain('CANARY');
  });
  it('keeps first-cause/cleanup classified separately from the run MODEL_UNAVAILABLE', () => {
    const c = createUnservedModelCapture(nonce); emit(c, 0, row(0)); emit(c, 0, row(0, 'cleanup', clean)); emit(c, 1, row(1)); failure(c, 1);
    emit(c, 1, row(1, 'cleanup', { ...clean, reason: 'receipt-failed' })); const r = report(); r.run.results[1]!.attempts[0]!.cleanup = 'failed'; r.run.results[1]!.attempts[0]!.secondaryErrors.push({ code: 'ENGINE_FAILURE', phase: 'cleanup' });
    expect(c.finish(r).custody.lifecycle).toBe('observed');
  });
  it('accepts observed unresolved custody without inventing first cause', () => {
    const c = createUnservedModelCapture(nonce); emit(c, 0, row(0)); emit(c, 0, row(0, 'cleanup', clean)); emit(c, 1, row(1));
    emit(c, 1, row(1, 'cleanup', { ...clean, nativeRetired: false, retiringAttemptCleared: false, reason: 'unresolved-custody' }));
    const r = report(); r.run.results[1]!.attempts[0]!.cleanup = 'failed'; expect(c.finish(r).custody.lifecycle).toBe('observed');
  });
  it.each(['wrong-nonce','duplicate-owner','duplicate-pair','unjoined','partial-tail','missing-cleanup','unknown-field','cause-text','first-before-retirement'])('fails closed on %s', fault => {
    const c = createUnservedModelCapture(nonce);
    if (fault === 'wrong-nonce') emit(c, 0, row(0, 'start', { captureNonce: other }));
    if (fault === 'duplicate-owner') { emit(c, 0, row(0)); emit(c, 1, row(0)); }
    if (fault === 'duplicate-pair') { emit(c, 0, row(0)); emit(c, 0, row(1)); }
    if (fault === 'unjoined') emit(c, undefined, row(0));
    if (fault === 'partial-tail') output(c, 0, prefix + '{');
    if (fault === 'missing-cleanup') { emit(c, 0, row(0)); emit(c, 1, row(1)); }
    if (fault === 'unknown-field') emit(c, 0, row(0, 'start', { message: 'DO_NOT_CAPTURE' }));
    if (fault === 'cause-text') { emit(c, 0, row(0)); emit(c, 0, row(0, 'first-cause', { stage: 'native-close', code: 'DO_NOT_CAPTURE', category: 'unknown' })); }
    if (fault === 'first-before-retirement') { emit(c, 0, row(0)); emit(c, 0, row(0, 'first-cause', { stage: 'native-close', code: 'unknown', category: 'unknown' })); }
    const value = c.finish(report()); expect(value.custody.lifecycle).toBe('incomplete'); expect(JSON.stringify(value)).not.toContain('DO_NOT_CAPTURE');
  });
  it('preserves total64 including two case projections and reserved terminal loss', () => {
    const c = createUnservedModelCapture(nonce); complete(c);
    for (let n = 0; n < 80; n++) emit(c, 0, row(0, 'admission', { stage: 'require-attempt', wire: 'absent', origin: 'unjoined' }));
    const value = c.finish(report()); expect(value.rows.length).toBeLessThanOrEqual(64); expect(value.rows.at(-1)).toMatchObject({ kind: 'capture-loss' });
    expect(value.rows.filter(r => r['kind'] === 'case')).toHaveLength(2); expect(value.custody.lifecycle).toBe('incomplete');
  });
  it('treats trailing producer loss as sticky incomplete', () => {
    const c = createUnservedModelCapture(nonce); complete(c); emit(c, undefined, { v: 1, kind: 'capture-loss', captureNonce: nonce, workerToken: worker, reason: 'row-cap' });
    expect(c.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('never serializes arbitrary report data', () => {
    const c = createUnservedModelCapture(nonce); complete(c); const r = report(); Object.assign(r.run.results[0]!.attempts[0]!, { error: { code: 'CANARY', message: 'CANARY', stack: 'CANARY', phase: 'CANARY' }, payload: 'CANARY' });
    expect(JSON.stringify(c.finish(r))).not.toContain('CANARY');
  });
  it('requires paired first-cause after observed retirement even if cleanup is complete', () => {
    const c = createUnservedModelCapture(nonce); complete(c); emit(c, 0, row(0, 'retirement', { stage: 'native-close', before: 'undefined', after: 'value' }));
    expect(c.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it.each(['valid','extra-key','bad-schema'])('treats shared conflict marker %s as sticky incomplete without owner rows', fault => {
    const c = createUnservedModelCapture(nonce); complete(c);
    const value = fault === 'valid' ? { schemaVersion: 1, status: 'incomplete' } : fault === 'extra-key' ? { schemaVersion: 1, status: 'incomplete', message: 'CANARY' } : { schemaVersion: 2, status: 'complete' };
    output(c, undefined, 'NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT ' + JSON.stringify(value) + '\n');
    const result = c.finish(report()); expect(result.custody.lifecycle).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain('CANARY'); expect(result.rows.filter(r => r['kind'] === 'case')).toHaveLength(2);
  });
  it.each(['worker','surface','attempt','tail','line','query'])('retains fixed %s cap and incomplete state', fault => {
    const c = createUnservedModelCapture(nonce);
    if (fault === 'worker') for (let n = 0; n < 9; n++) emit(c, n, row(0, 'start', {}, n.toString(16).padStart(64, '0')));
    if (fault === 'surface') for (let n = 0; n < 17; n++) emit(c, n, row(0, 'start', { surface: n + 1 }));
    if (fault === 'attempt') for (let n = 0; n < 17; n++) emit(c, n, row(n));
    if (fault === 'tail') for (let n = 0; n < 9; n++) output(c, n, 'x'.repeat(1200));
    if (fault === 'line') output(c, 0, prefix + 'x'.repeat(2049) + '\n');
    if (fault === 'query') {
      emit(c, 0, row(0));
      for (let n = 0; n < 9; n++) emit(c, 0, row(0, 'query', { client: 1, generation: 1, operationSeq: n + 1, command: 'browser.query', transmittedTimeoutMs: 10, selectedLocalCancel: 'none', rawCode: 'unknown', rawEffects: 'unknown', rawScopeState: 'unknown', returnedCode: 'unknown', timeoutRewritten: false, cancelAckSeen: false }));
    }
    const value = c.finish(report()); expect(value.custody.lifecycle).toBe('incomplete'); expect(value.custody.workerBindings).toBeLessThanOrEqual(8); expect(value.custody.surfaceBindings).toBeLessThanOrEqual(16); expect(value.custody.attemptBindings).toBeLessThanOrEqual(16);
  });
  it.each(['duplicate','different-stage'])('rejects first-cause %s', fault => {
    const c = createUnservedModelCapture(nonce); complete(c); failure(c, 1);
    emit(c, 1, row(1, 'first-cause', { stage: fault === 'duplicate' ? 'native-close' : 'scope-end', code: 'unknown', category: 'unknown' }));
    expect(c.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('sink failure cannot replace the actual workload return', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('synthetic sink'); });
    const value = { outcome: { report: report() } }; expect(await withUnservedModelDiagnostics(async () => value)).toBe(value);
  });
  it('dedicated wrapper is no-op without capture', async () => {
    const sentinel = { outcome: { report: report() } }; const run = vi.fn(async (sink: unknown) => { expect(sink).toBeUndefined(); return sentinel; });
    expect(await withUnservedModelDiagnostics(run)).toBe(sentinel); expect(run).toHaveBeenCalledTimes(1);
  });
  it('restores four env values and preserves thrown Proxy identity without probing', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', 'prior'); vi.stubEnv('E2E_NATIVE_DIAGNOSTIC_SUITE', 'prior-suite'); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let traps = 0; const thrown = new Proxy({}, { get() { traps++; throw 1; }, getOwnPropertyDescriptor() { traps++; throw 1; }, getPrototypeOf() { traps++; throw 1; } });
    let seen: unknown; try { await withUnservedModelDiagnostics(async () => { throw thrown; }); } catch (cause) { seen = cause; }
    expect(seen === thrown).toBe(true); expect(traps).toBe(0); expect(process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE']).toBe('prior'); expect(process.env['E2E_NATIVE_DIAGNOSTIC_SUITE']).toBe('prior-suite'); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('');
  });
  it('does not overwrite overlapping mode and keeps workload once', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '1'); vi.stubEnv('E2E_NATIVE_DIAGNOSTIC_SUITE', 'engine-secrets');
    const lines: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(value => { lines.push(String(value)); return true; });
    let calls = 0; await withUnservedModelDiagnostics(async sink => { calls++; expect(sink).toBeUndefined(); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('0'); return { outcome: { report: report() } }; });
    expect(calls).toBe(1); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('1'); expect(process.env['E2E_NATIVE_DIAGNOSTIC_SUITE']).toBe('engine-secrets'); expect(lines.join('')).toContain('overlapping-capture'); expect(lines.join('')).toContain('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT {"schemaVersion":1,"status":"incomplete"}'); expect(lines.join('')).not.toContain('_BEGIN');
  });
  it.each([false, true])('restores suppressed overlapping observer after rejection even with missing identity=%s', async missingIdentity => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', nonce); vi.stubEnv('E2E_NATIVE_DIAGNOSTIC_SUITE', 'engine-secrets'); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    if (missingIdentity) vi.stubEnv('GITHUB_RUN_ID', '');
    const sentinel = Object.freeze({}); let seen: unknown;
    try { await withUnservedModelDiagnostics(async sink => { expect(sink).toBeUndefined(); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('0'); throw sentinel; }); } catch (cause) { seen = cause; }
    expect(seen === sentinel).toBe(true); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('1'); expect(process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE']).toBe(nonce); expect(process.env['E2E_NATIVE_DIAGNOSTIC_SUITE']).toBe('engine-secrets');
  });
  it('validates actual identity, not source constants', () => {
    expect(projectUnservedModelIdentity(process.env, process.version)?.caseSchema).toBe('unserved-model-two-v1'); expect(projectUnservedModelIdentity(process.env, 'v1.0.0')).toBeUndefined();
  });
});

// Explicit synthetic identities; these do not claim Node26 execution.
describe('declared fullmatrix selector identity', () => {
  it.each([["22", "v22.23.4", true], ["24", "v24.22.1", true], ["26", "v26.0.0", true], ["22.22.3", "v22.22.3", true], ["24.8.0", "v24.8.0", true], ["22.23.4", "v22.23.4", true], ["24.22.1", "v24.22.1", true], ["26.1.2", "v26.1.2", true], ["26", "v26.999.999", true], ["26.999.999", "v26.999.999", true], ["22", "v24.22.1", false], ["24", "v26.0.0", false], ["26", "v22.23.4", false], ["22.22.3", "v22.22.4", false], ["24.8.0", "v24.8.1", false], ["26.1.2", "v26.1.3", false], ["20", "v20.1.0", false], ["25.1.0", "v25.1.0", false], ["27", "v27.0.0", false], ["026", "v26.0.0", false], ["26.01.0", "v26.01.0", false], ["26.0.00", "v26.0.00", false], ["26.1000.0", "v26.1000.0", false], ["26", "v26.1000.0", false], ["v26.0.0", "v26.0.0", false], ["26", "26.0.0", false], ["26.0", "v26.0.0", false], ["26.0.0.0", "v26.0.0.0", false], ["26\n", "v26.0.0", false], ["26.0.0", "v26.0.0\n", false], [" 26", "v26.0.0", false], ["26 ", "v26.0.0", false], ["../26", "v26.0.0", false], ["/26", "v26.0.0", false], ["26.0.0-beta", "v26.0.0-beta", false], ["26.0.0+build", "v26.0.0+build", false]]) ('binds requested %s to actual %s with acceptance %s', (selector, nodeVersion, accepted) => {
    const env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', NODE_SELECTOR: selector as string, E2E_CAPTURE_SOURCE_COMMIT: 'a'.repeat(40), E2E_CAPTURE_SOURCE_TREE: 'b'.repeat(40) };
    const result = projectUnservedModelIdentity(env, nodeVersion as string);
    if (accepted) expect(result).toMatchObject({ selector, nodeVersion }); else expect(result).toBeUndefined();
  });
});
