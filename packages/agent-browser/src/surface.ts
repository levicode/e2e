import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EngineError, TestError, parseKey, sameSite,
  type EngineAttemptContext, type EngineCleanupContext, type EngineInitInfo,
  type EngineObserveOptions, type EngineSnapshot, type EngineState,
  type EnginePrepareInfo, type EnginePrepareResult, type EngineFinishInfo, type VideoSegment,
  type LocatorAction, type LocatorExpression, type NodeRef, type OperationContext,
  type PointerAction, type ViewportPoint, type Momentum, type ScrollDirection,
} from 'e2e/engine';
import { guardCallbackScope } from './callback-scope.ts';
import { AGENT_BROWSER_VERSION, CliTransport } from './transport.ts';
import { ConnectionSource, type BrowserConnect } from './connection-source.ts';
import { CdpConnection } from './cdp.ts';
import { defaultContextIdentity, type BrowserContexts } from './browser-context.ts';
import { NetworkHub } from './network.ts';
import { SnapshotAdapter } from './observation.ts';
import { LocatorCompanion } from './locators.ts';
import { launchChromium, type OwnedBrowser } from './launch.ts';
import { captureState, restoreState, type StateProbeTargets } from './state.ts';
import { captureMaskedPixels } from './pixels.ts';
import { bounded, beforeDispatch, within } from './budget.ts';
import { ProtectedContext, type ProtectedOptions } from './protected.ts';
import { installDiagnostics } from './diagnostics.ts';
import { InputController } from './input.ts';
import { LeasedBrowsers, type BrowserProvider, type LeaseDownloads } from './provider.ts';
import { VideoRecorder, ProviderVideo, type AttemptVideo, type ScreencastOptions } from './video.ts';

export interface AgentBrowserOptions extends ProtectedOptions {
  /** Exact-ref patched agent-browser executable. The stock binary is intentionally refused. */
  readonly executable?: string;
  readonly browser?: 'chromium' | BrowserProvider;
  readonly connect?: BrowserConnect;
  readonly screencast?: ScreencastOptions;
  readonly executablePath?: string;
  readonly args?: readonly string[];
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly testIdAttribute?: string;
}

export interface Tab { readonly tabId: string; readonly targetId: string; readonly active: boolean; readonly url: string; readonly title: string }

export const unsupported = (message: string): never => { throw new EngineError('UNSUPPORTED_CAPABILITY', message, { retryable: false }); };
export const invalidState = (): never => { throw new EngineError('INVALID_STATE', 'No active agent-browser attempt', { retryable: false }); };

/** Primary node actions and snapshot/ref ownership stay with agent-browser; CDP fills explicit API gaps. */
export class AgentBrowserSurface {
  private info: EngineInitInfo | undefined;
  private attempt: EngineAttemptContext | undefined;
  private owned: OwnedBrowser | undefined;
  private readonly leases: LeasedBrowsers | undefined;
  private readonly connectionSource: ConnectionSource | undefined;
  private contextId: string | undefined;
  private defaultContextId: string | undefined;
  private defaultLeaseContext = false;
  private launchedThisAttempt = false;
  private backgroundGeneration = 0;
  private video: AttemptVideo | undefined;
  private transport: CliTransport | undefined;
  private traceTransport: CliTransport | undefined;
  private traceAdapter: SnapshotAdapter | undefined;
  private traceDisabled = false;
  private traceBusy = false;
  private endpoint: string | undefined;
  private snapshots: SnapshotAdapter | undefined;
  private locators: LocatorCompanion | undefined;
  private connection: CdpConnection | undefined;
  private network: NetworkHub | undefined;
  private sessionId: string | undefined;
  private targetId: string | undefined;
  private tainted = false;
  private poisoned = false;
  private uiBusy = false;
  private readonly uiContext = new AsyncLocalStorage<{ active: boolean }>();
  private uiOwner: { active: boolean } | undefined;
  private readonly origins = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private activeUnsubscribe: (() => void)[] = [];
  private readonly pendingBackground = new Set<Promise<void>>();
  private readonly backgroundErrors: unknown[] = [];
  private readonly restartCallbacks: ((context: OperationContext) => Promise<void>)[] = [];
  private protectedContext: ProtectedContext | undefined;
  private ownNavigations = 0;
  private browserCleanup: (() => void)[] = [];
  private viewport: { width: number; height: number } | undefined;

  assertUsable(): void { this.requireTransport(); }
  private guardAttempt(context: OperationContext): void {
    if (!this.info || !this.attempt || context.runId !== this.info.runId || context.attemptId !== this.attempt.attemptId) {
      throw new EngineError('INVALID_STATE', 'The browser operation belongs to an inactive attempt', { retryable: false });
    }
  }
  guardOperation(context: OperationContext): void { guardCallbackScope(this); this.guardAttempt(context); this.requireTransport(); }
  private ownsUi(): boolean { const owner = this.uiContext.getStore(); return owner !== undefined && owner.active && owner === this.uiOwner; }
  private assertInputUsable(): void {
    this.assertUsable();
    if (this.uiBusy && !this.ownsUi()) unsupported('Concurrent UI input is not supported; network handlers remain independent');
  }
  private async withUi<T>(context: OperationContext, work: () => Promise<T>): Promise<T> {
    if (this.uiBusy || this.input.isBusy) unsupported('Concurrent UI mutations are not supported; network event waits remain concurrent');
    this.uiBusy = true;
    const owner = { active: true };
    this.uiOwner = owner;
    try { const result = await this.uiContext.run(owner, work); await this.captureTrace(context); return result; }
    finally { owner.active = false; if (this.uiOwner === owner) { this.uiBusy = false; this.uiOwner = undefined; } }
  }
  markUncertain(context?: OperationContext): never {
    if (context && (!this.attempt || context.attemptId !== this.attempt.attemptId || context.runId !== this.info?.runId)) invalidState();
    this.poisoned = true; this.connectionSource?.poisonAttempt(); throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'The browser action outcome is unknown; this attempt cannot be reused', { retryable: false }); }
  registerRestart(callback: (context: OperationContext) => Promise<void>): void { this.restartCallbacks.push(callback); }
  registerCleanup(cleanup: () => void): void { this.unsubscribe.push(cleanup); }
  registerBackground(work: Promise<void>): void {
    const generation = this.backgroundGeneration;
    const tracked = work.catch((error: unknown) => { if (generation === this.backgroundGeneration) this.backgroundErrors.push(error); }).finally(() => this.pendingBackground.delete(tracked));
    this.pendingBackground.add(tracked);
  }


  readonly options: AgentBrowserOptions;
  readonly input: InputController;
  constructor(options: AgentBrowserOptions) {
    this.options = options;
    this.leases = typeof options.browser === 'object' ? new LeasedBrowsers(options.browser) : undefined;
    this.connectionSource = options.connect ? new ConnectionSource(options.connect) : undefined;
    this.input = new InputController({ cdp: () => this.cdp, session: () => this.cdpSession, assertUsable: () => this.assertInputUsable(), guardOperation: context => this.guardOperation(context), markUncertain: () => this.markUncertain(), frameSession: (frame, context) => this.routes.sessionForTarget(frame, context) });
  }
  get projectRoot(): string { return this.info?.projectRoot ?? process.cwd(); }
  get artifactsDir(): string { return this.attempt?.artifactsDir ?? invalidState(); }
  get cdp(): CdpConnection { return this.connection ?? invalidState(); }
  get cdpSession(): string { return this.sessionId ?? invalidState(); }
  get activeTarget(): string { return this.targetId ?? invalidState(); }
  get routes(): NetworkHub { return this.network ?? invalidState(); }
  get browserContextId(): string | undefined { return this.contextId; }
  private get targetContextId(): string | undefined { return this.contextId ?? this.defaultContextId; }
  get remote(): boolean { return this.leases !== undefined || this.connectionSource !== undefined; }
  get downloads(): LeaseDownloads | undefined { return this.leases?.downloads(); }
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> { return this.leases?.prepare(info); }
  async finish(info: EngineFinishInfo): Promise<void> { await this.leases?.finish(info); }

  async init(info: EngineInitInfo): Promise<void> {
    this.info = info;
    this.leases?.init(info);
    this.connectionSource?.init(info);
    const cli = new CliTransport(this.cliOptions());
    try { await cli.version({ signal: info.signal, timeoutMs: 30_000, runId: info.runId, attemptId: '', origin: 'test' }); }
    finally { await cli.close({ signal: new AbortController().signal, timeoutMs: 5000, runId: info.runId, attemptId: '', origin: 'test' }); }
  }

  async startAttempt(attempt: EngineAttemptContext): Promise<void> {
    if (!this.info) invalidState();
    if (this.attempt) throw new EngineError('INVALID_STATE', 'Previous agent-browser attempt has not closed', { retryable: false });
    this.attempt = attempt;
    this.launchedThisAttempt = false;
    this.backgroundGeneration++;
    this.pendingBackground.clear(); this.backgroundErrors.length = 0;
    this.tainted = false;
    this.poisoned = false;
    this.origins.clear();
    this.viewport = this.options.viewport === undefined ? { width: 1280, height: 720 } : this.options.viewport ?? undefined;
    await this.leases?.startAttempt(attempt);
    await this.connectionSource?.startAttempt(attempt);
    const record = this.leases?.recorder(attempt.attemptId);
    this.video = record ? new ProviderVideo(record, attempt.artifactsDir) : new VideoRecorder({ ...this.options.screencast, artifactsDir: attempt.artifactsDir, env: this.info?.env ?? {}, ffmpegPath: this.options.screencast?.ffmpegPath ?? this.info?.env.E2E_FFMPEG_EXECUTABLE ?? 'ffmpeg' });
    this.protectedContext = new ProtectedContext(this.options, this.info?.app.site);
    await this.protectedContext.prepare(this.projectRoot, attempt.resolveSecret);
    await this.launch(this.operation(attempt.signal, 30_000));
    const browser = await this.cdp.send<{ product: string; protocolVersion: string }>('Browser.getVersion', {}, this.operation(attempt.signal, 5000));
    attempt.environment({ engine: `agent-browser ${AGENT_BROWSER_VERSION}`, browser: browser.product, protocol: browser.protocolVersion, companion: 'public Chromium CDP', isolation: this.remote ? (this.defaultLeaseContext ? 'exclusive leased default context' : 'owned context per attempt') : 'owned process per attempt' });
  }

  private cliOptions() {
    const executable = this.options.executable ?? this.info?.env.E2E_AGENT_BROWSER_EXECUTABLE;
    return { ...(executable ? { executable } : {}), ...(this.info ? { env: this.info.env } : {}) };
  }

  private operation(signal: AbortSignal, timeoutMs: number): OperationContext {
    return { signal, timeoutMs, runId: this.info?.runId ?? '', attemptId: this.attempt?.attemptId ?? '', origin: 'test' };
  }

  private async launch(context: OperationContext, deferUserHooks = false): Promise<void> {
    context = bounded(context);
    const info = this.info ?? invalidState();
    let endpoint: string;
    if (this.leases) endpoint = await this.leases.endpoint(context.signal);
    else if (this.connectionSource) endpoint = await this.connectionSource.endpoint(context.signal);
    else {
      this.owned = await launchChromium({
        executable: this.options.executablePath ?? info.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium',
        headed: info.headed, env: info.env,
        ...(this.options.args ? { args: this.options.args } : {}),
      }, context);
      endpoint = this.owned.endpoint;
    }
    this.endpoint = endpoint;
    this.traceDisabled = false;
    this.connection = await CdpConnection.connect(endpoint, context);
    await this.cdp.verifyChromium(context);
    const contexts = await this.cdp.send<BrowserContexts>('Target.getBrowserContexts', {}, context);
    const existingTargets = await this.cdp.listTargets(context);
    this.defaultContextId = defaultContextIdentity(contexts, existingTargets);
    const browserExclusive = !this.remote || (this.leases?.scope ?? this.connectionSource?.scope) === 'attempt';
    if (!browserExclusive) unsupported('Shared browser endpoints cannot guarantee first-popup hooks without affecting unrelated pages; use a dedicated attempt-scoped browser');
    if (this.remote && contexts.browserContextIds.length > 0) unsupported('An attempt-scoped endpoint must exclusively own its browser; unrelated contexts are present');
    let selectedTarget: string | undefined;
    if (this.remote) {
      if ((this.leases?.scope ?? this.connectionSource?.scope) === 'attempt' && !this.launchedThisAttempt) {
        const pages = existingTargets.filter(target => target.type === 'page');
        if (contexts.browserContextIds.length > 0 || pages.some(page => page.browserContextId !== this.defaultContextId)) unsupported('An attempt-scoped browser lease must exclusively own its default context');
        this.defaultLeaseContext = true;
        selectedTarget = pages[0]?.targetId ?? (await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }, context)).targetId;
      } else {
        const created = await this.cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true }, context);
        if (!created.browserContextId) throw new EngineError('ENGINE_FAILURE', 'The remote browser did not create an isolated context', { retryable: false });
        this.contextId = created.browserContextId;
        const page = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: this.contextId }, context);
        selectedTarget = page.targetId;
      }
    }
    selectedTarget ??= (await this.cdp.listTargets(context)).find(target => target.type === 'page' && target.browserContextId === this.targetContextId)?.targetId;
    selectedTarget ??= (await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', ...(this.contextId ? { browserContextId: this.contextId } : {}) }, context)).targetId;
    if (this.contextId === undefined) this.defaultContextId = defaultContextIdentity(contexts, await this.cdp.listTargets(context));
    this.launchedThisAttempt = true;
    this.transport = new CliTransport({ ...this.cliOptions(), cdp: endpoint, cdpTarget: selectedTarget, cdpContext: this.contextId ?? null });
    const connection = this.cdp;
    const protectedContext = this.protectedContext;
    const launchAttempt = this.attempt ?? invalidState();
    const launchRunId = info.runId;
    this.network = new NetworkHub(connection, {
      callbackOwner: this,
      browserExclusive,
      browserContextId: this.contextId ?? null,
      ...(this.contextId !== undefined || this.defaultContextId === undefined ? {} : { defaultBrowserContextId: this.defaultContextId }),
      operation: () => ({ signal: launchAttempt.signal, timeoutMs: 30_000, runId: launchRunId, attemptId: launchAttempt.attemptId, origin: 'test' }),
      resolveUrl: (url) => { if (!/^https?:/.test(url)) throw new TestError('INVALID_ARGUMENT', 'Route URL override must be absolute until a fixture resolver is registered'); return new URL(url).href; },
      resolvePath: (file) => path.resolve(this.projectRoot, file),
      configuredHeaderNames: protectedContext?.configuredHeaderNames ?? [],
      ...(protectedContext && protectedContext.configuredHeaderNames.length > 0
        ? { siteHeaders: (url: string) => protectedContext.siteHeaders(url) } : {}),
      ...(protectedContext && this.options.basicAuth !== undefined
        ? { authorization: (url: string) => protectedContext.authorization(url) } : {}),
    });
    if (!deferUserHooks) await this.installProtected(context);
    await this.network.start(context);
    if (this.attempt) this.browserCleanup.push(await installDiagnostics(this.cdp, this.network, this.attempt, { activeTarget: () => this.targetId, ownNavigation: () => this.ownNavigations > 0, onOrigin: (origin: string) => { if (this.connection === connection && this.attempt === launchAttempt) this.origins.add(origin); } }, context));
    await this.transport.run(selectedTarget ? ['tab', selectedTarget] : ['open', 'about:blank'], context, { mutating: true });
    await this.bindActive(context);
    const network = this.routes;
    const primaryTransport = this.transport;
    this.locators = new LocatorCompanion({ cdp: () => connection, session: () => this.connection === connection ? this.cdpSession : invalidState(), transport: () => { if (this.connection !== connection) invalidState(); this.assertUsable(); return primaryTransport; }, frameSession: (frameId, operation) => network.sessionForTarget(frameId, operation), ...(info.app.site ? { allowFrameUrl: (url: string) => sameSite(url, info.app.site!) } : {}), ...(this.options.testIdAttribute ? { testIdAttribute: this.options.testIdAttribute } : {}) });
    const locators = this.locators;
    this.snapshots = new SnapshotAdapter(this.transport, { snapshotArgs: operation => locators.snapshotArgs(operation), readMetadata: (refs, operation) => locators.readMetadata(refs, operation), ...(this.options.testIdAttribute ? { testIdAttribute: this.options.testIdAttribute } : {}) });
    if (this.viewport) await this.setViewport(this.viewport, context);
    if (!deferUserHooks) for (const callback of this.restartCallbacks) await callback(context);
    if (!deferUserHooks) await this.video?.pageOpened(this.cdp, this.activeTarget, context);
  }

  /** Optional trace reads have their own CLI session, never a second browser or the action ref map. */
  private async captureTrace(context: OperationContext): Promise<void> {
    const attempt = this.attempt;
    if (!attempt?.screen || this.traceDisabled || this.traceBusy || !this.endpoint || !this.locators || context.signal.aborted || context.timeoutMs <= 0) return;
    this.traceBusy = true;
    const connection = this.connection;
    const operation = bounded({ ...context, timeoutMs: Math.min(context.timeoutMs, 1000) });
    try {
      this.guardOperation(operation);
      this.traceTransport ??= new CliTransport({ ...this.cliOptions(), cdp: this.endpoint, cdpTarget: this.activeTarget, cdpContext: this.contextId ?? null });
      const target = this.activeTarget;
      const transport = this.traceTransport;
      const locators = this.locators;
      const selected = await transport.run<{ targetId: string }>(['tab', target, '--no-activate'], operation);
      this.guardOperation(operation);
      if (connection !== this.connection) return;
      if (selected.targetId !== target) throw new Error('Trace target identity mismatch');
      this.traceAdapter ??= new SnapshotAdapter(transport, {
        preserveRefs: true,
        snapshotArgs: current => locators.snapshotArgs(current),
        readMetadata: (refs, current) => locators.readMetadata(refs, current),
        ...(this.options.testIdAttribute ? { testIdAttribute: this.options.testIdAttribute } : {}),
      });
      const snapshot = await this.traceAdapter.observe(operation);
      if (attempt === this.attempt && connection === this.connection) attempt.screen(snapshot);
    } catch {
      // A missing optional trace must not poison an acknowledged UI action or replace its error.
      if (attempt === this.attempt && connection === this.connection) this.traceDisabled = true;
    } finally { if (attempt === this.attempt && connection === this.connection) this.traceBusy = false; }
  }

  private async installProtected(context: OperationContext): Promise<void> {
    const protectedContext = this.protectedContext;
    const connection = this.cdp;
    await this.routes.registerSessionInitializer((session, _target, operation) => protectedContext?.configureSession(connection, session, operation), context);
  }

  private async bindActive(context: OperationContext): Promise<void> {
    const tabs = await this.tabs(context);
    const active = tabs.find((tab) => tab.active);
    if (!active) throw new EngineError('ENGINE_FAILURE', 'agent-browser did not identify its active tab', { retryable: false });
    const targets = await this.cdp.listTargets(context);
    if (!targets.some((target) => target.targetId === active.targetId && target.type === 'page' && target.browserContextId === this.targetContextId)) throw new EngineError('ENGINE_FAILURE', 'agent-browser and CDP do not share a page target', { retryable: false });
    this.targetId = active.targetId;
    this.sessionId = await this.routes.useTarget(active.targetId, context);
    for (const unsubscribe of this.activeUnsubscribe.splice(0)) unsubscribe();
    await this.cdp.send('Page.enable', {}, context, this.sessionId);
    await this.cdp.send('Runtime.enable', {}, context, this.sessionId);

  }

  private requireTransport(): CliTransport {
    if (this.poisoned || this.transport?.poisoned) throw new EngineError('INVALID_STATE', 'An uncertain action ended this attempt; a fresh attempt is required', { retryable: false });
    return this.transport ?? invalidState();
  }

  async command<T>(args: readonly string[], context: OperationContext, mutating = false): Promise<T> {
    this.guardOperation(context);
    beforeDispatch(context);
    return this.requireTransport().run<T>(args, context, { mutating });
  }

  async tabs(context: OperationContext): Promise<readonly Tab[]> {
    const result = await this.command<{ tabs: Tab[] }>(['tab', 'list'], context);
    if (!Array.isArray(result.tabs)) throw new EngineError('ENGINE_FAILURE', 'Malformed public tab listing', { retryable: false });
    if (!this.remote) return result.tabs;
    const permitted = new Set((await this.cdp.listTargets(context)).filter(target => target.browserContextId === this.targetContextId).map(target => target.targetId));
    return result.tabs.filter(tab => permitted.has(tab.targetId));
  }

  async switchTab(tab: string, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.switchTab(tab, context)); }
    context = bounded(context);
    if (!(await this.tabs(context)).some(target => target.tabId === tab || target.targetId === tab)) throw new TestError('INVALID_ARGUMENT', 'The tab is outside this attempt');
    await this.video?.pageClosing(context);
    await this.command(['tab', tab], context, true);
    this.snapshots?.invalidate();
    await this.bindActive(context);
    await this.video?.pageOpened(this.cdp, this.activeTarget, context);
  }

  async observe(context: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    this.guardOperation(context);
    context = bounded(context);
    const snapshot = await (this.snapshots ?? invalidState()).observe(context);
    if (!options?.pixels) return snapshot;
    if (this.tainted) throw new TestError('POLICY_DENIED', 'Pixels are unavailable after sensitive input');
    const masked = await captureMaskedPixels(this.cdp, this.activeTarget, context, this.probeTargets());
    return { ...snapshot, pixels: masked.pixels, maskedRegionCount: masked.maskedRegionCount };
  }

  async locate(expression: LocatorExpression, context: OperationContext) {
    this.guardOperation(context);
    context = bounded(context);
    await this.captureTrace(context);
    const found = await (this.locators ?? invalidState()).locate(expression, context, this.snapshots ?? invalidState());
    return found;
  }

  async open(url: string, context: OperationContext, waitUntil = 'load'): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.open(url, context, waitUntil)); }
    context = bounded(context);
    this.snapshots?.invalidate();
    this.ownNavigations++;
    try { await this.command(['open', url, '--wait-until', waitUntil], context, true); }
    finally { this.ownNavigations--; }
    try { const location = new URL(url); if (/^https?:$/.test(location.protocol)) this.origins.add(location.origin); } catch { /* harness validates */ }
  }

  async back(context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.back(context)); }
    context = bounded(context);
    this.snapshots?.invalidate();
    this.ownNavigations++;
    try { await this.command(['back'], context, true); }
    finally { this.ownNavigations--; }
  }

  async evaluate<T>(source: string, context: OperationContext, mutating = true): Promise<T> {
    this.guardOperation(context);
    try {
      const result = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: source, awaitPromise: true, returnByValue: true, userGesture: true,
      }, context, this.cdpSession);
      if (result.exceptionDetails) throw new TestError('EVALUATE_FAILED', 'Page JavaScript evaluation threw an exception');
      return result.result.value as T;
    } catch (error) {
      if (error instanceof TestError || !mutating) throw error;
      this.markUncertain(context);
    }
  }

  async perform(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.perform(ref, action, context)); }
    context = bounded(context);
    let dispatched = false;
    const end = Date.now() + context.timeoutMs;
    const budget = (): OperationContext => ({ ...context, timeoutMs: Math.max(0, end - Date.now()) });
    const adapter = this.snapshots ?? invalidState();
    try {
      if (adapter.isRoot(ref) && action.kind === 'swipe') { await this.wheel(action.direction, action.momentum ?? 'none', await this.viewportExtent(action.direction, budget()), budget()); return; }
      await adapter.verify(ref, budget());
      const selector = adapter.resolve(ref);
      const act = async (argv: string[]) => {
        const result = await this.command(argv, budget(), true); dispatched = true;
        if (['click', 'dblclick', 'hover', 'check', 'uncheck', 'drag', 'mouse'].includes(argv[0] ?? '')) this.input.adoptPointer(await this.command(['mouse', 'state'], budget()));
        return result;
      };
      const modifiers = ('modifiers' in action ? action.modifiers ?? [] : []).filter(modifier => !this.input.isKeyDown(modifier));
      if (['tap', 'doubleTap', 'secondaryTap', 'longPress', 'hover', 'check', 'uncheck', 'dragTo'].includes(action.kind) && this.input.buttons !== 0) unsupported('Release held mouse buttons before a node-addressed pointer action');
      for (const modifier of modifiers) { await this.input.keyDown(modifier, budget()); dispatched = true; }
      try {
        switch (action.kind) {
          case 'tap': await act(['click', selector, '--modifiers', String(this.input.modifiers)]); break;
          case 'doubleTap': await act(['dblclick', selector, '--modifiers', String(this.input.modifiers)]); break;
          case 'fill':
            if (action.sensitive) this.tainted = true;
            await act(['fill', selector, '--', action.value]);
            break;
          case 'clear': await act(['fill', selector, '--', '']); break;
          case 'focus': case 'hover': case 'check': case 'uncheck': await act([action.kind, selector]); break;
          case 'scrollIntoView': await act(['scrollintoview', selector]); break;
          case 'press': await act(['focus', selector]); await this.pressKey(action.key, budget()); break;
          case 'setInputFiles': await act(['upload', selector, ...action.paths.map((file) => path.resolve(this.projectRoot, file))]); break;
          case 'dragTo': await adapter.verify(action.target, budget()); await act(['drag', selector, adapter.resolve(action.target)]); break;
          case 'selectOption': {
            const mode = typeof action.value === 'string' ? '--label' : 'value' in action.value ? '--value' : 'index' in action.value ? '--index' : '--label';
            const value = typeof action.value === 'string' ? action.value : 'value' in action.value ? action.value.value : 'index' in action.value ? String(action.value.index) : action.value.label;
            await act(['select', selector, mode, '--', value!]); break;
          }
          case 'swipe': {
            await act(['hover', selector]);
            const box = await this.command<{ width: number; height: number }>(['get', 'box', selector], budget());
            await this.wheel(action.direction, action.momentum ?? 'none', action.direction === 'up' || action.direction === 'down' ? box.height : box.width, budget());
            break;
          }
          case 'secondaryTap': case 'longPress': {
            await act(['hover', selector]);
            const button = action.kind === 'secondaryTap' ? 'right' : 'left';
            await adapter.verify(ref, budget());
            await this.input.mouseDown(button, budget());
            if (action.kind === 'longPress') await this.delay(action.durationMs ?? 500, budget());
            await this.input.mouseUp(button, budget()); break;
          }
        }
      } finally {
        for (const modifier of modifiers.toReversed()) await this.input.keyUp(modifier, budget());
      }
    } catch (error) {
      if (dispatched) this.markUncertain(context);
      throw error;
    }
  }

  async pressKey(key: string, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.pressKey(key, context)); }
    if (!parseKey(key)) unsupported('Key is outside the engine keyboard grammar');
    await this.command(['press', key.replace('ControlOrMeta', process.platform === 'darwin' ? 'Meta' : 'Control')], context, true);
  }

  async typeText(text: string, replace: boolean, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.typeText(text, replace, context)); }
    context = bounded(context);
    let dispatched = false;
    await this.input.assertTextFocus(context);
    try {
    if (replace) { await this.pressKey('ControlOrMeta+a', context); dispatched = true; await this.pressKey('Backspace', context); }
    await this.command(['keyboard', 'type', '--', text], context, true);
    } catch (error) { if (dispatched) this.markUncertain(context); throw error; }
  }

  async pointer(point: ViewportPoint, action: PointerAction, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    const points = 'target' in action ? [point, action.target] : [point];
    if (points.some(value => !Number.isFinite(value.x) || !Number.isFinite(value.y))) throw new TestError('INVALID_ARGUMENT', 'Pointer coordinates must be finite');
    if ('durationMs' in action && action.durationMs !== undefined && (!Number.isFinite(action.durationMs) || action.durationMs < 0)) throw new TestError('INVALID_ARGUMENT', 'Pointer duration must be a nonnegative finite number');
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.pointer(point, action, context)); }
    context = bounded(context);
    let dispatched = false;
    const act = async (work: () => Promise<void>): Promise<void> => { await work(); dispatched = true; };
    try {
      await act(() => this.input.mouseMove(point.x, point.y, context));
      switch (action.kind) {
        case 'hover': return;
        case 'tap': case 'secondaryTap': case 'doubleTap': case 'longPress': {
          const button = action.kind === 'secondaryTap' ? 'right' : 'left';
          for (let count = 1; count <= (action.kind === 'doubleTap' ? 2 : 1); count++) {
            await act(() => this.input.mouseDown(button, context, count));
            if (action.kind === 'longPress') await this.delay(action.durationMs ?? 500, context);
            await act(() => this.input.mouseUp(button, context, count));
          }
          return;
        }
        case 'swipe': {
          await act(async () => this.wheel(action.direction, action.momentum ?? 'none', await this.viewportExtent(action.direction, context), context));
          return;
        }
        case 'dragTo': case 'swipeTo': {
          await act(() => this.input.mouseDown('left', context));
          const duration = action.kind === 'swipeTo' ? action.durationMs ?? 250 : 250;
          const steps = Math.max(1, Math.ceil(duration / 16));
          for (let step = 1; step <= steps; step++) {
            const fraction = step / steps;
            await act(() => this.input.mouseMove(point.x + (action.target.x - point.x) * fraction, point.y + (action.target.y - point.y) * fraction, context));
            if (duration > 0) await this.delay(duration / steps, context);
          }
          await act(() => this.input.mouseUp('left', context));
          return;
        }
      }
    } catch (error) { if (dispatched) this.markUncertain(context); throw error; }
  }

  private async viewportExtent(direction: ScrollDirection, context: OperationContext): Promise<number> {
    return this.evaluate<number>(direction === 'up' || direction === 'down' ? 'innerHeight' : 'innerWidth', context, false);
  }

  private async wheel(direction: ScrollDirection, momentum: Momentum, extent: number, context: OperationContext): Promise<void> {
    if (!Number.isFinite(extent) || extent <= 0) throw new EngineError('NOT_ACTIONABLE', 'The scroll target has no visible extent', { retryable: false });
    const distance = Math.round(extent * (momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5));
    const dx = direction === 'right' ? distance : direction === 'left' ? -distance : 0;
    const dy = direction === 'down' ? distance : direction === 'up' ? -distance : 0;
    await this.input.mouseWheel(dx, dy, context);
    try { await this.evaluate("document.visibilityState==='hidden'?undefined:new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)))", context, false); }
    catch { this.markUncertain(context); }
  }

  private async delay(ms: number, context: OperationContext): Promise<void> {
    if (ms > context.timeoutMs) this.markUncertain(context);
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); try { this.markUncertain(context); } catch (error) { reject(error); } };
      const timer = setTimeout(() => { context.signal.removeEventListener('abort', aborted); resolve(); }, ms);
      context.signal.addEventListener('abort', aborted, { once: true });
      if (context.signal.aborted) aborted();
    });
  }

  async setViewport(size: { width: number; height: number }, context: OperationContext): Promise<void> {
    await this.command(['set', 'viewport', String(size.width), String(size.height)], context, true);
    this.viewport = { ...size };
  }

  async screenshot(context: OperationContext): Promise<string> {
    this.guardOperation(context);
    if (this.tainted) throw new TestError('POLICY_DENIED', 'Screenshots are unavailable after sensitive input');
    const artifactsDir = this.artifactsDir;
    const capture = await captureMaskedPixels(this.cdp, this.activeTarget, context, this.probeTargets());
    this.guardOperation(context);
    const file = `agent-browser-${randomUUID()}.png`;
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, file), capture.pixels.data);
    return file;
  }

  async startVideo(context: OperationContext): Promise<void> { this.guardOperation(context); await (this.video ?? invalidState()).arm(this.cdp, this.activeTarget, context); }
  async stopVideo(context: OperationContext): Promise<readonly VideoSegment[]> { this.guardOperation(context); return (this.video ?? invalidState()).stop(context); }

  private probeTargets(): StateProbeTargets {
    const network = this.routes;
    const contextId = this.contextId;
    const targetContextId = this.targetContextId;
    return { create: operation => network.createProbeTarget(operation), release: (target, operation) => network.releaseProbeTarget(target, operation), browserContextId: () => contextId, targetBrowserContextId: () => targetContextId };
  }

  async capture(context: OperationContext): Promise<EngineState> {
    this.guardOperation(context);
    return captureState(this.cdp, context, this.origins, this.probeTargets());
  }
  async restore(state: EngineState, context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.restore(state, context)); }
    context = bounded(context);
    let replaced = false;
    try {
    await restoreState(state, context, async () => {
      replaced = true;
      await this.closeBrowser(context);
      this.guardAttempt(context);
      this.poisoned = false;
      await this.launch(context, true);
      return this.cdp;
    }, { create: (operation) => this.routes.createProbeTarget(operation), release: (target, operation) => this.routes.releaseProbeTarget(target, operation), browserContextId: () => this.contextId, targetBrowserContextId: () => this.targetContextId });
    await this.installProtected(context);
    for (const callback of this.restartCallbacks) await callback(context);
    this.snapshots?.invalidate();
    await this.bindActive(context);
    await this.video?.pageOpened(this.cdp, this.activeTarget, context);
    } catch (error) { if (replaced && context.attemptId === this.attempt?.attemptId) this.poisoned = true; throw error; }
  }
  async restart(context: OperationContext): Promise<void> { context = bounded(context); await this.restore(await this.capture(context), context); }
  async reset(context: OperationContext): Promise<void> {
    this.guardOperation(context);
    if (!this.ownsUi()) { context = bounded(context); return this.withUi(context, () => this.reset(context)); }
    context = bounded(context);
    await this.closeBrowser(context); this.guardAttempt(context); this.poisoned = false; this.origins.clear(); await this.launch(context);
  }
  async settle(context: EngineCleanupContext): Promise<void> {
    const operation = bounded(this.operation(context.signal, context.timeoutMs));
    await this.network?.settle(operation);
    await within(Promise.all(this.pendingBackground), operation);
    const error = this.backgroundErrors.shift();
    if (error) throw error;
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    try { await this.closeBrowser(this.operation(context.signal, context.timeoutMs), true); }
    finally {
      try { await this.leases?.endAttempt(context); }
      finally { this.connectionSource?.endAttempt();
        this.attempt = undefined; this.snapshots = undefined; this.uiBusy = false; if (this.uiOwner) this.uiOwner.active = false; this.uiOwner = undefined; this.video = undefined; this.backgroundGeneration++; this.pendingBackground.clear(); this.backgroundErrors.length = 0; }
    }
  }
  async dispose(context: EngineCleanupContext): Promise<void> { try { await this.endAttempt(context); } finally { try { await this.leases?.dispose(context); } finally { this.connectionSource?.dispose(); this.info = undefined; } } }

  private async closeBrowser(context: OperationContext, final = false): Promise<void> {
    let error: unknown;
    try { if (final) await this.video?.abandon(context); else await this.video?.pageClosing(context); } catch (cause) { error = cause; }
    for (const cleanup of this.browserCleanup.splice(0)) cleanup();
    this.network?.close(); this.network = undefined;
    if (final) {
      for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
      this.restartCallbacks.length = 0;
    }
    for (const unsubscribe of this.activeUnsubscribe.splice(0)) unsubscribe();
    // Disconnect our CLI sessions while their exact targets still exist. A scoped close never
    // authorizes a reconnect or a broader browser close after the owned context is disposed.
    try { await this.traceTransport?.close(context); } catch (cause) { error ??= cause; }
    try { await this.transport?.close(context); } catch (cause) { error ??= cause; }
    this.traceTransport = undefined; this.traceAdapter = undefined; this.traceBusy = false;
    if (this.defaultLeaseContext && this.connection) {
      try {
        const pages = (await this.connection.listTargets(context)).filter(target => target.type === 'page' && target.browserContextId === this.defaultContextId);
        await Promise.all(pages.map(page => this.connection!.send('Target.closeTarget', { targetId: page.targetId }, context)));
      } catch (cause) { error ??= cause; }
    }
    this.defaultLeaseContext = false;
    if (this.contextId !== undefined && this.connection) {
      try { await this.connection.send('Target.disposeBrowserContext', { browserContextId: this.contextId }, context); } catch (cause) { error ??= cause; }
    }
    this.contextId = undefined; this.defaultContextId = undefined;
    try { await this.owned?.close(); } catch (cause) { error ??= cause; }
    this.owned = undefined;
    this.endpoint = undefined;
    this.connection?.close(); this.connection = undefined;
    this.transport = undefined; this.sessionId = undefined; this.targetId = undefined;
    this.input.reset();
    if (error) throw error;
  }
}
