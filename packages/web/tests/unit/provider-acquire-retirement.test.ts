import { expect, it, vi } from 'vitest';
import { EngineError, type EngineAttemptContext } from 'e2e/engine';
import { NativeSurface } from '../../src/native-surface.ts';
import { LeasedBrowsers, type BrowserLease, type BrowserProvider } from '../../src/provider.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
const signal = new AbortController().signal;
const prepare = { runId: 'review', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, slots: 1, signal, log: () => {} };
const init = (env: Readonly<Record<string, string | undefined>>) => ({ ...prepare, env, workerSlot: 0 });
const attempt = (id = 'old', attemptSignal = signal): EngineAttemptContext => ({ attemptId: id, signal: attemptSignal, artifactsDir: '/tmp', resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const cancelled = () => ({ signal: AbortSignal.abort(), timeoutMs: 0 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const lease = (id: string): BrowserLease => ({ id, cdpEndpoint: `ws://synthetic.test/${id}` });

it('surface disposal cannot permit init until pending acquire and its late release settle', async () => {
  const acquired = deferred<BrowserLease>(); const released = deferred<void>();
  const release = vi.fn(() => released.promise);
  const surface = new NativeSurface({ browser: { name: 'acquire-review', scope: 'attempt', acquire: () => acquired.promise, release } });
  const prepared = await surface.prepare(prepare); const info = init(prepared?.env ?? {});
  await surface.init(info);
  const starting = surface.startAttempt(attempt()).catch((cause: unknown) => cause);
  await tick();
  const cleanup = cancelled();
  await surface.endAttempt(cleanup);
  const caller = surface.dispose(cleanup).catch((cause: unknown) => cause);
  const owner = (surface as unknown as { disposing?: Promise<void> }).disposing;
  expect(owner).toBeDefined();
  let ownerSettled = false; void owner?.then(() => { ownerSettled = true; }, () => { ownerSettled = true; });
  await caller; await tick();
  const settledBeforeAcquire = ownerSettled;
  const prematureInit = await surface.init(info).then(() => 'accepted', () => 'rejected');
  acquired.resolve(lease('late'));
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  const settledBeforeRelease = ownerSettled;
  released.resolve(); await starting; await owner;
  await surface.init(info); await surface.dispose({ signal, timeoutMs: 1000 });
  expect({ settledBeforeAcquire, settledBeforeRelease, prematureInit }).toEqual({ settledBeforeAcquire: false, settledBeforeRelease: false, prematureInit: 'rejected' });
});

it('next attempt cannot reacquire before retired acquire settles', async () => {
  const first = deferred<BrowserLease>(); const second = deferred<BrowserLease>();
  const release = vi.fn(async () => {}); const acquire = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const leases = new LeasedBrowsers({ name: 'acquire-review', scope: 'attempt', acquire, release });
  const prepared = await leases.prepare(prepare); leases.init(init(prepared.env ?? {}));
  const old = leases.startAttempt(attempt()).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
  const cleanup = leases.endAttempt(cancelled()).catch((cause: unknown) => cause);
  const fresh = leases.startAttempt(attempt('fresh')).catch((cause: unknown) => cause);
  const beforeLate = acquire.mock.calls.length;
  first.resolve(lease('late')); await old; await cleanup;
  second.resolve(lease('fresh')); const freshResult = await fresh;
  await leases.endAttempt({ signal, timeoutMs: 1000 });
  expect(beforeLate).toBe(1);
  expect(freshResult).toMatchObject({ code: 'INVALID_STATE' });
  expect(release).toHaveBeenCalledTimes(1);
});

it('retains failed late attempt release and original cleanup signal', async () => {
  const pending = deferred<BrowserLease>(); const releaseFailure = new Error('late release remains unconfirmed');
  const release = vi.fn(async (_lease: BrowserLease, _context: { signal: AbortSignal }) => { throw releaseFailure; });
  const provider: BrowserProvider = { name: 'acquire-review', scope: 'attempt', acquire: () => pending.promise, release };
  const leases = new LeasedBrowsers(provider); const prepared = await leases.prepare(prepare); const info = init(prepared.env ?? {}); leases.init(info);
  const opening = leases.startAttempt(attempt()).catch((cause: unknown) => cause);
  const budget = cancelled();
  const closing = leases.endAttempt(budget).catch((cause: unknown) => cause);
  const late = lease('late'); pending.resolve(late); await opening;
  const failure = await closing;
  const repeat = await leases.endAttempt(budget).catch((cause: unknown) => cause);
  let initRejected = false; try { leases.init(info); } catch { initRejected = true; }
  expect(release).toHaveBeenCalledTimes(1);
  expect(release.mock.calls[0]?.[0]).toBe(late);
  expect(repeat).toBe(failure);
  expect({ failure: (failure as EngineError | undefined)?.cause, initRejected, originalSignal: release.mock.calls[0]?.[1].signal === budget.signal }).toEqual({ failure: releaseFailure, initRejected: true, originalSignal: true });
});

it('publishes a single attempt release receipt before provider.release reenters endAttempt', async () => {
  const released = deferred<void>(); let leases!: LeasedBrowsers; let reentered: Promise<void> | undefined;
  const release = vi.fn(() => {
    if (release.mock.calls.length === 1) reentered = leases.endAttempt(cancelled());
    return released.promise;
  });
  leases = new LeasedBrowsers({ name: 'reentrant-attempt-release', scope: 'attempt', acquire: async () => lease('owned'), release });
  const prepared = await leases.prepare(prepare); leases.init(init(prepared.env ?? {}));
  await leases.startAttempt(attempt()); await tick();
  const ending = leases.endAttempt(cancelled());
  try { expect(release).toHaveBeenCalledTimes(1); expect(reentered).toBe(ending); }
  finally { released.resolve(); await ending; await reentered; }
  await leases.endAttempt(cancelled()); expect(release).toHaveBeenCalledTimes(1);
});
