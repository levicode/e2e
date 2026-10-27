/** Real public Browser identity-refresh assertions, not a browser emulator. */
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, JsonValue } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { PERSISTENT_PAGE_REOPEN_CAPABILITY } from '../../src/native/capabilities.ts';
import { NativeProtocolPeer, type PeerOutcome, type PeerRequest } from '../helpers/native-protocol-peer.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
let peer: NativeProtocolPeer | undefined;
const operation = () => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' as const });
const cleanup = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });
const context = (): EngineAttemptContext => ({ attemptId: 'a1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => { throw new Error('No secrets in identity fixture'); }, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
const identity = (page: string) => ({ browser: 'browser-1', context: 'context-1', page });
const refresh = (): Record<string, JsonValue> => ({ version: 1, identityScope: 'scope-1', previousPageIdentity: 'page-1', recoveryIdentity: identity('page-2') });
async function fixture(custom?: (frame: PeerRequest) => PeerOutcome | Promise<PeerOutcome> | undefined) {
  vi.mocked(connectNativeProcess).mockImplementation(async (settings, budget, onEvent) => {
    expect(settings.capabilities).toContain(PERSISTENT_PAGE_REOPEN_CAPABILITY);
    peer = new NativeProtocolPeer(settings.capabilities, frame => {
      const response = custom?.(frame);
      if (response !== undefined) return response;
      if (frame.command === 'scope.open') return { data: { identityScope: 'scope-1', recoveryIdentity: identity('page-1') } };
      if (frame.command === 'scope.reconnect') return { data: { identityScope: 'scope-reconnected' } };
      if (frame.command === 'page.title') return { data: { title: 'current title' } };
      if (frame.command === 'blob.release') return { data: { released: true } };
      if (frame.command === 'session.environment') return { data: { identityScope: 'scope-1', browser: 'Chromium/156.0' } };
      if (['scope.configure', 'network.routes.replace', 'scope.end', 'page.navigate'].includes(frame.command)) return { data: null };
      throw new Error(`Unexpected identity fixture command ${frame.command}`);
    });
    return peer.connect(budget, onEvent);
  });
  const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/open', reconnectEndpoint: () => 'ws://synthetic.test/reconnect' } });
  await engine.init!({ runId: 'run', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
  await engine.startAttempt!(context());
  return engine;
}
beforeEach(() => { vi.mocked(connectNativeProcess).mockReset(); peer = undefined; });
afterEach(() => { peer?.dispose(); vi.restoreAllMocks(); });
it('refreshes the exact page identity on adjacent event/result frames and reconnects to the reopened page', async () => {
  let delivery: Promise<void> | undefined;
  const engine = await fixture(frame => {
    if (frame.command === 'page.navigate') {
      // Do not wait for event consumption before queuing the result: exercise
      // the real client's ordering when both frames are adjacent in its stream.
      delivery = peer!.event('scope.page-reopened', refresh());
      return { data: null };
    }
    return undefined;
  });
  try {
    const browser = nativeBrowser(engine, operation);
    await browser.goto('https://synthetic.test/reopened');
    await expect(browser.title()).resolves.toBe('current title');
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await expect(browser.title()).resolves.toBe('current title');
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args).toEqual({ identityScope: 'scope-1', endpoint: 'ws://synthetic.test/reconnect', expectedBrowserIdentity: 'browser-1', expectedContextIdentity: 'context-1', expectedPageIdentity: 'page-2' });
    expect(peer!.frames.find(frame => frame['type'] === 'hello')?.['requiredCapabilities']).toContain(PERSISTENT_PAGE_REOPEN_CAPABILITY);
    await delivery;
  } finally { await engine.dispose!(cleanup()); }
});
it('ignores an old-scope identity refresh instead of overwriting the current page', async () => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', { ...refresh(), identityScope: 'retired-scope' });
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await nativeBrowser(engine, operation).title();
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args['expectedPageIdentity']).toBe('page-1');
  } finally { await engine.dispose!(cleanup()); }
});
it.each([
  ['wrong previous page', { ...refresh(), previousPageIdentity: 'foreign-page' }],
  ['wrong context', { ...refresh(), recoveryIdentity: { ...identity('page-2'), context: 'foreign-context' } }],
  ['wrong browser', { ...refresh(), recoveryIdentity: { ...identity('page-2'), browser: 'foreign-browser' } }],
  ['wrong version', { ...refresh(), version: 2 }],
  ['unchanged page', { ...refresh(), recoveryIdentity: identity('page-1') }],
  ['empty page', { ...refresh(), recoveryIdentity: identity('') }],
  ['overlong page', { ...refresh(), recoveryIdentity: identity('p'.repeat(257)) }],
  ['extra event field', { ...refresh(), extra: true }],
  ['extra identity field', { ...refresh(), recoveryIdentity: { ...identity('page-2'), extra: true } }],
  ...Array.from({ length: 32 }, (_, code) => [
    `C0 control U+${code.toString(16).padStart(4, '0')}`,
    { ...refresh(), recoveryIdentity: identity(`page-${String.fromCodePoint(code)}`) },
  ] as const),
  ['DEL control', { ...refresh(), recoveryIdentity: identity(`page-${String.fromCodePoint(0x7f)}`) }],
] satisfies readonly (readonly [string, Record<string, JsonValue>])[])('rejects %s without a reconnect or identity overwrite', async (_label, payload) => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', payload);
    await expect(nativeBrowser(engine, operation).title()).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(0);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});
it.each([
  ['space', ' '],
  ['printable ASCII upper boundary', '~'],
  ['C1 lower boundary', String.fromCodePoint(0x80)],
  ['supplementary code point', String.fromCodePoint(0x1f600)],
  ['maximum UTF-16 length', 'p'.repeat(256)],
])('accepts %s page identity without rewriting it', async (_label, page) => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', { ...refresh(), recoveryIdentity: identity(page) });
    await peer!.event('scope.disconnected', { identityScope: 'scope-1', reason: 'browser-connection-closed' });
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('current title');
    expect(peer!.requests.find(frame => frame.command === 'scope.reconnect')?.args['expectedPageIdentity']).toBe(page);
  } finally { await engine.dispose!(cleanup()); }
});
it('rejects duplicate refresh instead of interpreting it as another page transition', async () => {
  const engine = await fixture();
  try {
    await peer!.event('scope.page-reopened', refresh());
    await peer!.event('scope.page-reopened', refresh());
    await expect(nativeBrowser(engine, operation).title()).rejects.toBeInstanceOf(Error);
    expect(peer!.requests.filter(frame => frame.command === 'scope.reconnect')).toHaveLength(0);
  } finally { await engine.dispose!(cleanup()).catch(() => undefined); }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it('rejects delayed old-page pixels after reopen and still publishes a fresh same-page observation', async () => {
  const old = Buffer.from('old protected pixels'); const fresh = Buffer.from('new protected pixels');
  const readStarted = deferred<void>(); const oldReply = deferred<PeerOutcome>();
  let observations = 0;
  const engine = await fixture(frame => {
    if (frame.command === 'browser.observe') {
      observations += 1;
      const bytes = observations === 1 ? old : fresh; const handle = observations === 1 ? 'old-image' : 'fresh-image';
      return { data: { identityScope: 'scope-1', revision: String(observations), viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: String(observations) }, role: 'document' },
        pixels: { identityScope: 'scope-1', handle, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0 } } };
    }
    if (frame.command === 'browser.pointer') return { data: null };
    if (frame.command === 'blob.read') {
      if (frame.args['handle'] === 'old-image') { readStarted.resolve(); return oldReply.promise; }
      return { data: { base64: fresh.toString('base64'), nextOffset: fresh.length, eof: true } };
    }
    if (frame.command === 'page.navigate') return (async () => { await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
    return undefined;
  });
  try {
    const stale = expect(engine.observe!(operation(), { pixels: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    await readStarted.promise;
    await nativeBrowser(engine, operation).goto('https://synthetic.test/reopened');
    oldReply.resolve({ data: { base64: old.toString('base64'), nextOffset: old.length, eof: true } });
    await stale;
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(peer!.requests.filter(frame => frame.command === 'browser.pointer')).toHaveLength(0);
    // Native page retirement owns the old image; no release can target a newer
    // owner and no stale bytes or refs are returned by the public observation.
    expect(peer!.requests.filter(frame => frame.command === 'blob.release' && frame.args['handle'] === 'old-image')).toHaveLength(0);
    const current = await engine.observe!(operation(), { pixels: true });
    expect(Buffer.from(current.pixels!.data)).toEqual(fresh);
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation());
    expect(peer!.requests.filter(frame => frame.command === 'browser.pointer')).toHaveLength(1);
    expect(peer!.requests.filter(frame => frame.command === 'blob.release' && frame.args['handle'] === 'fresh-image')).toHaveLength(1);
  } finally { oldReply.resolve({ error: 'cancelled' }); await engine.dispose!(cleanup()); }
});

it('rejects a delayed old-page semantic result without invalidating the completed open', async () => {
  const captured = deferred<void>(); const reply = deferred<PeerOutcome>();
  let observations = 0;
  const snapshot = (revision: string) => ({ identityScope: 'scope-1', revision, viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision }, role: 'document' } });
  const engine = await fixture(frame => {
    if (frame.command === 'browser.observe') { if (++observations === 1) { captured.resolve(); return reply.promise; } return { data: snapshot('2') }; }
    if (frame.command === 'browser.perform') return { data: null };
    if (frame.command === 'page.navigate') return (async () => { await peer!.event('scope.page-reopened', refresh()); return { data: null }; })();
    return undefined;
  });
  try {
    const stale = expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'CANCELLED' });
    await captured.promise;
    await nativeBrowser(engine, operation).goto('https://synthetic.test/reopened');
    reply.resolve({ data: snapshot('1') });
    await stale;
    const current = await engine.observe!(operation());
    expect(current).toMatchObject({ identityScope: 'scope-1', root: { ref: { id: 'root', revision: 'r1' } } });
    await engine.perform!(current.root.ref, { kind: 'tap' }, operation());
    expect(peer!.requests.findLast(frame => frame.command === 'browser.perform')?.args).toEqual({
      identityScope: 'scope-1', ref: { id: '@e1', revision: '2' }, action: { kind: 'tap' },
    });
    await expect(nativeBrowser(engine, operation).title()).resolves.toBe('current title');
  } finally { reply.resolve({ error: 'cancelled' }); await engine.dispose!(cleanup()); }
});
