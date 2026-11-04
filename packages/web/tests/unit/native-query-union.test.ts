import { describe, expect, it } from 'vitest';
import type { LocatorExpression, OperationContext } from 'e2e/engine';
import { QUERY_UNION_CAPABILITY, REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import type { EngineCommandMap } from '../../src/native/engine-contract.ts';
import { queryDiagnostic, queryUsesUnion } from '../../src/native/query-diagnostic.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'union', attemptId: 'union', origin: 'test' });
const terminal: LocatorExpression = { kind: 'selector', selector: 'button' };
const label: LocatorExpression = { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Name', exact: true } } };
const displayValue: LocatorExpression = { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'value', exact: true } } };
const union = (left: LocatorExpression = terminal, right: LocatorExpression = label): LocatorExpression => ({ kind: 'union', left, right });
const args = (expression: LocatorExpression): EngineCommandMap['browser.query']['args'] => ({ identityScope: 'scope', expression,
  testIdAttribute: 'data-testid', secureFieldSelector: 'input[type=password]' });
const commands = ['browser.query', 'fixture.query', 'fixture.read-fields'] as const;
const requestArgs = (command: typeof commands[number], expression: LocatorExpression) => ({
  ...args(expression), ...(command === 'fixture.read-fields' ? { fields: ['value'] as const } : {}),
});
const expressions: readonly LocatorExpression[] = [
  union(),
  { kind: 'index', source: union(), index: 'first' },
  { kind: 'frame', selector: '#frame', source: union() },
  { ...label, scope: union() },
  { kind: 'filter', source: terminal, has: union() },
  { kind: 'filter', source: union(), has: label },
  union(union(), terminal),
  union(terminal, union()),
];

for (const command of commands) {
  it(`${command} refuses nested unions on an older runtime without dispatch or invalidation`, async () => {
    const peer = new NativeProtocolPeer([], () => ({ data: command === 'fixture.read-fields'
      ? { identityScope: 'scope', values: [] } : { identityScope: 'scope', revision: '1', nodes: [] } }));
    const client = await peer.connect(operation(), () => {});
    try {
      const channel = new EngineChannel(client);
      for (const expression of expressions) {
        await expect(channel.command(command, requestArgs(command, expression), operation())).rejects.toMatchObject({
          code: 'UNSUPPORTED_CAPABILITY', retryable: false,
          message: `Locator unions require ${QUERY_UNION_CAPABILITY}; update the native agent-browser runtime`,
        });
      }
      expect(peer.requests).toHaveLength(0);
      await expect(channel.command(command, requestArgs(command, terminal), operation())).resolves.toHaveProperty('identityScope', 'scope');
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]?.args['expression']).toEqual(terminal);
    } finally { await client.close(operation()); }
  });

  it(`${command} forwards the exact union AST only after validated optional negotiation`, async () => {
    const peer = new NativeProtocolPeer([QUERY_UNION_CAPABILITY], () => ({ data: command === 'fixture.read-fields'
      ? { identityScope: 'scope', values: [] } : { identityScope: 'scope', revision: '1', nodes: [] } }));
    const client = await peer.connect(operation(), () => {});
    try {
      const channel = new EngineChannel(client);
      for (const expression of expressions) {
        const request = requestArgs(command, expression);
        const original = structuredClone(request);
        await channel.command(command, request, operation());
        expect(peer.requests.at(-1)).toMatchObject({ command, args: original });
      }
      expect(peer.requests).toHaveLength(expressions.length);
      expect(client.negotiation().protocol).toBe('agent-browser-session/1');
    } finally { await client.close(operation()); }
  });

  it(`${command} maps native displayValue union refusals through the existing diagnostic`, async () => {
    const peer = new NativeProtocolPeer([QUERY_UNION_CAPABILITY], () => ({ error: 'unsupported-capability' }));
    const client = await peer.connect(operation(), () => {});
    try {
      for (const expression of [union(displayValue), union(terminal, displayValue)]) {
        await expect(new EngineChannel(client).command(command, requestArgs(command, expression), operation())).rejects.toMatchObject({
          code: 'UNSUPPORTED_CAPABILITY', retryable: false,
          message: 'displayValue queries cannot scope child queries, serve as a has-filter, or form a union in this engine',
        });
      }
      expect(peer.requests).toHaveLength(2);
    } finally { await client.close(operation()); }
  });
}

describe('bounded union feature evidence', () => {
  it('keeps union optional and ignores query text and non-expression metadata', () => {
    expect(REQUIRED_CAPABILITIES).not.toContain(QUERY_UNION_CAPABILITY);
    expect(queryUsesUnion({ kind: 'selector', selector: '[kind="union"]' })).toBe(false);
    expect(queryUsesUnion({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'union', exact: true } } })).toBe(false);
    expect(queryUsesUnion({ ...terminal, metadata: union() } as LocatorExpression)).toBe(false);
  });

  it('cannot report absence after malformed traversal, a cycle, depth, or node exhaustion', async () => {
    let deep: LocatorExpression = union();
    for (let i = 0; i < 65; i++) deep = { kind: 'index', index: 0, source: deep };
    let broad: LocatorExpression = terminal;
    for (let i = 0; i < 12; i++) broad = { kind: 'filter', source: broad, has: broad };
    const cycle: { kind: 'filter'; source: LocatorExpression } = { kind: 'filter', source: terminal };
    cycle.source = cycle;
    const invalid = [null, [], {}, { kind: 'unknown' }, { kind: 'filter' }, { kind: 'query', scope: null }, deep, broad, cycle];
    const peer = new NativeProtocolPeer([], () => ({ data: { identityScope: 'scope', revision: '1', nodes: [] } }));
    const client = await peer.connect(operation(), () => {});
    try {
      const channel = new EngineChannel(client);
      for (const expression of invalid) {
        expect(queryUsesUnion(expression as LocatorExpression)).toBeUndefined();
        await expect(channel.command('browser.query', args(expression as LocatorExpression), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      }
      expect(peer.requests).toHaveLength(0);
      await channel.command('browser.query', args(terminal), operation());
      expect(peer.requests).toHaveLength(1);
    } finally { await client.close(operation()); }
  });

  it('does not let unexpected expression edges conceal a union from an older runtime', () => {
    for (const key of ['source', 'scope', 'has', 'left', 'right']) {
      expect(queryUsesUnion({ ...terminal, [key]: union() } as LocatorExpression)).toBe(true);
    }
  });
});

describe('native union composition diagnostics', () => {
  it('recognizes terminal displayValue provenance in either branch through refinements', () => {
    const refinements: readonly LocatorExpression[] = [displayValue,
      { kind: 'index', index: 'first', source: displayValue },
      { kind: 'filter', source: displayValue, has: label },
      { kind: 'frame', selector: '#frame', source: displayValue },
    ];
    for (const expression of refinements) {
      expect(queryDiagnostic(union(expression))).toBe('display-value-composition');
      expect(queryDiagnostic(union(terminal, expression))).toBe('display-value-composition');
    }
    expect(queryDiagnostic(union(union(displayValue)))).toBe('display-value-composition');
    expect(queryDiagnostic(union({ ...label, scope: displayValue }))).toBe('display-value-composition');
  });

  it('treats ordinary and exact-label unions as plain composable expressions', () => {
    expect(queryDiagnostic(union())).toBeUndefined();
    expect(queryDiagnostic({ ...label, scope: union() })).toBeUndefined();
    expect(queryDiagnostic({ kind: 'filter', source: label, has: union() })).toBeUndefined();
  });
});

it('leaves malformed AST admission to a runtime that negotiated union support', async () => {
  const peer = new NativeProtocolPeer([QUERY_UNION_CAPABILITY], () => ({ error: 'invalid-arguments' }));
  const client = await peer.connect(operation(), () => {});
  const expression = { kind: 'filter', source: null } as unknown as LocatorExpression;
  try {
    await expect(new EngineChannel(client).command('browser.query', args(expression), operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0]?.args['expression']).toEqual(expression);
    expect(client.negotiation().capabilities).toContain(QUERY_UNION_CAPABILITY);
  } finally { await client.close(operation()); }
});

it('does not mistake caller metadata for validated negotiation evidence', async () => {
  const peer = new NativeProtocolPeer([], () => ({ data: { identityScope: 'scope', revision: '1', nodes: [] } }));
  const client = await peer.connect(operation(), () => {});
  try {
    const request = { ...args(union()), capabilities: [QUERY_UNION_CAPABILITY] };
    const channel = new EngineChannel(client);
    await expect(channel.command('browser.query', request, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', retryable: false });
    expect(peer.requests).toHaveLength(0);
    await expect(channel.command('browser.query', args(terminal), operation())).resolves.toMatchObject({ nodes: [] });
    expect(peer.requests).toHaveLength(1);
  } finally { await client.close(operation()); }
});
