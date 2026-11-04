/** Candidate regression: only mock native peer and lifecycle publication facade.
 * Real protocol reader + BrowserChannel + default browser route + ErrorLatch.
 * Peer revoke/drain and lifecycle publication are controlled frames/state only.
 * No browser/native process, role/AX, beforeunload or service-worker fixture.
 */
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { EngineError, type EngineFixtureContext, type OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import type { BrowserEventMap, NativeWebSurface } from '../../src/native/browser-contract.ts';
import { NativeClient } from '../../src/native/client.ts';
import { ErrorLatch } from '../../src/runtime-support.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Listener = (event: BrowserEventMap[keyof BrowserEventMap]) => void | Promise<void>;

it.each(['ack-first', 'proof-first', 'expired-ack-then-proof-same-turn', 'kind-mismatch-then-proof', 'missing-late-proof', 'expired-proof-first', 'dialog-expired-proof-first', 'dialog-missing-ack-then-proof', 'wrong-token', 'wrong-transition-scope', 'no-transition', 'transition-failure', 'no-proof-deadline', 'transport-close', 'close-frame', 'decision-cancelled'] as const)('candidate default continue retirement ordering: %s', async ordering => {
  const now = performance.now();
  let clock = now;
  const clockSpy = ordering === 'missing-late-proof' ? vi.spyOn(performance, 'now').mockImplementation(() => clock) : undefined;
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const decisionOutcomes: { accepted: boolean; disposition?: string; error?: unknown }[] = [];
  const dialog = ordering.startsWith('dialog-');
  const continued = deferred<Record<string, unknown>>();
  const delivered = deferred<void>();
  const signal = new AbortController().signal;
  const decisionCancellation = new AbortController();
  let requestedClose: Promise<void> | undefined;
  const operation = (timeoutMs = 1000): OperationContext => ({
    runId: 'retirement-repro', attemptId: 'one', origin: 'test', signal, timeoutMs,
  });
  const send = (message: unknown) => { output.write(JSON.stringify(message) + '\n'); };
  const rejectDecision = (request: Record<string, unknown>, code = 'decision-missing') => send({
    type: 'control-result', id: request['id'], generation: 1,
    accepted: false, error: { code }, scopeState: 'usable',
  });
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
    requests.push(frame);
    const decision = frame['decision'] as { kind?: string } | undefined;
    if (frame['type'] === 'decision' && (decision?.kind === 'continue' || decision?.kind === 'dialog')) continued.resolve(frame);
    // Original code may issue its existing best-effort abort after explicit
    // rejection. It remains rejected; this is not the proposed repair/fallback.
    if (frame['type'] === 'decision' && decision?.kind === 'abort') queueMicrotask(() => { rejectDecision(frame); });
    if (frame['type'] === 'request' && frame['command'] === 'dialog.register') queueMicrotask(() => send({
      type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'],
      ok: true, data: null, effects: 'completed', scopeState: 'usable',
    }));
    if (frame['type'] === 'request' && frame['command'] === 'page.title') queueMicrotask(() => send({
      type: 'result', id: frame['id'], generation: 1, operationSeq: frame['operationSeq'],
      ok: true, data: { title: 'replacement' }, effects: 'completed', scopeState: 'usable',
    }));
    done();
  } });
  let scope = 'old';
  let client!: NativeClient;
  let channel!: BrowserChannel;
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose: () => {
    input.destroy(); output.destroy();
  } }, [], operation(), async event => {
    try { await channel.dispatch(event); } finally { delivered.resolve(); }
  });
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1',
    sessionId: 'retirement-repro', generation: 1, capabilities: [], scopeState: 'usable',
    limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 },
  });
  client = await connecting;
  const listeners = new Map<keyof BrowserEventMap, Set<Listener>>();
  const bind = () => {
    channel = new BrowserChannel(client, { identityScope: () => scope, operation });
    for (const [name, callbacks] of listeners) for (const callback of callbacks) channel.subscribe(name, callback);
  };
  bind();
  const latch = new ErrorLatch();
  const surface: NativeWebSurface = {
    latch,
    get identityScope() {
      if (!client.callbackRevocationGuard()()) throw new EngineError('CANCELLED', 'captured callback retired', { retryable: false });
      return scope;
    },
    // Same captured-scope/revocation condition as the production fixture view;
    // this small owner facade is the declared mocked publication boundary.
    latchCallbackFailure: (originalScope, error) => {
      const disposition = client.callbackFailureDisposition(error);
      if (disposition === 'retired') return;
      if (disposition === 'hard' || (client.callbackRevocationGuard()() && originalScope === scope)) latch.latch(error);
    },
    routeRegistryVersion: () => 0,
    allocateRouteRegistryVersion: () => { throw new Error('No user routes in this control'); },
    invalidate: () => client.invalidate(),
    command: (name, args, context) => channel.command(name, args, context),
    decide: async (token, decision, context) => {
      try { await channel.decide(ordering === 'wrong-token' ? 'unknown-token' : token, decision, ordering === 'decision-cancelled' ? { ...context, signal: decisionCancellation.signal } : context); decisionOutcomes.push({ accepted: true }); }
      catch (error) { expect(client.callbackFailureDisposition(new Error('unrelated error'))).toBeUndefined(); decisionOutcomes.push({ accepted: false, disposition: client.callbackFailureDisposition(error) ?? 'unmarked', error }); throw error; }
    },
    subscribe(name, callback) {
      const listener = callback as Listener;
      let entries = listeners.get(name);
      if (entries === undefined) { entries = new Set(); listeners.set(name, entries); }
      entries.add(listener);
      const unsubscribe = channel.subscribe(name, callback);
      return () => { entries.delete(listener); unsubscribe(); };
    },
    retainDownloadFile: () => { throw new Error('No downloads in this control'); },
    projectPath: path => path,
    siteHeaders: () => undefined,
    artifactPath: () => { throw new Error('No artifact writes in this control'); },
  };
  const context = {
    operation, signal, timeouts: { action: 1000, test: 5000, assertion: 1000 },
    fixture: (_name: string, value: object) => value,
    expectable: (value: object) => value,
    app: { resolveUrl: (value: string) => new URL(value, 'http://fixture.test/').href },
  } as unknown as EngineFixtureContext;
  const browser = createBrowserFixture(surface, context);
  const epoch = client.callbackCheckpoint();
  try {
    if (dialog) await browser.onDialog('accept');
    send({ type: 'event', generation: 1, sequence: 1, event: dialog ? 'dialog.opened' : 'network.request',
      payload: dialog ? { identityScope: 'old', type: 'prompt', message: 'ordinary prompt' } : { identityScope: 'old', version: 0, registrationIds: [],
        request: { url: 'http://fixture.test/popup-resource', method: 'GET', headers: {} } },
      decision: { token: 'original-request', timeoutMs: 1000 },
    });
    const control = await continued.promise;
    let resetting = ordering === 'no-transition' ? undefined : client.request('scope.reset', { identityScope: ordering === 'wrong-transition-scope' ? 'other' : 'old' }, operation(), epoch);
    const resetFailure = resetting?.then(() => undefined, error => error);
    let reset = requests.at(-1)!;
    const proof = { type: 'event', generation: 1, sequence: 2, event: 'scope.callbacks-retired',
      payload: { identityScope: 'old', throughEventSequence: 1 } };
    if (ordering === 'proof-first' || ordering === 'expired-proof-first' || ordering === 'dialog-expired-proof-first') send(proof);
    const hardCode = ordering.includes('expired') ? 'decision-expired' : ordering === 'kind-mismatch-then-proof' ? 'decision-kind-mismatch' : 'decision-missing';
    rejectDecision(control, hardCode);
    // No await between these frames: proof mutates owner.revoked before the
    // rejected promise reaches the browser route catch. The immutable hard
    // classification must survive that later mutable revocation.
    if (ordering === 'missing-late-proof') clock += 1001;
    if (ordering === 'expired-ack-then-proof-same-turn' || ordering === 'kind-mismatch-then-proof' || ordering === 'missing-late-proof' || ordering === 'dialog-missing-ack-then-proof' || ordering === 'wrong-token' || ordering === 'wrong-transition-scope') send(proof);
    // Release proof independently of callback completion; reset result remains held.
    if (ordering === 'ack-first') { await Promise.resolve(); send(proof); }
    if (ordering === 'transition-failure') {
      await Promise.resolve();
      send({ type: 'result', id: reset['id'], generation: 1, operationSeq: reset['operationSeq'],
        ok: false, error: { code: 'cleanup-failed' }, effects: 'not-dispatched', scopeState: 'usable' });
    }
    if (ordering === 'transport-close') { await Promise.resolve(); output.end(); }
    if (ordering === 'decision-cancelled') { await Promise.resolve(); decisionCancellation.abort(); }
    if (ordering === 'close-frame') {
      await Promise.resolve();
      requestedClose = client.close(operation());
      const closingFrame = requests.at(-1)!;
      send({ type: 'closed', id: closingFrame['id'], generation: 1, scopeState: 'closed' });
    }
    await delivered.promise;
    if (ordering === 'transition-failure' || ordering === 'no-proof-deadline' || ordering === 'transport-close' || ordering === 'close-frame') {
      expect(decisionOutcomes[0]).toMatchObject({ accepted: false, disposition: 'hard', error: { code: 'ENGINE_FAILURE', cause: { nativeReason: 'decision-missing' } } });
      expect(decisionOutcomes.filter(outcome => outcome.accepted)).toHaveLength(0);
      if (ordering === 'transition-failure') expect(await resetting).toMatchObject({ ok: false, error: { code: 'cleanup-failed' } });
      else expect(await resetFailure).toBeInstanceOf(EngineError);
      if (requestedClose !== undefined) await requestedClose;
      await expect(browser.title()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', cause: { nativeReason: 'decision-missing' } });
      return;
    }
    if (ordering === 'decision-cancelled') send(proof);
    if (ordering === 'no-transition') {
      resetting = client.request('scope.reset', { identityScope: 'old' }, operation(), epoch);
      reset = requests.at(-1)!;
      send(proof);
    }
    send({ type: 'result', id: reset['id'], generation: 1, operationSeq: reset['operationSeq'],
      ok: true, data: { identityScope: 'replacement', activatePage: true }, effects: 'completed', scopeState: 'usable' });
    expect((await resetting!).ok).toBe(true);
    channel.dispose(); scope = 'replacement'; bind(); client.retireCallbacks(epoch);
    expect(surface.identityScope).toBe('replacement');
    const continues = requests.filter(frame => frame['type'] === 'decision'
      && (frame['decision'] as { kind?: string }).kind === 'continue');
    expect(continues).toHaveLength(dialog ? 0 : 1);
    expect(decisionOutcomes.filter(outcome => outcome.accepted)).toHaveLength(0);
    expect(decisionOutcomes[0]).toMatchObject({ accepted: false, disposition: ordering === 'ack-first' || ordering === 'proof-first' ? 'retired' : 'hard', error: { code: 'ENGINE_FAILURE', cause: { nativeReason: hardCode } } });
    if (ordering !== 'ack-first' && ordering !== 'proof-first') {
      await expect(browser.title()).rejects.toMatchObject({ code: 'ENGINE_FAILURE',
        message: 'The native browser rejected an expired or invalid decision', cause: { nativeReason: hardCode } });
    } else {
      await expect(browser.title()).resolves.toBe('replacement');
    }
  } finally {
    const closing = client.close(operation());
    if (requestedClose !== undefined) {
      await closing;
    } else if (ordering === 'no-proof-deadline' || ordering === 'transport-close') {
      await expect(closing).rejects.toBeInstanceOf(EngineError);
    } else {
      const close = requests.at(-1)!;
      send({ type: 'closed', id: close['id'], generation: 1, scopeState: 'closed' });
      await closing;
    }
    clockSpy?.mockRestore();
  }
});
