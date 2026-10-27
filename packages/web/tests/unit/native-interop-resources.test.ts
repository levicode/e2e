/** Synthetic ownership tests only; production PW identity/binding code stays real. */
import { chromium } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue, OperationContext } from 'e2e/engine';
import { NativeInteropResources, type NativeInteropResourceOptions } from '../helpers/native-interop-resources.ts';
import { createReplacementOperation } from '../helpers/native-interop-replacement.ts';
import { NativeProtocolPeer, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { NativeProtocolPeer as RetirementProtocolPeer } from '../helpers/retirement-protocol-peer.ts';
import { FinalizedRecordingPeer } from '../helpers/native-finalized-recording-peer.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { bindPersistentPlaywrightContext, connectPlaywrightClient, createPlaywrightContext } from '../../src/native/playwright-binding.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'unit-interop', attemptId: 'attempt', origin: 'test' });
const creation = { source: 'launch', context: 'isolated', headless: true, blockServiceWorkers: false, viewport: { width: 1280, height: 720 }, media: {}, initScripts: [] } as const;
const prepare = { ...creation, preparationId: 'unit-ticket' };
const request = (command: string, args: Record<string, JsonValue>): PeerRequest => ({ type: 'request', id: 'direct', generation: 1, operationSeq: 1, command, args });
afterEach(() => vi.restoreAllMocks());

async function fixture(options: NativeInteropResourceOptions = {}) {
  const resources = new NativeInteropResources(options);
  const connectPW = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(endpoint => resources.connectPlaywright(endpoint));
  const peer = new NativeProtocolPeer([], call => resources.respond(call), { close: () => resources.closeNative() });
  const client = await peer.connect(operation(), () => {});
  const engine = new EngineChannel(client);
  return { resources, peer, client, engine, connectPW };
}

it('prepare refusal owns no PW client/context and preserves the exact wire stage', async () => {
  const { resources, peer, client, engine, connectPW } = await fixture();
  resources.refuseNext('scope.interop.prepare', 'policy-denied');
  try {
    await expect(engine.command('scope.interop.prepare', prepare, operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(peer.requests.map(call => call.command)).toEqual(['scope.interop.prepare']);
    expect(connectPW).not.toHaveBeenCalled();
    expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 0 });
  } finally { await client.close(operation()); }
});

it('adopt refusal retains preparation plus PW custody until distinct native Close and PW disconnect receipts', async () => {
  const { resources, peer, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  resources.refuseNext('scope.interop.adopt', 'policy-denied');
  await expect(engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(peer.requests.map(call => call.command)).toEqual(['scope.interop.prepare', 'scope.interop.adopt']);
  expect(resources.snapshot()).toEqual({ prepared: true, nativeContexts: 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
  await client.close(operation());
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
  await expect(binding.context.close()).rejects.toThrow('destroyed native context');
  expect(browser.contexts()).toEqual([binding.context]);
  await browser.close();
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 1 });
});

it('uses exact ticket/context/target IDs and two retirement phases with real wrapper bookkeeping', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  try {
    const ids = { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId };
    for (const wrong of [{ ...ids, preparationId: 'wrong' }, { ...ids, contextId: 'wrong' }, { ...ids, targetId: 'wrong' }]) {
      expect(() => resources.respond(request('scope.interop.adopt', wrong))).toThrow('Synthetic interop resource contract');
    }
    const opened = await engine.command('scope.interop.adopt', ids, operation());
    expect(opened.recoveryIdentity).toEqual({ browser: 'unit-browser', context: binding.contextId, page: binding.targetId });
    await expect(engine.command('scope.interop.identify', { identityScope: opened.identityScope }, operation())).resolves.toEqual({ contextId: binding.contextId, targetId: binding.targetId, persistent: false });
    expect(() => resources.respond(request('scope.end', { identityScope: opened.identityScope }))).toThrow('precedes retire');
    expect(() => resources.respond(request('scope.interop.retire', { identityScope: opened.identityScope, contextId: 'wrong' }))).toThrow('exact live isolated context');
    await engine.command('scope.interop.retire', { identityScope: opened.identityScope, contextId: binding.contextId }, operation());
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 0 });
    const onClose = vi.fn(); binding.context.on('close', onClose);
    await binding.context.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(browser.contexts()).toEqual([]);
    await engine.command('scope.end', { identityScope: opened.identityScope }, operation());
    expect(resources.snapshot()).toMatchObject({ prepared: false, nativeContexts: 0, playwrightContexts: 0, contextCloseEvents: 1 });
  } finally { await client.close(operation()); await browser.close(); }
});

it('persistent identify binds only the actual borrowed default-context and target pair', async () => {
  const { resources, client, engine } = await fixture();
  const opened = await engine.command('scope.open', { ...creation, source: 'connect', context: 'persistent', endpoint: resources.endpoint }, operation());
  const ids = await engine.command('scope.interop.identify', { identityScope: opened.identityScope }, operation());
  expect(ids).toEqual({ contextId: opened.recoveryIdentity.context, targetId: opened.recoveryIdentity.page, persistent: true });
  const browser = await connectPlaywrightClient(resources.endpoint, operation());
  try {
    await expect(bindPersistentPlaywrightContext(browser, { ...ids, contextId: 'sibling' }, operation())).rejects.toThrow('default context identity changed');
    await expect(bindPersistentPlaywrightContext(browser, { ...ids, targetId: 'sibling' }, operation())).rejects.toThrow('original persistent Page no longer exists');
    const binding = await bindPersistentPlaywrightContext(browser, ids, operation());
    expect(binding.context).toBe(browser.contexts()[0]); expect(binding.page).toBe(binding.context.pages()[0]);
    await engine.command('scope.end', { identityScope: opened.identityScope }, operation());
    await browser.close();
    expect(binding.context.pages()).toEqual([]);
    expect(binding.page.isClosed()).toBe(true);
  } finally { await client.close(operation()); await browser.close(); }
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 1, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 1 });
});

it.each(['reset', 'restore'])('does not turn native-only %s destruction into a successful PW wrapper close', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  const onClose = vi.fn(); binding.context.on('close', onClose);
  resources.destroyNativeContext(binding.contextId);
  expect(browser.contexts()).toEqual([binding.context]);
  expect(onClose).not.toHaveBeenCalled();
  await expect(binding.context.close()).rejects.toThrow('destroyed native context');
  expect(onClose).not.toHaveBeenCalled();
  expect(resources.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 1, contextCloseEvents: 0 });
  await client.close(operation()); await browser.close();
});

it('rejects unknown wire/CDP commands instead of acknowledging unmodeled behavior', async () => {
  const { resources, client, engine } = await fixture();
  expect(() => resources.respond(request('scope.typographical-error', {}))).toThrow('unexpected command');
  expect(() => resources.respond(request('scope.reset', {}))).toThrow('unexpected command scope.reset');
  expect(() => resources.respond(request('state.restore', {}))).toThrow('unexpected command state.restore');
  expect(() => resources.respond(request('scope.open', { ...creation, initScripts: [] }))).toThrow('not an interop substitute');
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  try {
    const binding = await createPlaywrightContext(browser, creation, operation());
    const session = await binding.context.newCDPSession(binding.page);
    await expect(session.send('Page.enable')).rejects.toThrow('unexpected page CDP command');
    await session.detach();
  } finally { await client.close(operation()); await browser.close(); }
});

it('protocol failure and transport disposal are not a native Close receipt and cannot clear allocated custody', async () => {
  const { resources, peer, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  await createPlaywrightContext(browser, creation, operation());
  peer.protocolFailure();
  await new Promise<void>(resolve => setImmediate(resolve));
  await expect(client.close(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(resources.events).not.toContain('native-close');
  expect(resources.snapshot()).toEqual({ prepared: true, nativeContexts: 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
  await browser.close();
  // PW disconnect disposes its own context, but cannot acknowledge the ticket.
  expect(resources.snapshot()).toEqual({ prepared: true, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 1 });
});

it('preparation abort requires its exact live ticket and does not grant PW allocation', async () => {
  const resources = new NativeInteropResources();
  resources.respond(request('scope.interop.prepare', { ...prepare, initScripts: [] }));
  expect(() => resources.respond(request('scope.interop.prepare', { ...prepare, initScripts: [] }))).toThrow('already owned');
  expect(() => resources.respond(request('scope.interop.abort', { preparationId: 'wrong' }))).toThrow('wrong preparation ticket');
  expect(resources.respond(request('scope.interop.abort', { preparationId: prepare.preparationId }))).toEqual({ data: null });
  expect(() => resources.respond(request('scope.interop.abort', { preparationId: prepare.preparationId }))).toThrow('wrong preparation ticket');
  await expect(resources.connectPlaywright(resources.endpoint)).rejects.toThrow('without preparation');
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 0 });
});

it('will not adopt a context before PW has created the exact reserved page', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  try {
    const context = await browser.newContext();
    expect(context.pages()).toEqual([]);
    // Deliberately guess this deterministic model's IDs: knowledge of an ID is
    // not proof that newPage allocated its corresponding native target.
    const ids = { preparationId: prepared.preparationId, contextId: 'unit-context-1', targetId: 'unit-target-1' };
    expect(() => resources.respond(request('scope.interop.adopt', ids))).toThrow('live PW allocation');
    expect(resources.snapshot()).toMatchObject({ prepared: true, nativeContexts: 1, playwrightContexts: 1 });
    const page = await context.newPage();
    expect(context.pages()).toEqual([page]);
    await expect(engine.command('scope.interop.adopt', ids, operation())).resolves.toMatchObject({ recoveryIdentity: { context: ids.contextId, page: ids.targetId } });
  } finally { await client.close(operation()); await browser.close(); }
});

it.each(['disconnect', 'context-close'] as const)('borrowed pre-adopt resources survive native Close until their PW %s receipt', async release => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', { ...prepare, source: 'connect', endpoint: resources.endpoint }, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  resources.refuseNext('scope.interop.adopt', 'policy-denied');
  await expect(engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(resources.snapshot()).toEqual({ prepared: true, nativeContexts: 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
  try {
    await client.close(operation());
    // Native owns neither the borrowed process nor this preflight-refused context.
    expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
    expect(browser.contexts()).toEqual([binding.context]);
    expect(binding.context.pages()).toEqual([binding.page]);
    expect(binding.page.isClosed()).toBe(false);
    if (release === 'context-close') await binding.context.close();
    else await browser.close();
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 0, contextCloseEvents: 1 });
  } finally { await browser.close(); }
});

it('native Close may destroy an adopted isolated context without owning its borrowed host process', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', { ...prepare, source: 'connect', endpoint: resources.endpoint }, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  await engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation());
  try {
    await client.close(operation());
    expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 0 });
    await expect(binding.context.close()).rejects.toThrow('destroyed native context');
  } finally { await browser.close(); }
});

it.each(['launch', 'connect'] as const)('reuse inherits %s manager ownership rather than acquiring process ownership', async source => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', source === 'connect' ? { ...prepare, source, endpoint: resources.endpoint } : prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const first = await createPlaywrightContext(browser, creation, operation());
  const opened = await engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: first.contextId, targetId: first.targetId }, operation());
  await engine.command('scope.interop.retire', { identityScope: opened.identityScope, contextId: first.contextId }, operation());
  await first.context.close();
  await engine.command('scope.end', { identityScope: opened.identityScope }, operation());
  const reused = await engine.command('scope.interop.prepare', { ...prepare, source: 'reuse', preparationId: 'unit-reuse-ticket' }, operation());
  const second = await createPlaywrightContext(browser, creation, operation());
  resources.refuseNext('scope.interop.adopt', 'policy-denied');
  await expect(engine.command('scope.interop.adopt', { preparationId: reused.preparationId, contextId: second.contextId, targetId: second.targetId }, operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  try {
    await client.close(operation());
    expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: source === 'launch' ? 0 : 1, playwrightClients: 1, playwrightContexts: 1, contextCloseEvents: 1 });
    expect(second.page.isClosed()).toBe(source === 'launch');
  } finally { await browser.close(); }
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 2 });
});

it('rejects source reuse before any manager exists', () => {
  const resources = new NativeInteropResources();
  expect(() => resources.respond(request('scope.interop.prepare', { ...prepare, source: 'reuse', initScripts: [] }))).toThrow('existing native manager');
  expect(resources.snapshot()).toEqual({ prepared: false, nativeContexts: 0, playwrightClients: 0, playwrightContexts: 0, contextCloseEvents: 0 });
});

it('retains exact PW settings and script arguments for opting-in domain assertions', async () => {
  const { resources, client, engine, connectPW } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const options = { ...creation, blockServiceWorkers: true, viewport: { width: 640, height: 480 }, userAgent: 'unit-agent', locale: 'en-GB', timezoneId: 'Europe/London', media: { colorScheme: 'dark', reducedMotion: 'reduce' } } as const;
  const binding = await createPlaywrightContext(browser, options, operation());
  try {
    expect(connectPW).toHaveBeenCalledWith(resources.endpoint, { timeout: 1000, noDefaults: true });
    expect(browser.newContext).toHaveBeenCalledWith({ viewport: options.viewport, userAgent: options.userAgent, locale: options.locale, timezoneId: options.timezoneId, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
    await binding.context.addInitScript('globalThis.unit = 7');
    await binding.page.setViewportSize({ width: 320, height: 240 });
    await binding.page.emulateMedia({ colorScheme: 'light' });
    expect(binding.context.addInitScript).toHaveBeenCalledExactlyOnceWith('globalThis.unit = 7');
    expect(binding.page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 320, height: 240 });
    expect(binding.page.emulateMedia).toHaveBeenCalledExactlyOnceWith({ colorScheme: 'light' });
  } finally { await client.close(operation()); await browser.close(); }
});

it('reconnecting a borrowed persistent manager does not invent a fresh default context', async () => {
  const { resources, client, engine } = await fixture();
  const options = { ...creation, source: 'connect', context: 'persistent', endpoint: resources.endpoint } as const;
  const first = await engine.command('scope.open', options, operation());
  const browser = await connectPlaywrightClient(resources.endpoint, operation());
  await client.close(operation()); await browser.close();
  const nextPeer = new NativeProtocolPeer([], call => resources.respond(call), { close: () => resources.closeNative() });
  const nextClient = await nextPeer.connect(operation(), () => {});
  const nextEngine = new EngineChannel(nextClient);
  try {
    const next = await nextEngine.command('scope.open', options, operation());
    expect(next.identityScope).not.toBe(first.identityScope);
    expect(next.recoveryIdentity).toEqual(first.recoveryIdentity);
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 0 });
  } finally { await nextClient.close(operation()); }
});

it('supports explicit endpoint/exact identity fixtures without conflating repeated scope strings with resources', async () => {
  const { resources, client, engine } = await fixture({ endpoint: 'ws://explicit-peer.invalid/browser', browserIdentity: 'fixture-browser', allocateContextIdentity: n => ({ contextId: `fixture-context-${n}`, targetId: `fixture-target-${n}` }), allocateScopeIdentity: () => 'deliberately-repeated-scope' });
  expect(resources.currentIdentity()).toBeUndefined();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  try {
    for (const n of [1, 2]) {
      if (n > 1) await engine.command('scope.interop.prepare', { ...prepare, source: 'reuse', preparationId: `ticket-${n}` }, operation());
      const binding = await createPlaywrightContext(browser, creation, operation());
      const opened = await engine.command('scope.interop.adopt', { preparationId: n === 1 ? prepared.preparationId : `ticket-${n}`, contextId: binding.contextId, targetId: binding.targetId }, operation());
      expect(opened).toEqual({ identityScope: 'deliberately-repeated-scope', recoveryIdentity: { browser: 'fixture-browser', context: `fixture-context-${n}`, page: `fixture-target-${n}` } });
      expect(resources.currentIdentity()).toEqual({ ...opened, contextId: binding.contextId, targetId: binding.targetId, persistent: false });
      const copy = resources.currentIdentity()!; copy.recoveryIdentity.context = 'mutated-copy';
      expect(resources.currentIdentity()!.recoveryIdentity.context).toBe(binding.contextId);
      await engine.command('scope.interop.retire', { identityScope: opened.identityScope, contextId: binding.contextId }, operation());
      await binding.context.close(); await engine.command('scope.end', { identityScope: opened.identityScope }, operation());
      expect(resources.currentIdentity()).toBeUndefined();
    }
  } finally { await client.close(operation()); await browser.close(); }
});

it('awaits only explicit async domain outcomes and rejects unknown or undefined replies', async () => {
  const resources = new NativeInteropResources();
  await expect(resources.respond(request('page.title', {}), async () => ({ data: { title: 'explicit domain' } }))).resolves.toEqual({ data: { title: 'explicit domain' } });
  await expect(resources.respond(request('scope.not-modeled', {}), async () => undefined)).rejects.toThrow('unexpected command');
  expect(resources.currentIdentity()).toBeUndefined();
});

it('persistent reconnect changes only an exact live scope and retains context/page ownership', async () => {
  const { resources, client, engine } = await fixture();
  const opened = await engine.command('scope.open', { ...creation, source: 'connect', context: 'persistent', endpoint: resources.endpoint }, operation());
  const before = resources.currentIdentity()!;
  expect(() => resources.reconnectScope('wrong-scope', 'next-scope')).toThrow('wrong scope');
  expect(resources.reconnectScope(opened.identityScope, 'next-scope')).toEqual({ identityScope: 'next-scope' });
  expect(resources.currentIdentity()).toEqual({ ...before, identityScope: 'next-scope' });
  expect(() => resources.respond(request('scope.end', { identityScope: opened.identityScope }))).toThrow('wrong scope');
  expect(() => resources.replaceNativeScope('next-scope', 'not-isolated')).toThrow('exact live isolated');
  await engine.command('scope.end', { identityScope: 'next-scope' }, operation());
  await client.close(operation());
});

it('legacy native-only replacement cannot manufacture a replacement PW wrapper or successful old-wrapper close', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  const opened = await engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation());
  try {
    expect(() => resources.reconnectScope(opened.identityScope, 'invalid-isolated-reconnect')).toThrow('exact live persistent');
    expect(() => resources.replaceNativeScope('wrong-scope', 'next-scope')).toThrow('wrong scope');
    expect(resources.replaceNativeScope(opened.identityScope, 'native-reset-scope')).toEqual({ identityScope: 'native-reset-scope' });
    expect(resources.currentIdentity()!.contextId).not.toBe(binding.contextId);
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 0 });
    expect(browser.contexts()).toEqual([binding.context]);
    await expect(binding.context.close()).rejects.toThrow('destroyed native context');
    expect(() => resources.respond(request('scope.interop.retire', { identityScope: 'native-reset-scope', contextId: binding.contextId }))).toThrow('exact live isolated');
    expect(() => resources.respond(request('scope.reset', { identityScope: 'native-reset-scope' }))).toThrow('unexpected command');
  } finally { await client.close(operation()); await browser.close(); }
});

it('retirement peer invokes only its captured Close hook after its held terminal receipt is released', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const close = vi.fn();
  const peer = new RetirementProtocolPeer([], () => ({ error: 'unsupported-command' }), { close });
  peer.holdCloseUntil(held);
  const client = await peer.connect(operation(), () => {});
  const closing = client.close(operation());
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(close).not.toHaveBeenCalled();
  release(); await closing;
  expect(close).toHaveBeenCalledOnce();
  peer.dispose(); expect(close).toHaveBeenCalledOnce();
  const unrelated = vi.fn(); new RetirementProtocolPeer([], () => ({ error: 'unsupported-command' }), { close: unrelated }).dispose();
  expect(unrelated).not.toHaveBeenCalled();
});

it('finalized-recording peer Close hook does not replace artifact replies or run on transport disposal', async () => {
  const close = vi.fn();
  const peer = new FinalizedRecordingPeer(undefined, undefined, { close });
  const client = await peer.connect();
  const engine = new EngineChannel(client);
  await expect(engine.command('scope.open', { ...creation, source: 'connect', context: 'persistent', endpoint: 'ws://artifact.invalid/browser' }, operation())).resolves.toEqual({ identityScope: 'attempt-scope', recoveryIdentity: { browser: 'browser', context: 'context', page: 'page' } });
  expect(close).not.toHaveBeenCalled();
  await client.close(operation()); expect(close).toHaveBeenCalledOnce();
  const untouched = vi.fn(); new FinalizedRecordingPeer(undefined, undefined, { close: untouched }).dispose();
  expect(untouched).not.toHaveBeenCalled();
});

it('persistent page reopen exposes a distinct exact Page without retargeting an old wrapper', async () => {
  const { resources, client, engine } = await fixture();
  const opened = await engine.command('scope.open', { ...creation, source: 'connect', context: 'persistent', endpoint: resources.endpoint }, operation());
  const ids = await engine.command('scope.interop.identify', { identityScope: opened.identityScope }, operation());
  const browser = await connectPlaywrightClient(resources.endpoint, operation());
  const old = await bindPersistentPlaywrightContext(browser, ids, operation());
  try {
    expect(() => resources.replaceNativePage('wrong-scope', ids.targetId, 'new-page')).toThrow('wrong scope');
    expect(() => resources.replaceNativePage(opened.identityScope, 'wrong-target', 'new-page')).toThrow('exact live target');
    const nextIds = resources.replaceNativePage(opened.identityScope, ids.targetId, 'new-page');
    expect(nextIds).toEqual({ contextId: ids.contextId, targetId: 'new-page' });
    expect(old.page.isClosed()).toBe(true);
    await expect(old.page.setViewportSize({ width: 10, height: 10 })).rejects.toThrow('destroyed native target');
    await expect(old.context.newCDPSession(old.page)).rejects.toThrow('exact page');
    const next = await bindPersistentPlaywrightContext(browser, nextIds, operation());
    expect(next.context).toBe(old.context); expect(next.page).not.toBe(old.page);
    expect(next.page.isClosed()).toBe(false);
    expect(() => resources.replaceNativePage(opened.identityScope, 'new-page', ids.targetId)).toThrow('already allocated');
    expect(() => resources.respond(request('scope.page-reopened', {}))).toThrow('unexpected command');
  } finally { await client.close(operation()); await browser.close(); }
});

it('isolated native page restart preserves its PW context but never retargets the old Page', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  const opened = await engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation());
  try {
    const next = resources.replaceNativePage(opened.identityScope, binding.targetId, 'isolated-restarted-page', 'restart-scope');
    expect(next.contextId).toBe(binding.contextId);
    expect(binding.page.isClosed()).toBe(true);
    expect(binding.context.pages()[0]).not.toBe(binding.page);
    expect(() => resources.respond(request('scope.interop.retire', { identityScope: opened.identityScope, contextId: binding.contextId }))).toThrow('wrong scope');
    await engine.command('scope.interop.retire', { identityScope: 'restart-scope', contextId: binding.contextId }, operation());
    await binding.context.close(); await engine.command('scope.end', { identityScope: 'restart-scope' }, operation());
  } finally { await client.close(operation()); await browser.close(); }
});

it('PW browser emits one real modeled disconnect event, never on native Close or after listener removal', async () => {
  const { resources, client, engine } = await fixture();
  const prepared = await engine.command('scope.interop.prepare', prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  await createPlaywrightContext(browser, creation, operation());
  const disconnected = vi.fn(() => { expect(browser.isConnected()).toBe(false); expect(browser.contexts()).toEqual([]); });
  const removed = vi.fn();
  expect(browser.on('disconnected', disconnected)).toBe(browser);
  browser.on('disconnected', removed); expect(browser.off('disconnected', removed)).toBe(browser);
  await client.close(operation());
  expect(browser.isConnected()).toBe(true); expect(disconnected).not.toHaveBeenCalled();
  await browser.close(); await browser.close();
  expect(disconnected).toHaveBeenCalledExactlyOnceWith(browser); expect(removed).not.toHaveBeenCalled();
  expect(resources.events.filter(event => event === 'pw-disconnect')).toHaveLength(1);
  browser.off('disconnected', disconnected);
});


async function replacementFixture(source: 'launch' | 'connect' = 'launch') {
  const fixtureState = await fixture();
  const prepared = await fixtureState.engine.command('scope.interop.prepare', source === 'connect' ? { ...prepare, source, endpoint: fixtureState.resources.endpoint } : prepare, operation());
  const browser = await connectPlaywrightClient(prepared.endpoint, operation());
  const binding = await createPlaywrightContext(browser, creation, operation());
  const opened = await fixtureState.engine.command('scope.interop.adopt', { preparationId: prepared.preparationId, contextId: binding.contextId, targetId: binding.targetId }, operation());
  return { ...fixtureState, browser, binding, opened };
}

it.each(['scope.reset', 'state.restore'])('explicit %s handoff uses actual PW retirement and a new allocation without a fresh prepare', async command => {
  const { resources, client, engine, browser, binding, opened } = await replacementFixture();
  const closeEvent = vi.fn(); binding.context.on('close', closeEvent);
  const phases: string[] = [];
  let replacement: Awaited<ReturnType<typeof createPlaywrightContext>> | undefined;
  const replace = createReplacementOperation(resources, { ...request(command, { identityScope: opened.identityScope }), operationSeq: 7, timeoutMs: 1000 }, async (payload, timeoutMs) => {
    expect(timeoutMs).toBeGreaterThan(0); expect(timeoutMs).toBeLessThanOrEqual(1000);
    phases.push(String(payload['phase']));
    if (payload['phase'] === 'retire') {
      expect(payload).toEqual({ version: 1, identityScope: opened.identityScope, operationSeq: 7, phase: 'retire', contextId: binding.contextId });
      expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 0 });
      await binding.context.close();
      return { kind: 'interop-retired' };
    }
    expect(payload).toEqual({ version: 1, identityScope: opened.identityScope, operationSeq: 7, phase: 'create' });
    expect(closeEvent).toHaveBeenCalledOnce(); expect(browser.contexts()).toEqual([]);
    expect(resources.snapshot()).toMatchObject({ prepared: false, nativeContexts: 0, playwrightContexts: 0 });
    replacement = await createPlaywrightContext(browser, creation, operation());
    expect(replacement.context).not.toBe(binding.context); expect(replacement.page).not.toBe(binding.page);
    await expect(replacement.context.addInitScript('before-adoption')).rejects.toThrow('precedes replacement adoption');
    return { kind: 'interop-created', contextId: replacement.contextId, targetId: replacement.targetId };
  });
  try {
    await expect(replace('replacement-scope')).resolves.toEqual({ data: { identityScope: 'replacement-scope', activatePage: command === 'scope.reset' } });
    expect(phases).toEqual(['retire', 'create']);
    expect(resources.snapshot()).toMatchObject({ prepared: false, nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 1 });
    expect(resources.events.filter(event => event === 'wire:scope.interop.prepare')).toHaveLength(1);
    expect(browser.newContext).toHaveBeenNthCalledWith(2, { viewport: creation.viewport, serviceWorkers: 'allow' });
    await replacement!.context.addInitScript('after-adoption');
    expect(replacement!.context.addInitScript).toHaveBeenLastCalledWith('after-adoption');
    await expect(replace('second-scope')).rejects.toThrow('already dispatched');
    await engine.command('scope.interop.retire', { identityScope: 'replacement-scope', contextId: replacement!.contextId }, operation());
    await replacement!.context.close(); await engine.command('scope.end', { identityScope: 'replacement-scope' }, operation());
  } finally { await client.close(operation()); await browser.close(); }
});

it('replacement cannot substitute native-only destruction for the original PW close receipt', async () => {
  const { resources, client, browser, binding, opened } = await replacementFixture();
  try {
    expect(() => resources.beginReplacement('foreign', 9)).toThrow('wrong scope');
    expect(() => resources.beginReplacement(opened.identityScope, 0)).toThrow('original operation sequence');
    resources.beginReplacement(opened.identityScope, 9);
    expect(() => resources.beginReplacement(opened.identityScope, 9)).toThrow('exact live isolated');
    expect(() => resources.acceptReplacementRetirement(opened.identityScope, 10)).toThrow('wrong replacement operation');
    expect(() => resources.acceptReplacementRetirement(opened.identityScope, 9)).toThrow('native absence and PW retirement');
    await expect(browser.newContext()).rejects.toThrow('outside the prepared allocation');
    resources.destroyNativeContext(binding.contextId);
    expect(() => resources.acceptReplacementRetirement(opened.identityScope, 9)).toThrow('native absence and PW retirement');
    await expect(binding.context.close()).rejects.toThrow('destroyed native context');
    expect(browser.contexts()).toEqual([binding.context]);
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 1, contextCloseEvents: 0 });
  } finally { await client.close(operation()); await browser.close(); }
});

it('replacement rejects early, old, and foreign adoption and grants only one same-owner allocation', async () => {
  const { resources, client, browser, binding, opened } = await replacementFixture();
  try {
    resources.beginReplacement(opened.identityScope, 11);
    const oldIds = { contextId: binding.contextId, targetId: binding.targetId };
    expect(() => resources.adoptReplacement(opened.identityScope, 11, oldIds, 'next', true)).toThrow('exact new live PW allocation');
    await binding.context.close(); resources.acceptReplacementRetirement(opened.identityScope, 11);
    expect(() => resources.acceptReplacementRetirement(opened.identityScope, 11)).toThrow('native absence and PW retirement');
    const next = await createPlaywrightContext(browser, creation, operation());
    const nextIds = { contextId: next.contextId, targetId: next.targetId };
    for (const ids of [oldIds, { ...nextIds, contextId: 'foreign' }, { ...nextIds, targetId: binding.targetId }]) expect(() => resources.adoptReplacement(opened.identityScope, 11, ids, 'next', true)).toThrow('exact new live PW allocation');
    expect(() => resources.adoptReplacement(opened.identityScope, 12, nextIds, 'next', true)).toThrow('wrong replacement operation');
    expect(() => resources.respond(request('scope.end', { identityScope: opened.identityScope }))).toThrow('replacement operation still owns');
    await expect(browser.newContext()).rejects.toThrow('outside the prepared allocation');
    await next.context.close();
    await expect(browser.newContext()).rejects.toThrow('outside the prepared allocation');
    expect(() => resources.adoptReplacement(opened.identityScope, 11, nextIds, 'next', true)).toThrow('exact new live PW allocation');
  } finally { await client.close(operation()); await browser.close(); }
});

it('a refused replacement candidate on a borrowed host remains PW custody after native Close', async () => {
  const { resources, client, browser, binding, opened } = await replacementFixture('connect');
  resources.beginReplacement(opened.identityScope, 12);
  await binding.context.close(); resources.acceptReplacementRetirement(opened.identityScope, 12);
  const next = await createPlaywrightContext(browser, creation, operation());
  expect(() => resources.adoptReplacement(opened.identityScope, 12, { contextId: 'foreign', targetId: next.targetId }, 'next', true)).toThrow('exact new live PW allocation');
  await client.close(operation());
  expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 1 });
  expect(next.page.isClosed()).toBe(false);
  expect(() => resources.acceptReplacementRetirement(opened.identityScope, 12)).toThrow('wrong scope');
  await browser.close();
  expect(resources.snapshot()).toMatchObject({ nativeContexts: 0, playwrightContexts: 0, contextCloseEvents: 2 });
});

it('replacement failure remains an explicit unknown result, not a successful ACK or implicit allocation', async () => {
  const { resources, client, browser, binding, opened } = await replacementFixture();
  try {
    const exchange = vi.fn(async () => ({ kind: 'interop-failed' }));
    const replace = createReplacementOperation(resources, { ...request('scope.reset', { identityScope: opened.identityScope }), timeoutMs: 1000 }, exchange);
    await expect(replace('unused')).resolves.toEqual({ error: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' });
    expect(exchange).toHaveBeenCalledOnce();
    expect(resources.currentIdentity()!.contextId).toBe(binding.contextId);
    expect(resources.snapshot()).toMatchObject({ nativeContexts: 1, playwrightContexts: 1, contextCloseEvents: 0 });
  } finally { await client.close(operation()); await browser.close(); }
});

it('held replacement dispatch consumes the original deadline rather than creating a new phase budget', async () => {
  const { resources, client, browser, opened } = await replacementFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const exchange = vi.fn(async () => ({ kind: 'interop-retired' }));
  const replace = createReplacementOperation(resources, { ...request('scope.reset', { identityScope: opened.identityScope }), timeoutMs: 100 }, exchange);
  now.mockReturnValue(10_101);
  try {
    await expect(replace('unused')).rejects.toThrow('original request deadline');
    expect(exchange).not.toHaveBeenCalled();
    expect(resources.events.some(event => event.startsWith('replacement-sealed:'))).toBe(false);
  } finally { now.mockRestore(); await client.close(operation()); await browser.close(); }
});


it('explicit peer decisions consume their token before the separately framed control ACK', async () => {
  const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-command' }));
  let settled = false; let deciding!: Promise<void>;
  const client = await peer.connect(operation(), event => {
    deciding = client.decide(event.decision!.token, { action: 'accept' }, operation()).then(() => { settled = true; });
    return deciding;
  });
  try {
    const selected = await peer.requestDecision('dialog.opened', { identityScope: 'scope', type: 'confirm', message: 'test' }, { token: 'exact-token', timeoutMs: 1000 });
    expect(selected).toEqual({ action: 'accept' });
    expect(settled).toBe(false);
    await deciding; expect(settled).toBe(true);
    expect(() => peer.requestDecision('dialog.opened', {}, { token: 'exact-token', timeoutMs: 1000 })).toThrow('fresh token');
    await expect(client.decide('exact-token', { action: 'accept' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(peer.frames.filter(frame => frame['type'] === 'decision')).toHaveLength(2);
  } finally { await client.close(operation()); }
});

it('an expired explicit peer token rejects selection without creating a successful ACK', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-command' }));
  let deciding!: Promise<unknown>;
  const client = await peer.connect(operation(), event => {
    now.mockReturnValue(2001);
    deciding = client.decide(event.decision!.token, { action: 'accept' }, operation()).catch(cause => cause);
    return deciding.then(() => {});
  });
  try {
    await expect(peer.requestDecision('dialog.opened', { identityScope: 'scope', type: 'confirm', message: 'test' }, { token: 'expired-token', timeoutMs: 1000 })).rejects.toThrow('token expired');
    await expect(deciding).resolves.toMatchObject({ code: 'ENGINE_FAILURE' });
  } finally { now.mockRestore(); await client.close(operation()); }
});

it('disposing an unanswered explicit decision rejects its waiter without a native Close receipt', async () => {
  const close = vi.fn();
  const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-command' }), { close });
  const pending = peer.requestDecision('dialog.opened', {}, { token: 'unanswered', timeoutMs: 1000 });
  peer.dispose();
  await expect(pending).rejects.toThrow('transport disposed');
  expect(close).not.toHaveBeenCalled();
  expect(() => peer.requestDecision('dialog.opened', {}, { token: 'after-dispose', timeoutMs: 1000 })).toThrow('fresh token');
});
