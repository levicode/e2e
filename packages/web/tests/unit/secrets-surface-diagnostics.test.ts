/** Pure insertion-point controls: real surface methods, no process/browser/transport creation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, OperationContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { connectionDeadline } from '../../src/operation-budget.ts';

type Row = Record<string, unknown>;
const rows: Row[] = [];
const signal = () => new AbortController().signal;
const context = (): EngineAttemptContext => ({ attemptId: 'fixture', artifactsDir: '/tmp/unused', signal: signal(), resolveSecret: async () => { throw new Error('unused'); }, appLog: () => {}, navigation: () => {}, environment: () => {} });
const operation = (): OperationContext => ({ signal: signal(), timeoutMs: 1000, runId: 'fixture', attemptId: 'fixture', origin: 'test' });
/** Test-only structural access exercises original private methods without exposing a production seam. */
function set(surface: NativeSurface, key: string, value: unknown): void { Reflect.set(surface, key, value); }
function get(surface: NativeSurface, key: string): unknown { return Reflect.get(surface, key); }
function call<T>(surface: NativeSurface, key: string, ...args: unknown[]): T { return Reflect.apply(Reflect.get(surface, key) as (...args: unknown[]) => T, surface, args); }
function deferred() { let resolve!: () => void; let reject!: (cause: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function owned(surface: NativeSurface) {
  const owner = context(); set(surface, 'workerCleanupUnconfirmed', true);
  await expect(surface.startAttempt(owner)).rejects.toThrow();
  set(surface, 'workerCleanupUnconfirmed', false);
  const attempt = { context: owner, ready: true, pageReady: true, epoch: 0, scope: 'fixture', retirement: new AbortController(), resourceCleanup: new AbortController(), wireRequests: new Set(), videoBlobBatches: new Set(), downloads: new Map(), downloadFiles: new Set(), recordingStarts: new Set(), lateRecordings: new Set(), lateRecordingStops: new Map() };
  set(surface, 'attempt', attempt); rows.length = 0; return attempt;
}
function deadline(remaining: () => { signal: AbortSignal; timeoutMs: number } = () => ({ signal: signal(), timeoutMs: 1000 })) { return { context: { signal: signal(), timeoutMs: 1000 }, remaining, dispose: () => {} }; }

beforeEach(() => {
  rows.length = 0;
  vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_DIAGNOSTIC', '1'); vi.stubEnv('E2E_ENGINE_SECRETS_CAPTURE_NONCE', 'a'.repeat(64));
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    const text = String(chunk); if (text.startsWith('ENGINE_SECRETS_DIAGNOSTIC ')) rows.push(JSON.parse(text.slice('ENGINE_SECRETS_DIAGNOSTIC '.length)) as Row); return true;
  }) as typeof process.stderr.write);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('real NativeSurface diagnostic insertion points', () => {
  it('records the guard after the original retirement wait, not its entry snapshot', async () => {
    const surface = new NativeSurface({}); const pending = deferred(); set(surface, 'endingAttempt', pending.promise);
    const work = surface.startAttempt(context()); expect(rows.filter(row => row['kind'] === 'guard')).toHaveLength(0);
    set(surface, 'workerCleanupUnconfirmed', true); pending.resolve();
    await expect(work).rejects.toThrow('provider recording cleanup is unresolved');
    expect(rows.find(row => row['kind'] === 'guard')?.['workerCleanupUnconfirmed']).toBe(true);
  });
  it('rethrows the exact pending latch error before any intended query is issued', async () => {
    const surface = new NativeSurface({}); await owned(surface); const failure = new Error('private canary');
    surface.latch.latch(failure);
    const wire = vi.fn(); set(surface, 'engineCommand', wire);
    await expect(surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'fixture', exact: true } } }, operation(), { purpose: 'fixture' })).rejects.toBe(failure);
    expect(wire).not.toHaveBeenCalled(); expect(rows).toMatchObject([{ kind: 'admission', stage: 'pending-latch', wire: 'absent', origin: 'unjoined' }]);
    expect(JSON.stringify(rows)).not.toContain('private canary');
  });
  it('preserves real undefined/null assignments and the later nonnull first failure', async () => {
    const surface = new NativeSurface({}); const attempt = await owned(surface);
    call(surface, 'recordPublicationFailure', attempt, undefined); expect(get(surface, 'retirementFailure')).toBeUndefined(); expect(rows).toHaveLength(0);
    call(surface, 'recordPublicationFailure', attempt, null); expect(get(surface, 'retirementFailure')).toBeNull();
    const failure = new Error('private canary'); call(surface, 'recordPublicationFailure', attempt, failure);
    expect(get(surface, 'retirementFailure')).toBe(failure);
    expect(rows.map(row => [row['before'], row['after']])).toEqual([['undefined', 'null'], ['null', 'value']]);
  });
  it('keeps the original assigned failure across a reentrant throwing diagnostic sink', async () => {
    const surface = new NativeSurface({}); const attempt = await owned(surface); const first = new Error('first'); const later = new Error('later');
    vi.mocked(process.stderr.write).mockImplementation(() => { call(surface, 'recordPublicationFailure', attempt, later); throw new Error('sink'); });
    expect(() => call(surface, 'recordPublicationFailure', attempt, first)).not.toThrow(); expect(get(surface, 'retirementFailure')).toBe(first);
  });
  it('retains the first real receipt rejection even when teardown awaits another receipt first', async () => {
    const surface = new NativeSurface({}); const attempt = await owned(surface); const finalized = deferred(); const stopping = deferred();
    Object.assign(attempt, { finalizedVideo: { retire: () => finalized.promise }, recordingStop: stopping.promise });
    const work = call<Promise<void>>(surface, 'closeAttempt', deadline()); const observed = work.catch(cause => cause);
    const first = new Error('stop first'); const later = new Error('finalized later'); stopping.reject(first); await Promise.resolve(); finalized.reject(later);
    expect(await observed).toBe(first); expect(get(surface, 'retirementFailure')).toBe(first);
    expect(rows.filter(row => row['kind'] === 'retirement')).toMatchObject([{ stage: 'recording-stop', before: 'undefined', after: 'value' }]);
  });
  it('does not turn the original departed local waiter into a failed cleanup receipt', async () => {
    const surface = new NativeSurface({}); await owned(surface); const departure = connectionDeadline('fixture wait');
    await call<Promise<void>>(surface, 'closeAttempt', deadline(() => { throw departure; }));
    expect(get(surface, 'retirementFailure')).toBeUndefined(); expect(rows.some(row => row['kind'] === 'retirement')).toBe(false);
    expect(rows.find(row => row['kind'] === 'cleanup')).toMatchObject({ reason: 'complete', retiringAttemptCleared: true });
  });
  it('changes diagnostic epoch only at the original successful worker-retirement reset', async () => {
    const surface = new NativeSurface({}); await owned(surface); const old = get(surface, 'secretsDiagnostics');
    set(surface, 'attempt', undefined); const retired = new AbortController(); retired.abort(); set(surface, 'workerRetirement', retired); set(surface, 'workerRestartable', true); set(surface, 'retirementFailure', new Error('old'));
    const aborted = new AbortController(); aborted.abort();
    await expect(call<Promise<void>>(surface, 'init', { signal: aborted.signal })).rejects.toThrow();
    expect(get(surface, 'retirementFailure')).toBeUndefined(); expect(get(surface, 'secretsDiagnostics')).not.toBe(old);
    const reset = get(surface, 'secretsDiagnostics'); await expect(call<Promise<void>>(surface, 'init', { signal: aborted.signal })).rejects.toThrow(); expect(get(surface, 'secretsDiagnostics')).toBe(reset);
  });
  it('marks an ownerless real closeWorker failure unjoined rather than attaching it to the last case', async () => {
    const surface = new NativeSurface({}); const failure = new Error('worker release');
    set(surface, 'retireAttempt', async () => {}); set(surface, 'closeClient', async () => {});
    set(surface, 'leases', { retireWorkerAcquisition: () => {}, dispose: async () => { throw failure; } });
    await expect(call<Promise<void>>(surface, 'closeWorker', { signal: signal(), timeoutMs: 1000 })).rejects.toBe(failure);
    expect(get(surface, 'retirementFailure')).toBe(failure); expect(rows).toMatchObject([{ kind: 'capture-loss', reason: 'owner-unjoined' }]);
  });
});
