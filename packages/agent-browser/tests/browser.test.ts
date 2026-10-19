import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import { EngineError, TestError, type EngineFixtureContext, type OperationContext } from 'e2e/engine';
import { createBrowserFixture, type BrowserExpectation } from '../src/browser.ts';
import { InputController } from '../src/input.ts';
import type { CdpConnection } from '../src/cdp.ts';
import type { LeaseDownloads } from '../src/provider.ts';
import type { AgentBrowserSurface } from '../src/surface.ts';

type EventHandler = (event: Record<string, unknown>) => void;
type Initializer = (session: string, target: string, context: OperationContext) => Promise<void>;

async function setup(t: TestContext, settings: { browserContextId?: string; remote?: boolean; downloads?: LeaseDownloads; failDownloadCleanup?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ab-browser-test-'));
  const calls: Array<{ method: string; params: Record<string, unknown>; session?: string }> = [];
  const events = new Map<string, Set<EventHandler>>();
  const cleanups: Array<() => void> = [];
  const background: Promise<void>[] = [];
  const artifacts: string[] = [];
  const operations = new Map<string, unknown>();
  const initializers: Initializer[] = [];
  const restarts: Array<(context: OperationContext) => Promise<void>> = [];
  const sessions = ['main', 'popup'];
  const controller = new AbortController();
  let expectation: BrowserExpectation | undefined;
  let poisoned = false;
  let activeAttempt = 'a';
  let downloadDirectory = '';
  let href = 'https://example.test/start';
  let title = 'Hello world';
  const op = (timeoutMs = 1_000): OperationContext => ({ signal: controller.signal, timeoutMs, runId: 'r', attemptId: 'a', origin: 'test' });
  const emit = (method: string, event: Record<string, unknown>, session?: string) => {
    for (const callback of events.get(`${session ?? ''}:${method}`) ?? []) callback(event);
  };
  const cdp = {
    async send(method: string, params: Record<string, unknown>, _context: OperationContext, session?: string) {
      calls.push({ method, params, ...(session === undefined ? {} : { session }) });
      if (method === 'Browser.setDownloadBehavior' && params.behavior === 'allowAndName') downloadDirectory = String(params.downloadPath);
      if (method === 'Browser.setDownloadBehavior' && params.behavior === 'deny' && settings.failDownloadCleanup) throw new Error('private cleanup response');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' }, childFrames: [{ frame: { id: 'frame-child' } }] } };
      if (method === 'Storage.getCookies') return { cookies: [{ name: 's', value: 'private', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true }] };
      return {};
    },
    on(method: string, handler: EventHandler, session?: string) {
      const key = `${session ?? ''}:${method}`;
      const collection = events.get(key) ?? new Set<EventHandler>();
      collection.add(handler); events.set(key, collection);
      return () => { collection.delete(handler); };
    },
    onClose: (_handler: () => void) => () => {},
  };
  const routes = {
    async registerSessionInitializer(callback: Initializer, context: OperationContext) {
      initializers.push(callback);
      for (const session of sessions) await callback(session, `target-${session}`, context);
    },
    async forEachSession(callback: Initializer, context: OperationContext) {
      for (const session of sessions) await callback(session, `target-${session}`, context);
    },
    async route(pattern: unknown, handler: unknown) { calls.push({ method: 'route', params: { pattern, handler } }); },
    async unroute(pattern: unknown) { calls.push({ method: 'unroute', params: { pattern } }); },
    async waitForResponse(pattern: unknown) { calls.push({ method: 'waitForResponse', params: { pattern } }); return { status: 200 }; },
  };
  const surface = {
    projectRoot: directory, artifactsDir: directory, cdp, cdpSession: 'main', routes, ...settings,
    registerCleanup: (fn: () => void) => cleanups.push(fn),
    registerRestart: (fn: (context: OperationContext) => Promise<void>) => restarts.push(fn),
    registerBackground(work: Promise<void>) { void work.catch(() => undefined); background.push(work); },
    guardOperation(operation: OperationContext) { if (operation.runId !== 'r' || operation.attemptId !== activeAttempt) throw new EngineError('INVALID_STATE', 'Old fixture attempt', { retryable: false }); },
    assertUsable() { if (poisoned) throw new EngineError('INVALID_STATE', 'poisoned', { retryable: false }); },
    markUncertain(): never { poisoned = true; throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'uncertain', { retryable: false }); },
    async command(args: readonly string[], _context: OperationContext, mutating: boolean) { calls.push({ method: 'command', params: { args, mutating } }); },
    async open(url: string, _context: OperationContext, wait: string) { href = url; calls.push({ method: 'open', params: { url, wait } }); },
    async back() { calls.push({ method: 'back', params: {} }); },
    async evaluate(source: string) {
      return vm.runInNewContext(source, { location: { href }, document: { title }, Promise, JSON, Object });
    },
    async setViewport(size: Record<string, number>) { calls.push({ method: 'viewport', params: size }); },
    async pressKey(key: string) { calls.push({ method: 'pressKey', params: { key } }); },
    async typeText(text: string, replace: boolean) { calls.push({ method: 'typeText', params: { text, replace } }); },
  };
  Object.assign(surface, { input: new InputController({
    cdp: () => cdp as unknown as CdpConnection, session: () => 'main',
    assertUsable: () => surface.assertUsable(), markUncertain: () => surface.markUncertain(),
  }) });
  const context = {
    signal: controller.signal, timeouts: { test: 2_000, action: 1_000, assertion: 200 },
    operation: op,
    app: { resolveUrl(value: string) { const url = new URL(value, 'https://example.test/base/'); if (!/^https?:$/.test(url.protocol)) throw new TestError('POLICY_DENIED', 'blocked'); return url.href; } },
    fixture(name: string, value: object, configuration: unknown) { operations.set(name, configuration); return value; },
    expectable(value: object, factory: () => BrowserExpectation) { expectation = factory(); return value; },
    locator: (expression: unknown) => expression,
    screen: (scope: unknown) => ({ scope }),
    attachArtifact(_kind: string, name: string) { artifacts.push(name); },
    attachViewport(size: Record<string, unknown>) { calls.push({ method: 'attachViewport', params: size }); },
  };
  const browser = createBrowserFixture(surface as unknown as AgentBrowserSurface, context as unknown as EngineFixtureContext);
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await rm(directory, { recursive: true, force: true }); });
  return {
    browser, calls, emit, events, directory, artifacts, operations, background, controller,
    retire() { activeAttempt = 'next-attempt'; },
    get expectation() { assert.ok(expectation); return expectation; },
    get poisoned() { return poisoned; },
    async restart() { for (const cleanup of cleanups) cleanup(); initializers.length = 0; for (const callback of restarts) await callback(op()); },
    async addSession(session: string) { sessions.push(session); for (const initializer of initializers) await initializer(session, `target-${session}`, op()); },
    async completeDownload(suggestedFilename = '../../secret.txt', frameId = 'frame-main') {
      const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      emit('Browser.downloadWillBegin', { guid, frameId, suggestedFilename });
      if (settings.downloads === undefined) await writeFile(path.join(downloadDirectory, guid), 'download body');
      emit('Browser.downloadProgress', { guid, state: 'completed' });
    },
    setTitle(value: string) { title = value; },
  };
}

test('records browser methods and resolves all navigation through harness URL policy', async (t) => {
  const fixture = await setup(t);
  await fixture.browser.goto('../next', { waitUntil: 'domcontentloaded' });
  assert.equal(await fixture.browser.url(), 'https://example.test/next');
  await assert.rejects(fixture.browser.goto('javascript:alert(1)'), { code: 'POLICY_DENIED' });
  await fixture.browser.reload(); await fixture.browser.back(); await fixture.browser.forward();
  assert.deepEqual(fixture.calls.filter((call) => call.method === 'command').map((call) => call.params.args), [['reload'], ['forward']]);
  const recorded = fixture.operations.get('browser') as Record<string, unknown>;
  for (const name of ['goto', 'evaluate', 'route', 'onDialog', 'waitForDownload', 'cookies', 'emulateMedia']) assert.ok(recorded[name]);
});

test('evaluate preserves JSON __proto__ keys and supports method function syntax', async (t) => {
  const { browser } = await setup(t);
  const argument = JSON.parse('{"__proto__":{"polluted":true},"normal":3}');
  assert.equal(await browser.evaluate((value) => Object.prototype.hasOwnProperty.call(value, '__proto__'), argument), true);
  const object = { method(value: number) { return value + 2; } };
  assert.equal(await browser.evaluate(object.method, 3), 5);
  await assert.rejects(browser.evaluate(() => ({ bad: Infinity })), { code: 'INVALID_ARGUMENT' });
});

test('URL and title assertions use shared public matching and assertion failure codes', async (t) => {
  const fixture = await setup(t);
  await fixture.expectation.toHaveURL('https://example.test/start');
  await fixture.expectation.toHaveTitle(/hello WORLD/i);
  await assert.rejects(fixture.expectation.toHaveTitle('missing', { timeout: 30 }), { code: 'ASSERTION_FAILED' });
  await assert.rejects(fixture.browser.waitForURL('javascript:bad', { timeout: 20 }));
});

test('routes and response waits delegate to the independent network hub', async (t) => {
  const { browser, calls } = await setup(t);
  await browser.route('**/api', async (route) => route.fulfill({ json: { ok: true } }));
  await browser.unroute('**/api');
  assert.equal((await browser.waitForResponse(/api/)).status, 200);
  assert.deepEqual(calls.map((call) => call.method), ['route', 'unroute', 'waitForResponse']);
});

test('cookie targets are validated before CDP mutation and unrelated fields do not leak through', async (t) => {
  const { browser, calls } = await setup(t);
  await browser.setCookies([{ name: 'token', value: 'secret', url: '../account', httpOnly: true }]);
  const command = calls.find((call) => call.method === 'Storage.setCookies');
  assert.deepEqual(command?.params.cookies, [{ name: 'token', value: 'secret', url: 'https://example.test/account', httpOnly: true }]);
  await assert.rejects(browser.setCookies([{ name: 'bad', value: 'secret', url: 'file:///private' }]), { code: 'POLICY_DENIED' });
  assert.deepEqual(await browser.cookies(), [{ name: 's', value: 'private', domain: 'example.test', path: '/', httpOnly: true, secure: true }]);
});

test('viewport and pointer arguments fail before sending malformed input', async (t) => {
  const { browser, calls } = await setup(t);
  await assert.rejects(browser.setViewport({ width: NaN, height: 100 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(browser.mouse.move(Infinity, 1), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(browser.keyboard.down('Control+Shift+x'), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
  await browser.mouse.wheel(12, 34);
  assert.equal(calls[0]?.method, 'Input.dispatchMouseEvent');
  assert.deepEqual(calls[0]?.params, { type: 'mouseWheel', x: 0, y: 0, deltaX: 12, deltaY: 34, buttons: 0, modifiers: 0 });
  await browser.keyboard.down('ControlOrMeta');
  assert.equal(calls[1]?.params.key, process.platform === 'darwin' ? 'Meta' : 'Control');
  assert.equal(calls[1]?.params.modifiers, process.platform === 'darwin' ? 4 : 2);
});

test('init scripts and media cover current and future sessions without duplicate installation', async (t) => {
  const fixture = await setup(t);
  await fixture.browser.addInitScript((value) => { Object.defineProperty(globalThis, 'seed', { value }); }, { seed: 3 });
  await fixture.browser.emulateMedia({ colorScheme: 'dark' });
  await fixture.browser.emulateMedia({ reducedMotion: 'reduce' });
  await fixture.addSession('later-frame');
  const scripts = fixture.calls.filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.deepEqual(scripts.map((call) => call.session), ['main', 'popup', 'later-frame']);
  const media = fixture.calls.findLast((call) => call.method === 'Emulation.setEmulatedMedia');
  assert.deepEqual(media?.params.features, [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.equal(media?.session, 'later-frame');
});

test('dialog handlers answer via CDP while the CLI is busy and newest registration wins', async (t) => {
  const fixture = await setup(t);
  await fixture.browser.onDialog('dismiss');
  const unsubscribe = await fixture.browser.onDialog(async (dialog) => { assert.equal(dialog.type, 'prompt'); await dialog.accept('answer'); });
  fixture.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Question' }, 'popup');
  await Promise.all(fixture.background);
  assert.deepEqual(fixture.calls.findLast((call) => call.method === 'Page.handleJavaScriptDialog')?.params, { accept: true, promptText: 'answer' });
  await unsubscribe(); await unsubscribe();
  fixture.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Question' }, 'main');
  await Promise.all(fixture.background);
  assert.deepEqual(fixture.calls.findLast((call) => call.method === 'Page.handleJavaScriptDialog')?.params, { accept: false });
});

test('unanswered dialogs latch a failure and are dismissed without exposing page text', async (t) => {
  const fixture = await setup(t);
  await fixture.browser.onDialog(() => {});
  fixture.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'private-page-secret' }, 'main');
  await assert.rejects(Promise.all(fixture.background), (error: unknown) => {
    assert.ok(error instanceof TestError);
    assert.equal(error.code, 'ACTION_FAILED');
    assert.ok(!error.message.includes('private-page-secret'));
    return true;
  });
  assert.deepEqual(fixture.calls.findLast((call) => call.method === 'Page.handleJavaScriptDialog')?.params, { accept: false });
});

test('download saves by GUID to a generated artifact path, never the suggested filename', async (t) => {
  const fixture = await setup(t);
  const result = await fixture.browser.waitForDownload(() => fixture.completeDownload());
  assert.match(result.path, /^download-[\da-f-]+\.bin$/);
  assert.equal(result.absolutePath, path.join(fixture.directory, result.path));
  assert.equal(result.suggestedFilename, '../../secret.txt');
  assert.equal(await readFile(result.absolutePath, 'utf8'), 'download body');
  assert.deepEqual(fixture.artifacts, [result.path]);
  assert.deepEqual(fixture.calls.findLast((call) => call.method === 'Browser.setDownloadBehavior')?.params, { behavior: 'deny', eventsEnabled: false });
});

test('a completed download cannot hide a trigger that never returns', async (t) => {
  const fixture = await setup(t);
  const began = Date.now();
  await assert.rejects(fixture.browser.waitForDownload(async () => {
    await fixture.completeDownload();
    await new Promise(() => {});
  }, { timeout: 60 }), { code: 'ACTION_MAY_HAVE_COMMITTED' });
  assert.ok(Date.now() - began < 300);
  assert.equal(fixture.poisoned, true);
});

test('a download in an unrelated tab does not satisfy the active-document wait', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(fixture.browser.waitForDownload(() => fixture.completeDownload('wrong.txt', 'unrelated-frame'), { timeout: 40 }), { code: 'ACTION_FAILED' });
  assert.equal(fixture.artifacts.length, 0);
  assert.equal(fixture.poisoned, false);
});


test('restart reattaches route, init-script, media, and dialog configuration', async (t) => {
  const fixture = await setup(t);
  await fixture.browser.route('**/keep', async (route) => route.abort());
  await fixture.browser.route('**/remove', async (route) => route.abort());
  await fixture.browser.unroute('**/remove');
  await fixture.browser.addInitScript('globalThis.initialized = true');
  await fixture.browser.emulateMedia({ colorScheme: 'dark' });
  await fixture.browser.onDialog('accept');
  const offset = fixture.calls.length;
  await fixture.restart();
  assert.deepEqual(fixture.calls.slice(offset).filter((call) => call.method === 'route').map((call) => call.params.pattern), ['**/keep']);
  assert.equal(fixture.calls.slice(offset).filter((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument').length, 2);
  fixture.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'after restart' }, 'main');
  await Promise.all(fixture.background);
  assert.deepEqual(fixture.calls.findLast((call) => call.method === 'Page.handleJavaScriptDialog')?.params, { accept: true });
});


test('cookie access and download behavior are confined to the exact browser context', async (t) => {
  const fixture = await setup(t, { browserContextId: 'owned-context' });
  await fixture.browser.cookies();
  await fixture.browser.setCookies([{ name: 'key', value: 'value', url: '/' }]);
  await fixture.browser.waitForDownload(() => fixture.completeDownload());
  const scoped = fixture.calls.filter((call) => ['Storage.getCookies', 'Storage.setCookies', 'Browser.setDownloadBehavior'].includes(call.method));
  assert.equal(scoped.length, 4);
  assert.ok(scoped.every((call) => call.params.browserContextId === 'owned-context'));
});

test('raw remote browsers without transfer support reject downloads before invoking user code', async (t) => {
  const fixture = await setup(t, { remote: true });
  let triggered = false;
  await assert.rejects(fixture.browser.waitForDownload(async () => { triggered = true; }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(triggered, false);
  assert.equal(fixture.calls.length, 0);
});

test('provider downloads transfer only a validated GUID from the declared remote directory', async (t) => {
  const requests: string[] = [];
  const fixture = await setup(t, { remote: true, browserContextId: 'leased-context', downloads: {
    provider: 'provider', dir: '/provider/remote-files',
    async read(file) { requests.push(file); return new TextEncoder().encode('remote download'); },
  } });
  const result = await fixture.browser.waitForDownload(() => fixture.completeDownload('../../private-secret'));
  assert.equal(await readFile(result.absolutePath, 'utf8'), 'remote download');
  assert.deepEqual(requests, ['/provider/remote-files/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  assert.ok(!result.absolutePath.includes('private-secret'));
  const configured = fixture.calls.find((call) => call.method === 'Browser.setDownloadBehavior');
  assert.equal(configured?.params.downloadPath, '/provider/remote-files');
  assert.equal(configured?.params.browserContextId, 'leased-context');
});

test('remote download read errors are sanitized and stalled transfers share the original budget', async (t) => {
  for (const stall of [false, true]) {
    const fixture = await setup(t, { remote: true, downloads: {
      provider: 'provider-secret', dir: '/provider/private-path',
      async read() { if (stall) await new Promise(() => {}); throw new Error('provider private response'); },
    } });
    await assert.rejects(fixture.browser.waitForDownload(() => fixture.completeDownload(), { timeout: 60 }), (error: unknown) => {
      assert.ok(error instanceof TestError); assert.equal(error.code, 'ACTION_FAILED');
      assert.ok(!String(error.stack).includes('private')); return true;
    });
    assert.equal(fixture.poisoned, false);
  }
});

test('unacknowledged download permission cleanup poisons instead of claiming safe completion', async (t) => {
  const fixture = await setup(t, { failDownloadCleanup: true });
  await assert.rejects(fixture.browser.waitForDownload(() => fixture.completeDownload()), { code: 'ACTION_MAY_HAVE_COMMITTED' });
  assert.equal(fixture.poisoned, true);
});


test('retained fixtures cannot operate on a later attempt even if their old signal was not aborted', async (t) => {
  const fixture = await setup(t);
  fixture.retire();
  assert.equal(fixture.controller.signal.aborted, false);
  for (const run of [
    () => fixture.browser.goto('/'), () => fixture.browser.evaluate('1'), () => fixture.browser.cookies(),
    () => fixture.browser.setCookies([{ name: 'key', value: 'value', url: '/' }]),
    () => fixture.browser.mouse.move(1, 2), () => fixture.browser.keyboard.down('Shift'),
    () => fixture.browser.route('**', route => route.continue()),
    () => fixture.browser.waitForResponse('**'), () => fixture.browser.onDialog('dismiss'),
    () => fixture.browser.waitForDownload(async () => { throw new Error('Must not trigger'); }),
  ]) await assert.rejects(async () => run(), { code: 'INVALID_STATE' });
  assert.equal(fixture.calls.length, 0);
});

test('a late download callback cannot attach artifacts or poison the next attempt', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(fixture.browser.waitForDownload(async () => { await fixture.completeDownload(); fixture.retire(); }), { code: 'INVALID_STATE' });
  assert.equal(fixture.poisoned, false);
  assert.equal(fixture.artifacts.length, 0);
});
