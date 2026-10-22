/** Real protocol client over an in-memory native peer; no browser success is implied. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineError, TestError, type EngineAttemptContext, type EngineFixtureContext, type OperationContext, type ProviderRecording } from 'e2e/engine';
import * as uploadFiles from '../../src/native/upload-files.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeClient } from '../../src/native/client.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { retainUnresolvedProcess } from '../../src/native/process-cleanup.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { HOSTILE_NAMES } from '../helpers/artifact-names.ts';

vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: async () => '/synthetic/trusted-agent-browser' }));
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: vi.fn() }));
const signal = new AbortController().signal;
const operation = (): OperationContext => ({ signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
function context(attemptId: string, attemptSignal = signal): EngineAttemptContext {
  return { attemptId, signal: attemptSignal, artifactsDir: '/tmp/synthetic-native-artifacts', resolveSecret: async () => 'synthetic-secret', appLog: () => {}, navigation: () => {}, environment: () => {} };
}
let frames: Record<string, unknown>[];
let currentScope: string;
let queryNodes: unknown[] = [];
let downloadBasename: string;
let recordingSegments: Record<string, unknown>[] = [];
let recordingMissing: number | undefined;
const recordingBytes = Buffer.from('synthetic-finalized-segment');
let holdScopeEnd = false;
let holdDecision = false;
let rejectHeldDecision: (() => void) | undefined;
let screenshotDelay = 0;
let repeatContextIdentity = false;
let preserveRestartScope = false;
let coalescedTransitionEvent = false;
let rejectScopeOpen: 'not-dispatched' | 'unknown' | undefined;
let releaseScopeEnd: (() => void) | undefined;
let sendEvent: (event: string, payload: Record<string, unknown>, decision?: { token: string; timeoutMs: number }) => Promise<void>;
beforeEach(() => {
  downloadBasename = 'download-id_1'; recordingMissing = undefined; queryNodes = []; holdDecision = false; rejectHeldDecision = undefined; coalescedTransitionEvent = false; preserveRestartScope = false; frames = []; screenshotDelay = 0; recordingSegments = []; currentScope = ''; repeatContextIdentity = false; rejectScopeOpen = undefined; holdScopeEnd = false; releaseScopeEnd = undefined; let scopes = 0; let sequence = 0;
  vi.mocked(connectNativeProcess).mockReset().mockImplementation(async (options, connectOperation, onEvent) => {
    const output = new PassThrough();
    const send = (message: unknown) => queueMicrotask(() => output.write(JSON.stringify(message) + '\n'));
    const input = new Writable({ write(chunk: Buffer, _encoding, done) {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; frames.push(frame);
      if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic-peer', generation: 1, capabilities: options.capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      else if (frame['type'] === 'close') send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
      else if (frame['type'] === 'decision') {
        if (holdDecision) rejectHeldDecision = () => send({ type: 'control-result', id: frame['id'], generation: 1, accepted: false, error: { code: 'invalid-arguments' }, scopeState: 'usable' });
        else send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
      }
      else {
        const command = frame['command']; let data: unknown = null;
        if (command === 'scope.open' && rejectScopeOpen !== undefined) {
          const effects = rejectScopeOpen; rejectScopeOpen = undefined;
          send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' }); done(); return;
        }
        if (command === 'scope.open') { currentScope = `scope-${++scopes}`; data = { identityScope: currentScope, recoveryIdentity: { browser: 'browser-owner', context: repeatContextIdentity ? 'snapshot-default-context' : `context-${scopes}`, page: `page-${scopes}` } }; }
        else if (command === 'scope.reset' || command === 'scope.restart' || command === 'scope.reconnect') { if (!(command === 'scope.restart' && preserveRestartScope)) currentScope = `scope-${++scopes}`; data = { identityScope: currentScope, ...(command === 'scope.restart' ? { recoveryIdentity: { browser: 'browser-owner', context: 'context-1', page: 'restarted-page' } } : {}) }; }
        else if (command === 'fixture.query' || command === 'browser.query') data = { identityScope: currentScope, revision: '1', nodes: queryNodes };
        else if (command === 'download.metadata') data = { identityScope: currentScope, source: 'provider', basename: downloadBasename };
        else if (command === 'blob.release') data = { released: true };
        else if (command === 'recording.stop') {
          data = recordingMissing === undefined ? { identityScope: currentScope, segments: recordingSegments } : { identityScope: currentScope, missingSegment: recordingMissing };
          if (recordingMissing === undefined) recordingSegments = [];
          recordingMissing = undefined;
        }
        else if (command === 'blob.read') data = { base64: recordingBytes.toString('base64'), nextOffset: recordingBytes.length, eof: true };
        else if (command === 'capture.screenshot') data = { identityScope: currentScope, handle: 'synthetic-image', size: 1, sha256: '0'.repeat(64), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0 };
        else if (command === 'session.environment') data = { identityScope: currentScope, browser: 'Synthetic Chromium', userAgent: 'synthetic-agent' };
        else if (command === 'browser.observe') data = { identityScope: currentScope, revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e1', revision: '1' }, role: 'document' } };
        else if (command === 'page.activate') data = { activated: true };
        else if (command === 'page.title') data = { title: 'Synthetic page' };
        const respond = () => {
          const result = { type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: true, data, effects: 'completed', scopeState: 'usable' };
          if (command === 'scope.reset' && coalescedTransitionEvent) {
            const event = { type: 'event', generation: 1, sequence: ++sequence, event: 'network.request', payload: { identityScope: currentScope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, decision: { token: 'replacement-callback', timeoutMs: 1000 } };
            queueMicrotask(() => output.write(JSON.stringify(result) + '\n' + JSON.stringify(event) + '\n'));
          } else send(result);
        };
        if (command === 'scope.end' && holdScopeEnd) releaseScopeEnd = respond; else if (command === 'capture.screenshot' && screenshotDelay > 0) setTimeout(respond, screenshotDelay); else respond();
      }
      done();
    } });
    const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, options.capabilities, connectOperation, onEvent);
    sendEvent = async (event, payload, decision) => { send({ type: 'event', generation: 1, sequence: ++sequence, event, payload, ...(decision === undefined ? {} : { decision }) }); await new Promise(resolve => setImmediate(resolve)); };
    return client;
  });
});
async function start(surface: NativeSurface) {
  const prepared = await surface.prepare({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: { site: 'fixture.test' }, env: {}, headed: false, slots: 1, signal, log: () => {} });
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: { site: 'fixture.test' }, env: prepared?.env ?? {}, headed: false, workerSlot: 0, signal, log: () => {} });
  await surface.startAttempt(context('attempt'));
}

describe('native surface ownership and fixed policy binding', () => {
  it.each([false, true])('retains a failed-start provider lease only for private unresolved cleanup evidence (%s)', async unresolved => {
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic-attempt', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release } });
    const failure = new EngineError('ENGINE_FAILURE', 'Synthetic startup failure', { retryable: false });
    if (unresolved) retainUnresolvedProcess(failure, {} as ChildProcessWithoutNullStreams);
    vi.mocked(connectNativeProcess).mockRejectedValueOnce(failure);
    // Attempt-scoped leases are acquired and owned by the worker itself.
    await expect(start(surface)).rejects.toBe(failure);
    if (unresolved) {
      await expect(surface.startAttempt(context('must-not-start'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(surface.dispose(cleanup())).rejects.toBe(failure);
      expect(release).not.toHaveBeenCalled();
    } else {
      await expect(surface.dispose(cleanup())).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it('builds real frame and selector fixtures through core context instead of an incomplete cast', async () => {
    const engine = web({});
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!(context('frame-contract'));
    try {
      queryNodes = [{ ref: { id: '@e7', revision: '1' }, role: 'button', name: 'Button D', attributes: { 'data-clicked': 'D' }, states: { hidden: false } }];
      const browser = nativeBrowser(engine, operation);
      await browser.frameLocator('iframe').getByRole('button', { name: 'Button D' }).waitFor();
      expect(await browser.frameLocator('iframe').frameLocator('#nested').locator('body').getAttribute('data-clicked')).toBe('D');
      const queries = frames.filter(frame => frame['command'] === 'fixture.query');
      expect(queries.length).toBeGreaterThanOrEqual(2);
      expect(queries[0]?.['args']).toMatchObject({ expression: { kind: 'frame', selector: 'iframe', source: { kind: 'query' } } });
      expect(queries.at(-1)?.['args']).toMatchObject({ expression: { kind: 'frame', selector: 'iframe', source: { kind: 'frame', selector: '#nested', source: { kind: 'selector', selector: 'body' } } } });
      queryNodes = [{ ref: { id: '@e8', revision: '1' }, role: 'textbox', states: { secure: true } }];
      await expect(browser.frameLocator('iframe').locator('input').getAttribute('value')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    } finally { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); } }
  });

  it('forwards the hostname site contract in the actual startup configuration payload', async () => {
    const surface = new NativeSurface({});
    await surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: { site: '127.0.0.1' }, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    try {
      await surface.startAttempt(context('hostname-contract'));
      const configured = frames.find(frame => frame['command'] === 'scope.configure');
      const nativeFixture: unknown = JSON.parse(await readFile(new URL('../fixtures/native-startup-hostname.json', import.meta.url), 'utf8'));
      expect(configured?.['args']).toEqual(nativeFixture);
      expect(frames.find(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ blockServiceWorkers: false });
      expect(frames.find(frame => frame['command'] === 'network.routes.replace')?.['args']).toEqual({ identityScope: 'scope-1', version: 1, registrationIds: [] });
    } finally { await surface.dispose(cleanup()); }
  });

  it('rethrows a latched callback failure once before any engine hook dispatch', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const failure = new TestError('ACTION_FAILED', 'synthetic route handler returned without deciding');
    surface.latch.latch(failure);
    const before = frames.length;
    await expect(surface.observe(operation())).rejects.toBe(failure);
    expect(frames).toHaveLength(before);
    await expect(surface.observe(operation())).resolves.toMatchObject({ identityScope: 'scope-1' });
    await surface.dispose(cleanup());
  });
  it('refuses an already-cancelled engine hook before dispatch', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const controller = new AbortController(); controller.abort(); const before = frames.length;
    await expect(surface.observe({ ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(frames).toHaveLength(before);
    await surface.dispose(cleanup());
  });
  it('does not let an operation admitted before retirement dispatch into the next attempt', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const pending = surface.observe(operation());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('next'));
    await rejected;
    expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(0);
    await surface.dispose(cleanup());
  });
  it('closes a late native handshake instead of publishing it after disposal', async () => {
    const connect = vi.mocked(connectNativeProcess).getMockImplementation()!;
    let deliver!: () => void; const delivery = new Promise<void>(resolve => { deliver = resolve; });
    vi.mocked(connectNativeProcess).mockImplementationOnce(async (...args) => { const client = await connect(...args); await delivery; return client; });
    const surface = new NativeSurface({});
    const initializing = surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} }).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    const ending = surface.dispose(cleanup());
    await expect(surface.startAttempt(context('too-early'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    deliver(); await ending;
    expect(await initializing).toMatchObject({ code: 'CANCELLED' });
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(0);
  });
  it('does not launch after disposal while an initial endpoint resolver is pending', async () => {
    let deliver!: (endpoint: string) => void;
    const endpoint = new Promise<string>(resolve => { deliver = resolve; });
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => { entered(); return endpoint; } } });
    const initializing = surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} }).catch((cause: unknown) => cause);
    await reached; await surface.dispose(cleanup()); deliver('ws://synthetic.test/retired');
    expect(await initializing).toMatchObject({ code: 'CANCELLED' });
    expect(connectNativeProcess).not.toHaveBeenCalled();
    await expect(surface.startAttempt(context('retired-worker'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('retains pending native connection ownership after a bounded cleanup wait expires', async () => {
    const connect = vi.mocked(connectNativeProcess).getMockImplementation()!;
    let deliver!: () => void; const delivery = new Promise<void>(resolve => { deliver = resolve; });
    vi.mocked(connectNativeProcess).mockImplementationOnce(async (...args) => { const client = await connect(...args); await delivery; return client; });
    const surface = new NativeSurface({});
    const initializing = surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} }).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    await expect(surface.dispose({ ...cleanup(), timeoutMs: 10 })).rejects.toBeDefined();
    await expect(surface.startAttempt(context('too-early'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    deliver(); expect(await initializing).toMatchObject({ code: 'CANCELLED' });
    await surface.dispose(cleanup());
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  });
  it('deducts recovery time from the following native command budget', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return 'ws://synthetic.test/browser'; } } });
    await start(surface); await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await surface.command('page.title', {}, operation());
    const command = frames.findLast(frame => frame['command'] === 'page.title');
    expect(command?.['timeoutMs']).toBeGreaterThan(0); expect(command?.['timeoutMs']).toBeLessThan(950);
    await surface.dispose(cleanup());
  });
  it('deducts screenshot command time before reading its artifact handle', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-deadline-'));
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    await surface.startAttempt({ ...context('capture'), artifactsDir: directory });
    screenshotDelay = 80;
    let transferBudget = 0;
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockImplementationOnce(async (_blob, _scope, remaining) => { transferBudget = remaining.timeoutMs; return Buffer.from('synthetic-image'); });
    try {
      await surface.screenshot('budget', operation());
      expect(transferBudget).toBeGreaterThan(0); expect(transferBudget).toBeLessThan(950);
    } finally { read.mockRestore(); await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });
  it('does not allocate or publish screenshot bytes returned after the operation deadline', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-late-artifact-'));
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    await surface.startAttempt({ ...context('capture'), artifactsDir: directory });
    const allocate = vi.spyOn(surface, 'artifactPath');
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 40)); return Buffer.from('late synthetic bytes'); });
    try {
      await expect(surface.screenshot('late', { ...operation(), timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(allocate).not.toHaveBeenCalled();
    } finally { read.mockRestore(); allocate.mockRestore(); await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });
  it('bounds a reconnect resolver that ignores its abort signal without dispatching the requested action', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => new Promise<string>(() => {}) } });
    await start(surface); await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await expect(surface.command('page.title', {}, { ...operation(), timeoutMs: 20 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(frames.filter(frame => frame['command'] === 'page.title')).toHaveLength(0);
    await surface.dispose(cleanup());
  });
  it('retains one worker client/browser while opening isolated attempts with monotonic registries', async () => {
    const surface = new NativeSurface({}); await start(surface);
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('second'));
    expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(1);
    expect(frames.find(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ blockServiceWorkers: false });
    expect(frames.filter(frame => frame['command'] === 'scope.open').map(frame => frame['args'])).toMatchObject([{ source: 'launch', context: 'isolated' }, { source: 'reuse', context: 'isolated' }]);
    expect(frames.filter(frame => frame['command'] === 'network.routes.replace').map(frame => frame['args'])).toEqual([{ version: 1, registrationIds: [], identityScope: 'scope-1' }, { version: 2, registrationIds: [], identityScope: 'scope-2' }]);
    await surface.dispose(cleanup());
  });
  it('requires the complete native capability set and maps protected/fixture queries to different commands', async () => {
    const surface = new NativeSurface({}); await start(surface);
    expect(vi.mocked(connectNativeProcess).mock.calls[0]?.[0].capabilities).toContain('browser.recording/1');
    const expression = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'save', exact: true } } } as const;
    await surface.locate(expression, operation()); await surface.locate(expression, operation(), { purpose: 'fixture' });
    expect(frames.filter(frame => String(frame['command']).endsWith('.query')).map(frame => frame['command'])).toEqual(['browser.query', 'fixture.query']);
    await surface.dispose(cleanup());
  });
  it('uses fresh cleanup context even after the attempt signal aborts', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const controller = new AbortController(); await surface.startAttempt(context('aborted', controller.signal)); controller.abort();
    await expect(surface.endAttempt(cleanup())).resolves.toBeUndefined();
    expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(true);
    await surface.dispose(cleanup());
  });
  it('injects same-site headers for agent-only requests without constructing Browser fixture', async () => {
    const surface = new NativeSurface({ headers: { 'x-synthetic-token': 'allowed' } }); await start(surface);
    expect(frames.find(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ blockServiceWorkers: true });
    await sendEvent('network.request', { identityScope: currentScope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'request-token', timeoutMs: 1000 });
    expect(frames.find(frame => frame['type'] === 'decision')?.['decision']).toEqual({ kind: 'continue', overrides: { headers: [{ name: 'x-synthetic-token', value: 'allowed' }] } });
    await surface.dispose(cleanup());
  });
  it('publishes the replacement channel before a callback coalesced with reset ACK', async () => {
    const surface = new NativeSurface({}); await start(surface); coalescedTransitionEvent = true;
    const fixture = surface.fixtureSurface(); const scopes: string[] = [];
    surface.subscribe('network.request', async event => { scopes.push(fixture.identityScope); await fixture.decide(event.token, { kind: 'continue', overrides: {} }, operation()); });
    await surface.reset(operation()); await new Promise(resolve => setImmediate(resolve));
    expect(scopes).toEqual(['scope-2']);
    expect(frames.findLast(frame => frame['type'] === 'decision')).toMatchObject({ token: 'replacement-callback' });
    await expect(fixture.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('retires post-decision callbacks even when restart preserves identityScope', async () => {
    const surface = new NativeSurface({}); await start(surface); preserveRestartScope = true;
    const fixture = surface.fixtureSurface(); const scope = currentScope; let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; }); let rejected: unknown;
    surface.subscribe('network.request', async event => {
      await fixture.decide(event.token, { kind: 'continue', overrides: {} }, operation());
      await hold;
      try { await fixture.command('page.title', {}, operation()); } catch (error) { rejected = error; }
      fixture.latchCallbackFailure(scope, new Error('retired callback must not poison restart'));
    });
    await sendEvent('network.request', { identityScope: scope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'old-callback', timeoutMs: 1000 });
    await surface.restart(operation()); expect(currentScope).toBe(scope);
    resume(); await new Promise(resolve => setImmediate(resolve));
    expect(rejected).toMatchObject({ code: 'CANCELLED' });
    await expect(fixture.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('retires an undecided old callback only after acknowledged terminal reconnect', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); const fixture = surface.fixtureSurface(); const scope = currentScope;
    let resume!: () => void; const hold = new Promise<void>(resolve => { resume = resolve; }); let rejected: unknown;
    surface.subscribe('network.request', async () => { await hold; try { await fixture.command('page.title', {}, operation()); } catch (cause) { rejected = cause; } });
    await sendEvent('network.request', { identityScope: scope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'lost-undecided', timeoutMs: 50 });
    await sendEvent('scope.disconnected', { identityScope: scope, reason: 'browser-connection-closed' });
    await surface.command('page.title', {}, operation());
    await new Promise(resolve => setTimeout(resolve, 60));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    resume(); await new Promise(resolve => setImmediate(resolve));
    expect(rejected).toMatchObject({ code: 'CANCELLED' });
    expect(frames.filter(frame => frame['type'] === 'decision')).toHaveLength(0);
    await surface.dispose(cleanup());
  });

  it('survives slow reconnect beyond the old callback deadline only after exact terminal proof', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return 'ws://synthetic.test/browser'; } } });
    await start(surface); const scope = currentScope; let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    surface.subscribe('network.request', async () => { await hold; throw new Error('revoked old handler rejection'); });
    await sendEvent('network.request', { identityScope: scope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'revoked-before-reconnect', timeoutMs: 50 });
    await sendEvent('scope.callbacks-retired', { identityScope: scope, throughEventSequence: 1 });
    await sendEvent('scope.disconnected', { identityScope: scope, reason: 'browser-connection-closed' });
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    resume(); await new Promise(resolve => setImmediate(resolve));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('does not latch a revoked pending decision rejection before the reconnect ACK', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); const scope = currentScope; const fixture = surface.fixtureSurface(); holdDecision = true;
    surface.subscribe('network.request', async event => {
      try { await fixture.decide(event.token, { kind: 'continue', overrides: {} }, operation()); }
      catch (cause) { fixture.latchCallbackFailure(scope, cause instanceof Error ? cause : new Error('decision rejected')); throw cause; }
    });
    await sendEvent('network.request', { identityScope: scope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'pending-decision', timeoutMs: 1000 });
    expect(rejectHeldDecision).toBeDefined();
    await sendEvent('scope.callbacks-retired', { identityScope: scope, throughEventSequence: 1 });
    rejectHeldDecision!(); await new Promise(resolve => setImmediate(resolve));
    expect(surface.latch.hasPending()).toBe(false);
    await sendEvent('scope.disconnected', { identityScope: scope, reason: 'browser-connection-closed' });
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('renders later popup navigation with its distinct original wording', async () => {
    const surface = new NativeSurface({}); await start(surface);
    await surface.endAttempt(cleanup()); const navigation = vi.fn();
    await surface.startAttempt({ ...context('navigation'), navigation });
    await sendEvent('app.navigation', { identityScope: currentScope, kind: 'popup-navigation', url: '/help' });
    expect(navigation).toHaveBeenCalledWith('the new tab navigated to /help');
    await surface.dispose(cleanup());
  });

  it.each(['reset', 'restart'] as const)('retains Browser route closure and exact registry across %s without registering again', async transition => {
    const surface = new NativeSurface({}); await start(surface);
    const fixtureContext = {
      operation, signal, timeouts: { action: 1000, test: 5000, assertion: 1000 },
      fixture: (_name: string, target: object) => target, expectable: (target: object) => target,
      app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
    } as unknown as EngineFixtureContext;
    const browser = createBrowserFixture(surface.fixtureSurface(), fixtureContext);
    const handler = vi.fn(async (route: Parameters<Parameters<typeof browser.route>[1]>[0]) => { await route.abort(); });
    await browser.route('**/data', handler);
    const registration = frames.findLast(frame => frame['command'] === 'network.routes.replace')!['args'] as { version: number; registrationIds: string[] };
    const oldScope = currentScope;
    await surface[transition](operation());
    const event = { version: registration.version, registrationIds: registration.registrationIds, request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } };
    await sendEvent('network.request', { ...event, identityScope: oldScope }, { token: 'retired-request', timeoutMs: 1000 });
    expect(handler).not.toHaveBeenCalled();
    await sendEvent('network.request', { ...event, identityScope: currentScope }, { token: 'current-request', timeoutMs: 1000 });
    expect(handler).toHaveBeenCalledOnce();
    expect(frames.filter(frame => frame['command'] === 'network.routes.replace')).toHaveLength(2);
    expect(frames.findLast(frame => frame['type'] === 'decision')).toMatchObject({ token: 'current-request', decision: { kind: 'abort' } });
    await surface.dispose(cleanup());
  });

  it('does not retain a removed listener after a same-attempt scope replacement', async () => {
    const surface = new NativeSurface({}); await start(surface); let calls = 0;
    const unsubscribe = surface.subscribe('registry-released', () => { calls++; });
    await surface.reset(operation()); unsubscribe();
    await sendEvent('registry-released', { identityScope: currentScope, registryVersion: 1 });
    expect(calls).toBe(0); await surface.dispose(cleanup());
  });
  it('answers configured server auth challenges without preemptive authorization headers', async () => {
    const surface = new NativeSurface({ basicAuth: { username: 'synthetic-user', password: 'synthetic-password' } }); await start(surface);
    await sendEvent('network.auth', { identityScope: currentScope, source: 'Server', origin: 'http://another-synthetic.test', scheme: 'basic', realm: 'fixture' }, { token: 'auth-token', timeoutMs: 1000 });
    expect(frames.find(frame => frame['type'] === 'decision')?.['decision']).toEqual({ kind: 'auth', username: 'synthetic-user', password: 'synthetic-password' });
    expect(frames.filter(frame => frame['command'] === 'network.routes.replace').map(frame => frame['args'])).toEqual([{ version: 1, registrationIds: [], identityScope: 'scope-1' }]);
    await surface.dispose(cleanup());
  });
  it('recovers only after a proven disconnect and never replays an earlier action', async () => {
    const reconnect = vi.fn(async () => 'ws://synthetic.test/reconnected');
    const surface = new NativeSurface({ connect: { cdpEndpoint: async () => 'ws://synthetic.test/initial', reconnectEndpoint: reconnect } }); await start(surface);
    await surface.command('page.title', {}, operation()); expect(reconnect).not.toHaveBeenCalled();
    await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await surface.command('page.title', {}, operation());
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(frames.filter(frame => frame['command'] === 'page.title')).toHaveLength(2);
    expect(frames.find(frame => frame['command'] === 'scope.reconnect')?.['args']).toMatchObject({ expectedBrowserIdentity: 'browser-owner', expectedContextIdentity: 'context-1', expectedPageIdentity: 'page-1' });
    await surface.dispose(cleanup());
  });
  it('uses the acknowledged restarted page authority for exact reconnect', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); preserveRestartScope = true;
    await surface.restart(operation());
    await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await surface.command('page.title', {}, operation());
    expect(frames.findLast(frame => frame['command'] === 'scope.reconnect')?.['args']).toMatchObject({ expectedBrowserIdentity: 'browser-owner', expectedContextIdentity: 'context-1', expectedPageIdentity: 'restarted-page' });
    await surface.dispose(cleanup());
  });
  it('does not capture a replacement attempt for a completed old action trace', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const screen = vi.fn(); const original = surface.command.bind(surface);
    vi.spyOn(surface, 'command').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await surface.endAttempt(cleanup()); await surface.startAttempt({ ...context('replacement-trace'), screen });
      return result;
    });
    await surface.open('https://fixture.test/', operation());
    expect(screen).not.toHaveBeenCalled();
    expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(0);
    await surface.dispose(cleanup());
  });
  it('leaves callback failure pending when it arrives between action completion and optional trace', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); await surface.startAttempt({ ...context('traced'), screen });
    const failure = new TestError('ACTION_FAILED', 'synthetic callback failed after action');
    const original = surface.command.bind(surface);
    vi.spyOn(surface, 'command').mockImplementation(async (...args) => {
      const value = await original(...args); surface.latch.latch(failure); return value;
    });
    await surface.open('https://fixture.test/', operation());
    expect(screen).not.toHaveBeenCalled();
    await expect(surface.observe(operation())).rejects.toBe(failure);
    await surface.dispose(cleanup());
  });
  it('records pixels-only traces without advancing semantic authority between two actions', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); const environment = vi.fn();
    await surface.startAttempt({ ...context('traced'), screen, environment });
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockResolvedValue(Buffer.from('synthetic-protected-pixels'));
    try {
      await surface.open('http://synthetic.test', operation());
      const snapshot = await surface.observe(operation());
      await surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      await surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      expect(screen).toHaveBeenCalledTimes(2);
      expect(screen.mock.calls[0]![0]).toMatchObject({ treeUnavailable: true, root: { ref: snapshot.root.ref }, pixels: { mediaType: 'image/png' } });
      expect(Object.keys(screen.mock.calls[0]![0].root)).toEqual(['ref']);
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(1);
      expect(frames.filter(frame => frame['command'] === 'capture.screenshot')).toHaveLength(2);
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => (frame['args'] as { ref: unknown }).ref)).toEqual([snapshot.root.ref, snapshot.root.ref]);
      expect(environment).toHaveBeenCalledWith({ browser: 'Synthetic Chromium', 'user agent': 'synthetic-agent' });
      expect(frames.some(frame => frame['command'] === 'fixture.query')).toBe(false);
    } finally { read.mockRestore(); await surface.dispose(cleanup()); }
  });

  it('rejects old screenshot bytes instead of allocating artifacts in the next attempt', async () => {
    const surface = new NativeSurface({}); await start(surface);
    let finish!: (value: Buffer) => void; let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(EngineChannel.prototype, 'readBlob').mockImplementationOnce(async () => { entered(); return new Promise<Buffer>(resolve => { finish = resolve; }); });
    try {
      const pending = surface.screenshot(undefined, operation()); const result = pending.catch((cause: unknown) => cause);
      await reading; await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
      const allocate = vi.spyOn(surface, 'artifactPath'); finish(Buffer.from('synthetic'));
      expect(await result).toMatchObject({ code: 'CANCELLED' }); expect(allocate).not.toHaveBeenCalled();
      allocate.mockRestore();
    } finally { spy.mockRestore(); await surface.dispose(cleanup()); }
  });
  it('does not latch a retired event handler failure onto the next attempt', async () => {
    const surface = new NativeSurface({}); await start(surface);
    let fail!: (cause: Error) => void;
    surface.subscribe('registry-released', () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    await sendEvent('registry-released', { identityScope: currentScope, registryVersion: 1 });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    fail(new Error('Synthetic retired callback failure')); await new Promise(resolve => setImmediate(resolve));
    await expect(surface.settleAttempt(cleanup())).resolves.toBeUndefined();
    await surface.dispose(cleanup());
  });

  it('cancels a recording stop waiter while retaining one underlying stop for cleanup', async () => {
    let finish!: () => void;
    const stopped = vi.fn(() => new Promise<{ url: string; mediaType: string }>(resolve => { finish = () => resolve({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }); }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release: async () => {}, record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped }) } });
    await start(surface); await surface.startVideo(operation());
    const controller = new AbortController();
    const collecting = surface.stopVideo({ ...operation(), signal: controller.signal });
    const rejected = expect(collecting).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1)); controller.abort(); await rejected;
    const ending = surface.endAttempt(cleanup()); finish(); await ending;
    expect(stopped).toHaveBeenCalledTimes(1); await surface.dispose(cleanup());
  });
  it('cleans up an explicitly not-dispatched scope rejection without poisoning the client', async () => {
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release } });
    rejectScopeOpen = 'not-dispatched';
    await expect(start(surface)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await expect(surface.endAttempt(cleanup())).resolves.toBeUndefined(); expect(release).toHaveBeenCalledTimes(1);
    await surface.dispose(cleanup());
  });
  it('does not treat an unknown scope-open outcome as a clean rejection', async () => {
    const surface = new NativeSurface({}); rejectScopeOpen = 'unknown';
    await expect(start(surface)).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.dispose(cleanup())).rejects.toBeDefined();
  });
  it('joins a late provider recorder and stops it before releasing its attempt lease', async () => {
    let finish!: (recording: ProviderRecording) => void;
    const stopped = vi.fn(async () => ({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }));
    const release = vi.fn(async () => { expect(stopped).toHaveBeenCalledTimes(1); });
    const record = vi.fn(() => new Promise<ProviderRecording>(resolve => { finish = resolve; }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record } });
    await start(surface);
    const starting = surface.startVideo(operation()).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    const ending = surface.endAttempt(cleanup());
    await new Promise(resolve => setImmediate(resolve)); expect(release).not.toHaveBeenCalled();
    finish({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped });
    expect(await starting).toMatchObject({ code: 'CANCELLED' }); await ending;
    expect(stopped).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
    await surface.dispose(cleanup());
  });
  it('retains an unresolved recorder lease after cleanup timeout and retries cleanup explicitly', async () => {
    let finish!: (recording: ProviderRecording) => void;
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record: () => new Promise<ProviderRecording>(resolve => { finish = resolve; }) } });
    await start(surface); const starting = surface.startVideo(operation()).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    await expect(surface.endAttempt({ ...cleanup(), timeoutMs: 10 })).rejects.toBeDefined();
    expect(release).not.toHaveBeenCalled(); await expect(surface.startAttempt(context('next'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    finish({ startedAt: '2026-10-21T00:00:00.000Z', stop: async () => ({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }) });
    await starting; await surface.endAttempt(cleanup()); expect(release).toHaveBeenCalledTimes(1);
    await surface.dispose(cleanup());
  });

  it('blocks a new attempt throughout native teardown and joins concurrent cleanup callers', async () => {
    const surface = new NativeSurface({}); await start(surface); holdScopeEnd = true;
    const first = surface.endAttempt(cleanup()); const second = surface.endAttempt(cleanup());
    expect(first).toBe(second);
    await expect(surface.startAttempt(context('too-early'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    releaseScopeEnd!(); await first; holdScopeEnd = false;
    await surface.startAttempt(context('after-cleanup')); await surface.dispose(cleanup());
  });

  it('does not stage a retired file selection into the replacement attempt', async () => {
    const surface = new NativeSurface({}); await start(surface);
    let finish!: (selection: uploadFiles.UploadSelection) => void;
    const select = vi.spyOn(uploadFiles, 'selectUploadFiles').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = surface.perform({ id: '@e7', revision: '1' }, { kind: 'setInputFiles', paths: ['/synthetic/file'] }, operation()).catch((cause: unknown) => cause);
      await new Promise(resolve => setImmediate(resolve)); await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
      finish({ files: [] }); expect(await pending).toMatchObject({ code: 'CANCELLED' });
      expect(frames.some(frame => frame['command'] === 'blob.create' || frame['command'] === 'browser.perform')).toBe(false);
    } finally { select.mockRestore(); await surface.dispose(cleanup()); }
  });

  it('keeps fixture callbacks bound to their attempt across replacement clients', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: async () => 'ws://synthetic.test/browser', reconnectEndpoint: async () => 'ws://synthetic.test/browser' } }); await start(surface);
    const fixture = surface.fixtureSurface(); const oldLatch = fixture.latch;
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    expect(() => fixture.artifactPath('screenshots', undefined, '.png')).toThrow();
    expect(() => fixture.command('page.title', {}, operation())).toThrow();
    fixture.invalidate(); oldLatch.latch(new Error('Synthetic retired callback'));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await expect(surface.settleAttempt(cleanup())).resolves.toBeUndefined();
    await surface.dispose(cleanup());
  });
  it('retains a retired attempt callback failure only in its detached latch', async () => {
    const surface = new NativeSurface({}); await start(surface); const fixture = surface.fixtureSurface();
    const oldScope = fixture.identityScope; const oldLatch = fixture.latch;
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    const failure = new Error('synthetic old callback failure'); fixture.latchCallbackFailure(oldScope, failure);
    expect(() => oldLatch.throwPending()).toThrow(failure);
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });
  it('drops an old-scope callback failure after a same-attempt reset', async () => {
    const surface = new NativeSurface({}); await start(surface); const fixture = surface.fixtureSurface();
    const oldScope = fixture.identityScope; await surface.reset(operation());
    fixture.latchCallbackFailure(oldScope, new Error('synthetic reset callback failure'));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });
  it('keeps the same fixture usable after an authorized same-attempt reset', async () => {
    const surface = new NativeSurface({}); await start(surface); const fixture = surface.fixtureSurface();
    await surface.reset(operation());
    await expect(fixture.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    expect(fixture.identityScope).toBe(currentScope); await surface.dispose(cleanup());
  });

  it('does not poison a reused worker client from a retired fixture cleanup', async () => {
    const surface = new NativeSurface({}); await start(surface); const fixture = surface.fixtureSurface();
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    expect(fixture.invalidate()).toMatchObject({ code: 'INVALID_STATE' });
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('writes a server-chosen download name as one counted file inside the attempt downloads folder', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-artifact-path-'));
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    await surface.startAttempt({ ...context('artifacts'), artifactsDir: directory });
    try {
      for (const [index, name] of HOSTILE_NAMES.entries()) {
        const { relative, absolute } = surface.artifactPath('downloads', name, '');
        const file = path.basename(absolute);
        expect(relative, name).toBe(`downloads/${file}`);
        expect(path.dirname(absolute), name).toBe(path.join(directory, 'downloads'));
        expect(file, name).toMatch(new RegExp(`^${String(index + 1).padStart(3, '0')}-[A-Za-z0-9._-]{1,64}$`));
      }
    } finally { await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });
  // The native encoder owns viewport fallback and JPEG options. This exercises
  // the public adapter's real wire payload, not a synthetic claim about pixels.
  it.each([
    { label: 'viewport-default', screencast: undefined },
    { label: 'configured', screencast: { size: { width: 640, height: 400 }, quality: 70 } },
  ])('sends $label screencast size and quality through the public native client', async ({ screencast }) => {
    const viewport = { width: 320, height: 200 };
    const engine = web({ viewport, ...(screencast === undefined ? {} : { screencast }) });
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!(context('video-options'));
    try {
      expect(frames.find(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ viewport });
      expect(frames.filter(frame => frame['command'] === 'recording.start')).toEqual([]);
      await engine.artifacts!.startVideo!(operation());
      const starts = frames.filter(frame => frame['command'] === 'recording.start');
      expect(starts).toHaveLength(1);
      expect(starts[0]?.['args']).toEqual({ identityScope: currentScope, ...screencast });
      if (screencast === undefined) {
        expect(starts[0]?.['args']).not.toHaveProperty('size');
        expect(starts[0]?.['args']).not.toHaveProperty('quality');
      }
    } finally { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); } }
  });

  it.each([1, 2])('reports finalized missing segment %i once without losing retained earlier output on retry', async ordinal => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-video-retry-'));
    const engine = web({});
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!({ ...context('video-retry'), artifactsDir: directory });
    try {
      recordingMissing = ordinal;
      recordingSegments = ordinal === 1 ? [] : [{ identityScope: currentScope, handle: 'kept-video', size: recordingBytes.length, sha256: createHash('sha256').update(recordingBytes).digest('hex'), mediaType: 'video/webm', startedAt: '2026-10-21T00:00:01.000Z' }];
      const missing = `video/${ordinal === 1 ? 'video' : 'video-part2'}.webm`;
      const failure = await engine.artifacts!.stopVideo!(operation()).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining(missing) });
      expect((failure as EngineError).message).toContain('screencast stop failed');
      expect(existsSync(path.join(directory, missing))).toBe(false);
      expect(frames.filter(frame => frame['command'] === 'blob.read')).toHaveLength(0);
      const kept = await engine.artifacts!.stopVideo!(operation());
      expect(kept).toEqual(ordinal === 1 ? [] : [{ path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' }]);
      if (ordinal === 2) expect(await readFile(path.join(directory, 'video/video.webm'))).toEqual(recordingBytes);
      expect(await engine.artifacts!.stopVideo!(operation())).toEqual([]);
      expect(frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(ordinal === 1 ? 0 : 1);
    } finally { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); await rm(directory, { recursive: true, force: true }); } }
  });

  it('preserves the documented per-attempt WebM filenames independently of generic artifact counters', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-video-names-'));
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    await surface.startAttempt({ ...context('video'), artifactsDir: directory });
    surface.artifactPath('screenshots', undefined, '.png');
    recordingSegments = [1, 2].map(index => ({ identityScope: currentScope, handle: `video-${index}`, size: 1, sha256: '0'.repeat(64), mediaType: 'video/webm', startedAt: '2026-10-21T00:00:00.000Z' }));
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockResolvedValue(Buffer.from('synthetic-path-fixture-not-a-video'));
    try {
      const segments = await surface.stopVideo(operation());
      expect(segments.map(segment => 'path' in segment ? segment.path : undefined)).toEqual(['video/video.webm', 'video/video-part2.webm']);
      expect(await readFile(path.join(directory, 'video/video.webm'), 'utf8')).toBe('synthetic-path-fixture-not-a-video');
    } finally { read.mockRestore(); await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });

  describe.each(['worker', 'attempt'] as const)('provider download paths in %s scope', scope => {
    it.each([
      ['/tmp/browser-downloads', '/tmp/browser-downloads/download-id_1'],
      ['/', '/download-id_1'],
      ['///tmp/browser-downloads', '/tmp/browser-downloads/download-id_1'],
      ['//browser', '/browser/download-id_1'],
      [String.raw`C:\browser-downloads`, String.raw`C:\browser-downloads\download-id_1`],
      ['D:/browser-downloads', String.raw`D:\browser-downloads\download-id_1`],
      [String.raw`\\browser\share\downloads`, String.raw`\\browser\share\downloads\download-id_1`],
      ['//browser/share/downloads', String.raw`\\browser\share\downloads\download-id_1`],
      ['//browser/share', String.raw`\\browser\share\download-id_1`],
      [String.raw`\\?\C:\browser-downloads`, String.raw`\\?\C:\browser-downloads\download-id_1`],
      [String.raw`\browser-downloads`, String.raw`\browser-downloads\download-id_1`],
    ])('reads %s using the remote path syntax, not the runner platform', async (dir, expected) => {
      const bytes = Buffer.from('provider download');
      const read = vi.fn(async () => bytes);
      const surface = new NativeSurface({ browser: {
        name: 'synthetic-downloads', scope,
        acquire: async () => ({ id: 'download-lease', cdpEndpoint: 'ws://synthetic.test/browser' }),
        release: async () => {}, downloads: { dir, read },
      } });
      await start(surface);
      try {
        await expect(surface.command('download.read', { handle: 'download-1', offset: 0, maxBytes: 9 }, operation())).resolves.toEqual({ base64: bytes.subarray(0, 9).toString('base64'), nextOffset: 9, eof: false });
        await expect(surface.command('download.read', { handle: 'download-1', offset: 9, maxBytes: 100 }, operation())).resolves.toEqual({ base64: bytes.subarray(9).toString('base64'), nextOffset: bytes.length, eof: true });
        expect(read).toHaveBeenCalledExactlyOnceWith({ id: 'download-lease', cdpEndpoint: 'ws://synthetic.test/browser' }, expected, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(frames.filter(frame => frame['command'] === 'download.metadata').map(frame => frame['args'])).toEqual([{ identityScope: currentScope, handle: 'download-1' }]);
        expect(frames.filter(frame => frame['command'] === 'download.read')).toHaveLength(0);
      } finally { await surface.dispose(cleanup()); }
    });
  });

  it.each(['', '.', '..', '../escape', String.raw`..\escape`, '/absolute', String.raw`C:\absolute`, 'file.txt'])('rejects an unsafe provider download basename %j before calling its reader', async basename => {
    downloadBasename = basename;
    const read = vi.fn(async () => Buffer.from('must not be read'));
    const surface = new NativeSurface({ browser: {
      name: 'synthetic-downloads', scope: 'attempt',
      acquire: async () => ({ id: 'download-lease', cdpEndpoint: 'ws://synthetic.test/browser' }),
      release: async () => {}, downloads: { dir: '/tmp/browser-downloads', read },
    } });
    await start(surface);
    try {
      await expect(surface.command('download.read', { handle: 'download-1', offset: 0, maxBytes: 100 }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(read).not.toHaveBeenCalled();
    } finally { await expect(surface.dispose(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' }); }
  });

  it('trusts new attempt-provider leases despite a repeated default context identity', async () => {
    repeatContextIdentity = true; let leases = 0;
    const acquire = vi.fn(async () => ({ id: `lease-${++leases}`, cdpEndpoint: `ws://synthetic.test/fresh-${leases}` }));
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire, release } });
    await start(surface); await surface.endAttempt(cleanup()); await surface.startAttempt(context('fresh-lease'));
    await surface.endAttempt(cleanup()); expect(acquire).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
    await surface.dispose(cleanup());
  });
  it('still refuses repeated context identity from a manual persistent connection', async () => {
    repeatContextIdentity = true;
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); await surface.endAttempt(cleanup());
    await expect(surface.startAttempt(context('reused-context'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(surface.dispose(cleanup())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
  it('replaces a worker provider lease only after a native-proven browser connection loss', async () => {
    let leases = 0; const acquire = vi.fn(async () => ({ id: `lease-${++leases}`, cdpEndpoint: `ws://synthetic.test/browser-${leases}` }));
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire, release } }); await start(surface);
    expect(acquire).toHaveBeenCalledTimes(1);
    await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await expect(surface.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(frames.findLast(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ source: 'connect', endpoint: 'ws://synthetic.test/browser-2' });
    await surface.dispose(cleanup()); expect(release).toHaveBeenCalledTimes(1);
  });
  it('replaces a retained worker browser after proven loss between attempts', async () => {
    let leases = 0; const acquire = vi.fn(async () => ({ id: `lease-${++leases}`, cdpEndpoint: `ws://synthetic.test/browser-${leases}` }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire, release: async () => {} } }); await start(surface);
    await surface.endAttempt(cleanup());
    await sendEvent('browser.disconnected', { reason: 'browser-connection-closed' });
    await surface.startAttempt(context('replacement'));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(frames.findLast(frame => frame['command'] === 'scope.open')?.['args']).toMatchObject({ source: 'connect', endpoint: 'ws://synthetic.test/browser-2' });
    await surface.dispose(cleanup());
  });
  it('ignores a worker loss callback from an already replaced native client tenure', async () => {
    let leases = 0; const acquire = vi.fn(async () => ({ id: `lease-${++leases}`, cdpEndpoint: `ws://synthetic.test/browser-${leases}` }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire, release: async () => {} } }); await start(surface);
    const oldCallback = vi.mocked(connectNativeProcess).mock.calls[0]![2];
    await sendEvent('browser.disconnected', { reason: 'browser-connection-closed' });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement')); await surface.endAttempt(cleanup());
    await oldCallback({ type: 'event', generation: 1, sequence: 999, event: 'browser.disconnected', payload: { reason: 'browser-connection-closed' } });
    await surface.startAttempt(context('same-worker')); expect(acquire).toHaveBeenCalledTimes(2);
    await surface.dispose(cleanup());
  });
  it('does not acquire another paid provider lease merely because the protocol client failed', async () => {
    const acquire = vi.fn(async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire, release: async () => {} } }); await start(surface);
    surface.invalidate(); await expect(surface.endAttempt(cleanup())).rejects.toBeDefined();
    await surface.startAttempt(context('new-proxy-same-lease'));
    expect(acquire).toHaveBeenCalledTimes(1); await surface.dispose(cleanup());
  });

  it('releases untouched video handles after a segment failure without replacing its cause', async () => {
    const surface = new NativeSurface({}); await start(surface);
    recordingSegments = [1, 2, 3].map(index => ({ identityScope: currentScope, handle: `video-${index}`, size: 1, sha256: '0'.repeat(64), mediaType: 'video/webm', startedAt: '2026-10-21T00:00:00.000Z' }));
    const primary = new Error('Synthetic video transfer failure');
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockRejectedValueOnce(primary);
    try {
      await expect(surface.stopVideo(operation())).rejects.toBe(primary);
      expect(frames.filter(frame => frame['command'] === 'blob.release').map(frame => frame['args'])).toEqual([{ handle: 'video-2', identityScope: currentScope }, { handle: 'video-3', identityScope: currentScope }]);
    } finally { read.mockRestore(); await surface.dispose(cleanup()); }
  });

});
