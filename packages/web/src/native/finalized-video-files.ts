/** Same-attempt local delivery of already verified, immutable terminal artifacts. */
import { open, mkdir, mkdtemp, lstat, link, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { PartialVideoTransferError, type FinalizedVideoSnapshot } from './finalized-recording.ts';
import { EngineError, type OperationContext, type VideoSegment } from 'e2e/engine';

export interface FinalizedVideoDeliveryBytes { readonly bytes: Uint8Array; readonly startedAt: string }
interface Owner {
  readonly artifactsDir: string;
  readonly allocatePart: () => number;
  readonly owns: () => boolean;
  readonly retirement: AbortSignal;
}
interface Entry {
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
  readonly size: number;
  staging: string | undefined;
  bytes: Buffer | undefined;
  identity: { dev: bigint; ino: bigint } | undefined;
  handle: FileHandle | undefined;
  writeComplete: boolean;
  written: boolean;
}
interface Budget { readonly signal: AbortSignal; readonly endsAt: number }

/** No native commands, transfer retries, or ordinary scope admission live here. */
export class FinalizedVideoFiles {
  private entries: Entry[] = [];
  private prepared = false;
  private delivered = false;
  private retired = false;
  private readonly localRetirement = new AbortController();
  private transferFailed = false;
  private transferFailure: unknown;
  private partialTransferFailure: { value: unknown } | undefined;
  private firstWriteFailed = false;
  private firstWriteFailure: unknown;
  private stagingDirectory: { path: string; dev: bigint | undefined; ino: bigint | undefined } | undefined;
  private retirementWork: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly onRetirement = () => { void this.retire().catch(() => {}); };

  constructor(private readonly owner: Owner) {
    owner.retirement.addEventListener('abort', this.onRetirement, { once: true });
    if (owner.retirement.aborted) this.onRetirement();
  }

  /** Start once, using the original automatic-cleanup deadline, not a new lease. */
  prepare(download: Promise<readonly FinalizedVideoDeliveryBytes[]>, endsAt: number, snapshot: () => FinalizedVideoSnapshot = () => ({ segments: [] })): void {
    if (this.prepared) throw invalid('Finalized video collection was already prepared');
    this.prepared = true;
    const budget = { signal: this.owner.retirement, endsAt };
    const work = async () => {
      let segments: readonly FinalizedVideoDeliveryBytes[];
      try { segments = await this.wait(download, budget); }
      catch (error) {
        const retained = snapshot();
        segments = error instanceof PartialVideoTransferError && performance.now() < endsAt ? error.segments : retained.segments;
        const failure = retained.failure ?? { value: error instanceof PartialVideoTransferError ? error.failure : error };
        if (segments.length === 0) { this.transferFailed = true; this.transferFailure = failure.value; return; }
        this.partialTransferFailure = failure;
      }
      try {
        // Transfer was accepted within its original deadline. Preserve these
        // bytes even if only the subsequent local persistence budget expires.
        this.checkOwner();
        // Allocate each public part exactly once. Copies prevent a caller from
        // mutating verified data after transfer ownership has been handed over.
        this.entries = segments.map(segment => {
          const part = this.owner.allocatePart();
          if (!Number.isSafeInteger(part) || part < 1) throw invalid('Invalid finalized video part');
          const relative = `video/${part === 1 ? 'video' : `video-part${part}`}.webm`;
          return { relative, absolute: path.join(this.owner.artifactsDir, relative), startedAt: segment.startedAt,
            size: segment.bytes.byteLength, staging: undefined, bytes: Buffer.from(segment.bytes), identity: undefined, handle: undefined, writeComplete: false, written: false };
        });
      } catch (error) { this.transferFailed = true; this.transferFailure = error; return; }
      // The original transfer clock never renews. A later claim may persist
      // bytes already verified before that clock expired, without another read.
      if (this.partialTransferFailure !== undefined && performance.now() >= endsAt) return;
      try { await this.persist(budget); }
      catch (error) { this.firstWriteFailed = true; this.firstWriteFailure = error; }
    };
    this.tail = work();
    // Automatic persistence has no caller yet. Keep its failure for claim rather
    // than creating an unhandled rejection or disguising failed collection as [].
    void this.tail.catch(() => {});
  }

  /** Only a successful, current-owner return consumes delivery. */
  claim(operation: OperationContext): Promise<readonly VideoSegment[]> {
    const budget = { signal: operation.signal, endsAt: performance.now() + operation.timeoutMs };
    let settled = false;
    let resolve!: (segments: readonly VideoSegment[]) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<readonly VideoSegment[]>((yes, no) => { resolve = yes; reject = no; });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: { value: unknown }, segments: readonly VideoSegment[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal.removeEventListener('abort', interrupted);
      this.localRetirement.signal.removeEventListener('abort', interrupted);
      if (error !== undefined) reject(error.value); else resolve(segments);
    };
    const interrupted = () => { try { this.check(budget); } catch (error) { finish({ value: error }); } };
    const expire = () => {
      interrupted();
      if (!settled) timer = setTimeout(expire, Math.max(1, Math.ceil(budget.endsAt - performance.now())));
    };
    timer = setTimeout(expire, Math.max(1, Math.ceil(operation.timeoutMs)));
    budget.signal.addEventListener('abort', interrupted, { once: true });
    this.localRetirement.signal.addEventListener('abort', interrupted, { once: true });
    interrupted();
    const work = this.tail.then(async () => {
      this.check(budget);
      if (settled) return;
      if (!this.prepared) throw invalid('Finalized video collection was not prepared');
      if (this.transferFailed) throw this.transferFailure;
      if (this.partialTransferFailure !== undefined) {
        const { value } = this.partialTransferFailure; this.partialTransferFailure = undefined;
        throw value;
      }
      if (this.firstWriteFailed) {
        this.firstWriteFailed = false;
        throw this.firstWriteFailure;
      }
      if (this.delivered) { finish(); return; }
      // A later same-attempt caller retries only pending local writes.
      await this.persist(budget);
      await this.verifyPublished(budget);
      this.check(budget);
      if (settled) return;
      const segments = this.entries.map(entry => ({ path: entry.relative, startedAt: entry.startedAt }));
      // Consumption and resolution share one synchronous commit. A caller that
      // already stopped waiting cannot lose the batch in a later microtask.
      this.delivered = true;
      finish(undefined, segments);
    });
    // Aborting a caller never releases this serialized filesystem owner early.
    this.tail = work.catch(error => finish({ value: error }));
    return result;
  }

  hasDelivered(): boolean { return this.delivered; }

  /** Revoke synchronously; retain and expose the one actual filesystem cleanup. */
  retire(): Promise<void> {
    this.retired = true;
    this.localRetirement.abort();
    this.owner.retirement.removeEventListener('abort', this.onRetirement);
    this.retirementWork ??= this.tail.then(async () => {
      try {
        for (const entry of this.entries) {
          if (entry.handle !== undefined) { await entry.handle.close(); entry.handle = undefined; }
          await this.removeStaging(entry);
        }
        await this.removeDirectory();
        this.entries = [];
      } catch { throw fileFailure(); }
      finally {
        // A failed close/removal keeps its owned handle/path for diagnostics and
        // the rejected cleanup receipt, but never keeps downloaded byte caches.
        for (const entry of this.entries) entry.bytes = undefined;
        this.transferFailure = undefined;
        this.partialTransferFailure = undefined;
        this.firstWriteFailure = undefined;
      }
    });
    return this.retirementWork;
  }

  private checkOwner(): void {
    if (this.retired || this.owner.retirement.aborted || !this.owner.owns()) throw invalid('Finalized video belongs to a retired attempt');
  }
  private check(budget: Budget): void {
    this.checkOwner();
    if (budget.signal.aborted) throw new EngineError('CANCELLED', 'Finalized video delivery was cancelled', { retryable: false });
    if (!Number.isFinite(budget.endsAt) || performance.now() >= budget.endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Finalized video delivery exceeded its deadline', { retryable: false });
  }
  private wait<T>(work: Promise<T>, budget: Budget): Promise<T> {
    try { this.check(budget); } catch (error) { void work.catch(() => {}); return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      const interrupted = () => { try { this.check(budget); } catch (error) { finish(); reject(error); } };
      let timer: ReturnType<typeof setTimeout>;
      const expire = () => {
        if (performance.now() >= budget.endsAt) interrupted();
        else timer = setTimeout(expire, Math.max(1, Math.ceil(budget.endsAt - performance.now())));
      };
      timer = setTimeout(expire, Math.max(1, Math.ceil(budget.endsAt - performance.now())));
      const finish = () => {
        clearTimeout(timer);
        budget.signal.removeEventListener('abort', interrupted);
        this.localRetirement.signal.removeEventListener('abort', interrupted);
      };
      budget.signal.addEventListener('abort', interrupted, { once: true });
      this.localRetirement.signal.addEventListener('abort', interrupted, { once: true });
      work.then(value => {
        finish();
        try { this.check(budget); resolve(value); } catch (error) { reject(error); }
      }, error => { finish(); reject(error); });
      interrupted();
    });
  }
  private async persist(budget: Budget): Promise<void> {
    try {
      for (const entry of this.entries) {
        this.check(budget);
        if (entry.handle !== undefined) { await entry.handle.close(); entry.handle = undefined; }
        if (entry.writeComplete) entry.bytes = undefined;
        if (!entry.writeComplete) {
          await this.ensureDirectory(budget);
          this.check(budget);
          const firstWrite = entry.identity === undefined;
          entry.staging ??= path.join(this.stagingDirectory!.path, path.basename(entry.relative));
          // First creation is exclusive. A retry touches only its original FD-
          // verified private inode, never an existing caller-visible filename.
          if (!firstWrite) {
            const current = await lstat(entry.staging, { bigint: true });
            if (!current.isFile() || current.dev !== entry.identity?.dev || current.ino !== entry.identity.ino) throw fileFailure();
          }
          this.check(budget);
          const handle = await open(entry.staging, firstWrite ? 'wx' : constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
          entry.handle = handle;
          let failed = false;
          try {
            const identity = await handle.stat({ bigint: true });
            if (!identity.isFile() || (!firstWrite && (entry.identity?.dev !== identity.dev || entry.identity.ino !== identity.ino))) throw fileFailure();
            entry.identity = { dev: identity.dev, ino: identity.ino };
            this.check(budget);
            if (!firstWrite) { await handle.truncate(0); this.check(budget); }
            await handle.writeFile(entry.bytes!);
            entry.writeComplete = true;
          } catch { failed = true; }
          try { await handle.close(); entry.handle = undefined; }
          catch { failed = true; }
          this.check(budget);
          if (failed) throw fileFailure();
          entry.bytes = undefined;
        }
        this.check(budget);
        if (!entry.written) {
          await this.checkDirectory();
          await this.verifyFile(entry.staging!, entry);
          this.check(budget);
          // Hard-link publication is atomic and exclusive on this same FS.
          // EEXIST is failure, never adoption; no final path is ever unlinked.
          await link(entry.staging!, entry.absolute);
          entry.written = true;
        }
        await this.removeStaging(entry);
        this.check(budget);
      }
      await this.removeDirectory();
      this.check(budget);
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw fileFailure();
    }
  }
  private async ensureDirectory(budget: Budget): Promise<void> {
    if (this.stagingDirectory !== undefined) { await this.checkDirectory(); return; }
    this.check(budget);
    const video = path.join(this.owner.artifactsDir, 'video');
    await mkdir(video, { recursive: true });
    this.check(budget);
    const directory = await mkdtemp(path.join(video, '.native-finalized-'));
    this.stagingDirectory = { path: directory, dev: undefined, ino: undefined };
    const identity = await lstat(directory, { bigint: true });
    this.stagingDirectory.dev = identity.dev; this.stagingDirectory.ino = identity.ino;
    if (!identity.isDirectory() || (identity.mode & 0o777n) !== 0o700n) throw fileFailure();
    this.check(budget);
  }
  private async checkDirectory(): Promise<void> {
    const directory = this.stagingDirectory;
    if (directory === undefined) throw fileFailure();
    const current = await lstat(directory.path, { bigint: true });
    if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw fileFailure();
  }
  private async verifyFile(file: string, entry: Entry): Promise<void> {
    const current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.dev !== entry.identity?.dev || current.ino !== entry.identity.ino || current.size !== BigInt(entry.size)) throw fileFailure();
  }
  private async verifyPublished(budget: Budget): Promise<void> {
    try {
      for (const entry of this.entries) {
        this.check(budget);
        if (!entry.written) throw fileFailure();
        await this.verifyFile(entry.absolute, entry);
      }
      this.check(budget);
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw fileFailure();
    }
  }
  private async removeStaging(entry: Entry): Promise<void> {
    if (entry.staging === undefined) return;
    await this.checkDirectory();
    const current = await lstat(entry.staging, { bigint: true });
    if (!current.isFile() || current.dev !== entry.identity?.dev || current.ino !== entry.identity.ino) throw fileFailure();
    // Cleanup is confined to our random mode-0700 staging namespace. It never
    // traverses an observed foreign directory/symlink or removes a final path.
    await unlink(entry.staging);
    entry.staging = undefined;
  }
  private async removeDirectory(): Promise<void> {
    if (this.stagingDirectory === undefined) return;
    await this.checkDirectory();
    await rmdir(this.stagingDirectory.path); // Not recursive: unknown entries refuse cleanup.
    this.stagingDirectory = undefined;
  }
}
function invalid(message: string): EngineError { return new EngineError('INVALID_STATE', message, { retryable: false }); }
function fileFailure(): EngineError { return new EngineError('ENGINE_FAILURE', 'Finalized video file could not be saved', { retryable: false }); }
