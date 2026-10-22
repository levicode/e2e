import { describe, expect, test } from 'vitest';
import type { LocatorExpression, OperationContext, SemanticQuery } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { isNativeNotDispatched, resultError } from '../../src/native/browser-channel.ts';
import type { EngineCommandMap } from '../../src/native/engine-contract.ts';
import { queryDiagnostic } from '../../src/native/query-diagnostic.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const message = 'displayValue queries cannot scope child queries or serve as a has-filter in this engine';
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'synthetic', attemptId: 'synthetic', origin: 'test' });
const query = (kind: SemanticQuery['kind']): LocatorExpression => ({ kind: 'query', query: { kind, value: { kind: 'string', value: 'synthetic', exact: true } } });
const ordinary: LocatorExpression = { kind: 'selector', selector: 'section' };
const scope = (source: LocatorExpression): LocatorExpression => ({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } }, scope: source });
const has = (source: LocatorExpression): LocatorExpression => ({ kind: 'filter', source: ordinary, has: source });
const refinements = (source: LocatorExpression): readonly LocatorExpression[] => [
  source,
  ...(['first', 'last', 2] as const).map(index => ({ kind: 'index' as const, source, index })),
  { kind: 'filter', source, hasText: { kind: 'string', value: 'synthetic', exact: false } },
  { kind: 'filter', source, has: ordinary },
  { kind: 'frame', source, selector: 'iframe' },
  { kind: 'filter', source: { kind: 'index', source, index: 0 }, has: ordinary },
];
const unsupported = (): readonly LocatorExpression[] => refinements(query('displayValue')).flatMap(source => [scope(source), has(source)].flatMap(refinements));
const args = (expression: LocatorExpression): EngineCommandMap['browser.query']['args'] => ({ identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type=password]', expression });
const success = { identityScope: 'scope', revision: '1', nodes: [] };

for (const command of ['browser.query', 'fixture.query'] as const) {
  describe(command, () => {
    test('maps the fixed diagnostic only after actual NativeClient request dispatch and native refusal', async () => {
      let responses = 0;
      const peer = new NativeProtocolPeer([], request => {
        expect(request.command).toBe(command);
        expect(peer.requests).toContain(request);
        responses++;
        return { error: 'unsupported-capability' };
      });
      const client = await peer.connect(operation(), () => {});
      const channel = new EngineChannel(client);
      try {
        for (const expression of unsupported()) {
          const failure = await channel.command(command, args(expression), operation()).catch(cause => cause);
          expect(failure).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message, retryable: false });
          expect(isNativeNotDispatched(failure)).toBe(true);
        }
        expect(responses).toBe(unsupported().length);
        expect(peer.requests).toHaveLength(responses);
      } finally { await client.close(operation()); }
    });

    test('never refuses or runs a query in the adapter, even for an unsupported-looking expression', async () => {
      const peer = new NativeProtocolPeer([], () => ({ data: success }));
      const client = await peer.connect(operation(), () => {});
      const channel = new EngineChannel(client);
      try {
        for (const expression of [scope(query('displayValue')), has(query('displayValue'))]) {
          await expect(channel.command(command, args(expression), operation())).resolves.toEqual(success);
        }
        expect(peer.requests.map(request => request.command)).toEqual([command, command]);
      } finally { await client.close(operation()); }
    });

    test('keeps unrelated native capability failures generic for allowed composition', async () => {
      const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-capability' }));
      const client = await peer.connect(operation(), () => {});
      const channel = new EngineChannel(client);
      const allowed = [
        ...refinements(query('displayValue')),
        ...[ordinary, query('role'), query('label')].flatMap(root => refinements(root).flatMap(source => [source, scope(source), has(source), { ...query('displayValue'), scope: source } as LocatorExpression])),
      ];
      try {
        for (const expression of allowed) {
          await expect(channel.command(command, args(expression), operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: 'The native browser operation failed (unsupported-capability)' });
        }
        expect(peer.requests).toHaveLength(allowed.length);
      } finally { await client.close(operation()); }
    });
  });
}

test.each([
  [{ error: 'unsupported-capability', effects: 'unknown', scopeState: 'quarantined' }, 'ACTION_MAY_HAVE_COMMITTED'],
  [{ error: 'unsupported-capability', effects: 'not-dispatched', scopeState: 'quarantined' }, 'UNSUPPORTED_CAPABILITY'],
  [{ error: 'unsupported-capability', effects: 'not-dispatched', scopeState: 'closed' }, 'UNSUPPORTED_CAPABILITY'],
  [{ error: 'unsupported-capability', effects: 'completed' }, 'UNSUPPORTED_CAPABILITY'],
  [{ error: 'cancelled' }, 'CANCELLED'],
  [{ error: 'deadline-exceeded' }, 'OPERATION_TIMEOUT'],
  [{ error: 'browser-failure' }, 'ENGINE_FAILURE'],
  [{ error: 'unsupported-command' }, 'UNSUPPORTED_CAPABILITY'],
  [{ error: 'not-a-valid-native-error' }, 'ENGINE_FAILURE'],
] satisfies readonly (readonly [PeerOutcome, string])[])('does not relabel native outcome %j', async (outcome, code) => {
  const peer = new NativeProtocolPeer([], () => outcome);
  const client = await peer.connect(operation(), () => {});
  try {
    const failure = await new EngineChannel(client).command('browser.query', args(scope(query('displayValue'))), operation()).catch(cause => cause);
    expect(failure).toMatchObject({ code });
    expect(failure.message).not.toBe(message);
    expect(peer.requests).toHaveLength(1);
    if (('scopeState' in outcome && (outcome.scopeState === 'quarantined' || outcome.scopeState === 'closed')) || outcome.error === 'not-a-valid-native-error') {
      await expect(client.request('synthetic.probe', {}, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(peer.requests).toHaveLength(1);
    }
  } finally { peer.dispose(); }
});

test('the centralized result classifier keeps unknown outcomes ahead of diagnostic evidence', () => {
  expect(resultError({ type: 'result', id: 'synthetic', generation: 1, operationSeq: 1, ok: false, error: { code: 'unsupported-capability' }, effects: 'unknown', scopeState: 'quarantined' }, undefined, 'display-value-composition')).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
});

test('unknown outcome wins even after the owner retires', async () => {
  let owns = true;
  const peer = new NativeProtocolPeer([], () => { owns = false; return { error: 'unsupported-capability', effects: 'unknown', scopeState: 'quarantined' }; });
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client, () => () => owns).command('browser.query', args(scope(query('displayValue'))), operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(peer.requests).toHaveLength(1);
  } finally { peer.dispose(); }
});

test('unrelated engine commands cannot acquire the query diagnostic', async () => {
  const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-capability' }));
  const client = await peer.connect(operation(), () => {});
  try {
    // Even an extra unsupported-looking expression cannot authorize wording for another command.
    await expect(new EngineChannel(client).command('session.environment', args(scope(query('displayValue'))), operation())).rejects.toMatchObject({ message: 'The native browser operation failed (unsupported-capability)' });
    expect(peer.requests[0]?.command).toBe('session.environment');
  } finally { await client.close(operation()); }
});

test.each([true, false])('diagnostic evidence follows the dispatched AST, not mutation while awaiting (initially unsupported=%s)', async initiallyUnsupported => {
  const original = initiallyUnsupported ? scope(query('displayValue')) : ordinary;
  const request = { ...args(original) };
  const peer = new NativeProtocolPeer([], frame => {
    expect(frame.args['expression']).toEqual(original);
    request.expression = initiallyUnsupported ? ordinary : scope(query('displayValue'));
    return { error: 'unsupported-capability' };
  });
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('fixture.query', request, operation())).rejects.toMatchObject({ message: initiallyUnsupported ? message : 'The native browser operation failed (unsupported-capability)' });
    expect(peer.requests).toHaveLength(1);
  } finally { await client.close(operation()); }
});

test('diagnostic inspection is bounded and does not recognize malformed node kinds', () => {
  let deep = scope(query('displayValue'));
  for (let i = 0; i < 65; i++) deep = { kind: 'index', source: deep, index: 0 };
  expect(queryDiagnostic(deep)).toBeUndefined();
  let broad = scope(query('displayValue'));
  for (let i = 0; i < 12; i++) broad = { kind: 'filter', source: broad, has: broad };
  expect(queryDiagnostic(broad)).toBeUndefined();
  const cycle: { kind: 'filter'; source: LocatorExpression; has: LocatorExpression } = { kind: 'filter', source: ordinary, has: scope(query('displayValue')) };
  cycle.source = cycle;
  expect(queryDiagnostic(cycle)).toBeUndefined();
  expect(queryDiagnostic({ kind: 'unknown', source: scope(query('displayValue')) } as unknown as LocatorExpression)).toBeUndefined();
});
