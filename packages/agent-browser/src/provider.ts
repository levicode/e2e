/** Structural hosted-browser SPI. Leases never reconnect, replace themselves, or expose provider diagnostics. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  ConfigurationError, EngineError, isProviderRecording,
  type EngineAttemptContext, type EngineCleanupContext, type EngineFinishInfo,
  type EngineInitInfo, type EnginePrepareInfo, type EnginePrepareResult,
  type ProviderRecordContext, type ProviderRecording,
} from 'e2e/engine';

/** Worker leases require a fresh browser context per attempt; attempt leases exclusively own their browser. */
export type BrowserProviderScope = 'worker' | 'attempt';
export interface BrowserRequest {
  readonly runId: string;
  readonly targetName: string;
  readonly slot: number;
  readonly slots: number;
  readonly attemptId?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Provider progress is intentionally suppressed: third-party logs may contain credentials. */
  readonly log: (line: string) => void;
}
export interface BrowserLease {
  readonly id: string;
  readonly cdpEndpoint: string;
  /** Accepted for structural compatibility only. This engine never reconnects after uncertainty. */
  readonly reconnectEndpoint?: string | undefined;
}
export interface BrowserReleaseContext {
  readonly runId: string;
  readonly targetName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}
export interface BrowserDownloadContext {
  readonly runId: string;
  readonly targetName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}
export interface BrowserProviderDownloads {
  readonly dir: string;
  read(lease: BrowserLease, file: string, context: BrowserDownloadContext): Promise<Uint8Array>;
}
export interface BrowserProvider {
  readonly name: string;
  readonly scope?: BrowserProviderScope | undefined;
  acquire(request: BrowserRequest): Promise<BrowserLease>;
  release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void>;
  record?(lease: BrowserLease, context: ProviderRecordContext): Promise<ProviderRecording>;
  readonly downloads?: BrowserProviderDownloads | undefined;
  sweep?(context: BrowserReleaseContext): Promise<readonly string[]>;
}
export interface LeaseDownloads {
  readonly provider: string;
  readonly dir: string;
  read(file: string, signal: AbortSignal): Promise<Uint8Array>;
}
export interface LeaseRecording {
  readonly recording: ProviderRecording;
  readonly provider: string;
  readonly leaseId: string;
}

type Run = Pick<BrowserReleaseContext, 'runId' | 'targetName' | 'env'>;
type WorkerRun = Run & { slot: number; slots: number };
type Held = { active: boolean; leases: BrowserLease[]; workersRan: boolean };
type Handoff = { slots: number; leases: BrowserLease[] };
const silent = (): void => undefined;
const MAX_HANDOFF_BYTES = 16 * 1024;
const LATE_RELEASE_MS = 15_000;
const safeFailures = new WeakSet<Error>();

/** All failures deliberately exclude provider names, lease handles, endpoints, abort reasons, and causes. */
function failure(message: string, code: 'ENGINE_FAILURE' | 'CANCELLED' | 'OPERATION_TIMEOUT' = 'ENGINE_FAILURE'): EngineError {
  const error = new EngineError(code, message, { retryable: false });
  safeFailures.add(error);
  return error;
}

/** Bounds a third-party promise, catches synchronous throws, and never copies a third-party error. */
function guarded<T>(action: () => Promise<T>, signal: AbortSignal, label: string, timeoutMs?: number): Promise<T> {
  if (signal.aborted) return Promise.reject(failure(`${label} cancelled`, 'CANCELLED'));
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return Promise.reject(failure(`${label} timed out`, 'OPERATION_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(failure(`${label} cancelled`, 'CANCELLED')); };
    signal.addEventListener('abort', aborted, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => { cleanup(); reject(failure(`${label} timed out`, 'OPERATION_TIMEOUT')); }, Math.max(0, timeoutMs));
    Promise.resolve().then(() => { if (signal.aborted) throw failure(`${label} cancelled`, 'CANCELLED'); return action(); }).then((value) => { cleanup(); resolve(value); }, (error: unknown) => {
      cleanup(); reject(error instanceof Error && safeFailures.has(error) ? error : failure(`${label} failed`, signal.aborted ? 'CANCELLED' : 'ENGINE_FAILURE'));
    });
  });
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }
function endpoint(value: unknown): value is string {
  if (!nonempty(value)) return false;
  try { const url = new URL(value); return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) && url.hostname !== '' && url.hash === ''; }
  catch { return false; }
}
function validLease(value: unknown): value is BrowserLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<BrowserLease>;
  return nonempty(lease.id) && endpoint(lease.cdpEndpoint) && (lease.reconnectEndpoint === undefined || endpoint(lease.reconnectEndpoint));
}

/** Accepts existing browser adapters structurally without importing any implementation from another engine. */
export function asBrowserProvider(value: object): BrowserProvider {
  const candidate = value as Partial<BrowserProvider>;
  if (!candidate || !nonempty(candidate.name) || typeof candidate.acquire !== 'function' || typeof candidate.release !== 'function'
    || (candidate.scope !== undefined && candidate.scope !== 'worker' && candidate.scope !== 'attempt')
    || (candidate.record !== undefined && typeof candidate.record !== 'function')
    || (candidate.sweep !== undefined && typeof candidate.sweep !== 'function')) {
    throw new ConfigurationError('INVALID_CONFIG', 'agent-browser: invalid browser provider');
  }
  const downloads = candidate.downloads;
  if (downloads !== undefined && (!downloads || !nonempty(downloads.dir) || typeof downloads.read !== 'function'
    || (!path.posix.isAbsolute(downloads.dir) && !path.win32.isAbsolute(downloads.dir)))) {
    throw new ConfigurationError('INVALID_CONFIG', 'agent-browser: browser provider downloads require an absolute directory and read()');
  }
  return candidate as BrowserProvider;
}

/** This handoff cannot collide with the legacy engine, even when both engines use the same target name. */
function handoffVariable(target: string): string {
  return `E2E_AGENT_BROWSER_BROWSERS_${target.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_${createHash('sha256').update(target).digest('hex').slice(0, 8).toUpperCase()}`;
}
function encode(handoff: Handoff): string {
  const result = JSON.stringify({ slots: handoff.slots, leases: handoff.leases.map(({ id, cdpEndpoint, reconnectEndpoint }) => ({ id, cdpEndpoint, reconnectEndpoint })) });
  if (Buffer.byteLength(result) > MAX_HANDOFF_BYTES) throw failure('Browser provider handoff exceeds the worker environment limit');
  return result;
}
function decode(raw: string | undefined): Handoff | undefined {
  if (raw === undefined || Buffer.byteLength(raw) > MAX_HANDOFF_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as Partial<Handoff>;
    if (typeof value.slots === 'number' && Number.isSafeInteger(value.slots) && value.slots > 0 && Array.isArray(value.leases) && value.leases.every(validLease)) {
      return { slots: value.slots, leases: value.leases };
    }
  } catch { /* A corrupt or foreign handoff is never used. */ }
  return undefined;
}

/** Runs all cleanup actions even if one fails, then reports only a sanitized failure. */
async function all(actions: readonly (() => Promise<unknown>)[], label: string): Promise<void> {
  const results = await Promise.allSettled(actions.map(async (action) => action()));
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') {
    if (rejected.reason instanceof Error && safeFailures.has(rejected.reason)) throw rejected.reason;
    throw failure(label);
  }
}

/** Exact-owner lease lifecycle. A transport drop ends an attempt; it never triggers another acquire. */
export class LeasedBrowsers {
  readonly scope: BrowserProviderScope;
  readonly name: string;
  readonly #provider: BrowserProvider;
  readonly #held = new Map<string, Held>();
  #run: WorkerRun | undefined;
  #current: BrowserLease | undefined;
  #attempt: BrowserLease | undefined;
  #opened: object | undefined;
  #tenure: object = {};

  constructor(provider: BrowserProvider) {
    this.#provider = asBrowserProvider(provider);
    this.scope = provider.scope ?? 'worker';
    this.name = provider.name;
  }

  /** Acquires worker leases concurrently; their creating process retains the original objects for release. */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (this.#held.has(info.targetName)) throw failure('Browser provider target is already prepared');
    if (info.signal.aborted) throw failure('Browser preparation cancelled', 'CANCELLED');
    if (!Number.isSafeInteger(info.slots) || info.slots < 0) throw failure('Browser provider slot count is invalid');
    if (info.slots === 0) return {};
    const held: Held = { active: true, leases: [], workersRan: false };
    this.#held.set(info.targetName, held);
    const leases: BrowserLease[] = [];
    if (this.scope === 'worker') {
      await all(Array.from({ length: info.slots }, (_, slot) => async () => {
        await this.#acquire({ runId: info.runId, targetName: info.targetName, env: info.env, signal: info.signal, slots: info.slots, slot, log: silent }, () => held.active, (lease) => {
          held.leases.push(lease);
          leases[slot] = lease;
        });
      }), 'Browser provider could not prepare every worker');
    }
    if (!held.active || info.signal.aborted) throw failure('Browser preparation cancelled', 'CANCELLED');
    const env = { [handoffVariable(info.targetName)]: encode({ slots: info.slots, leases }) };
    held.workersRan = true;
    info.log(`Prepared ${leases.length} worker browser lease(s)`);
    return { ...(this.scope === 'worker' ? { workers: info.slots } : {}), env };
  }

  /** Releases all runner-owned leases exactly once and performs a bounded provider sweep after workers ran. */
  async finish(info: EngineFinishInfo): Promise<void> {
    const held = this.#held.get(info.targetName);
    this.#held.delete(info.targetName);
    if (!held) return;
    held.active = false;
    const context = { runId: info.runId, targetName: info.targetName, env: info.env, signal: info.signal, log: silent };
    const deadline = Date.now() + Math.max(0, info.timeoutMs);
    const actions = held.leases.splice(0).map((lease) => () => this.#release(lease, context, info.timeoutMs));
    let failed = false;
    try { await all(actions, 'Browser provider cleanup failed'); } catch { failed = true; }
    if (held.workersRan && this.#provider.sweep) {
      try { await guarded(() => this.#provider.sweep!(context), info.signal, 'Browser provider sweep', Math.max(0, deadline - Date.now())); }
      catch { failed = true; }
    }
    if (failed) throw failure('Browser provider cleanup failed');
  }

  /** Selects only the runner-prepared lease for this exact worker slot. */
  init(info: EngineInitInfo): void {
    if (this.#opened || this.#run) throw failure('Browser provider worker is already initialized');
    if (info.signal.aborted) throw failure('Browser provider initialization cancelled', 'CANCELLED');
    const handoff = decode(info.env[handoffVariable(info.targetName)]);
    if (!handoff || !Number.isSafeInteger(info.workerSlot) || info.workerSlot < 0 || info.workerSlot >= handoff.slots
      || (this.scope === 'worker' ? handoff.leases.length !== handoff.slots : handoff.leases.length !== 0)) {
      throw failure('Browser provider worker handoff is invalid or missing');
    }
    this.#tenure = {};
    this.#run = { runId: info.runId, targetName: info.targetName, env: info.env, slot: info.workerSlot, slots: handoff.slots };
    this.#current = handoff.leases[info.workerSlot];
  }

  /** Repeated calls return the identical endpoint; neither reconnectEndpoint nor acquire is consulted. */
  async endpoint(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw failure('Browser endpoint request cancelled', 'CANCELLED');
    this.#requireRun();
    const lease = this.scope === 'worker' ? this.#current : this.#attempt;
    if (!lease) throw failure('Browser provider has no active lease');
    return lease.cdpEndpoint;
  }

  /** An attempt-scoped acquisition cannot be committed after the attempt ends, even when the provider ignores abort. */
  async startAttempt(context: Pick<EngineAttemptContext, 'attemptId' | 'signal'>): Promise<BrowserLease> {
    const run = this.#requireRun();
    if (this.#opened) throw failure('Browser provider already has an open attempt');
    if (context.signal.aborted) throw failure('Browser lease acquisition cancelled', 'CANCELLED');
    const token = {};
    const tenure = this.#tenure;
    this.#opened = token;
    if (this.scope === 'worker') {
      if (!this.#current) throw failure('Browser provider has no worker lease');
      return this.#current;
    }
    const lease = await this.#acquire({ ...run, attemptId: context.attemptId, signal: context.signal, log: silent },
      () => this.#opened === token && this.#tenure === tenure, (acquired) => { this.#attempt = acquired; });
    if (this.#opened !== token || this.#tenure !== tenure || context.signal.aborted) {
      // endAttempt owns an already committed lease; an abandoned acquisition cleaned itself.
      throw failure('Browser lease arrived after its attempt ended', 'CANCELLED');
    }
    return lease;
  }

  /** Clears ownership before awaiting release, making cleanup idempotent and preventing the next attempt from seeing the lease. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const lease = this.#attempt;
    this.#attempt = undefined;
    this.#opened = undefined;
    if (lease) await this.#release(lease, { ...this.#requireRun(), signal: context.signal, log: silent }, context.timeoutMs);
  }

  /** Runner-created worker leases remain the runner's to release; attempt leases are still cleaned on abnormal disposal. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    this.#tenure = {};
    try { await this.endAttempt(context); }
    finally { this.#current = undefined; this.#run = undefined; }
  }

  /** Captures one lease for the recording lifetime, wrapping provider errors before public recording helpers see them. */
  recorder(attemptId: string): ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined {
    if (!this.#provider.record) return undefined;
    const run = this.#requireRun();
    const lease = this.#lease();
    return async (signal) => {
      if (signal.aborted) throw failure('Browser provider recording cancelled', 'CANCELLED');
      let recording: ProviderRecording;
      // The recording owner keeps this promise alive after cancellation to clean a late handle.
      try { recording = await this.#provider.record!(lease, { ...run, attemptId, signal }); }
      catch { throw failure('Browser provider recording failed', signal.aborted ? 'CANCELLED' : 'ENGINE_FAILURE'); }
      if (!isProviderRecording(recording)) throw failure('Browser provider returned an invalid recording');
      return {
        provider: 'browser provider', leaseId: 'current',
        recording: {
          startedAt: recording.startedAt,
          stop: async (context) => {
            // Outer video ownership bounds and shares this exact in-flight stop; never replace it.
            try { return await recording.stop(context); }
            catch { throw failure('Browser provider recording cleanup failed'); }
          },
        },
      };
    };
  }

  /** Captures the current lease and confines the requested file to the provider's declared download directory. */
  downloads(): LeaseDownloads | undefined {
    const served = this.#provider.downloads;
    if (!served) return undefined;
    const run = this.#requireRun();
    const lease = this.#lease();
    const filesystem = path.win32.isAbsolute(served.dir) && !path.posix.isAbsolute(served.dir) ? path.win32 : path.posix;
    return { provider: 'browser provider', dir: served.dir, read: async (file, signal) => {
      const relative = filesystem.relative(served.dir, file);
      if (!filesystem.isAbsolute(file) || relative === '' || relative === '..' || relative.startsWith(`..${filesystem.sep}`) || filesystem.isAbsolute(relative) || file.includes('\0')) {
        throw failure('Browser provider download path is outside its directory');
      }
      const bytes = await guarded(() => served.read(lease, file, { ...run, signal }), signal, 'Browser provider download');
      if (!(bytes instanceof Uint8Array)) throw failure('Browser provider download did not return bytes');
      return bytes;
    } };
  }

  #requireRun(): WorkerRun { if (!this.#run) throw failure('Browser provider worker is not initialized'); return this.#run; }
  #lease(): BrowserLease {
    const lease = this.scope === 'worker' ? this.#current : this.#attempt;
    if (!lease) throw failure('Browser provider has no active lease');
    return lease;
  }

  /** The fulfillment handler owns late cleanup even after the bounded caller has already returned. */
  async #acquire(request: BrowserRequest, active: () => boolean, accept: (lease: BrowserLease) => void): Promise<BrowserLease> {
    return guarded(async () => {
      const value: unknown = await this.#provider.acquire(request);
      if (!validLease(value)) {
        if (value && typeof value === 'object') void this.#lateRelease(value as BrowserLease, request);
        throw failure('Browser provider returned an invalid lease');
      }
      if (request.signal.aborted || !active()) {
        void this.#lateRelease(value, request);
        throw failure('Browser lease arrived after cancellation', 'CANCELLED');
      }
      accept(value);
      return value;
    }, request.signal, 'Browser lease acquisition');
  }
  #release(lease: BrowserLease, context: BrowserReleaseContext, timeoutMs: number): Promise<void> {
    return guarded(() => this.#provider.release(lease, context), context.signal, 'Browser provider release', timeoutMs);
  }
  async #lateRelease(lease: BrowserLease, run: Run): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATE_RELEASE_MS);
    timer.unref();
    try { await this.#release(lease, { ...run, signal: controller.signal, log: silent }, LATE_RELEASE_MS); }
    catch { /* A runner-side sweep is the final backstop for a provider that ignores cleanup. */ }
    finally { clearTimeout(timer); }
  }
}
