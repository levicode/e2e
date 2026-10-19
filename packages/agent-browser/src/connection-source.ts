/** Compatibility bridge for callback-supplied CDP endpoints, without transport recovery. */
import { ConfigurationError, EngineError, type EngineInitInfo } from 'e2e/engine';

export type CdpEndpointResolver = (signal: AbortSignal) => Promise<string>;
export interface BrowserConnect {
  readonly cdpEndpoint: CdpEndpointResolver;
  /** Selects attempt-scoped provisioning for compatibility; this callback is never invoked. */
  readonly reconnectEndpoint?: CdpEndpointResolver | undefined;
}

interface Attempt {
  readonly id: string;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly endpoint: Promise<string>;
  uncertain: boolean;
}

function invalid(): never { throw new ConfigurationError('INVALID_CONFIG', 'agentBrowser connect requires an endpoint callback and optional reconnect callback'); }
function failure(code: 'CANCELLED' | 'INVALID_STATE' | 'ENGINE_FAILURE' | 'OPERATION_TIMEOUT', message: string): EngineError {
  return new EngineError(code, message, { retryable: false });
}

/** Snapshots callbacks so later mutations of the config cannot change connection scope. */
export function validateConnect(value: unknown): BrowserConnect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  try {
    const candidate = value as Partial<BrowserConnect>;
    const { cdpEndpoint, reconnectEndpoint } = candidate;
    if (Object.keys(candidate).some((key) => key !== 'cdpEndpoint' && key !== 'reconnectEndpoint')
      || typeof cdpEndpoint !== 'function'
      || (reconnectEndpoint !== undefined && typeof reconnectEndpoint !== 'function')) invalid();
    return { cdpEndpoint, ...(reconnectEndpoint === undefined ? {} : { reconnectEndpoint }) };
  } catch { invalid(); }
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) && url.hostname !== '' && url.hash === '';
  } catch { return false; }
}

/** Bounds callback resolution and discards late completion; no callback error or endpoint is echoed. */
function resolveEndpoint(callback: CdpEndpointResolver, signal: AbortSignal, timeoutMs: number): Promise<string> {
  if (signal.aborted) return Promise.reject(failure('CANCELLED', 'Browser endpoint resolution cancelled'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(failure('OPERATION_TIMEOUT', 'Browser endpoint resolution budget exhausted'));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const finish = (error?: EngineError, value?: string): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (error) { controller.abort(); reject(error); } else resolve(value!);
    };
    const aborted = () => finish(failure('CANCELLED', 'Browser endpoint resolution cancelled'));
    const timer = setTimeout(() => finish(failure('OPERATION_TIMEOUT', 'Browser endpoint resolution timed out')), Math.min(timeoutMs, 2_147_483_647));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted || controller.signal.aborted) throw failure('CANCELLED', 'Browser endpoint resolution cancelled');
      return callback(AbortSignal.any([signal, controller.signal]));
    }).then((value) => {
      if (!validEndpoint(value)) finish(failure('ENGINE_FAILURE', 'Browser endpoint callback returned an invalid endpoint'));
      else finish(undefined, value);
    }, () => finish(failure(signal.aborted ? 'CANCELLED' : 'ENGINE_FAILURE', 'Browser endpoint callback failed')));
    if (signal.aborted) aborted();
  });
}

/** One worker source. A dropped connection never asks this source to provision a replacement. */
export class ConnectionSource {
  readonly scope: 'worker' | 'attempt';
  private readonly connect: BrowserConnect;
  private initialized = false;
  private workerEndpoint: Promise<string> | undefined;
  private current: Attempt | undefined;
  private generation = 0;

  constructor(connect: BrowserConnect) {
    this.connect = validateConnect(connect);
    this.scope = this.connect.reconnectEndpoint === undefined ? 'worker' : 'attempt';
  }

  init(info: Pick<EngineInitInfo, 'signal'>): void {
    if (this.initialized) throw failure('INVALID_STATE', 'Browser endpoint source is already initialized');
    if (info.signal.aborted) throw failure('CANCELLED', 'Browser endpoint source initialization cancelled');
    this.initialized = true; this.generation++;
  }

  /** Provision only at an explicit attempt boundary; worker scope calls its resolver once in total. */
  async startAttempt(context: { readonly attemptId: string; readonly signal: AbortSignal; readonly timeoutMs?: number }): Promise<void> {
    if (!this.initialized || this.current) throw failure('INVALID_STATE', 'Browser endpoint source cannot start this attempt');
    if (context.signal.aborted) throw failure('CANCELLED', 'Browser endpoint source attempt cancelled');
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const endpoint = this.scope === 'worker' && this.workerEndpoint !== undefined
      ? this.workerEndpoint : resolveEndpoint(this.connect.cdpEndpoint, signal, context.timeoutMs ?? 30_000);
    if (this.scope === 'worker') this.workerEndpoint = endpoint;
    const attempt: Attempt = { id: context.attemptId, controller, signal, endpoint, uncertain: false };
    this.current = attempt;
    const generation = this.generation;
    await endpoint;
    if (this.current !== attempt || generation !== this.generation || signal.aborted) throw failure('CANCELLED', 'Browser endpoint arrived after its attempt ended');
  }

  /** Reuses the already-provisioned endpoint, never reconnectEndpoint and never another resolver call. */
  async endpoint(signal: AbortSignal): Promise<string> {
    const attempt = this.current;
    if (!this.initialized || !attempt || attempt.uncertain) throw failure('INVALID_STATE', 'No usable browser endpoint attempt is active');
    if (signal.aborted || attempt.signal.aborted) throw failure('CANCELLED', 'Browser endpoint request cancelled');
    const endpoint = await attempt.endpoint;
    if (this.current !== attempt || attempt.uncertain || signal.aborted || attempt.signal.aborted) throw failure('INVALID_STATE', 'Browser endpoint attempt is no longer usable');
    return endpoint;
  }

  /** Uncertainty only closes the source for this attempt; it never invokes a recovery callback. */
  poisonAttempt(): void { if (this.current) { this.current.uncertain = true; this.current.controller.abort(); } }

  endAttempt(): void {
    const attempt = this.current;
    this.current = undefined;
    attempt?.controller.abort();
  }

  /** The engine owns its contexts; the connect callback never grants permission to kill the remote browser. */
  dispose(): void { this.endAttempt(); this.generation++; this.initialized = false; this.workerEndpoint = undefined; }
}
