/** Explicit unit-test resource model. This is not a browser, DOM implementation,
 * CDP server, or evidence that native Chromium has released a resource.
 *
 * Spy on chromium.connectOverCDP in EACH opting-in fixture. Keep the production
 * playwright-binding module intact so it must discover exact context/target IDs.
 * Native contexts and PW wrappers have independent lifetimes. Legacy native-only
 * replacement must not close PW wrappers; coordinated replacement uses the
 * explicit retirement/allocation/adoption phases below.
 */
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { vi } from 'vitest';
import type { PeerOutcome, PeerRequest } from './native-protocol-peer.ts';

type InteropCommand = 'scope.interop.prepare' | 'scope.interop.adopt' | 'scope.interop.identify' | 'scope.interop.retire' | 'scope.interop.abort';
type Manager = { readonly ownsProcess: boolean };
type NativeContext = { manager: Manager; nativeAdopted: boolean; contextId: string; targetId: string; persistent: boolean; alive: boolean; pageAlive: boolean };
type Wrapper = { resource: NativeContext; context: BrowserContext; page: Page; closed: boolean; events: EventEmitter };
type Client = { manager: Manager; connected: boolean; wrappers: Wrapper[]; browser: Browser };
type Scope = { identityScope: string; resource: NativeContext; retiring: boolean };
type Session = { client: Client; resource: NativeContext | undefined; targetId: string | undefined; closed: boolean; events: EventEmitter; session: CDPSession };
type Replacement = { scope: Scope; operationSeq: number; owner: Client; phase: 'retire' | 'create'; allocation?: NativeContext };
function fail(detail: string): never { throw new Error(`Synthetic interop resource contract: ${detail}`); }
function exact(args: PeerRequest['args'], keys: string[]): void {
  if (Object.keys(args).toSorted().join(',') !== keys.toSorted().join(',')) fail(`expected exact arguments ${keys.join(',')}`);
}
function text(args: PeerRequest['args'], key: string): string {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : fail(`missing ${key}`);
}

export interface NativeInteropResourceOptions {
  readonly endpoint?: string;
  readonly browserIdentity?: string;
  readonly allocateContextIdentity?: (allocation: number, persistent: boolean) => { readonly contextId: string; readonly targetId: string };
  /** Ended scope strings may deliberately repeat in callback-epoch regressions. */
  readonly allocateScopeIdentity?: () => string;
}
function identity(value: string): string { return value.length > 0 ? value : fail('empty resource identity'); }

export class NativeInteropResources {
  readonly endpoint: string;
  constructor(private readonly options: NativeInteropResourceOptions = {}) {
    this.endpoint = identity(options.endpoint ?? 'ws://synthetic-interop.invalid/browser');
    if (options.browserIdentity !== undefined) identity(options.browserIdentity);
  }
  readonly events: string[] = [];
  private serial = 0;
  private allocations = 0;
  private readonly targetIds = new Set<string>();
  private prepared: string | undefined;
  private manager: Manager | undefined;
  private scope: Scope | undefined;
  private replacement: Replacement | undefined;
  private readonly contexts: NativeContext[] = [];
  private readonly clients: Client[] = [];
  private readonly sessions: Session[] = [];
  private readonly refusals = new Map<InteropCommand, string[]>();

  /** A refusal applies to exactly this stage, never an alias for old scope.open. */
  refuseNext(command: InteropCommand, code: string): void {
    const pending = this.refusals.get(command) ?? [];
    pending.push(code); this.refusals.set(command, pending);
  }
  snapshot() {
    const wrappers = this.clients.flatMap(client => client.wrappers);
    return {
      prepared: this.prepared !== undefined,
      nativeContexts: this.contexts.filter(context => context.alive).length,
      playwrightClients: this.clients.filter(client => client.connected).length,
      playwrightContexts: wrappers.filter(wrapper => !wrapper.closed).length,
      contextCloseEvents: this.events.filter(event => event.startsWith('pw-context-closed:')).length,
    };
  }
  /** Read-only ownership metadata, not a guarantee that the resource is alive. */
  currentIdentity() {
    const scope = this.scope;
    if (scope === undefined) return undefined;
    return { identityScope: scope.identityScope, contextId: scope.resource.contextId, targetId: scope.resource.targetId, persistent: scope.resource.persistent, recoveryIdentity: { browser: this.options.browserIdentity ?? 'unit-browser', context: scope.resource.contextId, page: scope.resource.targetId } };
  }
  /** Explicit domain seam: a proven persistent reconnect changes scope only. */
  reconnectScope(expectedScope: string, nextScope: string): { identityScope: string } {
    const scope = this.ownedScope({ identityScope: expectedScope });
    if (!scope.resource.persistent || !scope.resource.alive || !scope.resource.pageAlive || scope.retiring) fail('reconnect requires the exact live persistent resource');
    scope.identityScope = identity(nextScope);
    return { identityScope: scope.identityScope };
  }
  /** Explicit native page-reopened/restart event: the old Page stays closed,
   * while the same context's inventory gets a distinct new Page wrapper. */
  replaceNativePage(expectedScope: string, oldTargetId: string, newTargetId: string, nextScope = expectedScope): { contextId: string; targetId: string } {
    const scope = this.ownedScope({ identityScope: expectedScope });
    const resource = scope.resource;
    if (!resource.alive || !resource.pageAlive || scope.retiring || resource.targetId !== oldTargetId) fail('page replacement requires the exact live target');
    identity(nextScope);
    identity(newTargetId);
    if (this.targetIds.has(newTargetId)) fail('target identity was already allocated');
    this.events.push(`native-page-destroyed:${oldTargetId}`);
    for (const session of this.sessions) if (session.resource === resource && session.targetId === oldTargetId) this.closeSession(session);
    resource.targetId = newTargetId; this.targetIds.add(newTargetId); scope.identityScope = nextScope;
    this.events.push(`native-page-created:${newTargetId}`);
    for (const client of this.clients) for (const wrapper of client.wrappers) {
      if (client.connected && !wrapper.closed && wrapper.resource === resource) {
        (wrapper.page as unknown as EventEmitter).emit('close', wrapper.page);
        wrapper.page = this.pageWrapper(wrapper);
      }
    }
    return { contextId: resource.contextId, targetId: newTargetId };
  }
  /** A real Page.close only destroys its exact target, not its context owner. */
  private closeNativePage(resource: NativeContext, targetId: string): void {
    if (!resource.alive || !resource.pageAlive || resource.targetId !== targetId) fail('close requires the exact live target');
    resource.pageAlive = false;
    this.events.push(`native-page-destroyed:${targetId}`);
    for (const session of this.sessions) if (session.resource === resource && session.targetId === targetId) this.closeSession(session);
    for (const client of this.clients) for (const wrapper of client.wrappers) {
      if (client.connected && !wrapper.closed && wrapper.resource === resource) (wrapper.page as unknown as EventEmitter).emit('close', wrapper.page);
    }
  }
  /** Explicit native closed-root reopen seam: no context allocation or restart. */
  reopenClosedNativePage(expectedScope: string, oldTargetId: string, newTargetId: string): void {
    const scope = this.ownedScope({ identityScope: expectedScope }); const resource = scope.resource;
    if (!resource.alive || resource.pageAlive || scope.retiring || resource.targetId !== oldTargetId) fail('reopen requires the exact closed target in its live context');
    identity(newTargetId);
    if (this.targetIds.has(newTargetId)) fail('target identity was already allocated');
    resource.targetId = newTargetId; resource.pageAlive = true; this.targetIds.add(newTargetId);
    this.events.push(`native-page-created:${newTargetId}`);
    for (const client of this.clients) for (const wrapper of client.wrappers) {
      if (client.connected && !wrapper.closed && wrapper.resource === resource) wrapper.page = this.pageWrapper(wrapper);
    }
  }
  /** Explicit legacy native-only reset/restore seam. This deliberately leaves
   * the old PW wrapper stale; it cannot make a production replacement GREEN. */
  replaceNativeScope(expectedScope: string, nextScope: string): { identityScope: string } {
    const scope = this.ownedScope({ identityScope: expectedScope });
    if (scope.resource.persistent || !scope.resource.alive || scope.retiring) fail('replacement requires the exact live isolated resource');
    identity(nextScope);
    this.destroyNativeContext(scope.resource.contextId);
    const resource = this.allocate(false);
    resource.nativeAdopted = true; resource.pageAlive = true;
    this.scope = { identityScope: nextScope, resource, retiring: false };
    return { identityScope: nextScope };
  }
  /** The native operation seals its exact old scope, but does not close PW or
   * destroy any context. The caller must send the private retire decision. */
  beginReplacement(expectedScope: string, operationSeq: number): { contextId: string } {
    const scope = this.ownedScope({ identityScope: expectedScope });
    if (!Number.isSafeInteger(operationSeq) || operationSeq < 1) fail('replacement requires its original operation sequence');
    if (this.replacement !== undefined || this.prepared !== undefined || scope.retiring || scope.resource.persistent || !scope.resource.alive || !scope.resource.pageAlive) fail('replacement requires the exact live isolated scope');
    const owners = this.clients.filter(client => client.connected && client.manager === this.manager && client.wrappers.some(wrapper => wrapper.resource === scope.resource && !wrapper.closed));
    if (owners.length !== 1) fail('replacement requires one exact connected PW owner');
    scope.retiring = true;
    this.replacement = { scope, operationSeq, owner: owners[0]!, phase: 'retire' };
    this.events.push(`replacement-sealed:${scope.resource.contextId}`);
    return { contextId: scope.resource.contextId };
  }
  /** Called after the retire decision is received, NOT after its control ACK.
   * Native absence alone is insufficient: PW's original wrapper must be gone. */
  acceptReplacementRetirement(expectedScope: string, operationSeq: number): void {
    const replacement = this.ownedReplacement(expectedScope, operationSeq);
    if (replacement.phase !== 'retire' || !replacement.owner.connected || replacement.scope.resource.alive || this.clients.some(client => client.wrappers.some(wrapper => wrapper.resource === replacement.scope.resource && !wrapper.closed))) fail('replacement creation precedes exact native absence and PW retirement');
    replacement.phase = 'create';
    this.events.push(`replacement-creation-authorized:${replacement.scope.resource.contextId}`);
  }
  /** The native operation independently validates the actual new PW allocation
   * before adopting it. No ACK, activation, or script application is invented. */
  adoptReplacement(expectedScope: string, operationSeq: number, ids: { contextId: string; targetId: string }, nextScope: string, activatePage: boolean): { identityScope: string; activatePage: boolean } {
    const replacement = this.ownedReplacement(expectedScope, operationSeq);
    exact(ids, ['contextId', 'targetId']); identity(nextScope);
    const resource = replacement.allocation;
    if (replacement.phase !== 'create' || !replacement.owner.connected || replacement.scope.resource.alive || resource === undefined || resource.contextId !== ids.contextId || resource.targetId !== ids.targetId || resource.manager !== this.manager || !resource.alive || !resource.pageAlive || resource.nativeAdopted || !replacement.owner.wrappers.some(wrapper => wrapper.resource === resource && !wrapper.closed)) fail('replacement adoption does not name the exact new live PW allocation');
    resource.nativeAdopted = true;
    this.scope = { identityScope: nextScope, resource, retiring: false };
    this.replacement = undefined;
    this.events.push(`replacement-adopted:${resource.contextId}`);
    return { identityScope: nextScope, activatePage };
  }
  /** Domain outcomes remain explicit at the call site. Unknown commands fail. */
  respond(request: PeerRequest): PeerOutcome;
  respond(request: PeerRequest, domain: (request: PeerRequest) => PeerOutcome | undefined): PeerOutcome;
  respond(request: PeerRequest, domain: (request: PeerRequest) => PeerOutcome | undefined | Promise<PeerOutcome | undefined>): PeerOutcome | Promise<PeerOutcome>;
  respond(request: PeerRequest, domain?: (request: PeerRequest) => PeerOutcome | undefined | Promise<PeerOutcome | undefined>): PeerOutcome | Promise<PeerOutcome> {
    const { command, args } = request;
    this.events.push(`wire:${command}`);
    const refusal = this.refusals.get(command as InteropCommand)?.shift();
    if (refusal !== undefined) return { error: refusal, effects: 'not-dispatched', scopeState: 'usable' };
    switch (command) {
      case 'scope.interop.prepare': {
        if (this.prepared !== undefined || this.scope !== undefined) fail('preparation already owned');
        const allowed = new Set(['source', 'context', 'endpoint', 'executablePath', 'headless', 'blockServiceWorkers', 'viewport', 'userAgent', 'locale', 'timezoneId', 'media', 'initScripts', 'preparationId']);
        if (Object.keys(args).some(key => !allowed.has(key))) fail('unknown prepare argument');
        if (args['context'] !== 'isolated' || !['launch', 'connect', 'reuse'].includes(text(args, 'source'))) fail('prepare requires an isolated source');
        if (!Array.isArray(args['initScripts']) || args['initScripts'].length !== 0) fail('user scripts must not run before adoption');
        const preparationId = text(args, 'preparationId');
        this.prepareManager(text(args, 'source'));
        this.prepared = preparationId;
        return { data: { preparationId: this.prepared, endpoint: this.endpoint } };
      }
      case 'scope.interop.adopt': {
        exact(args, ['preparationId', 'contextId', 'targetId']);
        if (this.prepared === undefined || text(args, 'preparationId') !== this.prepared) fail('wrong preparation ticket');
        const resource = this.contexts.find(context => context.contextId === args['contextId'] && context.targetId === args['targetId'] && context.alive && context.pageAlive && !context.persistent && context.manager === this.manager);
        if (resource === undefined || !this.clients.some(client => client.connected && client.wrappers.some(wrapper => wrapper.resource === resource && !wrapper.closed))) fail('adoption does not name a live PW allocation');
        resource.nativeAdopted = true;
        this.scope = { identityScope: this.options.allocateScopeIdentity === undefined ? `unit-scope-${++this.serial}` : identity(this.options.allocateScopeIdentity()), resource, retiring: false };
        this.prepared = undefined;
        return this.opened();
      }
      case 'scope.open': {
        if (args['source'] !== 'connect' || args['context'] !== 'persistent') fail('isolated scope.open is not an interop substitute');
        if (this.scope !== undefined || this.prepared !== undefined) fail('scope already owned');
        this.prepareManager('connect');
        const resource = this.contexts.find(context => context.alive && context.persistent) ?? this.allocate(true);
        this.scope = { identityScope: this.options.allocateScopeIdentity === undefined ? `unit-scope-${++this.serial}` : identity(this.options.allocateScopeIdentity()), resource, retiring: false };
        return this.opened();
      }
      case 'scope.interop.identify': {
        exact(args, ['identityScope']); const scope = this.ownedScope(args);
        if (!scope.resource.alive || !scope.resource.pageAlive) fail('cannot identify a destroyed context or page');
        return { data: { contextId: scope.resource.contextId, targetId: scope.resource.targetId, persistent: scope.resource.persistent } };
      }
      case 'scope.interop.retire': {
        exact(args, ['identityScope', 'contextId']); const scope = this.ownedScope(args);
        if (scope.resource.persistent || args['contextId'] !== scope.resource.contextId || !scope.resource.alive || scope.retiring) fail('retire requires the exact live isolated context');
        scope.retiring = true;
        return { data: null };
      }
      case 'scope.interop.abort': {
        exact(args, ['preparationId']);
        if (this.prepared === undefined || args['preparationId'] !== this.prepared) fail('wrong preparation ticket');
        this.prepared = undefined; return { data: null };
      }
      case 'scope.end': {
        if (this.replacement !== undefined) fail('replacement operation still owns its scope');
        exact(args, ['identityScope']); const scope = this.ownedScope(args);
        if (!scope.resource.persistent && (!scope.retiring || scope.resource.alive)) fail('isolated scope.end precedes retire and native-context destruction');
        this.scope = undefined; return { data: null };
      }
      default: {
        const outcome = domain?.(request);
        const checked = (value: PeerOutcome | undefined): PeerOutcome => { if (value === undefined) fail(`unexpected command ${command}`); return value; };
        return outcome instanceof Promise ? outcome.then(checked) : checked(outcome);
      }
    }
  }
  /** Called only for the framed terminal Close, not transport disposal/errors. */
  closeNative(): void {
    this.events.push('native-close');
    // A borrowed host is not ours to terminate. Its pre-adopt PW allocation
    // survives native Close until PW's disposeOnDetach or context.close receipt.
    for (const context of this.contexts) {
      if (context.alive && !context.persistent && context.manager === this.manager && (context.manager.ownsProcess || context.nativeAdopted)) this.destroyNativeContext(context.contextId);
    }
    if (this.manager?.ownsProcess === true) for (const session of this.sessions) if (session.client.manager === this.manager) this.closeSession(session);
    this.scope = undefined; this.prepared = undefined; this.replacement = undefined; this.manager = undefined;
  }
  /** Native reset/restore destroys the resource, NOT the PW registry entry.
   * A later wrapper.close() must fail rather than manufacture a close event. */
  destroyNativeContext(contextId: string): void {
    const resource = this.contexts.find(context => context.contextId === contextId && context.alive);
    if (resource === undefined) fail('cannot destroy an unknown native context');
    resource.alive = false; resource.pageAlive = false; this.events.push(`native-context-destroyed:${contextId}`);
    for (const session of this.sessions) if (session.resource === resource) this.closeSession(session);
  }
  /** Explicit fake for chromium.connectOverCDP. Never opens a socket. */
  async connectPlaywright(endpoint: unknown): Promise<Browser> {
    if (endpoint !== this.endpoint) fail('unexpected CDP endpoint');
    if (this.prepared === undefined && this.scope?.resource.persistent !== true) fail('PW connected without preparation or a persistent scope');
    if (this.manager === undefined) fail('PW connected without a native manager');
    const client = { manager: this.manager, connected: true, wrappers: [] as Wrapper[], browser: undefined as unknown as Browser };
    const connected = () => { if (!client.connected) fail('PW client is disconnected'); };
    const events = new EventEmitter();
    const browser = {
      isConnected: () => client.connected,
      on: (event: string, listener: () => void) => { if (event !== 'disconnected') fail(`unexpected browser event ${event}`); events.on(event, listener); return browser; },
      off: (event: string, listener: () => void) => { if (event !== 'disconnected') fail(`unexpected browser event ${event}`); events.off(event, listener); return browser; },
      contexts: () => client.wrappers.filter(wrapper => !wrapper.closed).map(wrapper => wrapper.context),
      newContext: vi.fn(async (_options?: unknown) => {
        connected();
        const replacement = this.replacement;
        const replacing = replacement?.phase === 'create' && replacement.owner === client && replacement.allocation === undefined;
        if ((this.prepared === undefined && !replacing) || this.manager !== client.manager || this.contexts.some(context => context.alive && !context.persistent && context.manager === client.manager)) fail('PW context created outside the prepared allocation');
        const resource = this.allocate(false);
        if (replacing) replacement.allocation = resource;
        return this.wrap(client, resource).context;
      }),
      newBrowserCDPSession: async () => {
        connected();
        return this.session(client, undefined, command => {
          if (command !== 'Target.getBrowserContexts') fail(`unexpected browser CDP command ${command}`);
          return { browserContextIds: this.contexts.filter(context => context.alive && !context.persistent).map(context => context.contextId), defaultBrowserContextId: this.contexts.find(context => context.alive && context.persistent)?.contextId };
        });
      },
      close: async () => {
        if (!client.connected) return;
        client.connected = false; this.events.push('pw-disconnect');
        for (const session of this.sessions) if (session.client === client) this.closeSession(session);
        for (const wrapper of client.wrappers) {
          if (wrapper.resource.alive && !wrapper.resource.persistent) this.destroyNativeContext(wrapper.resource.contextId);
          this.closeWrapper(wrapper);
        }
        events.emit('disconnected', browser);
      },
    } as unknown as Browser;
    client.browser = browser; this.clients.push(client); this.events.push('pw-connect');
    if (this.scope?.resource.persistent === true) this.wrap(client, this.scope.resource);
    return browser;
  }
  private prepareManager(source: string): void {
    if (source === 'reuse') {
      if (this.manager === undefined) fail('reuse requires an existing native manager');
      return;
    }
    if (source !== 'launch' && source !== 'connect') fail('unknown manager source');
    if (this.manager !== undefined) fail('an existing manager must use source reuse');
    this.manager = { ownsProcess: source === 'launch' };
  }
  private allocate(persistent: boolean): NativeContext {
    if (this.manager === undefined) fail('context allocation requires a native manager');
    const id = ++this.serial;
    const ids = this.options.allocateContextIdentity?.(++this.allocations, persistent) ?? { contextId: `unit-context-${id}`, targetId: `unit-target-${id}` };
    identity(ids.contextId); identity(ids.targetId);
    if (this.contexts.some(resource => resource.contextId === ids.contextId) || this.targetIds.has(ids.targetId)) fail('context or target identity was already allocated');
    this.targetIds.add(ids.targetId);
    const resource = { manager: this.manager, nativeAdopted: false, ...ids, persistent, alive: true, pageAlive: persistent };
    this.contexts.push(resource); this.events.push(`native-context-created:${resource.contextId}`); return resource;
  }
  private ownedScope(args: PeerRequest['args']): Scope {
    if (this.scope === undefined || text(args, 'identityScope') !== this.scope.identityScope) fail('wrong scope identity');
    return this.scope;
  }
  private ownedReplacement(expectedScope: string, operationSeq: number): Replacement {
    const scope = this.ownedScope({ identityScope: expectedScope });
    const replacement = this.replacement;
    if (replacement === undefined || replacement.scope !== scope || replacement.operationSeq !== operationSeq) fail('wrong replacement operation identity');
    return replacement;
  }
  private opened(): PeerOutcome {
    const scope = this.scope!;
    return { data: { identityScope: scope.identityScope, recoveryIdentity: { browser: this.options.browserIdentity ?? 'unit-browser', context: scope.resource.contextId, page: scope.resource.targetId } } };
  }
  /** Sessions are exact client/target objects, independent of PW wrappers.
   * Closing a native target emits its sessions' close receipt without faking a
   * context.close event. Browser sessions remain until their client/process ends. */
  private session(client: Client, resource: NativeContext | undefined, send: (command: string) => unknown): CDPSession {
    const state = { client, resource, targetId: resource?.targetId, closed: false, events: new EventEmitter(), session: undefined as unknown as CDPSession };
    const live = () => { if (state.closed) fail('CDP session was closed'); };
    const session = {
      send: async (command: string) => { live(); return send(command); },
      detach: async () => { live(); this.closeSession(state); },
      on: (event: string, listener: (closed: CDPSession) => void) => { if (event !== 'close') fail(`unexpected CDP session event ${event}`); state.events.on(event, listener); return session; },
      off: (event: string, listener: (closed: CDPSession) => void) => { if (event !== 'close') fail(`unexpected CDP session event ${event}`); state.events.off(event, listener); return session; },
    } as unknown as CDPSession;
    state.session = session; this.sessions.push(state);
    return session;
  }
  private closeSession(state: Session): void {
    if (state.closed) return;
    state.closed = true;
    this.events.push(`cdp-session-closed:${state.targetId ?? 'browser'}`);
    // Playwright 1.64.1 emits the exact public CDPSession as the event argument.
    state.events.emit('close', state.session);
  }
  private closeWrapper(wrapper: Wrapper): void {
    if (wrapper.closed) return;
    wrapper.closed = true; this.events.push(`pw-context-closed:${wrapper.resource.contextId}`);
    (wrapper.page as unknown as EventEmitter).emit('close', wrapper.page);
    wrapper.events.emit('close');
  }
  private wrap(client: Client, resource: NativeContext): Wrapper {
    const wrapper = { resource, closed: false, events: new EventEmitter(), context: undefined as unknown as BrowserContext, page: undefined as unknown as Page };
    const live = () => { if (!client.connected || wrapper.closed || !resource.alive) fail('PW wrapper names a destroyed native context'); };
    const context = {
      browser: () => client.browser,
      isClosed: () => wrapper.closed,
      pages: () => !wrapper.closed && resource.pageAlive && resource.alive ? [wrapper.page] : [],
      newPage: async () => { live(); if (resource.pageAlive) fail('only the reserved page is modeled'); resource.pageAlive = true; this.events.push(`native-page-created:${resource.targetId}`); return wrapper.page; },
      addInitScript: vi.fn(async (_source: unknown, _arg?: unknown) => { live(); if (this.replacement?.allocation === resource && !resource.nativeAdopted) fail('user script precedes replacement adoption'); this.events.push(`pw-init-script:${resource.contextId}`); }),
      newCDPSession: async (page: Page) => {
        live(); if (page !== wrapper.page || !resource.pageAlive) fail('CDP session does not name the exact page');
        return this.session(client, resource, command => {
          live(); if (command !== 'Target.getTargetInfo') fail(`unexpected page CDP command ${command}`);
          return { targetInfo: { type: 'page', targetId: resource.targetId, browserContextId: resource.contextId } };
        });
      },
      close: async () => {
        if (wrapper.closed) return;
        live(); this.destroyNativeContext(resource.contextId); this.closeWrapper(wrapper);
      },
      on: (event: string, listener: () => void) => { wrapper.events.on(event, listener); return wrapper.context; },
      off: (event: string, listener: () => void) => { wrapper.events.off(event, listener); return wrapper.context; },
    } as unknown as BrowserContext;
    wrapper.context = context;
    wrapper.page = this.pageWrapper(wrapper);
    client.wrappers.push(wrapper); this.events.push(`pw-context-created:${resource.contextId}`); return wrapper;
  }
  private pageWrapper(wrapper: Wrapper): Page {
    const resource = wrapper.resource; const targetId = resource.targetId;
    const closed = () => !resource.alive || !resource.pageAlive || wrapper.closed || resource.targetId !== targetId;
    const live = () => { if (closed()) fail('PW Page names a destroyed native target'); };
    return Object.assign(new EventEmitter(), {
      context: () => wrapper.context, url: () => 'about:blank', isClosed: closed,
      close: async () => { if (!closed()) this.closeNativePage(resource, targetId); },
      setViewportSize: vi.fn(async (_value: unknown) => { live(); }),
      emulateMedia: vi.fn(async (_value: unknown) => { live(); }),
    }) as unknown as Page;
  }
}
