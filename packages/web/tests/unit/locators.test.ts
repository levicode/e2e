/**
 * LocatorExpression projection: which compositions land on Playwright's own
 * locator chain, which ones a display-value query defers until its candidates
 * are read, and which ones the engine cannot express at all.
 */

import type { Locator as PwLocator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { LocatorExpression, TextPattern } from 'e2e/engine';
import { applyPostSteps, projectExpression as projectWith, type PostStep } from '../../src/locators.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';

/** A chain-recording stand-in for a Playwright locator. */
interface FakeLocator {
  readonly chain: readonly string[];
}

function fakeLocator(chain: readonly string[]): PwLocator {
  const self = {
    chain,
    locator: (selector: string) => fakeLocator([...chain, `locator(${selector})`]),
    getByRole: (role: string, options?: Record<string, unknown>) =>
      fakeLocator([
        ...chain,
        `role(${role}${options === undefined || Object.keys(options).length === 0 ? '' : `,${JSON.stringify(options, (_key, value: unknown) => (value instanceof RegExp ? String(value) : value))}`})`,
      ]),

    getByLabel: (text: string | RegExp, options?: { exact?: boolean }) =>
      fakeLocator([...chain, `label(${String(text)}${options?.exact ? ',exact' : ''})`]),
    getByText: (text: string | RegExp, options?: { exact?: boolean }) =>
      fakeLocator([...chain, `text(${String(text)}${options?.exact ? ',exact' : ''})`]),
    filter: (options: { hasText?: string | RegExp; has?: PwLocator; visible?: boolean }) =>
      fakeLocator([
        ...chain,
        `filter(${[
          options.hasText === undefined ? '' : `hasText=${String(options.hasText)}`,
          options.has === undefined ? '' : `has=${chainOf(options.has).join('>')}`,
          options.visible === undefined ? '' : `visible=${String(options.visible)}`,
        ]
          .filter((part) => part !== '')
          .join(',')})`,
      ]),
    first: () => fakeLocator([...chain, 'first']),
    last: () => fakeLocator([...chain, 'last']),
    nth: (index: number) => fakeLocator([...chain, `nth(${String(index)})`]),
  };
  return self as unknown as PwLocator;
}

function chainOf(locator: PwLocator): readonly string[] {
  return (locator as unknown as FakeLocator).chain;
}

const page = fakeLocator([]) as unknown as Page;

/** Projects with the default test-id attribute; the attribute itself is exercised in its own case. */
const projectExpression = (target: Page, expression: LocatorExpression) => projectWith(target, expression, 'data-testid');

/** The step every semantic query part starts from: its scope plus the closed shadow roots under it. */
const ROOTS = 'locator(e2e-roots=)';

/** The step an exact role name projects to: the name with icon-font glyphs allowed around its words. */
function exactRoleName(role: string, name: string, options = ''): string {
  return `role(${role},{${options}"name":"/^[\\\\s\\\\p{Co}]*${name}[\\\\s\\\\p{Co}]*$/u"})`;
}

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
async function expectNativeDisplayValueRefusal(expressions: readonly LocatorExpression[]) {
  const operation = () => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const });
  const peer = new NativeProtocolPeer([], () => ({ error: 'unsupported-capability' }));
  const client = await peer.connect(operation(), () => undefined);
  try {
    const channel = new EngineChannel(client);
    for (const command of ['browser.query', 'fixture.query'] as const) for (const expression of expressions) {
      await expect(channel.command(command, {
        identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]',
      }, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY', retryable: false,
        message: 'displayValue queries cannot scope child queries or serve as a has-filter in this engine',
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
async function expectNativeQueries(expressions: readonly LocatorExpression[]) {
  const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
  const node = { ref: { id: '@e1', revision: '1' }, role: 'textbox', name: 'Decoded fixture node' };
  const peer = new NativeProtocolPeer([], () => ({ data: { identityScope: 'scope', revision: '1', nodes: [node] } }));
  const client = await peer.connect(operation, () => undefined);
  const originals = expressions.map(expression => structuredClone({ identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }));
  try {
    const channel = new EngineChannel(client);
    for (const expression of expressions) {
      const result = await channel.command('browser.query', { identityScope: 'scope', expression, testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]' }, operation);
      expect(result).toEqual({ identityScope: 'scope', revision: '1', nodes: [node] });
    }
    expect(peer.requests.map(request => [request.command, request.args])).toEqual(originals.map(args => ['browser.query', args]));
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
});

describe('projectExpression', () => {
  it('projects a testId query onto the configured attribute, encoded as getByTestId encodes it', () => {
    const testId = (value: TextPattern): LocatorExpression => ({
      kind: 'query',
      query: { kind: 'testId', value },
    });
    const exact = projectWith(page, testId({ kind: 'string', value: 'save "draft"', exact: true }), 'data-qa');
    expect(chainOf(exact.locator)).toEqual([ROOTS, 'locator(internal:testid=[data-qa="save \\"draft\\""s])']);
    // A string is always an exact match, whatever `exact` says: getByTestId has no substring mode.
    const loose = projectWith(page, testId({ kind: 'string', value: 'save', exact: false }), 'data-qa');
    expect(chainOf(loose.locator)).toEqual([ROOTS, 'locator(internal:testid=[data-qa="save"s])']);
    const pattern = projectWith(page, testId({ kind: 'regexp', source: '^row-\\d+$', flags: 'i' }), 'data-test-id');
    expect(chainOf(pattern.locator)).toEqual([ROOTS, 'locator(internal:testid=[data-test-id=/^row-\\d+$/i])']);
    // An attribute with a comma is quoted, as Playwright quotes it.
    const quoted = projectWith(page, testId({ kind: 'string', value: 'x', exact: true }), 'a,b');
    expect(chainOf(quoted.locator)).toEqual([ROOTS, 'locator(internal:testid=["a,b"="x"s])']);
  });

  it('passes role states and the heading level through to getByRole', () => {
    const heading: LocatorExpression = {
      kind: 'query',
      query: {
        kind: 'role',
        value: { kind: 'string', value: 'heading', exact: true },
        name: { kind: 'string', value: 'Dashboard', exact: true },
        level: 1,
      },
    };
    expect(chainOf(projectExpression(page, heading).locator)).toEqual([ROOTS, exactRoleName('heading', 'Dashboard', '"level":1,')]);
    const checkbox: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: true, disabled: false } },
    };
    expect(chainOf(projectExpression(page, checkbox).locator)).toEqual([ROOTS, 'role(checkbox,{"checked":true,"disabled":false})']);
  });

  it('spells the contract image role as the img role the selector knows', () => {
    const image: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'image', exact: true }, name: { kind: 'string', value: 'Map', exact: true } },
    };
    expect(chainOf(projectExpression(page, image).locator)).toEqual([ROOTS, exactRoleName('img', 'Map')]);
    const tablist: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: { kind: 'string', value: 'tablist', exact: true } },
    };
    expect(chainOf(projectExpression(page, tablist).locator)).toEqual([ROOTS, 'role(tablist)']);
  });

  it('composes per-element filters onto the displayValue candidate locator', () => {
    const projected = projectExpression(page, {
      kind: 'index',
      source: { kind: 'filter', source: shared, hasText: { kind: 'string', value: 'x', exact: false }, has: textbox },
      index: 0,
    });
    expect(chainOf(projected.locator)).toEqual([
      'locator(e2e-roots=input:not([type="checkbox" i]):not([type="radio" i]), textarea, select)',
      `filter(hasText=x,has=${ROOTS}>role(textbox))`,
    ]);
    expect(projected.displayValue).not.toBeNull();
    expect(projected.steps).toEqual([{ kind: 'index', index: 0 }]);
  });

  it('defers a filter placed after a position on a displayValue query to the selected element', () => {
    const projected = projectExpression(page, {
      kind: 'filter',
      source: { kind: 'index', source: shared, index: 'first' },
      hasText: { kind: 'string', value: 'x', exact: false },
      has: textbox,
    });
    expect(chainOf(projected.locator)).toEqual(['locator(e2e-roots=input:not([type="checkbox" i]):not([type="radio" i]), textarea, select)']);
    expect(projected.steps).toHaveLength(2);
    expect(projected.steps[0]).toEqual({ kind: 'index', index: 'first' });
    const filter = projected.steps[1]!;
    expect(filter.kind).toBe('filter');
    if (filter.kind !== 'filter') return;
    expect(filter.options.hasText).toBe('x');
    expect(chainOf(filter.options.has!)).toEqual([ROOTS, 'role(textbox)']);
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

  // Run 39940386738's positional case executes last/first followed by hasText.
  // Its pinned matcher filters evaluate(source), so only selected indices enter
  // the predicate. This peer proves AST forwarding and decoding, not matching.
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
});

describe('applyPostSteps', () => {
  const matches = ['a', 'b', 'c'];
  const index = (value: 'first' | 'last' | number): PostStep => ({ kind: 'index', index: value });
  const never = () => Promise.resolve(false);

  it('runs a filter step only on the matches the steps before it selected', async () => {
    const asked: string[] = [];
    const filter: PostStep = { kind: 'filter', options: { hasText: 'x' } };
    const kept = await applyPostSteps(matches, [index('last'), filter], async (match, options) => {
      asked.push(`${match}:${String(options.hasText)}`);
      return match === 'c';
    });
    expect(kept).toEqual(['c']);
    expect(asked).toEqual(['c:x']);
    expect(await applyPostSteps(matches, [index('first'), filter], never)).toEqual([]);
  });
});
