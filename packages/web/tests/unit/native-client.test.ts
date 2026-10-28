import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { AcceptanceTrace, type AcceptanceRecord } from '../../src/native/acceptance-trace.ts';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { BrowserChannel } from '../../src/native/browser-channel.ts';
import type { NativeEvent } from '../../src/native/protocol.ts';

function context(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 1000, runId: 'synthetic-run', attemptId: 'synthetic-attempt', origin: 'test' };
}
function harness(trace?: AcceptanceTrace) {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>); callback(); } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (...messages: unknown[]) => output.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const ready = (extra: Record<string, unknown> = {}) => ({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'sample-client', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable', ...extra });
  const result = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: true, data: { completed: true }, effects: 'completed', scopeState: 'usable', ...extra });
  const connect = (onEvent: (event: NativeEvent) => void | Promise<void> = () => {}) => NativeClient.connect({ readable: output, writable: input, dispose, ...(trace === undefined ? {} : { acceptanceTrace: trace }) }, [], context(), onEvent);
  return { input, output, requests, dispose, send, ready, result, connect };
}

async function opened(trace?: AcceptanceTrace) {
  const fixture = harness(trace);
  const connecting = fixture.connect();
  fixture.send(fixture.ready(trace === undefined ? {} : { capabilities: ['acceptance.faults/1'] }));
  return { ...fixture, client: await connecting };
}

async function close(fixture: Awaited<ReturnType<typeof opened>>) {
  const closing = fixture.client.close(context());
  fixture.send({ type: 'closed', id: fixture.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
  await closing;
}

describe('native session client', () => {
  it.each(['before-deadline', 'after-deadline'] as const)('preserves ordinary decision deadline during automatic terminal cleanup: %s', async timing => {
    vi.useFakeTimers();
    try {
      const fixture = harness();
      const connecting = NativeClient.connect({ readable: fixture.output, writable: fixture.input, dispose: fixture.dispose }, ['terminal.close/1'], context(), () => {});
      fixture.send(fixture.ready({ capabilities: ['terminal.close/1'] }));
      const client = await connecting;
      const lifetime = new AbortController();
      const deciding = client.decide('terminal-held-control', { kind: 'continue' }, { ...context(lifetime.signal), timeoutMs: 20 }).then(() => 'accepted', cause => cause);
      const decision = fixture.requests.at(-1)!;
      const action = client.request('page.title', { identityScope: 'scope-one' }, context());
      const request = fixture.requests.at(-1)!;
      lifetime.abort();
      // This later request result arrives BEFORE the earlier decision ACK.
      fixture.send(fixture.result(request, { ok: false, data: undefined, error: { code: 'browser-failure' }, effects: 'unknown', scopeState: 'quarantined' }));
      await action;
      expect(client.isTerminal()).toBe(true);
      const closing = client.close(context()).then(() => 'closed', cause => cause);
      await vi.advanceTimersByTimeAsync(timing === 'before-deadline' ? 19 : 21);
      if (timing === 'before-deadline') {
        fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
        expect(await deciding).toBe('accepted');
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.requests.at(-1)!['type']).toBe('close');
        fixture.send({ type: 'closed', id: fixture.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
        expect(await closing).toBe('closed');
      } else {
        // A broken timer implementation would still admit this late ACK.
        if (fixture.dispose.mock.calls.length === 0) fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
        expect(await deciding).toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(await closing).toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(fixture.requests.filter(frame => frame['type'] === 'close')).toHaveLength(0);
        expect(fixture.dispose).toHaveBeenCalledOnce();
      }
    } finally { vi.useRealTimers(); }
  });

  it('retains callback decision custody without reopening selected callback authority after abort', async () => {
    const fixture = harness();
    const lifetime = new AbortController();
    let client!: NativeClient;
    let written!: () => void;
    const dispatched = new Promise<void>(resolve => { written = resolve; });
    let done!: () => void;
    const handled = new Promise<void>(resolve => { done = resolve; });
    const connecting = fixture.connect(async event => {
      const deciding = client.decide(event.decision!.token, { kind: 'continue' }, context(lifetime.signal));
      written();
      try {
        await deciding;
        await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      } finally { done(); }
    });
    fixture.send(fixture.ready()); client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'exact-callback', timeoutMs: 1000 } });
    await dispatched;
    const decision = fixture.requests.at(-1)!;
    lifetime.abort();
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await handled;
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close({ ...fixture, client });
  });


  it('retains an ordinary decision ACK after caller abort and joins it before terminal close', async () => {
    const fixture = await opened();
    const lifetime = new AbortController();
    const deciding = fixture.client.decide('held-control-token', { kind: 'continue' }, context(lifetime.signal));
    void deciding.catch(() => {});
    const decision = fixture.requests.at(-1)!;
    expect(decision['type']).toBe('decision');
    lifetime.abort();
    const closing = fixture.client.close(context());
    void closing.catch(() => {});
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await deciding;
    await vi.waitFor(() => expect(fixture.requests.at(-1)!['type']).toBe('close'));
    fixture.send({ type: 'closed', id: fixture.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
    await closing;
    expect(fixture.requests.filter(frame => frame['type'] === 'decision')).toHaveLength(1);
  });

  it('rejects an already-aborted ordinary decision without writing or poisoning the client', async () => {
    const fixture = await opened();
    const lifetime = new AbortController(); lifetime.abort();
    await expect(fixture.client.decide('not-dispatched', { kind: 'continue' }, context(lifetime.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello']);
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close(fixture);
  });

  it('checks ordinary decision dispatch cancellation after serialization without leaking payload', async () => {
    const fixture = await opened();
    const lifetime = new AbortController();
    const decision = { get kind() { lifetime.abort(); return 'continue'; } };
    await expect(fixture.client.decide('private-not-dispatched', decision, context(lifetime.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello']);
    await close(fixture);
  });

  it('keeps the original ordinary decision deadline after abort and refuses unknown ACK cleanup', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await opened();
      const lifetime = new AbortController();
      const failure = fixture.client.decide('deadline-token', { kind: 'continue' }, { ...context(lifetime.signal), timeoutMs: 20 }).catch(cause => cause);
      lifetime.abort();
      const closing = fixture.client.close(context()).catch(cause => cause);
      await vi.advanceTimersByTimeAsync(21);
      expect(await failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(await closing).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
      expect(fixture.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('bounds an outstanding ordinary decision receipt by the existing close budget', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await opened();
      const deciding = fixture.client.decide('long-receipt', { kind: 'continue' }, { ...context(), timeoutMs: 60000 }).catch(cause => cause);
      const closing = fixture.client.close(context()).catch(cause => cause);
      await vi.advanceTimersByTimeAsync(15001);
      expect(await closing).toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(await deciding).toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
    } finally { vi.useRealTimers(); }
  });

  it.each(['crash', 'wrong-generation'] as const)('does not launder %s through caller-aborted decision cleanup', async fault => {
    const fixture = await opened();
    const lifetime = new AbortController();
    const privateMarker = 'synthetic-private-control-marker';
    const deciding = fixture.client.decide(privateMarker, { kind: 'continue' }, context(lifetime.signal)).catch(cause => cause);
    const decision = fixture.requests.at(-1)!;
    lifetime.abort();
    const closing = fixture.client.close(context()).catch(cause => cause);
    if (fault === 'crash') fixture.output.destroy(new Error(privateMarker));
    else fixture.send({ type: 'control-result', id: decision['id'], generation: 2, accepted: true, scopeState: 'usable' });
    const failure = await deciding;
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(String(failure)).not.toContain(privateMarker);
    expect(await closing).toBe(failure);
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
  });

  it('preserves an explicit rejected decision ACK without treating it as success', async () => {
    const fixture = await opened();
    const lifetime = new AbortController();
    const deciding = fixture.client.decide('rejected-control', { kind: 'continue' }, context(lifetime.signal));
    const decision = fixture.requests.at(-1)!;
    lifetime.abort();
    const rejected = expect(deciding).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: false, error: { code: 'invalid-arguments' }, scopeState: 'usable' });
    await rejected;
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close(fixture);
  });

  it('publishes negotiated readiness before an event coalesced in the same stream chunk', async () => {
    const fixture = harness();
    const events: NativeEvent[] = [];
    const connecting = fixture.connect(event => { events.push(event); });
    fixture.send(fixture.ready(), { type: 'event', generation: 1, sequence: 1, event: 'registry-released', payload: { registryVersion: 1 } });
    const client = await connecting;
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(fixture.dispose).not.toHaveBeenCalled();
    await close({ ...fixture, client });
  });

  it('does not start a queued callback after a later frame invalidates the client', async () => {
    const fixture = harness();
    const handler = vi.fn();
    const connecting = fixture.connect(handler);
    fixture.send(fixture.ready());
    const client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'diagnostic', payload: {} }, { type: 'unrecognized' });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    await expect(client.request('session.status', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('correlates out-of-order results without replaying or sharing operation sequences', async () => {
    const fixture = await opened();
    const first = fixture.client.request('first', {}, context());
    const second = fixture.client.request('second', {}, context());
    const one = fixture.requests[1]!;
    const two = fixture.requests[2]!;
    expect([one['operationSeq'], two['operationSeq']]).toEqual([1, 2]);
    fixture.send(fixture.result(two, { data: 2 }), fixture.result(one, { data: 1 }));
    expect((await first).data).toBe(1);
    expect((await second).data).toBe(2);
    expect(fixture.requests).toHaveLength(3);
    await close(fixture);
  });

  it('delivers a callback decision while the triggering command remains pending', async () => {
    const fixture = harness();
    let client: NativeClient;
    const handled = vi.fn();
    const connecting = fixture.connect(async event => { await client.decide(event.decision!.token, { kind: 'abort' }, context()); handled(); });
    fixture.send(fixture.ready());
    client = await connecting;
    const action = client.request('navigate', {}, context());
    const request = fixture.requests[1]!;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'sample-token', timeoutMs: 500 } });
    await Promise.resolve();
    const decision = fixture.requests[2]!;
    expect(decision['type']).toBe('decision');
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await Promise.resolve();
    fixture.send(fixture.result(request));
    await action;
    expect(handled).toHaveBeenCalledOnce();
    await close({ ...fixture, client });
  });

  it('binds callback child requests to the native token without affecting ordinary requests', async () => {
    const fixture = harness();
    let client: NativeClient;
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const connecting = fixture.connect(async () => {
      await client.request('page.title', {}, context());
      finished();
    });
    fixture.send(fixture.ready());
    client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'sample-child-token', timeoutMs: 500 } });
    await Promise.resolve();
    const child = fixture.requests.at(-1)!;
    expect(child['callbackToken']).toBe('sample-child-token');
    fixture.send(fixture.result(child));
    await done;
    const ordinary = client.request('page.url', {}, context());
    const request = fixture.requests.at(-1)!;
    expect(request).not.toHaveProperty('callbackToken');
    fixture.send(fixture.result(request));
    await ordinary;
    await close({ ...fixture, client });
  });

  it('refuses reads from a selected callback without promoting its consumed token to ordinary authority', async () => {
    const fixture = harness();
    let client: NativeClient;
    let finished!: () => void; let decisionSent!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const decisionWritten = new Promise<void>(resolve => { decisionSent = resolve; });
    const connecting = fixture.connect(async event => {
      const deciding = client.decide(event.decision!.token, { kind: 'continue' }, context());
      decisionSent();
      await deciding;
      await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
      finished();
    });
    fixture.send(fixture.ready());
    client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'selected-token', timeoutMs: 500 } });
    await decisionWritten;
    const decision = fixture.requests.at(-1)!;
    expect(decision['type']).toBe('decision');
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await done;
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'decision']);
    // A genuinely new caller outside the completed callback still owns ordinary admission.
    const ordinary = client.request('page.title', {}, context());
    const read = fixture.requests.at(-1)!;
    expect(read['command']).toBe('page.title');
    expect(read).not.toHaveProperty('callbackToken');
    expect(read['timeoutMs']).toBe(1000);
    fixture.send(fixture.result(read));
    await ordinary;
    await close({ ...fixture, client });
  });

  it('stages coalesced post-ACK callbacks until the replacement scope is published', async () => {
    const fixture = harness(); let client: NativeClient; let published = false;
    const observed: boolean[] = [];
    const connecting = fixture.connect(async event => { observed.push(published); await client.decide(event.decision!.token, { kind: 'continue' }, context()); });
    fixture.send(fixture.ready()); client = await connecting;
    const epoch = client.callbackCheckpoint();
    const transition = client.request('scope.reset', {}, context(), epoch);
    const request = fixture.requests.at(-1)!;
    fixture.send(fixture.result(request), { type: 'event', generation: 1, sequence: 1, event: 'request', payload: { identityScope: 'new-scope' }, decision: { token: 'new-token', timeoutMs: 1000 } });
    await transition; await Promise.resolve();
    expect(observed).toEqual([]);
    client.retireCallbacks(epoch); published = true;
    await Promise.resolve();
    expect(observed).toEqual([true]);
    const decision = fixture.requests.at(-1)!;
    fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await Promise.resolve(); await Promise.resolve();
    await close({ ...fixture, client });
  });

  it('does not invoke a staged callback whose deadline expired before publication', async () => {
    vi.useFakeTimers();
    try {
      const fixture = harness(); const handler = vi.fn(); const connecting = fixture.connect(handler);
      fixture.send(fixture.ready()); const client = await connecting; const epoch = client.callbackCheckpoint();
      const transition = client.request('scope.reset', {}, context(), epoch);
      fixture.send(fixture.result(fixture.requests.at(-1)!), { type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'expired-staged', timeoutMs: 100 } });
      await transition; await vi.advanceTimersByTimeAsync(101);
      client.retireCallbacks(epoch); await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
      await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });

  it.each([['scope.end', 'scope-ended'], ['scope.reconnect', 'scope-reconnected']] as const)('requires successful %s ACK for callback revocation proof', async (command, proof) => {
    const fixture = await opened(); const epoch = fixture.client.callbackCheckpoint();
    const ending = fixture.client.request(command, {}, context(), epoch);
    fixture.send(fixture.result(fixture.requests.at(-1)!, { ok: false, data: undefined, error: { code: 'invalid-arguments' }, effects: 'not-dispatched' }));
    expect((await ending).ok).toBe(false);
    expect(() => fixture.client.retireCallbacks(epoch, proof)).toThrow();
  });

  it('consumes a coalesced terminal proof before invoking the retired callback', async () => {
    const fixture = harness(); const handler = vi.fn(); const connecting = fixture.connect(handler);
    fixture.send(fixture.ready()); const client = await connecting; const epoch = client.callbackCheckpoint();
    fixture.send(
      { type: 'event', generation: 1, sequence: 1, event: 'request', payload: { identityScope: 'old' }, decision: { token: 'queued', timeoutMs: 1000 } },
      { type: 'event', generation: 1, sequence: 2, event: 'scope.callbacks-retired', payload: { identityScope: 'old', throughEventSequence: 1 } },
    );
    await Promise.resolve(); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled(); expect(client.callbackCheckpoint()).toBe(epoch);
    await close({ ...fixture, client });
  });

  it.each([false, true])('retires only proven callbacks, including selected=%s, without releasing live closure quota', async selected => {
    vi.useFakeTimers(); let resume!: () => void;
    try {
      const hold = new Promise<void>(resolve => { resume = resolve; }); const fixture = harness(); let client: NativeClient;
      const connecting = fixture.connect(async event => { if (selected) await client.decide(event.decision!.token, { kind: 'continue' }, context()); await hold; throw new Error('late revoked error'); });
      fixture.send(fixture.ready({ limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 1, maxTimeoutMs: 3600000 } })); client = await connecting;
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: { identityScope: 'old' }, decision: { token: 'old-token', timeoutMs: 50 } }); await Promise.resolve();
      if (selected) { fixture.send({ type: 'control-result', id: fixture.requests.at(-1)!['id'], generation: 1, accepted: true, scopeState: 'usable' }); await Promise.resolve(); }
      fixture.send({ type: 'event', generation: 1, sequence: 2, event: 'scope.callbacks-retired', payload: { identityScope: 'old', throughEventSequence: 1 } });
      await vi.advanceTimersByTimeAsync(60); expect(client.callbackCheckpoint()).toBe(0); expect(fixture.dispose).not.toHaveBeenCalled();
      // A revoked but still-running JS closure must continue charging the bounded queue.
      fixture.send({ type: 'event', generation: 1, sequence: 3, event: 'request', payload: { identityScope: 'other' }, decision: { token: 'new-token', timeoutMs: 50 } });
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally { resume?.(); vi.useRealTimers(); }
  });

  it('does not deliver later callbacks from a scope whose producers were sealed', async () => {
    const fixture = harness(); const handler = vi.fn(); const connecting = fixture.connect(handler);
    fixture.send(fixture.ready()); const client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'scope.callbacks-retired', payload: { identityScope: 'old', throughEventSequence: 0 } });
    fixture.send({ type: 'event', generation: 1, sequence: 2, event: 'request', payload: { identityScope: 'old' }, decision: { token: 'impossible-late', timeoutMs: 1000 } });
    await Promise.resolve(); expect(handler).not.toHaveBeenCalled();
    await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('does not retire an unrelated scope or suppress its live deadline', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    try {
      const hold = new Promise<void>(resolve => { resume = resolve; }); const fixture = harness(); const connecting = fixture.connect(async () => { await hold; });
      fixture.send(fixture.ready()); await connecting;
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: { identityScope: 'live' }, decision: { token: 'live-token', timeoutMs: 50 } }); await Promise.resolve();
      fixture.send({ type: 'event', generation: 1, sequence: 2, event: 'scope.callbacks-retired', payload: { identityScope: 'other', throughEventSequence: 1 } });
      await vi.advanceTimersByTimeAsync(51); expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally { resume?.(); vi.useRealTimers(); }
  });

  it.each([
    { generation: 2, payload: { identityScope: 'old', throughEventSequence: 0 } },
    { generation: 1, payload: { identityScope: 'old', throughEventSequence: 1 } },
    { generation: 1, payload: { identityScope: 'old', throughEventSequence: -1 } },
    { generation: 1, payload: { identityScope: '', throughEventSequence: 0 } },
    { generation: 1, payload: { identityScope: 'x'.repeat(129), throughEventSequence: 0 } },
    { generation: 1, payload: { identityScope: 'old', throughEventSequence: 0, extra: true } },
  ])('rejects malformed terminal callback proof %#', async proof => {
    const fixture = await opened();
    fixture.send({ type: 'event', sequence: 1, event: 'scope.callbacks-retired', ...proof });
    await expect(fixture.client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('does not suspend an undecided callback deadline merely because reconnect is pending', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    try {
      const hold = new Promise<void>(resolve => { finish = resolve; });
      const fixture = harness(); const connecting = fixture.connect(async () => { await hold; });
      fixture.send(fixture.ready()); const client = await connecting;
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'undecided-before-reconnect', timeoutMs: 50 } });
      await Promise.resolve();
      const epoch = client.callbackCheckpoint();
      const reconnect = client.request('scope.reconnect', {}, context(), epoch).catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(51);
      expect(await reconnect).toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(() => client.retireCallbacks(epoch, 'scope-reconnected')).toThrow();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
    } finally { finish?.(); vi.useRealTimers(); }
  });

  it('does not grant reconnect revocation authority from another successful lifecycle ACK', async () => {
    const fixture = await opened(); const epoch = fixture.client.callbackCheckpoint();
    const restarting = fixture.client.request('scope.restart', {}, context(), epoch);
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await restarting;
    expect(() => fixture.client.retireCallbacks(epoch, 'scope-reconnected')).toThrow();
  });

  it('fails closed when the bounded post-ACK event buffer overflows', async () => {
    const fixture = harness(); const handler = vi.fn(); const connecting = fixture.connect(handler);
    fixture.send(fixture.ready({ limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 2, maxTimeoutMs: 3600000 } }));
    const client = await connecting;
    const transition = client.request('scope.reset', {}, context(), client.callbackCheckpoint());
    const request = fixture.requests.at(-1)!;
    fixture.send(fixture.result(request), ...[1, 2, 3].map(sequence => ({ type: 'event', generation: 1, sequence, event: 'diagnostic', payload: {} })));
    await transition; await Promise.resolve();
    expect(handler).not.toHaveBeenCalled(); expect(fixture.dispose).toHaveBeenCalledOnce();
    await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('keeps pre-ACK decisions dispatchable and does not stage after a rejected transition', async () => {
    const fixture = harness(); let client: NativeClient; const seen: string[] = [];
    const connecting = fixture.connect(async event => { seen.push(event.decision!.token); await client.decide(event.decision!.token, { kind: 'continue' }, context()); });
    fixture.send(fixture.ready()); client = await connecting;
    const transition = client.request('scope.reset', {}, context(), client.callbackCheckpoint());
    const request = fixture.requests.at(-1)!;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'old-token', timeoutMs: 1000 } });
    await Promise.resolve(); expect(seen).toEqual(['old-token']);
    fixture.send({ type: 'control-result', id: fixture.requests.at(-1)!['id'], generation: 1, accepted: true, scopeState: 'usable' });
    fixture.send(fixture.result(request, { ok: false, data: undefined, error: { code: 'invalid-arguments' }, effects: 'not-dispatched' }));
    expect((await transition).ok).toBe(false);
    fixture.send({ type: 'event', generation: 1, sequence: 2, event: 'request', payload: {}, decision: { token: 'still-old-token', timeoutMs: 1000 } });
    await Promise.resolve(); expect(seen).toEqual(['old-token', 'still-old-token']);
    fixture.send({ type: 'control-result', id: fixture.requests.at(-1)!['id'], generation: 1, accepted: true, scopeState: 'usable' });
    await Promise.resolve(); await Promise.resolve(); await close({ ...fixture, client });
  });

  it('retires only settled transition callbacks without poisoning the reused client', async () => {
    vi.useFakeTimers();
    try {
      const fixture = harness(); let client: NativeClient; let resume!: () => void;
      const hold = new Promise<void>(resolve => { resume = resolve; });
      let rejected: unknown;
      const connecting = fixture.connect(async event => {
        await client.decide(event.decision!.token, { kind: 'continue' }, context());
        await hold;
        try { await client.request('page.title', {}, context()); } catch (error) { rejected = error; }
        throw new Error('Retired callback failure must not poison replacement');
      });
      fixture.send(fixture.ready()); client = await connecting;
      const epoch = client.callbackCheckpoint();
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'retiring-token', timeoutMs: 100 } });
      await Promise.resolve();
      fixture.send({ type: 'control-result', id: fixture.requests.at(-1)!['id'], generation: 1, accepted: true, scopeState: 'usable' });
      await Promise.resolve(); await Promise.resolve();
      client.retireCallbacks(epoch);
      await vi.advanceTimersByTimeAsync(200);
      resume(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(rejected).toMatchObject({ code: 'INVALID_STATE' });
      expect(fixture.requests.some(frame => frame['command'] === 'page.title')).toBe(false);
      expect(fixture.dispose).not.toHaveBeenCalled();
      const ordinary = client.request('page.url', {}, context());
      fixture.send(fixture.result(fixture.requests.at(-1)!)); await ordinary;
      await close({ ...fixture, client });
    } finally { vi.useRealTimers(); }
  });

  it('keeps the next epoch live callback deadline authoritative after retirement', async () => {
    vi.useFakeTimers();
    try {
      const fixture = harness(); let resume!: () => void;
      const hold = new Promise<void>(resolve => { resume = resolve; });
      const connecting = fixture.connect(() => hold); fixture.send(fixture.ready()); const client = await connecting;
      client.retireCallbacks(client.callbackCheckpoint());
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'new-epoch-token', timeoutMs: 100 } });
      await Promise.resolve(); await vi.advanceTimersByTimeAsync(101);
      await expect(client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(fixture.dispose).toHaveBeenCalledOnce(); resume();
    } finally { vi.useRealTimers(); }
  });

  it('refuses transition retirement while a native decision remains undecided', async () => {
    const fixture = harness(); let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const connecting = fixture.connect(() => hold); fixture.send(fixture.ready()); const client = await connecting;
    fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'undecided-token', timeoutMs: 1000 } });
    await Promise.resolve();
    expect(() => client.retireCallbacks(client.callbackCheckpoint())).toThrow();
    expect(fixture.requests.some(frame => frame['type'] === 'decision')).toBe(false);
    expect(fixture.dispose).toHaveBeenCalledOnce(); resume();
  });

  it.each(['ack-first', 'result-first'] as const)('retains cancellation settlement in %s order before reuse', async (order) => {
    const records: AcceptanceRecord[] = [];
    const fixture = await opened(new AcceptanceTrace(record => { records.push(record); })); const controller = new AbortController();
    const request = fixture.client.request('browser.observe', {}, context(controller.signal));
    const original = fixture.requests.at(-1)!; controller.abort();
    const cancel = fixture.requests.at(-1)!;
    const ack = { type: 'control-result', id: cancel['id'], generation: 1, accepted: order === 'ack-first', ...(order === 'ack-first' ? {} : { error: { code: 'invalid-arguments' } }), scopeState: 'usable' };
    const result = fixture.result(original, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched' });
    let done = false; void request.then(() => { done = true; });
    fixture.send(order === 'ack-first' ? ack : result); await Promise.resolve();
    expect(done).toBe(false);
    await expect(fixture.client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    fixture.send(order === 'ack-first' ? result : ack);
    expect(await request).toMatchObject({ ok: false, error: { code: 'cancelled' }, effects: 'not-dispatched' });
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'request', 'cancel']);
    expect(records.filter(record => record.phase === 'CancelAckValidated')).toMatchObject([{ operationSeq: original['operationSeq'], accepted: order === 'ack-first' }]);
    expect(records.filter(record => record.phase === 'ResultValidated')).toMatchObject([{ operationSeq: original['operationSeq'] }]);
    await close(fixture);
  });

  // This proves only the public adapter boundary. The native producer must independently
  // prove whole input ACKs, exact authority and cleanup before issuing Completed + usable.
  it.each(['ack-first', 'result-first'] as const)('reports settled partial typing as CANCELLED and permits fresh inspection in %s order', async order => {
    const fixture = await opened(); const controller = new AbortController();
    const engine = new EngineChannel(fixture.client, scope => () => scope === 'typing-scope');
    const browser = new BrowserChannel(fixture.client, { identityScope: () => 'typing-scope', operation: context });
    const published = vi.fn();
    const pending = engine.command('browser.keyboard.type', { identityScope: 'typing-scope', text: 'replacement', replace: true }, context(controller.signal)).then(published);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    const original = fixture.requests.at(-1)!; controller.abort();
    const cancel = fixture.requests.at(-1)!;
    const ack = { type: 'control-result', id: cancel['id'], generation: 1, accepted: order === 'ack-first', ...(order === 'ack-first' ? {} : { error: { code: 'invalid-arguments' } }), scopeState: 'usable' };
    const result = fixture.result(original, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'completed', scopeState: 'usable' });
    fixture.send(order === 'ack-first' ? ack : result); await Promise.resolve();
    let inspected = false;
    const inspection = browser.command('page.title', {}, context()).finally(() => { inspected = true; });
    await Promise.resolve();
    expect(inspected).toBe(false);
    expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'request', 'cancel']);
    fixture.send(order === 'ack-first' ? result : ack); await rejected;
    await new Promise(resolve => setImmediate(resolve));
    expect(published).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
    fixture.send(fixture.result(fixture.requests.at(-1)!, { data: { title: 'Fresh inspection, not rollback' } }));
    await expect(inspection).resolves.toEqual({ title: 'Fresh inspection, not rollback' });
    expect(fixture.requests.filter(frame => frame['type'] === 'request').map(frame => frame['command'])).toEqual(['browser.keyboard.type', 'page.title']);
    await close(fixture);
  });

  it.each(['result', 'ack'] as const)('quarantines when cancellation settlement loses its %s', async (missing) => {
    vi.useFakeTimers();
    try {
      const records: AcceptanceRecord[] = [];
      const fixture = await opened(new AcceptanceTrace(record => { records.push(record); })); const controller = new AbortController();
      const request = fixture.client.request('click', {}, context(controller.signal));
      const failed = expect(request).rejects.toMatchObject({ retryable: false });
      const original = fixture.requests.at(-1)!; controller.abort(); const cancel = fixture.requests.at(-1)!;
      fixture.send(missing === 'result'
        ? { type: 'control-result', id: cancel['id'], generation: 1, accepted: true, scopeState: 'usable' }
        : fixture.result(original, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched' }));
      await vi.advanceTimersByTimeAsync(5000); await failed;
      expect(records.find(record => record.phase === 'SettlementExpired')).toMatchObject({ resultSeen: missing !== 'result', cancelAckSeen: missing !== 'ack' });
      expect(fixture.dispose).toHaveBeenCalledOnce();
      await expect(fixture.client.request('click', {}, context())).rejects.toMatchObject({ retryable: false });
      expect(fixture.requests.map(frame => frame['type'])).toEqual(['hello', 'request', 'cancel']);
    } finally { vi.useRealTimers(); }
  });

  it('keeps control callbacks live while an expired request settles without extending work', async () => {
    vi.useFakeTimers();
    try {
      const fixture = harness(); let client: NativeClient;
      const connecting = fixture.connect(async event => { await client.decide(event.decision!.token, { kind: 'abort' }, context()); });
      fixture.send(fixture.ready()); client = await connecting;
      const request = client.request('browser.observe', {}, { ...context(), timeoutMs: 20 });
      const original = fixture.requests.at(-1)!;
      await vi.advanceTimersByTimeAsync(20); const cancel = fixture.requests.at(-1)!;
      fixture.send({ type: 'event', generation: 1, sequence: 1, event: 'request', payload: {}, decision: { token: 'cleanup-token', timeoutMs: 500 } });
      await Promise.resolve(); const decision = fixture.requests.at(-1)!;
      expect(decision['type']).toBe('decision');
      fixture.send({ type: 'control-result', id: decision['id'], generation: 1, accepted: true, scopeState: 'usable' });
      fixture.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: true, scopeState: 'usable' });
      fixture.send(fixture.result(original, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched' }));
      expect(await request).toMatchObject({ error: { code: 'deadline-exceeded' } });
      expect(original['timeoutMs']).toBe(20); expect(fixture.dispose).not.toHaveBeenCalled();
      await close({ ...fixture, client });
    } finally { vi.useRealTimers(); }
  });

  it.each(['completed', 'unknown'] as const)('preserves %s effects when cancellation races a mutation result', async (effects) => {
    const records: AcceptanceRecord[] = [];
    const fixture = await opened(new AcceptanceTrace(record => { records.push(record); })); const controller = new AbortController();
    const request = fixture.client.request('click', {}, context(controller.signal));
    const original = fixture.requests.at(-1)!; controller.abort(); const cancel = fixture.requests.at(-1)!;
    if (effects === 'completed') fixture.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: false, error: { code: 'invalid-arguments' }, scopeState: 'usable' });
    fixture.send(fixture.result(original, effects === 'completed' ? {} : { ok: false, data: undefined, error: { code: 'cancelled' }, effects, scopeState: 'quarantined' }));
    expect(await request).toMatchObject({ effects });
    expect(records.some(record => record.phase === 'ResultValidated')).toBe(true);
    if (effects === 'unknown') expect(records.some(record => record.phase === 'CancelAckValidated')).toBe(false);
    if (effects === 'completed') await close(fixture);
    else expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it.each(['id', 'generation'] as const)('rejects a cancellation ACK with unrelated %s', async (field) => {
    const records: AcceptanceRecord[] = [];
    const fixture = await opened(new AcceptanceTrace(record => { records.push(record); })); const controller = new AbortController();
    const request = fixture.client.request('browser.observe', {}, context(controller.signal));
    const failure = expect(request).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    controller.abort(); const cancel = fixture.requests.at(-1)!;
    fixture.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: true, scopeState: 'usable', [field]: field === 'id' ? 'unrelated' : 2 });
    await failure; expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(records.some(record => record.phase === 'CancelAckValidated')).toBe(false);
    expect(records.some(record => record.phase === 'FrameRefused' && record.reason === 'response-correlation')).toBe(true);
  });

  it('retains lifecycle event publication until a cancelled transition has actually settled', async () => {
    const fixture = harness(); const events: NativeEvent[] = [];
    const connecting = fixture.connect(event => { events.push(event); }); fixture.send(fixture.ready()); const client = await connecting;
    const epoch = client.callbackCheckpoint(); const controller = new AbortController();
    const transition = client.request('scope.reset', {}, context(controller.signal), epoch);
    const original = fixture.requests.at(-1)!; controller.abort(); const cancel = fixture.requests.at(-1)!;
    fixture.send(fixture.result(original), { type: 'event', generation: 1, sequence: 1, event: 'navigation', payload: { identityScope: 'replacement' } });
    await Promise.resolve(); expect(events).toEqual([]);
    fixture.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: false, error: { code: 'invalid-arguments' }, scopeState: 'usable' });
    expect((await transition).ok).toBe(true);
    expect(events).toEqual([]); client.retireCallbacks(epoch); await Promise.resolve();
    expect(events).toHaveLength(1); await close({ ...fixture, client });
  });

  it('refuses an already aborted request before writing it', async () => {
    const fixture = await opened();
    const controller = new AbortController(); controller.abort();
    await expect(fixture.client.request('click', {}, context(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.requests).toHaveLength(1);
    await close(fixture);
  });

  it('keeps a clean native refusal reusable but quarantines an unknown result', async () => {
    const fixture = await opened();
    const first = fixture.client.request('missing', {}, context());
    fixture.send({ ...fixture.result(fixture.requests.at(-1)!), ok: false, data: undefined, error: { code: 'unsupported-command' }, effects: 'not-dispatched' });
    expect((await first).ok).toBe(false);
    const second = fixture.client.request('click', {}, context());
    fixture.send({ ...fixture.result(fixture.requests.at(-1)!), ok: false, data: undefined, error: { code: 'deadline-exceeded' }, effects: 'unknown', scopeState: 'quarantined' });
    expect((await second).effects).toBe('unknown');
    await expect(fixture.client.request('click', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('rejects all pending promises when closure precedes their results', async () => {
    const fixture = await opened();
    const action = fixture.client.request('navigate', {}, context());
    const rejected = expect(action).rejects.toMatchObject({ code: 'CANCELLED' });
    await close(fixture);
    await rejected;
  });

  it('applies a negotiated lower frame bound to subsequent outbound requests', async () => {
    const fixture = harness();
    const connecting = fixture.connect();
    fixture.send(fixture.ready({ limits: { maxFrameBytes: 256, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 } }));
    const client = await connecting;
    await expect(client.request('evaluate', { script: 'x'.repeat(300) }, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(1);
    await close({ ...fixture, client });
  });

  it('rejects wrong generation and event gaps rather than forwarding them', async () => {
    const fixture = await opened();
    const action = fixture.client.request('status', {}, context());
    fixture.send(fixture.result(fixture.requests.at(-1)!, { generation: 2 }));
    await expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const second = await opened();
    second.send({ type: 'event', generation: 1, sequence: 2, event: 'diagnostic', payload: {} });
    await expect(second.client.request('status', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});

describe('closed native receive diagnostics', () => {
  it.each([
    ['schema', { type: 'private-secret-value' }],
    ['event-order', { type: 'event', generation: 1, sequence: 2, event: 'test', payload: {} }],
    ['response-correlation', { type: 'control-result', id: 'unknown-private-id', generation: 1, accepted: true, scopeState: 'usable' }],
    ['response-kind', { type: 'control-result', id: 'c2', generation: 1, accepted: true, scopeState: 'usable' }],
    ['callback-proof', { type: 'event', generation: 1, sequence: 1, event: 'scope.callbacks-retired', payload: { identityScope: 'private-scope', throughEventSequence: 9 } }],
    ['native-refusal:invalid-arguments', { type: 'error', error: { code: 'invalid-arguments' }, scopeState: 'quarantined' }],
    ['schema', { type: 'error', error: { code: 'private-secret-value' }, scopeState: 'quarantined' }],
  ])('reports only %s and preserves failure/quarantine', async (reason, message) => {
    const fixture = await opened();
    const pending = fixture.client.request('page.title', {}, context());
    fixture.send(message);
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: `The native browser protocol became invalid (${reason})` });
    expect(fixture.dispose).toHaveBeenCalledOnce();
    await expect(fixture.client.request('page.title', {}, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: `The native browser protocol became invalid (${reason})` });
    expect(fixture.requests).toHaveLength(2);
  });

  it('distinguishes invalid framing without exposing its bytes', async () => {
    const fixture = await opened();
    const pending = fixture.client.request('page.title', {}, context());
    fixture.output.write('private-secret-value\n');
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (frame)' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('reports bounded event capacity without exposing event data', async () => {
    const fixture = harness();
    const connecting = fixture.connect();
    fixture.send(fixture.ready({ limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 1, maxTimeoutMs: 3600000 } }));
    const client = await connecting;
    const pending = client.request('page.title', {}, context());
    fixture.send(...[1, 2].map(sequence => ({ type: 'event', generation: 1, sequence, event: 'test', payload: { value: 'private-secret-value' } })));
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The native browser protocol became invalid (capacity)' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});

describe('instrumented settlement diagnostics', () => {
  it.each([false, true])('limits diagnostics to instrumented readiness=%s', async instrumented => {
    vi.useFakeTimers();
    try {
      const f = harness(); const connecting = f.connect();
      f.send(f.ready({ capabilities: instrumented ? ['acceptance.faults/1'] : [] }));
      const client = await connecting; const controller = new AbortController();
      const request = client.request('private-command', {}, context(controller.signal));
      const original = f.requests.at(-1)!;
      const failure = request.catch(cause => cause as Error);
      controller.abort();
      f.send(f.result(original, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched' }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await failure).toMatchObject({ code: 'CANCELLED', message: 'The native browser operation ended without a settled outcome' + (instrumented ? ' (settlement:result-seen=true;cancel-ack-seen=false)' : '') });
      expect(f.dispose).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('reports a settled cancel ACK without inventing an original result', async () => {
    vi.useFakeTimers();
    try {
      const f = harness(); const connecting = f.connect(); f.send(f.ready({ capabilities: ['acceptance.faults/1'] }));
      const client = await connecting; const controller = new AbortController();
      const request = client.request('private-command', {}, context(controller.signal)); const failure = request.catch(cause => cause as Error);
      controller.abort(); const cancel = f.requests.at(-1)!;
      f.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: true, scopeState: 'usable' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await failure).toMatchObject({ code: 'CANCELLED', message: 'The native browser operation ended without a settled outcome (settlement:result-seen=false;cancel-ack-seen=true)' });
      expect(f.requests.map(frame => frame['type'])).toEqual(['hello', 'request', 'cancel']);
    } finally { vi.useRealTimers(); }
  });
});


describe('internal acceptance observer isolation', () => {
  it('emits nothing and adds no write callback before negotiated acceptance capability', async () => {
    const observe = vi.fn(); const trace = new AcceptanceTrace(observe); const fixture = harness(trace);
    const write = vi.spyOn(fixture.input, 'write');
    const connecting = fixture.connect();
    expect(write).toHaveBeenCalledOnce(); expect(write.mock.calls[0]).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
    fixture.send(fixture.ready()); const client = await connecting;
    const request = client.request('private-command', { token: 'private-token' }, context());
    expect(write.mock.calls.at(-1)).toHaveLength(1);
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await request;
    await close({ ...fixture, client }); trace.finish();
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps the original Buffer and one write when backpressure returns %s', async returned => {
    const records: AcceptanceRecord[] = []; const trace = new AcceptanceTrace(record => { records.push(record); });
    const fixture = await opened(trace); const forwarded: Buffer[] = []; let callback: ((error?: Error | null) => void) | undefined;
    const original = fixture.input.write.bind(fixture.input);
    const write = vi.spyOn(fixture.input, 'write').mockImplementation((chunk, encoding, cb) => {
      forwarded.push(chunk as Buffer); callback = typeof encoding === 'function' ? encoding : cb;
      original(chunk); return returned;
    });
    const request = fixture.client.request('private-command', { url: 'https://private.invalid/secret', token: 'private-token' }, context());
    expect(write).toHaveBeenCalledOnce(); expect(forwarded[0]).toBe(write.mock.calls[0]![0]);
    const entry = records.findLast(record => record.phase === 'WriteEntered')!;
    expect(entry.length).toBe(forwarded[0]!.length); expect(entry.end! - entry.start!).toBe(entry.length);
    expect(records.findLast(record => record.phase === 'WriteReturned')?.returned).toBe(returned);
    // A delayed error callback is not an ACK, rejection, quarantine, or retry.
    callback?.(Object.assign(new Error('private-error-text'), { code: 'EPIPE' }));
    expect(records.findLast(record => record.phase === 'WriteCallback')?.io).toBe('broken-pipe');
    expect(fixture.dispose).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce();
    fixture.send(fixture.result(fixture.requests.at(-1)!)); await expect(request).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(records)).not.toMatch(/private-command|private.invalid|private-token|private-error-text/);
    write.mockRestore(); await close(fixture); trace.finish();
  });

  it('contains observer and diagnostic property exceptions without changing delivery', async () => {
    const records: AcceptanceRecord[] = []; let throwObserver = true;
    const trace = new AcceptanceTrace(record => { if (throwObserver) throw new Error('private observer'); records.push(record); });
    const fixture = await opened(trace); throwObserver = false;
    Object.defineProperty(fixture.input, 'writableEnded', { configurable: true, get() { throw new Error('private getter'); } });
    const writes = vi.spyOn(fixture.input, 'write');
    const request = fixture.client.request('read', {}, context());
    expect(writes).toHaveBeenCalledOnce(); fixture.send(fixture.result(fixture.requests.at(-1)!));
    await expect(request).resolves.toMatchObject({ ok: true });
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(records.some(record => record.droppedBefore > 0)).toBe(true);
    delete (fixture.input as unknown as Record<string, unknown>)['writableEnded'];
    await close(fixture);
  });

  it('preserves thrown-write and stream-error failures without retaining error text', async () => {
    for (const mode of ['throw', 'stream'] as const) {
      const records: AcceptanceRecord[] = []; const fixture = await opened(new AcceptanceTrace(record => { records.push(record); }));
      const error = Object.assign(new Error('secret error sentinel'), { code: 'ECONNRESET' });
      const write = mode === 'throw' ? vi.spyOn(fixture.input, 'write').mockImplementation(() => { throw error; }) : undefined;
      const request = fixture.client.request('read', {}, context());
      const failed = expect(request).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      if (mode === 'stream') fixture.input.emit('error', error);
      await failed; expect(fixture.dispose).toHaveBeenCalledOnce();
      if (mode === 'throw') { expect(write).toHaveBeenCalledOnce(); expect(records.find(record => record.phase === 'WriteThrew')?.io).toBe('connection-reset'); }
      expect(JSON.stringify(records)).not.toContain('secret error sentinel');
    }
  });

  it('records a failed pre-write serialization without sending or poisoning reuse', async () => {
    const records: AcceptanceRecord[] = []; const fixture = await opened(new AcceptanceTrace(record => { records.push(record); }));
    const args: Record<string, never> = {}; Object.defineProperty(args, 'secret', { enumerable: true, get() { throw new Error('secret serialization'); } });
    await expect(fixture.client.request('read', args, context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fixture.requests).toHaveLength(1); expect(fixture.dispose).not.toHaveBeenCalled();
    expect(records.findLast(record => record.phase === 'ExchangeRefused')).toMatchObject({ reason: 'serialization', kind: 'request' });
    await close(fixture);
  });

  it.each(['clean', 'partial', 'invalid'] as const)('classifies %s receive boundaries without payloads', async mode => {
    const records: AcceptanceRecord[] = []; const fixture = await opened(new AcceptanceTrace(record => { records.push(record); }));
    const request = fixture.client.request('read', {}, context()); const failure = expect(request).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    if (mode === 'invalid') fixture.output.write('private-invalid-frame\n');
    else { if (mode === 'partial') fixture.output.write('{"private-pending":'); fixture.output.end(); }
    await failure;
    if (mode === 'invalid') expect(records.findLast(record => record.phase === 'FrameRefused')?.reason).toBe('parse');
    else expect(records.findLast(record => record.phase === 'ReceiveEof')).toMatchObject({ clean: mode === 'clean', failed: false, pendingBytes: mode === 'clean' ? 0 : 19 });
    expect(JSON.stringify(records)).not.toMatch(/private-invalid|private-pending/);
  });
});


describe('acceptance scalar accounting', () => {
  it('bounds pre-ready facts, marks suppression, and clamps counters with explicit overflow', () => {
    const records: AcceptanceRecord[] = []; const trace = new AcceptanceTrace(record => { records.push(record); });
    for (let index = 0; index < 100; index++) trace.observe('FrameComplete');
    expect(records).toHaveLength(0); trace.enable();
    expect(records).toHaveLength(64); expect(records[0]).toMatchObject({ phase: 'CaptureStarted', initialSubmittedBytes: 0, seedKnown: true, suppressedBefore: 37 });
    trace.span(Number.MAX_SAFE_INTEGER); expect(trace.span(1).end).toBe(Number.MAX_SAFE_INTEGER);
    trace.finish(); expect(records.at(-1)).toMatchObject({ phase: 'CaptureFinished', submittedBytes: Number.MAX_SAFE_INTEGER, overflow: true, pendingWriteCallbacks: 0 });
  });
  it('reports pending write callbacks at the terminal boundary rather than inventing completion', () => {
    const records: AcceptanceRecord[] = []; const trace = new AcceptanceTrace(record => { records.push(record); }); trace.enable();
    const write = trace.writeObserver({ kind: 'cancel', operationSeq: 2, start: 0, end: 1, length: 1 });
    trace.finish(); expect(records.at(-1)?.pendingWriteCallbacks).toBe(1);
    write.complete(); expect(records.at(-1)?.phase).toBe('CaptureFinished');
  });
});


describe('terminal cleanup control', () => {
  async function terminalPeer(settle?: (context: OperationContext) => Promise<void>) {
    const peer = harness();
    const connecting = NativeClient.connect({ readable: peer.output, writable: peer.input, dispose: peer.dispose, ...(settle === undefined ? {} : { settle }) }, ['terminal.close/1'], context(), () => {});
    peer.send(peer.ready({ capabilities: ['terminal.close/1'] }));
    return { ...peer, client: await connecting };
  }
  function unknown(peer: Awaited<ReturnType<typeof terminalPeer>>, request: Record<string, unknown>, code = 'browser-failure') {
    peer.send(peer.result(request, { ok: false, data: undefined, error: { code }, effects: 'unknown', scopeState: 'quarantined' }));
  }
  function receipt(peer: Awaited<ReturnType<typeof terminalPeer>>, generation = 1) {
    peer.send({ type: 'closed', id: peer.requests.find(request => request['type'] === 'close')!['id'], generation, scopeState: 'closed' });
  }
  it.each(['before', 'after'] as const)('shares one close receipt when explicit close starts %s Unknown', async order => {
    const settle = vi.fn(async () => {});
    const peer = await terminalPeer(settle);
    const action = peer.client.request('page.navigate', {}, context());
    const request = peer.requests.at(-1)!;
    const early = order === 'before' ? peer.client.close(context()) : undefined;
    unknown(peer, request);
    expect(peer.client.isTerminal()).toBe(true);
    expect((await action).effects).toBe('unknown');
    expect(peer.dispose).not.toHaveBeenCalled();
    await expect(peer.client.request('scope.reconnect', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(peer.client.decide('retired', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const expired = { ...context(AbortSignal.abort()), get timeoutMs(): number { throw new Error('expired getter'); } };
    const first = peer.client.close(expired);
    const second = peer.client.close(context());
    expect(first).toBe(second);
    if (early !== undefined) expect(first).toBe(early);
    expect(peer.requests.filter(item => item['type'] === 'close')).toHaveLength(1);
    receipt(peer);
    await first;
    expect(settle).toHaveBeenCalledOnce();
    expect(peer.dispose).toHaveBeenCalledOnce();
    expect(peer.client.close(expired)).toBe(first);
  });
  it.each(['before', 'after'] as const)('preserves Unknown with cancel ACK %s result', async order => {
    const peer = await terminalPeer();
    const controller = new AbortController();
    const action = peer.client.request('page.navigate', {}, context(controller.signal));
    const request = peer.requests.at(-1)!;
    controller.abort();
    const cancel = peer.requests.at(-1)!;
    const ack = () => peer.send({ type: 'control-result', id: cancel['id'], generation: 1, accepted: false, error: { code: 'scope-unavailable' }, scopeState: 'quarantined' });
    if (order === 'before') ack();
    unknown(peer, request);
    if (order === 'after') ack();
    expect((await action).effects).toBe('unknown');
    receipt(peer);
    await peer.client.close(context());
  });
  it('accepts exact close proof before cancel ACK without treating the retired cancel as a cleanup failure', async () => {
    const settle = vi.fn(async () => {});
    const peer = await terminalPeer(settle);
    const controller = new AbortController();
    const action = peer.client.request('page.navigate', {}, context(controller.signal));
    const rejected = expect(action).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    expect(peer.requests.filter(request => request['type'] === 'cancel')).toHaveLength(1);
    const closing = peer.client.close(context());
    receipt(peer);
    await rejected;
    await expect(closing).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledOnce();
    expect(peer.dispose).toHaveBeenCalledOnce();
    expect(peer.client.close(context())).toBe(closing);
    await expect(peer.client.request('page.navigate', {}, context())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it.each(['eof', 'stale', 'cleanup-failed', 'malformed'] as const)('retains cleanup failure for %s without rewriting Unknown', async fault => {
    const peer = await terminalPeer();
    const action = peer.client.request('page.navigate', {}, context());
    unknown(peer, peer.requests.at(-1)!);
    const closing = peer.client.close(context());
    const rejection = expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    if (fault === 'eof') peer.output.end();
    else if (fault === 'stale') receipt(peer, 2);
    else if (fault === 'cleanup-failed') peer.send({ type: 'error', id: peer.requests.at(-1)!['id'], error: { code: 'cleanup-failed' }, scopeState: 'quarantined' });
    else peer.output.write('{invalid}\n');
    await rejection;
    expect((await action).effects).toBe('unknown');
    expect(peer.client.close(context())).toBe(closing);
    expect(peer.dispose).toHaveBeenCalledOnce();
  });
  it('does not treat a valid receipt as success when proxy settlement fails', async () => {
    const peer = await terminalPeer(async () => { throw new Error('exit failed'); });
    const action = peer.client.request('page.navigate', {}, context());
    unknown(peer, peer.requests.at(-1)!);
    const closing = peer.client.close(context());
    const rejected = expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    receipt(peer); await rejected;
    expect((await action).effects).toBe('unknown');
    expect(peer.client.close(context())).toBe(closing);
  });
  it('settles already pending outcomes and suppresses late callbacks without reviving requests', async () => {
    const peer = await terminalPeer();
    const first = peer.client.request('first', {}, context()); const one = peer.requests.at(-1)!;
    const second = peer.client.request('second', {}, context()); const two = peer.requests.at(-1)!;
    unknown(peer, one);
    peer.send({ type: 'event', generation: 1, sequence: 1, event: 'network.request', payload: {}, decision: { token: 'late', timeoutMs: 1 } });
    peer.send(peer.result(two, { ok: false, data: undefined, error: { code: 'cancelled' }, effects: 'not-dispatched', scopeState: 'quarantined' }));
    receipt(peer);
    expect((await first).effects).toBe('unknown');
    expect((await second).effects).toBe('not-dispatched');
    await peer.client.close(context());
    expect(peer.requests.filter(item => item['type'] === 'close')).toHaveLength(1);
  });
  it('bounds missing close receipt independently of an expired action budget', async () => {
    vi.useFakeTimers();
    try {
      const peer = await terminalPeer();
      const action = peer.client.request('page.navigate', {}, context());
      unknown(peer, peer.requests.at(-1)!);
      const closing = peer.client.close(context());
      const rejection = expect(closing).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(15001);
      await rejection;
      expect((await action).effects).toBe('unknown');
      expect(peer.requests.filter(item => item['type'] === 'close')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('does not authorize a cleanup exchange from malformed terminal-shaped input', async () => {
    const peer = await terminalPeer();
    const action = peer.client.request('page.navigate', {}, context());
    const rejected = expect(action).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    peer.send(peer.result(peer.requests.at(-1)!, { effects: 'unknown', scopeState: 'quarantined' }));
    await rejected;
    expect(peer.requests.filter(item => item['type'] === 'close')).toHaveLength(0);
  });
});
