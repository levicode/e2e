import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError, type LocatorExpression, type OperationContext, type SemanticNode } from 'e2e/engine';
import { SnapshotAdapter } from '../src/observation.ts';

const context: OperationContext = { signal: new AbortController().signal, timeoutMs: 20_000, runId: 'run', attemptId: 'attempt', origin: 'test' };
const query = (kind: 'role' | 'text' | 'testId' | 'placeholder' | 'displayValue', value: string): LocatorExpression => ({ kind: 'query', query: { kind, value: { kind: 'string', value, exact: true } } });

interface Fixture {
  snapshot: string;
  refs: Record<string, { role: string; name: string }>;
  attrs?: Record<string, Record<string, string>>;
  values?: Record<string, string>;
  boxes?: Record<string, { x: number; y: number; width: number; height: number }>;
  frames?: boolean;
  complete?: boolean;
}

/** Simulates public CLI data responses, including the batch transport's unwrapped results. */
class FakeTransport {
  readonly calls: { args: readonly string[]; sensitive: boolean }[] = [];
  paths: string[] = [];
  scoped: Fixture | undefined;
  anchored: unknown[] = [];
  readonly fixture: Fixture;
  constructor(fixture: Fixture) { this.fixture = fixture; }
  async run<T>(args: readonly string[], _context: OperationContext, options?: { mutating?: boolean; sensitive?: boolean }): Promise<T> {
    this.calls.push({ args, sensitive: options?.sensitive === true });
    if (args[0] === 'snapshot') {
      const value = args.includes('--selector') ? this.scoped ?? this.fixture : this.fixture;
      return { snapshot: value.snapshot, refs: value.refs, origin: 'https://fixture.test/', ...(value.complete === undefined ? {} : { complete: value.complete }) } as T;
    }
    if (args[0] === 'eval') {
      const script = args[1] ?? '';
      if (script.includes('width:innerWidth')) return { result: { width: 800, height: 600, frames: this.fixture.frames ?? false, location: 'https://fixture.test/' } } as T;
      if (script.includes('const selectors =')) return { result: this.anchored } as T;
      return { result: this.paths } as T;
    }
    if (args[0] === 'get' && args[1] === 'attr') {
      if (!Object.hasOwn(this.fixture.refs, args[2]?.slice(1) ?? '')) throw new EngineError('NODE_STALE', 'Element is stale', { retryable: true });
      return { value: null } as T;
    }
    if (args[0] === 'batch') {
      return args.slice(2).map((command) => {
        const [verb, key, ref, attribute] = command.split(' ');
        const id = ref?.slice(1) ?? '';
        if (verb === 'get' && key === 'attr') return { value: this.fixture.attrs?.[id]?.[attribute ?? ''] ?? null };
        if (verb === 'get' && key === 'value') return { value: this.fixture.values?.[id] ?? '' };
        if (verb === 'get' && key === 'box') return this.fixture.boxes?.[id] ?? { x: 0, y: 0, width: 40, height: 20 };
        if (verb === 'is' && key === 'visible') return { visible: true };
        if (verb === 'is' && key === 'enabled') return { enabled: true };
        throw new Error('Unexpected test command');
      }) as T;
    }
    throw new Error('Unexpected test call');
  }
}

/** Flattens the delivered semantic tree for assertions. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

const errorCode = (code: string) => (error: unknown): boolean => error instanceof EngineError && error.code === code;

test('preserves every default ref, including unnamed offscreen generic and font-icon controls', async () => {
  const transport = new FakeTransport({
    snapshot: '- button "Save" [ref=e1]\n- generic [ref=e2] clickable [cursor:pointer, onclick]\n- generic "\\uf00d" [ref=e3]\n- StaticText "Status ready"',
    refs: { e1: { role: 'button', name: 'Save' }, e2: { role: 'generic', name: '' }, e3: { role: 'generic', name: '\uf00d' }, e4: { role: 'generic', name: '' } },
    boxes: { e2: { x: 20, y: 1500, width: 20, height: 20 }, e4: { x: 20, y: 2500, width: 20, height: 20 } },
  });
  const adapter = new SnapshotAdapter(transport);
  const result = await adapter.observe(context);
  const all = nodes(result.root);
  assert.deepEqual(all.filter((node) => /:e\d+$/.test(node.ref.id)).map((node) => node.ref.id).toSorted(), ['agent-browser:e1', 'agent-browser:e2', 'agent-browser:e3', 'agent-browser:e4']);
  const offscreen = all.find((node) => node.ref.id === 'agent-browser:e2')!;
  assert.equal(offscreen.name, '');
  assert.equal(offscreen.attributes?.['agent-browser:interaction'], 'clickable');
  assert.equal(offscreen.attributes?.['agent-browser:hints'], 'cursor:pointer, onclick');
  assert.equal(offscreen.rect?.y, 1500);
  assert.equal(offscreen.states?.hidden, false);
  assert.equal(adapter.resolve(offscreen.ref), '@e2');
  assert.ok(all.some((node) => node.text === 'Status ready'));
  assert.deepEqual(transport.calls[0]?.args, ['snapshot']);
  assert.ok(transport.calls.every((call) => call.sensitive));
});

test('secure values and raw snapshot suffixes never enter the tree or get-value calls', async () => {
  const transport = new FakeTransport({
    snapshot: '- textbox "Password" [ref=e1]: TOP_SECRET\n  - StaticText "TOP_SECRET"\n- textbox "User" [ref=e2]: raw-untrusted-value',
    refs: { e1: { role: 'textbox', name: 'Password' }, e2: { role: 'textbox', name: 'User' } },
    attrs: { e1: { type: 'password', autocomplete: 'current-password' }, e2: { type: 'text', autocomplete: 'username' } },
    values: { e1: 'TOP_SECRET', e2: 'alice' },
  });
  const result = await new SnapshotAdapter(transport).observe(context);
  const all = nodes(result.root);
  const password = all.find((node) => node.ref.id === 'agent-browser:e1')!;
  assert.equal(password.states?.secure, true);
  assert.equal(password.inputPurpose, 'password');
  assert.equal(password.value, undefined);
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
  assert.ok(!JSON.stringify(result).includes('raw-untrusted-value'));
  assert.ok(!transport.calls.flatMap((call) => call.args).includes('get value @e1'));
  assert.equal(all.find((node) => node.ref.id === 'agent-browser:e2')?.value, 'alice');
});

test('only latest element revision resolves, but root id remains stable across invalidation', async () => {
  const adapter = new SnapshotAdapter(new FakeTransport({ snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } }));
  const first = await adapter.observe(context);
  const second = await adapter.observe(context);
  assert.equal(first.root.ref.id, second.root.ref.id);
  assert.notEqual(first.root.ref.revision, second.root.ref.revision);
  assert.throws(() => adapter.resolve(first.root.children![0]!.ref), errorCode('NODE_STALE'));
  assert.equal(adapter.resolve(second.root.children![0]!.ref), '@e1');
  adapter.invalidate();
  assert.equal(adapter.isRoot(first.root.ref), true);
  assert.equal(adapter.resolve(first.root.ref), 'html');
  assert.throws(() => adapter.resolve(second.root.children![0]!.ref), errorCode('NODE_STALE'));
});

test('semantic AST retains hierarchy, text assertions, attributes, states and levels', async () => {
  const adapter = new SnapshotAdapter(new FakeTransport({
    snapshot: '- group "Settings" [ref=e1]\n  - heading "Preferences" [level=2, ref=e2]\n  - checkbox "Email" [checked=true, ref=e3]\n  - textbox "Name" [ref=e4]\n  - StaticText "Saved"',
    refs: { e1: { role: 'group', name: 'Settings' }, e2: { role: 'heading', name: 'Preferences' }, e3: { role: 'checkbox', name: 'Email' }, e4: { role: 'textbox', name: 'Name' } },
    attrs: { e4: { placeholder: 'Full name' } }, values: { e4: 'Alice' },
  }));
  assert.equal((await adapter.locate(query('text', 'Saved'), context)).length, 1);
  const scoped: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'checkbox', exact: true }, states: { checked: true } }, scope: query('role', 'group') };
  assert.equal((await adapter.locate(scoped, context)).length, 1);
  assert.equal((await adapter.locate(query('placeholder', 'Full name'), context)).length, 1);
  assert.equal((await adapter.locate(query('displayValue', 'Alice'), context)).length, 1);
  const headings = await adapter.locate({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, level: 2 } }, context);
  assert.equal(headings.length, 1);
});

test('safe unique anchors provide replay selectors, focus, and selected text', async () => {
  const transport = new FakeTransport({ snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: 'textbox', name: 'Name' } }, attrs: { e1: { id: 'name', 'data-testid': 'user-name', type: 'text' } }, values: { e1: 'Alice' } });
  transport.anchored = [{ focused: true, secure: false, selection: 'Ali' }];
  const snapshot = await new SnapshotAdapter(transport).observe(context);
  const node = snapshot.root.children![0]!;
  assert.equal(node.selector, '[id="name"]');
  assert.equal(node.testId, 'user-name');
  assert.equal(node.states?.focused, true);
  assert.equal(node.selection, 'Ali');
  transport.anchored = [null];
  assert.equal((await new SnapshotAdapter(transport).observe(context)).root.children![0]!.selector, undefined);
});

test('CSS selectors bind the rendered target ref without selecting a descendant', async () => {
  const fixture = { snapshot: '- button "Save" [ref=e1]\n- button "Other" [ref=e2]', refs: { e1: { role: 'button', name: 'Save' }, e2: { role: 'button', name: 'Other' } } };
  const transport = new FakeTransport(fixture);
  transport.paths = ['html:nth-child(1) > body:nth-child(2) > button:nth-child(1)'];
  transport.scoped = { ...fixture, snapshot: '- button "Save" [ref=e1]' };
  const result = await new SnapshotAdapter(transport).locate({ kind: 'selector', selector: '#save' }, context);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.ref.id, 'agent-browser:e1');
  transport.scoped = { ...fixture, snapshot: '- generic\n  - button "Save" [ref=e1]' };
  await assert.rejects(new SnapshotAdapter(transport).locate({ kind: 'selector', selector: '#container' }, context), errorCode('UNSUPPORTED_CAPABILITY'));
});

test('frames are visibly incomplete and frame locators explicitly unsupported', async () => {
  const transport = new FakeTransport({ snapshot: '- Iframe "Child" [ref=e1]\n  - button "Inner" [ref=e2]', refs: { e1: { role: 'Iframe', name: 'Child' }, e2: { role: 'button', name: 'Inner' } }, frames: true });
  const adapter = new SnapshotAdapter(transport);
  const snapshot = await adapter.observe(context);
  assert.equal(snapshot.truncated, true);
  assert.equal(nodes(snapshot.root).find((node) => node.ref.id === 'agent-browser:e2')?.rect, undefined);
  assert.equal((await adapter.locate(query('role', 'button'), context)).length, 0);
  await assert.rejects(adapter.locate({ kind: 'frame', selector: 'iframe', source: query('role', 'button') }, context), errorCode('UNSUPPORTED_CAPABILITY'));
});

test('pre-action verification uses exact-ref reads without resetting the imported ref map', async () => {
  const transport = new FakeTransport({ snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } });
  const adapter = new SnapshotAdapter(transport);
  const snapshot = await adapter.observe(context);
  transport.fixture.snapshot = '- button "Save" [ref=e2]';
  transport.fixture.refs = { e2: { role: 'button', name: 'Save' } };
  await assert.rejects(adapter.verify(snapshot.root.children![0]!.ref, context), errorCode('NODE_STALE'));
  assert.deepEqual(transport.calls.at(-1)?.args, ['get', 'attr', '@e1', 'id']);
});


test('authoritative metadata callback preserves native identity and scrubs secure descendants', async () => {
  const transport = new FakeTransport({ snapshot: '- textbox "Password" [ref=e1]\n  - StaticText "secret-child"', refs: { e1: { role: 'textbox', name: 'Password' } } });
  let nativeRefs: unknown;
  const adapter = new SnapshotAdapter(transport, { readMetadata: async (refs) => {
    nativeRefs = refs;
    return { e1: { name: 'Password', inputPurpose: 'password', states: { secure: true }, value: 'secret-value', attributes: { value: 'secret-attribute', type: 'password' } } };
  } });
  const snapshot = await adapter.observe(context);
  assert.deepEqual(nativeRefs, transport.fixture.refs);
  assert.equal(nodes(snapshot.root).find((node) => node.ref.id === 'agent-browser:e1')?.inputPurpose, 'password');
  assert.ok(!JSON.stringify(snapshot).includes('secret-'));
  assert.ok(!transport.calls.some((call) => call.args[0] === 'batch'));
});

test('adopt shares the same revision space for publicly imported exact refs', async () => {
  const transport = new FakeTransport({ snapshot: '(empty page)', refs: {} });
  const adapter = new SnapshotAdapter(transport);
  const [first] = adapter.adopt([{ nativeRef: 'e100', node: { role: 'textbox', name: 'Imported', states: { secure: true }, value: 'never-keep' } }]);
  assert.equal(adapter.resolve(first!.ref), '@e100');
  assert.equal(first!.value, undefined);
  const [second] = adapter.adopt([{ nativeRef: 'e101', node: { role: 'button', name: 'Next' } }]);
  assert.equal(adapter.resolve(second!.ref), '@e101');
  assert.throws(() => adapter.resolve(first!.ref), errorCode('NODE_STALE'));
});

test('traceSnapshot returns only the cached sanitized observation without resetting adopted refs', async () => {
  const transport = new FakeTransport({ snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } });
  const adapter = new SnapshotAdapter(transport);
  assert.equal(adapter.traceSnapshot(), undefined);
  const snapshot = await adapter.observe(context);
  const before = transport.calls.length;
  assert.equal(adapter.traceSnapshot(), snapshot);
  const [adopted] = adapter.adopt([{ nativeRef: 'e2', node: { role: 'button', name: 'Next' } }]);
  assert.equal(adapter.traceSnapshot(), undefined);
  assert.equal(transport.calls.length, before);
  assert.equal(adapter.resolve(adopted!.ref), '@e2');
});

test('trace-only adapters use public preserve mode and a separate revision namespace', async () => {
  const transport = new FakeTransport({ snapshot: '- button "Save" [ref=e1]', refs: { e1: { role: 'button', name: 'Save' } } });
  const active = new SnapshotAdapter(transport);
  const initial = await active.observe(context);
  const trace = new SnapshotAdapter(transport, { preserveRefs: true, snapshotArgs: async () => ['--allowed-frame-documents', '{"frame":"loader"}'] });
  const snapshot = await trace.observe(context);
  assert.ok(transport.calls.some(call => call.args.join(' ') === 'snapshot --preserve-refs --allowed-frame-documents {"frame":"loader"}'));
  assert.equal(active.resolve(initial.root.children![0]!.ref), '@e1');
  assert.notEqual(snapshot.root.ref.revision, initial.root.ref.revision);
  assert.throws(() => active.resolve(snapshot.root.children![0]!.ref), errorCode('NODE_STALE'));
});


test('recursive native completeness is authoritative while an explicit partial capture remains truncated', async () => {
  const transport = new FakeTransport({ snapshot: '- Iframe "Child" [ref=e1]', refs: { e1: { role: 'Iframe', name: 'Child' } }, frames: true, complete: true });
  const adapter = new SnapshotAdapter(transport);
  assert.equal((await adapter.observe(context)).truncated, false);
  transport.fixture.complete = false;
  transport.fixture.frames = false;
  assert.equal((await adapter.observe(context)).truncated, true);
});
