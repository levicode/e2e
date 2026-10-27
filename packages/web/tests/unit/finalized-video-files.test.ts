import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import { FinalizedVideoFiles, type FinalizedVideoBytes } from '../../src/native/finalized-video-files.ts';

const interception = vi.hoisted(() => ({ write: undefined as undefined | (() => Promise<void>), publish: undefined as undefined | (() => Promise<void>), partialFailure: false, closeFailures: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, link: async (...args: Parameters<typeof real.link>) => {
    if (interception.publish !== undefined) await interception.publish();
    return real.link(...args);
  }, open: async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'close') return async () => {
        if (interception.closeFailures > 0) { interception.closeFailures--; throw new Error('synthetic close failure'); }
        return target.close();
      };
      if (property === 'writeFile') return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        if (interception.write !== undefined) await interception.write();
        if (interception.partialFailure) {
          interception.partialFailure = false;
          await target.writeFile(Buffer.from('partial-owned-file'));
          throw new Error('synthetic disk write failure');
        }
        return target.writeFile(...writeArgs);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function operation(signal: AbortSignal = new AbortController().signal, timeoutMs = 2000): OperationContext {
  return { signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' };
}
const first = { bytes: Buffer.from('verified-video-one'), startedAt: '2026-10-26T19:00:00.000Z' };
const second = { bytes: Buffer.from('verified-video-two'), startedAt: '2026-10-26T19:00:01.000Z' };
const directories: string[] = [];
const owners: FinalizedVideoFiles[] = [];
const expectedCleanupFailures = new Set<FinalizedVideoFiles>();
async function fixture(initialPart = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), 'finalized-video-files-'));
  directories.push(directory);
  let part = initialPart;
  let owns = true;
  const retirement = new AbortController();
  const files = new FinalizedVideoFiles({ artifactsDir: directory, allocatePart: () => ++part,
    owns: () => owns, retirement: retirement.signal });
  owners.push(files);
  return { files, directory, retirement, allocated: () => part, revoke: () => { owns = false; } };
}
async function staging(directory: string): Promise<string> {
  const name = (await readdir(path.join(directory, 'video'))).find(candidate => candidate.startsWith('.native-finalized-'));
  if (name === undefined) throw new Error('missing owned staging directory');
  return path.join(directory, 'video', name);
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('filesystem condition not reached');
}
afterEach(async () => {
  interception.write = undefined; interception.publish = undefined; interception.partialFailure = false; interception.closeFailures = 0;
  for (const owner of owners.splice(0)) {
    if (expectedCleanupFailures.delete(owner)) await expect(owner.retire()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    else await owner.retire();
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('same-attempt finalized video file delivery', () => {
  it('automatically persists verified bytes and returns paths/start times exactly once', async () => {
    const f = await fixture();
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    await until(async () => (await readdir(path.join(f.directory, 'video')).catch(() => [])).filter(name => name.endsWith('.webm')).length === 2);
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
    expect(await readFile(path.join(f.directory, 'video/video-part2.webm'))).toEqual(second.bytes);
    expect(f.allocated()).toBe(2);
    expect(await f.files.claim(operation())).toEqual([
      { path: 'video/video.webm', startedAt: first.startedAt },
      { path: 'video/video-part2.webm', startedAt: second.startedAt },
    ]);
    expect(await f.files.claim(operation())).toEqual([]);
    expect(f.allocated()).toBe(2);
  });

  it('keeps a failed transfer a failure on every claim and never creates files', async () => {
    const f = await fixture();
    const error = new EngineError('ENGINE_FAILURE', 'Terminal transfer failed', { retryable: false });
    f.files.prepare(Promise.reject(error), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toBe(error);
    await expect(f.files.claim(operation())).rejects.toBe(error);
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.allocated()).toBe(0);
  });

  it('never overwrites a collision and retries only the missing part after partial success', async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, 'video'));
    const collision = path.join(f.directory, 'video/video-part2.webm');
    await writeFile(collision, 'foreign-existing-video');
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const original = await stat(path.join(f.directory, 'video/video.webm'), { bigint: true });
    expect(await readFile(collision, 'utf8')).toBe('foreign-existing-video');
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
    expect(f.allocated()).toBe(2);
    await rm(collision);
    expect(await f.files.claim(operation())).toEqual([
      { path: 'video/video.webm', startedAt: first.startedAt },
      { path: 'video/video-part2.webm', startedAt: second.startedAt },
    ]);
    expect((await stat(path.join(f.directory, 'video/video.webm'), { bigint: true })).ino).toBe(original.ino);
    expect(await readFile(collision)).toEqual(second.bytes);
    expect(f.allocated()).toBe(2);
    expect(await f.files.claim(operation())).toEqual([]);
  });

  it('retains bytes after a real partial write and retries its own incomplete inode', async () => {
    const f = await fixture();
    interception.partialFailure = true;
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(path.join(await staging(f.directory), 'video.webm'), 'utf8')).toBe('partial-owned-file');
    await expect(stat(path.join(f.directory, 'video/video.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
    expect(f.allocated()).toBe(1);
  });

  it('does not adopt a foreign replacement of an incomplete file', async () => {
    const f = await fixture();
    interception.partialFailure = true;
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const target = path.join(await staging(f.directory), 'video.webm');
    expectedCleanupFailures.add(f.files);
    // Keep the owned inode alive at another name, preventing inode reuse.
    const { rename } = await import('node:fs/promises');
    await rename(target, path.join(f.directory, 'incomplete-original'));
    await writeFile(target, 'foreign');
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(target, 'utf8')).toBe('foreign');
    expect(f.allocated()).toBe(1);
  });

  it('serializes concurrent claims so only one returns the saved segments', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 2000);
    const claims = [f.files.claim(operation()), f.files.claim(operation()), f.files.claim(operation())];
    transfer.resolve([first]);
    expect(await Promise.all(claims)).toEqual([[{ path: 'video/video.webm', startedAt: first.startedAt }], [], []]);
    expect(f.allocated()).toBe(1);
    expect(await readdir(path.join(f.directory, 'video'))).toEqual(['video.webm']);
  });

  it('caller abort while waiting does not consume delivery or cancel automatic persistence', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 2000);
    const cancel = new AbortController(); const claim = f.files.claim(operation(cancel.signal));
    cancel.abort(); await expect(claim).rejects.toMatchObject({ code: 'CANCELLED' });
    transfer.resolve([first]);
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(f.allocated()).toBe(1);
  });

  it('caller deadline while queued does not consume the one successful return', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 2000);
    await expect(f.files.claim(operation(undefined, 10))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    transfer.resolve([first]);
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(await f.files.claim(operation())).toEqual([]);
  });

  it('automatic deadline is fixed and a late transfer cannot be written or retried', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 10);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    transfer.resolve([first]);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.allocated()).toBe(0);
  });

  it('retirement rejects waiting claims and a late transfer makes no files', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 2000);
    const claim = f.files.claim(operation());
    f.retirement.abort(); await expect(claim).rejects.toMatchObject({ code: 'INVALID_STATE' });
    transfer.resolve([first]);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.allocated()).toBe(0);
  });

  it('retains in-flight filesystem ownership but cannot publish or start another write after retirement', async () => {
    const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
    interception.write = async () => { entered.resolve(); await release.promise; };
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    await entered.promise;
    const claim = f.files.claim(operation());
    f.retirement.abort(); await expect(claim).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const cleanup = f.files.retire();
    release.resolve(); interception.write = undefined;
    await cleanup;
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await readdir(path.join(f.directory, 'video'))).toEqual([]);
  });

  it('copies verified bytes and refuses a foreign attempt without consuming delivery', async () => {
    const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
    interception.write = async () => { entered.resolve(); await release.promise; };
    const bytes = Buffer.from('immutable verified bytes');
    f.files.prepare(Promise.resolve([{ bytes, startedAt: first.startedAt }]), performance.now() + 2000);
    await entered.promise; bytes.fill(0); release.resolve(); interception.write = undefined;
    expect(await f.files.claim(operation())).toHaveLength(1);
    f.revoke();
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await readFile(path.join(f.directory, 'video/video.webm'), 'utf8')).toBe('immutable verified bytes');
  });

  it('does not consume the initial local failure when an earlier claimant was already aborted', async () => {
    const f = await fixture();
    await mkdir(path.join(f.directory, 'video'));
    const target = path.join(f.directory, 'video/video.webm');
    await writeFile(target, 'foreign');
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    const cancel = new AbortController(); cancel.abort();
    await expect(f.files.claim(operation(cancel.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(target, 'utf8')).toBe('foreign');
    await rm(target);
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
  });

  it('caller abort during a retained local retry cannot consume or duplicate its completed file', async () => {
    const f = await fixture();
    const target = path.join(f.directory, 'video/video.webm');
    interception.partialFailure = true;
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const entered = deferred<void>(); const release = deferred<void>();
    interception.write = async () => { entered.resolve(); await release.promise; };
    const cancel = new AbortController();
    const retry = f.files.claim(operation(cancel.signal));
    await entered.promise;
    cancel.abort(); await expect(retry).rejects.toMatchObject({ code: 'CANCELLED' });
    const next = f.files.claim(operation());
    release.resolve(); interception.write = undefined;
    expect(await next).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(await readFile(target)).toEqual(first.bytes);
    expect(f.allocated()).toBe(1);
    expect(await f.files.claim(operation())).toEqual([]);
  });

  it('expired automatic persistence starts no second file and a later local retry preserves the first', async () => {
    const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
    interception.write = async () => { entered.resolve(); await release.promise; };
    const endsAt = performance.now() + 30;
    f.files.prepare(Promise.resolve([first, second]), endsAt);
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, endsAt - performance.now() + 5)));
    release.resolve(); interception.write = undefined;
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(stat(path.join(f.directory, 'video/video.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
    const original = await stat(path.join(await staging(f.directory), 'video.webm'), { bigint: true });
    expect(await f.files.claim(operation())).toHaveLength(2);
    expect((await stat(path.join(f.directory, 'video/video.webm'), { bigint: true })).ino).toBe(original.ino);
    expect(await readFile(path.join(f.directory, 'video/video-part2.webm'))).toEqual(second.bytes);
    expect(f.allocated()).toBe(2);
  });

  it('explicit retire wakes a waiting claim even without aborting the caller or supplied signal', async () => {
    const f = await fixture(); const transfer = deferred<readonly FinalizedVideoBytes[]>();
    f.files.prepare(transfer.promise, performance.now() + 2000);
    const claim = f.files.claim(operation()); const cleanup = f.files.retire();
    await expect(claim).rejects.toMatchObject({ code: 'INVALID_STATE' });
    transfer.resolve([first]); await cleanup;
    expect(await readdir(f.directory)).toEqual([]);
  });


  it('retirement without retry removes only private partial output and keeps completed videos', async () => {
    const f = await fixture(); let writes = 0;
    interception.write = async () => { if (++writes === 2) interception.partialFailure = true; };
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
    await expect(stat(path.join(f.directory, 'video/video-part2.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
    await f.files.retire();
    expect(await readdir(path.join(f.directory, 'video'))).toEqual(['video.webm']);
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
  });

  it('retirement refuses a foreign staging-directory symlink without traversing or deleting it', async () => {
    const f = await fixture(); interception.partialFailure = true;
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const owned = await staging(f.directory);
    const foreign = path.join(f.directory, 'foreign'); await mkdir(foreign); await writeFile(path.join(foreign, 'video.webm'), 'foreign');
    const { rename, symlink } = await import('node:fs/promises');
    await rename(owned, `${owned}-original`); await symlink(foreign, owned, 'dir');
    expectedCleanupFailures.add(f.files);
    await expect(f.files.retire()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(path.join(foreign, 'video.webm'), 'utf8')).toBe('foreign');
    expect((await (await import('node:fs/promises')).lstat(owned)).isSymbolicLink()).toBe(true);
  });


  it('checks completed-file identity before a claim and never adopts its foreign replacement', async () => {
    const f = await fixture();
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    const target = path.join(f.directory, 'video/video.webm');
    await until(async () => (await stat(target).catch(() => undefined))?.size === first.bytes.length);
    const { rename } = await import('node:fs/promises');
    const original = path.join(f.directory, 'original'); await rename(target, original);
    await writeFile(target, Buffer.alloc(first.bytes.length, 7));
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(await readFile(target)).toEqual(Buffer.alloc(first.bytes.length, 7));
    await rm(target); await rename(original, target);
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(f.allocated()).toBe(1);
  });


  it('does not publish before a failed close is actually retried and never rewrites completed bytes', async () => {
    const f = await fixture(); let writes = 0;
    interception.write = async () => { writes++; };
    interception.closeFailures = 1;
    f.files.prepare(Promise.resolve([first]), performance.now() + 2000);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(stat(path.join(f.directory, 'video/video.webm'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(await staging(f.directory), 'video.webm'))).toEqual(first.bytes);
    expect(await f.files.claim(operation())).toEqual([{ path: 'video/video.webm', startedAt: first.startedAt }]);
    expect(writes).toBe(1);
    expect(await readdir(path.join(f.directory, 'video'))).toEqual(['video.webm']);
  });

  it('reserves continuation names once from the captured attempt counter', async () => {
    const f = await fixture(3);
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    expect(await f.files.claim(operation())).toEqual([
      { path: 'video/video-part4.webm', startedAt: first.startedAt },
      { path: 'video/video-part5.webm', startedAt: second.startedAt },
    ]);
    expect(f.allocated()).toBe(5);
    expect(await f.files.claim(operation())).toEqual([]);
  });


  it('retirement during an already-issued link allows its completion but no claim or next publication', async () => {
    const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
    interception.publish = async () => { entered.resolve(); await release.promise; };
    f.files.prepare(Promise.resolve([first, second]), performance.now() + 2000);
    await entered.promise;
    const claim = f.files.claim(operation());
    const cleanup = f.files.retire();
    await expect(claim).rejects.toMatchObject({ code: 'INVALID_STATE' });
    release.resolve(); interception.publish = undefined;
    await cleanup;
    expect(await readdir(path.join(f.directory, 'video'))).toEqual(['video.webm']);
    expect(await readFile(path.join(f.directory, 'video/video.webm'))).toEqual(first.bytes);
    await expect(f.files.claim(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

});
