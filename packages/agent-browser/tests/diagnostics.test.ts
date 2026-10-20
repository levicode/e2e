import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppLogEntry, OperationContext } from 'e2e/engine';
import type { CdpConnection, CdpTarget } from '../src/cdp.ts';
import type { NetworkHub } from '../src/network.ts';
import { installDiagnostics } from '../src/diagnostics.ts';

type Listener = { method: string; sessionId: string | undefined; handler: (event: Record<string, unknown>) => void };
type Initializer = (sessionId: string, targetId: string, context: OperationContext) => void | Promise<void>;

/** Deterministic protocol source; no remote properties or application functions are ever evaluated. */
class Protocol {
  readonly listeners = new Set<Listener>();
  readonly closing = new Set<() => void>();
  readonly calls: { method: string; sessionId: string | undefined }[] = [];
  readonly targets: CdpTarget[] = [{ targetId: 'main', type: 'page', url: 'about:blank' }];
  on(method: string, handler: Listener['handler'], sessionId?: string): () => void {
    const listener = { method, handler, sessionId };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onClose(handler: () => void): () => void { this.closing.add(handler); return () => { this.closing.delete(handler); }; }
  async send(method: string, _params: object, _context: OperationContext, sessionId?: string): Promise<object> { this.calls.push({ method, sessionId }); return {}; }
  async listTargets(): Promise<readonly CdpTarget[]> { return this.targets; }
  emit(method: string, event: Record<string, unknown>, sessionId = 'active'): void {
    for (const listener of this.listeners) if (listener.method === method && listener.sessionId === sessionId) listener.handler(event);
  }
}

/** Reproduces the hub's before-resume initializer contract for current and future target sessions. */
class Hub {
  readonly entries = [{ targetId: 'main', sessionId: 'active', type: 'page' }];
  readonly initializers: Initializer[] = [];
  sessions(): readonly { targetId: string; sessionId: string; type: string }[] { return this.entries; }
  async registerSessionInitializer(initializer: Initializer, operation: OperationContext): Promise<void> {
    this.initializers.push(initializer);
    await Promise.all(this.entries.map((entry) => initializer(entry.sessionId, entry.targetId, operation)));
  }
  async add(targetId: string, sessionId: string, type = 'page'): Promise<void> {
    this.entries.push({ targetId, sessionId, type });
    await Promise.all(this.initializers.map((initialize) => initialize(sessionId, targetId, context())));
  }
}

/** Uses one bounded test context for setup commands. */
function context(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 1000, runId: 'diagnostics', attemptId: 'one', origin: 'test' };
}

/** Captures only what the harness would retain, with a synthetic ledger redaction at the sink boundary. */
async function fixture(): Promise<{
  protocol: Protocol; hub: Hub; log: AppLogEntry[]; navigations: string[]; cleanup: () => void; controller: AbortController;
}> {
  const protocol = new Protocol();
  const hub = new Hub();
  const log: AppLogEntry[] = [];
  const navigations: string[] = [];
  const controller = new AbortController();
  const cleanup = await installDiagnostics(protocol as unknown as CdpConnection, hub as unknown as NetworkHub, {
    signal: controller.signal,
    appLog: (entry) => log.push({ ...entry, text: entry.text.replaceAll('synthetic-secret', '[redacted]') }),
    navigation: (line) => navigations.push(line.replaceAll('synthetic-secret', '[redacted]')),
  }, {
    activeTarget: () => 'main', ownNavigation: (url) => url === 'https://app.test/explicit',
  }, context());
  return { protocol, hub, log, navigations, cleanup, controller };
}

test('console diagnostics forward primitive values to the redacting sink without inspecting remote objects', async () => {
  const { protocol, log, cleanup } = await fixture();
  protocol.emit('Runtime.consoleAPICalled', { type: 'log', args: [
    { type: 'string', value: 'synthetic-secret' }, { type: 'number', value: 42 },
    { type: 'boolean', value: false }, { type: 'undefined' }, { type: 'object', subtype: 'null' },
    { type: 'object', objectId: 'private-handle', preview: { properties: [{ value: 'private-object-property' }] } },
    { type: 'object', subtype: 'array', description: 'private-description' },
  ] });
  assert.deepEqual(log, [{ source: 'console', level: 'info', text: '[redacted] 42 false undefined null [Object] [Array]' }]);
  assert.deepEqual(protocol.calls.map((call) => call.method).toSorted(), ['Network.enable', 'Page.enable', 'Runtime.enable']);
  cleanup();
});

test('malformed console arguments and error-shaped objects never leak arbitrary nested JSON', async () => {
  const { protocol, log, cleanup } = await fixture();
  protocol.emit('Runtime.consoleAPICalled', { type: 'warning', args: { secret: 'hidden' } });
  protocol.emit('Runtime.consoleAPICalled', { type: 'error', args: [null, { type: 'number', value: { secret: 'hidden' } }, { type: 'string', unserializableValue: 'hidden' }] });
  protocol.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { privatePayload: 'hidden' } } });
  assert.deepEqual(log.map((entry) => entry.text), ['[unavailable console arguments]', '[unavailable] [unavailable] [unavailable]', 'Uncaught page JavaScript exception']);
  assert.equal(JSON.stringify(log).includes('hidden'), false);
  cleanup();
});

test('uncaught errors and explicit error console arguments preserve full values for harness redaction', async () => {
  const { protocol, log, cleanup } = await fixture();
  protocol.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'TypeError: synthetic-secret\n    at fixture.js:1' } } });
  protocol.emit('Runtime.consoleAPICalled', { type: 'assert', args: [{ type: 'object', subtype: 'error', description: 'AssertionError: synthetic-secret' }] });
  assert.deepEqual(log.map((entry) => [entry.source, entry.level, entry.text]), [
    ['error', 'error', 'TypeError: [redacted]\n    at fixture.js:1'],
    ['console', 'error', 'AssertionError: [redacted]'],
  ]);
  cleanup();
});

test('network diagnostics retain method, safe URL, status, and closed error codes without bodies or credentials', async () => {
  const { protocol, log, cleanup } = await fixture();
  protocol.emit('Network.requestWillBeSent', { requestId: 'one', request: { method: 'POST', url: 'https://username:password@app.test/api?token=private-query#private-fragment', headers: { Authorization: 'private-header' }, postData: 'private-body' } });
  protocol.emit('Network.responseReceived', { requestId: 'one', response: { status: 503, statusText: 'private-status-text', url: 'https://app.test/api?token=private-query' } });
  protocol.emit('Network.loadingFailed', { requestId: 'one', errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH' });
  protocol.emit('Network.loadingFailed', { requestId: 'missing', errorText: 'private-error https://credentials.test' });
  assert.deepEqual(log, [
    { source: 'network', level: 'error', text: 'POST https://app.test/api 503' },
    { source: 'network', level: 'error', text: 'POST https://app.test/api net::ERR_CONTENT_LENGTH_MISMATCH' },
    { source: 'network', level: 'error', text: 'request failed' },
  ]);
  assert.doesNotMatch(JSON.stringify(log), /private|password|username/);
  cleanup();
});

test('routine load echoes, aborted navigation requests, missing favicon, and successful HTTP responses are omitted', async () => {
  const { protocol, log, cleanup } = await fixture();
  protocol.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Failed to load resource: duplicate network echo' }] });
  protocol.emit('Runtime.consoleAPICalled', { type: 'debug', args: [{ type: 'string', value: 'debug detail' }] });
  protocol.emit('Network.responseReceived', { requestId: 'one', response: { status: 200, url: 'https://app.test/' } });
  protocol.emit('Network.responseReceived', { requestId: 'two', response: { status: 404, url: 'https://app.test/favicon.ico' } });
  protocol.emit('Network.loadingFailed', { requestId: 'three', errorText: 'net::ERR_ABORTED' });
  protocol.emit('Network.loadingFailed', { requestId: 'four', errorText: 'net::ERR_FAILED', canceled: true });
  assert.deepEqual(log, []);
  cleanup();
});

test('popup and OOPIF sessions get diagnostics and contextual navigation before they resume', async () => {
  const { protocol, hub, log, navigations, cleanup } = await fixture();
  await hub.add('popup', 'popup-session');
  await hub.add('frame', 'frame-session', 'iframe');
  protocol.emit('Runtime.consoleAPICalled', { type: 'info', args: [{ type: 'string', value: 'popup says hello' }] }, 'popup-session');
  protocol.emit('Network.responseReceived', { requestId: 'frame-request', response: { status: 401, url: 'https://frame.test/api' } }, 'frame-session');
  protocol.emit('Page.frameNavigated', { frame: { id: 'popup', url: 'https://app.test/popup?token=private' } }, 'popup-session');
  protocol.emit('Page.frameNavigated', { frame: { id: 'frame', url: 'https://frame.test/embed?private=yes' } }, 'frame-session');
  assert.deepEqual(navigations, ['the app opened a new tab', 'the new tab navigated to https://app.test/popup', 'frame loaded https://frame.test/embed']);
  assert.equal(log.length, 2);
  for (const sessionId of ['popup-session', 'frame-session']) assert.equal(protocol.calls.filter((call) => call.sessionId === sessionId).length, 3);
  cleanup();
});

test('active-page and nested-frame navigation ignore blank/data documents and engine-owned navigation', async () => {
  const { protocol, navigations, cleanup } = await fixture();
  protocol.emit('Page.frameNavigated', { frame: { id: 'main', url: 'about:blank' } });
  protocol.emit('Page.frameNavigated', { frame: { id: 'main', url: 'data:text/plain,private' } });
  protocol.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://app.test/explicit' } });
  protocol.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://app.test/checkout?secret=hidden' } });
  protocol.emit('Page.frameNavigated', { frame: { id: 'nested', parentId: 'main', url: 'https://app.test/frame' } });
  protocol.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://app.test/spa#private' });
  assert.deepEqual(navigations, ['navigated to https://app.test/checkout', 'frame loaded https://app.test/frame', 'navigated to https://app.test/spa']);
  cleanup();
});

test('cleanup and attempt cancellation remove listeners and suppress all future target instrumentation', async () => {
  const { protocol, hub, log, navigations, cleanup, controller } = await fixture();
  controller.abort();
  assert.equal(protocol.listeners.size, 0);
  protocol.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'after cancellation' }] });
  await hub.add('after-close', 'after-close-session');
  assert.equal(protocol.calls.some((call) => call.sessionId === 'after-close-session'), false);
  assert.deepEqual(log, []);
  assert.deepEqual(navigations, []);
  cleanup();
});

test('origin tracking covers current documents, popup navigation, OOPIF navigation, and same-document changes', async () => {
  const protocol = new Protocol();
  protocol.targets[0] = { targetId: 'main', type: 'page', url: 'https://app.test/current' };
  const hub = new Hub();
  const origins: string[] = [];
  const cleanup = await installDiagnostics(protocol as unknown as CdpConnection, hub as unknown as NetworkHub, {
    appLog: () => undefined, navigation: () => undefined, signal: new AbortController().signal,
  }, { activeTarget: () => 'main', onOrigin: (origin) => origins.push(origin), ownNavigation: () => true }, context());
  await hub.add('popup', 'popup-session');
  await hub.add('frame', 'frame-session', 'iframe');
  protocol.emit('Page.frameNavigated', { frame: { id: 'popup', url: 'https://popup.test/closed-soon?private=one' } }, 'popup-session');
  protocol.emit('Page.frameNavigated', { frame: { id: 'frame', url: 'https://frame.test/embed' } }, 'frame-session');
  protocol.emit('Page.navigatedWithinDocument', { url: 'https://app.test/spa#hash' });
  protocol.emit('Runtime.executionContextCreated', { context: { origin: 'https://context.test' } }, 'popup-session');
  assert.deepEqual(new Set(origins), new Set(['https://app.test', 'https://popup.test', 'https://frame.test', 'https://context.test']));
  cleanup();
});
