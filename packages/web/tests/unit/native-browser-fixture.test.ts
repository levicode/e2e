import { describe, expect, it } from 'vitest';
import { EngineError, type EngineFixtureContext, type OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap, NativeWebSurface } from '../../src/native/browser-contract.ts';

function fixture(initialRegistryVersion = 0) {
  let registryVersion = initialRegistryVersion;
  let scope = 'scope-1';
  const callbacks = new Map<string, Set<(event: never) => void | Promise<void>>>();
  const commands: { name: keyof BrowserCommandMap; args: unknown }[] = [];
  const decisions: { token: string; decision: BrowserDecision }[] = [];
  const signal = new AbortController().signal;
  const operation = (timeoutMs = 1000): OperationContext => ({ signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' });
  let invalidated: EngineError | undefined;
  const responders = new Map<keyof BrowserCommandMap, (args: unknown) => unknown | Promise<unknown>>();
  const surface: NativeWebSurface = {
    latch: new ErrorLatch(), get identityScope() { return scope; },
    latchCallbackFailure: (scope, error) => { if (scope === surface.identityScope) surface.latch.latch(error); },
    routeRegistryVersion: () => registryVersion,
    allocateRouteRegistryVersion: () => ++registryVersion,
    invalidate: () => invalidated ??= new EngineError('ENGINE_FAILURE', 'Native fixture contract invalidated', { retryable: false }),
    async command<K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args']): Promise<BrowserCommandMap[K]['result']> {
      if (invalidated !== undefined) throw invalidated;
      commands.push({ name, args });
      const responder = responders.get(name);
      // This fake is deliberately behind the separately tested runtime-decoding channel.
      return (responder === undefined ? name.endsWith('.subscribe') ? { subscriptionId: `subscription-${commands.length}` } : null : await responder(args)) as BrowserCommandMap[K]['result'];
    },
    subscribe(name, callback) {
      let entries = callbacks.get(name);
      if (entries === undefined) { entries = new Set(); callbacks.set(name, entries); }
      const entry = callback as (event: never) => void | Promise<void>;
      entries.add(entry);
      return () => { entries.delete(entry); };
    },
    async decide(token, decision) { decisions.push({ token, decision }); },
    projectPath: file => file,
    siteHeaders: () => ({ 'x-site': 'synthetic' }),
    artifactPath: () => { throw new Error('This fixture does not write artifacts'); },
  };
  const context = {
    operation, signal, timeouts: { action: 1000, test: 5000, assertion: 1000 },
    fixture: (_name: string, target: object) => target,
    expectable: (target: object) => target,
    app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
  } as unknown as EngineFixtureContext;
  const browser = createBrowserFixture(surface, context);
  const emit = async <K extends keyof BrowserEventMap>(name: K, event: BrowserEventMap[K]) => {
    await Promise.all([...callbacks.get(name) ?? []].map(callback => callback(event as never)));
  };
  return { browser, surface, commands, decisions, responders, emit, reset: () => { scope = 'scope-2'; } };
}

function request(token: string, version: number, registrationIds: string[]): BrowserEventMap['network.request'] {
  return { identityScope: 'scope-1', token, timeoutMs: 1000, version, registrationIds, request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } };
}

describe('native public browser fixture policy', () => {
  it('preserves the original matching chain across unrouteAll and fallback', async () => {
    const f = fixture();
    const called: string[] = [];
    await f.browser.route(/\/data$/u, async route => { called.push('older'); await route.fulfill({ json: { ok: true } }); });
    await f.browser.route('**/data', async route => { called.push('newer'); await f.browser.unrouteAll(); await route.fallback(); });
    await f.emit('network.request', request('first', 2, ['route-1', 'route-2']));
    await f.emit('network.request', { ...request('second', 2, ['route-1', 'route-2']), fallbackOf: 'first', request: { url: 'http://fixture.test/changed', method: 'GET', headers: {} } });
    expect(called).toEqual(['newer', 'older']);
    expect(f.decisions.map(entry => entry.decision.kind)).toEqual(['fallback', 'fulfill']);
    expect(f.commands.findLast(command => command.name === 'network.routes.replace')?.args).toEqual({ version: 3, registrationIds: [] });
  });

  it('reads a large fallback body alias without releasing native request ownership', async () => {
    const f = fixture();
    f.responders.set('network.body.read', () => ({ base64: Buffer.from('synthetic body').toString('base64'), nextOffset: 14, eof: true }));
    let body: string | undefined;
    await f.browser.route('**/data', async route => { body = route.request.postData; await route.continue(); });
    const event = request('body-token', 1, ['route-1']);
    await f.emit('network.request', { ...event, request: { ...event.request, postDataHandle: 'request-body-alias' } });
    expect(body).toBe('synthetic body');
    expect(f.commands.some(command => command.name === 'network.body.release')).toBe(false);
    expect(f.decisions[0]?.decision.kind).toBe('continue');
  });

  it('continues registry versions from the client lifetime instead of restarting at one', async () => {
    const f = fixture(41);
    await f.browser.route('**/data', route => route.abort());
    expect(f.commands.at(-1)?.args).toEqual({ version: 42, registrationIds: ['route-1'] });
    await f.emit('network.request', request('later-attempt', 42, ['route-1']));
    expect(f.decisions.at(-1)?.decision.kind).toBe('abort');
  });

  it('continues an exhausted chain with configured site headers', async () => {
    const f = fixture();
    await f.emit('network.request', request('empty', 0, []));
    expect(f.decisions[0]?.decision).toEqual({ kind: 'continue', overrides: { headers: [{ name: 'x-site', value: 'synthetic' }] } });
  });

  it('captures one response body eagerly for concurrent waiters and caches repeated reads', async () => {
    const f = fixture();
    f.responders.set('network.body.read', () => ({ base64: Buffer.from('{"ok":true}').toString('base64'), nextOffset: 11, eof: true }));
    const first = f.browser.waitForResponse('**/data');
    const second = f.browser.waitForResponse(/data$/u);
    await Promise.resolve();
    await f.emit('network.response', { identityScope: 'scope-1', activePage: true, handle: 'body', url: 'http://fixture.test/data', status: 200, headers: {} });
    const [one, two] = await Promise.all([first, second]);
    expect(f.commands.filter(command => command.name === 'network.body.read')).toHaveLength(1);
    Object.assign(one.headers, { 'x-caller': 'first-only' });
    expect(two.headers).not.toHaveProperty('x-caller');
    await expect(one.json()).resolves.toEqual({ ok: true });
    await expect(two.text()).resolves.toBe('{"ok":true}');
    expect(f.commands.filter(command => command.name === 'network.body.read')).toHaveLength(1);
    expect(f.commands.filter(command => command.name === 'network.responses.unsubscribe')).toHaveLength(2);
  });

  it('preserves a body read failure rather than reporting an empty successful body', async () => {
    const f = fixture();
    f.responders.set('network.body.read', () => { throw new Error('synthetic interrupted response'); });
    const waiting = f.browser.waitForResponse('**/data');
    await Promise.resolve();
    await f.emit('network.response', { identityScope: 'scope-1', activePage: true, handle: 'body', url: 'http://fixture.test/data', status: 200, headers: {} });
    const response = await waiting;
    await expect(response.text()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    await expect(response.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    expect(f.commands.filter(command => command.name === 'network.body.read')).toHaveLength(1);
  });

  it('permits nested browser reads in a route callback before and after its decision', async () => {
    const f = fixture();
    f.responders.set('page.title', () => ({ title: 'Synthetic' }));
    await f.browser.route('**/data', async route => {
      expect(await f.browser.title()).toBe('Synthetic');
      await route.fulfill({ body: 'done' });
      expect(await f.browser.title()).toBe('Synthetic');
    });
    await f.emit('network.request', request('nested', 1, ['route-1']));
    f.surface.latch.throwPending();
    expect(f.commands.filter(command => command.name === 'page.title')).toHaveLength(2);
  });
  it('stages large fulfilled bodies with exact hash and sequential chunks, transferring ownership once', async () => {
    const f = fixture();
    let identity: { size: number; sha256: string };
    f.responders.set('blob.create', args => { identity = args as typeof identity; return { ...identity, handle: 'large-body', maxChunkBytes: 65536 }; });
    f.responders.set('blob.write', args => { const chunk = args as { offset: number; base64: string }; return { nextOffset: chunk.offset + Buffer.from(chunk.base64, 'base64').length }; });
    f.responders.set('blob.seal', () => ({ ...identity, handle: 'large-body' }));
    await f.browser.route('**/data', route => route.fulfill({ body: 'x'.repeat(300000) }));
    await f.emit('network.request', request('large', 1, ['route-1']));
    f.surface.latch.throwPending();
    expect(f.decisions[0]?.decision).toMatchObject({ kind: 'fulfill', bodyHandle: 'large-body' });
    expect(f.decisions[0]?.decision).not.toHaveProperty('bodyBase64');
    expect(f.commands.filter(command => command.name === 'blob.write')).toHaveLength(5);
    expect(f.commands.filter(command => command.name === 'blob.release')).toHaveLength(0);
  });

  it('quarantines an unverified staged body instead of fulfilling it', async () => {
    const f = fixture();
    f.responders.set('blob.create', args => ({ ...args as object, handle: 'bad-body', maxChunkBytes: 65536 }));
    f.responders.set('blob.write', args => { const chunk = args as { offset: number; base64: string }; return { nextOffset: chunk.offset + Buffer.from(chunk.base64, 'base64').length }; });
    f.responders.set('blob.seal', () => ({ handle: 'bad-body', size: 0, sha256: '0'.repeat(64) }));
    f.responders.set('blob.release', () => ({ released: true }));
    await f.browser.route('**/data', route => route.fulfill({ body: 'x'.repeat(300000) }));
    await f.emit('network.request', request('bad', 1, ['route-1']));
    expect(() => f.surface.latch.throwPending()).toThrow('Native fixture contract invalidated');
    expect(f.decisions.map(entry => entry.decision.kind)).toEqual(['abort']);
    expect(f.commands.filter(command => command.name === 'blob.release')).toHaveLength(0); // Poisoned transport cannot send more commands.
  });

  it('preserves the primary response timeout when unsubscribe also fails', async () => {
    const f = fixture();
    f.responders.set('network.responses.unsubscribe', () => { throw new Error('synthetic cleanup failure'); });
    await expect(f.browser.waitForResponse('**/never', { timeout: 1 })).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    await expect(f.browser.title()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it.each([[], ['unknown'], ['route-1', 'route-1']].map(registrationIds => ({ registrationIds })))('never bypasses an abort route through a malformed captured registry $registrationIds', async ({ registrationIds }) => {
    const f = fixture();
    await f.browser.route('**/data', route => route.abort());
    await f.emit('network.request', request('malformed', 1, registrationIds));
    expect(() => f.surface.latch.throwPending()).toThrow('Native fixture contract invalidated');
    expect(f.decisions.map(entry => entry.decision.kind)).toEqual(['abort']);
  });

  it('latches the primary route failure before any secondary blob cleanup failure', async () => {
    const f = fixture();
    f.responders.set('blob.create', args => ({ ...args as object, handle: 'body', maxChunkBytes: 65536 }));
    f.responders.set('blob.write', args => { const chunk = args as { offset: number; base64: string }; return { nextOffset: chunk.offset + Buffer.from(chunk.base64, 'base64').length }; });
    f.responders.set('blob.seal', () => { throw new Error('primary sealing failure'); });
    f.responders.set('blob.release', () => { throw new Error('secondary cleanup failure'); });
    await f.browser.route('**/data', route => route.fulfill({ body: 'x'.repeat(300000) }));
    await f.emit('network.request', request('primary', 1, ['route-1']));
    expect(() => f.surface.latch.throwPending()).toThrow('primary sealing failure');
    await expect(f.browser.title()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('invalidates malformed native evaluation envelopes instead of reusing their session', async () => {
    const f = fixture();
    f.responders.set('page.evaluate', () => ({ value: { ok: 'not-a-boolean' } }));
    await expect(f.browser.evaluate(() => 1)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(f.browser.title()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('does not let an old response waiter consume replacement-scope events or clean up there', async () => {
    const f = fixture(); const pending = f.browser.waitForResponse('**/data', { timeout: 20 });
    const rejected = pending.catch((cause: unknown) => cause); await Promise.resolve(); f.reset();
    await f.emit('network.response', { identityScope: 'scope-2', activePage: true, handle: 'new-body', url: 'http://fixture.test/data', status: 200, headers: {} });
    expect(await rejected).toMatchObject({ code: 'ACTION_FAILED' });
    expect(f.commands.some(command => command.name === 'network.body.read' || command.name === 'network.responses.unsubscribe')).toBe(false);
    f.responders.set('context.cookies.get', () => ({ cookies: [] })); await expect(f.browser.cookies()).resolves.toEqual([]);
  });
  it('drops retired route callback failure instead of aborting or poisoning the replacement scope', async () => {
    const f = fixture(); let fail!: (cause: Error) => void;
    await f.browser.route('**/data', () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const event = f.emit('network.request', request('retired', 1, ['route-1'])); await Promise.resolve(); f.reset();
    fail(new Error('Synthetic retired callback')); await event;
    expect(f.decisions).toHaveLength(0); expect(() => f.surface.latch.throwPending()).not.toThrow();
  });

});
