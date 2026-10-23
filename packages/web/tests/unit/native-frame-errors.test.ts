import { expect, test } from 'vitest';
import type { LocatorExpression, OperationContext } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { isNativeNotDispatched, resultError } from '../../src/native/browser-channel.ts';
import type { EngineCommandMap } from '../../src/native/engine-contract.ts';
import { frameQuerySnapshot } from '../../src/native/query-diagnostic.ts';
import { MAX_FRAME_BYTES, type NativeResult } from '../../src/native/protocol.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic', attemptId: 'synthetic', origin: 'test' });
const terminal: LocatorExpression = { kind: 'selector', selector: 'button' };
const frame = (selector: string, source: LocatorExpression = terminal): LocatorExpression => ({ kind: 'frame', selector, source });
const nested = (): LocatorExpression => frame('#outer', { kind: 'index', index: 'first', source: {
  kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } }, scope: {
    kind: 'filter', has: terminal, source: frame('.middle', frame('css=#deep')),
  },
} });
const args = (expression = nested()): EngineCommandMap['browser.query']['args'] => ({ identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type=password]', expression });
const outcome = (index: number, count: number): PeerOutcome => ({ error: count === 0 ? 'frame-not-found' : 'frame-ambiguous', frameSelection: { index, count } });

for (const command of ['browser.query', 'fixture.query'] as const) {
  test(`${command} retains native ordinal, exact count, original selector, and old public retryability`, async () => {
    let index = 0; let count = 0;
    const peer = new NativeProtocolPeer([], request => { expect(request.command).toBe(command); return outcome(index, count); });
    const client = await peer.connect(operation(), () => {});
    try {
      for (index = 0; index < 3; index++) for (count of [0, 2, 100_000]) {
        const selector = ['#outer', '.middle', 'css=#deep'][index];
        const failure = await new EngineChannel(client).command(command, args(), operation()).catch(cause => cause);
        expect(failure).toMatchObject({ code: count === 0 ? 'FRAME_NOT_FOUND' : 'FRAME_AMBIGUOUS',
          message: count === 0 ? `no frame matches ${selector}` : `${count} frames match ${selector}`, retryable: count === 0 });
        expect(isNativeNotDispatched(failure)).toBe(true);
      }
      expect(peer.requests).toHaveLength(9); // No diagnostic query or retry.
    } finally { await client.close(operation()); }
  });

  test(`${command} captures selector strings before the original AST is mutated`, async () => {
    const original = { kind: 'frame' as const, selector: '#original', source: terminal };
    const request = { ...args(original) };
    const peer = new NativeProtocolPeer([], sent => {
      expect(sent.args['expression']).toMatchObject({ selector: '#original' });
      original.selector = '#mutated';
      request.expression = frame('#replacement');
      return outcome(0, 2);
    });
    const client = await peer.connect(operation(), () => {});
    try {
      await expect(new EngineChannel(client).command(command, request, operation())).rejects.toMatchObject({ code: 'FRAME_AMBIGUOUS', message: '2 frames match #original', retryable: false });
      expect(peer.requests).toHaveLength(1);
    } finally { await client.close(operation()); }
  });
}

test.each([
  ['no chain', terminal, 0],
  ['ordinal beyond chain', frame('#outer'), 1],
  ['frame-bearing has', { kind: 'filter', source: frame('#outer'), has: frame('#unrelated') }, 0],
  ['malformed frame', { kind: 'frame', selector: 10, source: terminal }, 0],
  ['unknown AST key', { ...frame('#outer'), injected: true }, 0],
] as const)('invalidates contradictory frame context: %s', async (_label, expression, index) => {
  const peer = new NativeProtocolPeer([], () => outcome(index, 0));
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('browser.query', args(expression as LocatorExpression), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    await expect(client.request('synthetic.probe', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(peer.requests).toHaveLength(1);
  } finally { peer.dispose(); }
});

test('a nonquery command cannot use a frame error or a caller-injected expression', async () => {
  const peer = new NativeProtocolPeer([], () => outcome(0, 0));
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('session.environment', args(), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(peer.requests).toHaveLength(1);
  } finally { peer.dispose(); }
});

for (const count of [0, 2]) for (const [effects, scopeState, expected] of [
  ['unknown', 'quarantined', 'ACTION_MAY_HAVE_COMMITTED'],
  ['not-dispatched', 'quarantined', 'ENGINE_FAILURE'],
  ['not-dispatched', 'closed', 'ENGINE_FAILURE'],
  ['completed', 'usable', 'ENGINE_FAILURE'],
] as const) {
  test(`count ${count}, ${effects}/${scopeState} cannot become an ordinary frame refusal`, async () => {
    const peer = new NativeProtocolPeer([], () => ({ ...outcome(1, count), effects, scopeState }));
    const client = await peer.connect(operation(), () => {});
    try {
      const failure = await new EngineChannel(client).command('browser.query', args(), operation()).catch(cause => cause);
      expect(failure).toMatchObject({ code: expected, retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(false);
      expect(peer.requests).toHaveLength(1);
    } finally { peer.dispose(); }
  });
}

for (const unknown of [false, true]) {
  test(`owner retirement precedes clean diagnostic mapping, but not unknown outcomes (${unknown})`, async () => {
    let owns = true;
    const peer = new NativeProtocolPeer([], () => { owns = false; return { ...outcome(0, 0), effects: unknown ? 'unknown' : 'not-dispatched', scopeState: unknown ? 'quarantined' : 'usable' }; });
    const client = await peer.connect(operation(), () => {});
    try {
      await expect(new EngineChannel(client, () => () => owns).command('browser.query', args(), operation())).rejects.toMatchObject({ code: unknown ? 'ACTION_MAY_HAVE_COMMITTED' : 'CANCELLED', retryable: false });
      expect(peer.requests).toHaveLength(1);
    } finally { peer.dispose(); }
  });
}

test('unknown effects keep precedence even over contradictory request context', async () => {
  const peer = new NativeProtocolPeer([], () => ({ ...outcome(63, 0), effects: 'unknown', scopeState: 'quarantined' }));
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('session.environment', args(terminal), operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  } finally { peer.dispose(); }
});

test('mapping without validated query context stays generic', () => {
  const result: NativeResult = { type: 'result', id: 'frame', generation: 1, operationSeq: 1, ok: false,
    error: { code: 'frame-not-found', frameSelection: { index: 0, count: 0 } }, effects: 'not-dispatched', scopeState: 'usable' };
  expect(resultError(result)).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
  expect(resultError(result, undefined, undefined, { selector: '#wrong-index', index: 1, count: 0 })).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
});

test('snapshot is copied, native-ordered, and bounded by depth, nodes, and UTF-8 bytes', () => {
  expect(frameQuerySnapshot(nested())).toEqual(['#outer', '.middle', 'css=#deep']);
  expect(frameQuerySnapshot(terminal)).toEqual([]);
  let deep: LocatorExpression = terminal;
  for (let i = 0; i < 64; i++) deep = frame(`#f${i}`, deep);
  expect(frameQuerySnapshot(deep)).toHaveLength(64);
  expect(frameQuerySnapshot(frame('#too-deep', deep))).toBeUndefined();
  let broad: LocatorExpression = terminal;
  for (let i = 0; i < 12; i++) broad = { kind: 'filter', source: broad, has: broad };
  expect(frameQuerySnapshot(frame('#outer', broad))).toBeUndefined();
  const cycle: { kind: 'frame'; selector: string; source: LocatorExpression } = { kind: 'frame', selector: '#cycle', source: terminal };
  cycle.source = cycle;
  expect(frameQuerySnapshot(cycle)).toBeUndefined();
  expect(frameQuerySnapshot(frame('a'.repeat(MAX_FRAME_BYTES)))).toHaveLength(1);
  expect(frameQuerySnapshot(frame('a'.repeat(MAX_FRAME_BYTES), frame('b')))).toBeUndefined();
  expect(frameQuerySnapshot(frame('界'.repeat(Math.ceil(MAX_FRAME_BYTES / 3))))).toBeUndefined();
  for (const expression of [null, {}, { kind: 'other' }, { kind: 'index', source: frame('#outer'), index: -1 },
    { kind: 'query', scope: frame('#outer'), query: { kind: 'role', value: { kind: 'string' } } }]) {
    expect(frameQuerySnapshot(expression as LocatorExpression)).toBeUndefined();
  }
});

test.each(['cancelled', 'deadline-exceeded', 'invalid-arguments', 'stale-reference'])('does not relabel ordinary native %s', async error => {
  const peer = new NativeProtocolPeer([], () => ({ error }));
  const client = await peer.connect(operation(), () => {});
  try {
    const failure = await new EngineChannel(client).command('browser.query', args(), operation()).catch(cause => cause);
    expect(failure.code).toBe(({ cancelled: 'CANCELLED', 'deadline-exceeded': 'OPERATION_TIMEOUT', 'invalid-arguments': 'ENGINE_FAILURE', 'stale-reference': 'NODE_STALE' })[error]);
    expect(peer.requests).toHaveLength(1);
  } finally { await client.close(operation()); }
});

test('each request gets fresh diagnostic context, and a successful native query is not preempted', async () => {
  let call = 0;
  const peer = new NativeProtocolPeer([], () => ++call === 1 ? { data: { identityScope: 'scope', revision: '1', nodes: [] } } : outcome(0, 0));
  const client = await peer.connect(operation(), () => {});
  const channel = new EngineChannel(client);
  try {
    await expect(channel.command('browser.query', args(frame('#first')), operation())).resolves.toMatchObject({ nodes: [] });
    await expect(channel.command('browser.query', args(frame('#second')), operation())).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', message: 'no frame matches #second' });
    await expect(channel.command('browser.query', args(terminal), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(peer.requests).toHaveLength(3);
  } finally { peer.dispose(); }
});

test.each([{ index: 0, count: 1 }, { index: 64, count: 0 }, { index: 0, count: 0, selector: 'untrusted' }])('real client rejects malformed frame facts before public mapping: %j', async frameSelection => {
  const peer = new NativeProtocolPeer([], () => ({ error: 'frame-not-found', frameSelection }));
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('browser.query', args(), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(peer.requests).toHaveLength(1);
  } finally { peer.dispose(); }
});
