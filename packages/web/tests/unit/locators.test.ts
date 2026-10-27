/**
 * Original locator contracts forwarded through the native client. Producer
 * matching, attribute reads and composition admission have separate exact
 * source-bound witnesses; these protocol peers are not browser implementations.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from 'e2e/engine';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { QUERY_UNION_CAPABILITY } from '../../src/native/capabilities.ts';
import { frameQuerySnapshot } from '../../src/native/query-diagnostic.ts';
import { isNativeNotDispatched } from '../../src/native/browser-channel.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';

const shared: LocatorExpression = {
  kind: 'query',
  query: { kind: 'displayValue', value: { kind: 'string', value: 'shared', exact: true } },
};
const textbox: LocatorExpression = {
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } },
};

// Admission is native-owned. CI26 composition_tests and composition_tests::
// unsupported_composition_never_dispatches_cdp_or_stages_references execute the
// producer refusal; this helper checks only the actual client's error mapping.
async function expectNativeDisplayValueRefusal(expressions: readonly LocatorExpression[], capabilities: readonly string[] = []) {
  const operation = () => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const });
  const peer = new NativeProtocolPeer(capabilities, () => ({ error: 'unsupported-capability' }));
  const client = await peer.connect(operation(), () => undefined);
  try {
    const channel = new EngineChannel(client);
    for (const command of ['browser.query', 'fixture.query'] as const) for (const expression of expressions) {
      await expect(channel.command(command, {
        identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]',
      }, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY', retryable: false,
        message: 'displayValue queries cannot scope child queries, serve as a has-filter, or form a union in this engine',
      });
    }
    expect(peer.requests.map(request => [request.command, request.args['expression']])).toEqual(
      ['browser.query', 'fixture.query'].flatMap(command => expressions.map(expression => [command, expression])),
    );
  } finally { await client.close(operation()); }
}

describe('native displayValue refusals', () => {
  it('rejects a displayValue query as a scope or has-filter, and names only those cases', async () => {
    await expectNativeDisplayValueRefusal([
      { ...textbox, scope: shared } as LocatorExpression,
      { kind: 'filter', source: textbox, has: shared },
    ]);
  });

  it('still rejects a displayValue has-filter after a position', async () => {
    await expectNativeDisplayValueRefusal([
      { kind: 'filter', source: { kind: 'index', source: textbox, index: 'first' }, has: shared },
    ]);
  });
});

// Matching is bound to run 39940386738's label-composition and lifecycle cases.
// Every expression receives the same transport fixture; this helper has no matcher.
async function expectNativeQueries(expressions: readonly LocatorExpression[], testIdAttribute = 'data-testid', capabilities: readonly string[] = []) {
  const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
  const node = { ref: { id: '@e1', revision: '1' }, role: 'textbox', name: 'Decoded fixture node' };
  const peer = new NativeProtocolPeer(capabilities, () => ({ data: { identityScope: 'scope', revision: '1', nodes: [node] } }));
  const client = await peer.connect(operation, () => undefined);
  const originals = expressions.map(expression => structuredClone({ identityScope: 'scope', expression, testIdAttribute, secureFieldSelector: 'input[type="password" i]' }));
  try {
    const channel = new EngineChannel(client);
    for (const expression of expressions) {
      const result = await channel.command('browser.query', { identityScope: 'scope', expression, testIdAttribute, secureFieldSelector: 'input[type="password" i]' }, operation);
      expect(result).toEqual({ identityScope: 'scope', revision: '1', nodes: [node] });
    }
    expect(peer.requests.map(request => [request.command, request.args])).toEqual(originals.map(args => ['browser.query', args]));
    expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual(expressions.map(() => 1000));
  } finally { await client.close(operation); }
}

describe('native query forwarding', () => {
  it('projects an exact label query onto the label engine with a label predicate, and composes exactly', async () => {
    const label: LocatorExpression = { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Display name', exact: true } } };
    const firstLabel: LocatorExpression = { kind: 'index', source: label, index: 'first' };
    await expectNativeQueries([
      label,
      firstLabel,
      { ...textbox, scope: firstLabel } as LocatorExpression,
      { kind: 'filter', source: textbox, has: label },
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Display', exact: false } } },
    ]);
  });

  it('narrows a visible query inside the selector for every kind, CSS candidates included', async () => {
    const visibleLabel: LocatorExpression = { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Display name', exact: true }, visible: true } };
    await expectNativeQueries([
      visibleLabel,
      { kind: 'filter', source: textbox, has: visibleLabel },
      { kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: 'ada', exact: true }, visible: true } },
      { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Save', exact: true }, visible: true } },
    ]);
  });

  it('defers positions on a displayValue query until its candidates are value-filtered', async () => {
    await expectNativeQueries([{ kind: 'index', source: { kind: 'index', source: shared, index: 'last' }, index: 'first' }]);
  });

  // The source-bound native MATCH_QUERY Node fixture exercises both predicates
  // before/after index with different matching candidates. This peer preserves
  // the exact old ASTs and budget only; it does not implement matching.
  it('composes per-element filters onto the displayValue candidate locator', async () => {
    await expectNativeQueries([{
      kind: 'index',
      source: { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'x', exact: false }, has: textbox },
      index: 0,
    }]);
  });

  it('defers a filter placed after a position on a displayValue query to the selected element', async () => {
    await expectNativeQueries([{
      kind: 'filter',
      source: { kind: 'index', source: shared, index: 'first' },
      hasText: { kind: 'string', value: 'x', exact: false },
      has: textbox,
    }]);
  });
});

// Exact production METADATA/MATCH_QUERY scripts have a browser-free fixture
// for all original values below. Rust producer tests separately preserve
// explicit false states, public glyph normalization, and authored img -> image.
describe('native semantic query projection', () => {
  it('projects a testId query onto the configured attribute, encoded as getByTestId encodes it', async () => {
    const testId = (value: TextPattern): LocatorExpression => ({ kind: 'query', query: { kind: 'testId', value } });
    await expectNativeQueries([
      testId({ kind: 'string', value: 'save "draft"', exact: true }),
      testId({ kind: 'string', value: 'save', exact: false }),
    ], 'data-qa');
    await expectNativeQueries([testId({ kind: 'regexp', source: '^row-\\d+$', flags: 'i' })], 'data-test-id');
    await expectNativeQueries([testId({ kind: 'string', value: 'x', exact: true })], 'a,b');
  });

  it('passes role states and the heading level through to getByRole', async () => {
    await expectNativeQueries([
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true },
        name: { kind: 'string', value: 'Dashboard', exact: true }, level: 1 } },
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true },
        states: { checked: true, disabled: false } } },
    ]);
  });

  it('spells the contract image role as the img role the selector knows', async () => {
    await expectNativeQueries([
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'image', exact: true },
        name: { kind: 'string', value: 'Map', exact: true } } },
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'tablist', exact: true } } },
    ]);
  });
});

// Run 39940386738's real-native lifecycle positional query case checks the
// matching results. This peer checks unchanged AST order and result decoding;
// it contains no matcher and its reply alone is not native matching proof.
describe('native positional forwarding', () => {
  type IndexStep = Pick<Extract<LocatorExpression, { kind: 'index' }>, 'kind' | 'index'>;
  it.each([
    [[{ kind: 'index', index: 3 }], []],
    [[{ kind: 'index', index: 'last' }, { kind: 'index', index: 'first' }], ['c']],
    [[], ['a', 'b', 'c']],
  ] as const satisfies readonly (readonly [readonly IndexStep[], readonly string[]])[])(
    'applies %j to yield %j',
    async (steps, expected) => {
      let expression: LocatorExpression = shared;
      for (const step of steps) expression = { kind: 'index', source: expression, index: step.index };
      const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
      const peer = new NativeProtocolPeer([], () => ({ data: {
        identityScope: 'scope', revision: '1',
        nodes: expected.map((name, offset) => ({ ref: { id: `@e${offset + 1}`, revision: '1' }, role: 'textbox', name, value: 'shared' })),
      } }));
      const client = await peer.connect(operation, () => undefined);
      try {
        const args = { identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' };
        const original = structuredClone(args);
        const result = await new EngineChannel(client).command('browser.query', args, operation);
        expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.query', original]]);
        expect(result.nodes.map(node => node.name)).toEqual(expected);
      } finally { await client.close(operation); }
    },
  );

  // The native MATCH_QUERY Node fixture checks last/first followed by hasText
  // and the exact candidate text-access trace. Eager filtering must fail that
  // witness even if returned matches stay unchanged. This peer checks only AST
  // forwarding, budget and decoding, not matcher execution.
  it('runs a filter step only on the matches the steps before it selected', async () => {
    const cases = [['last', ['c']], ['first', []]] as const;
    const replies = cases.map(([, names]) => ({
      identityScope: 'scope', revision: '1',
      nodes: names.map(name => ({ ref: { id: '@e1', revision: '1' }, role: 'textbox', name, value: 'shared' })),
    }));
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ data: replies.shift()! }));
    const client = await peer.connect(operation, () => undefined);
    const originals = cases.map(([index]) => ({
      identityScope: 'scope',
      expression: { kind: 'filter', source: { kind: 'index', source: shared, index }, hasText: { kind: 'string', value: 'x', exact: false } },
      testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]',
    } as const));
    try {
      const channel = new EngineChannel(client);
      for (const [offset, [, expected]] of cases.entries()) {
        const args = structuredClone(originals[offset]!);
        const result = await channel.command('browser.query', args, operation);
        expect(result.nodes.map(node => node.name)).toEqual(expected);
      }
      expect(peer.requests.map(request => [request.command, request.args])).toEqual(originals.map(args => ['browser.query', args]));
      expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual([1000, 1000]);
    } finally { await client.close(operation); }
  });

  // The additional upstream union case is outside the original 93. Native
  // admission tests refuse displayValue unions; MATCH_QUERY owns ordered union.
  it('projects a union onto Playwright or, and rejects a displayValue branch', async () => {
    const button: LocatorExpression = {
      kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } },
    };
    await expectNativeQueries([{ kind: 'union', left: textbox, right: button }], 'data-testid', [QUERY_UNION_CAPABILITY]);
    await expectNativeDisplayValueRefusal([{ kind: 'union', left: shared, right: textbox }], [QUERY_UNION_CAPABILITY]);
  });

});

// Latest-upstream cases outside the original 93-case inventory. Native run
// 40125273477 executes union_frame_paths_are_exact_and_stripped_before_matching;
// it owns native outer-to-inner splitting and cross-document admission. These
// assertions exercise only diagnostic snapshots and native adapter refusals.
describe('native frame expression projection', () => {
  const inFrame = (selector: string): LocatorExpression => ({ kind: 'frame', selector, source: textbox });

  it('lists the frames along an expression, outermost first', () => {
    expect(frameQuerySnapshot({ kind: 'frame', selector: '#outer', source: inFrame('#inner') })).toEqual(['#outer', '#inner']);
    expect(frameQuerySnapshot({ kind: 'union', left: inFrame('#left'), right: inFrame('#left') })).toEqual(['#left']);
  });

  it('rejects a union whose branches live in different documents', async () => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([QUERY_UNION_CAPABILITY], () => ({ error: 'unsupported-capability' }));
    const client = await peer.connect(operation, () => undefined);
    const originals = [inFrame('#right'), textbox].map(right => ({
      identityScope: 'scope', expression: { kind: 'union', left: inFrame('#left'), right } as LocatorExpression,
      testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]',
    }));
    try {
      for (const args of originals) {
        const failure = await new EngineChannel(client).command('browser.query', structuredClone(args), operation).catch((cause: unknown) => cause);
        expect(failure).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', retryable: false,
          message: 'The native browser operation failed (unsupported-capability)' });
        expect(isNativeNotDispatched(failure)).toBe(true);
        expect(frameQuerySnapshot(args.expression)).toBeUndefined();
      }
      expect(peer.requests.map(request => [request.command, request.args])).toEqual(originals.map(args => ['browser.query', args]));
      expect(peer.frames.filter(frame => frame['type'] === 'request').map(frame => frame['timeoutMs'])).toEqual([1000, 1000]);
      expect(client.negotiation().capabilities).toContain(QUERY_UNION_CAPABILITY);
    } finally { await client.close(operation); }
  });
});
