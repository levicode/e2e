/** Real-browser parity gate. No skips: CI must supply the exact-ref public CLI binary. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { LocatorExpression, OperationContext, SemanticNode } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium, type OwnedBrowser } from '../src/launch.ts';
import { LocatorCompanion } from '../src/locators.ts';
import { NetworkHub } from '../src/network.ts';
import { SnapshotAdapter, type SnapshotRef } from '../src/observation.ts';
import { CliTransport } from '../src/transport.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 25_000, runId: 'locator-integration', attemptId: 'one', origin: 'test' });
const string = (value: string) => ({ kind: 'string' as const, value, exact: true });
const selector = (value: string): LocatorExpression => ({ kind: 'selector', selector: value });
const role = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'role', value: string(value) } });
const flatten = (node: SemanticNode): SemanticNode[] => [node, ...(node.children ?? []).flatMap(flatten)];

/** The fixture includes AX-silent nodes, label aliases, closed shadow roots and two iframe levels. */
async function withLocators(run: (fixture: {
  cli: CliTransport; cdp: CdpConnection; session: string; companion: LocatorCompanion; adapter: SnapshotAdapter;
  createCompanion: (allowFrameUrl?: (url: string) => boolean) => LocatorCompanion;
}) => Promise<void>, initialPath = '/'): Promise<void> {
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'A reviewed exact-ref binary is required; do not skip the browser gate');
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/glyph') {
      response.end(`<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0}.font-icon{width:40px;height:40px;cursor:pointer;background:#ddd}
        .font-icon::before{content:'\\e000';font-family:Arial}
        </style><p>waiting</p><div style="height:1800px"></div><div id="glyph" class="font-icon"></div>
        <script>window.clicks=0;document.getElementById('glyph').addEventListener('click',()=>window.clicks++)</script>`);
    } else if (path === '/grand') {
      response.end('<!doctype html><body style="margin:0"><button id="deep" style="position:absolute;left:7px;top:9px;width:80px;height:25px">Deep save</button>');
    } else if (path === '/child') {
      response.end(`<!doctype html><body style="margin:0"><p>${request.headers.host?.startsWith('localhost:') ? 'Foreign-only static text' : 'Same-only static text'}</p><div id="panel"><button class="choice">First choice</button><button class="choice">Second choice</button></div><iframe id="inner" src="/grand" style="position:absolute;left:10px;top:80px;width:200px;height:100px;border:2px solid"></iframe><div id="child-host"></div><script>document.querySelector('#child-host').attachShadow({mode:'closed'}).innerHTML='<button id="child-shadow">Child shadow</button>'</script>`);
    } else {
      response.end(`<!doctype html><title>Locator fixture</title><body style="margin:0">
        <label for="name">Primary label</label><label for="name">Alternate label</label><input id="name" class="editable" value="Alice">
        <input id="otp" autocomplete="one-time-code" value="123456"><input id="password" type="password" value="FIXTURE_PASSWORD" data-private="FIXTURE_ATTRIBUTE">
        <input id="enabled" type="checkbox" checked><input id="disabled" type="checkbox"><h2>Section</h2>
        <div id="plain" class="assertion-only">Plain noninteractive text</div>
        <button id="first">Save first</button><button id="second">Save second</button><button style="display:none">Hidden</button>
        <a href="/next?token=FIXTURE_QUERY#FIXTURE_FRAGMENT">Continue</a><div id="host"></div>
        <iframe id="same" src="/child" style="position:absolute;left:40px;top:250px;width:400px;height:250px;border:3px solid"></iframe>
        <iframe id="cross" src="http://localhost:${port}/child" style="position:absolute;left:500px;top:250px;width:400px;height:250px;border:4px solid"></iframe>
        <script>window.closedClicks=0;const root=document.querySelector('#host').attachShadow({mode:'closed'});root.innerHTML='<button id="closed">Closed action</button>';root.querySelector('button').addEventListener('click',()=>window.closedClicks++);</script>`);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  port = (server.address() as AddressInfo).port;
  let browser: OwnedBrowser | undefined; let cdp: CdpConnection | undefined; let cli: CliTransport | undefined; let hub: NetworkHub | undefined;
  try {
    browser = await launchChromium({ executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env: process.env, args: ['--site-per-process', ...(process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] }, operation());
    cdp = await CdpConnection.connect(browser.endpoint, operation());
    const initial = (await cdp.listTargets(operation())).find(target => target.type === 'page');
    assert.ok(initial, 'The exclusively owned Chromium must expose its initial page');
    cli = new CliTransport({ executable: process.env.E2E_AGENT_BROWSER_EXECUTABLE, cdp: browser.endpoint, cdpTarget: initial.targetId, cdpContext: null });
    await cli.run(['open', `http://127.0.0.1:${port}${initialPath}`, '--wait-until', 'load'], operation(), { mutating: true });
    const { tabs } = await cli.run<{ tabs: { targetId: string; active: boolean }[] }>(['tab', 'list'], operation());
    const active = tabs.find((tab) => tab.active); assert.ok(active);
    hub = new NetworkHub(cdp, { operation, resolveUrl: value => new URL(value, `http://127.0.0.1:${port}`).href, resolvePath: value => value });
    await hub.start(operation()); const session = await hub.useTarget(active.targetId, operation());
    const createCompanion = (allowFrameUrl?: (url: string) => boolean) => new LocatorCompanion({ cdp: () => cdp!, session: () => session, transport: () => cli!, frameSession: (id, context) => hub!.sessionForTarget(id, context), ...(allowFrameUrl ? { allowFrameUrl } : {}) });
    const companion = createCompanion();
    const adapter = new SnapshotAdapter(cli, { readMetadata: (refs, context) => companion.readMetadata(refs, context) });
    await run({ cli, cdp, session, companion, adapter, createCompanion });
  } finally {
    hub?.close(); cdp?.close();
    try { await cli?.close(operation()); } finally { await browser?.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
  }
}

test('unnamed icon smoke retains the native default snapshot ref and clicks it exactly once without a locator', { timeout: 120_000 }, async () => {
  await withLocators(async ({ cli, adapter }) => {
    const native = await cli.run<{ snapshot: string; refs: Record<string, SnapshotRef> }>(['snapshot'], operation());
    const clickableLines = native.snapshot.split('\n').filter(line => line.includes('clickable [cursor:pointer]'));
    assert.equal(clickableLines.length, 1, 'The unfiltered public snapshot must expose the cursor-only font icon');
    const nativeId = /\[ref=(e\d+)\]/.exec(clickableLines[0]!)?.[1];
    assert.ok(nativeId, 'The native cursor hint must carry an actionable default ref');
    assert.equal(native.refs[nativeId]?.name, '');
    assert.equal(native.refs[nativeId]?.role, 'generic');
    assert.equal(typeof native.refs[nativeId]?.backendNodeId, 'number');
    assert.equal((await cli.run<{ value: string }>(['get', 'attr', `@${nativeId}`, 'id'], operation())).value, 'glyph');

    const snapshot = await adapter.observe(operation());
    const icons = flatten(snapshot.root).filter(node => node.attributes?.['agent-browser:interaction'] === 'clickable'
      && node.attributes['agent-browser:hints']?.includes('cursor:pointer'));
    assert.equal(icons.length, 1, 'The semantic adapter must retain the native interaction hint');
    const icon = icons[0]!;
    assert.equal(icon.selector, '#glyph');
    assert.equal(icon.name, '');
    assert.equal(icon.role, 'generic');
    assert.equal(icon.attributes?.id, undefined, 'Observation does not expose arbitrary DOM attributes');
    assert.ok(icon.rect && icon.rect.y >= snapshot.viewport.height);
    await cli.run(['click', adapter.resolve(icon.ref)], operation(), { mutating: true });
    assert.deepEqual((await cli.run<{ result: { clicks: number; scrolled: boolean } }>(['eval', '({clicks:window.clicks,scrolled:window.scrollY>0})'], operation())).result, { clicks: 1, scrolled: true });
  }, '/glyph');
});

test('semantic labels, state filters, CSS, XPath, exact nonref import and closed-shadow actions agree', { timeout: 120_000 }, async () => {
  await withLocators(async ({ cli, companion, adapter }) => {
    for (const label of ['Primary label', 'Alternate label']) {
      const found = await companion.locate({ kind: 'query', query: { kind: 'label', value: string(label) } }, operation(), adapter);
      assert.equal(found.length, 1); assert.equal(found[0]?.attributes?.id, 'name');
    }
    const xpath = await companion.locate(selector('xpath=//input[@id="name"]'), operation(), adapter);
    assert.equal(xpath[0]?.attributes?.class, 'editable');
    const checked = await companion.locate({ kind: 'query', query: { kind: 'role', value: string('checkbox'), states: { checked: true } } }, operation(), adapter);
    assert.equal(checked.length, 1); assert.equal(checked[0]?.attributes?.id, 'enabled');
    const named = await companion.locate({ kind: 'query', query: { kind: 'role', value: string('button'), name: { kind: 'regexp', source: '^Save', flags: 'g' } } }, operation(), adapter);
    assert.equal(named.length, 2, 'regexp state must not discard alternating matches');
    const [otp] = await companion.locate(selector('#otp'), operation(), adapter);
    assert.equal(otp?.inputPurpose, 'one-time-code'); assert.equal(otp?.states?.secure, false);
    const [plain] = await companion.locate(selector('#plain'), operation(), adapter); assert.ok(plain);
    assert.equal((await cli.run<{ value: string }>(['get', 'attr', adapter.resolve(plain.ref), 'id'], operation())).value, 'plain');
    const trace = new SnapshotAdapter(cli, { preserveRefs: true, readMetadata: (refs, context) => companion.readMetadata(refs, context) });
    await trace.observe(operation());
    await adapter.verify(plain.ref, operation());
    await cli.run(['eval', 'document.querySelector("#plain").replaceWith(document.querySelector("#plain").cloneNode(true));true'], operation(), { mutating: true });
    await assert.rejects(adapter.verify(plain.ref, operation()), { code: 'NODE_STALE' });
    const [closed] = await companion.locate(selector('#closed'), operation(), adapter); assert.ok(closed);
    await cli.run(['click', adapter.resolve(closed.ref)], operation(), { mutating: true });
    assert.equal((await cli.run<{ result: number }>(['eval', 'window.closedClicks'], operation())).result, 1);
  });
});

test('wrapped frame expressions support same-process and OOPIF worlds, nested geometry and replay paths', { timeout: 120_000 }, async () => {
  await withLocators(async ({ cdp, companion, adapter }) => {
    assert.ok((await cdp.listTargets(operation())).some(target => target.type === 'iframe'), 'Cross-site fixture must be an OOPIF');
    for (const frame of ['#same', '#cross']) {
      const expression: LocatorExpression = { kind: 'index', index: 'last', source: { kind: 'filter', hasText: string('Second choice'), source: {
        kind: 'query', query: { kind: 'role', value: string('button') }, scope: { kind: 'frame', selector: frame, source: selector('#panel') },
      } } };
      const [choice] = await companion.locate(expression, operation(), adapter);
      assert.equal(choice?.name, 'Second choice'); assert.deepEqual(choice?.framePath, [frame]);
      const parents = await companion.locate({ kind: 'frame', selector: frame, source: { kind: 'filter', source: selector('#panel'), has: selector(':scope > .choice') } }, operation(), adapter);
      assert.equal(parents.length, 1);
      const [shadow] = await companion.locate({ kind: 'frame', selector: frame, source: selector('#child-shadow') }, operation(), adapter);
      assert.equal(shadow?.name, 'Child shadow');
      const [deep] = await companion.locate({ kind: 'frame', selector: frame, source: { kind: 'frame', selector: '#inner', source: role('button') } }, operation(), adapter);
      assert.deepEqual(deep?.framePath, [frame, '#inner']); assert.equal(deep?.selector, '#deep');
      assert.ok(deep?.rect); assert.equal(deep.rect.x, frame === '#same' ? 62 : 523); assert.equal(deep.rect.y, frame === '#same' ? 344 : 345);
    }
    await assert.rejects(companion.locate({ kind: 'frame', selector: 'iframe', source: role('button') }, operation(), adapter), { code: 'FRAME_AMBIGUOUS' });
  });
});

test('default snapshot keeps native refs and frame replay while suppressing secure attributes and URL tokens', { timeout: 120_000 }, async () => {
  await withLocators(async ({ adapter }) => {
    const snapshot = await adapter.observe(operation());
    const data = JSON.stringify(snapshot);
    for (const secret of ['FIXTURE_PASSWORD', 'FIXTURE_ATTRIBUTE', 'FIXTURE_QUERY', 'FIXTURE_FRAGMENT']) assert.ok(!data.includes(secret));
    const nodes = flatten(snapshot.root);
    assert.ok(nodes.some(node => node.name === 'Second choice' && node.framePath?.[0] === '#same'));
    assert.ok(nodes.some(node => node.name === 'Second choice' && node.framePath?.[0] === '#cross'));
    for (const frame of ['#same', '#cross']) assert.ok(nodes.some(node => node.name === 'Deep save' && node.framePath?.join('/') === `${frame}/#inner`));
    assert.equal(snapshot.truncated, false, 'The patched full snapshot reports complete recursive frame capture');
  });
});

test('observation policy omits disallowed child refs and nonref text without omitting the parent iframe', { timeout: 120_000 }, async () => {
  await withLocators(async ({ cli, createCompanion }) => {
    const companion = createCompanion(url => new URL(url).hostname === '127.0.0.1');
    const adapter = new SnapshotAdapter(cli, { snapshotArgs: context => companion.snapshotArgs(context), readMetadata: (refs, context) => companion.readMetadata(refs, context) });
    const snapshot = await adapter.observe(operation());
    const all = flatten(snapshot.root);
    assert.ok(all.some(node => node.text === 'Same-only static text'));
    assert.ok(!JSON.stringify(snapshot).includes('Foreign-only static text'));
    assert.ok(!all.some(node => node.framePath?.[0] === '#cross'));
    assert.ok(all.some(node => node.selector === '#cross'), 'The parent-owned iframe remains in the default tree');
  });
});
