import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EnginePrepareInfo, EngineInitInfo, EngineFinishInfo, EngineCleanupContext } from 'e2e/engine';
import { asBrowserProvider, LeasedBrowsers, type BrowserLease, type BrowserProvider, type BrowserReleaseContext } from '../src/provider.ts';

const signal = new AbortController().signal;
const cleanup: EngineCleanupContext = { signal, timeoutMs: 500 };
const logs: string[] = [];
/** Public lifecycle values needed by the structural lease manager. */
function preparing(slots = 1, targetName = 'web-test', override: Partial<EnginePrepareInfo> = {}): EnginePrepareInfo {
  return { runId: 'run', targetName, slots, env: {}, signal, projectRoot: '/tmp', app: {}, headed: false, log: (line) => logs.push(line), ...override };
}
function initializing(env: Readonly<Record<string, string | undefined>>, workerSlot = 0, targetName = 'web-test'): EngineInitInfo {
  return { ...preparing(1, targetName), env, workerSlot } as EngineInitInfo;
}
function finishing(targetName = 'web-test'): EngineFinishInfo { return { ...preparing(1, targetName), ...cleanup }; }
function lease(id: string): BrowserLease { return { id, cdpEndpoint: `ws://localhost/browser/${id}`, reconnectEndpoint: `ws://localhost/reconnect/${id}` }; }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** Includes deliberately secret-bearing provider metadata so tests prove the diagnostics boundary. */
function fixture(scope: 'worker' | 'attempt' = 'worker'): {
  provider: BrowserProvider; created: BrowserLease[]; released: BrowserLease[]; releaseContexts: BrowserReleaseContext[]; swept: { count: number };
} {
  const created: BrowserLease[] = [];
  const released: BrowserLease[] = [];
  const releaseContexts: BrowserReleaseContext[] = [];
  const swept = { count: 0 };
  const provider: BrowserProvider = {
    name: 'secret-provider-name', scope,
    acquire: async (request) => { request.log('secret-provider-token'); const current = { ...lease(`secret-lease-${created.length}`), extraSecret: 'secret-private-property' }; created.push(current); return current; },
    release: async (current, context) => { context.log('secret-release-token'); released.push(current); releaseContexts.push(context); },
    sweep: async (context) => { context.log('secret-sweep-token'); swept.count += 1; return ['secret-swept-id']; },
  };
  return { provider, created, released, releaseContexts, swept };
}

test('worker leases use distinct handoff keys, declared JSON fields, exact slots, and original owner objects for release', async () => {
  logs.length = 0;
  const f = fixture();
  const runner = new LeasedBrowsers(f.provider);
  const prepared = await runner.prepare(preparing(2));
  assert.equal(prepared.workers, 2);
  assert.match(Object.keys(prepared.env!)[0]!, /^E2E_AGENT_BROWSER_BROWSERS_/);
  assert.doesNotMatch(JSON.stringify(prepared.env), /extraSecret|secret-private-property/);
  const first = new LeasedBrowsers(f.provider);
  const second = new LeasedBrowsers(f.provider);
  first.init(initializing(prepared.env!, 0));
  second.init(initializing(prepared.env!, 1));
  assert.equal(await first.endpoint(signal), f.created[0]!.cdpEndpoint);
  assert.equal(await first.endpoint(signal), f.created[0]!.cdpEndpoint);
  assert.equal(await second.endpoint(signal), f.created[1]!.cdpEndpoint);
  assert.equal(f.created.length, 2, 'Repeated endpoint requests must never acquire a replacement');
  await first.startAttempt({ attemptId: 'one', signal });
  await first.endAttempt(cleanup);
  await first.dispose(cleanup);
  await second.dispose(cleanup);
  assert.equal(f.released.length, 0, 'Workers never release runner-owned leases');
  await runner.finish(finishing());
  await runner.finish(finishing());
  assert.equal(f.released.length, 2);
  assert.equal(f.released[0], f.created[0]);
  assert.equal(f.released[1], f.created[1]);
  assert.equal(f.swept.count, 1);
  assert.doesNotMatch(logs.join('\n'), /secret/);
});

test('target handoff keys distinguish punctuation collisions and never accept missing, oversized, or out-of-range handoffs', async () => {
  const f = fixture();
  const runner = new LeasedBrowsers(f.provider);
  const a = await runner.prepare(preparing(1, 'web-a'));
  const b = await runner.prepare(preparing(1, 'web.a'));
  assert.notEqual(Object.keys(a.env!)[0], Object.keys(b.env!)[0]);
  assert.throws(() => new LeasedBrowsers(f.provider).init(initializing({}, 0)), /handoff/);
  assert.throws(() => new LeasedBrowsers(f.provider).init(initializing(a.env!, 1, 'web-a')), /handoff/);
  assert.throws(() => new LeasedBrowsers(f.provider).init(initializing({ [Object.keys(a.env!)[0]!]: ' '.repeat(20_000) }, 0, 'web-a')), /handoff/);
  await runner.finish(finishing('web-a'));
  await runner.finish(finishing('web.a'));
});

test('partial preparation failure retains every successful lease for finish and never echoes provider errors', async () => {
  const f = fixture();
  const acquire = f.provider.acquire;
  f.provider.acquire = async (request) => { if (request.slot === 1) throw new Error('secret-provider-error ws://private/token'); return acquire(request); };
  const manager = new LeasedBrowsers(f.provider);
  await assert.rejects(manager.prepare(preparing(3)), (error: Error) => !JSON.stringify(error).includes('secret') && !error.message.includes('secret'));
  await manager.finish(finishing());
  assert.equal(f.released.length, 2);
  assert.equal(f.swept.count, 0);
});

test('attempt leases are fresh, cleanup is idempotent, and no implicit reconnect follows endpoint reuse', async () => {
  const f = fixture('attempt');
  const runner = new LeasedBrowsers(f.provider);
  const prepared = await runner.prepare(preparing());
  const worker = new LeasedBrowsers(f.provider);
  worker.init(initializing(prepared.env!));
  assert.equal(f.created.length, 0);
  await assert.rejects(worker.endpoint(signal), /no active lease/);
  const first = await worker.startAttempt({ attemptId: 'one', signal });
  assert.equal(await worker.endpoint(signal), first.cdpEndpoint);
  assert.equal(await worker.endpoint(signal), first.cdpEndpoint);
  await assert.rejects(worker.startAttempt({ attemptId: 'overlap', signal }), /open attempt/);
  await worker.endAttempt(cleanup);
  await worker.endAttempt(cleanup);
  const second = await worker.startAttempt({ attemptId: 'two', signal });
  assert.notEqual(second.id, first.id);
  await worker.dispose(cleanup);
  assert.deepEqual(f.released, [first, second]);
  await runner.finish(finishing());
  assert.equal(f.swept.count, 1);
});

test('aborted acquisition returns promptly and releases a late lease with a fresh cleanup signal', async () => {
  const f = fixture('attempt');
  const pending = deferred<BrowserLease>();
  f.provider.acquire = () => pending.promise;
  const manager = new LeasedBrowsers(f.provider);
  const prepared = await manager.prepare(preparing());
  manager.init(initializing(prepared.env!));
  const controller = new AbortController();
  const acquiring = manager.startAttempt({ attemptId: 'one', signal: controller.signal });
  await tick();
  controller.abort(new Error('secret-abort-reason'));
  await assert.rejects(acquiring, { code: 'CANCELLED' });
  await manager.endAttempt(cleanup);
  const late = lease('late');
  pending.resolve(late);
  await tick();
  assert.deepEqual(f.released, [late]);
  assert.equal(f.releaseContexts[0]!.signal.aborted, false);
  await manager.dispose(cleanup);
});

test('ending a still-acquiring attempt prevents its late lease from entering the next attempt', async () => {
  const f = fixture('attempt');
  const pending = deferred<BrowserLease>();
  let count = 0;
  f.provider.acquire = async () => ++count === 1 ? pending.promise : lease('next');
  const manager = new LeasedBrowsers(f.provider);
  const prepared = await manager.prepare(preparing());
  manager.init(initializing(prepared.env!));
  const acquiring = manager.startAttempt({ attemptId: 'one', signal });
  await tick();
  await manager.endAttempt(cleanup);
  await manager.startAttempt({ attemptId: 'two', signal });
  pending.resolve(lease('late'));
  await assert.rejects(acquiring);
  await tick();
  assert.equal(await manager.endpoint(signal), lease('next').cdpEndpoint);
  assert.deepEqual(f.released.map((value) => value.id), ['late']);
  await manager.dispose(cleanup);
});

test('finish during pending runner acquisition releases late leases instead of abandoning them', async () => {
  const f = fixture();
  const pending = deferred<BrowserLease>();
  f.provider.acquire = () => pending.promise;
  const manager = new LeasedBrowsers(f.provider);
  const preparingPromise = manager.prepare(preparing());
  await tick();
  await manager.finish(finishing());
  pending.resolve(lease('late-runner'));
  await assert.rejects(preparingPromise);
  await tick();
  assert.deepEqual(f.released.map((value) => value.id), ['late-runner']);
});

test('cleanup attempts every release and sweep even when a provider rejects, and does not retry uncertain releases', async () => {
  const f = fixture();
  let attempts = 0;
  f.provider.release = async () => { attempts += 1; throw new Error('secret-release-failure'); };
  const manager = new LeasedBrowsers(f.provider);
  await manager.prepare(preparing(2));
  await assert.rejects(manager.finish(finishing()), (error: Error) => !error.message.includes('secret') && error.cause === undefined);
  await manager.finish(finishing());
  assert.equal(attempts, 2);
  assert.equal(f.swept.count, 1);
});

test('cleanup is bounded even when a provider ignores its abort signal', async () => {
  const f = fixture();
  f.provider.release = () => new Promise(() => undefined);
  const manager = new LeasedBrowsers(f.provider);
  await manager.prepare(preparing());
  await assert.rejects(manager.finish({ ...finishing(), timeoutMs: 10 }), /cleanup failed/);
});

test('downloads bind the current lease, confine paths, preserve bytes, and sanitize provider errors', async () => {
  const f = fixture('attempt');
  const reads: { current: BrowserLease; file: string }[] = [];
  const provider = { ...f.provider, downloads: { dir: '/remote/downloads', read: async (current: BrowserLease, file: string) => { reads.push({ current, file }); return new Uint8Array([1, 2]); } } };
  const manager = new LeasedBrowsers(provider);
  const prepared = await manager.prepare(preparing());
  manager.init(initializing(prepared.env!));
  const current = await manager.startAttempt({ attemptId: 'one', signal });
  const downloads = manager.downloads()!;
  assert.deepEqual(await downloads.read('/remote/downloads/file', signal), new Uint8Array([1, 2]));
  assert.equal(reads[0]!.current, current);
  for (const file of ['/remote/secret', '/remote/downloads/../secret', '/remote/downloads', 'relative']) await assert.rejects(downloads.read(file, signal), /outside/);
  provider.downloads.read = async () => { throw new Error('secret-download-path-and-token'); };
  await assert.rejects(downloads.read('/remote/downloads/file', signal), (error: Error) => error.cause === undefined && !error.message.includes('secret'));
  await manager.dispose(cleanup);
});

test('recordings hide provider names and lease handles and sanitize stop failures', async () => {
  const f = fixture();
  const provider = { ...f.provider, record: async () => ({ startedAt: new Date(0).toISOString(), stop: async () => { throw new Error('secret-video-token'); } }) };
  const manager = new LeasedBrowsers(provider);
  const prepared = await manager.prepare(preparing());
  manager.init(initializing(prepared.env!));
  const recorded = await manager.recorder('one')!(signal);
  assert.equal(recorded.provider, 'browser provider');
  assert.equal(recorded.leaseId, 'current');
  await assert.rejects(recorded.recording.stop({ dir: '/tmp/video', signal }), (error: Error) => error.cause === undefined && !error.message.includes('secret'));
  await manager.dispose(cleanup);
  await manager.finish(finishing());
});

test('invalid provider configuration and malformed endpoint diagnostics never quote supplied values', async () => {
  for (const value of [null, {}, { name: 'secret', acquire: 'secret' }, { ...fixture().provider, downloads: { dir: 'secret', read: async () => new Uint8Array() } }, { ...fixture().provider, scope: 'secret' }]) {
    assert.throws(() => asBrowserProvider(value as object), (error: Error) => !error.message.includes('secret'));
  }
  const f = fixture();
  f.provider.acquire = async () => ({ id: 'secret-id', cdpEndpoint: 'file:///secret-token' });
  const manager = new LeasedBrowsers(f.provider);
  await assert.rejects(manager.prepare(preparing()), (error: Error) => !error.message.includes('secret'));
  await tick();
  assert.equal(f.released.length, 1, 'Even a malformed acquired lease must be returned to its creator');
  await manager.finish(finishing());
});

test('recording ownership receives a late handle after cancellation and preserves one in-flight provider stop', async () => {
  const f = fixture();
  const starting = deferred<{ startedAt: string; stop(): Promise<{ url: string; mediaType: string }> }>();
  const stopping = deferred<{ url: string; mediaType: string }>();
  let stops = 0;
  const manager = new LeasedBrowsers({ ...f.provider, record: () => starting.promise });
  const prepared = await manager.prepare(preparing());
  manager.init(initializing(prepared.env!));
  const controller = new AbortController();
  const recording = manager.recorder('one')!(controller.signal);
  controller.abort();
  starting.resolve({ startedAt: new Date(0).toISOString(), stop: () => { stops += 1; return stopping.promise; } });
  const late = await recording;
  const cleaned = late.recording.stop({ dir: '/tmp/video', signal });
  stopping.resolve({ url: 'https://example.test/video', mediaType: 'video/mp4' });
  assert.deepEqual(await cleaned, { url: 'https://example.test/video', mediaType: 'video/mp4' });
  assert.equal(stops, 1);
  await manager.dispose(cleanup);
  await manager.finish(finishing());
});
