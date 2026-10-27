/** Real protocol client over an in-memory native peer; no browser success is implied. */
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineEngine, EngineError, TestError, type EngineAttemptContext, type EngineFixtureContext, type OperationContext, type ProviderRecording } from 'e2e/engine';
import * as uploadFiles from '../../src/native/upload-files.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { decodeEngineResult } from '../../src/native/engine-decode.ts';
import { NativeClient } from '../../src/native/client.ts';
import { CONTINUE_EXACT_OWNER_CAPABILITY } from '../../src/native/capabilities.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { retainUnresolvedProcess } from '../../src/native/process-cleanup.ts';
import { connectNativeProcess } from '../../src/native/process.ts';
import { createBrowserFixture } from '../../src/browser.ts';
import { NativeSurface } from '../../src/native-surface.ts';
import type { BrowserCommandMap } from '../../src/native/browser-contract.ts';
import { web } from '../../src/index.ts';
import { nativeBrowser } from '../helpers/native-browser.ts';
import { createEngineSession } from '../../../e2e/dist/engine/session.js';
import { ScreenPresenter } from '../../../e2e/dist/agent/screen-update.js';
import { prepareObservation, projectTree } from '../../../e2e/dist/agent/observation.js';
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
let continueExactOwner = false;
let environmentBrowser = 'Synthetic Chromium';
let environmentUserAgent = 'synthetic-agent';
let currentScope: string;
let queryNodes: unknown[] = [];
let downloadBasename: string;
let recordingSegments: Record<string, unknown>[] = [];
let recordingMissing: number | undefined;
const recordingBytes = Buffer.from('synthetic-finalized-segment');
let cancellationObserved: (() => void) | undefined;
let holdScopeEnd = false;
let holdClose = false;
let releaseClose: (() => void) | undefined;
let holdDecision = false;
let rejectHeldDecision: (() => void) | undefined;
let screenshotDelay = 0;
let repeatContextIdentity = false;
let preserveRestartScope = false;
let coalescedTransitionEvent = false;
let rejectScopeOpen: 'not-dispatched' | 'unknown' | undefined;
let releaseScopeEnd: (() => void) | undefined;
let holdObservation = false;
let observationHeld: (() => void) | undefined;
let settleObservation: (() => void) | undefined;
let acknowledgeCancel: (() => void) | undefined;
let interceptRequest: ((frame: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => boolean) | undefined;
let sendEvent: (event: string, payload: Record<string, unknown>, decision?: { token: string; timeoutMs: number }) => Promise<void>;
beforeEach(() => {
  holdClose = false; releaseClose = undefined;
  continueExactOwner = false; environmentBrowser = 'Synthetic Chromium'; environmentUserAgent = 'synthetic-agent';
  interceptRequest = undefined; cancellationObserved = undefined;
  holdObservation = false; observationHeld = undefined; settleObservation = undefined; acknowledgeCancel = undefined;
  downloadBasename = 'download-id_1'; recordingMissing = undefined; queryNodes = []; holdDecision = false; rejectHeldDecision = undefined; coalescedTransitionEvent = false; preserveRestartScope = false; frames = []; screenshotDelay = 0; recordingSegments = []; currentScope = ''; repeatContextIdentity = false; rejectScopeOpen = undefined; holdScopeEnd = false; releaseScopeEnd = undefined; let scopes = 0; let sequence = 0;
  vi.mocked(connectNativeProcess).mockReset().mockImplementation(async (options, connectOperation, onEvent) => {
    // Explicit fixture activation is idempotent now that production requires it.
    const capabilities = continueExactOwner ? [...new Set([...options.capabilities, CONTINUE_EXACT_OWNER_CAPABILITY])] : options.capabilities;
    const output = new PassThrough();
    const send = (message: unknown) => queueMicrotask(() => output.write(JSON.stringify(message) + '\n'));
    const input = new Writable({ write(chunk: Buffer, _encoding, done) {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; frames.push(frame);
      if (frame['type'] === 'hello') send({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'synthetic-peer', generation: 1, capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
      else if (frame['type'] === 'close') {
        const respond = () => send({ type: 'closed', id: frame['id'], generation: 1, scopeState: 'closed' });
        if (holdClose) releaseClose = respond; else respond();
      }
      else if (frame['type'] === 'cancel') {
        acknowledgeCancel = () => send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
        cancellationObserved?.();
      }
      else if (frame['type'] === 'decision') {
        if (holdDecision) rejectHeldDecision = () => send({ type: 'control-result', id: frame['id'], generation: 1, accepted: false, error: { code: 'invalid-arguments' }, scopeState: 'usable' });
        else send({ type: 'control-result', id: frame['id'], generation: 1, accepted: true, scopeState: 'usable' });
      }
      else {
        const command = frame['command']; let data: unknown = null;
        if (interceptRequest?.(frame, result => send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: true, ...(result['ok'] === false ? {} : { data: null }), effects: 'completed', scopeState: 'usable', ...result }))) { done(); return; }
        if (command === 'browser.observe' && holdObservation) {
          settleObservation = () => send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: false, error: { code: 'deadline-exceeded' }, effects: 'not-dispatched', scopeState: 'usable' });
          observationHeld?.(); done(); return;
        }
        if (command === 'scope.open' && rejectScopeOpen !== undefined) {
          const effects = rejectScopeOpen; rejectScopeOpen = undefined;
          send({ type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'], ok: false, error: { code: 'browser-failure' }, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' }); done(); return;
        }
        if (command === 'scope.open') { currentScope = `scope-${++scopes}`; data = { identityScope: currentScope, recoveryIdentity: { browser: 'browser-owner', context: repeatContextIdentity ? 'snapshot-default-context' : `context-${scopes}`, page: `page-${scopes}` } }; }
        else if (command === 'scope.reset' || command === 'scope.restart' || command === 'scope.reconnect') { if (!(command === 'scope.restart' && preserveRestartScope)) currentScope = `scope-${++scopes}`; data = { identityScope: currentScope, ...(command === 'scope.restart' ? { recoveryIdentity: { browser: 'browser-owner', context: 'context-1', page: 'restarted-page' } } : {}) }; }
        else if (command === 'fixture.query' || command === 'browser.query') data = { identityScope: currentScope, revision: '1', nodes: queryNodes };
        else if (command === 'fixture.read-fields') {
          const fields = (frame['args'] as { fields: string[] }).fields;
          data = { identityScope: currentScope, values: queryNodes.map(entry => {
            const node = entry as Record<string, unknown>;
            const states = node['states'] as Record<string, boolean> | undefined;
            return { ...Object.fromEntries(Object.entries(node).filter(([key]) => fields.includes(key))), states: { ...(fields.includes('states') ? states : {}), secure: states?.['secure'] === true } };
          }) };
        }
        else if (command === 'network.responses.subscribe' || command === 'download.subscribe') data = { subscriptionId: 'synthetic-subscription' };
        else if (command === 'download.metadata') data = { identityScope: currentScope, source: 'provider', basename: downloadBasename };
        else if (command === 'blob.release') data = { released: true };
        else if (command === 'recording.stop') {
          data = recordingMissing === undefined ? { identityScope: currentScope, segments: recordingSegments } : { identityScope: currentScope, missingSegment: recordingMissing };
          if (recordingMissing === undefined) recordingSegments = [];
          recordingMissing = undefined;
        }
        else if (command === 'blob.read') data = { base64: recordingBytes.toString('base64'), nextOffset: recordingBytes.length, eof: true };
        else if (command === 'capture.screenshot') data = { identityScope: currentScope, handle: 'synthetic-image', size: 1, sha256: '0'.repeat(64), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0, ...((frame['args'] as Record<string, unknown>)['purpose'] === 'trace' ? { viewportRef: { id: '@e90', revision: '1' }, viewport: { width: 100, height: 80 }, location: 'https://synthetic.test/trace' } : {}) };
        else if (command === 'session.environment') data = { identityScope: currentScope, browser: environmentBrowser, userAgent: environmentUserAgent };
        else if (command === 'browser.trace') data = { identityScope: currentScope, revision: '1', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e900', revision: '1' }, role: 'document', name: 'live trace' } };
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
    const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, capabilities, connectOperation, onEvent);
    sendEvent = async (event, payload, decision) => { send({ type: 'event', generation: 1, sequence: ++sequence, event, payload, ...(decision === undefined ? {} : { decision }) }); await new Promise(resolve => setImmediate(resolve)); };
    return client;
  });
});
async function start(surface: NativeSurface) {
  const prepared = await surface.prepare({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: { site: 'fixture.test' }, env: {}, headed: false, slots: 1, signal, log: () => {} });
  await surface.init({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: { site: 'fixture.test' }, env: prepared?.env ?? {}, headed: false, workerSlot: 0, signal, log: () => {} });
  await surface.startAttempt(context('attempt'));
}

interface HeldRequest {
  readonly args: Record<string, unknown>;
  succeed(data: unknown): void;
  fail(code: string, effects?: 'not-dispatched' | 'unknown'): void;
  retire(): void;
}
/** Hold real framed requests without replacing the Surface, channel, or blob collector. */
function holdRequests(...commands: string[]) {
  const queued = new Map<string, HeldRequest[]>();
  const waiting = new Map<string, (request: HeldRequest) => void>();
  interceptRequest = (frame, reply) => {
    const command = String(frame['command']);
    if (!commands.includes(command)) return false;
    const request: HeldRequest = {
      args: frame['args'] as Record<string, unknown>,
      succeed: data => reply({ data }),
      fail: (code, effects = 'not-dispatched') => reply({ ok: false, error: { code }, effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable' }),
      retire: () => reply({ ok: false, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'usable', retention: { version: 1, retiredOperationSeq: frame['operationSeq'], producerState: 'retiring', inputDebt: 1, objectDebt: 2 } }),
    };
    const resolve = waiting.get(command);
    if (resolve !== undefined) { waiting.delete(command); resolve(request); }
    else { const pending = queued.get(command) ?? []; pending.push(request); queued.set(command, pending); }
    return true;
  };
  return {
    next(command: string): Promise<HeldRequest> {
      const request = queued.get(command)?.shift();
      if (request !== undefined) return Promise.resolve(request);
      return new Promise(resolve => { waiting.set(command, resolve); });
    },
  };
}
/** Distinct root data shares an immutable viewport issuance, not the publication revision. */
function observation(revision: unknown, handle?: string, scope = currentScope) {
  return {
    identityScope: scope, revision, viewport: { width: 100, height: 80 },
    root: { ref: { id: '@e1', revision: '1' }, role: 'document', name: `snapshot ${String(revision)}` },
    viewportRef: { id: '@e2', revision: '1' },
    ...(handle === undefined ? {} : { pixels: { identityScope: scope, handle, size: recordingBytes.length, sha256: createHash('sha256').update(recordingBytes).digest('hex'), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0 } }),
  };
}
/** Complete a single exact synthetic blob chunk; production code still verifies its digest. */
function finishBlob(request: HeldRequest): void {
  request.succeed({ base64: recordingBytes.toString('base64'), nextOffset: recordingBytes.length, eof: true });
}

describe('native environment report compatibility', () => {
  it.each([
    ['Chrome/156.0.8100.0', 'chromium 156.0.8100.0'],
    ['HeadlessChrome/156.0.8100.0', 'chromium 156.0.8100.0'],
    ['Chromium/156.0.8100.0', 'chromium 156.0.8100.0'],
    ['Chrome/156.0', 'chromium 156.0'],
    ['Lightpanda/0.2.0', 'Lightpanda/0.2.0'],
    ['Synthetic Chromium', 'Synthetic Chromium'],
    ['chrome/156.0.8100.0', 'chrome/156.0.8100.0'],
    ['CHROME/156.0.8100.0', 'CHROME/156.0.8100.0'],
    ['NotChrome/156.0.8100.0', 'NotChrome/156.0.8100.0'],
    ['Chrome/156', 'Chrome/156'], ['Chrome/156..0', 'Chrome/156..0'],
    ['Chrome/156.0.beta', 'Chrome/156.0.beta'], ['Chrome/156.0.0.0 extra', 'Chrome/156.0.0.0 extra'],
    [' Chrome/156.0.0.0', ' Chrome/156.0.0.0'], ['Chrome/156.0.0.0 ', 'Chrome/156.0.0.0 '],
    ['Chrome/156.0.0.0\n', 'Chrome/156.0.0.0\n'], ['Chrome/156.0.0.0\t', 'Chrome/156.0.0.0\t'],
    ['Chrome/', 'Chrome/'], ['', ''],
  ])('displays exact product %j as %j without changing wire facts', async (product, display) => {
    environmentBrowser = product;
    const configuredUserAgent = 'Synthetic configured UA Chrome/999.0.0.0'; environmentUserAgent = configuredUserAgent;
    const surface = new NativeSurface({ userAgent: configuredUserAgent }); await start(surface); await surface.endAttempt(cleanup());
    const environment = vi.fn(); await surface.startAttempt({ ...context('environment'), environment });
    const raw = { identityScope: currentScope, browser: product, userAgent: configuredUserAgent };
    expect(decodeEngineResult('session.environment', raw)).toEqual(raw);
    await surface.command('page.navigate', { url: 'https://synthetic.test', waitUntil: 'load' }, operation());
    await new Promise(resolve => setImmediate(resolve));
    expect(environment).toHaveBeenCalledExactlyOnceWith({ browser: display, 'user agent': configuredUserAgent });
    if (display.startsWith('chromium ')) expect(display).toMatch(/^chromium \d+\./);
    environmentBrowser = 'Chrome/999.0.0.0';
    await surface.command('page.reload', {}, operation()); await new Promise(resolve => setImmediate(resolve));
    expect(environment).toHaveBeenCalledOnce(); expect(frames.filter(frame => frame['command'] === 'session.environment')).toHaveLength(1);
    expect((frames.findLast(frame => frame['command'] === 'scope.open')!['args'] as Record<string, unknown>)['userAgent']).toBe(configuredUserAgent);
    await surface.dispose(cleanup());
  });
});

// This adapter witness complements the separately executed native direct-point
// producer tests (private patch 3cdaad78). It is not renderer or hold-time proof.
// The four legacy actions were transferred after both tests passed together.
describe('native direct-point ordered forwarding', () => {
  it('taps, double-taps, secondary-taps, and long-presses at the point as given', async () => {
    const surface = new NativeSurface({});
    await start(surface);
    const point = { x: 10, y: 20 };
    const actions = [
      { kind: 'tap' },
      { kind: 'doubleTap' },
      { kind: 'secondaryTap' },
      { kind: 'longPress', durationMs: 700 },
    ] as const;
    const originalActions = structuredClone(actions);
    const scope = surface.identityScope;
    // Exact forwarding assumes no elapsed admission time; keep its original
    // 1000ms assertion independent of scheduler latency in this payload test.
    const clock = vi.spyOn(performance, 'now').mockReturnValue(Math.trunc(performance.now()));
    try {
      for (const action of actions) {
        await expect(surface.performAt(point, action, operation())).resolves.toBeUndefined();
      }
      const requests = frames.filter(frame => frame['command'] === 'browser.pointer');
      expect(requests.map(frame => frame['args'])).toEqual(originalActions.map(action => ({
        identityScope: scope, point: { x: 10, y: 20 }, action,
      })));
      expect(requests.map(frame => frame['timeoutMs'])).toEqual([1000, 1000, 1000, 1000]);
      expect(surface.identityScope).toBe(scope);
      expect(point).toEqual({ x: 10, y: 20 });
      expect(actions).toEqual(originalActions);
    } finally {
      clock.mockRestore();
      try { await surface.endAttempt(cleanup()); }
      finally { await surface.dispose(cleanup()); }
    }
  });
});

// Public-entry companion to original node swipe identities21–22. The native
// component producers, not this peer, prove400x300 geometry, centre200,150,
// down150/fast-left-600 and render ACKs. There is no public aiming/box wire field.
describe('native node swipe public entry forwarding', () => {
  it.each([
    ['same-ref down then fast-left', [
      { kind: 'swipe', direction: 'down' },
      { kind: 'swipe', direction: 'left', momentum: 'fast' },
    ]],
    ['single down with native-owned centre targeting', [
      { kind: 'swipe', direction: 'down' },
    ]],
  ] as const)('preserves %s through perform under the original7ms budget', async (_title, actions) => {
    const surface = new NativeSurface({});
    await start(surface);
    const observed = await surface.observe(operation());
    const ref = observed.root.ref;
    const originalRef = structuredClone(ref);
    const originalActions = structuredClone(actions);
    const scope = surface.identityScope;
    const before = frames.length;
    // Freeze only the clock/timers, never perform/admit/channel/decode. This
    // proves per-call absolute-budget forwarding, not a7ms renderer success.
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      for (const action of actions) {
        await expect(surface.perform(ref, action, { ...operation(), timeoutMs: 7 })).resolves.toBeUndefined();
      }
      const requests = frames.slice(before).filter(frame => frame['type'] === 'request');
      expect(requests.map(frame => [frame['command'], frame['args']])).toEqual(originalActions.map(action => [
        'browser.perform', { identityScope: scope, ref: { id: '@e1', revision: '1' }, action },
      ]));
      expect(requests.map(frame => frame['timeoutMs'])).toEqual(actions.map(() => 7));
      expect(ref).toEqual(originalRef);
      expect(actions).toEqual(originalActions);
      expect(surface.identityScope).toBe(scope);
    } finally {
      try { await surface.endAttempt(cleanup()); }
      finally {
        try { await surface.dispose(cleanup()); }
        finally { vi.useRealTimers(); }
      }
    }
  });
});

// These companions keep the original pointer inputs and settlement boundary on
// the real adapter. Native producer witnesses at 0c61010f (run 40113180638) cover
// geometry, cancellation/release, and post-wheel render-ACK settlement. Those five
// original cases are transferred; the exact 48ms fake-clock pacing case remains.
describe('native pointer path forwarding companions', () => {
  it.each([
    { label: 'fractional tap and swipe coordinates', calls: [
      { point: { x: 332, y: 158.875 }, action: { kind: 'tap' } },
      { point: { x: 10.4, y: 20.5 }, action: { kind: 'swipeTo', target: { x: 110.6, y: 20.5 } } },
    ] },
    { label: 'the no-duration swipe path', calls: [
      { point: { x: 10, y: 20 }, action: { kind: 'swipeTo', target: { x: 110, y: 20 } } },
    ] },
    { label: 'the 48ms swipe path', calls: [
      { point: { x: 10, y: 20 }, action: { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 } },
    ] },
    { label: 'the viewport-sized downward wheel intent', calls: [
      { point: { x: 10, y: 20 }, action: { kind: 'swipe', direction: 'down' } },
    ] },
  ] as const)('forwards $label unchanged and waits for the producer result', async ({ calls }) => {
    const surface = new NativeSurface({}); await start(surface);
    const peer = holdRequests('browser.pointer'); const scope = surface.identityScope;
    const original = structuredClone(calls);
    try {
      for (const [index, input] of calls.entries()) {
        let finished = false;
        const pending = surface.performAt(input.point, input.action, operation());
        void pending.then(() => { finished = true; }, () => { finished = true; });
        const held = await peer.next('browser.pointer');
        try {
          await new Promise(resolve => setImmediate(resolve));
          expect(finished).toBe(false);
          expect(held.args).toEqual({ identityScope: scope, ...original[index] });
          const requests = frames.filter(frame => frame['command'] === 'browser.pointer');
          expect(requests).toHaveLength(index + 1);
          const timeoutMs = requests.at(-1)?.['timeoutMs'];
          expect(Number.isInteger(timeoutMs)).toBe(true);
          expect(timeoutMs).toBeGreaterThan(0); expect(timeoutMs).toBeLessThanOrEqual(1000);
        } finally { held.succeed(null); await pending; }
        await expect(pending).resolves.toBeUndefined();
        expect(finished).toBe(true);
      }
      expect(calls).toEqual(original); expect(surface.identityScope).toBe(scope);
      expect(frames.filter(frame => frame['command'] === 'browser.pointer').map(frame => frame['args']))
        .toEqual(original.map(input => ({ identityScope: scope, ...input })));
    } finally { await surface.dispose(cleanup()); }
  });

  it.each([
    ['not-dispatched', 'CANCELLED'],
    ['unknown', 'ACTION_MAY_HAVE_COMMITTED'],
  ] as const)('forwards timed-swipe cancellation once and preserves %s settlement', async (effects, code) => {
    const surface = new NativeSurface({}); await start(surface);
    const peer = holdRequests('browser.pointer'); const controller = new AbortController();
    const point = { x: 10, y: 20 };
    const action = { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 } as const;
    let finished = false;
    const pending = surface.performAt(point, action, { ...operation(), signal: controller.signal }).then(
      value => { finished = true; return value; },
      (cause: unknown) => { finished = true; return cause; },
    );
    try {
      const held = await peer.next('browser.pointer');
      const request = frames.find(frame => frame['command'] === 'browser.pointer')!;
      let acknowledged = false;
      try {
        expect(held.args).toEqual({ identityScope: surface.identityScope, point, action });
        expect(Number.isInteger(request['timeoutMs'])).toBe(true);
        expect(request['timeoutMs']).toBeGreaterThan(0); expect(request['timeoutMs']).toBeLessThanOrEqual(1000);
        controller.abort();
        await new Promise(resolve => setImmediate(resolve));
        expect(frames.filter(frame => frame['type'] === 'cancel')).toEqual([
          expect.objectContaining({ generation: request['generation'], operationSeq: request['operationSeq'] }),
        ]);
        expect(acknowledgeCancel).toBeTypeOf('function'); acknowledgeCancel!(); acknowledged = true;
        await new Promise(resolve => setImmediate(resolve));
        expect(finished).toBe(false);
      } finally {
        if (!acknowledged) acknowledgeCancel?.();
        held.fail('cancelled', effects); await pending;
      }
      await expect(pending).resolves.toMatchObject({ code, retryable: false });
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(1);
      expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    } finally { await surface.dispose(cleanup()); }
  });
});

describe('retained exact-owner adapter publication and services', () => {
  it.each(['provider', 'native'] as const)('preserves configured routes, auth, dialogs, downloads and %s recording across Unknown', async mode => {
    continueExactOwner = true;
    const peer = holdRequests('browser.pointer');
    const record = vi.fn(async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop }));
    const stop = vi.fn(async () => ({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }));
    const release = vi.fn(async () => {}); const acquire = vi.fn(async () => ({ id: 'stable-lease', cdpEndpoint: 'ws://synthetic.test/browser' }));
    let finishDownload!: (bytes: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>(resolve => { finishDownload = resolve; }));
    const surface = new NativeSurface({
      basicAuth: { username: 'synthetic-user', password: 'synthetic-password' }, headers: { 'x-synthetic-policy': 'retained' },
      initScripts: ['globalThis.syntheticInstalled = true'], locale: 'en-US', timezoneId: 'UTC',
      browser: { name: 'synthetic-retained', scope: 'attempt', acquire, release, downloads: { dir: '/synthetic-downloads', read }, ...(mode === 'provider' ? { record } : {}) },
    });
    await start(surface); await surface.startVideo(operation());
    const scope = surface.identityScope; const fixture = surface.fixtureSurface();
    const version = surface.allocateRouteRegistryVersion();
    await surface.command('network.routes.replace', { version, registrationIds: ['installed-route'] }, operation());
    await surface.command('network.responses.subscribe', {}, operation()); await surface.command('download.subscribe', {}, operation());
    await surface.command('dialog.register', { enabled: true }, operation());
    const routed = vi.fn(async (event: { token: string }) => { await fixture.command('page.title', {}, operation()); await fixture.decide(event.token, { kind: 'continue', overrides: {} }, operation()); });
    const dialog = vi.fn(async (event: { token: string }) => { await fixture.decide(event.token, { kind: 'dialog', accept: true }, operation()); });
    const response = vi.fn(); const download = vi.fn();
    surface.subscribe('network.request', routed); surface.subscribe('dialog.opened', dialog); surface.subscribe('network.response', response); surface.subscribe('download.started', download);
    const pendingDownload = surface.command('download.read', { handle: 'held-download', offset: 0, maxBytes: 100 }, operation());
    await new Promise(resolve => setImmediate(resolve)); expect(read).toHaveBeenCalledOnce();
    const uncertain = surface.performAt({ x: 12, y: 24 }, { kind: 'tap' }, operation());
    (await peer.next('browser.pointer')).retire(); await expect(uncertain).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(surface.identityScope).toBe(scope); expect(fixture.identityScope).toBe(scope);
    expect(acquire).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(frames.filter(frame => frame['type'] === 'hello')).toHaveLength(1); expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(0);
    expect(frames.filter(frame => frame['command'] === 'scope.open' || frame['command'] === 'scope.configure')).toHaveLength(2);
    expect(frames.some(frame => ['scope.end', 'scope.reset', 'scope.reconnect'].includes(String(frame['command'])))).toBe(false);
    await sendEvent('network.request', { identityScope: scope, version, registrationIds: ['installed-route'], request: { url: 'https://fixture.test/data', method: 'GET', headers: {} } }, { token: 'fresh-route', timeoutMs: 1000 });
    await sendEvent('network.auth', { identityScope: scope, source: 'Server', origin: 'https://fixture.test', scheme: 'basic', realm: 'synthetic' }, { token: 'fresh-auth', timeoutMs: 1000 });
    await sendEvent('dialog.opened', { identityScope: scope, type: 'alert', message: 'Synthetic retained dialog' }, { token: 'fresh-dialog', timeoutMs: 1000 });
    await sendEvent('network.response', { identityScope: scope, activePage: true, handle: 'response-after', url: 'https://fixture.test/data', status: 200, headers: {} });
    await sendEvent('download.started', { identityScope: scope, activePage: true, handle: 'download-after', suggestedFilename: 'synthetic.txt' });
    expect(routed).toHaveBeenCalledOnce(); expect(dialog).toHaveBeenCalledOnce(); expect(response).toHaveBeenCalledOnce(); expect(download).toHaveBeenCalledOnce();
    expect(frames.find(frame => frame['token'] === 'fresh-auth')?.['decision']).toEqual({ kind: 'auth', username: 'synthetic-user', password: 'synthetic-password' });
    finishDownload(Buffer.from('retained download')); await expect(pendingDownload).resolves.toMatchObject({ eof: true });
    await surface.command('download.read', { handle: 'held-download', offset: 0, maxBytes: 100 }, operation()); expect(read).toHaveBeenCalledOnce();
    const point = surface.performAt({ x: 36, y: 48 }, { kind: 'tap' }, operation());
    const next = await peer.next('browser.pointer'); expect(next.args).toEqual({ identityScope: scope, point: { x: 36, y: 48 }, action: { kind: 'tap' } }); next.succeed(null); await point;
    expect(frames.some(frame => frame['command'] === 'browser.observe' || frame['command'] === 'browser.query')).toBe(false);
    await surface.stopVideo(operation());
    if (mode === 'provider') { expect(record).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); }
    else { expect(frames.filter(frame => frame['command'] === 'recording.start')).toHaveLength(1); expect(frames.filter(frame => frame['command'] === 'recording.stop')).toHaveLength(1); }
    await surface.dispose(cleanup()); expect(release).toHaveBeenCalledOnce();
  });

  it.each(['browser.observe', 'blob.read', 'blob.release'] as const)('cleans old observation blobs held at %s without publishing or rotating scope', async stage => {
    continueExactOwner = true; const peer = holdRequests('browser.observe', 'browser.pointer', 'blob.read', 'blob.release');
    const surface = new NativeSurface({}); await start(surface); const scope = surface.identityScope;
    const capture = surface.observe(operation()).catch((cause: unknown) => cause);
    const observed = await peer.next('browser.observe');
    let read: HeldRequest | undefined; let release: HeldRequest | undefined;
    if (stage !== 'browser.observe') { observed.succeed(observation('1', 'retired-capture')); read = await peer.next('blob.read'); }
    if (stage === 'blob.release') { finishBlob(read!); release = await peer.next('blob.release'); }
    const uncertain = surface.performAt({ x: 1, y: 2 }, { kind: 'tap' }, operation()); (await peer.next('browser.pointer')).retire();
    await expect(uncertain).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    if (stage === 'browser.observe') { observed.succeed(observation('1', 'retired-capture')); read = await peer.next('blob.read'); }
    if (stage !== 'blob.release') { finishBlob(read!); release = await peer.next('blob.release'); }
    expect(release!.args).toEqual({ identityScope: scope, handle: 'retired-capture' }); release!.succeed({ released: true });
    expect(await capture).toMatchObject({ code: 'NODE_STALE', retryable: true }); expect(surface.identityScope).toBe(scope);
    const fresh = surface.observe(operation()); (await peer.next('browser.observe')).succeed(observation('2')); await expect(fresh).resolves.toMatchObject({ identityScope: scope });
    expect(frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(1);
    await surface.dispose(cleanup());
  });

  it.each(['protected', 'fixture'] as const)('does not return late %s locator refs across retirement', async purpose => {
    continueExactOwner = true; const name = purpose === 'fixture' ? 'fixture.query' : 'browser.query'; const peer = holdRequests(name, 'browser.pointer');
    const surface = new NativeSurface({}); await start(surface);
    const locate = surface.locate({ kind: 'selector', selector: 'button' }, operation(), { purpose }).catch((cause: unknown) => cause); const query = await peer.next(name);
    const uncertain = surface.performAt({ x: 1, y: 2 }, { kind: 'tap' }, operation()); (await peer.next('browser.pointer')).retire(); await expect(uncertain).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    query.succeed({ identityScope: currentScope, revision: '1', nodes: [{ ref: { id: '@e1', revision: '1' }, role: 'button' }] });
    expect(await locate).toMatchObject({ code: 'NODE_STALE' }); await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('never publishes an old trace held before retirement, even with no earlier observation cache', async () => {
    continueExactOwner = true; const peer = holdRequests('browser.trace', 'browser.pointer');
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup()); const screen = vi.fn(); await surface.startAttempt({ ...context('traced'), screen });
    const first = surface.performAt({ x: 1, y: 2 }, { kind: 'tap' }, operation()); (await peer.next('browser.pointer')).succeed(null); const trace = await peer.next('browser.trace');
    const uncertain = surface.performAt({ x: 3, y: 4 }, { kind: 'tap' }, operation()); (await peer.next('browser.pointer')).retire(); await expect(uncertain).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    trace.succeed(observation('1')); await first;
    expect(screen).not.toHaveBeenCalled(); await surface.dispose(cleanup());
  });
});

describe('public point input recovery freshness', () => {
  it('recovers from negotiated Unknown on the next observation without replay or a disconnect event', async () => {
    const reconnect = vi.fn(() => 'ws://synthetic.test/recovered');
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: reconnect } });
    await start(surface);
    const oldScope = currentScope; let interrupted = false;
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'browser.pointer' || interrupted) return false;
      interrupted = true;
      reply({ ok: false, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined', recovery: { version: 1, identityScope: oldScope } });
      return true;
    };
    try {
      await expect(surface.performAt({ x: 10, y: 10 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(reconnect).not.toHaveBeenCalled();
      expect(frames.some(frame => frame['type'] === 'close')).toBe(false);
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(1);
      const observed = await surface.observe(operation());
      expect(observed.identityScope).not.toBe(oldScope);
      expect(reconnect).toHaveBeenCalledOnce();
      expect(frames.filter(frame => frame['command'] === 'scope.reconnect').map(frame => frame['args'])).toEqual([{
        identityScope: oldScope, endpoint: 'ws://synthetic.test/recovered', expectedBrowserIdentity: 'browser-owner', expectedContextIdentity: 'context-1', expectedPageIdentity: 'page-1',
      }]);
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(1);
      // This subsequent call is a new explicit intention, not automatic replay.
      await surface.performAt({ x: 20, y: 20 }, { kind: 'tap' }, operation());
      const inputs = frames.filter(frame => frame['command'] === 'browser.pointer');
      expect(inputs).toHaveLength(2);
      expect(inputs[1]!['args']).toMatchObject({ identityScope: observed.identityScope, point: { x: 20, y: 20 } });
    } finally { await surface.dispose(cleanup()); }
  });

  it('keeps initial and direct fixture input available but requires public observation after each recovery', async () => {
    const engine = web({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!(context('attempt'));
    const point = { x: 20, y: 30 };
    try {
      await engine.performAt!(point, { kind: 'tap' }, operation());
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(0);
      await engine.observe!(operation());
      const fixture = nativeBrowser(engine, operation);
      for (const event of ['scope.disconnected', 'browser.disconnected']) {
        await sendEvent(event, { ...(event === 'scope.disconnected' ? { identityScope: currentScope } : {}), reason: 'browser-connection-closed' });
        await fixture.mouse.move(point.x, point.y);
        await fixture.mouse.down();
        await fixture.mouse.up();
        await fixture.mouse.wheel(0, 25);
        await engine.locate!({ kind: 'selector', selector: 'button' }, operation());
        const before = frames.length;
        await expect(engine.performAt!(point, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
        expect(frames.slice(before)).toEqual([]);
        await engine.observe!(operation());
        await engine.performAt!(point, { kind: 'tap' }, operation());
      }
      expect(frames.filter(frame => frame['command'] === 'input.mouse')).toHaveLength(8);
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(3);
      await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
      await expect(engine.performAt!(point, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await engine.endAttempt!(cleanup());
      await engine.startAttempt!(context('replacement'));
      await engine.performAt!(point, { kind: 'tap' }, operation());
    } finally { await engine.dispose!(cleanup()); }
  });

  it.each(['native-failure', 'pixel-failure', 'pending-pixels'] as const)('does not grant point input from a %s observation', async mode => {
    const peer = holdRequests('browser.observe', 'blob.read', 'blob.release');
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface);
    try {
      await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
      await surface.locate({ kind: 'selector', selector: 'button' }, operation());
      const pending = surface.observe(operation()).catch((cause: unknown) => cause);
      const capture = await peer.next('browser.observe');
      let release: HeldRequest | undefined;
      if (mode === 'native-failure') capture.fail('deadline-exceeded');
      else {
        capture.succeed(observation('1', 'new-image'));
        const read = await peer.next('blob.read');
        if (mode === 'pixel-failure') read.fail('deadline-exceeded');
        else finishBlob(read);
        release = await peer.next('blob.release');
        if (mode === 'pixel-failure') release.succeed({ released: true });
      }
      if (mode !== 'pending-pixels') expect(await pending).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      const before = frames.length;
      const input = await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation()).catch((cause: unknown) => cause);
      const dispatched = frames.slice(before);
      if (mode === 'pending-pixels') {
        release!.succeed({ released: true });
        expect(await pending).toMatchObject({ identityScope: currentScope });
      }
      expect(input).toMatchObject({ code: 'NODE_STALE' });
      expect(dispatched).toEqual([]);
      if (mode !== 'pending-pixels') {
        const fresh = surface.observe(operation());
        (await peer.next('browser.observe')).succeed(observation('2'));
        await fresh;
      }
      await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation());
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(1);
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['pending', 'recovered-same-scope'] as const)('does not renew point input from old pixels during %s recovery', async mode => {
    const peer = holdRequests('browser.observe', 'blob.read', 'blob.release', 'scope.reconnect');
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface);
    const oldScope = currentScope;
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation('1', 'old-image'));
      finishBlob(await peer.next('blob.read'));
      const release = await peer.next('blob.release');
      await sendEvent('scope.disconnected', { identityScope: oldScope, reason: 'browser-connection-closed' });
      const owner = surface.locate({ kind: 'selector', selector: 'button' }, operation());
      const reconnect = await peer.next('scope.reconnect');
      const waiter = surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation()).catch((cause: unknown) => cause);
      if (mode === 'recovered-same-scope') { reconnect.succeed({ identityScope: oldScope }); await owner; }
      release.succeed({ released: true });
      expect(await older).toMatchObject({ code: mode === 'pending' ? 'NODE_STALE' : 'CANCELLED' });
      if (mode === 'pending') { reconnect.succeed({ identityScope: oldScope }); await owner; }
      expect(await waiter).toMatchObject({ code: 'NODE_STALE', retryable: true });
      expect(frames.filter(frame => frame['command'] === 'scope.reconnect')).toHaveLength(1);
      expect(frames.filter(frame => frame['command'] === 'browser.pointer')).toHaveLength(0);
      const fresh = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('2'));
      await fresh;
      await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation());
    } finally { await surface.dispose(cleanup()); }
  });

  it('does not grant point input from queries, screenshots, or optional semantic traces', async () => {
    const peer = holdRequests('capture.screenshot', 'blob.read', 'browser.trace');
    const directory = await mkdtemp(path.join(tmpdir(), 'native-recovery-points-'));
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn();
    await surface.startAttempt({ ...context('traced'), artifactsDir: directory, screen });
    try {
      await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
      await surface.locate({ kind: 'selector', selector: 'button' }, operation());
      await surface.locate({ kind: 'selector', selector: 'button' }, operation(), { purpose: 'fixture' });
      const screenshot = surface.screenshot(undefined, operation());
      (await peer.next('capture.screenshot')).succeed(observation('1', 'screenshot').pixels);
      finishBlob(await peer.next('blob.read'));
      await screenshot;
      const action = surface.open('https://synthetic.test/', operation());
      (await peer.next('browser.trace')).succeed(observation('2'));
      await action;
      expect(screen).toHaveBeenCalledTimes(1);
      interceptRequest = undefined;
      const before = frames.length;
      await expect(surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(frames.slice(before)).toEqual([]);
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(0);
    } finally { await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('native observation presentation ordering', () => {
  it.each((['blob.read', 'blob.release'] as const).flatMap(stage =>
    (['pending', 'cancelled', 'dirty-release', 'recovered', 'recovery-failed'] as const)
      .filter(mode => stage === 'blob.release' || mode === 'pending' || mode === 'recovery-failed')
      .map(mode => ({ stage, mode })),
  ))('retires an observation held at $stage after exact cleanup during $mode recovery', async ({ stage, mode }) => {
    const peer = holdRequests('browser.observe', 'blob.read', 'blob.release');
    let resolveEndpoint!: (endpoint: string) => void;
    let rejectEndpoint!: (cause: Error) => void;
    let resolverEntered!: () => void;
    const entered = new Promise<void>(resolve => { resolverEntered = resolve; });
    const endpoint = new Promise<string>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => { resolverEntered(); return endpoint; } } });
    await start(surface);
    const controller = new AbortController();
    const oldScope = currentScope;
    const older = surface.observe({ ...operation(), signal: controller.signal }).catch((cause: unknown) => cause);
    (await peer.next('browser.observe')).succeed(observation('1', 'retiring-image'));
    const read = await peer.next('blob.read');
    if (stage === 'blob.release') finishBlob(read);
    let release = stage === 'blob.release' ? await peer.next('blob.release') : undefined;
    await sendEvent('scope.disconnected', { identityScope: oldScope, reason: 'browser-connection-closed' });
    const recovery = surface.locate({ kind: 'selector', selector: 'button' }, operation()).catch((cause: unknown) => cause);
    await entered;
    try {
      if (mode === 'cancelled') controller.abort();
      if (mode === 'recovered') { resolveEndpoint('ws://synthetic.test/browser'); await expect(recovery).resolves.toEqual([]); }
      if (mode === 'recovery-failed') { rejectEndpoint(new Error('Synthetic recovery refusal')); await expect(recovery).resolves.toBeInstanceOf(EngineError); }
      if (stage === 'blob.read') { finishBlob(read); release = await peer.next('blob.release'); }
      expect(release!.args).toEqual({ identityScope: oldScope, handle: 'retiring-image' });
      if (mode === 'dirty-release') release!.fail('cleanup-failed', 'unknown');
      else release!.succeed({ released: true });
      const failure = await older;
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: mode === 'cancelled' || mode === 'recovered' ? 'CANCELLED' : mode === 'dirty-release' ? 'ENGINE_FAILURE' : 'NODE_STALE', retryable: mode === 'pending' || mode === 'recovery-failed' });
      expect(frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(1);
      if (mode === 'pending' || mode === 'cancelled') { resolveEndpoint('ws://synthetic.test/browser'); await expect(recovery).resolves.toEqual([]); }
      if (mode === 'pending' || mode === 'cancelled' || mode === 'recovered') {
        const fresh = surface.observe(operation());
        (await peer.next('browser.observe')).succeed(observation('2'));
        await expect(fresh).resolves.toMatchObject({ identityScope: currentScope, root: { name: 'snapshot 2', ref: { id: 'root', revision: 'r1' } }, viewportRef: { id: 'n3', revision: '1' } });
      }
      if (mode === 'dirty-release') { resolveEndpoint('ws://synthetic.test/browser'); await expect(recovery).resolves.toBeInstanceOf(EngineError); }
    } finally {
      resolveEndpoint('ws://synthetic.test/browser');
      await recovery;
      await surface.dispose(cleanup()).catch(() => undefined);
    }
  });

  it.each([
    ['blob.read', '1', '2'], ['blob.release', '1', '2'],
    ['blob.read', '9', '10'], ['blob.release', '9', '10'],
    ['blob.read', '9007199254740992', '9007199254740993'],
    ['blob.release', '9007199254740992', '9007199254740993'],
    ['blob.read', '18446744073709551614', '18446744073709551615'],
    ['blob.release', '18446744073709551614', '18446744073709551615'],
  ] as const)('rejects an older snapshot after delayed %s (%s < %s)', async (boundary, oldRevision, newRevision) => {
    const peer = holdRequests('browser.observe', boundary);
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation(oldRevision, 'older-image'));
      const transfer = await peer.next(boundary);
      expect(transfer.args['handle']).toBe('older-image');
      const newer = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation(newRevision));
      await expect(newer).resolves.toMatchObject({ root: { name: `snapshot ${newRevision}` }, viewportRef: { id: 'n3', revision: '1' } });
      if (boundary === 'blob.read') finishBlob(transfer); else transfer.succeed({ released: true });
      await expect(older).resolves.toMatchObject({ code: 'NODE_STALE', retryable: true });
      expect(frames.filter(frame => frame['command'] === 'blob.release').map(frame => frame['args'])).toEqual([{ identityScope: currentScope, handle: 'older-image' }]);
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(2);
      await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['pending', 'failed'] as const)('advances before the newer snapshot transfer is %s and never rolls it back', async outcome => {
    const peer = holdRequests('browser.observe', 'blob.read');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation('1', 'older-image'));
      const oldRead = await peer.next('blob.read');
      let newerSettled = false;
      const newer = surface.observe(operation()).then(value => { newerSettled = true; return value; }, (cause: unknown) => { newerSettled = true; return cause; });
      (await peer.next('browser.observe')).succeed(observation('2', 'newer-image'));
      const newRead = await peer.next('blob.read');
      if (outcome === 'failed') {
        newRead.fail('browser-failure');
        await expect(newer).resolves.toMatchObject({ code: 'ENGINE_FAILURE' });
      }
      finishBlob(oldRead);
      await expect(older).resolves.toMatchObject({ code: 'NODE_STALE' });
      if (outcome === 'pending') {
        expect(newerSettled).toBe(false);
        finishBlob(newRead);
        await expect(newer).resolves.toMatchObject({ root: { name: 'snapshot 2' }, pixels: { data: recordingBytes } });
      }
      expect(frames.filter(frame => frame['command'] === 'blob.release').map(frame => (frame['args'] as Record<string, unknown>)['handle']).toSorted()).toEqual(['newer-image', 'older-image']);
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['pending', 'browser-failure', 'invalid-arguments'] as const)('does not supersede an already committed snapshot for a newer %s request', async outcome => {
    const peer = holdRequests('browser.observe', 'blob.read');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('1', 'older-image'));
      const oldRead = await peer.next('blob.read');
      const newer = surface.observe(operation()).catch((cause: unknown) => cause);
      const newRequest = await peer.next('browser.observe');
      if (outcome !== 'pending') { newRequest.fail(outcome); await expect(newer).resolves.toMatchObject({ code: 'ENGINE_FAILURE' }); }
      finishBlob(oldRead);
      await expect(older).resolves.toMatchObject({ root: { name: 'snapshot 1' } });
      if (outcome === 'pending') { newRequest.fail('browser-failure'); await expect(newer).resolves.toMatchObject({ code: 'ENGINE_FAILURE' }); }
    } finally { await surface.dispose(cleanup()); }
  });

  it('does not lower its watermark when native success replies arrive out of order', async () => {
    const peer = holdRequests('browser.observe', 'blob.read');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      const oldRequest = await peer.next('browser.observe');
      const newer = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('2'));
      await expect(newer).resolves.toMatchObject({ root: { name: 'snapshot 2' } });
      oldRequest.succeed(observation('1', 'older-image'));
      finishBlob(await peer.next('blob.read'));
      await expect(older).resolves.toMatchObject({ code: 'NODE_STALE' });
      const stillOld = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation('1'));
      await expect(stillOld).resolves.toMatchObject({ code: 'NODE_STALE' });
    } finally { await surface.dispose(cleanup()); }
  });

  it('keeps queries, fixture correlation, and screenshots outside observation ordering', async () => {
    const peer = holdRequests('browser.observe', 'blob.read', 'browser.query', 'fixture.query', 'fixture.correlate', 'capture.screenshot');
    const directory = await mkdtemp(path.join(tmpdir(), 'native-observe-isolation-'));
    const surface = new NativeSurface({}); await start(surface);
    await surface.endAttempt(cleanup()); await surface.startAttempt({ ...context('isolation'), artifactsDir: directory });
    try {
      const pending = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('1', 'observed-image'));
      const observationRead = await peer.next('blob.read');
      const expression = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'save', exact: true } } } as const;
      for (const fixture of [false, true]) {
        const query = surface.locate(expression, operation(), fixture ? { purpose: 'fixture' } : undefined);
        (await peer.next(fixture ? 'fixture.query' : 'browser.query')).succeed({ identityScope: currentScope, revision: '18446744073709551615', nodes: [] });
        await expect(query).resolves.toEqual([]);
      }
      const correlation = surface.command('fixture.correlate', { located: [], observed: [] }, operation());
      (await peer.next('fixture.correlate')).succeed({ identityScope: currentScope, matches: [] });
      await expect(correlation).resolves.toEqual({ identityScope: currentScope, matches: [] });
      const screenshot = surface.screenshot('separate', operation());
      (await peer.next('capture.screenshot')).succeed(observation('18446744073709551615', 'screenshot-image').pixels);
      finishBlob(await peer.next('blob.read'));
      const screenshotPath = await screenshot;
      expect(await readFile(path.join(directory, screenshotPath))).toEqual(recordingBytes);
      finishBlob(observationRead);
      await expect(pending).resolves.toMatchObject({ root: { name: 'snapshot 1' }, pixels: { data: recordingBytes } });
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(1);
    } finally { await surface.dispose(cleanup()); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not replace the current trace reference when an older root-only snapshot finishes late', async () => {
    const peer = holdRequests('browser.observe', 'blob.release', 'browser.trace');
    const surface = new NativeSurface({}); await start(surface);
    const screen = vi.fn();
    await surface.endAttempt(cleanup()); await surface.startAttempt({ ...context('traced-order'), screen });
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed({ ...observation('1', 'older-image'), viewportRef: undefined });
      const oldRelease = await peer.next('blob.release');
      const newer = surface.observe(operation());
      const nextData = observation('2'); nextData.root.ref = { id: '@e3', revision: '2' };
      (await peer.next('browser.observe')).succeed({ ...nextData, viewportRef: undefined });
      const current = await newer;
      oldRelease.succeed({ released: true });
      await expect(older).resolves.toMatchObject({ code: 'NODE_STALE' });
      const action = surface.perform(current.root.ref, { kind: 'tap' }, operation());
      (await peer.next('browser.trace')).succeed(observation('2'));
      await action;
      expect(screen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ root: { ...observation('2').root, ref: { id: 'root', revision: expect.stringMatching(/^t[0-9]+$/) } } }));
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => (frame['args'] as Record<string, unknown>)['ref'])).toEqual([{ id: '@e3', revision: '2' }]);
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['cancelled', 'deadline'] as const)('keeps %s ahead of stale presentation after blob release', async outcome => {
    const peer = holdRequests('browser.observe', 'blob.release');
    const surface = new NativeSurface({}); await start(surface);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const controller = new AbortController();
    try {
      const older = surface.observe({ ...operation(), signal: controller.signal }).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation('1', 'older-image'));
      const release = await peer.next('blob.release');
      const newer = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('2'));
      await newer;
      if (outcome === 'cancelled') controller.abort(); else clock.mockReturnValue(2001);
      release.succeed({ released: true });
      await expect(older).resolves.toMatchObject({ code: outcome === 'cancelled' ? 'CANCELLED' : 'OPERATION_TIMEOUT', retryable: false });
      expect(frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(1);
    } finally { clock.mockRestore(); await surface.dispose(cleanup()); }
  });

  it.each(['reset', 'same-scope restart', 'attempt'] as const)('isolates the watermark and late completion across %s turnover', async turnover => {
    const peer = holdRequests('browser.observe', 'blob.release');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation('100', 'older-image'));
      const release = await peer.next('blob.release');
      const oldScope = currentScope;
      if (turnover === 'reset') await surface.reset(operation());
      else if (turnover === 'same-scope restart') { preserveRestartScope = true; await surface.restart(operation()); }
      else { await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement')); }
      const replacement = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('1'));
      await expect(replacement).resolves.toMatchObject({ root: { name: 'snapshot 1' } });
      release.succeed({ released: true });
      await expect(older).resolves.toMatchObject({ code: 'CANCELLED' });
      const current = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('1'));
      await expect(current).resolves.toMatchObject({ identityScope: currentScope, root: { name: 'snapshot 1' } });
      expect(frames.filter(frame => frame['command'] === 'blob.release').map(frame => frame['args'])).toEqual([{ identityScope: oldScope, handle: 'older-image' }]);
    } finally { await surface.dispose(cleanup()); }
  });

  it('rejects a late old-owner result before its malformed revision can poison a replacement owner', async () => {
    const peer = holdRequests('browser.observe');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      const oldRequest = await peer.next('browser.observe');
      preserveRestartScope = true; await surface.restart(operation());
      const replacement = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('1'));
      await replacement;
      oldRequest.succeed(observation('18446744073709551616'));
      await expect(older).resolves.toMatchObject({ code: 'CANCELLED' });
      await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['', '0', '00', '01', '-1', '+1', '1.0', '1e2', ' 1', '1\n', '18446744073709551616', '9'.repeat(100), 1])('invalidates non-canonical or out-of-range publication revision %j', async revision => {
    const peer = holdRequests('browser.observe');
    const surface = new NativeSurface({}); await start(surface);
    try {
      const pending = surface.observe(operation()).catch((cause: unknown) => cause);
      (await peer.next('browser.observe')).succeed(observation(revision));
      await expect(pending).resolves.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(frames.filter(frame => frame['command'] === 'blob.read')).toHaveLength(0);
    } finally { await surface.dispose(cleanup()).catch(() => undefined); }
  });

  it.each(['unknown', 'malformed', 'digest', 'release'] as const)('preserves %s failure instead of replacing it with stale presentation', async failure => {
    const boundary = failure === 'release' ? 'blob.release' : 'blob.read';
    const peer = holdRequests('browser.observe', boundary);
    const surface = new NativeSurface({}); await start(surface);
    try {
      const older = surface.observe(operation()).catch((cause: unknown) => cause);
      const oldRequest = await peer.next('browser.observe');
      let transfer: HeldRequest | undefined;
      if (failure === 'digest' || failure === 'release') {
        const data = observation('1', 'older-image');
        if (failure === 'digest') data.pixels!.sha256 = '0'.repeat(64);
        oldRequest.succeed(data); transfer = await peer.next(boundary);
      }
      const newer = surface.observe(operation());
      (await peer.next('browser.observe')).succeed(observation('2'));
      await newer;
      if (failure === 'unknown') oldRequest.fail('browser-failure', 'unknown');
      else if (failure === 'malformed') oldRequest.succeed({ ...observation('1'), root: null });
      else if (failure === 'digest') finishBlob(transfer!);
      else transfer!.fail('browser-failure');
      await expect(older).resolves.toMatchObject({ code: failure === 'unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', retryable: false });
    } finally { await surface.dispose(cleanup()).catch(() => undefined); }
  });
});

describe('native surface ownership and fixed policy binding', () => {
  it('passes classified errors through untouched, whatever their class', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const observed = await surface.observe(operation());
    const command = vi.spyOn(EngineChannel.prototype, 'command');
    const before = frames.length;
    try {
      for (const failure of [new EngineError('NODE_STALE', 'gone', { retryable: true }), new TestError('INVALID_ARGUMENT', 'bad')]) {
        command.mockRejectedValueOnce(failure);
        await expect(surface.perform(observed.root.ref, { kind: 'tap' }, operation())).rejects.toBe(failure);
      }
      expect(command.mock.calls.map(([name]) => name)).toEqual(['browser.perform', 'browser.perform']);
      expect(frames.slice(before).filter(frame => frame['command'] === 'browser.perform')).toEqual([]);
    } finally { command.mockRestore(); await surface.dispose(cleanup()); }
  });

  it.each([false, true])('releases a failed-start provider lease without discarding unresolved cleanup evidence (%s)', async unresolved => {
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
      expect(release).toHaveBeenCalledTimes(1);
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
      const queries = frames.filter(frame => frame['command'] === 'fixture.query' || frame['command'] === 'fixture.read-fields');
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
  it.each(['ack-first', 'result-first', 'missing-ack'] as const)('settles an expired NativeSurface context without rereading its deadline (%s)', async order => {
    const surface = new NativeSurface({}); await start(surface);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 10_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const originalRequest = NativeClient.prototype.request;
    let expiredGetterReads = 0;
    let getter: ReturnType<typeof vi.spyOn> | undefined;
    let readProductionDeadline: (() => number) | undefined;
    const request = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, command, args, current, transition) {
      if (command === 'browser.observe' && holdObservation) {
        const productionGetter = Object.getOwnPropertyDescriptor(current, 'timeoutMs')?.get;
        expect(productionGetter).toBeTypeOf('function');
        readProductionDeadline = () => productionGetter!.call(current) as number;
        getter = vi.spyOn(current, 'timeoutMs', 'get').mockImplementation(() => {
          if (now >= 12_000) expiredGetterReads++;
          return readProductionDeadline!();
        });
      }
      return originalRequest.call(this, command, args, current, transition);
    });
    let finished = false;
    try {
      holdObservation = true;
      const reached = new Promise<void>(resolve => { observationHeld = resolve; });
      const pending = surface.observe({ ...operation(), timeoutMs: 2_000 }).then(
        value => { finished = true; return value; },
        (error: unknown) => { finished = true; return error; },
      );
      await reached;
      const original = frames.at(-1)!;
      expect(original).toMatchObject({ type: 'request', command: 'browser.observe', timeoutMs: 2_000 });
      now = 12_000;
      expect(readProductionDeadline).toThrow('Native operation exhausted its deadline before dispatch');
      const timerError: unknown = await vi.advanceTimersByTimeAsync(2_000).then(() => undefined, (error: unknown) => error);
      const boundary = { expiredGetterReads, cancelWrites: frames.filter(frame => frame['type'] === 'cancel').length, timerError };
      if (acknowledgeCancel !== undefined) {
        const cancel = frames.at(-1)!;
        expect(cancel).toMatchObject({ type: 'cancel', operationSeq: original['operationSeq'], generation: original['generation'] });
        expect(finished).toBe(false);
        if (order === 'missing-ack') {
          settleObservation!(); now += 4_999;
          await vi.advanceTimersByTimeAsync(4_999); expect(finished).toBe(false);
          now += 1; await vi.advanceTimersByTimeAsync(1);
          await expect(pending).resolves.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'The native browser operation ended without a settled outcome' });
          const submitted = frames.length;
          await expect(surface.observe(operation())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
          expect(frames).toHaveLength(submitted);
        } else {
          (order === 'ack-first' ? acknowledgeCancel : settleObservation)!();
          await vi.advanceTimersByTimeAsync(0);
          expect(finished).toBe(false);
          (order === 'ack-first' ? settleObservation : acknowledgeCancel)!();
          await expect(pending).resolves.toMatchObject({ code: 'OPERATION_TIMEOUT' });
          holdObservation = false;
          await expect(surface.observe(operation())).resolves.toMatchObject({ identityScope: 'scope-1' });
        }
        expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
      } else {
        // Let the old failure terminate before reporting its pre-exchange boundary.
        settleObservation!(); await vi.advanceTimersByTimeAsync(5_000); await pending;
      }
      expect(boundary).toEqual({ expiredGetterReads: 0, cancelWrites: 1, timerError: undefined });
      expect(expiredGetterReads).toBe(0);
    } finally {
      getter?.mockRestore(); request.mockRestore(); clock.mockRestore(); vi.useRealTimers();
      await surface.dispose(cleanup()).catch(() => undefined);
    }
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
  it.each(['engine', 'browser'] as const)('cancels an already submitted %s read when its exact attempt retires', async channel => {
    const surface = new NativeSurface({}); await start(surface);
    const command = channel === 'engine' ? 'browser.query' : 'page.title';
    const peer = holdRequests(command);
    const longOperation = { ...operation(), timeoutMs: 30_000 };
    const pending = (channel === 'engine'
      ? surface.locate({ kind: 'selector', selector: '#held' }, longOperation)
      : surface.command('page.title', {}, longOperation)).catch((cause: unknown) => cause);
    const held = await peer.next(command);
    const request = frames.find(frame => frame['command'] === command)!;
    holdScopeEnd = true;
    const ending = surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(frames.filter(frame => frame['type'] === 'cancel')).toEqual([
        expect.objectContaining({ generation: request['generation'], operationSeq: request['operationSeq'] }),
      ]);
      expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
      expect(frames.some(frame => frame['type'] === 'cancel' && frame['operationSeq'] !== request['operationSeq'])).toBe(false);
    } finally {
      acknowledgeCancel?.(); held.fail('cancelled');
      await new Promise(resolve => setImmediate(resolve));
      releaseScopeEnd?.(); holdScopeEnd = false;
      await expect(ending).resolves.toBeUndefined();
      await expect(pending).resolves.toMatchObject({ code: channel === 'engine' ? 'CANCELLED' : 'INVALID_STATE' });
      interceptRequest = undefined;
      await surface.dispose(cleanup());
    }
  });
  it.each(['engine', 'browser'] as const)('joins one %s cancellation independently of cleanup waiters and isolates the next attempt', async channel => {
    const surface = new NativeSurface({}); await start(surface);
    const command = channel === 'engine' ? 'browser.query' : 'page.title';
    const original = NativeClient.prototype.request;
    let requestSignal: AbortSignal | undefined;
    let cleanupSignal: AbortSignal | undefined;
    const inspect = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, name, args, current, transition) {
      if (name === command) requestSignal = current.signal;
      if (name === 'scope.end') cleanupSignal = current.signal;
      return original.call(this, name, args, current, transition);
    });
    try {
    const caller = new AbortController();
    const peer = holdRequests(command);
    const pending = (channel === 'engine'
      ? surface.locate({ kind: 'selector', selector: '#held' }, { ...operation(), signal: caller.signal, timeoutMs: 30_000 })
      : surface.command('page.title', {}, { ...operation(), signal: caller.signal, timeoutMs: 30_000 })).catch((cause: unknown) => cause);
    const held = await peer.next(command);
    const oldSignal = requestSignal!;
    expect(getEventListeners(oldSignal, 'abort')).toHaveLength(1);
    holdClose = true;
    const cleanupCaller = new AbortController();
    const first = surface.endAttempt({ signal: cleanupCaller.signal, timeoutMs: 1000 });
    const second = surface.endAttempt(cleanup());
    cleanupCaller.abort();
    await first;
    expect(caller.signal.aborted).toBe(false);
    expect(oldSignal.aborted).toBe(true);
    expect(getEventListeners(oldSignal, 'abort')).toHaveLength(0);
    expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
    acknowledgeCancel!();
    await new Promise(resolve => setImmediate(resolve));
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
    held.fail('cancelled'); await pending;
    await new Promise(resolve => setImmediate(resolve));
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
    expect(cleanupSignal).toBeUndefined();
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    let opened = false;
    const next = surface.startAttempt(context('next-after-cancel')).then(() => { opened = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(opened).toBe(false);
    releaseClose!(); holdClose = false; await second; await next;
    const fresh = (channel === 'engine'
      ? surface.locate({ kind: 'selector', selector: '#fresh' }, operation())
      : surface.command('page.title', {}, operation()));
    const freshRequest = await peer.next(command);
    const freshSignal = requestSignal!;
    expect(freshSignal).not.toBe(oldSignal); expect(freshSignal.aborted).toBe(false);
    caller.abort();
    expect(freshSignal.aborted).toBe(false);
    expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    freshRequest.succeed(channel === 'engine' ? { identityScope: currentScope, revision: '1', nodes: [] } : { title: 'fresh' });
    await fresh;
    expect(getEventListeners(freshSignal, 'abort')).toHaveLength(0);
    } finally { interceptRequest = undefined; inspect.mockRestore(); holdClose = false; releaseClose?.(); await surface.dispose(cleanup()).catch(() => undefined); }
  });
  it.each(['engine', 'browser'] as const)('preserves an already dispatched %s Unknown while retirement joins its request', async channel => {
    continueExactOwner = true;
    const surface = new NativeSurface({}); await start(surface);
    const command = channel === 'engine' ? 'browser.pointer' : 'page.evaluate';
    const peer = holdRequests(command);
    const pending = (channel === 'engine'
      ? surface.performAt({ x: 1, y: 1 }, { kind: 'tap' }, { ...operation(), timeoutMs: 30_000 })
      : surface.command('page.evaluate', { source: '() => 1', argument: null }, { ...operation(), timeoutMs: 30_000 })).catch((cause: unknown) => cause);
    const held = await peer.next(command);
    const ending = surface.endAttempt(cleanup());
    expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(1);
    acknowledgeCancel!(); held.retire();
    await expect(pending).resolves.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    await ending;
    expect(frames.filter(frame => frame['command'] === command)).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    interceptRequest = undefined; await surface.dispose(cleanup());
  });
  it.each(['engine', 'browser'] as const)('releases the %s request owner after synchronous channel failure and reentrant retirement', async channel => {
    const surface = new NativeSurface({}); await start(surface);
    const command = channel === 'engine' ? 'browser.query' : 'page.title';
    const original = NativeClient.prototype.request;
    const failure = new Error('synchronous request failure');
    let ending: Promise<void> | undefined;
    const request = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, name, args, current, transition) {
      if (name === command) { ending = surface.endAttempt(cleanup()); throw failure; }
      return original.call(this, name, args, current, transition);
    });
    const pending = channel === 'engine'
      ? surface.locate({ kind: 'selector', selector: '#held' }, operation())
      : surface.command('page.title', {}, operation());
    await expect(pending).rejects.toBe(failure);
    expect(ending).toBeDefined(); await ending;
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    request.mockRestore(); await surface.startAttempt(context('after-sync-failure'));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });
  it('spends the original retirement deadline while joining requests instead of renewing scope cleanup', async () => {
    const surface = new NativeSurface({}); await start(surface);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const peer = holdRequests('browser.query');
    const pending = surface.locate({ kind: 'selector', selector: '#held' }, { ...operation(), timeoutMs: 30_000 }).catch((cause: unknown) => cause);
    const held = await peer.next('browser.query'); holdScopeEnd = true;
    try {
      const waiter = surface.endAttempt({ ...cleanup(), timeoutMs: 5000 });
      const owner = retirementState(surface).endingAttempt!;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
      acknowledgeCancel!(); held.fail('cancelled'); await pending;
      await vi.advanceTimersByTimeAsync(0);
      const end = frames.find(frame => frame['command'] === 'scope.end')!;
      expect(end['timeoutMs']).toBeGreaterThan(0);
      expect(end['timeoutMs']).toBeLessThanOrEqual(1000);
      releaseScopeEnd!(); holdScopeEnd = false; await owner; await waiter;
    } finally { vi.useRealTimers(); interceptRequest = undefined; await surface.dispose(cleanup()); }
  });
  it('retains an expired request owner until exact settlement without renewing ordinary cleanup', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const original = NativeClient.prototype.request;
    let deliver!: (result: Awaited<ReturnType<NativeClient['request']>>) => void;
    let entered!: () => void; const enteredRequest = new Promise<void>(resolve => { entered = resolve; });
    const scope = currentScope;
    const request = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, name, args, current, transition) {
      if (name !== 'browser.query') return original.call(this, name, args, current, transition);
      entered(); return new Promise(resolve => { deliver = resolve; });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = surface.locate({ kind: 'selector', selector: '#never-settled' }, { ...operation(), timeoutMs: 30_000 }).catch((cause: unknown) => cause);
    await enteredRequest;
    const waiter = surface.endAttempt(cleanup());
    const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    try {
      await vi.advanceTimersByTimeAsync(1000); await waiter;
      let settled = false; void owner.then(() => { settled = true; });
      expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
      expect(settled).toBe(false);
      const controller = new AbortController();
      const next = surface.startAttempt(context('waiting-before-late', controller.signal)).catch((cause: unknown) => cause);
      controller.abort(); expect(await next).toMatchObject({ code: 'CANCELLED' });
      deliver({ type: 'result', id: 'held-query', generation: 1, operationSeq: 4, ok: true, data: { identityScope: scope, revision: '1', nodes: [] }, effects: 'completed', scopeState: 'usable' });
      await expect(pending).resolves.toMatchObject({ code: 'CANCELLED' });
      await owner;
      expect(retirementState(surface).retirementFailure).toBeUndefined();
      expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
      request.mockRestore(); vi.useRealTimers();
      await surface.startAttempt(context('fresh-after-proof'));
      expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(2);
      await surface.dispose(cleanup());
    } finally { request.mockRestore(); vi.useRealTimers(); }
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
  it('sends only selected field values under the original native callback token', async () => {
    const surface = new NativeSurface({}); await start(surface);
    queryNodes = [{ ref: { id: '@e2', revision: '1' }, text: 'current value', selector: '#not-requested', states: { secure: false } }];
    expect(vi.mocked(connectNativeProcess).mock.calls[0]?.[0].capabilities).toContain('browser.fixture-read-fields/1');
    const seen: unknown[] = [];
    const stop = surface.subscribe('network.request', async () => {
      seen.push(await surface.readFields({ kind: 'selector', selector: '#field' }, ['text'], operation()));
    });
    await sendEvent('network.request', { identityScope: currentScope, version: 1, registrationIds: [], request: { url: 'http://fixture.test/data', method: 'GET', headers: {} } }, { token: 'native-live-decision', timeoutMs: 1000 });
    expect(seen).toEqual([[{ text: 'current value', states: { secure: false } }]]);
    expect(frames.find(frame => frame['command'] === 'fixture.read-fields')).toMatchObject({ callbackToken: 'native-live-decision', args: { fields: ['text'] } });
    expect(frames.some(frame => ['fixture.query', 'browser.query', 'browser.observe', 'page.evaluate'].includes(String(frame['command'])))).toBe(false);
    stop(); await surface.dispose(cleanup());
  });
  it('does not fall back or emit a business operation when native field authority refuses', async () => {
    const surface = new NativeSurface({}); await start(surface);
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'fixture.read-fields') return false;
      reply({ ok: false, error: { code: 'scope-unavailable' }, effects: 'not-dispatched', scopeState: 'usable' }); return true;
    };
    await expect(surface.readFields({ kind: 'selector', selector: '#field' }, ['text'], operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(frames.filter(frame => frame['command'] === 'fixture.read-fields')).toHaveLength(1);
    expect(frames.some(frame => ['fixture.query', 'browser.query', 'browser.observe', 'page.evaluate'].includes(String(frame['command'])))).toBe(false);
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

  it('does not unsubscribe a replacement scope when an old subscription result reaches the waiter late', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const oldScope = currentScope;
    const native = surface.fixtureSurface();
    const command = native.command.bind(native);
    let returned!: () => void;
    const subscribed = new Promise<void>(resolve => { returned = resolve; });
    let resume!: () => void;
    const released = new Promise<void>(resolve => { resume = resolve; });
    native.command = async <K extends keyof BrowserCommandMap>(name: K, args: BrowserCommandMap[K]['args'], current: OperationContext): Promise<BrowserCommandMap[K]['result']> => {
      const result = await command(name, args, current);
      if (name === 'download.subscribe') { returned(); await released; }
      return result;
    };
    const fixtureContext = {
      operation, signal, attachArtifact: vi.fn(),
      fixture: (_name: string, target: object) => target, expectable: (target: object) => target,
      app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
    } as unknown as EngineFixtureContext;
    const trigger = vi.fn(async () => { throw new Error('retired trigger must not execute'); });
    const browser = createBrowserFixture(native, fixtureContext);
    const waiting = browser.waitForDownload(trigger).catch(cause => cause);
    try {
      await subscribed;
      await surface.reset(operation());
      expect(currentScope).not.toBe(oldScope);
      const replacement = await surface.command('download.subscribe', {}, operation());
      expect(replacement).toEqual({ subscriptionId: 'synthetic-subscription', identityScope: currentScope });
      resume();
      const outcome = await waiting;
      await surface.latch.settle(cleanup());
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe')).toEqual([]);
      expect(outcome).toMatchObject({ code: 'INVALID_STATE' });
      expect(trigger).not.toHaveBeenCalled();
      await surface.command('download.unsubscribe', { subscriptionId: replacement.subscriptionId }, operation());
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe').map(frame => frame['args'])).toEqual([
        { identityScope: currentScope, subscriptionId: 'synthetic-subscription' },
      ]);
    } finally { resume(); await surface.dispose(cleanup()); }
  });

  it('retires a download event with its scope owner after the attempt signal aborts', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const controller = new AbortController(); await surface.startAttempt(context('cancelled-download', controller.signal));
    const scope = surface.identityScope;
    let finish!: () => void;
    surface.subscribe('download.started', () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await sendEvent('download.started', { identityScope: scope, activePage: true, handle: 'cancelled-download', suggestedFilename: 'cancelled.bin' });
      controller.abort(); finish();
      await expect(surface.latch.settle(cleanup())).resolves.toBeUndefined();
      expect(frames.filter(frame => frame['command'] === 'download.release').map(frame => frame['args'])).toEqual([{ identityScope: scope, handle: 'cancelled-download' }]);
      await expect(surface.endAttempt(cleanup())).resolves.toBeUndefined();
      expect(frames.filter(frame => frame['command'] === 'scope.end').map(frame => frame['args'])).toContainEqual({ identityScope: scope });
    } finally { finish?.(); await surface.dispose(cleanup()).catch(() => undefined); }
  });

  it('unsubscribes a cancelled download without poisoning exact-scope cleanup', async () => {
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (bytes: Uint8Array) => void;
    const surface = new NativeSurface({ browser: {
      name: 'cancelled-download', scope: 'worker',
      acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release: async () => {},
      downloads: { dir: '/synthetic-downloads', read: async () => { entered(); return new Promise<Uint8Array>(resolve => { finish = resolve; }); } },
    } });
    await start(surface); await surface.endAttempt(cleanup());
    const directory = await mkdtemp(path.join(tmpdir(), 'cancelled-download-'));
    const controller = new AbortController(); await surface.startAttempt({ ...context('cancelled-download', controller.signal), artifactsDir: directory });
    const scope = surface.identityScope; const attached = vi.fn();
    const fixture = createBrowserFixture(surface.fixtureSurface(), {
      operation: () => ({ ...operation(), signal: controller.signal }), signal: controller.signal, attachArtifact: attached,
      fixture: (_name: string, target: object) => target, expectable: (target: object) => target,
      app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
    } as unknown as EngineFixtureContext);
    const waiting = fixture.waitForDownload(async () => {
      await sendEvent('download.started', { identityScope: scope, activePage: true, handle: 'held-download', suggestedFilename: 'cancelled.bin' });
    }).catch(cause => cause);
    try {
      await reading; controller.abort();
      expect(await waiting).toMatchObject({ code: 'CANCELLED' });
      finish(Buffer.from('late synthetic bytes'));
      await expect(surface.latch.settle(cleanup())).resolves.toBeUndefined();
      expect(attached).not.toHaveBeenCalled();
      expect(await readdir(path.join(directory, 'downloads'))).toEqual([]);
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe').map(frame => frame['args'])).toEqual([{ identityScope: scope, subscriptionId: 'synthetic-subscription' }]);
      await expect(surface.endAttempt(cleanup())).resolves.toBeUndefined();
    } finally { finish?.(Buffer.from('late synthetic bytes')); await waiting; await surface.dispose(cleanup()).catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
  });

  it('cleans the captured download scope without initiating recovery for a cancelled caller', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface);
    const oldScope = surface.identityScope;
    const { subscriptionId } = await surface.command('download.subscribe', {}, operation());
    await sendEvent('scope.disconnected', { identityScope: oldScope, reason: 'browser-connection-closed' });
    try {
      const result = await surface.command('download.unsubscribe', { subscriptionId }, { ...operation(), signal: AbortSignal.abort() }).catch(cause => cause);
      expect(frames.filter(frame => frame['command'] === 'scope.reconnect')).toEqual([]);
      expect(surface.identityScope).toBe(oldScope);
      expect(result).toBeNull();
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe').map(frame => frame['args'])).toEqual([{ identityScope: oldScope, subscriptionId }]);
      // Only subsequent business work may recover, and it still succeeds.
      await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
      expect(surface.identityScope).not.toBe(oldScope);
      expect(frames.filter(frame => frame['command'] === 'scope.reconnect')).toHaveLength(1);
    } finally { await surface.dispose(cleanup()); }
  });

  it('arms a download waiter only after subscription recovery and cleans the recovered scope', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface);
    const artifactsDir = await mkdtemp(path.join(tmpdir(), 'download-recovery-'));
    await surface.endAttempt(cleanup()); await surface.startAttempt({ ...context('download'), artifactsDir });
    const attachArtifact = vi.fn();
    const fixtureContext = {
      operation, signal, timeouts: { action: 1000, test: 5000, assertion: 1000 }, attachArtifact,
      fixture: (_name: string, target: object) => target, expectable: (target: object) => target,
      app: { resolveUrl: (url: string) => new URL(url, 'http://fixture.test/').href },
    } as unknown as EngineFixtureContext;
    const browser = createBrowserFixture(surface.fixtureSurface(), fixtureContext);
    const oldScope = currentScope;
    const bytes = Buffer.from('recovered download');
    interceptRequest = (frame, reply) => {
      if (frame['command'] === 'download.metadata') { reply({ data: { identityScope: currentScope, source: 'local' } }); return true; }
      if (frame['command'] !== 'download.read') return false;
      reply({ data: { base64: bytes.toString('base64'), nextOffset: bytes.length, eof: true } }); return true;
    };
    await sendEvent('scope.disconnected', { identityScope: oldScope, reason: 'browser-connection-closed' });
    const trigger = vi.fn(async () => {
      expect(currentScope).not.toBe(oldScope);
      expect(frames.findLast(frame => frame['command'] === 'download.subscribe')?.['args']).toMatchObject({ identityScope: currentScope });
      await sendEvent('download.started', { identityScope: oldScope, activePage: true, handle: 'retired-download', suggestedFilename: 'retired.txt' });
      await sendEvent('download.started', { identityScope: currentScope, activePage: false, handle: 'other-page-download', suggestedFilename: 'other.txt' });
      await sendEvent('download.started', { identityScope: currentScope, activePage: true, handle: 'recovered-download', suggestedFilename: 'kept.txt' });
    });
    try {
      const download = await browser.waitForDownload(trigger);
      expect(trigger).toHaveBeenCalledOnce();
      expect(await readFile(download.absolutePath, 'utf8')).toBe('recovered download');
      expect(attachArtifact).toHaveBeenCalledExactlyOnceWith('download', download.path);
      expect(frames.filter(frame => frame['command'] === 'download.read')).toHaveLength(1);
      expect(frames.findLast(frame => frame['command'] === 'download.read')?.['args']).toMatchObject({ identityScope: currentScope, handle: 'recovered-download' });
      expect(frames.findLast(frame => frame['command'] === 'download.unsubscribe')?.['args']).toMatchObject({ identityScope: currentScope, subscriptionId: 'synthetic-subscription' });
      const failure = new Error('trigger failed');
      await expect(browser.waitForDownload(async () => { throw failure; })).rejects.toBe(failure);
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe')).toHaveLength(2);
      // Recovery before arming is allowed; a scope replacement after arming is not.
      await expect(browser.waitForDownload(async () => {
        await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
        await surface.command('page.title', {}, operation());
        await sendEvent('download.started', { identityScope: currentScope, activePage: true, handle: 'replacement-download', suggestedFilename: 'replacement.txt' });
      })).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      expect(frames.filter(frame => frame['command'] === 'download.read')).toHaveLength(1);
      expect(frames.filter(frame => frame['command'] === 'download.unsubscribe')).toHaveLength(2);
    } finally { await surface.dispose(cleanup()); await rm(artifactsDir, { recursive: true, force: true }); }
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
  it('retains the original scope and cached refusal without replay after a clean reconnect refusal', async () => {
    const reconnect = vi.fn(async () => 'ws://synthetic.test/replacement');
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/original', reconnectEndpoint: reconnect } });
    await start(surface);
    const originalScope = currentScope;
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'scope.reconnect') return false;
      reply({ ok: false, error: { code: 'stale-scope' }, effects: 'not-dispatched', scopeState: 'usable' });
      return true;
    };
    try {
      await sendEvent('scope.disconnected', { identityScope: originalScope, reason: 'browser-connection-closed' });
      const beforeRecovery = frames.length;
      const firstFailure: unknown = await surface.observe(operation()).catch((cause: unknown) => cause);
      expect(firstFailure).toBeInstanceOf(EngineError);
      expect(firstFailure).toMatchObject({ code: 'INVALID_STATE', retryable: false });
      expect(reconnect).toHaveBeenCalledOnce();
      expect(frames.slice(beforeRecovery)).toHaveLength(1);
      expect(frames[beforeRecovery]).toMatchObject({ command: 'scope.reconnect', args: {
        identityScope: originalScope, expectedBrowserIdentity: 'browser-owner', expectedContextIdentity: 'context-1', expectedPageIdentity: 'page-1',
      } });
      const afterRefusal = frames.length;
      await expect(surface.observe(operation())).rejects.toBe(firstFailure);
      expect(frames).toHaveLength(afterRefusal);
      expect(reconnect).toHaveBeenCalledOnce();
      await surface.endAttempt(cleanup());
      const cleanupCommands = frames.slice(afterRefusal).filter(frame => frame['command'] !== undefined);
      expect(cleanupCommands).toHaveLength(1);
      expect(cleanupCommands[0]).toMatchObject({ command: 'scope.end', args: { identityScope: originalScope } });
    } finally { await surface.dispose(cleanup()); }
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
  it('records live semantic traces without advancing semantic authority between two actions', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); const environment = vi.fn();
    await surface.startAttempt({ ...context('traced'), screen, environment });
    const read = vi.spyOn(EngineChannel.prototype, 'readBlob').mockResolvedValue(Buffer.from('synthetic-protected-pixels'));
    try {
      await surface.open('http://synthetic.test', operation());
      const snapshot = await surface.observe(operation());
      await surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      await surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      expect(screen).toHaveBeenCalledTimes(3);
      expect(screen.mock.calls[0]![0]).toMatchObject({ root: { role: 'document', name: 'live trace' } });
      expect(screen.mock.calls[0]![0].treeUnavailable).toBeUndefined();
      expect(screen.mock.calls[0]![0].pixels).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(1);
      expect(frames.filter(frame => frame['command'] === 'browser.trace')).toHaveLength(3);
      expect(frames.filter(frame => frame['command'] === 'capture.screenshot')).toHaveLength(0);
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => (frame['args'] as { ref: unknown }).ref)).toEqual([{ id: '@e1', revision: '1' }, { id: '@e1', revision: '1' }]);
      expect(environment).toHaveBeenCalledWith({ browser: 'Synthetic Chromium', 'user agent': 'synthetic-agent' });
      expect(frames.some(frame => frame['command'] === 'fixture.query')).toBe(false);
    } finally { read.mockRestore(); await surface.dispose(cleanup()); }
  });

  it('omits a settled one-second trace timeout without failing or replaying the action or retiring its observed ref', async () => {
    const peer = holdRequests('browser.trace');
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); await surface.startAttempt({ ...context('trace-timeout'), screen });
    try {
      const snapshot = await surface.observe(operation());
      const cancelled = new Promise<void>(resolve => { cancellationObserved = resolve; });
      const first = surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      const held = await peer.next('browser.trace');
      const trace = frames.findLast(frame => frame['command'] === 'browser.trace')!;
      expect(trace['timeoutMs']).toBeGreaterThan(0);
      expect(trace['timeoutMs']).toBeLessThanOrEqual(1000);
      // Let the actual client timer/AbortSignal expire, not a synthetic action
      // error. A cancel ACK alone is not settlement: return the exact clean
      // native DeadlineExceeded/NotDispatched/Usable outcome as well.
      await cancelled;
      expect(frames.filter(frame => frame['type'] === 'cancel' && frame['operationSeq'] === trace['operationSeq'])).toHaveLength(1);
      acknowledgeCancel!(); held.fail('deadline-exceeded');
      await expect(first).resolves.toBeUndefined();
      expect(screen).not.toHaveBeenCalled();
      expect(frames.filter(frame => frame['command'] === 'browser.perform')).toHaveLength(1);
      const second = surface.perform(snapshot.root.ref, { kind: 'tap' }, operation());
      (await peer.next('browser.trace')).succeed(observation('2'));
      await expect(second).resolves.toBeUndefined();
      expect(screen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ root: { ...observation('2').root, ref: { id: 'root', revision: expect.stringMatching(/^t[0-9]+$/) } } }));
      expect(frames.filter(frame => frame['command'] === 'browser.observe')).toHaveLength(1);
      expect(frames.filter(frame => frame['command'] === 'browser.trace')).toHaveLength(2);
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => (frame['args'] as { ref: unknown }).ref)).toEqual([{ id: '@e1', revision: '1' }, { id: '@e1', revision: '1' }]);
      expect(frames.some(frame => ['fixture.query', 'capture.screenshot'].includes(String(frame['command'])))).toBe(false);
    } finally { cancellationObserved = undefined; await surface.dispose(cleanup()); }
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
    await expect(surface.dispose(cleanup())).resolves.toBeUndefined();
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
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
  it('retains an unresolved recorder owner after releasing its lease at the caller deadline', async () => {
    let finish!: (recording: ProviderRecording) => void;
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record: () => new Promise<ProviderRecording>(resolve => { finish = resolve; }) } });
    await start(surface); const starting = surface.startVideo(operation()).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    await expect(surface.endAttempt({ ...cleanup(), timeoutMs: 10 })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const next = surface.startAttempt(context('next', controller.signal)).catch((cause: unknown) => cause);
    controller.abort();
    await expect(next).resolves.toMatchObject({ code: 'CANCELLED' });
    finish({ startedAt: '2026-10-21T00:00:00.000Z', stop: async () => ({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }) });
    await starting; await surface.endAttempt(cleanup()); expect(release).toHaveBeenCalledTimes(1);
    await surface.dispose(cleanup());
  });

  it('blocks a new attempt throughout native teardown and joins concurrent cleanup callers', async () => {
    const surface = new NativeSurface({}); await start(surface); holdScopeEnd = true;
    const first = surface.endAttempt(cleanup()); const second = surface.endAttempt(cleanup());
    let started = false;
    const next = surface.startAttempt(context('after-cleanup')).then(() => { started = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(started).toBe(false);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
    releaseScopeEnd!(); await Promise.all([first, second, next]); holdScopeEnd = false;
    await surface.dispose(cleanup());
  });

  it('does not stage a retired file selection into the replacement attempt', async () => {
    const surface = new NativeSurface({}); await start(surface);
    let finish!: (selection: uploadFiles.UploadSelection) => void;
    const select = vi.spyOn(uploadFiles, 'selectUploadFiles').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      queryNodes = [{ ref: { id: '@e7', revision: '1' } }];
      const [located] = await surface.locate({ kind: 'selector', selector: '#upload' }, operation(), { purpose: 'fixture' });
      const pending = surface.perform(located!.ref, { kind: 'setInputFiles', paths: ['/synthetic/file'] }, operation()).catch((cause: unknown) => cause);
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

  // Original video case 6: run 40137712725 at native 643157 executes
  // recording_unarmed_page_hooks_and_stop_are_resource_free_noops. That producer
  // proves the never-armed pageOpened/pageClosing hooks; this public peer proves
  // only empty-stop decoding, exact forwarding and absence of adapter recording work.
  it('runs every hook straight through until armed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-video-never-armed-'));
    const engine = web({});
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!({ ...context('video-never-armed'), artifactsDir: directory });
    try {
      const fixture = nativeBrowser(engine, operation);
      await expect(fixture.title()).resolves.toBe('Synthetic page');
      const scope = currentScope;
      const beforeStop = frames.length;
      expect(frames.filter(frame => frame['command'] === 'recording.start')).toEqual([]);
      await expect(engine.artifacts!.stopVideo!(operation())).resolves.toEqual([]);
      expect(frames.slice(beforeStop).filter(frame => frame['type'] === 'request').map(frame => [frame['command'], frame['args']])).toEqual([
        ['recording.stop', { identityScope: scope }],
      ]);
      const stop = frames.slice(beforeStop).find(frame => frame['command'] === 'recording.stop');
      expect(stop?.['timeoutMs']).toBeGreaterThan(0);
      expect(stop?.['timeoutMs']).toBeLessThanOrEqual(1000);
      expect(frames.filter(frame => ['recording.start', 'blob.read', 'blob.release'].includes(String(frame['command'])))).toEqual([]);
      expect(existsSync(path.join(directory, 'video'))).toBe(false);
      await expect(fixture.title()).resolves.toBe('Synthetic page');
      expect(currentScope).toBe(scope);
      expect(frames.slice(beforeStop).filter(frame => frame['type'] === 'request').map(frame => frame['command'])).toEqual(['recording.stop', 'page.title']);
    } finally { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); await rm(directory, { recursive: true, force: true }); } }
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

  // Original video.ts obligations, paired with CI27's executed producer ledger
  // tests. This peer proves artifact collection/no adapter replay, not encoding,
  // a real failed stop or producer-owned late page-hook cleanup.
  it('keeps a segment whose stop failed but whose file exists', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'native-retained-video-'));
    const engine = web({});
    await engine.init!({ runId: 'run', targetName: 'web', projectRoot: '/tmp', app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => {} });
    await engine.startAttempt!({ ...context('retained-video'), artifactsDir: directory });
    try {
      recordingSegments = [{ identityScope: currentScope, handle: 'retained-video', size: recordingBytes.length, sha256: createHash('sha256').update(recordingBytes).digest('hex'), mediaType: 'video/webm', startedAt: '2026-10-21T00:00:01.000Z' }];
      const segments = await engine.artifacts!.stopVideo!(operation());
      expect(segments).toEqual([{ path: 'video/video.webm', startedAt: '2026-10-21T00:00:01.000Z' }]);
      expect(await readFile(path.join(directory, 'video/video.webm'))).toEqual(recordingBytes);
      expect(frames.filter(frame => frame['command'] === 'blob.release')).toHaveLength(1);
      expect(await engine.artifacts!.stopVideo!(operation())).toEqual([]);
    } finally { try { await engine.endAttempt!(cleanup()); } finally { await engine.dispose!(cleanup()); await rm(directory, { recursive: true, force: true }); } }
  });

  it('starts no segment for a page opened after the attempt abandoned its recording', async () => {
    const surface = new NativeSurface({});
    await start(surface);
    try {
      await surface.startVideo(operation());
      await surface.endAttempt(cleanup());
      const retired = frames.length;
      await expect(surface.startVideo(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(frames).toHaveLength(retired);
      await surface.startAttempt(context('after-abandoned-recording'));
      await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
      expect(frames.filter(frame => frame['command'] === 'recording.start')).toHaveLength(1);
      expect(frames.slice(retired).filter(frame => frame['command'] === 'recording.start' || frame['command'] === 'recording.stop')).toEqual([]);
    } finally { await surface.dispose(cleanup()); }
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
    await expect(surface.dispose(cleanup())).resolves.toBeUndefined();
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(2);
  });
  it('retires a policy-rejected known scope once while refusing unpublished business work', async () => {
    repeatContextIdentity = true;
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); await surface.endAttempt(cleanup()); holdScopeEnd = true;
    await expect(surface.startAttempt(context('reused-context'))).rejects.toThrow(/reused a browser/);
    await expect(surface.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const first = surface.endAttempt(cleanup()); const second = surface.endAttempt(cleanup());
    await vi.waitFor(() => expect(releaseScopeEnd).toBeDefined());
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(2);
    releaseScopeEnd!(); await Promise.all([first, second]); await surface.dispose(cleanup());
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(2);
    expect(frames.filter(frame => frame['command'] === 'scope.configure')).toHaveLength(1);
    expect(frames.some(frame => frame['command'] === 'page.title')).toBe(false);
  });
  it('preserves cleanup failure after a known policy rejection and never grants a new attempt', async () => {
    repeatContextIdentity = true;
    const surface = new NativeSurface({ connect: { cdpEndpoint: () => 'ws://synthetic.test/browser', reconnectEndpoint: () => 'ws://synthetic.test/browser' } });
    await start(surface); await surface.endAttempt(cleanup());
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'scope.end') return false;
      reply({ ok: false, error: { code: 'cleanup-failed' }, effects: 'unknown', scopeState: 'quarantined' }); return true;
    };
    await expect(surface.startAttempt(context('reused-context'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const failure = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    await expect(surface.startAttempt(context('must-remain-blocked'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(2);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(2);
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
    await expect(surface.startAttempt(context('new-proxy-same-lease'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(acquire).toHaveBeenCalledTimes(1); await expect(surface.dispose(cleanup())).rejects.toBeDefined();
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

describe('native initial action trace publication', () => {
  it.each(['first', 'observe', 'same-scope restart', 'cancelled', 'failed-trace'] as const)('keeps semantic trace presentation bound to its original %s owner', async mode => {
    const peer = holdRequests('browser.trace');
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); await surface.startAttempt({ ...context('first-trace'), screen });
    const controller = new AbortController();
    try {
      const action = surface.open('https://synthetic.test/', { ...operation(), signal: controller.signal });
      const request = await peer.next('browser.trace');
      expect(request.args['options']).toEqual({});
      if (mode === 'observe') await surface.observe(operation());
      if (mode === 'same-scope restart') { preserveRestartScope = true; await surface.restart(operation()); }
      if (mode === 'cancelled') controller.abort();
      if (mode === 'failed-trace') request.fail('cleanup-failed', 'unknown'); else request.succeed(observation('7'));
      await action;
      if (mode === 'first') {
        expect(screen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ root: { ref: { id: 'root', revision: 't1' }, role: 'document', name: 'snapshot 7' }, viewport: { width: 100, height: 80 } }));
        expect(frames.some(frame => frame['command'] === 'browser.observe' || frame['command'] === 'fixture.query')).toBe(false);
      } else expect(screen).not.toHaveBeenCalled();
      expect(frames.some(frame => ['capture.screenshot', 'blob.read', 'blob.release'].includes(String(frame['command'])))).toBe(false);
    } finally { await surface.dispose(cleanup()).catch(() => undefined); }
  });
});

describe('terminal cleanup surface ownership', () => {
  it('joins independent cleanup after Unknown without dispatching scope.end or recovery', async () => {
    const surface = new NativeSurface({}); await start(surface);
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'page.title') return false;
      reply({ ok: false, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined' }); return true;
    };
    await expect(surface.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await surface.endAttempt(cleanup());
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(frames.some(frame => frame['command'] === 'scope.end' || frame['command'] === 'scope.reconnect')).toBe(false);
    interceptRequest = undefined;
    await surface.startAttempt(context('after-confirmed-retirement'));
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.endAttempt(cleanup()); await surface.dispose(cleanup());
  });
  it('retains a rejected provider lease release and never retries or reacquires blindly', async () => {
    const lease = { id: 'unresolved-lease', cdpEndpoint: 'ws://synthetic.test/browser' };
    const acquire = vi.fn(async () => lease);
    const release = vi.fn(async (_lease: { id: string }) => { throw new Error('release outcome unconfirmed'); });
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire, release } });
    await start(surface);
    const first = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(first).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBe(lease);
    await expect(surface.endAttempt(cleanup())).rejects.toBe(first);
    await expect(surface.dispose(cleanup())).rejects.toBe(first);
    await expect(surface.startAttempt(context('must-not-acquire'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('retains a genuine scope.end cleanup failure after final shutdown succeeds', async () => {
    const surface = new NativeSurface({}); await start(surface);
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'scope.end') return false;
      reply({ ok: false, error: { code: 'cleanup-failed' }, effects: 'unknown', scopeState: 'quarantined' }); return true;
    };
    const first = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(first).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt(cleanup())).rejects.toBe(first);
    await expect(surface.dispose(cleanup())).rejects.toBe(first);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  });
});

/** Owner state is inspected only to distinguish actual cleanup from a departed waiter. */
function retirementState(surface: NativeSurface) {
  return surface as unknown as {
    endingAttempt?: Promise<void>;
    client?: NativeClient;
    retiringAttempt?: { downloads: Map<string, unknown>; observationHighWater?: unknown };
    retirementFailure?: unknown;
  };
}

describe('provider release is independent from failed native cleanup', () => {
  it.each(['recording', 'native-close'] as const)('releases the exact attempt lease after %s failure without granting UI reuse', async failing => {
    const lease = { id: 'independent-lease', cdpEndpoint: 'ws://synthetic.test/browser' };
    const primary = new Error('primary cleanup failure');
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => lease, release,
      record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: async () => { throw primary; } }),
    } });
    await start(surface);
    if (failing === 'recording') await surface.startVideo(operation());
    const close = failing === 'native-close' ? vi.spyOn(NativeClient.prototype, 'close').mockRejectedValue(primary) : undefined;
    try {
      const failure = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
      if (failing === 'recording') expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
      else expect(failure).toBe(primary);
      expect(release).toHaveBeenCalledExactlyOnceWith(lease, expect.objectContaining({ runId: 'run', targetName: 'web' }));
      expect(retirementState(surface).retiringAttempt).toBeDefined();
      await expect(surface.startAttempt(context('must-not-reuse'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(surface.dispose(cleanup())).rejects.toBe(failure);
      expect(release).toHaveBeenCalledTimes(1);
      expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
    } finally { close?.mockRestore(); await surface.dispose(cleanup()).catch(() => undefined); }
  });

  it('preserves the primary recorder failure when exact lease release also fails', async () => {
    const primary = new Error('primary recorder stop failed');
    const secondary = new Error('secondary lease release failed');
    const release = vi.fn(async () => { throw secondary; });
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'both-fail', cdpEndpoint: 'ws://synthetic.test/browser' }), release,
      record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: async () => { throw primary; } }),
    } });
    await start(surface); await surface.startVideo(operation());
    const failure = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the primary recorder failure when release exhausts the same cleanup budget', async () => {
    const primary = new Error('primary recorder stop failed before release timeout');
    const release = vi.fn(async (_lease: unknown, budget: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => { budget.signal.addEventListener('abort', () => reject(new Error('release aborted')), { once: true }); }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'release-timeout', cdpEndpoint: 'ws://synthetic.test/browser' }), release,
      record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: async () => { throw primary; } }),
    } });
    await start(surface); await surface.startVideo(operation());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const ending = surface.endAttempt({ signal, timeoutMs: 1000 }).catch((cause: unknown) => cause);
      const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(1000); await ending;
      const failure = await owner;
      expect(release).toHaveBeenCalledTimes(1);
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: primary });
      await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    } finally { vi.useRealTimers(); }
  });

  it('releases a worker-owned replacement independently of an unconfirmed native close', async () => {
    let acquisitions = 0;
    const acquire = vi.fn(async () => ({ id: `worker-${++acquisitions}`, cdpEndpoint: 'ws://synthetic.test/browser' }));
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire, release } });
    await start(surface);
    await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement'));
    expect(acquire).toHaveBeenCalledTimes(2);
    const primary = new Error('worker native close unconfirmed');
    const close = vi.spyOn(NativeClient.prototype, 'close').mockRejectedValue(primary);
    try {
      await expect(surface.dispose(cleanup())).rejects.toBe(primary);
      expect(release).toHaveBeenCalledExactlyOnceWith(await acquire.mock.results[1]!.value, expect.objectContaining({ runId: 'run' }));
      await expect(surface.startAttempt(context('must-not-reuse'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally { close.mockRestore(); await surface.dispose(cleanup()).catch(() => undefined); }
  });
});

describe('caller-bounded cleanup with retained exact settlement', () => {
  it('revokes synchronously on pre-cancel and waits for native close without dispatching scope.end', async () => {
    const surface = new NativeSurface({}); await start(surface); const old = surface.fixtureSurface();
    holdClose = true;
    const ending = surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
    expect(() => old.identityScope).toThrow();
    await expect(ending).resolves.toBeUndefined();
    const owner = retirementState(surface).endingAttempt!;
    expect(owner).toBeDefined();
    expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
    const nextController = new AbortController();
    const next = surface.startAttempt(context('cancelled-next-wait', nextController.signal)).catch((cause: unknown) => cause);
    nextController.abort(); expect(await next).toMatchObject({ code: 'CANCELLED' });
    expect(retirementState(surface).endingAttempt).toBe(owner);
    releaseClose!(); await owner; holdClose = false;
    await surface.startAttempt(context('fresh-after-close'));
    expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(2);
    expect(() => old.identityScope).toThrow();
    await surface.dispose(cleanup());
  });

  it.each(['abort', 'timeout'] as const)('keeps one owner after caller %s until actual close, not just cancel ACK', async mode => {
    const surface = new NativeSurface({}); await start(surface); holdScopeEnd = true; holdClose = true;
    const controller = new AbortController();
    const ending = surface.endAttempt({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 10 : 100 });
    const owner = retirementState(surface).endingAttempt!;
    const scopeEnd = frames.find(frame => frame['command'] === 'scope.end')!;
    expect(scopeEnd['timeoutMs']).toBeLessThanOrEqual(mode === 'timeout' ? 10 : 100);
    if (mode === 'abort') controller.abort();
    await ending;
    await vi.waitFor(() => expect(releaseClose).toBeDefined());
    acknowledgeCancel?.();
    let settled = false; void owner.then(() => { settled = true; });
    const duplicate = surface.endAttempt({ ...cleanup(), timeoutMs: 5000 });
    let started = false; const next = surface.startAttempt(context('next-after-retained-close')).then(() => { started = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(started).toBe(false);
    expect(retirementState(surface).endingAttempt).toBe(owner);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    releaseClose!(); await Promise.all([owner, duplicate, next]); holdClose = false; holdScopeEnd = false;
    expect(started).toBe(true);
    expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(2);
    await surface.dispose(cleanup());
  });

  it('retains a late cleanup failure after the caller aborts even when terminal close succeeds', async () => {
    const surface = new NativeSurface({}); await start(surface); const peer = holdRequests('scope.end'); holdClose = true;
    const controller = new AbortController();
    const ending = surface.endAttempt({ ...cleanup(), signal: controller.signal });
    const request = await peer.next('scope.end'); const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    controller.abort(); await ending;
    request.fail('cleanup-failed', 'unknown');
    await vi.waitFor(() => expect(releaseClose).toBeDefined()); releaseClose!();
    const failure = await owner;
    expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.startAttempt(context('not-after-real-cleanup-failure'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
  });

  it('keeps missing native close proof unresolved through the existing safety deadline', async () => {
    const surface = new NativeSurface({}); await start(surface); holdClose = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      await surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
      const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
      let completed = false; void owner.then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(14_999); expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const failure = await owner;
      expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      await expect(surface.startAttempt(context('no-close-proof'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(surface.dispose(cleanup())).rejects.toBe(failure);
      expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      expect(frames.some(frame => frame['command'] === 'scope.end')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('releases a worker-owned lease at the caller deadline while retaining its unfinished recorder', async () => {
    let acquisitions = 0; let finishStop!: () => void;
    const release = vi.fn(async (_lease: unknown, _current: { signal: AbortSignal }) => {});
    const stop = vi.fn((_current: { signal: AbortSignal }) => new Promise<{ url: string; mediaType: string }>(resolve => { finishStop = () => resolve({ url: 'https://synthetic.test/worker.mp4', mediaType: 'video/mp4' }); }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', acquire: async () => ({ id: `worker-${++acquisitions}`, cdpEndpoint: 'ws://synthetic.test/browser' }), release,
      record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop }),
    } });
    await start(surface); await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
    await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement')); await surface.startVideo(operation());
    const departing = surface.dispose({ signal, timeoutMs: 10 });
    const owner = (surface as unknown as { disposing: Promise<void> }).disposing;
    await expect(departing).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(release.mock.calls[0]![0]).toMatchObject({ id: 'worker-2' });
    expect(release.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(stop.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(retirementState(surface).retiringAttempt).toBeDefined();
    finishStop(); await owner;
    expect(release).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
  });

  it('retains actual provider receipts after the caller deadline without extending their effect signal', async () => {
    let finishStop!: () => void; let finishRelease!: () => void;
    const stop = vi.fn((_current: { signal: AbortSignal }) => new Promise<{ url: string; mediaType: string }>(resolve => { finishStop = () => resolve({ url: 'https://synthetic.test/ended.mp4', mediaType: 'video/mp4' }); }));
    const release = vi.fn((_lease: unknown, _current: { signal: AbortSignal }) => new Promise<void>(resolve => { finishRelease = resolve; }));
    let acquired = 0;
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: `lease-${++acquired}`, cdpEndpoint: 'ws://synthetic.test/browser' }), release,
      record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop }),
    } });
    await start(surface); await surface.startVideo(operation());
    await surface.endAttempt({ signal, timeoutMs: 10 });
    const owner = retirementState(surface).endingAttempt!;
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(stop.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(release.mock.calls[0]![1].signal).toBe(stop.mock.calls[0]![0].signal);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
    let started = false; const next = surface.startAttempt(context('after-real-receipts')).then(() => { started = true; });
    finishStop(); await new Promise(resolve => setImmediate(resolve)); expect(started).toBe(false);
    finishRelease(); await Promise.all([owner, next]);
    expect(acquired).toBe(2); expect(release).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
    const disposing = surface.dispose(cleanup()); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2)); finishRelease(); await disposing;
  });
});

describe('bounded native attempt cleanup ownership', () => {
  it.each(['already-aborted', 'mid-wait-abort', 'wait-timeout'] as const)('finishes one owned cleanup after %s without granting early business authority', async mode => {
    const surface = new NativeSurface({}); await start(surface);
    await surface.observe(operation());
    holdScopeEnd = true; holdClose = true;
    const controller = new AbortController();
    if (mode === 'already-aborted') controller.abort();
    const waiting = surface.endAttempt({ signal: controller.signal, timeoutMs: mode === 'already-aborted' ? 0 : mode === 'wait-timeout' ? 10 : 1000 });
    const owner = retirementState(surface).endingAttempt;
    const retired = retirementState(surface).retiringAttempt!;
    retired.downloads.set('retained-download', Promise.resolve(Buffer.from('old attempt')));
    expect(owner).toBeDefined();
    const expectedEnds = mode === 'already-aborted' ? 0 : 1;
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(expectedEnds);
    if (expectedEnds > 0) expect(frames.find(frame => frame['command'] === 'scope.end')!['timeoutMs']).toBeLessThanOrEqual(mode === 'wait-timeout' ? 10 : 1000);
    if (mode === 'mid-wait-abort') controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    const duplicate = surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
    await expect(duplicate).resolves.toBeUndefined();
    expect(retirementState(surface).endingAttempt).toBe(owner);
    let opened = false;
    const next = surface.startAttempt(context('after-owned-cleanup')).then(() => { opened = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(opened).toBe(false);
    await expect(surface.command('page.title', {}, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(expectedEnds);
    expect(frames.filter(frame => frame['type'] === 'cancel')).toHaveLength(expectedEnds);
    expect(retired.downloads.size).toBe(1);
    releaseClose!(); await owner; await next; holdScopeEnd = false; holdClose = false;
    expect(retirementState(surface)).toMatchObject({ retiringAttempt: undefined, endingAttempt: undefined, retirementFailure: undefined });
    expect(retired.downloads.size).toBe(0);
    expect(retired.observationHighWater).toBeUndefined();
    await expect(surface.command('page.title', {}, operation())).resolves.toEqual({ title: 'Synthetic page' });
    await surface.dispose(cleanup());
  });

  it('keeps a late native cleanup failure permanent after its caller has left', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const peer = holdRequests('scope.end');
    holdClose = true; const controller = new AbortController();
    const ending = surface.endAttempt({ ...cleanup(), signal: controller.signal });
    const request = await peer.next('scope.end');
    controller.abort(); await ending;
    const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    const next = surface.startAttempt(context('must-not-open')).catch((cause: unknown) => cause);
    request.fail('cleanup-failed', 'unknown');
    await vi.waitFor(() => expect(releaseClose).toBeDefined()); releaseClose!();
    const failure = await owner;
    expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(await next).toBe(failure);
    await expect(surface.endAttempt(cleanup())).rejects.toBe(failure);
    await expect(surface.startAttempt(context('still-must-not-open'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(surface.dispose(cleanup())).rejects.toBe(failure);
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  });

  it('spends one caller deadline across recorder and scope cleanup, retaining native close after expiry', async () => {
    let finishRecording!: () => void;
    const release = vi.fn(async (_lease: unknown, _context: { signal: AbortSignal }) => {});
    const stopped = vi.fn(() => new Promise<{ url: string; mediaType: string }>(resolve => { finishRecording = () => resolve({ url: 'https://synthetic.test/video', mediaType: 'video/mp4' }); }));
    const acquire = vi.fn(async () => ({ id: 'owned-lease', cdpEndpoint: 'ws://synthetic.test/browser' }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire, release, record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped }) } });
    await start(surface); await surface.startVideo(operation());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      holdScopeEnd = true; holdClose = true;
      const waiting = surface.endAttempt({ signal, timeoutMs: 15_000 });
      const retired = retirementState(surface).retiringAttempt;
      const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(9000);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
      finishRecording(); await vi.advanceTimersByTimeAsync(0);
      expect(frames.find(frame => frame['command'] === 'scope.end')).toMatchObject({ timeoutMs: 6000 });
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6000);
      await waiting;
      expect(retirementState(surface).retiringAttempt).toBe(retired);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]![1].signal.aborted).toBe(true);
      expect(acquire).toHaveBeenCalledTimes(1);
      let finished = false; void owner.then(() => { finished = true; });
      releaseScopeEnd!(); acknowledgeCancel?.(); await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(false);
      releaseClose!(); await owner; holdClose = false; holdScopeEnd = false;
      expect(retirementState(surface).retirementFailure).toBeUndefined();
      await surface.startAttempt(context('fresh-after-terminal-proof'));
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(vi.mocked(connectNativeProcess)).toHaveBeenCalledTimes(2);
      await surface.dispose(cleanup());
    } finally { vi.useRealTimers(); }
  });

  it('passes the caller remainder to native close while retaining its independent correlated proof', async () => {
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'late-close-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release } });
    await start(surface);
    const client = retirementState(surface).client;
    const close = vi.spyOn(NativeClient.prototype, 'close');
    holdScopeEnd = true; holdClose = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const waiting = surface.endAttempt({ signal, timeoutMs: 15_000 });
      const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(9000); releaseScopeEnd!(); await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.calls[0]![0].timeoutMs).toBe(6000);
      const nativeClose = close.mock.results[0]!.value as Promise<void>;
      await vi.advanceTimersByTimeAsync(6000);
      await waiting;
      expect(release).toHaveBeenCalledTimes(1);
      expect(retirementState(surface).client).toBe(client);
      expect(retirementState(surface).retiringAttempt).toBeDefined();
      let finished = false; void owner.then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(false);
      releaseClose!(); await nativeClose; await owner;
      expect(retirementState(surface).client).toBeUndefined();
      expect(retirementState(surface).retiringAttempt).toBeUndefined();
      expect(retirementState(surface).retirementFailure).toBeUndefined();
      await surface.dispose(cleanup());
      expect(release).toHaveBeenCalledTimes(1);
      expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    } finally { close.mockRestore(); vi.useRealTimers(); }
  });

  it('retains failed late recorder cleanup across reaping after independently releasing the lease', async () => {
    let finish!: (recording: ProviderRecording) => void;
    const failure = new Error('Synthetic late recorder cleanup failure');
    const stopped = vi.fn(async () => { throw failure; });
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'late-recorder-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record: () => new Promise<ProviderRecording>(resolve => { finish = resolve; }) } });
    await start(surface);
    const recording = surface.startVideo(operation()).catch((cause: unknown) => cause);
    await new Promise(resolve => setImmediate(resolve));
    await surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
    const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    finish({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped });
    expect(await recording).toMatchObject({ code: 'CANCELLED' });
    const cleanupFailure = await owner;
    expect(cleanupFailure).toMatchObject({ code: 'ENGINE_FAILURE', cause: failure });
    await expect(surface.endAttempt(cleanup())).rejects.toBe(cleanupFailure);
    await expect(surface.dispose(cleanup())).rejects.toBe(cleanupFailure);
    await expect(surface.startAttempt(context('not-after-recorder-failure'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(stopped).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(1);
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
  });

  it('releases the lease after an unconfirmed close without treating release as native cleanup proof', async () => {
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'uncertain-close-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release } });
    await start(surface);
    const failure = new EngineError('ENGINE_FAILURE', 'Synthetic unconfirmed native close', { retryable: false });
    const close = vi.spyOn(NativeClient.prototype, 'close').mockRejectedValue(failure);
    try {
      await expect(surface.endAttempt(cleanup())).rejects.toBe(failure);
      await expect(surface.startAttempt(context('no-replacement-lease'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(release).toHaveBeenCalledTimes(1);
      expect(retirementState(surface).retiringAttempt).toBeDefined();
    } finally { close.mockRestore(); await expect(surface.dispose(cleanup())).rejects.toBe(failure); }
    expect(release).toHaveBeenCalledTimes(1);
    await expect(surface.startAttempt(context('not-reusable-after-reaping'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('shares explicit resource reaping after failure without restoring reuse or hiding the original error', async () => {
    let finish!: () => void;
    const release = vi.fn(async () => {});
    const stopped = vi.fn().mockRejectedValueOnce(new Error('Synthetic recorder cleanup failed')).mockImplementation(() => new Promise<{ url: string; mediaType: string }>(resolve => { finish = () => resolve({ url: 'https://synthetic.test/reaped.mp4', mediaType: 'video/mp4' }); }));
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'reaped-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped }) } });
    await start(surface); await surface.startVideo(operation());
    const failure = await surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
    const reaping = surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    const owner = retirementState(surface).endingAttempt;
    const duplicate = surface.endAttempt(cleanup()).catch((cause: unknown) => cause);
    const disposing = surface.dispose(cleanup()).catch((cause: unknown) => cause);
    expect(retirementState(surface).endingAttempt).toBe(owner);
    expect(stopped).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(surface.startAttempt(context('no-business-during-reap'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    finish();
    for (const result of await Promise.all([reaping, duplicate, disposing])) expect(result).toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    expect(retirementState(surface).retiringAttempt).toBeUndefined();
    await expect(surface.endAttempt(cleanup())).rejects.toBe(failure);
    await expect(surface.startAttempt(context('no-business-after-reap'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(stopped).toHaveBeenCalledTimes(2);
    expect(frames.filter(frame => frame['command'] === 'scope.open')).toHaveLength(1);
  });

  it.each(['end', 'dispose'] as const)('publishes one owner before a provider stop synchronously re-enters %s', async entry => {
    let finish!: () => void;
    const release = vi.fn(async () => {});
    let surface!: NativeSurface;
    let joined!: Promise<void>;
    let disposal!: Promise<void>;
    let before!: Promise<void>;
    const stopped = vi.fn(() => {
      before = retirementState(surface).endingAttempt!;
      expect(before).toBeDefined();
      joined = surface.endAttempt(cleanup());
      disposal = surface.dispose(cleanup());
      expect(retirementState(surface).endingAttempt).toBe(before);
      return new Promise<{ url: string; mediaType: string }>(resolve => { finish = () => resolve({ url: 'https://synthetic.test/reentrant.mp4', mediaType: 'video/mp4' }); });
    });
    surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'reentrant-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped }) } });
    await start(surface); await surface.startVideo(operation());
    const waiting = entry === 'end' ? surface.endAttempt(cleanup()) : surface.dispose(cleanup());
    expect(retirementState(surface).endingAttempt).toBe(before);
    expect(stopped).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([waiting, joined, disposal]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(1);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  });

  it('joins retained terminal cleanup without granting a later caller new ordinary cleanup authority', async () => {
    const release = vi.fn(async () => {});
    const surface = new NativeSurface({ browser: { name: 'synthetic', scope: 'attempt', acquire: async () => ({ id: 'joined-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release } });
    await start(surface); holdClose = true;
    await surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
    const owner = retirementState(surface).endingAttempt;
    await expect(surface.dispose({ signal: AbortSignal.abort(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'CANCELLED' });
    const disposing = surface.dispose(cleanup());
    await new Promise(resolve => setImmediate(resolve));
    expect(retirementState(surface).endingAttempt).toBe(owner);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
    releaseClose!(); await disposing;
    expect(frames.filter(frame => frame['command'] === 'scope.end')).toHaveLength(0);
    expect(frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

/** Restored public aliases over the same framed native protocol, not a fake alias engine. */
describe('native Web public reference compatibility', () => {
  it('round-trips public trees, fixture/protected queries, drag and viewport through core evidence', async () => {
    const surface = new NativeSurface({}); await start(surface);
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'browser.observe') return false;
      reply({ data: { ...observation('19'), root: { ref: { id: '@e41', revision: '19' }, role: 'document', children: [
        { ref: { id: '@e58', revision: '19' }, role: 'button', name: 'Source' },
        { ref: { id: '@e90', revision: '19' }, role: 'button', name: 'Target' },
      ] }, viewportRef: { id: '@e501', revision: '19' } } }); return true;
    };
    const engine = defineEngine({ name: 'web-boundary', version: '1', spiVersion: 1, referenceRevisions: 'engine',
      observe: surface.observe.bind(surface), locate: surface.locate.bind(surface), perform: surface.perform.bind(surface),
      actions: ['tap', 'dragTo', 'swipe'],
    });
    const session = createEngineSession({ engine, targetName: 'web-boundary' });
    try {
      const raw = await session.observe(operation());
      const observed = prepareObservation(raw, { redact: text => text, redactCut: text => text, maxBytes: 4096 });
      expect(observed.text).toContain('#n116 button "Source"');
      expect(observed.text).toContain('#n180 button "Target"');
      expect(observed.text).not.toContain('@e');
      if (observed.kind !== 'semantic') throw new Error('semantic tree required');
      expect(projectTree(observed.tree).children?.map(child => child.id)).toEqual(['n116', 'n180']);
      await session.perform({ id: 'n116', revision: raw.revision }, { kind: 'dragTo', target: { id: 'n180', revision: raw.revision } }, operation());
      await session.swipe('down', undefined, operation());
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => frame['args'])).toEqual([
        { identityScope: currentScope, ref: { id: '@e58', revision: '19' }, action: { kind: 'dragTo', target: { id: '@e90', revision: '19' } } },
        { identityScope: currentScope, ref: { id: '@e501', revision: '19' }, action: { kind: 'swipe', direction: 'down' } },
      ]);
      queryNodes = [{ ref: { id: '@e908', revision: '23' }, role: 'button', name: 'Located' }];
      for (const purpose of ['fixture', 'protected'] as const) {
        const [located] = await session.locate({ kind: 'selector', selector: '#actual-css-id' }, operation(), { purpose });
        expect(located!.id).toMatch(/^n\d+$/);
        await session.perform(located!, { kind: 'tap' }, operation());
        expect(frames.findLast(frame => frame['command'] === 'browser.perform')!['args']).toEqual({ identityScope: currentScope, ref: { id: '@e908', revision: '23' }, action: { kind: 'tap' } });
      }
    } finally { await surface.dispose(cleanup()); }
  });

  it('never turns a guessed native ID or viewport into an element, and leaves point drag unchanged', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const peer = holdRequests('browser.observe');
    const pending = surface.observe(operation()); (await peer.next('browser.observe')).succeed(observation('1')); const snapshot = await pending;
    try {
      const before = frames.length;
      for (const ref of [{ id: '@e1', revision: '1' }, { id: 'n9000', revision: '1' }, { ...snapshot.root.ref, revision: '2' }]) {
        await expect(surface.perform(ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      }
      await expect(surface.perform(snapshot.viewportRef!, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(surface.perform(snapshot.root.ref, { kind: 'dragTo', target: snapshot.viewportRef! }, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(frames.slice(before).some(frame => frame['command'] === 'browser.perform')).toBe(false);
      await surface.performAt({ x: 12, y: 34 }, { kind: 'dragTo', target: { x: 56, y: 78 } }, operation());
      expect(frames.findLast(frame => frame['command'] === 'browser.pointer')!['args']).toEqual({ identityScope: currentScope, point: { x: 12, y: 34 }, action: { kind: 'dragTo', target: { x: 56, y: 78 } } });
    } finally { await surface.dispose(cleanup()); }
  });

  it.each(['reset', 'restart', 'same-scope-restart', 'navigation', 'attempt'] as const)('does not revive prior public refs after %s, even if native text repeats', async transition => {
    const surface = new NativeSurface({}); await start(surface);
    try {
      const old = (await surface.observe(operation())).root.ref;
      if (transition === 'reset') await surface.reset(operation());
      else if (transition === 'restart' || transition === 'same-scope-restart') { preserveRestartScope = transition === 'same-scope-restart'; await surface.restart(operation()); }
      else if (transition === 'navigation') await sendEvent('app.navigation', { identityScope: currentScope, kind: 'main', url: 'https://synthetic.test/next' });
      else { await surface.endAttempt(cleanup()); await surface.startAttempt(context('replacement')); }
      const fresh = (await surface.observe(operation())).root.ref;
      expect(fresh).not.toEqual(old);
      const before = frames.length;
      await expect(surface.perform(old, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(frames).toHaveLength(before);
      await surface.perform(fresh, { kind: 'tap' }, operation());
      expect(frames.findLast(frame => frame['command'] === 'browser.perform')!['args']).toMatchObject({ ref: { id: '@e1', revision: '1' } });
    } finally { await surface.dispose(cleanup()); }
  });

  it('retires aliases across persistent reconnect before allowing fresh same-text refs', async () => {
    const surface = new NativeSurface({ connect: { cdpEndpoint: async () => 'ws://synthetic.test/browser', reconnectEndpoint: async () => 'ws://synthetic.test/browser' } }); await start(surface);
    try {
      const old = (await surface.observe(operation())).root.ref;
      await sendEvent('scope.disconnected', { identityScope: currentScope, reason: 'browser-connection-closed' });
      const fresh = (await surface.observe(operation())).root.ref;
      expect(fresh).not.toEqual(old);
      await expect(surface.perform(old, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await surface.perform(fresh, { kind: 'tap' }, operation());
    } finally { await surface.dispose(cleanup()); }
  });

  it('keeps diagnostic correlation on native refs and returns only the pinned public candidate', async () => {
    const surface = new NativeSurface({}); await start(surface);
    try {
      const observed = (await surface.observe(operation())).root.ref;
      queryNodes = [{ ref: { id: '@e33', revision: '4' } }];
      const located = (await surface.locate({ kind: 'selector', selector: '#root' }, operation(), { purpose: 'fixture' }))[0]!.ref;
      interceptRequest = (frame, reply) => {
        if (frame['command'] !== 'fixture.correlate') return false;
        expect(frame['args']).toEqual({ identityScope: currentScope, located: [{ id: '@e33', revision: '4' }], observed: [{ id: '@e1', revision: '1' }] });
        reply({ data: { identityScope: currentScope, matches: [{ id: '@e1', revision: '1' }] } }); return true;
      };
      await expect(surface.command('fixture.correlate', { located: [located], observed: [observed] }, operation())).resolves.toEqual({ identityScope: currentScope, matches: [observed] });
    } finally { await surface.dispose(cleanup()); }
  });

  it('shows trace aliases but refuses them as action authority without retiring live refs', async () => {
    const surface = new NativeSurface({}); await start(surface); await surface.endAttempt(cleanup());
    const screen = vi.fn(); await surface.startAttempt({ ...context('trace-aliases'), screen });
    try {
      const live = (await surface.observe(operation())).root.ref;
      await surface.perform(live, { kind: 'tap' }, operation());
      const historical = screen.mock.calls[0]![0].root.ref;
      expect(historical.id).toBe('root'); expect(historical.revision).not.toBe(live.revision);
      await expect(surface.perform(historical, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      await surface.perform(live, { kind: 'tap' }, operation());
      expect(frames.filter(frame => frame['command'] === 'browser.perform')).toHaveLength(2);
    } finally { await surface.dispose(cleanup()); }
  });
  it('keeps the current observed reference after more than 16K locator acquisitions', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const engine = defineEngine({ name: 'web-populations', version: '1', spiVersion: 1, referenceRevisions: 'engine',
      observe: surface.observe.bind(surface), locate: surface.locate.bind(surface), perform: surface.perform.bind(surface), actions: ['tap'],
    });
    const session = createEngineSession({ engine, targetName: 'web-populations' });
    try {
      const observed = await session.observe(operation());
      for (let batch = 0; batch < 17; batch++) {
        queryNodes = Array.from({ length: 1024 }, (_, index) => ({ ref: { id: `@e${batch * 1024 + index + 100}`, revision: '1' } }));
        await session.locate({ kind: 'selector', selector: '.candidate' }, operation());
      }
      await session.perform(observed.root, { kind: 'tap' }, operation());
      expect(frames.findLast(frame => frame['command'] === 'browser.perform')!['args']).toMatchObject({ ref: { id: '@e1', revision: '1' } });
    } finally { await surface.dispose(cleanup()); }
  });

  it('preserves stable live-element IDs through core revisions and refuses absent or replaced identities', async () => {
    const surface = new NativeSurface({}); await start(surface);
    const engine = defineEngine({ name: 'web-generations', version: '1', spiVersion: 1, referenceRevisions: 'engine',
      observe: surface.observe.bind(surface), locate: surface.locate.bind(surface), perform: surface.perform.bind(surface), actions: ['tap'],
    });
    const session = createEngineSession({ engine, targetName: 'web-generations' });
    let nativeId: string | undefined = '@e7'; let text = '0'; let captures = 0;
    interceptRequest = (frame, reply) => {
      if (frame['command'] !== 'browser.observe') return false;
      reply({ data: { ...observation(String(++captures)), root: { ref: { id: '@e1', revision: '1' }, role: 'document', children: [
        { ref: { id: '@e8', revision: '1' }, role: 'status', name: 'Counter', text },
        ...(nativeId === undefined ? [] : [{ ref: { id: nativeId, revision: '1' }, role: 'button', name: 'Increment' }]),
      ] } } }); return true;
    };
    try {
      const first = await session.observe(operation()); text = '1'; const second = await session.observe(operation());
      if (first.kind !== 'semantic' || second.kind !== 'semantic') throw new Error('semantic observations required');
      const old = first.tree.children![1]!.ref; const fresh = second.tree.children![1]!.ref;
      expect(fresh.id).toBe(old.id); expect(fresh.revision).not.toBe(old.revision);
      const options = { redact: (value: string) => value, redactCut: (value: string) => value, maxBytes: 4096 };
      const initial = prepareObservation(first, options); const updated = prepareObservation(second, options);
      if (initial.kind !== 'semantic' || updated.kind !== 'semantic') throw new Error('semantic observations required');
      const presenter = new ScreenPresenter();
      presenter.initial({ revision: initial.revision, text: initial.text, truncated: initial.truncated, viewport: initial.viewport });
      expect(presenter.update({ revision: updated.revision, text: updated.text, truncated: updated.truncated, viewport: updated.viewport })).toContain('changed #n16 status "Counter" text="1"');
      expect(updated.kind === 'semantic' && updated.nodes.has(old.id)).toBe(true);
      await session.perform(old, { kind: 'tap' }, operation());
      await session.perform(fresh, { kind: 'tap' }, operation());
      expect(frames.filter(frame => frame['command'] === 'browser.perform').map(frame => frame['args'])).toEqual([
        { identityScope: currentScope, ref: { id: '@e7', revision: '1' }, action: { kind: 'tap' } },
        { identityScope: currentScope, ref: { id: '@e7', revision: '1' }, action: { kind: 'tap' } },
      ]);
      nativeId = undefined; await session.observe(operation());
      await expect(session.perform(old, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      nativeId = '@e9'; const replacement = await session.observe(operation());
      await expect(session.perform({ id: old.id, revision: replacement.revision }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(frames.filter(frame => frame['command'] === 'browser.perform')).toHaveLength(2);
    } finally { await surface.dispose(cleanup()); }
  });

});


it.each(['recorder', 'native-close', 'lease'] as const)('preserves first actual cleanup failure (%s) after the caller departs', async first => {
  const errors = {
    recorder: new Error('first-order recorder receipt'),
    'native-close': new Error('first-order native close receipt'),
    lease: new Error('first-order lease receipt'),
  };
  let rejectStop!: (cause: unknown) => void;
  let rejectClose!: (cause: unknown) => void;
  let rejectRelease!: (cause: unknown) => void;
  const stopReceipt = new Promise<{ url: string; mediaType: string }>((_, reject) => { rejectStop = reject; });
  const closeReceipt = new Promise<void>((_, reject) => { rejectClose = reject; });
  const releaseReceipt = new Promise<void>((_, reject) => { rejectRelease = reject; });
  const stopped = vi.fn(() => stopReceipt);
  const release = vi.fn(() => releaseReceipt);
  const surface = new NativeSurface({ browser: { name: 'ordered-cleanup-fixture', scope: 'attempt',
    acquire: async () => ({ id: 'ordered-cleanup-lease', cdpEndpoint: 'ws://synthetic.test/browser' }), release,
    record: async () => ({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped }),
  } });
  await start(surface); await surface.startVideo(operation());
  const close = vi.spyOn(NativeClient.prototype, 'close').mockImplementation(() => closeReceipt);
  try {
    const controller = new AbortController();
    const caller = surface.endAttempt({ signal: controller.signal, timeoutMs: 1000 });
    const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    expect(stopped).toHaveBeenCalledTimes(1);
    controller.abort(); await caller;
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalled();
    // A second cleanup caller joins the same owner, not a new cleanup effect.
    const disposing = surface.dispose(cleanup()).catch((cause: unknown) => cause);
    const reject = { recorder: rejectStop, 'native-close': rejectClose, lease: rejectRelease };
    const order = [first, ...(['recorder', 'native-close', 'lease'] as const).filter(kind => kind !== first)];
    for (const kind of order) {
      reject[kind](errors[kind]);
      // Prove actual receipt order rather than an arbitrary Promise.all order.
      await new Promise(resolve => setImmediate(resolve));
    }
    const failure = await owner;
    if (first === 'native-close') expect(failure).toBe(errors[first]);
    else expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', cause: errors[first] });
    expect(await disposing).toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(surface.startAttempt(context('blocked'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally { close.mockRestore(); await surface.dispose(cleanup()).catch(() => undefined); }
});

it('records first exact late recorder failure rather than mutable last failure', async () => {
  const primary = new Error('first late rollback failure');
  const secondary = new Error('second late rollback failure');
  const finishes: Array<(recording: ProviderRecording) => void> = [];
  const rejects: Array<(cause: unknown) => void> = [];
  const stops = [0, 1].map(() => {
    const work = new Promise<{ url: string; mediaType: string }>((_, reject) => { rejects.push(reject); });
    return vi.fn(() => work);
  });
  const record = vi.fn(() => new Promise<ProviderRecording>(resolve => { finishes.push(resolve); }));
  const release = vi.fn(async () => {});
  const surface = new NativeSurface({ browser: { name: 'late-order-review', scope: 'attempt', acquire: async () => ({ id: 'late-order', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record } });
  await start(surface);
  const firstController = new AbortController();
  const first = surface.startVideo({ ...operation(), signal: firstController.signal }).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  firstController.abort(); await first;
  const second = surface.startVideo(operation()).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
  await surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
  const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
  try {
    finishes[0]!({ startedAt: '2026-10-21T00:00:00.000Z', stop: stops[0]! });
    finishes[1]!({ startedAt: '2026-10-21T00:00:00.000Z', stop: stops[1]! });
    await vi.waitFor(() => expect(stops.every(stop => stop.mock.calls.length === 1)).toBe(true));
    rejects[0]!(primary); rejects[1]!(secondary);
    const failure = await owner; await second;
    expect((failure as EngineError).cause).toBe(primary);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(surface.startAttempt(context('no-reuse'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  } finally { await surface.dispose(cleanup()).catch(() => undefined); }
});


it('observes late rollback failure before a subsequently failed native close', async () => {
  let finish!: (recording: ProviderRecording) => void;
  let rejectStop!: (cause: unknown) => void;
  let rejectClose!: (cause: unknown) => void;
  const primary = new Error('late rollback already known');
  const secondary = new Error('native close subsequently failed');
  const stopReceipt = new Promise<{ url: string; mediaType: string }>((_, reject) => { rejectStop = reject; });
  const closeReceipt = new Promise<void>((_, reject) => { rejectClose = reject; });
  const stopped = vi.fn(() => stopReceipt);
  const release = vi.fn(async () => {});
  const record = vi.fn(() => new Promise<ProviderRecording>(resolve => { finish = resolve; }));
  const surface = new NativeSurface({ browser: { name: 'late-close-order', scope: 'attempt', acquire: async () => ({ id: 'late-close-order', cdpEndpoint: 'ws://synthetic.test/browser' }), release, record } });
  await start(surface);
  const starting = surface.startVideo(operation()).catch((cause: unknown) => cause);
  await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  const close = vi.spyOn(NativeClient.prototype, 'close').mockImplementation(() => closeReceipt);
  try {
    await surface.endAttempt({ signal: AbortSignal.abort(), timeoutMs: 0 });
    const owner = retirementState(surface).endingAttempt!.catch((cause: unknown) => cause);
    const retired = retirementState(surface).retiringAttempt as unknown as { lateRecordingFailure?: unknown };
    finish({ startedAt: '2026-10-21T00:00:00.000Z', stop: stopped });
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
    rejectStop(primary);
    for (let turn = 0; turn < 20 && retired.lateRecordingFailure === undefined; turn++) await Promise.resolve();
    expect(retired.lateRecordingFailure).toMatchObject({ cause: primary });
    rejectClose(secondary);
    const failure = await owner; await starting;
    expect((failure as EngineError).cause).toBe(primary);
  } finally { close.mockRestore(); await surface.dispose(cleanup()).catch(() => undefined); }
});
