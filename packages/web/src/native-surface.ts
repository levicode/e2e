/** One native adapter owns a worker browser and each attempt's scoped resources. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Browser as PlaywrightBrowser, BrowserContext, Page } from 'playwright-core';
import { bindPersistentPlaywrightContext, connectPlaywrightClient, createPlaywrightContext, disconnectedBindingMode, type PlaywrightBinding } from './native/playwright-binding.ts';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import {
  EngineError, raceAbort, validateJsonValue, stopProviderRecording,
  type EngineAppInfo, type EngineAttemptContext, type EngineCleanupContext,
  type EngineFinishInfo, type EngineInitInfo, type EngineLocateOptions,
  type EngineFieldValues, type EngineReadField,
  type EngineObserveOptions, type EnginePrepareInfo, type EnginePrepareResult,
  type EngineSnapshot, type EngineState, type VideoSegment, type LocatorAction, type LocatorExpression, type NodeRef,
  type OperationContext, type PointerAction, type SemanticNode, type ViewportPoint,
} from 'e2e/engine';
import { ConfiguredInitScripts } from './init-scripts.ts';
import { LeasedBrowsers, type LeaseRecording } from './provider.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from './protected-app.ts';
import { connectionAbort, withConnectionBudget, type ConnectionBudget } from './operation-budget.ts';
import { ErrorLatch, isClassified, sanitizeFilename } from './runtime-support.ts';
import type { WebOptions } from './web-options.ts';
import { decodeBrowserEvent, decodeBrowserResult } from './native/browser-decode.ts';
import { BrowserChannel, isNativeNotDispatched } from './native/browser-channel.ts';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap, NativeWebSurface } from './native/browser-contract.ts';
import { EngineChannel, isUnavailableBlobRead } from './native/engine-channel.ts';
import { NativeReferenceAliases, type ReferenceOwner } from './native/reference-aliases.ts';
import { FinalizedVideoFiles } from './native/finalized-video-files.ts';
import type { EngineCommandMap, NativeImage, RecoveryIdentity, ScopeCreationOptions } from './native/engine-contract.ts';
import type { NativeClient } from './native/client.ts';
import { connectNativeProcess } from './native/process.ts';
import type { NativeEvent } from './native/protocol.ts';
import { readUploadFile, selectUploadFiles } from './native/upload-files.ts';
import { resolveNativeExecutable } from './native/runtime.ts';

import { isNativeProcessCleanupUnresolved } from './native/process-cleanup.ts';
import { PERSISTENT_PAGE_REOPEN_CAPABILITY, REQUIRED_CAPABILITIES } from './native/capabilities.ts';
const SECURE_FIELD_SELECTOR = 'input[type="password" i]';
const LIFECYCLE_TIMEOUT_MS = 3_600_000;
const LATE_RECORDING_STOP_MS = 10_000;
interface Listener { readonly callback: (event: BrowserEventMap[keyof BrowserEventMap]) => void | Promise<void>; unsubscribe?: (() => void) | undefined }
interface PendingConnection { work: Promise<void>; cleanupFailure?: unknown }
interface Attempt {
  epoch: number;
  ready: boolean;
  pageReady: boolean;
  rawBinding?: PlaywrightBinding;
  rawOpening?: Promise<void>;
  /** Prepare ACK owns resources even when the later adopt RPC never dispatches. */
  interopPrepared?: true;
  rawMedia?: ScopeCreationOptions['media'];
  readonly context: EngineAttemptContext;
  readonly retirement: AbortController;
  cleanupSignal?: AbortSignal;
  lateRecordingFailure?: unknown;
  observeLateRecordingFailure?: (cause: unknown) => void;
  readonly wireRequests: Set<Promise<void>>;
  scope: string;
  recovery?: RecoveryIdentity;
  credentials?: { readonly username: string; readonly password: string } | undefined;
  recording?: LeaseRecording | undefined;
  recordingStart?: Promise<void> | undefined;
  recordingStartSignal?: AbortSignal | undefined;
  readonly recordingStarts: Set<Promise<void>>;
  readonly lateRecordings: Set<LeaseRecording>;
  readonly lateRecordingStops: Map<LeaseRecording, Promise<void>>;
  recordingStop?: Promise<readonly VideoSegment[]> | undefined;
  environmentTold?: boolean;
  observationHighWater?: { readonly epoch: number; readonly scope: string; readonly client: NativeClient; revision: bigint };
  reconnect?: ((signal: AbortSignal) => string | Promise<string>) | undefined;
  recoveryPending?: boolean;
  /** Public observation-derived points need new evidence after CDP recovery. */
  recoveryObservationRequired: boolean;
  recovering?: Promise<void> | undefined;
  /** The recovery owner fails this attempt, not only its current waiters. */
  recoveryFailure?: { readonly error: unknown };
  channel?: BrowserChannel;
  counter: number;
  videoCounter: number;
  finalizedVideo?: FinalizedVideoFiles;
  readonly downloads: Map<string, Promise<Uint8Array | undefined>>;
}

/** Not exported as a Playwright surface and never supplies raw native/CDP commands to users. */
export class NativeSurface implements NativeWebSurface {
  latch = new ErrorLatch();
  private scripts: ConfiguredInitScripts;
  private readonly leases: LeasedBrowsers | undefined;
  private initInfo: EngineInitInfo | undefined;
  private app: EngineAppInfo = {};
  private attempt: Attempt | undefined;
  private retiringAttempt: Attempt | undefined;
  private endingAttempt: Promise<void> | undefined;
  private client: NativeClient | undefined;
  private clientTenure = 0;
  private workerRetirement = new AbortController();
  private disposing: Promise<void> | undefined;
  private workerRestartable = false;
  private workerCleanupUnconfirmed = false;
  private retirementFailure: unknown;
  private connecting: PendingConnection | undefined;
  private engine: EngineChannel | undefined;
  private executable: string | undefined;
  private workerEndpoint: string | undefined;
  private playwrightClient: PlaywrightBrowser | undefined;
  private playwrightClosing: Promise<void> | undefined;
  private workerSourceLost = false;
  private openedBefore = false;
  private readonly callbackOwner = new AsyncLocalStorage<{ attempt: Attempt; epoch: number; notRevoked: () => boolean }>();
  private registryHighWater = 0;
  private registryCurrent = 0;
  private readonly usedContexts = new Set<string>();
  private readonly references = new NativeReferenceAliases();
  private readonly listeners = new Map<keyof BrowserEventMap, Set<Listener>>();

  constructor(private readonly options: WebOptions) {
    this.scripts = new ConfiguredInitScripts(options.initScripts ?? []);
    this.leases = typeof options.browser === 'object' ? new LeasedBrowsers(options.browser) : undefined;
  }

  /** Internal attempt-bound fixture view, not a second adapter or public browser handle. */
  fixtureSurface(): NativeWebSurface {
    const attempt = this.requireAttempt(); const client = this.requireClient(); const latch = this.latch;
    const check = () => { this.assertAttempt(attempt); this.assertCallback(); };
    return {
      latch,
      latchCallbackFailure: (scope, error) => { if (this.callbackOwner.getStore()?.notRevoked() !== false && (this.attempt !== attempt || (attempt.scope === scope && this.callbackIsCurrent()))) latch.latch(error); },
      get identityScope() { check(); return attempt.scope; },
      routeRegistryVersion: () => { check(); return this.routeRegistryVersion(); },
      allocateRouteRegistryVersion: () => { check(); return this.allocateRouteRegistryVersion(); },
      invalidate: () => this.attempt === attempt && this.callbackIsCurrent() ? client.invalidate() : invalidState('The fixture belongs to a retired attempt'),
      command: (name, args, operation) => { check(); return this.command(name, args, operation); },
      subscribe: (name, callback) => { check(); return this.subscribe(name, callback); },
      decide: (token, decision, operation) => { check(); return this.decide(token, decision, operation); },
      projectPath: file => { check(); return this.projectPath(file); },
      siteHeaders: url => { check(); return this.siteHeaders(url); },
      artifactPath: (folder, label, extension) => { check(); return this.artifactPath(folder, label, extension); },
    };
  }

  latchCallbackFailure(scope: string, error: Error): void { if (this.attempt?.scope === scope) this.latch.latch(error); }
  get identityScope(): string { return this.requireAttempt().scope; }
  routeRegistryVersion(): number { return this.registryCurrent; }
  allocateRouteRegistryVersion(): number {
    if (this.registryHighWater >= Number.MAX_SAFE_INTEGER) throw this.invalidate();
    return ++this.registryHighWater;
  }
  invalidate(): EngineError { return this.requireClient().invalidate(); }
  private get persistent(): boolean { return this.leases?.scope === 'attempt' || this.options.connect?.reconnectEndpoint !== undefined; }

  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.scripts.load(info.projectRoot);
    // Preparation never downloads or executes an unverified arbitrary PATH binary.
    await resolveNativeExecutable(info.env, info.projectRoot);
    return this.leases?.prepare(info);
  }
  async finish(info: EngineFinishInfo): Promise<void> { await this.leases?.finish(info); }
  async init(info: EngineInitInfo): Promise<void> {
    this.leases?.assertCanInit();
    if (this.disposing !== undefined) throw invalidState('Native worker disposal is still pending');
    if (this.workerRetirement.signal.aborted) {
      if (!this.workerRestartable) throw invalidState('Native worker cleanup has not been confirmed');
      this.workerRetirement = new AbortController(); this.workerRestartable = false;
      this.retirementFailure = undefined;
      this.openedBefore = false; this.workerSourceLost = false; this.workerEndpoint = undefined;
    }
    // An older initialization keeps its retired authority across every await.
    const retirement = this.workerRetirement;
    const signal = AbortSignal.any([info.signal, retirement.signal]);
    const check = () => { if (signal.aborted) throw new EngineError('CANCELLED', 'Native worker initialization was cancelled', { retryable: false }); };
    check();
    this.initInfo = info; this.app = info.app; this.leases?.init(info);
    const scripts = new ConfiguredInitScripts(this.options.initScripts ?? []);
    await raceAbort(() => scripts.load(info.projectRoot), signal, 'loading browser initialization scripts');
    check(); this.scripts = scripts;
    const executable = await raceAbort(() => resolveNativeExecutable(info.env, info.projectRoot), signal, 'resolving native browser executable');
    check(); this.executable = executable;
    if (!this.persistent) {
      const endpoint = this.leases !== undefined
        ? await raceAbort(() => this.leases!.endpoint(signal), signal, 'resolving worker browser endpoint')
        : this.options.connect === undefined ? undefined : await this.resolveEndpoint(this.options.connect.cdpEndpoint, signal, 'connect.cdpEndpoint');
      check(); this.workerEndpoint = endpoint;
      await this.connect(this.operation(signal));
    }
  }
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    const retirement = this.endingAttempt;
    if (!this.workerRetirement.signal.aborted && this.retirementFailure === undefined && retirement !== undefined) {
      await raceAbort(() => retirement, context.signal, 'waiting for native attempt retirement');
    }
    if (this.workerRetirement.signal.aborted || this.workerCleanupUnconfirmed || this.retirementFailure !== undefined || this.attempt !== undefined || this.retiringAttempt !== undefined || this.connecting !== undefined) throw invalidState('An attempt is active or its provider recording cleanup is unresolved');
    const attempt: Attempt = { epoch: 0, ready: false, pageReady: false, recoveryObservationRequired: false, context, retirement: new AbortController(), wireRequests: new Set(), scope: '', counter: 0, videoCounter: 0, downloads: new Map(), recordingStarts: new Set(), lateRecordings: new Set(), lateRecordingStops: new Map() };
    this.attempt = attempt; this.latch = new ErrorLatch(); this.listeners.clear();
    const startupSignal = AbortSignal.any([context.signal, attempt.retirement.signal]);
    const startingOperation = this.operation(startupSignal);
    const startupDeadline = performance.now() + startingOperation.timeoutMs;
    const operation: OperationContext = { ...startingOperation, get timeoutMs() {
      const remaining = startupDeadline - performance.now();
      if (remaining <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Browser startup exhausted its original deadline', { retryable: false });
      return remaining;
    } };
    let openDispatched = false;
    let attemptLeaseAcquired = false;
    let policyRejectedClient: NativeClient | undefined;
    try {
      if (this.options.basicAuth !== undefined) attempt.credentials = await raceAbort(() => httpCredentials(this.options.basicAuth!, context.resolveSecret), startupSignal, 'resolving browser credentials');
      this.assertAttempt(attempt);
      if (this.workerSourceLost && !this.persistent) {
        const retiredClient = this.client; this.client = undefined; this.engine = undefined; this.openedBefore = false;
        await retiredClient?.close(operation);
        this.assertAttempt(attempt);
        this.workerEndpoint = this.leases === undefined
          ? this.options.connect === undefined ? undefined : await this.resolveEndpoint(this.options.connect.cdpEndpoint, startupSignal, 'connect.cdpEndpoint')
          : await raceAbort(() => this.leases!.endpoint(startupSignal), startupSignal, 'resolving worker browser replacement');
        this.assertAttempt(attempt); this.workerSourceLost = false;
      }
      let endpoint = this.workerEndpoint;
      if (this.leases?.scope === 'attempt') { const lease = await this.leases.startAttempt(context); attemptLeaseAcquired = true; endpoint = lease.cdpEndpoint; attempt.reconnect = () => lease.reconnectEndpoint ?? lease.cdpEndpoint; }
      else if (this.persistent) { endpoint = await this.resolveEndpoint(this.options.connect!.cdpEndpoint, startupSignal, 'connect.cdpEndpoint'); attempt.reconnect = this.options.connect!.reconnectEndpoint; }
      this.assertAttempt(attempt);
      if (context.signal.aborted) throw new EngineError('CANCELLED', 'Native attempt startup was cancelled', { retryable: false });
      if (this.client === undefined) await this.connect(operation);
      this.assertAttempt(attempt);
      const creation = this.creationOptions();
      attempt.rawMedia = { ...creation.media };
      const args: EngineCommandMap['scope.open']['args'] = this.openedBefore && !this.persistent
        ? { ...creation, source: 'reuse', context: 'isolated' }
        : endpoint === undefined
          ? { ...creation, source: 'launch', context: 'isolated', headless: this.initInfo?.headed !== true }
          : { ...creation, source: 'connect', context: this.persistent ? 'persistent' : 'isolated', endpoint };
      openDispatched = true;
      const establishing = (async () => {
        if (this.persistent) {
          const opened = await this.requireEngine().command('scope.open', args, operation);
          attempt.scope = opened.identityScope; attempt.recovery = opened.recoveryIdentity;
          const ids = await this.requireEngine().command('scope.interop.identify', { identityScope: opened.identityScope }, operation);
          if (!ids.persistent || endpoint === undefined) throw this.invalidate();
          this.playwrightClient = await connectPlaywrightClient(endpoint, operation);
          attempt.rawBinding = await bindPersistentPlaywrightContext(this.playwrightClient, ids, operation);
          if (creation.viewport !== null) await attempt.rawBinding.page.setViewportSize(creation.viewport);
          await attempt.rawBinding.page.emulateMedia(creation.media);
          return opened;
        }
        const preparationId = randomUUID();
        // PW owns user-script registration for this isolated context. Native owns
        // its runtime, harness network policy and observation/action machinery.
        const prepared = await this.requireEngine().command('scope.interop.prepare', { ...args, initScripts: [], preparationId }, operation);
        attempt.interopPrepared = true;
        if (prepared.preparationId !== preparationId) throw this.invalidate();
        if (this.playwrightClient === undefined) this.playwrightClient = await connectPlaywrightClient(prepared.endpoint, operation);
        if (!this.playwrightClient.isConnected()) throw invalidState('The isolated Playwright context was lost; it cannot recover as a persistent default context');
        attempt.rawBinding = await createPlaywrightContext(this.playwrightClient, creation, operation);
        return this.requireEngine().command('scope.interop.adopt', { preparationId, contextId: attempt.rawBinding.contextId, targetId: attempt.rawBinding.targetId }, operation);
      })();
      attempt.rawOpening = establishing.then(() => undefined);
      void attempt.rawOpening.catch(() => {});
      const opened = await establishing;
      this.assertAttempt(attempt);
      attempt.scope = opened.identityScope; attempt.recovery = opened.recoveryIdentity;
      if (this.persistent && this.leases === undefined) {
        if (this.usedContexts.has(opened.recoveryIdentity.context)) {
          const client = this.requireClient();
          client.negotiation(); // Only a confirmed usable open can take policy-only retirement.
          policyRejectedClient = client;
          throw invalidState('The endpoint reused a browser context across attempts');
        }
        this.usedContexts.add(opened.recoveryIdentity.context);
      }
      this.openedBefore = true;
      this.bindChannel(attempt);
      const downloads = this.leases?.downloads();
      await this.requireEngine().command('scope.configure', {
        identityScope: attempt.scope, testIdAttribute: this.options.testIdAttribute ?? 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR,
        requestPolicy: { ...(this.app.site === undefined ? {} : { site: this.app.site }), ...(this.options.headers === undefined ? {} : { headers: lowercaseNames(this.options.headers) }), ...(attempt.credentials === undefined ? {} : { basicAuth: attempt.credentials }) },
        downloads: downloads === undefined ? { source: 'local' } : { source: 'provider', remoteDirectory: downloads.dir },
      }, operation);
      this.assertAttempt(attempt);
      const version = this.allocateRouteRegistryVersion();
      // Startup alone may admit its captured unpublished owner. Keep callback and recovery fences.
      const admitted = await this.admit(operation, attempt);
      this.assertScope(attempt, admitted.scope);
      await attempt.channel!.command('network.routes.replace', { version, registrationIds: [] }, admitted.operation);
      this.assertAttempt(attempt);
      if (startupSignal.aborted) throw new EngineError('CANCELLED', 'Native attempt startup was cancelled', { retryable: false });
      this.registryCurrent = version;
      if (attempt.rawBinding?.kind === 'isolated') {
        // Reserve a script-free blank Page first. Register user scripts only
        // after native ownership, headers, routes and dialogs are installed.
        // Activation refreshes that same Page before the first app navigation.
        for (const source of creation.initScripts) {
          await attempt.rawBinding.context.addInitScript(source);
          this.assertAttempt(attempt); this.assertBudget(operation);
        }
      }
      attempt.ready = true;
    } catch (cause) {
      // A healthy, fully opened scope rejected only by local policy still needs scope.end.
      // The existing retirement owner fences business work and preserves cleanup failures.
      if (attempt.interopPrepared && this.attempt === attempt) {
        // No fresh ordinary scope.end budget: only the existing exact Close
        // safety authority may retire earlier prepare/PW allocations here.
        attempt.retirement.abort();
        void this.retireAttempt({ signal: attempt.retirement.signal, timeoutMs: 0 }).catch(() => {});
      } else if (!this.persistent && openDispatched && !attempt.interopPrepared && !attemptLeaseAcquired && attempt.scope === '' && isNativeNotDispatched(cause) && this.attempt === attempt) {
        // A settled refusal of prepare itself owns no new browser/context.
        // Unlike adopt refusal after prepare ACK, it can retain the healthy worker.
        attempt.credentials = undefined; this.attempt = undefined;
      } else if (policyRejectedClient !== undefined && this.client === policyRejectedClient && this.attempt === attempt) {
        // Keep the unpublished owner for endAttempt's caller-provided cleanup budget.
        attempt.retirement.abort();
      }
      // Unknown or partially opened scopes remain unusable; do not generalize the policy exception.
      else if (openDispatched && this.attempt === attempt && this.client !== undefined && !this.client.isTerminal() && !(attempt.scope === '' && isNativeNotDispatched(cause))) this.client.invalidate();
      if (!openDispatched && !attemptLeaseAcquired && this.attempt === attempt) { attempt.credentials = undefined; this.attempt = undefined; }
      throw cause;
    }
  }
  settleAttempt(context: EngineCleanupContext): Promise<void> { return this.latch.settle(context); }
  endAttempt(context: EngineCleanupContext): Promise<void> {
    // Ordinary cleanup uses this budget; exact mandatory retirement stays owned.
    return waitForRetirement(this.retireAttempt(context), context);
  }
  private retireAttempt(context: EngineCleanupContext): Promise<void> {
    if (this.endingAttempt !== undefined) return this.endingAttempt;
    if (this.retirementFailure !== undefined && this.retiringAttempt === undefined && this.connecting === undefined) return Promise.reject(this.retirementFailure);
    let resolve!: () => void; let reject!: (cause: unknown) => void;
    const owned = new Promise<void>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
    // Publish the existing owner before provider code can synchronously re-enter cleanup.
    this.endingAttempt = owned;
    void owned.catch(() => {});
    const deadline = cleanupDeadline(context);
    void this.closeAttempt(deadline).finally(deadline.dispose).then(() => {
      if (this.endingAttempt === owned) this.endingAttempt = undefined;
      resolve();
    }, cause => {
      this.retirementFailure ??= cause;
      if (this.endingAttempt === owned) this.endingAttempt = undefined;
      reject(this.retirementFailure);
    });
    return owned;
  }
  private async closeAttempt(deadline: CleanupDeadline): Promise<void> {
    const cleanup = deadline.context; const remaining = deadline.remaining;
    const attempt = this.attempt ?? this.retiringAttempt;
    const client = this.client; const engine = this.engine; const connecting = this.connecting;
    if (connecting !== undefined) this.clientTenure++;
    if (attempt !== undefined) attempt.cleanupSignal = cleanup.signal;
    attempt?.retirement.abort(); this.references.retire();
    const finalizedCleanup = attempt?.finalizedVideo?.retire();
    const recordingStarts = [...(attempt?.recordingStarts ?? [])];
    const recordingStops = new Set<Promise<unknown>>();
    if (attempt?.recordingStop !== undefined) recordingStops.add(attempt.recordingStop);
    let scopeEnd: Promise<unknown> | undefined;
    let scopeEnded = false;
    let failure: unknown = this.retirementFailure;
    const failed = (cause: unknown, departed = false) => {
      // A departed waiter is not a failed exact-owner cleanup receipt.
      if (departed && cleanup.signal.aborted && cause instanceof EngineError && (cause.code === 'CANCELLED' || cause.code === 'OPERATION_TIMEOUT')) return;
      failure ??= cause;
      this.retirementFailure ??= cause;
    };
    // Observe exact receipts when they settle. Joining them in teardown order
    // must not reorder the first real failure after the caller has departed.
    const receipt = <T>(work: Promise<T>, departed = false): Promise<T> => {
      void work.catch(cause => { failed(cause, departed); });
      return work;
    };
    if (finalizedCleanup !== undefined) receipt(finalizedCleanup);
    for (const stopping of recordingStops) receipt(stopping);
    if (attempt !== undefined) for (const stopping of attempt.lateRecordingStops.values()) receipt(stopping);
    if (attempt !== undefined) {
      // New rollback receipts can arrive after this retirement has started.
      // Observe their actual failure, not the later body-cancellation chain.
      attempt.observeLateRecordingFailure = failed;
      if (attempt.lateRecordingFailure !== undefined && attempt.lateRecordings.size > 0) failed(attempt.lateRecordingFailure);
    }
    if (connecting !== undefined) {
      const observed = () => { if (connecting.cleanupFailure !== undefined) failed(connecting.cleanupFailure); };
      void connecting.work.then(observed, observed);
    }
    this.attempt = undefined; this.retiringAttempt = attempt; this.listeners.clear(); attempt?.channel?.dispose();
    if (attempt !== undefined) attempt.credentials = undefined;
    try {
      remaining();
      if (attempt?.rawOpening !== undefined) {
        await raceAbort(() => attempt.rawOpening!.catch(() => undefined), cleanup.signal, 'joining Playwright context creation');
        remaining();
      }
      if (attempt !== undefined && attempt.wireRequests.size > 0) {
        await raceAbort(() => Promise.all(attempt.wireRequests), cleanup.signal, 'settling retired native requests');
        remaining();
      }
      if (connecting !== undefined) {
        await raceAbort(() => connecting.work.catch(() => undefined), cleanup.signal, 'retiring native connection');
        remaining();
        if (connecting.cleanupFailure !== undefined) throw connecting.cleanupFailure;
      }
      if (recordingStarts.length > 0) {
        await raceAbort(() => Promise.allSettled(recordingStarts), cleanup.signal, 'retiring provider recording starts');
        remaining();
      }
      if (attempt !== undefined) for (const recording of attempt.lateRecordings) {
        remaining();
        const stopping = receipt(this.stopLateProviderRecording(attempt, recording, cleanup.signal)); recordingStops.add(stopping);
        await raceAbort(() => stopping, cleanup.signal, 'retiring late provider recording');
        remaining();
      }
      if (attempt?.recording !== undefined) {
        remaining();
        const stopping = receipt(this.stopProviderVideo(attempt, cleanup.signal)); recordingStops.add(stopping);
        await raceAbort(() => stopping, cleanup.signal, 'retiring provider recording');
        remaining();
      }
      if (failure === undefined && client?.isTerminal() !== true && client?.recoveryScope() === undefined && attempt !== undefined && attempt.scope !== '' && engine !== undefined) {
        const callbackEpoch = client!.callbackCheckpoint(); const budget = remaining();
        scopeEnd = engine.command('scope.end', { identityScope: attempt.scope }, this.operation(budget.signal, budget.timeoutMs, attempt.context.attemptId), callbackEpoch);
        receipt(scopeEnd, true);
        await raceAbort(() => scopeEnd!, cleanup.signal, 'ending native scope');
        scopeEnded = true; client!.retireCallbacks(callbackEpoch, 'scope-ended');
      }
    } catch (cause) { failed(cause, true); }

    // NativeClient.close retains its existing independent terminal-safety budget.
    // Give it only the caller's remaining wait before independent lease release.
    const needsClose = client !== undefined && ((attempt !== undefined && !scopeEnded) || this.persistent || this.workerSourceLost || failure !== undefined || cleanup.signal.aborted);
    const closing = receipt(needsClose ? this.closeClient(cleanup, client) : Promise.resolve());
    try { await raceAbort(() => closing, cleanup.signal, 'waiting for native close'); }
    catch (cause) { failed(cause, true); }
    // Release billing with the original signal, even if expired. Its actual
    // receipt remains owned; a later cleanup caller cannot reissue release.
    const releasing = receipt(this.leases?.endAttempt(cleanup) ?? Promise.resolve());
    let nativeRetired = !needsClose && (scopeEnded || attempt === undefined || client === undefined);
    let finalizedCleanupProven = finalizedCleanup === undefined;
    let released = false;
    try {
      try { await closing; if (this.client !== client) nativeRetired = true; } catch (cause) { failed(cause); }
      // Join already-owned work, not new effects. Cancel ACK alone is not settlement.
      if (attempt?.rawOpening !== undefined) await attempt.rawOpening.catch(() => undefined);
      if (scopeEnd !== undefined) try { await scopeEnd; } catch (cause) { failed(cause, true); }
      if (attempt !== undefined) await Promise.allSettled(attempt.wireRequests);
      if (connecting !== undefined) {
        await connecting.work.catch(() => undefined);
        if (connecting.cleanupFailure !== undefined) failed(connecting.cleanupFailure);
      }
      await Promise.allSettled(recordingStarts);
      for (const stopping of recordingStops) try { await stopping; } catch (cause) { failed(cause); }
      if (attempt?.lateRecordingFailure !== undefined && attempt.lateRecordings.size > 0) failed(attempt.lateRecordingFailure);
      if (finalizedCleanup !== undefined) {
        try { await finalizedCleanup; finalizedCleanupProven = true; }
        catch (cause) { this.workerCleanupUnconfirmed = true; failed(cause); }
      }
      try { await releasing; released = true; }
      catch (cause) { this.workerCleanupUnconfirmed = true; failed(cause); }
      const recordingsRetired = attempt === undefined || (attempt.recording === undefined && attempt.recordingStarts.size === 0 && attempt.lateRecordings.size === 0);
      if (nativeRetired && finalizedCleanupProven && recordingsRetired && released && connecting?.cleanupFailure === undefined) {
        attempt?.downloads.clear();
        if (attempt !== undefined) delete attempt.observationHighWater;
        this.retiringAttempt = undefined;
      } else failure ??= invalidState('Native attempt cleanup remains unresolved');
    } finally { if (attempt !== undefined) attempt.credentials = undefined; }
    if (failure !== undefined) throw failure;
  }

  dispose(context: EngineCleanupContext): Promise<void> {
    this.workerRetirement.abort();
    if (this.disposing === undefined) {
      let resolve!: () => void; let reject!: (cause: unknown) => void;
      const owned = new Promise<void>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
      this.disposing = owned;
      void owned.catch(() => {});
      const disposed = () => {
        // A reported old failure is not unresolved custody. Only explicit init
        // may create a fresh tenure after every owner is confirmed disposed.
        this.workerRestartable = !this.workerCleanupUnconfirmed && this.client === undefined && this.playwrightClient === undefined && this.playwrightClosing === undefined && this.attempt === undefined && this.retiringAttempt === undefined && this.connecting === undefined;
        if (this.disposing === owned) this.disposing = undefined;
      };
      const deadline = cleanupDeadline(context);
      void this.closeWorker(deadline.context).finally(deadline.dispose).then(() => {
        disposed(); resolve();
      }, cause => {
        disposed(); reject(this.retirementFailure ?? cause);
      });
    }
    const owned = this.disposing;
    return withConnectionBudget(context, 'disposing native worker', () => owned);
  }
  private async closeClient(context: EngineCleanupContext, client = this.client): Promise<void> {
    // Worker disposal may reach here while attempt startup/retirement still owns
    // a late PW allocation. Capture its receipt before any await or owner clear.
    const rawOpening = (this.attempt ?? this.retiringAttempt)?.rawOpening;
    try {
      await client?.close(this.operation(context.signal, context.timeoutMs));
      if (rawOpening !== undefined) await rawOpening.catch(() => undefined);
      if (this.client === client) {
        const raw = this.playwrightClient;
        if (raw !== undefined) {
          // NativeClient.close deduplicates its receipt; share PW's receipt too.
          // Caller departure may not abandon this exact disconnect or permit init.
          const closing = this.playwrightClosing ??= raw.close();
          await closing;
          if (this.playwrightClient === raw) this.playwrightClient = undefined;
          if (this.playwrightClosing === closing) this.playwrightClosing = undefined;
        }
        if (this.client === client) { this.client = undefined; this.engine = undefined; this.openedBefore = false; }
      }
    }
    catch (cause) { this.workerCleanupUnconfirmed = true; throw cause; }
  }
  private async closeWorker(cleanup: EngineCleanupContext): Promise<void> {
    let failure: unknown;
    const receipt = <T>(work: Promise<T>): Promise<T> => {
      void work.catch(cause => { failure ??= cause; this.retirementFailure ??= cause; });
      return work;
    };
    const attempt = receipt(this.retireAttempt(cleanup));
    try { await raceAbort(() => attempt, cleanup.signal, 'waiting for native attempt cleanup'); }
    catch (cause) { if (!cleanup.signal.aborted) failure ??= cause; }
    // A hanging retained recorder/artifact owner must not keep a billed worker alive.
    const closing = receipt(this.closeClient(cleanup));
    try { await raceAbort(() => closing, cleanup.signal, 'waiting for native worker close'); }
    catch (cause) { if (!cleanup.signal.aborted) failure ??= cause; }
    const releasing = receipt((this.leases?.dispose(cleanup) ?? Promise.resolve()).catch(cause => { this.workerCleanupUnconfirmed = true; throw cause; }));
    for (const work of [attempt, closing, releasing]) {
      try { await work; } catch (cause) { failure ??= cause; this.retirementFailure ??= cause; }
    }
    if (failure !== undefined) throw this.retirementFailure ?? failure;
  }

  private async connect(operation: OperationContext): Promise<void> {
    const info = this.initInfo;
    if (info === undefined || this.executable === undefined) throw invalidState('The native browser worker has not initialized');
    if (this.connecting !== undefined) throw invalidState('A native connection is already pending');
    const tenure = ++this.clientTenure;
    const attempt = this.attempt;
    const pending: PendingConnection = { work: Promise.resolve() };
    this.connecting = pending;
    pending.work = (async () => {
      const client = await connectNativeProcess({ executable: this.executable!, cwd: info.projectRoot, env: info.env, capabilities: REQUIRED_CAPABILITIES }, operation, event => tenure === this.clientTenure ? this.onEvent(event) : undefined);
      if (tenure !== this.clientTenure || operation.signal.aborted || (attempt !== undefined && this.attempt !== attempt)) {
        try { await client.close(this.operation(AbortSignal.timeout(1000), 1000)); }
        catch (cause) { pending.cleanupFailure = cause; throw cause; }
        throw new EngineError('CANCELLED', 'Native connection arrived after its owner retired', { retryable: false });
      }
      this.client = client;
      client.onOperationRetired(() => {
        // Retire only cached presentation. Routes, recordings, downloads, and the exact owner survive.
        if (this.client === client && this.attempt !== undefined) { delete this.attempt.observationHighWater; this.references.retire(); }
      });
      client.onFinalizedRecording((owner, download, endsAt) => {
        const ownerAttempt = this.attempt;
        if (this.client !== client || ownerAttempt === undefined || ownerAttempt.scope !== owner.identityScope || ownerAttempt.finalizedVideo !== undefined || ownerAttempt.retirement.signal.aborted) return;
        const files = new FinalizedVideoFiles({ artifactsDir: ownerAttempt.context.artifactsDir, allocatePart: () => ++ownerAttempt.videoCounter,
          owns: () => this.client === client && this.attempt === ownerAttempt && ownerAttempt.scope === owner.identityScope,
          retirement: ownerAttempt.retirement.signal });
        ownerAttempt.finalizedVideo = files;
        files.prepare(download, endsAt);
      });
      this.engine = new EngineChannel(client, scope => {
        const owner = this.attempt ?? this.retiringAttempt;
        return () => this.client === client && owner !== undefined && (this.attempt === owner || this.retiringAttempt === owner) && owner.scope === scope;
      });
    })().catch(cause => { if (isNativeProcessCleanupUnresolved(cause)) pending.cleanupFailure = cause; throw cause; }).finally(() => { if (this.connecting === pending && pending.cleanupFailure === undefined) this.connecting = undefined; });
    await pending.work;
  }
  private creationOptions(): ScopeCreationOptions {
    return { blockServiceWorkers: this.options.headers !== undefined, viewport: this.options.viewport === undefined ? { width: 1280, height: 720 } : this.options.viewport,
      ...(this.options.userAgent === undefined ? {} : { userAgent: this.options.userAgent }),
      ...(this.options.locale === undefined ? {} : { locale: this.options.locale }),
      ...(this.options.timezoneId === undefined ? {} : { timezoneId: this.options.timezoneId }),
      media: { ...(this.options.colorScheme === undefined ? {} : { colorScheme: this.options.colorScheme }), ...(this.options.reducedMotion === undefined ? {} : { reducedMotion: this.options.reducedMotion }) },
      initScripts: this.scripts.forAttempt(),
    };
  }
  private bindChannel(attempt: Attempt): void {
    attempt.channel?.dispose();
    // Event handles outlive body cancellation. Only this exact attempt's
    // retirement may cancel their release; a failed release still fails cleanup.
    attempt.channel = new BrowserChannel(this.requireClient(), { identityScope: () => { this.assertAttempt(attempt); return attempt.scope; }, operation: () => this.operation(attempt.retirement.signal) });
    for (const [name, callbacks] of this.listeners) for (const listener of callbacks) listener.unsubscribe = attempt.channel.subscribe(name, listener.callback);
  }
  private async onEvent(event: NativeEvent): Promise<void> {
    if (event.event === 'browser.disconnected') {
      const payload = event.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !('reason' in payload) || payload.reason !== 'browser-connection-closed' || event.decision !== undefined) throw this.invalidate();
      if (this.attempt !== undefined) this.attempt.recoveryPending = true;
      if (!this.persistent) { this.workerSourceLost = true; this.workerEndpoint = undefined; }
      return;
    }
    const attempt = this.attempt;
    if (attempt === undefined || attempt.channel === undefined) return;
    const latch = this.latch;
    const epoch = attempt.epoch;
    const notRevoked = this.requireClient().callbackRevocationGuard();
    const work = this.callbackOwner.run({ attempt, epoch, notRevoked }, () => this.dispatchEvent(attempt, event, latch));
    latch.track('native event', work);
    try { await work; } catch (cause) { if (notRevoked() && (this.attempt !== attempt || attempt.epoch === epoch)) latch.latch(cause instanceof Error ? cause : invalidState('Native event processing failed')); }
    finally { if (event.event === 'download.started' && event.payload !== null && typeof event.payload === 'object' && 'handle' in event.payload && typeof event.payload.handle === 'string') attempt.downloads.delete(event.payload.handle); }
  }

  private async dispatchEvent(attempt: Attempt, event: NativeEvent, latch: ErrorLatch): Promise<void> {
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw this.invalidate();
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload['identityScope'] !== 'string') throw this.invalidate();
    if (payload['identityScope'] !== attempt.scope) return;
    const operation = this.operation(attempt.context.signal, event.decision?.timeoutMs ?? LIFECYCLE_TIMEOUT_MS);
    if (event.event === 'scope.page-reopened') {
      const recovery = payload['recoveryIdentity'];
      const previous = attempt.recovery;
      if (!this.requireClient().negotiation().capabilities.includes(PERSISTENT_PAGE_REOPEN_CAPABILITY)
        || event.decision !== undefined || payload['version'] !== 1
        || Object.keys(payload).toSorted().join(',') !== 'identityScope,previousPageIdentity,recoveryIdentity,version'
        || recovery === null || typeof recovery !== 'object' || Array.isArray(recovery)
        || Object.keys(recovery).toSorted().join(',') !== 'browser,context,page'
        || !('browser' in recovery) || !('context' in recovery) || !('page' in recovery)
        || previous === undefined || recovery.browser !== previous.browser || recovery.context !== previous.context
        || payload['previousPageIdentity'] !== previous.page || typeof recovery.page !== 'string'
        || recovery.page.length === 0 || recovery.page.length > 256 || Array.from(recovery.page).some(character => {
          const code = character.codePointAt(0);
          return code !== undefined && (code <= 0x1f || code === 0x7f);
        })
        || recovery.page === previous.page) throw this.invalidate();
      // The scope/generation-fenced event precedes the caller's result. Keep
      // the same attempt, routes and media; only old page evidence retires.
      if (attempt.epoch === Number.MAX_SAFE_INTEGER) throw this.invalidate();
      attempt.recovery = { browser: previous.browser, context: previous.context, page: recovery.page };
      attempt.epoch += 1;
      attempt.recoveryObservationRequired = true;
      delete attempt.observationHighWater;
      return;
    }
    if (event.event === 'scope.disconnected') {
      if (payload['reason'] !== 'browser-connection-closed') throw this.invalidate();
      attempt.recoveryPending = true;
      if (!this.persistent) { this.workerSourceLost = true; this.workerEndpoint = undefined; }
      return;
    }
    if (event.event === 'network.auth') {
      if (event.decision === undefined || payload['source'] !== 'Server' || typeof payload['origin'] !== 'string' || typeof payload['scheme'] !== 'string' || typeof payload['realm'] !== 'string') throw this.invalidate();
      await this.requireClient().decide(event.decision.token, attempt.credentials === undefined ? { kind: 'cancel-auth' } : { kind: 'auth', username: attempt.credentials.username, password: attempt.credentials.password }, operation);
      return;
    }
    if (event.event === 'network.request' && (this.listeners.get('network.request')?.size ?? 0) === 0) {
      if (event.decision === undefined) throw this.invalidate();
      let request: BrowserEventMap['network.request'];
      try { request = decodeBrowserEvent('network.request', { ...payload, token: event.decision.token, timeoutMs: event.decision.timeoutMs }); } catch { throw this.invalidate(); }
      if (request.version !== this.registryCurrent || request.registrationIds.length !== 0) throw this.invalidate();
      const headers = this.siteHeaders(request.request.url);
      await attempt.channel!.decide(request.token, { kind: 'continue', overrides: headers === undefined ? {} : { headers: Object.entries({ ...lowercaseNames(request.request.headers), ...headers }).map(([name, value]) => ({ name, value })) } }, operation);
      return;
    }
    if (event.event === 'dialog.opened' && (this.listeners.get('dialog.opened')?.size ?? 0) === 0) {
      if (event.decision === undefined) throw this.invalidate();
      await attempt.channel!.decide(event.decision.token, { kind: 'dialog', accept: false }, operation);
      if (this.attempt !== attempt || this.callbackIsCurrent()) latch.latch(invalidState('An application dialog had no registered handler')); return;
    }
    if (event.event === 'app.log') {
      const source = payload['source']; const level = payload['level']; const text = payload['text'];
      if ((source !== 'console' && source !== 'error' && source !== 'network' && source !== 'system') || (level !== 'error' && level !== 'warning' && level !== 'info') || typeof text !== 'string') throw this.invalidate();
      attempt.context.appLog({ source, level, text }); return;
    }
    if (event.event === 'app.navigation') {
      const kind = payload['kind']; const url = payload['url']; const frameName = payload['frameName'];
      if ((kind !== 'main' && kind !== 'popup' && kind !== 'popup-navigation' && kind !== 'frame') || typeof url !== 'string' || (frameName !== undefined && typeof frameName !== 'string')) throw this.invalidate();
      if (kind === 'main') this.references.retire();
      if (kind === 'popup') attempt.context.navigation(`the app opened a new tab${url === 'about:blank' ? '' : ` at ${url}`}; the test stays on its page`);
      else if (kind === 'popup-navigation') { if (url !== 'about:blank' && url !== 'about:srcdoc' && !url.startsWith('data:')) attempt.context.navigation(`the new tab navigated to ${url}`); }
      else if (url !== 'about:blank' && url !== 'about:srcdoc' && !url.startsWith('data:') && payload['initiatedByOperation'] !== true) attempt.context.navigation(kind === 'frame' ? `frame${frameName ? ` "${frameName}"` : ''} loaded ${url}` : `navigated to ${url}`);
      return;
    }
    await attempt.channel!.dispatch(event);
  }

  private async resolveEndpoint(resolve: (signal: AbortSignal) => string | Promise<string>, signal: AbortSignal, source: string): Promise<string> {
    let endpoint: string;
    try { endpoint = await raceAbort(async () => resolve(signal), signal, 'resolving browser endpoint'); }
    catch (cause) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Browser endpoint resolution was cancelled', { retryable: false });
      if (isClassified(cause)) throw cause;
      throw new EngineError('ENGINE_FAILURE', `${source} could not resolve a browser endpoint`, { retryable: false });
    }
    if (signal.aborted) throw new EngineError('CANCELLED', 'Browser endpoint resolution was cancelled', { retryable: false });
    if (typeof endpoint !== 'string' || endpoint.trim() === '') throw new EngineError('ENGINE_FAILURE', `${source} resolved to an empty CDP endpoint`, { retryable: false });
    return endpoint;
  }

  /** Capture the caller's attempt before yielding; a later attempt is never a retry target. */
  private async admit(operation: OperationContext, startupAttempt?: Attempt): Promise<{ attempt: Attempt; scope: string; operation: OperationContext }> {
    this.assertCallback();
    const attempt = startupAttempt ?? this.requireAttempt();
    this.assertAttempt(attempt);
    this.latch.throwPending();
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native operation was cancelled', { retryable: false });
    const endsAt = performance.now() + operation.timeoutMs;
    await this.ensureConnected(operation, attempt);
    this.assertAttempt(attempt);
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native operation was cancelled', { retryable: false });
    const timeoutMs = endsAt - performance.now();
    if (timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native browser recovery exhausted the operation budget', { retryable: false });
    const current = { ...operation, get timeoutMs() {
      const remaining = endsAt - performance.now();
      if (remaining <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native operation exhausted its deadline before dispatch', { retryable: false });
      return remaining;
    } };
    return { attempt, scope: attempt.scope, operation: current };
  }

  private async ensureConnected(operation: OperationContext, attempt: Attempt): Promise<void> {
    this.assertAttempt(attempt);
    if (attempt.recoveryFailure !== undefined) throw attempt.recoveryFailure.error;
    if (attempt.rawBinding !== undefined && disconnectedBindingMode(attempt.rawBinding) === 'isolated-context-lost') throw invalidState('The isolated context was destroyed with its Playwright connection; a fresh attempt is required');
    if (this.requireClient().recoveryScope() === attempt.scope) attempt.recoveryPending = true;
    if (!attempt.recoveryPending) return;
    if (attempt.reconnect === undefined || attempt.recovery === undefined) throw invalidState('The native browser disconnected and has no persistent recovery contract');
    const recovering = attempt.recovering;
    if (recovering !== undefined) {
      // A waiter owns only its wait; its cancellation cannot fail the shared owner.
      await withConnectionBudget(operation, 'native browser recovery', () => recovering);
      return;
    }
    attempt.recoveryObservationRequired = true;
    // Share the owner's classified deadline/cancellation, not an inner aborted resolver.
    attempt.recovering = withConnectionBudget(operation, 'native browser recovery', async remaining => {
      const endpoint = await this.resolveEndpoint(attempt.reconnect!, remaining().signal, 'connect.reconnectEndpoint');
      this.assertAttempt(attempt);
      const identity = attempt.recovery!;
      const client = this.requireClient(); const callbackEpoch = client.reconnectCheckpoint(attempt.scope);
      const result = await this.requireEngine().command('scope.reconnect', { identityScope: attempt.scope, endpoint, expectedBrowserIdentity: identity.browser, expectedContextIdentity: identity.context, expectedPageIdentity: identity.page }, { ...operation, ...remaining() }, callbackEpoch);
      this.assertAttempt(attempt); remaining();
      client.retireCallbacks(callbackEpoch, 'scope-reconnected'); attempt.epoch += 1; attempt.scope = result.identityScope; attempt.recoveryPending = false; this.bindChannel(attempt);
    }).catch((error: unknown) => {
      // Only this captured owner may record failure. Callback errors remain one-shot.
      attempt.recoveryFailure ??= { error };
      throw attempt.recoveryFailure.error;
    }).finally(() => { attempt.recovering = undefined; });
    await attempt.recovering;
  }

  async command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], operation: OperationContext): Promise<BrowserCommandMap[K]['result']> {
    const attempt = this.requireAttempt();
    if (name === 'download.unsubscribe') {
      // Terminal cleanup must not recover or create a replacement business scope.
      // Keep callback checks, the original budget, and wire-request retirement,
      // but dispatch only through the captured channel under its owning attempt.
      this.assertCallback(); this.latch.throwPending();
      const channel = attempt.channel;
      if (channel === undefined) throw invalidState('The native browser scope is not ready');
      const result = await withinAttemptRequest({ ...operation, signal: attempt.retirement.signal }, attempt,
        current => channel.command(name, args, current));
      this.assertAttempt(attempt);
      return result;
    }
    const correlationOwner = name === 'fixture.correlate' ? this.referenceOwner() : undefined;
    const correlation = correlationOwner === undefined ? undefined : this.references.correlation(correlationOwner, args);
    if (correlation !== undefined) args = correlation.args as BrowserCommandMap[K]['args'];
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    this.assertAttempt(attempt);
    if (attempt.channel === undefined) throw invalidState('The native browser scope is not ready');
    if (correlationOwner !== undefined && !correlationOwner.owns()) throw new EngineError('NODE_STALE', 'The correlation reference owner has retired', { retryable: true });
    if (name === 'download.read') {
      const read = args as BrowserCommandMap['download.read']['args'];
      const bytes = await this.providerDownload(attempt, read.handle, operation);
      if (bytes !== undefined) {
        if (!Number.isSafeInteger(read.offset) || read.offset < 0 || read.offset > bytes.length || !Number.isSafeInteger(read.maxBytes) || read.maxBytes <= 0) throw invalidState('Invalid provider download read bounds');
        const chunk = bytes.subarray(read.offset, read.offset + read.maxBytes);
        return decodeBrowserResult(name, { base64: Buffer.from(chunk).toString('base64'), nextOffset: read.offset + chunk.length, eof: read.offset + chunk.length === bytes.length });
      }
    }
    const client = this.requireClient(); const publication = client.publicationCheckpoint();
    const channel = attempt.channel; const pageEpoch = attempt.epoch;
    const result = await withinAttemptRequest(operation, attempt, current => channel.command(name, args, current));
    this.assertAttempt(attempt);
    if ((name.startsWith('page.') && name !== 'page.navigate' || name.startsWith('input.') || name === 'fixture.correlate') && attempt.epoch !== pageEpoch) throw new EngineError('NODE_STALE', 'The application page changed during the operation', { retryable: true });
    if (name === 'fixture.correlate') {
      this.assertPublication(client, publication);
      const correlated = result as BrowserCommandMap['fixture.correlate']['result'];
      return { ...correlated, matches: correlation!.project(correlated.matches) } as BrowserCommandMap[K]['result'];
    }
    if (name === 'page.navigate' || name === 'page.reload' || name === 'page.back' || name === 'page.forward') { attempt.pageReady = true; this.tellEnvironment(attempt); }
    if (attempt.rawBinding !== undefined && name === 'context.viewport') await attempt.rawBinding.page.setViewportSize(args as BrowserCommandMap['context.viewport']['args']);
    if (attempt.rawBinding !== undefined && name === 'context.media') {
      attempt.rawMedia = { ...attempt.rawMedia, ...args as BrowserCommandMap['context.media']['args'] };
      await attempt.rawBinding.page.emulateMedia(attempt.rawMedia);
    }
    if (name === 'network.routes.replace') this.registryCurrent = (args as BrowserCommandMap['network.routes.replace']['args']).version;
    return result;
  }
  private providerDownload(attempt: Attempt, handle: string, operation: OperationContext): Promise<Uint8Array | undefined> {
    let reading = attempt.downloads.get(handle);
    if (reading !== undefined) return reading;
    const scope = attempt.scope;
    reading = withConnectionBudget(operation, 'provider download', async remaining => {
      const metadata = await attempt.channel!.command('download.metadata', { handle }, { ...operation, ...remaining() });
      if (metadata.identityScope !== scope) throw this.invalidate();
      if (metadata.source === 'local') return undefined;
      const downloads = this.leases?.downloads();
      if (downloads === undefined) throw invalidState('Native download requires a configured provider reader');
      // win32.isAbsolute also accepts POSIX roots, so require an explicit Windows root.
      const windowsPath = downloads.dir.startsWith('\\')
        || /^[A-Za-z]:[\\/]/.test(downloads.dir)
        || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(downloads.dir);
      const paths = windowsPath ? path.win32 : path.posix;
      const file = paths.join(downloads.dir, metadata.basename);
      const bytes = await downloads.read(file, remaining().signal);
      this.assertAttempt(attempt);
      if (attempt.scope !== scope) throw invalidState('The provider download belongs to a retired scope');
      if (!(bytes instanceof Uint8Array)) throw invalidState('The provider download reader returned invalid bytes');
      return bytes;
    });
    attempt.downloads.set(handle, reading); return reading;
  }
  subscribe<K extends keyof BrowserEventMap>(name: K, callback: (event: BrowserEventMap[K]) => void | Promise<void>): () => void {
    const attempt = this.requireAttempt();
    let listeners = this.listeners.get(name);
    if (listeners === undefined) { listeners = new Set(); this.listeners.set(name, listeners); }
    const listener: Listener = { callback: callback as Listener['callback'] }; listeners.add(listener);
    listener.unsubscribe = attempt.channel?.subscribe(name, callback);
    return () => { listeners.delete(listener); listener.unsubscribe?.(); };
  }
  decide(token: string, decision: BrowserDecision, operation: OperationContext): Promise<void> {
    const channel = this.requireAttempt().channel;
    if (channel === undefined) throw invalidState('The native browser scope is not ready');
    return channel.decide(token, decision, operation);
  }
  projectPath(file: string): string { if (this.initInfo === undefined) throw invalidState('The Web worker is not initialized'); return path.resolve(this.initInfo.projectRoot, file); }
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined { return siteHeadersFor(url, this.app.site, this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers)); }
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    const attempt = this.requireAttempt();
    const relative = path.posix.join(folder, `${String(++attempt.counter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}${extension}`);
    const absolute = path.join(attempt.context.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true }); return { relative, absolute };
  }

  private async engineCommand<K extends keyof EngineCommandMap>(name: K, args: EngineCommandMap[K]['args'], operation: OperationContext): Promise<EngineCommandMap[K]['result']> {
    const attempt = this.requireAttempt(); const scope = attempt.scope; const pageEpoch = attempt.epoch;
    const engine = this.requireEngine();
    const result = await withinAttemptRequest(operation, attempt, current => engine.command(name, args, current));
    this.assertAttempt(attempt);
    if (scope !== attempt.scope) throw invalidState('The browser scope changed during an operation');
    if ((name.startsWith('browser.') || name.startsWith('fixture.') || name === 'capture.screenshot' || name === 'state.capture') && attempt.epoch !== pageEpoch) throw new EngineError('CANCELLED', 'The native page result owner has retired', { retryable: false });
    return result;
  }
  async observe(operation: OperationContext, options: EngineObserveOptions = {}): Promise<EngineSnapshot> {
    const optionalPixels = options.pixels === true;
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt(); const scope = attempt.scope; const engine = this.requireEngine();
    const epoch = attempt.epoch; const client = this.requireClient(); const publication = client.publicationCheckpoint();
    const snapshot = await this.engineCommand('browser.observe', { identityScope: scope, options, testIdAttribute: this.options.testIdAttribute ?? 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR }, operation);
    this.assertObservationOwner(attempt, scope, epoch, client);
    const revision = observationRevision(snapshot.revision);
    if (snapshot.identityScope !== scope || (snapshot.pixels !== undefined && snapshot.pixels.identityScope !== scope) || revision === undefined) throw client.invalidate();
    // Native publication, not local admission or transfer completion, advances this scalar.
    let highWater = attempt.observationHighWater;
    if (publication === client.publicationCheckpoint()) {
      if (highWater === undefined || highWater.epoch !== epoch || highWater.scope !== scope || highWater.client !== client) {
        highWater = { epoch, scope, client, revision }; attempt.observationHighWater = highWater;
      } else if (revision > highWater.revision) highWater.revision = revision;
    }
    const owns = () => this.attempt === attempt && this.client === client && attempt.scope === scope && attempt.epoch === epoch;
    const data = snapshot.pixels === undefined ? undefined
      : optionalPixels && snapshot.treeUnavailable !== true
        ? await this.optionalObservationPixels(snapshot.pixels, scope, operation, attempt, engine, owns)
        : await engine.readBlob(snapshot.pixels, scope, operation, owns);
    const pixels = data === undefined || snapshot.pixels === undefined ? undefined : { data, mediaType: snapshot.pixels.mediaType, width: snapshot.pixels.width, height: snapshot.pixels.height, scale: snapshot.pixels.scale };
    this.assertScope(attempt, scope); this.assertBudget(operation);
    this.assertObservationOwner(attempt, scope, epoch, client);
    this.assertPublication(client, publication);
    // Recovery and operation retirement never bypass exact blob cleanup.
    if (attempt.recoveryPending) throw new EngineError('NODE_STALE', 'observation capture was retired by browser recovery', { retryable: true });
    if (highWater !== undefined && revision < highWater.revision) throw new EngineError('NODE_STALE', 'observation capture was superseded', { retryable: true });
    if (snapshot.treeUnavailable === true) this.references.retire();
    const aliases = this.references.capture(this.referenceOwner(), [snapshot.root], snapshot.viewportRef, snapshot.treeUnavailable === true ? 'pixels' : 'observe');
    // Only this complete public return grants point input, never a partial capture.
    attempt.recoveryObservationRequired = false;
    return { identityScope: scope, root: aliases.nodes[0]!, viewport: snapshot.viewport,
      ...(aliases.viewport === undefined ? {} : { viewportRef: aliases.viewport }),
      ...(snapshot.location === undefined ? {} : { location: snapshot.location }),
      ...(snapshot.truncated === undefined ? {} : { truncated: snapshot.truncated }),
      ...(snapshot.treeUnavailable === true ? { treeUnavailable: true as const } : {}),
      ...(snapshot.maskedRegionCount === undefined || (snapshot.pixels !== undefined && pixels === undefined) ? {} : { maskedRegionCount: snapshot.maskedRegionCount }),
      ...(pixels === undefined ? {} : { pixels }),
    };
  }
  /** Optional bytes cannot make an already validated semantic receipt wait for transfer cleanup. */
  private async optionalObservationPixels(image: NativeImage, scope: string, operation: OperationContext, attempt: Attempt, engine: EngineChannel, owns: () => boolean): Promise<Buffer | undefined> {
    const remaining = operation.timeoutMs;
    // One timer tick for the synchronous publication checks, not a new capture budget.
    const timeoutMs = remaining - Math.min(1, remaining / 5);
    const cutoff = new AbortController();
    const latch = this.latch;
    let delivered = false;
    const signal = AbortSignal.any([operation.signal, attempt.retirement.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completeRead!: (bytes: Buffer | undefined) => void;
    let rejectRead!: (cause: unknown) => void;
    const read = new Promise<Buffer | undefined>((resolve, reject) => { completeRead = resolve; rejectRead = reject; });
    const expired = new Promise<undefined>(resolve => {
      timer = setTimeout(() => { resolve(undefined); cutoff.abort(); }, timeoutMs);
    });
    // Registration covers readBlob's finally too. Retirement joins this exact
    // old transfer even when optional acceptance has already closed.
    const transfer = withinAttemptRequest({ ...operation, signal: AbortSignal.any([signal, cutoff.signal]), timeoutMs }, attempt,
      current => engine.readBlob(image, scope, current, owns, {
        complete: completeRead,
        fail: cause => {
          // Neither validated bytes nor a read failure waits for readonly cleanup.
          if (isUnavailableBlobRead(cause)) completeRead(undefined); else rejectRead(cause);
        },
      })).catch((cause: unknown) => {
      if (isUnavailableBlobRead(cause)) return undefined;
      if (delivered && owns() && !(cause instanceof EngineError && (cause.code === 'CANCELLED' || cause.code === 'OPERATION_TIMEOUT'))) {
        latch.latch(cause instanceof Error ? cause : invalidState('Late optional pixel transfer failed'));
      }
      throw cause;
    });
    try {
      const bytes = await raceAbort(() => Promise.race([read, transfer, expired]), signal, 'native optional pixel transfer');
      delivered = true;
      return bytes;
    }
    finally { clearTimeout(timer); cutoff.abort(); }
  }
  async locate(expression: LocatorExpression, operation: OperationContext, options?: EngineLocateOptions): Promise<readonly SemanticNode[]> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const scope = this.identityScope; const client = this.requireClient(); const publication = client.publicationCheckpoint(); const pageEpoch = admitted.attempt.epoch;
    const result = await this.engineCommand(options?.purpose === 'fixture' ? 'fixture.query' : 'browser.query', { identityScope: scope, expression, testIdAttribute: this.options.testIdAttribute ?? 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR }, operation);
    if (result.identityScope !== scope) throw this.invalidate();
    this.assertPublication(client, publication);
    this.assertObservationOwner(admitted.attempt, scope, pageEpoch, client);
    return this.references.capture(this.referenceOwner(), result.nodes, undefined, 'locate').nodes;
  }
  async readFields(expression: LocatorExpression, fields: readonly EngineReadField[], operation: OperationContext): Promise<readonly EngineFieldValues[]> {
    fields = Object.freeze([...fields]);
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const scope = admitted.scope; const client = this.requireClient(); const publication = client.publicationCheckpoint(); const pageEpoch = admitted.attempt.epoch;
    const result = await this.engineCommand('fixture.read-fields', { identityScope: scope, expression, fields, testIdAttribute: this.options.testIdAttribute ?? 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR }, operation);
    if (result.identityScope !== scope) throw this.invalidate();
    this.assertScope(admitted.attempt, scope);
    this.assertPublication(client, publication);
    this.assertObservationOwner(admitted.attempt, scope, pageEpoch, client);
    return result.values;
  }
  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    ({ ref, action } = this.references.action(this.referenceOwner(), ref, action));
    if (action.kind !== 'setInputFiles') { await this.engineCommand('browser.perform', { identityScope: this.identityScope, ref, action }, operation); await this.screenAfterAction(operation, admitted.attempt, admitted.scope); return; }
    const attempt = this.requireAttempt(); const scope = attempt.scope; const engine = this.requireEngine();
    const selection = await selectUploadFiles(action.paths.map(file => this.projectPath(file)), operation);
    this.assertScope(attempt, scope);
    const files: { name: string; mimeType: string; bodyHandle: string; relativePath?: string }[] = [];
    const stage = async (index: number, remaining: OperationContext): Promise<void> => {
      const file = selection.files[index];
      this.assertScope(attempt, scope);
      if (file === undefined) { await engine.command('browser.perform', { identityScope: scope, ref, action: { kind: 'setInputFiles', files, ...(selection.directoryName === undefined ? {} : { directoryName: selection.directoryName }) } }, remaining); this.assertScope(attempt, scope); return; }
      const bytes = await readUploadFile(file, remaining);
      this.assertScope(attempt, scope);
      await engine.withUpload(bytes, remaining, async (handle, budget) => {
        this.assertScope(attempt, scope);
        files.push({ name: file.name, mimeType: lookupMime(file.name) || 'application/octet-stream', bodyHandle: handle, ...(file.relativePath === undefined ? {} : { relativePath: file.relativePath }) });
        await stage(index + 1, budget);
      }, scope);
    };
    await stage(0, operation);
    await this.screenAfterAction(operation, attempt, scope);
  }
  async restart(operation: OperationContext): Promise<void> { await this.transition('scope.restart', operation); }
  async reset(operation: OperationContext): Promise<void> { if (this.persistent) throw invalidState('A persistent browser context cannot be replaced'); await this.transition('scope.reset', operation); }
  private async transition(name: 'scope.restart' | 'scope.reset', operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt();
    const client = this.requireClient(); const callbackEpoch = client.callbackCheckpoint();
    const result = await this.requireEngine().command(name, { identityScope: attempt.scope }, operation, callbackEpoch);
    this.assertAttempt(attempt); client.retireCallbacks(callbackEpoch); attempt.epoch += 1; attempt.scope = result.identityScope;
    if ('recoveryIdentity' in result) attempt.recovery = result.recoveryIdentity;
    this.bindChannel(attempt);
  }
  async captureState(operation: OperationContext): Promise<EngineState> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt(); const scope = attempt.scope; const engine = this.requireEngine();
    const pageEpoch = attempt.epoch; const client = this.requireClient();
    const state = await this.engineCommand('state.capture', { identityScope: scope }, operation);
    const bytes = await engine.readBlob(state, scope, operation, () => this.attempt === attempt && this.client === client && attempt.scope === scope && attempt.epoch === pageEpoch);
    this.assertObservationOwner(attempt, scope, pageEpoch, client); this.assertBudget(operation);
    let data: unknown;
    try { data = JSON.parse(bytes.toString('utf8')); validateJsonValue(data, 'native storage state'); } catch { throw this.invalidate(); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw this.invalidate();
    return { format: state.format, version: state.version, data };
  }
  async restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    if (this.persistent) throw invalidState('A persistent browser context cannot be replaced');
    if ((state.format !== 'agent-browser-storage-state' && state.format !== 'playwright-storage-state') || state.version !== 1 || state.data === null || typeof state.data !== 'object' || Array.isArray(state.data)) throw invalidState('Unsupported browser storage state envelope');
    validateJsonValue(state.data, 'browser storage state');
    const attempt = this.requireAttempt(); const scope = attempt.scope; const engine = this.requireEngine();
    const client = this.requireClient(); const callbackEpoch = client.callbackCheckpoint();
    await engine.withUpload(Buffer.from(JSON.stringify(state.data)), operation, async (bodyHandle, remaining) => {
      this.assertScope(attempt, scope);
      const result = await engine.command('state.restore', { identityScope: scope, format: state.format as 'agent-browser-storage-state' | 'playwright-storage-state', version: 1, bodyHandle }, remaining, callbackEpoch);
      this.assertAttempt(attempt); client.retireCallbacks(callbackEpoch); attempt.epoch += 1; attempt.scope = result.identityScope; this.bindChannel(attempt);
    }, scope, 'consume-on-success');
  }
  async startVideo(operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt(); const recorder = this.leases?.recorder(attempt.context.attemptId);
    await this.requireEngine().command('page.activate', { identityScope: admitted.scope }, operation);
    attempt.pageReady = true;
    if (recorder !== undefined) {
      this.assertScope(attempt, admitted.scope); this.assertBudget(operation);
      if (attempt.recording !== undefined) return;
      if (attempt.recordingStart === undefined) {
        if (attempt.recordingStarts.size + attempt.lateRecordings.size >= 64) throw invalidState('Too many provider recording starts remain unsettled');
        const latch = this.latch;
        const work = (async () => {
          const recording = await recorder(operation.signal);
          if (this.attempt !== attempt || operation.signal.aborted) {
            attempt.lateRecordings.add(recording);
            try {
              await this.stopLateProviderRecording(attempt, recording, attempt.cleanupSignal ?? AbortSignal.timeout(LATE_RECORDING_STOP_MS));
            } catch (cause) { attempt.lateRecordingFailure ??= cause; latch.latch(cause instanceof Error ? cause : invalidState('Late provider recording cleanup failed')); }
            throw new EngineError('CANCELLED', 'Browser recording started after its operation retired', { retryable: false });
          }
          attempt.recording = recording;
        })().finally(() => {
          attempt.recordingStarts.delete(work);
          if (attempt.recordingStart === work) { attempt.recordingStart = undefined; attempt.recordingStartSignal = undefined; }
        });
        attempt.recordingStarts.add(work); attempt.recordingStart = work; attempt.recordingStartSignal = operation.signal;
        void work.catch(() => undefined);
      }
      const work = attempt.recordingStart;
      try { await raceAbort(() => work, operation.signal, 'starting provider recording'); }
      finally { if (operation.signal.aborted && attempt.recordingStart === work && attempt.recordingStartSignal === operation.signal) { attempt.recordingStart = undefined; attempt.recordingStartSignal = undefined; } }
      return;
    }
    await this.engineCommand('recording.start', { identityScope: attempt.scope, ...this.options.screencast }, operation);
  }
  /** Retains one exact late stop, including after a cleanup waiter times out. */
  private stopLateProviderRecording(attempt: Attempt, recording: LeaseRecording, signal: AbortSignal): Promise<void> {
    const pending = attempt.lateRecordingStops.get(recording);
    if (pending !== undefined) return pending;
    const work = stopProviderRecording(recording.recording, { artifactsDir: attempt.context.artifactsDir, provider: recording.provider, leaseId: recording.leaseId, signal }).then(() => {
      attempt.lateRecordings.delete(recording);
    }, cause => {
      attempt.lateRecordingFailure ??= cause;
      attempt.observeLateRecordingFailure?.(cause);
      throw cause;
    }).finally(() => { attempt.lateRecordingStops.delete(recording); });
    attempt.lateRecordingStops.set(recording, work);
    return work;
  }
  private stopProviderVideo(attempt: Attempt, signal: AbortSignal): Promise<readonly VideoSegment[]> {
    const record = attempt.recording;
    if (record === undefined) return Promise.resolve([]);
    attempt.recordingStop ??= stopProviderRecording(record.recording, { artifactsDir: attempt.context.artifactsDir, provider: record.provider, leaseId: record.leaseId, signal }).then(segment => {
      if (attempt.recording === record) attempt.recording = undefined;
      return [segment];
    }).finally(() => { attempt.recordingStop = undefined; });
    return attempt.recordingStop;
  }
  async stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    // This attempt's frozen result is not an ordinary browser admission. In
    // particular it cannot trigger recovery, stop a recorder, or reopen input.
    if (this.attempt?.finalizedVideo !== undefined) {
      this.assertCallback(); const attempt = this.requireAttempt(); this.assertAttempt(attempt); this.latch.throwPending(); this.assertBudget(operation);
      return attempt.finalizedVideo!.claim(operation);
    }
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt();
    if (attempt.finalizedVideo !== undefined) return attempt.finalizedVideo.claim(operation);
    if (attempt.recordingStart !== undefined) await raceAbort(() => attempt.recordingStart!, operation.signal, 'starting provider video');
    if (this.leases?.recorder(attempt.context.attemptId) !== undefined) return raceAbort(() => this.stopProviderVideo(attempt, operation.signal), operation.signal, 'stopping provider recording');
    const scope = attempt.scope; const engine = this.requireEngine();
    const result = await this.engineCommand('recording.stop', { identityScope: attempt.scope }, operation);
    if (result.identityScope !== attempt.scope) throw this.invalidate();
    if ('missingSegment' in result) {
      const filename = result.missingSegment === 1 ? 'video.webm' : `video-part${result.missingSegment}.webm`;
      throw new EngineError('ENGINE_FAILURE', `screencast stop failed: video/${filename} was not produced`, { retryable: false });
    }
    const segments: VideoSegment[] = [];
    const channel = attempt.channel!;
    let next = 0;
    try {
      for (; next < result.segments.length; next++) {
        const segment = result.segments[next]!;
        const bytes = await engine.readBlob(segment, scope, operation);
        this.assertScope(attempt, scope); this.assertBudget(operation);
        const part = ++attempt.videoCounter;
        const relative = `video/${part === 1 ? 'video' : `video-part${part}`}.webm`;
        const target = { relative, absolute: path.join(attempt.context.artifactsDir, relative) };
        mkdirSync(path.dirname(target.absolute), { recursive: true });
        await writeFile(target.absolute, bytes, { flag: 'wx' }); this.assertScope(attempt, scope); this.assertBudget(operation); segments.push({ path: target.relative, startedAt: segment.startedAt });
      }
    } catch (cause) {
      // readBlob owns the segment it started. Untouched output handles still
      // belong to this collector unless lifecycle retirement already revoked them.
      if (this.attempt === attempt && attempt.scope === scope) {
        for (const segment of result.segments.slice(next + 1)) {
          try { await channel.command('blob.release', { handle: segment.handle }, this.operation(AbortSignal.timeout(1000), 1000, attempt.context.attemptId)); }
          catch { if (this.attempt === attempt && attempt.scope === scope) channel.invalidate(); }
        }
      }
      throw cause;
    }
    return segments;
  }
  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    if (admitted.attempt.recoveryPending || admitted.attempt.recoveryObservationRequired) throw new EngineError('NODE_STALE', 'observe the screen again after CDP recovery before acting', { retryable: true });
    await this.engineCommand('browser.pointer', { identityScope: admitted.scope, point, action }, operation);
    await this.screenAfterAction(operation, admitted.attempt, admitted.scope);
  }
  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const epoch = admitted.attempt.epoch;
    try { await this.engineCommand('browser.keyboard.type', { identityScope: admitted.scope, text, replace: options.replace }, operation); }
    catch (cause) {
      if (isNativeNotDispatched(cause)) this.assertAttempt(admitted.attempt);
      if (!operation.signal.aborted && isNativeNotDispatched(cause) && this.attempt === admitted.attempt
        && (admitted.attempt.scope !== admitted.scope || admitted.attempt.epoch !== epoch)) {
        throw new EngineError('NODE_STALE', 'The focused document was replaced before typing dispatched', { retryable: true });
      }
      throw cause;
    }
    await this.screenAfterAction(operation, admitted.attempt, admitted.scope);
  }
  async pressKey(key: string, operation: OperationContext): Promise<void> { const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation; await this.engineCommand('browser.keyboard.press', { identityScope: this.identityScope, key }, operation); await this.screenAfterAction(operation, admitted.attempt, admitted.scope); }
  async open(url: string, operation: OperationContext): Promise<void> { const attempt = this.requireAttempt(); const scope = attempt.scope; await this.command('page.navigate', { url, waitUntil: 'load' }, operation); await this.screenAfterAction(operation, attempt, scope); }
  async back(operation: OperationContext): Promise<void> { const attempt = this.requireAttempt(); const scope = attempt.scope; await this.command('page.back', {}, operation); await this.screenAfterAction(operation, attempt, scope); }
  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const admitted = await this.admit(operation); this.assertScope(admitted.attempt, admitted.scope); operation = admitted.operation;
    const attempt = this.requireAttempt(); const scope = attempt.scope; const engine = this.requireEngine();
    const client = this.requireClient(); const publication = client.publicationCheckpoint(); const pageEpoch = attempt.epoch;
    const image = await this.engineCommand('capture.screenshot', { identityScope: scope, secureFieldSelector: SECURE_FIELD_SELECTOR }, operation);
    const bytes = await engine.readBlob(image, scope, operation, () => this.attempt === attempt && this.client === client && attempt.scope === scope && attempt.epoch === pageEpoch);
    this.assertScope(attempt, scope); this.assertBudget(operation);
    this.assertPublication(client, publication);
    this.assertObservationOwner(attempt, scope, pageEpoch, client);
    const target = this.artifactPath('screenshots', label, '.png');
    await writeFile(target.absolute, bytes, { flag: 'wx' }); this.assertScope(attempt, scope); this.assertBudget(operation); this.assertPublication(client, publication); this.assertObservationOwner(attempt, scope, pageEpoch, client); return target.relative;
  }

  private tellEnvironment(attempt: Attempt): void {
    if (attempt.environmentTold) return;
    attempt.environmentTold = true;
    const operation = this.operation(AbortSignal.any([attempt.context.signal, AbortSignal.timeout(1000)]), 1000);
    void this.engineCommand('session.environment', { identityScope: attempt.scope }, operation).then(facts => {
      if (this.attempt !== attempt || facts.identityScope !== attempt.scope) return;
      // Normalize only known native product labels at the report display boundary.
      const product = /^(?:Chrome|HeadlessChrome|Chromium)\/(\d+(?:\.\d+)+)$/.exec(facts.browser);
      const browser = product?.[0] === facts.browser ? `chromium ${product[1]}` : facts.browser;
      attempt.context.environment({ browser, ...(facts.userAgent === undefined ? {} : { 'user agent': facts.userAgent }) });
    }).catch(() => undefined);
  }
  private async screenAfterAction(operation: OperationContext, attempt: Attempt, scope: string): Promise<void> {
    if (this.attempt !== attempt || attempt.scope !== scope) return;
    if (attempt.context.screen === undefined || operation.signal.aborted || this.latch.hasPending()) return;
    if (attempt.recoveryPending) return;
    const epoch = attempt.epoch; const client = this.requireClient(); const publication = client.publicationCheckpoint();
    const highWater = attempt.observationHighWater; const revision = highWater?.revision;
    const engine = this.requireEngine();
    const endsAt = performance.now() + 1000;
    const trace = { ...operation, signal: AbortSignal.any([operation.signal, AbortSignal.timeout(1000)]), get timeoutMs() { return endsAt - performance.now(); } };
    try {
      // Automatic trace retains the original bounded semantic-read contract.
      // Native stages a live tree in a disposable map, without Observe admission
      // or publication of action/viewport refs. Explicit pixels use screenshot().
      const snapshot = await engine.command('browser.trace', { identityScope: scope,
        testIdAttribute: this.options.testIdAttribute ?? 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, options: {} }, trace);
      this.assertBudget(trace); this.assertObservationOwner(attempt, scope, epoch, client); this.assertPublication(client, publication);
      if (snapshot.identityScope !== scope || attempt.recoveryPending || this.latch.hasPending()
        || attempt.observationHighWater !== highWater || highWater?.revision !== revision) return;
      const aliases = this.references.trace([snapshot.root], snapshot.viewportRef);
      attempt.context.screen({ identityScope: scope, root: aliases.nodes[0]!,
        ...(aliases.viewport === undefined ? {} : { viewportRef: aliases.viewport }),
        viewport: snapshot.viewport,
        ...(snapshot.location === undefined ? {} : { location: snapshot.location }),
        ...(snapshot.truncated === undefined ? {} : { truncated: snapshot.truncated }) });
    } catch { /* Optional live trace never consumes callback failures or fails the action. */ }
  }

  /** A textual scope alone cannot revive evidence after reconnect or page replacement. */
  private referenceOwner(): ReferenceOwner {
    const attempt = this.requireAttempt(); const client = this.requireClient();
    const scope = attempt.scope; const epoch = attempt.epoch; const publication = client.publicationCheckpoint();
    return { attempt, client, scope, epoch, publication,
      owns: () => this.attempt === attempt && this.client === client && attempt.scope === scope
        && attempt.epoch === epoch && client.publicationCheckpoint() === publication
        && !attempt.retirement.signal.aborted && !attempt.recoveryPending };
  }

  private callbackIsCurrent(): boolean { const owner = this.callbackOwner.getStore(); return owner === undefined || (owner.notRevoked() && this.attempt === owner.attempt && owner.attempt.epoch === owner.epoch); }
  private assertCallback(): void { if (!this.callbackIsCurrent()) throw new EngineError('CANCELLED', 'The browser callback belongs to a retired transition', { retryable: false }); }
  private assertBudget(operation: OperationContext): void {
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Native artifact publication was cancelled', { retryable: false });
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Native artifact publication exceeded its deadline', { retryable: false });
  }
  private operation(signal: AbortSignal, timeoutMs = LIFECYCLE_TIMEOUT_MS, attemptId = this.attempt?.context.attemptId ?? ''): OperationContext {
    return { signal, timeoutMs, runId: this.initInfo?.runId ?? '', attemptId, origin: 'test' };
  }
  requireContext(): BrowserContext { const binding = this.requireAttempt().rawBinding; if (binding === undefined) throw invalidState('No live Playwright context exists'); return binding.context; }
  requirePage(): Page { const attempt = this.requireAttempt(); if (!attempt.pageReady || attempt.rawBinding === undefined) throw invalidState('No page is ready before app.open(), browser.goto(), or recording activation'); return attempt.rawBinding.page; }
  private requireAttempt(): Attempt { if (this.attempt === undefined || !this.attempt.ready || this.attempt.scope === '') throw invalidState('No native browser attempt is ready'); return this.attempt; }
  private assertScope(attempt: Attempt, scope: string): void { this.assertAttempt(attempt); if (attempt.scope !== scope) throw new EngineError('CANCELLED', 'The native browser scope has retired', { retryable: false }); }
  /** A reused scope string cannot restore a retired observation's publication owner. */
  private assertObservationOwner(attempt: Attempt, scope: string, epoch: number, client: NativeClient): void {
    this.assertScope(attempt, scope);
    if (attempt.epoch !== epoch || this.client !== client) throw new EngineError('CANCELLED', 'The native observation owner has retired', { retryable: false });
  }
  /** Old captures remain historical only; matching scope identity never renews their refs. */
  private assertPublication(client: NativeClient, checkpoint: number): void {
    if (client.publicationCheckpoint() !== checkpoint) throw new EngineError('NODE_STALE', 'Native reference publication was retired by an uncertain operation', { retryable: true });
  }
  private assertAttempt(attempt: Attempt): void { if (this.attempt !== attempt) throw new EngineError('CANCELLED', 'The native browser attempt has retired', { retryable: false }); }
  private requireClient(): NativeClient { if (this.client === undefined) throw invalidState('The native browser client is not running'); return this.client; }
  private requireEngine(): EngineChannel { if (this.engine === undefined) throw invalidState('The native browser client is not running'); return this.engine; }
}
/** Bound canonical positive u64 ordering evidence before converting it without precision loss. */
function observationRevision(value: string): bigint | undefined {
  if (value.length === 0 || value.length > 20 || value[0] === '0' || /[^0-9]/.test(value)) return undefined;
  const revision = BigInt(value);
  return revision <= 18_446_744_073_709_551_615n ? revision : undefined;
}
function invalidState(message: string): EngineError { return new EngineError('INVALID_STATE', message, { retryable: false }); }

/** Ordinary requests retire with their captured attempt, never mandatory cleanup. */
async function withinAttemptRequest<T>(operation: OperationContext, attempt: Attempt, work: (operation: OperationContext) => Promise<T>): Promise<T> {
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  // Register before invoking the channel, including synchronous re-entry/throw.
  attempt.wireRequests.add(settled);
  try {
    return await work({
      signal: AbortSignal.any([operation.signal, attempt.retirement.signal]),
      // Preserve the caller's original monotonic deadline without refreshing it.
      get timeoutMs() { return operation.timeoutMs; },
      runId: operation.runId,
      attemptId: operation.attemptId,
      origin: operation.origin,
    });
  } finally { attempt.wireRequests.delete(settled); settle(); }
}

interface CleanupDeadline {
  readonly context: EngineCleanupContext;
  readonly remaining: () => ConnectionBudget;
  readonly dispose: () => void;
}

/** One caller deadline for effects; retained settlement cannot renew this authority. */
function cleanupDeadline(context: EngineCleanupContext): CleanupDeadline {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const endsAt = performance.now() + context.timeoutMs;
  const expire = () => controller.abort(new EngineError('OPERATION_TIMEOUT', 'Native cleanup exhausted its caller budget', { retryable: false }));
  const timer = setTimeout(expire, Math.max(0, context.timeoutMs));
  if (context.timeoutMs <= 0) expire();
  return {
    context: { signal, get timeoutMs() { return Math.max(0, endsAt - performance.now()); } },
    remaining: () => {
      if (performance.now() >= endsAt && !signal.aborted) expire();
      if (signal.aborted) throw connectionAbort(signal, 'Native cleanup');
      return { signal, timeoutMs: Math.max(0, endsAt - performance.now()) };
    },
    dispose: () => clearTimeout(timer),
  };
}

/** End-hook waiters may leave; only the owned promise can prove cleanup or fail reuse. */
function waitForRetirement(work: Promise<void>, context: EngineCleanupContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const leave = () => { clearTimeout(timer); context.signal.removeEventListener('abort', leave); resolve(); };
    const timer = setTimeout(leave, Math.max(0, context.timeoutMs));
    context.signal.addEventListener('abort', leave, { once: true });
    work.then(leave, cause => { clearTimeout(timer); context.signal.removeEventListener('abort', leave); reject(cause); });
    if (context.signal.aborted || context.timeoutMs <= 0) leave();
  });
}
