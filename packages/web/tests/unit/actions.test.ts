/**
 * Native action forwarding, settlement and public error contracts.
 */

import { describe, expect, it, vi } from 'vitest';
import { EngineError, type LocatorAction } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { BrowserChannel, isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';
import { serverMessage } from '../../src/native/protocol.ts';
import type { EngineCommandMap } from '../../src/native/engine-contract.ts';

// The native producer owns string-to-label selection. Run 39940386738 executes
// select_modes_are_unambiguous_and_string_means_label and the hosted exact-action
// contract. This peer proves the original action and 7ms budget cross the adapter once.
// C03's exact dev tests at native 31df55cf prove the 900ms CDP hold, empty
// PREPARE_FILL/Delete fallback and positive index 2. The latter scripts execute
// in a Node scripted DOM. These peers preserve actions/budgets, not renderer proof.
describe('native locator action forwarding', () => {
  it.each([
    [{ kind: 'selectOption', value: 'Blue' }, 'selectOption', [{ label: 'Blue' }, { timeout: 7 }]],
    [{ kind: 'longPress', durationMs: 900 }, 'click', [{ timeout: 7, delay: 900 }]],
    [{ kind: 'clear' }, 'fill', ['', { timeout: 7 }]],
    [{ kind: 'selectOption', value: { index: 2 } }, 'selectOption', [{ index: 2 }, { timeout: 7 }]],
  ] as const satisfies readonly (readonly [LocatorAction, string, readonly unknown[]])[])(
    'dispatches %j to locator.%s',
    async (action) => {
      vi.useFakeTimers();
      const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
      const peer = new NativeProtocolPeer([], () => ({ data: null }));
      const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
      try {
        const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
        const original = structuredClone(args);
        await new EngineChannel(client).command('browser.perform', args, operation);
        expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
        expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
      } finally {
        try { await client.close({ ...operation, timeoutMs: 1000 }); }
        finally { vi.useRealTimers(); }
      }
    },
  );

  // Immutable native drag tests resolve the source and exact destination through
  // browser.perform. This peer checks only the original target ref and budget.
  it('uses Playwright drag when both sides are locators', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const action: LocatorAction = { kind: 'dragTo', target: { id: 'n2', revision: 'r' } };
    const peer = new NativeProtocolPeer([], () => ({ data: null }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
      const original = structuredClone(args);
      await new EngineChannel(client).command('browser.perform', args, operation);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });
});

// Original identities21–23 have exact400x300 native producer fixtures.
// The native fixtures separately prove targeting and known-pointer continuity;
// the peers below only prove adapter dispatch and budget forwarding.
// The protocol carries direction/momentum;
// target geometry and aiming are owned by native, with no fabricated wire fields.
describe('native node swipe adapter obligations', () => {
  it.each([
    ['scrolls a node with a wheel gesture sized by its own box: the agent node scroll', [
      { kind: 'swipe', direction: 'down' }, { kind: 'swipe', direction: 'left', momentum: 'fast' },
    ]],
    ['wheels a node hit at its centre there, at the box the hit test read, without hovering it first', [
      { kind: 'swipe', direction: 'down' },
    ]],
    ['wheels a node the pointer already hovers without moving the pointer', [
      { kind: 'swipe', direction: 'down' },
    ]],
  ] as const)('%s', async (_title, actions) => {
    vi.useFakeTimers();
    const operation = { timeoutMs: 7, signal: new AbortController().signal, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ data: null }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    const expected = actions.map(action => ['browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action }]);
    try {
      const channel = new EngineChannel(client);
      for (const action of actions) {
        await expect(channel.command('browser.perform', { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action }, operation)).resolves.toBeNull();
      }
      // No separate public hover, pointer movement or box request is inserted.
      // This says nothing about native's internal preparation/CDP call counts.
      expect(peer.requests.map(request => [request.command, request.args])).toEqual(expected);
      expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual(actions.map(() => 7));
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });
});

// Run 39940386738 executes the no-box native refusal and its public lifecycle
// counterpart. This peer checks only error mapping, one dispatch and the 7ms wire budget.
describe('native locator action refusals', () => {
  // Original case 7. The mandatory native synthetic fixture taps the same
  // real button successfully, closes only its actual Chrome target, observes
  // native detachment, then refuses this exact tap with no Input command.
  // This peer proves public mapping and clean scope teardown, not page closure.
  it('maps "Target page, context or browser has been closed" to ENGINE_FAILURE', async () => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], request => {
      if (request.command === 'browser.perform') return { error: 'browser-failure', effects: 'not-dispatched', scopeState: 'usable' };
      if (request.command === 'scope.end') return { data: null };
      throw new Error('Unexpected closed-page adapter command');
    });
    const disposed = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation, () => undefined);
    const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
    const original = structuredClone(args);
    try {
      const channel = new EngineChannel(client);
      const failure: unknown = await channel.command('browser.perform', args, operation).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(true);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
      expect(disposed).not.toHaveBeenCalled();
      await expect(channel.command('scope.end', { identityScope: 'scope' }, operation)).resolves.toBeNull();
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([
        ['browser.perform', original], ['scope.end', { identityScope: 'scope' }],
      ]);
    } finally { await client.close(operation); }
  });

  // Original case 4. The source-bound MATCH_QUERY fixture executes this author
  // text; native live_query_publication_then_tap_refuses_ambiguity_without_input
  // publishes one match, revalidates two, and releases both query groups with
  // zero input/scroll despite those words. This peer proves the adapter half.
  it('keeps misleading action-log words in an ambiguous text query as author data', async () => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const expression = { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'performing click action', exact: false } } } as const;
    const ref = { id: '@e2', revision: '1' };
    const queryArgs = { identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' };
    const actionArgs = { identityScope: 'scope', ref, action: { kind: 'tap' } as const };
    const original = structuredClone([queryArgs, actionArgs]);
    const peer = new NativeProtocolPeer([], request => {
      if (request.command === 'browser.query') return { data: { identityScope: 'scope', revision: '1', nodes: [{ ref, role: 'button', name: 'click action done', text: 'performing click action\nclick action done' }] } };
      if (request.command === 'browser.perform') return { error: 'stale-reference', effects: 'not-dispatched', scopeState: 'usable' };
      if (request.command === 'page.title') return { data: { title: 'still usable' } };
      throw new Error('Unexpected misleading-query adapter command');
    });
    const disposed = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation, () => undefined);
    try {
      const channel = new EngineChannel(client);
      const query = await channel.command('browser.query', queryArgs, operation);
      expect(query).toMatchObject({ identityScope: 'scope', nodes: [{ ref, name: 'click action done' }] });
      const failure: unknown = await channel.command('browser.perform', actionArgs, operation).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ code: 'NODE_STALE', retryable: true });
      expect(isNativeNotDispatched(failure)).toBe(true);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([
        ['browser.query', original[0]], ['browser.perform', original[1]],
      ]);
      expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual([1000, 1000]);
      expect(disposed).not.toHaveBeenCalled();
      await expect(new BrowserChannel(client, { identityScope: () => 'scope', operation: () => operation }).command('page.title', {}, operation)).resolves.toEqual({ title: 'still usable' });
      expect(peer.requests.map(request => request.command)).toEqual(['browser.query', 'browser.perform', 'page.title']);
    } finally { await client.close(operation); }
  });

  // Same-source native preparation_effect_settlement_unacked_input_release_remains_unknown
  // executes a tap through its original deadline: move/press are acknowledged,
  // release remains unacknowledged, and the producer retains Unknown without replay.
  // This peer proves only the closed outcome's public mapping and terminal adapter fence.
  it('treats a log that stopped at "performing" as uncertain: the input may be in flight', async () => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' }));
    const dispose = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation, () => undefined);
    const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
    const original = structuredClone(args);
    try {
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
      expect(dispose).toHaveBeenCalledOnce();
      const retired = peer.frames.length;
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(peer.frames).toHaveLength(retired);
      expect(peer.requests).toHaveLength(1);
    } finally {
      await expect(client.close(operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });

  // Formal 0e3f's stale_does_not_erase_unknown_effects_after_dispatch checks the
  // shared failure rule. live_drag_destination_revalidates_after_press_without_replay
  // additionally witnesses real press -> stale/Unknown; it is not a tap replay test.
  it.each([
    ['strict mode violation: 2 elements\nCall log:\n  - move and down action done', 'ACTION_MAY_HAVE_COMMITTED', false],
  ] as const)('maps "%s" to %s', async (_text, code, retryable) => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'stale-reference', effects: 'unknown', scopeState: 'quarantined' }));
    const dispose = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code, retryable });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(dispose).toHaveBeenCalledOnce();
      const retired = peer.frames.length;
      await expect(client.request('page.title', {}, operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(peer.frames).toHaveLength(retired);
    } finally {
      await expect(client.close(operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });

  // The labels preserve the old classification rows. Run 39940386738's native
  // live-query tap test executes ambiguous and missing targets, and witnesses
  // stale-reference/not-dispatched with no input or scroll. No legacy text is
  // parsed by this peer; it proves the closed error's adapter mapping.
  it.each([
    ['strict mode violation: 2 elements', 'NODE_STALE', true],
    ['element is detached from the DOM', 'NODE_STALE', true],
  ] as const)('maps "%s" to %s', async (_text, code, retryable) => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'stale-reference' }));
    const client = await peer.connect(operation, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code, retryable });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
    } finally { await client.close(operation); }
  });

  it('reports a node without a box as NOT_ACTIONABLE on swipe', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'not-actionable' }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'swipe', direction: 'up' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });
});

/** Exercise the real decoder and adapter; this peer supplies no renderer evidence. */
async function nativeActionFailure(action: EngineCommandMap['browser.perform']['args']['action'], outcome: Extract<PeerOutcome, { error: string }>): Promise<EngineError> {
  const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'action-contract', attemptId: 'action-contract', origin: 'test' as const };
  const peer = new NativeProtocolPeer(['terminal.close/1'], request => {
    if (request.command === 'browser.perform') return outcome;
    if (request.command === 'scope.end') return { data: null };
    throw new Error('Unexpected native action contract command');
  });
  const client = await peer.connect(operation, () => undefined);
  const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
  const original = structuredClone(args);
  try {
    const channel = new EngineChannel(client);
    const failure: unknown = await channel.command('browser.perform', args, operation).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
    expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
    expect(isNativeNotDispatched(failure)).toBe(outcome.effects === 'not-dispatched');
    if (outcome.effects === 'unknown') {
      await expect(channel.command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      await expect(channel.command('scope.end', { identityScope: 'scope' }, operation)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      expect(peer.requests).toHaveLength(1);
    } else {
      await expect(channel.command('scope.end', { identityScope: 'scope' }, operation)).resolves.toBeNull();
      expect(peer.requests.map(request => request.command)).toEqual(['browser.perform', 'scope.end']);
    }
    return failure as EngineError;
  } finally {
    await client.close(operation);
    expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
  }
}

// Public replacements for actions:6/8/9/10/11/13/14/15/16. Native producer
// receipts are separate prerequisites; these tests do not infer effects from
// missing logs or reconstruct a Playwright Error across the process boundary.
describe('native action error public contracts', () => {
  it('maps a clean typed tap refusal to NOT_ACTIONABLE without replay', async () => {
    const failure = await nativeActionFailure({ kind: 'tap' }, { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'tap did not become actionable' });
  });

  it('keeps acknowledged tap preparation reusable without claiming it was not dispatched', async () => {
    const failure = await nativeActionFailure({ kind: 'tap' }, { error: 'not-actionable', effects: 'completed', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'tap did not become actionable' });
    expect(isNativeNotDispatched(failure)).toBe(false);
  });

  it('reports the closed interception blocker without exposing renderer markup or raw logs', async () => {
    const failure = await nativeActionFailure({ kind: 'tap' }, { error: 'intercepted-pointer', effects: 'completed', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'tap did not become actionable: another element intercepts pointer events' });
    expect(failure.message.length).toBeLessThan(160);
    expect(failure.message).not.toContain('<div');
    expect(failure.cause).toBeUndefined();
  });

  it('keeps an unqualified refusal bounded and rejects raw diagnostics instead of inventing a blocker', async () => {
    const failure = await nativeActionFailure({ kind: 'tap' }, { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'tap did not become actionable' });
    expect(failure.cause).toBeUndefined();
    for (const field of ['message', 'cause', 'stack', 'callLog']) {
      expect(() => serverMessage({
        type: 'result', id: 'action', generation: 1, operationSeq: 1, ok: false,
        effects: 'not-dispatched', scopeState: 'usable',
        error: { code: 'not-actionable', [field]: 'private DOM text: performing click action' },
      })).toThrow();
    }
  });

  it('keeps unacknowledged tap input Unknown and non-retryable', async () => {
    const failure = await nativeActionFailure({ kind: 'tap' }, { error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' });
    expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: 'tap outcome is unknown; the action may have committed' });
    expect(failure.cause).toBeUndefined();
  });

  it('does not turn a locally expired pending action into a clean refusal or replay it while settling', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'action-deadline', attemptId: 'action-deadline', origin: 'test' as const };
    let settle!: (outcome: PeerOutcome) => void;
    const result = new Promise<PeerOutcome>(resolve => { settle = resolve; });
    const peer = new NativeProtocolPeer(['terminal.close/1'], () => result);
    const client = await peer.connect(operation, () => undefined);
    try {
      const channel = new EngineChannel(client);
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
      const pending = channel.command('browser.perform', args, { ...operation, timeoutMs: 7 }).catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(7);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', args]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
      expect(peer.frames.filter(frame => frame['type'] === 'cancel')).toMatchObject([{ operationSeq: peer.requests[0]!.operationSeq }]);
      await expect(channel.command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      settle({ error: 'deadline-exceeded', effects: 'unknown', scopeState: 'quarantined' });
      const failure: unknown = await pending;
      expect(failure).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(false);
      expect((failure as Error).cause).toBeUndefined();
      await expect(channel.command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'INVALID_STATE', retryable: false });
      expect(peer.requests).toHaveLength(1);
    } finally {
      try {
        await client.close(operation);
        expect(peer.frames.filter(frame => frame['type'] === 'close')).toHaveLength(1);
      } finally { vi.useRealTimers(); }
    }
  });

  it('maps a typed press actionability refusal without requiring or interpreting a backend call log', async () => {
    const failure = await nativeActionFailure({ kind: 'press', key: 'Enter' }, { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'press did not become actionable' });
    expect(failure.message).not.toContain('Timeout');
    expect(failure.cause).toBeUndefined();
  });

  it('redacts sensitive fill failures without downgrading a post-probe race from Unknown', async () => {
    const secret = 'hunter2-plaintext';
    for (const effects of ['not-dispatched', 'unknown'] as const) {
      const failure = await nativeActionFailure({ kind: 'fill', value: secret, sensitive: true }, {
        error: 'not-actionable', effects, scopeState: effects === 'unknown' ? 'quarantined' : 'usable',
      });
      expect(failure).toMatchObject({ code: effects === 'unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : 'NOT_ACTIONABLE', retryable: false });
      expect(failure.message).toContain('[redacted]');
      expect(failure.message).not.toContain(secret);
      expect(failure.stack).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(failure.cause).toBeUndefined();
    }
  });

  it('keeps an ordinary fill diagnostic useful without fabricating a remote JavaScript cause', async () => {
    const failure = await nativeActionFailure({ kind: 'fill', value: 'gamma', sensitive: false }, { error: 'not-actionable', effects: 'not-dispatched', scopeState: 'usable' });
    expect(failure).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false, message: 'fill did not become actionable' });
    expect(failure.message).not.toContain('[redacted]');
    expect(failure.message).not.toContain('gamma');
    expect(failure.stack).not.toContain('gamma');
    expect(failure.cause).toBeUndefined();
  });
});

// These are adapter proofs. The native retirement_node_swipes and
// direct_point_clicks fixtures own the geometry, pacing and render-ACK proof.
describe('native action motion contracts', () => {
  it('forwards node swipes after a known hover without inserting another pointer operation', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'motion', attemptId: 'motion', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ data: null }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    try {
      const channel = new EngineChannel(client);
      const hover = { identityScope: 'scope', point: { x: 80, y: 70 }, action: { kind: 'hover' } as const };
      await expect(channel.command('browser.pointer', hover, operation)).resolves.toBeNull();
      const swipes = [
        { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'swipe', direction: 'down' } as const },
        { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'swipe', direction: 'left', momentum: 'fast' } as const },
      ];
      for (const swipe of swipes) await expect(channel.command('browser.perform', swipe, operation)).resolves.toBeNull();
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([
        ['browser.pointer', hover], ...swipes.map(swipe => ['browser.perform', swipe]),
      ]);
      expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual([7, 7, 7]);
      // No adapter-side hover, geometry request, movement or replay is inserted.
      // Native must separately prove wheel coordinates, delta and render settlement.
      expect(peer.requests.filter(request => request.command === 'browser.pointer')).toHaveLength(1);
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });

  it('forwards the 48ms pointer path and keeps completion pending until the native result', async () => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'paced-motion', attemptId: 'paced-motion', origin: 'test' as const };
    let arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    let settle!: (outcome: PeerOutcome) => void;
    const outcome = new Promise<PeerOutcome>(resolve => { settle = resolve; });
    const peer = new NativeProtocolPeer([], () => { arrived(); return outcome; });
    const client = await peer.connect(operation, () => undefined);
    try {
      const args = { identityScope: 'scope', point: { x: 10, y: 20 }, action: { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 } as const };
      let finished = false;
      const pending = new EngineChannel(client).command('browser.pointer', args, operation).then(result => { finished = true; return result; });
      await received;
      expect(finished).toBe(false);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.pointer', args]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
      settle({ data: null });
      await expect(pending).resolves.toBeNull();
      expect(finished).toBe(true);
      expect(peer.requests).toHaveLength(1);
    } finally { await client.close(operation); }
  });
});
