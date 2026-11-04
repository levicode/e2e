import { expect, it, vi } from 'vitest';
import { EngineError } from 'e2e/engine';
import { LeasedBrowsers, type BrowserLease, type BrowserProvider } from '../../src/provider.ts';

const signal = new AbortController().signal;
const prepare = { runId: 'worker-acquire', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, slots: 1, signal, log: () => {} };
const init = (env: Readonly<Record<string, string | undefined>>) => ({ ...prepare, env, workerSlot: 0 });
const cancelled = () => ({ signal: AbortSignal.abort(), timeoutMs: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const lease = (id: string): BrowserLease => ({ id, cdpEndpoint: `ws://synthetic.test/${id}` });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function worker(acquire: BrowserProvider['acquire'], release: BrowserProvider['release']) {
  const leases = new LeasedBrowsers({ name: 'worker-acquire', scope: 'worker', acquire, release });
  const prepared = await leases.prepare(prepare); const info = init(prepared.env ?? {});
  leases.init(info); await leases.endpoint(signal); return { leases, info };
}

it('retains failed late worker release and the original cleanup signal', async () => {
  const pending = deferred<BrowserLease>(); const primary = new Error('late worker release remains unconfirmed');
  const release = vi.fn(async (_lease: BrowserLease, _context: { signal: AbortSignal }) => { throw primary; });
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => pending.promise);
  const { leases, info } = await worker(acquire, release);
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause);
  const budget = cancelled(); const closing = leases.dispose(budget).catch((cause: unknown) => cause);
  const late = lease('late'); pending.resolve(late); await opening;
  const failure = await closing; const repeat = await leases.dispose(cancelled()).catch((cause: unknown) => cause);
  expect(release).toHaveBeenCalledTimes(1); expect(release.mock.calls[0]?.[0]).toBe(late);
  expect(release.mock.calls[0]?.[1].signal).toBe(budget.signal);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary }); expect(repeat).toBe(failure);
  expect(() => leases.init(info)).toThrowError('Provider cleanup remains unresolved');
});

it('retains pending worker acquisition and its actual rollback receipt before a fresh init', async () => {
  const pending = deferred<BrowserLease>(); const released = deferred<void>();
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => pending.promise);
  const release = vi.fn(() => released.promise); const { leases, info } = await worker(acquire, release);
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause);
  const budget = cancelled(); let settled = false; const closing = leases.dispose(budget).then(() => { settled = true; });
  await tick(); expect(settled).toBe(false); expect(() => leases.init(info)).toThrow();
  await expect(leases.endpoint(signal)).rejects.toMatchObject({ code: 'INVALID_STATE' }); expect(acquire).toHaveBeenCalledTimes(2);
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false); expect(() => leases.init(info)).toThrow();
  released.resolve(); await opening; await closing; leases.init(info);
  expect(await leases.endpoint(signal)).toBe('ws://synthetic.test/prepared'); expect(release).toHaveBeenCalledTimes(1);
});

it('ends only attempt-owned pending replacement without releasing a live cross-attempt worker lease', async () => {
  const pending = deferred<BrowserLease>(); const released = deferred<void>();
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementationOnce(() => pending.promise).mockResolvedValue(lease('fresh'));
  const release = vi.fn().mockImplementationOnce(() => released.promise).mockResolvedValue(undefined);
  const { leases } = await worker(acquire, release);
  const opening = leases.endpoint(signal, 'attempt').catch((cause: unknown) => cause);
  const budget = cancelled(); let settled = false; const ending = leases.endAttempt(budget).then(() => { settled = true; });
  await tick(); expect(settled).toBe(false);
  await expect(leases.endpoint(signal, 'attempt')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(release.mock.calls[0]?.[1].signal).toBe(budget.signal); expect(settled).toBe(false);
  released.resolve(); await opening; await ending;
  expect(await leases.endpoint(signal, 'attempt')).toBe('ws://synthetic.test/fresh');
  await leases.endAttempt(cancelled()); expect(release).toHaveBeenCalledTimes(1);
  await leases.dispose(cancelled()); expect(release.mock.calls.map(([value]) => value.id)).toEqual(['late', 'fresh']);
});

it('does not revoke an init-owned acquisition from an unrelated endAttempt', async () => {
  const pending = deferred<BrowserLease>(); const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => pending.promise);
  const release = vi.fn(async () => {}); const { leases } = await worker(acquire, release);
  const opening = leases.endpoint(signal); await leases.endAttempt(cancelled());
  pending.resolve(lease('init-owned')); expect(await opening).toBe('ws://synthetic.test/init-owned');
  expect(release).not.toHaveBeenCalled(); await leases.dispose(cancelled()); expect(release).toHaveBeenCalledTimes(1);
});

it.each(['current-first', 'late-first'] as const)('independently releases current while acquiring, retaining the first actual failure (%s)', async order => {
  const pending = deferred<BrowserLease>(); const currentRelease = deferred<void>(); const lateRelease = deferred<void>();
  const first = new Error('first actual cleanup rejection'); const second = new Error('second actual cleanup rejection');
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockResolvedValueOnce(lease('current')).mockImplementation(() => pending.promise);
  const release = vi.fn((value: BrowserLease) => value.id === 'current' ? currentRelease.promise : lateRelease.promise);
  const { leases, info } = await worker(acquire, release); await leases.endpoint(signal);
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause); const budget = cancelled();
  const closing = leases.dispose(budget).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(release.mock.calls[0]?.[0].id).toBe('current'));
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  const early = order === 'current-first' ? currentRelease : lateRelease; const later = order === 'current-first' ? lateRelease : currentRelease;
  early.reject(first); await tick(); later.reject(second); await opening;
  const failure = await closing; expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: first });
  expect(await leases.dispose(cancelled()).catch((cause: unknown) => cause)).toBe(failure);
  expect(() => leases.init(info)).toThrow(); expect(release).toHaveBeenCalledTimes(2);
});

it('publishes the pending worker owner before acquire synchronously reenters dispose', async () => {
  const pending = deferred<BrowserLease>(); const released = deferred<void>(); let leases!: LeasedBrowsers; let disposal: Promise<void> | undefined;
  const budget = cancelled(); const release = vi.fn((_lease: BrowserLease, _context: { signal: AbortSignal }) => released.promise);
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => { disposal = leases.dispose(budget); return pending.promise; });
  const prepared = await worker(acquire, release); leases = prepared.leases;
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause); expect(disposal).toBeDefined();
  let settled = false; void disposal!.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(release.mock.calls[0]?.[1].signal).toBe(budget.signal); expect(settled).toBe(false);
  released.resolve(); await opening; await disposal; leases.init(prepared.info);
});

it('does not relabel a rejected acquire as cleanup failure or keep a resource-free journal', async () => {
  const pending = deferred<BrowserLease>(); const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => pending.promise);
  const release = vi.fn(async () => {}); const { leases, info } = await worker(acquire, release);
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause); const closing = leases.dispose(cancelled());
  pending.reject(new Error('acquire refused')); const body = await opening;
  expect(body).toBeInstanceOf(EngineError); await closing; leases.init(info); expect(release).not.toHaveBeenCalled();
});

it('publishes a single worker release receipt before provider.release reenters dispose', async () => {
  const released = deferred<void>(); let leases!: LeasedBrowsers; let reentered: Promise<void> | undefined;
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockResolvedValue(lease('current'));
  const release = vi.fn(() => { if (release.mock.calls.length === 1) reentered = leases.dispose(cancelled()); return released.promise; });
  ({ leases } = await worker(acquire, release)); await leases.endpoint(signal);
  const disposing = leases.dispose(cancelled());
  expect(reentered).toBe(disposing); expect(release).toHaveBeenCalledTimes(1);
  released.resolve(); await disposing; await reentered; expect(release).toHaveBeenCalledTimes(1);
});

it('retains failed cleanup of the replaced worker lease while independently releasing its successor', async () => {
  const oldRelease = deferred<void>(); const primary = new Error('previous worker release is unconfirmed');
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockResolvedValueOnce(lease('current')).mockResolvedValue(lease('successor'));
  const release = vi.fn((value: BrowserLease) => value.id === 'current' ? oldRelease.promise : Promise.resolve());
  const { leases, info } = await worker(acquire, release); await leases.endpoint(signal);
  const opening = leases.endpoint(signal, 'attempt').catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  const ending = leases.endAttempt(cancelled()).catch((cause: unknown) => cause);
  oldRelease.reject(primary); const failure = await ending; expect(await opening).toBe(failure);
  expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
  expect(await leases.dispose(cancelled()).catch((cause: unknown) => cause)).toBe(failure);
  expect(release.mock.calls.map(([value]) => value.id)).toEqual(['current', 'successor']);
  expect(() => leases.init(info)).toThrow();
});

it('keeps the first cleanup signal and one rollback receipt across endAttempt and dispose', async () => {
  const pending = deferred<BrowserLease>(); const released = deferred<void>(); const primary = new Error('single rollback failed');
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockImplementation(() => pending.promise);
  const release = vi.fn((_lease: BrowserLease, _context: { signal: AbortSignal }) => released.promise); const { leases } = await worker(acquire, release);
  const opening = leases.endpoint(signal, 'attempt').catch((cause: unknown) => cause);
  const budget = cancelled(); const ending = leases.endAttempt(budget).catch((cause: unknown) => cause);
  const disposing = leases.dispose(cancelled()).catch((cause: unknown) => cause);
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  expect(release.mock.calls[0]?.[1].signal).toBe(budget.signal);
  released.reject(primary); const failure = await ending;
  expect(await opening).toBe(failure); expect(await disposing).toBe(failure); expect(release).toHaveBeenCalledTimes(1);
});
it.each(['same-turn', 'after-first-reaction', 'late-first-same-turn', 'late-first-after-first-reaction'] as const)('preserves actual worker release rejection order (%s)', async order => {
  const pending = deferred<BrowserLease>(); const currentRelease = deferred<void>(); const lateRelease = deferred<void>();
  const first = new Error('first held-worker rejection'); const second = new Error('later rollback rejection');
  const acquire = vi.fn().mockResolvedValueOnce(lease('prepared')).mockResolvedValueOnce(lease('current')).mockImplementation(() => pending.promise);
  const release = vi.fn((value: BrowserLease) => value.id === 'current' ? currentRelease.promise : lateRelease.promise);
  const { leases } = await worker(acquire, release); await leases.endpoint(signal);
  const opening = leases.endpoint(signal).catch((cause: unknown) => cause);
  const closing = leases.dispose(cancelled()).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(release.mock.calls[0]?.[0].id).toBe('current'));
  pending.resolve(lease('late')); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  const earlier = order.startsWith('late-first') ? lateRelease : currentRelease;
  const later = order.startsWith('late-first') ? currentRelease : lateRelease;
  earlier.reject(first);
  if (order.endsWith('after-first-reaction')) await Promise.resolve();
  later.reject(second); await opening;
  const failure = await closing;
  expect((failure as EngineError).cause).toBe(first);
  expect(release).toHaveBeenCalledTimes(2);
  expect(await leases.dispose(cancelled()).catch((cause: unknown) => cause)).toBe(failure);
});
