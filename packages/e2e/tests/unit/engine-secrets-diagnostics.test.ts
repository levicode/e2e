import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineSecretsCapture, projectEngineSecretsIdentity, withEngineSecretsDiagnostics } from '../helpers/engine-secrets-diagnostics.ts';
import type { RunEventSink } from '../../src/run/events.ts';

const nonce = 'a'.repeat(64);
const worker = 'b'.repeat(64);
const secondWorker = 'c'.repeat(64);
const prefix = 'ENGINE_SECRETS_DIAGNOSTIC ';
const titles = ['signs in through basic auth', 'fails on the echoed password', 'fails on the echoed Authorization header', 'downloads the echoed headers', 'takes a screenshot of the page, an engine-held secret tainting no pixels'];
const pair = (index: number) => ({ testId: `test-${index}`, agent: 'default', repeat: 0 });
const report = () => ({ run: { targets: [{ id: 'web' }], errors: [], results: titles.map((title, index) => ({ declarationIndex: index, titlePath: [title], file: 'tests/basic-auth.e2e.ts', targetId: 'web', testId: `test-${index}`, agent: 'default', repeat: 0, selected: true, kind: 'test', status: 'passed', attempts: [{ index: 0, status: 'passed', cleanup: 'complete', secondaryErrors: [] }] })) } });
const row = (index: number, kind = 'start', token = worker, fields = {}) => ({ v: 1, kind, captureNonce: nonce, workerToken: token, surface: 1, attempt: index + 1, ...fields });
const cleanup = { nativeRetired: true, finalizedCleanupProven: true, recordingsRetired: true, released: true, connectingCleanupFailurePresent: false, retiringAttemptCleared: true, reason: 'complete', dirty: 'unknown' };
const guard = { workerRetired: false, workerCleanupUnconfirmed: false, retirementFailurePresent: false, attemptPresent: false, retiringAttemptPresent: false, connectingPresent: false };
function output(capture: ReturnType<typeof createEngineSecretsCapture>, index: number | undefined, text: string) {
  capture.onEvent({ seq: 1, at: '2026-10-31T00:00:00.000Z', type: 'output', target: 'web', pair: index === undefined ? undefined : pair(index), stream: 'stderr', text });
}
function emit(capture: ReturnType<typeof createEngineSecretsCapture>, index: number, value: unknown) { output(capture, index, prefix + JSON.stringify(value) + '\n'); }
function complete(capture: ReturnType<typeof createEngineSecretsCapture>) { for (let i = 0; i < 5; i++) { emit(capture, i, row(i)); emit(capture, i, row(i, 'cleanup', worker, cleanup)); } }
beforeEach(() => {
  vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '2'); vi.stubEnv('NODE_SELECTOR', process.versions.node);
  vi.stubEnv('E2E_CAPTURE_SOURCE_COMMIT', 'd'.repeat(40)); vi.stubEnv('E2E_CAPTURE_SOURCE_TREE', 'e'.repeat(40));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('bounded engine secret evidence', () => {
  it('retains all five exact identities and the middle download failure without text', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    const data = report(); data.run.results[3]!.status = 'failed'; data.run.results[3]!.attempts[0]!.status = 'failed';
    const result = capture.finish(data);
    expect(result.custody.projection).toBe('complete'); expect(result.custody.lifecycle).toBe('observed');
    expect(result.rows.find(value => value['kind'] === 'case' && value['caseOrdinal'] === 4)?.['status']).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(worker); expect(JSON.stringify(result)).not.toContain('test-');
  });
  it('binds reordered results by exact declaration identity, never array position', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report(); data.run.results.reverse();
    expect(capture.finish(data).rows.filter(value => value['kind'] === 'case').map(value => value['caseOrdinal'])).toEqual([1, 2, 3, 4, 5]);
  });
  it.each(['missing', 'duplicate', 'extra', 'title', 'file', 'declaration', 'repeat', 'target', 'attempt'] as const)('marks %s report identity invalid', fault => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report(); const first = data.run.results[0]!;
    if (fault === 'missing') data.run.results.pop();
    if (fault === 'duplicate') data.run.results[1] = first;
    if (fault === 'extra') data.run.results.push(first);
    if (fault === 'title') first.titlePath = ['CANARY'];
    if (fault === 'file') first.file = 'CANARY';
    if (fault === 'declaration') first.declarationIndex = 9;
    if (fault === 'repeat') first.repeat = 1;
    if (fault === 'target') first.targetId = 'other';
    if (fault === 'attempt') first.attempts.push(first.attempts[0]!);
    const result = capture.finish(data); expect(result.custody.projection).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('preserves a skipped middle download with no attempt, never invents passed', () => {
    const capture = createEngineSecretsCapture(nonce); const data = report();
    for (let i = 0; i < 5; i++) if (i !== 3) { emit(capture, i, row(i)); emit(capture, i, row(i, 'cleanup', worker, cleanup)); }
    data.run.results[3]!.status = 'skipped'; data.run.results[3]!.attempts = [];
    const result = capture.finish(data); expect(result.custody.projection).toBe('complete'); expect(result.rows.find(value => value['caseOrdinal'] === 4)?.['status']).toBe('skipped');
  });
  it('drops every arbitrary sensitive error/report field and unknown code', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report();
    const canary = 'DO_NOT_CAPTURE_SECRET';
    Object.assign(data.run.results[2]!.attempts[0]!, { error: { code: canary, phase: 'body', message: canary, stack: canary, details: { token: canary }, scopeId: canary }, artifacts: [{ path: canary }], appLog: [canary], extensions: { secret: canary } });
    Object.assign(data.run, { environment: { secret: canary }, project: canary });
    const result = capture.finish(data); expect(JSON.stringify(result)).not.toContain(canary); expect(result.rows.find(value => value['kind'] === 'case' && value['caseOrdinal'] === 3)?.['errorCode']).toBe('unknown');
  });
  it('keeps equal surface/start ordinals on two workers distinct through interleaved chunks', () => {
    const capture = createEngineSecretsCapture(nonce);
    const first = prefix + JSON.stringify(row(0)) + '\n'; const second = prefix + JSON.stringify(row(0, 'start', secondWorker)) + '\n';
    output(capture, 0, first.slice(0, 50)); output(capture, 1, second.slice(0, 70)); output(capture, 0, first.slice(50)); output(capture, 1, second.slice(70));
    emit(capture, 0, row(0, 'cleanup', worker, cleanup)); emit(capture, 1, row(0, 'cleanup', secondWorker, cleanup));
    for (let i = 2; i < 5; i++) { emit(capture, i, row(i)); emit(capture, i, row(i, 'cleanup', worker, cleanup)); }
    const result = capture.finish(report()); expect(result.custody.lifecycle).toBe('observed');
    const starts = result.rows.filter(value => value['kind'] === 'start'); expect(starts[0]?.['workerOrdinal']).not.toBe(starts[1]?.['workerOrdinal']); expect(starts[1]?.['caseOrdinal']).toBe(2);
  });
  it('attributes a late receipt to its original case, not the current output pair', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    emit(capture, 3, row(2, 'retirement', worker, { stage: 'download-file', before: 'undefined', after: 'value' }));
    const result = capture.finish(report()); expect(result.rows.find(value => value['kind'] === 'retirement')?.['caseOrdinal']).toBe(3);
  });
  it('refuses a second worker claiming the same pair and any missing owner start', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); emit(capture, 0, row(0, 'start', secondWorker)); emit(capture, 0, row(9, 'cleanup', secondWorker, cleanup));
    expect(capture.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('does not concatenate pairless partial writes', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    const line = prefix + JSON.stringify(row(2, 'retirement', worker, { stage: 'publication', before: 'undefined', after: 'value' })) + '\n';
    output(capture, undefined, line.slice(0, 30)); output(capture, undefined, line.slice(30));
    const result = capture.finish(report()); expect(result.custody.lifecycle).toBe('incomplete'); expect(result.rows.some(value => value['kind'] === 'retirement')).toBe(false);
  });
  it('retirement-present refusal without first-write evidence is incomplete', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); emit(capture, 0, row(0, 'guard', worker, { ...guard, retirementFailurePresent: true }));
    expect(capture.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('admits only strict current-run rows and never echoes rejected payload', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    emit(capture, 0, { ...row(0), message: 'CANARY' }); emit(capture, 0, { ...row(0), captureNonce: 'd'.repeat(64) });
    output(capture, 0, prefix + '{"bad":"CANARY"}\n');
    const result = capture.finish(report()); expect(result.custody.lifecycle).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('shares the 64-row budget with projections and marks all overflow incomplete', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    for (let i = 0; i < 60; i++) emit(capture, 0, row(0, 'admission', worker, { stage: 'pending-latch', origin: 'unjoined', wire: 'absent' }));
    const result = capture.finish(report()); expect(result.rows.length).toBe(64); expect(result.custody.overflow).toBe(true); expect(result.custody.lifecycle).toBe('incomplete'); expect(result.custody.projection).toBe('incomplete');
  });
  it('rejects overlong lines, truncated tails and ninth failure markers', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); output(capture, 0, prefix + 'x'.repeat(2050) + '\n'); emit(capture, 0, row(0, 'overflow', worker, { limit: 8 })); output(capture, 0, prefix);
    const result = capture.finish(report()); expect(result.custody.overflow).toBe(true); expect(result.custody.lifecycle).toBe('incomplete');
  });
  it('bounds worker/surface/attempt admission and tail allocations under hostile input', () => {
    const capture = createEngineSecretsCapture(nonce);
    for (let i = 0; i < 100; i++) { const token = i.toString(16).padStart(64, '0'); emit(capture, i, row(i, 'start', token)); }
    for (let i = 0; i < 100; i++) output(capture, i, prefix.slice(0, 5));
    const result = capture.finish(report()); expect(result.custody.workerBindings).toBeLessThanOrEqual(8); expect(result.custody.surfaceBindings).toBeLessThanOrEqual(16); expect(result.custody.attemptBindings).toBeLessThanOrEqual(16); expect(result.custody.overflow).toBe(true);
  });
  it('does not fabricate native origin or an absent wire from missing results', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const result = capture.finish(report()); expect(result.custody.nativeOrigin).toBe('unknown'); expect(result.rows.some(value => value['wire'] === 'absent')).toBe(false);
  });
  it('preserves run return identity and env with a throwing diagnostic sink', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', 'prior'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', 'prior-nonce');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('sink'); });
    const value = { outcome: { report: report() } };
    await expect(withEngineSecretsDiagnostics(async () => value)).resolves.toBe(value);
    expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('prior'); expect(process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE']).toBe('prior-nonce');
  });
  it('preserves the exact thrown object and emits incomplete custody on missing report', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); const written: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation((text) => { written.push(String(text)); return true; });
    const failure = new Error('BUSINESS_CANARY');
    await expect(withEngineSecretsDiagnostics(async () => { throw failure; })).rejects.toBe(failure);
    expect(written.join('')).not.toContain('BUSINESS_CANARY'); expect(written.join('')).toContain('"projection":"incomplete"');
  });

  it('joins later refusal to the same surface first-write, not the new attempt', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    emit(capture, 2, row(2, 'retirement', worker, { stage: 'publication', before: 'undefined', after: 'value' }));
    emit(capture, 4, row(4, 'guard', worker, { ...guard, retirementFailurePresent: true }));
    expect(capture.finish(report()).custody.lifecycle).toBe('observed');
  });
  it('never joins a retirement cause from another worker with identical surface number', () => {
    const capture = createEngineSecretsCapture(nonce);
    for (let i = 0; i < 5; i++) { const token = i === 4 ? secondWorker : worker; emit(capture, i, row(i, 'start', token)); emit(capture, i, row(i, 'cleanup', token, cleanup)); }
    emit(capture, 2, row(2, 'retirement', worker, { stage: 'publication', before: 'undefined', after: 'value' }));
    emit(capture, 4, row(4, 'guard', secondWorker, { ...guard, retirementFailurePresent: true }));
    expect(capture.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('preserves exact wire identity per client and caps per-client failures', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    const query = { client: 1, generation: 1, operationSeq: 1, command: 'fixture.query', transmittedTimeoutMs: 500, selectedLocalCancel: 'deadline', rawCode: 'cleanup-failed', rawEffects: 'unknown', rawScopeState: 'closed', returnedCode: 'cleanup-failed', timeoutRewritten: false, cancelAckSeen: false };
    emit(capture, 2, row(2, 'query', worker, query)); emit(capture, 2, row(2, 'query', worker, { ...query, client: 2 }));
    const result = capture.finish(report()); expect(result.custody.lifecycle).toBe('observed'); expect(result.rows.filter(value => value['kind'] === 'query').map(value => value['client'])).toEqual([1, 2]);
    const excess = createEngineSecretsCapture(nonce); complete(excess); for (let i = 0; i < 9; i++) emit(excess, 2, row(2, 'query', worker, query));
    expect(excess.finish(report()).custody.lifecycle).toBe('incomplete');
  });
  it('allows 64 total rows exactly but not an extra row hidden outside projection budget', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture);
    for (let i = 0; i < 49; i++) emit(capture, 0, row(0, 'admission', worker, { stage: 'pending-latch', origin: 'unjoined', wire: 'absent' }));
    const result = capture.finish(report()); expect(result.rows).toHaveLength(64); expect(result.custody.lifecycle).toBe('observed'); expect(result.custody.projection).toBe('complete');
  });
  it('caps retained surface and attempt owners at sixteen independently of workers', () => {
    for (const distinctSurfaces of [false, true]) {
      const capture = createEngineSecretsCapture(nonce);
      for (let i = 0; i < 17; i++) emit(capture, i, { ...row(i), surface: distinctSurfaces ? i + 1 : 1 });
      const result = capture.finish(report()); expect(result.custody.attemptBindings).toBe(16); expect(result.custody.surfaceBindings).toBeLessThanOrEqual(16); expect(result.custody.overflow).toBe(true);
    }
  });
  it('caps total tail text and refuses missing final projection', () => {
    const capture = createEngineSecretsCapture(nonce);
    for (let i = 0; i < 8; i++) output(capture, i, 'x'.repeat(1100));
    const result = capture.finish(undefined); expect(result.custody.overflow).toBe(true); expect(result.custody.projection).toBe('incomplete'); expect(result.custody.lifecycle).toBe('incomplete');
  });
  it('marks truncated secondary errors incomplete without copying their messages', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report();
    Object.assign(data.run.results[0]!.attempts[0]!, { secondaryErrors: Array.from({ length: 9 }, () => ({ phase: 'cleanup', code: 'INVALID_STATE', message: 'CANARY' })) });
    const result = capture.finish(data); expect(result.custody.overflow).toBe(true); expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('does not replace a returned outcome when a projection getter throws', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const value = { outcome: { get report(): unknown { throw new Error('CANARY'); } } };
    await expect(withEngineSecretsDiagnostics(async () => value)).resolves.toBe(value);
  });
  it('does not claim adequate unknown-outcome evidence when its admission/query row is missing', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report();
    Object.assign(data.run.results[2]!.attempts[0]!, { error: { code: 'ACTION_MAY_HAVE_COMMITTED', phase: 'body' } });
    expect(capture.finish(data).custody.lifecycle).toBe('incomplete');
  });
  it('records a failed begin write without changing the run outcome', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(text => { const line = String(text); if (line.startsWith('ENGINE_SECRETS_DIAGNOSTIC_BEGIN ')) throw new Error('sink'); written.push(line); return true; });
    const value = { outcome: { report: report() } }; await expect(withEngineSecretsDiagnostics(async () => value)).resolves.toBe(value);
    expect(written.join('')).toContain('"began":false');
  });
  it.each(['result-status', 'attempt-status', 'cleanup', 'duplicate-pair', 'renamed-target'] as const)('refuses structurally invalid %s without claiming projection complete', field => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report();
    if (field === 'result-status') data.run.results[0]!.status = 'CANARY';
    if (field === 'attempt-status') data.run.results[0]!.attempts[0]!.status = 'CANARY';
    if (field === 'cleanup') delete (data.run.results[0]!.attempts[0] as { cleanup?: string }).cleanup;
    if (field === 'duplicate-pair') data.run.results[1]!.testId = data.run.results[0]!.testId;
    if (field === 'renamed-target') { data.run.targets[0]!.id = 'other'; for (const result of data.run.results) result.targetId = 'other'; }
    const result = capture.finish(data); expect(result.custody.projection).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('accepts closed worker loss without allocating a fabricated owner', () => {
    const capture = createEngineSecretsCapture(nonce);
    output(capture, undefined, prefix + JSON.stringify({ v: 1, captureNonce: nonce, workerToken: worker, kind: 'capture-loss', reason: 'owner-unjoined' }) + '\n');
    const result = capture.finish(report()); expect(result.custody.overflow).toBe(true); expect(result.custody.workerBindings).toBe(0); expect(result.custody.surfaceBindings).toBe(0); expect(result.custody.attemptBindings).toBe(0);
    expect(result.rows.find(value => value['kind'] === 'capture-loss')).toEqual({ v: 1, kind: 'capture-loss', reason: 'owner-unjoined', worker: 'unjoined' });
    expect(JSON.stringify(result)).not.toContain(worker);
  });
  it('turns ACTUAL runtime client-cap loss into incomplete evidence below the row cap', async () => {
    vi.resetModules(); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', nonce);
    const lines: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(text => { lines.push(String(text)); return true; });
    const runtime = await import('../../../web/src/native/secrets-diagnostics.ts');
    const surface = runtime.createSecretsSurface()!; const owner = surface.start();
    surface.emit(owner, { kind: 'cleanup', nativeRetired: true, finalizedCleanupProven: true, recordingsRetired: true, released: true, connectingCleanupFailurePresent: false, retiringAttemptCleared: true, reason: 'complete', dirty: 'unknown' });
    const raw = { error: { code: 'cancelled' }, effects: 'unknown', scopeState: 'closed' };
    for (let i = 0; i < 17; i++) runtime.observeSecretsQuery({}, owner, 'fixture.query', raw, raw, { generation: 1, operationSeq: 7, transmittedTimeoutMs: 500, cancellation: undefined, timeoutRewritten: false, cancelAckSeen: false });
    expect(lines.length).toBeLessThan(64); expect(lines.some(line => line.includes('"reason":"client-cap"'))).toBe(true);
    const capture = createEngineSecretsCapture(nonce); for (const line of lines) output(capture, 0, line);
    const data = report(); for (let i = 1; i < 5; i++) { data.run.results[i]!.status = 'skipped'; data.run.results[i]!.attempts = []; }
    const result = capture.finish(data); expect(result.custody.projection).toBe('complete'); expect(result.custody.invalidRecords).toBe(0); expect(result.custody.lifecycle).toBe('incomplete'); expect(result.custody.overflow).toBe(true);
  });
  it('turns ACTUAL unowned runtime cleanup loss into incomplete without a start', async () => {
    vi.resetModules(); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', nonce);
    const lines: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(text => { lines.push(String(text)); return true; });
    const runtime = await import('../../../web/src/native/secrets-diagnostics.ts'); runtime.createSecretsSurface()!.loss('owner-unjoined');
    expect(lines).toHaveLength(1); const capture = createEngineSecretsCapture(nonce); output(capture, undefined, lines[0]!);
    const data = report(); for (const result of data.run.results) { result.status = 'skipped'; result.attempts = []; }
    const result = capture.finish(data); expect(result.custody.projection).toBe('complete'); expect(result.custody.invalidRecords).toBe(0); expect(result.custody.lifecycle).toBe('incomplete'); expect(result.custody.workerBindings).toBe(0);
  });
  it('does not claim exhaustive lifecycle delivery even when all required observed rows exist', () => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const result = capture.finish(report());
    expect(result.custody.lifecycle).toBe('observed'); expect(result.custody.coverage).toBe('observed-only'); expect(result.custody.exhaustive).toBe(false); expect(result.custody.noAbsenceInference).toBe(true);
  });
  it.each(['cleanup', 'run'] as const)('marks known %s failure without a retirement/loss receipt incomplete', source => {
    const capture = createEngineSecretsCapture(nonce); complete(capture); const data = report();
    if (source === 'cleanup') data.run.results[0]!.attempts[0]!.cleanup = 'failed';
    else Object.assign(data.run, { errors: [{ phase: 'cleanup', code: 'INVALID_STATE', message: 'CANARY' }] });
    const result = capture.finish(data); expect(result.custody.lifecycle).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('projects the real local Node identity without claiming a CI patch version', () => {
    expect(projectEngineSecretsIdentity(process.env, process.version)).toEqual({ consumerRun: '123', consumerAttempt: '2', selector: process.versions.node, nodeVersion: process.version, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), caseSchema: 'engine-secrets-five-v1' });
  });
  it.each(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'NODE_SELECTOR', 'E2E_CAPTURE_SOURCE_COMMIT', 'E2E_CAPTURE_SOURCE_TREE'])('rejects missing or arbitrary %s without reflecting it', field => {
    const missing = { ...process.env }; delete missing[field]; expect(projectEngineSecretsIdentity(missing, process.version)).toBeUndefined();
    expect(projectEngineSecretsIdentity({ ...process.env, [field]: 'CANARY\nINJECT' }, process.version)).toBeUndefined();
  });
  it.each([
    ['22.23.4', 'v24.22.1'],
    ['24.22.1', 'v22.23.4'],
  ])('refuses invalid identities independently of the host runtime: %s', (selector, mismatchedVersion) => {
    const identity = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', NODE_SELECTOR: selector, E2E_CAPTURE_SOURCE_COMMIT: 'd'.repeat(40), E2E_CAPTURE_SOURCE_TREE: 'e'.repeat(40) };
    expect(projectEngineSecretsIdentity(identity, `v${selector}`)).toEqual({ consumerRun: '123', consumerAttempt: '2', selector, nodeVersion: `v${selector}`, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), caseSchema: 'engine-secrets-five-v1' });
    for (const invalidSelector of ['20.19.0', '24.1000.1', 'v24.19.0', '24.19.0\n']) expect(projectEngineSecretsIdentity({ ...identity, NODE_SELECTOR: invalidSelector }, `v${invalidSelector}`)).toBeUndefined();
    expect(projectEngineSecretsIdentity(identity, mismatchedVersion)).toBeUndefined();
    for (const run of ['0', '01', '1'.repeat(21)]) expect(projectEngineSecretsIdentity({ ...identity, GITHUB_RUN_ID: run }, `v${selector}`)).toBeUndefined();
  });
  it('binds BEGIN and END to actual consumer identity and labels base source separately', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(text => { written.push(String(text)); return true; });
    await withEngineSecretsDiagnostics(async () => ({ outcome: { report: report() } }));
    const begin = JSON.parse(written.find(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC_BEGIN '))!.slice('ENGINE_SECRETS_DIAGNOSTIC_BEGIN '.length));
    const end = JSON.parse(written.find(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC_END '))!.slice('ENGINE_SECRETS_DIAGNOSTIC_END '.length));
    expect(end).toEqual(begin); expect(begin).toMatchObject({ consumerRun: '123', consumerAttempt: '2', selector: process.versions.node, nodeVersion: process.version, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), caseSchema: 'engine-secrets-five-v1' });
    expect(written.join('')).toContain('"baseConsumer":"ad67f6c766c093800a04315ae5f05feb148cf28c"'); expect(written.join('')).not.toContain('"sourceConsumer"');
  });
  it('makes missing identity explicitly unavailable without changing result, error or runtime env', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('NODE_SELECTOR', 'CANARY'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '0');
    const written: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(text => { written.push(String(text)); return true; });
    const value = { outcome: { report: report() } }; let sink: RunEventSink | undefined;
    await expect(withEngineSecretsDiagnostics(async onEvent => { sink = onEvent; return value; })).resolves.toBe(value);
    const failure = new Error('BUSINESS'); await expect(withEngineSecretsDiagnostics(async () => { throw failure; })).rejects.toBe(failure);
    expect(sink).toBeUndefined(); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('0');
    expect(written.every(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC_UNAVAILABLE '))).toBe(true); expect(written.join('')).not.toContain('CANARY'); expect(written.join('')).not.toContain('BUSINESS');
  });
  it.each(['1', 'prior'])('isolates conflicting active diagnostics without altering the business result: %s', async active => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', active);
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', 'a'.repeat(64)); vi.stubEnv('E2E_NATIVE_DIAGNOSTIC_SUITE', 'unserved-model-two-workers');
    const written: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(text => { written.push(String(text)); return true; });
    const value = { outcome: { report: report() } };
    await expect(withEngineSecretsDiagnostics(async onEvent => { expect(onEvent).toBeUndefined(); expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('0'); return value; })).resolves.toBe(value);
    const failure = new Error('BUSINESS_CANARY'); await expect(withEngineSecretsDiagnostics(async () => { expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe('0'); throw failure; })).rejects.toBe(failure);
    expect(process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC']).toBe(active); expect(process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE']).toBe('a'.repeat(64)); expect(process.env['E2E_NATIVE_DIAGNOSTIC_SUITE']).toBe('unserved-model-two-workers');
    expect(written.filter(line => line.startsWith('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT '))).toHaveLength(2);
    expect(written.every(line => line.startsWith('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT ') || line.startsWith('ENGINE_SECRETS_DIAGNOSTIC_UNAVAILABLE '))).toBe(true);
    expect(written.join('')).not.toContain('BUSINESS_CANARY'); expect(written.join('')).not.toContain('a'.repeat(64));
  });
  it('does not default an unknown suite to secrets', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '0'); vi.stubEnv('E2E_NATIVE_DIAGNOSTIC_SUITE', 'PRIVATE_SUITE_CANARY');
    const written: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation(text => { written.push(String(text)); return true; });
    await withEngineSecretsDiagnostics(async onEvent => { expect(onEvent).toBeUndefined(); return { outcome: { report: report() } }; });
    expect(written.some(line => line.startsWith('NATIVE_DIAGNOSTIC_CAPTURE_CONFLICT '))).toBe(true); expect(written.join('')).not.toContain('PRIVATE_SUITE_CANARY');
  });
  it('is inert without exact opt-in', async () => {
    vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '0'); let sink: RunEventSink | undefined;
    const value = { outcome: { report: report() } }; await expect(withEngineSecretsDiagnostics(async onEvent => { sink = onEvent; return value; })).resolves.toBe(value); expect(sink).toBeUndefined();
  });
});
