import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { OperationContext } from 'e2e/engine';
import { CdpConnection, isExistingEmulationOverride } from '../src/cdp.ts';
import { NetworkCompanion, NetworkHub } from '../src/network.ts';
import { guardCallbackScope, runCallbackScope } from '../src/callback-scope.ts';
import { ProtectedContext } from '../src/protected.ts';

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
const actualWebSocket = globalThis.WebSocket;
const sockets: FakeWebSocket[] = [];

/** EventTarget implementation of the browser's public wire protocol for deterministic transport tests. */
class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  readonly commands: Command[] = [];
  respondTo: (command: Command) => void = (command) => this.reply(command, {});

  constructor(_address: string) {
    super();
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }

  send(raw: string): void {
    const command = JSON.parse(raw) as Command;
    this.commands.push(command);
    queueMicrotask(() => this.respondTo(command));
  }

  reply(command: Command, result: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result, sessionId: command.sessionId }) }));
  }

  protocolError(command: Command, message = 'secret-token https://private.example/'): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, error: { message } }) }));
  }

  event(method: string, params: object, sessionId: string | undefined = 'active'): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }) }));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

beforeEach(() => { sockets.length = 0; globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket; });
afterEach(() => { for (const socket of sockets) socket.close(); globalThis.WebSocket = actualWebSocket; });

/** Gives each test an independent cancellation signal and bounded operation. */
function operation(timeoutMs = 1000, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs, runId: 'test', attemptId: 'one', origin: 'test' };
}

/** Connects only the deterministic in-process socket. */
async function transport(): Promise<{ connection: CdpConnection; socket: FakeWebSocket }> {
  const connection = await CdpConnection.connect('ws://localhost/devtools/browser/test', operation());
  return { connection, socket: sockets.at(-1)! };
}

/** Uses the already-connected active target, with fresh per-body budgets. */
async function network(): Promise<{ connection: CdpConnection; socket: FakeWebSocket; network: NetworkCompanion }> {
  const current = await transport();
  const companion = new NetworkCompanion(current.connection, 'active', {
    operation,
    resolveUrl: (value) => new URL(value, 'https://app.test').href,
    resolvePath: (value) => value,
  });
  await companion.start(operation());
  return { ...current, network: companion };
}

/** Allows all event handlers and their immediate protocol replies to finish. */
async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

/** Emits a paused browser request. */
function pause(socket: FakeWebSocket, id = 'fetch-1', url = 'https://app.test/api'): void {
  socket.event('Fetch.requestPaused', { requestId: id, request: { url, method: 'POST', headers: { Accept: '*/*' }, postData: 'original' } });
}

/** Emits a real-response header event without prematurely finishing the body. */
function response(socket: FakeWebSocket, id = 'network-1', url = 'https://app.test/api'): void {
  socket.event('Network.responseReceived', { requestId: id, response: { url, status: 200, headers: { 'Content-Type': 'application/json' } } });
}

test('multiplexes concurrent commands and delivers target events while a command is pending', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = () => undefined;
  const first = connection.send<{ value: number }>('Runtime.evaluate', {}, operation(), 'active');
  const second = connection.send<{ value: number }>('Page.getFrameTree', {}, operation(), 'active');
  const received: number[] = [];
  const unsubscribe = connection.on<{ value: number }>('Network.responseReceived', (event) => received.push(event.value), 'active');
  socket.event('Network.responseReceived', { value: 1 });
  socket.event('Network.responseReceived', { value: 99 }, 'other');
  assert.deepEqual(received, [1]);
  socket.reply(socket.commands[1]!, { value: 2 });
  assert.equal((await second).value, 2);
  socket.reply(socket.commands[0]!, { value: 1 });
  assert.equal((await first).value, 1);
  unsubscribe();
  socket.event('Network.responseReceived', { value: 3 });
  assert.deepEqual(received, [1]);
});

test('attaches precisely agent-browser targetId with flatten, never creates or silently switches targets', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = (command) => socket.reply(command, command.method === 'Target.getTargets'
    ? { targetInfos: [{ targetId: 'agent-active', type: 'page', url: 'about:blank' }, { targetId: 'unrelated', type: 'page', url: 'about:blank' }] }
    : { sessionId: 'same-target-session' });
  assert.equal(await connection.attachTarget('agent-active', operation()), 'same-target-session');
  assert.deepEqual(socket.commands[1]!.params, { targetId: 'agent-active', flatten: true });
  await assert.rejects(connection.attachTarget('gone', operation()), { code: 'INVALID_STATE' });
  assert.equal(socket.commands.filter((command) => command.method === 'Target.attachToTarget').length, 1);
  assert.equal(socket.commands.some((command) => command.method === 'Target.createTarget'), false);
});

test('times out one command, ignores its late reply, and still accepts other commands', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = () => undefined;
  const timedOut = connection.send('Runtime.evaluate', {}, operation(5), 'active');
  await assert.rejects(timedOut, { code: 'OPERATION_TIMEOUT' });
  socket.reply(socket.commands[0]!, { stale: true });
  socket.respondTo = (command) => socket.reply(command, { ok: true });
  assert.deepEqual(await connection.send('Page.getFrameTree', {}, operation(), 'active'), { ok: true });
});

test('cancellation rejects without leaking signal reason or endpoint and removes pending command', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = () => undefined;
  const controller = new AbortController();
  const pending = connection.send('Runtime.evaluate', {}, operation(1000, controller.signal), 'active');
  controller.abort(new Error('secret-token'));
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as { code: string }).code, 'CANCELLED');
    assert.doesNotMatch(String(error), /secret-token|localhost/);
    return true;
  });
  socket.reply(socket.commands[0]!, {});
});

test('sanitizes protocol failures and fails every pending command when the socket closes', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = (command) => socket.protocolError(command);
  await assert.rejects(connection.send('Runtime.evaluate', {}, operation()), (error: unknown) => {
    assert.doesNotMatch(String(error), /secret-token|private\.example/);
    return true;
  });
  socket.respondTo = () => undefined;
  const first = connection.send('One', {}, operation());
  const second = connection.send('Two', {}, operation());
  let closes = 0;
  connection.onClose(() => { closes += 1; });
  socket.close();
  await assert.rejects(first, { code: 'ENGINE_FAILURE' });
  await assert.rejects(second, { code: 'ENGINE_FAILURE' });
  connection.close();
  assert.equal(closes, 1);
});

test('known renderer-override conflicts require the exact method and response while error text remains sanitized', async () => {
  const { connection, socket } = await transport();
  for (const [method, message, kind] of [
    ['Emulation.setLocaleOverride', 'Another locale override is already in effect', 'locale'],
    ['Emulation.setTimezoneOverride', 'Timezone override is already in effect', 'timezone'],
    ['Runtime.evaluate', 'Another locale override is already in effect', undefined],
    ['Emulation.setLocaleOverride', 'Another locale override is already in effect: private-token', undefined],
    ['Emulation.setTimezoneOverride', 'Invalid timezone id', undefined],
  ] as const) {
    socket.respondTo = command => socket.protocolError(command, message);
    await assert.rejects(connection.send(method, {}, operation(), 'active'), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : undefined, 'CDP command failed');
      assert.equal(isExistingEmulationOverride(error, 'locale'), kind === 'locale');
      assert.equal(isExistingEmulationOverride(error, 'timezone'), kind === 'timezone');
      assert.doesNotMatch(String(error), /already in effect|private-token|Invalid timezone/);
      return true;
    });
  }
});

test('same-renderer popup override conflicts preserve initialization before resume after our initial successful override', async () => {
  const { connection, socket, hub } = await networkHub();
  const protectedContext = new ProtectedContext({ locale: 'en-GB', timezoneId: 'Europe/London', initScripts: ['globalThis.configuredBeforeApp=true'] });
  await protectedContext.prepare('.', async () => 'unused');
  socket.respondTo = command => {
    if (command.sessionId === 'popup-session' && command.method === 'Emulation.setLocaleOverride') {
      socket.protocolError(command, 'Another locale override is already in effect');
    } else if (command.sessionId === 'popup-session' && command.method === 'Emulation.setTimezoneOverride') {
      socket.protocolError(command, 'Timezone override is already in effect');
    } else socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
  };
  await hub.registerSessionInitializer((session, _target, context) => protectedContext.configureSession(connection, session, context), operation());
  attachEvent(socket, 'popup', 'popup-session');
  await hub.settle(operation());
  const commands = socket.commands.filter(command => command.sessionId === 'popup-session').map(command => command.method);
  assert.ok(commands.indexOf('Emulation.setTimezoneOverride') > commands.indexOf('Emulation.setLocaleOverride'));
  assert.ok(commands.indexOf('Runtime.runIfWaitingForDebugger') > commands.indexOf('Page.addScriptToEvaluateOnNewDocument'));
});

test('first-target and new-connection override conflicts fail closed', async () => {
  for (const kind of ['locale', 'timezone'] as const) {
    const method = kind === 'locale' ? 'Emulation.setLocaleOverride' : 'Emulation.setTimezoneOverride';
    const message = kind === 'locale' ? 'Another locale override is already in effect' : 'Timezone override is already in effect';
    const protectedContext = new ProtectedContext(kind === 'locale' ? { locale: 'en-GB' } : { timezoneId: 'Europe/London' });
    await protectedContext.prepare('.', async () => 'unused');
    const current = await transport();
    current.socket.respondTo = command => {
      if (command.method === method) current.socket.protocolError(command, message);
      else current.socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
    };
    await assert.rejects(protectedContext.configureSession(current.connection, 'first', operation()), /CDP command failed/);
    current.socket.respondTo = command => current.socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
    await protectedContext.configureSession(current.connection, 'first', operation());
    const replacement = await transport();
    replacement.socket.respondTo = command => {
      if (command.method === method) replacement.socket.protocolError(command, message);
      else replacement.socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
    };
    await assert.rejects(protectedContext.configureSession(replacement.connection, 'replacement', operation()), /CDP command failed/);
  }
});

test('unexpected renderer override failures stay fatal after a successful earlier setting', async () => {
  for (const kind of ['locale', 'timezone'] as const) {
    const method = kind === 'locale' ? 'Emulation.setLocaleOverride' : 'Emulation.setTimezoneOverride';
    const protectedContext = new ProtectedContext(kind === 'locale' ? { locale: 'en-GB' } : { timezoneId: 'Europe/London' });
    await protectedContext.prepare('.', async () => 'unused');
    const { connection, socket } = await transport();
    socket.respondTo = command => socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
    await protectedContext.configureSession(connection, 'first', operation());
    socket.respondTo = command => {
      if (command.method === method) socket.protocolError(command);
      else socket.reply(command, command.method === 'Browser.getVersion' ? { userAgent: 'synthetic' } : {});
    };
    await assert.rejects(protectedContext.configureSession(connection, 'popup', operation()), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : undefined, 'CDP command failed');
      assert.doesNotMatch(String(error), /secret-token|private\.example/);
      return true;
    });
  }
});

test('response wait registers before an independent action and reads body only after loadingFinished', async () => {
  const { connection, socket, network: companion } = await network();
  socket.respondTo = (command) => {
    if (command.method === 'Runtime.evaluate') response(socket);
    socket.reply(command, command.method === 'Network.getResponseBody' ? { body: '{"ok":true}', base64Encoded: false } : {});
  };
  const pending = companion.waitForResponse('**/api', operation());
  await connection.send('Runtime.evaluate', {}, operation(), 'active');
  const matched = await pending;
  assert.equal(matched.status, 200);
  assert.equal(matched.headers['content-type'], 'application/json');
  assert.equal(socket.commands.some((command) => command.method === 'Network.getResponseBody'), false);
  const text = matched.text();
  let bodyReady = false;
  void text.then(() => { bodyReady = true; });
  await tick();
  assert.equal(bodyReady, false);
  socket.event('Network.loadingFinished', { requestId: 'network-1' });
  assert.equal(await text, '{"ok":true}');
  assert.deepEqual(await matched.json(), { ok: true });
  assert.equal(socket.commands.filter((command) => command.method === 'Network.getResponseBody').length, 1);
});

test('body read has an independent budget after the header match deadline', async () => {
  const { socket, network: companion } = await network();
  socket.respondTo = (command) => socket.reply(command, { body: 'late body', base64Encoded: false });
  const pending = companion.waitForResponse('**/api', operation(20));
  response(socket);
  const matched = await pending;
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.event('Network.loadingFinished', { requestId: 'network-1' });
  assert.equal(await matched.text(), 'late body');
});

test('failed body remains a failure instead of becoming an empty successful response', async () => {
  const { socket, network: companion } = await network();
  const pending = companion.waitForResponse('**/api', operation());
  response(socket);
  const matched = await pending;
  socket.event('Network.loadingFailed', { requestId: 'network-1', errorText: 'https://private.example/secret' });
  await assert.rejects(matched.text(), { code: 'ACTION_FAILED' });
  await assert.rejects(matched.text(), (error: unknown) => {
    assert.match(String(error), /failed/);
    assert.doesNotMatch(String(error), /private|secret/);
    return true;
  });
});

test('matching request failure before headers differs from a response wait timeout', async () => {
  const { socket, network: companion } = await network();
  const pending = companion.waitForResponse('**/api', operation());
  socket.event('Network.requestWillBeSent', { requestId: 'network-1', request: { url: 'https://app.test/api' } });
  socket.event('Network.loadingFailed', { requestId: 'network-1' });
  await assert.rejects(pending, { code: 'ACTION_FAILED' });
  await assert.rejects(companion.waitForResponse('**/never', operation(5)), { code: 'OPERATION_TIMEOUT' });
});

test('closing the companion rejects outstanding response and body waits', async () => {
  const { socket, network: companion } = await network();
  const headers = companion.waitForResponse('**/api', operation());
  response(socket);
  const matched = await headers;
  const pendingBody = matched.text();
  const pendingResponse = companion.waitForResponse('**/other', operation());
  companion.close();
  await assert.rejects(pendingBody, { code: 'ACTION_FAILED' });
  await assert.rejects(pendingResponse, { code: 'ACTION_FAILED' });
});

test('routes run LIFO, fallback enters the previous handler, and one fulfillment reaches the same session', async () => {
  const { socket, network: companion } = await network();
  const order: string[] = [];
  await companion.route('**/api', async (route) => { order.push('older'); await route.fulfill({ json: { ok: true }, status: 201 }); }, operation());
  await companion.route('**/api', async (route) => { order.push('newer'); await route.fallback(); }, operation());
  pause(socket);
  await companion.settle(operation());
  assert.deepEqual(order, ['newer', 'older']);
  const fulfill = socket.commands.find((command) => command.method === 'Fetch.fulfillRequest')!;
  assert.equal(fulfill.sessionId, 'active');
  assert.equal(fulfill.params.requestId, 'fetch-1');
  assert.equal(fulfill.params.responseCode, 201);
  assert.equal(Buffer.from(fulfill.params.body as string, 'base64').toString(), '{"ok":true}');
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.fulfillRequest').length, 1);
});

test('continue skips older routes and uses CDP base64 post data and normalized header overrides', async () => {
  const { socket, network: companion } = await network();
  let olderRan = false;
  await companion.route('**/api', async (route) => { olderRan = true; await route.abort(); }, operation());
  await companion.route('**/api', async (route) => { await route.continue({ url: '/rewritten', method: 'PUT', headers: { 'X-TEST': 'one' }, postData: 'héllo' }); }, operation());
  pause(socket);
  await companion.settle(operation());
  assert.equal(olderRan, false);
  const continued = socket.commands.find((command) => command.method === 'Fetch.continueRequest')!;
  assert.deepEqual(continued.params, {
    requestId: 'fetch-1', url: 'https://app.test/rewritten', method: 'PUT',
    headers: [{ name: 'x-test', value: 'one' }], postData: Buffer.from('héllo').toString('base64'),
  });
});

test('async route can wait for a concurrent action without holding a global protocol lock', async () => {
  const { connection, socket, network: companion } = await network();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await companion.route('**/api', async (route) => { await gate; await route.fulfill({ body: 'done' }); }, operation());
  pause(socket);
  await connection.send('Runtime.evaluate', {}, operation(), 'active');
  release();
  await companion.settle(operation());
  assert.equal(socket.commands.some((command) => command.method === 'Fetch.fulfillRequest'), true);
});

test('handler failure and no-decision abort the request and fail settle without exposing arbitrary errors', async () => {
  const { socket, network: companion } = await network();
  await companion.route('**/api', () => { throw new Error('secret-token https://private.example'); }, operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), (error: unknown) => {
    assert.doesNotMatch(String(error), /secret-token|private\.example/);
    return true;
  });
  assert.equal(socket.commands.at(-1)!.method, 'Fetch.failRequest');
  await companion.unroute('**/api', operation());
  await companion.route('**/api', () => undefined, operation());
  pause(socket, 'fetch-2');
  await assert.rejects(companion.settle(operation()), /without calling/);
});

test('attempt teardown cancels an automatic continuation without inventing a user route failure', async () => {
  const { connection, socket } = await transport();
  const controller = new AbortController();
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(1000, controller.signal), resolveUrl: url => url, resolvePath: file => file,
    siteHeaders: () => ({ 'x-preview-key': 'synthetic' }),
  });
  await companion.start(operation());
  socket.respondTo = command => {
    if (command.method !== 'Fetch.continueRequest') socket.reply(command, {});
  };
  pause(socket);
  await tick();
  assert.equal(socket.commands.at(-1)?.method, 'Fetch.continueRequest');
  controller.abort();
  await companion.settle(operation());
  assert.equal(socket.commands.filter(command => command.method === 'Fetch.failRequest').length, 0);
});

test('automatic protocol failures and real user route failures remain errors across teardown', async () => {
  const { connection, socket } = await transport();
  const controller = new AbortController();
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(1000, controller.signal), resolveUrl: url => url, resolvePath: file => file,
    siteHeaders: () => ({ 'x-preview-key': 'synthetic' }),
  });
  await companion.start(operation());
  socket.respondTo = command => {
    if (command.method === 'Fetch.continueRequest') socket.protocolError(command);
    else socket.reply(command, {});
  };
  pause(socket);
  await tick();
  controller.abort();
  await assert.rejects(companion.settle(operation()), /Automatic request continuation failed/);

  const user = await network();
  await user.network.route('**/api', () => { throw new Error('private handler failure'); }, operation());
  pause(user.socket);
  await tick();
  user.network.close();
  await assert.rejects(user.network.settle(operation()), /Asynchronous route handler failed/);
});

test('attempt cancellation does not disguise an unfinished user route as automatic cleanup', async () => {
  const { connection, socket } = await transport();
  const controller = new AbortController();
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(1000, controller.signal), resolveUrl: url => url, resolvePath: file => file,
  });
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  await companion.route('**/api', () => waiting, operation());
  pause(socket);
  await tick();
  controller.abort();
  await assert.rejects(companion.settle(operation()), /Asynchronous route handler failed/);
  resume();
  await tick();
  assert.equal(socket.commands.some(command => command.method === 'Fetch.continueRequest'), false);
});

test('attempt teardown cancels a built-in Basic authentication response without a spurious failure', async () => {
  const { connection, socket } = await transport();
  const controller = new AbortController();
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(1000, controller.signal), resolveUrl: url => url, resolvePath: file => file,
    authorization: () => ({ username: 'synthetic', password: 'synthetic' }),
  });
  await companion.start(operation());
  socket.respondTo = command => {
    if (command.method !== 'Fetch.continueWithAuth') socket.reply(command, {});
  };
  socket.event('Fetch.authRequired', { requestId: 'auth', request: { url: 'https://app.test/auth' },
    authChallenge: { source: 'Server', origin: 'https://app.test', scheme: 'basic', realm: 'synthetic' } });
  await tick();
  assert.equal(socket.commands.at(-1)?.method, 'Fetch.continueWithAuth');
  controller.abort();
  await companion.settle(operation());
});

test('authorization preparation failures remain sanitized failures when teardown cancels their reply', async () => {
  const { connection, socket } = await transport();
  const controller = new AbortController();
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(1000, controller.signal), resolveUrl: url => url, resolvePath: file => file,
    authorization: () => { throw new Error('private-token https://private.example'); },
  });
  await companion.start(operation());
  socket.respondTo = command => {
    if (command.method !== 'Fetch.continueWithAuth') socket.reply(command, {});
  };
  socket.event('Fetch.authRequired', { requestId: 'auth', request: { url: 'https://app.test/auth' },
    authChallenge: { source: 'Server', origin: 'https://app.test', scheme: 'basic', realm: 'synthetic' } });
  await tick();
  assert.equal(socket.commands.at(-1)?.method, 'Fetch.continueWithAuth');
  assert.deepEqual(socket.commands.at(-1)?.params.authChallengeResponse, { response: 'CancelAuth' });
  controller.abort();
  await assert.rejects(companion.settle(operation()), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : undefined, 'HTTP authorization failed');
    assert.doesNotMatch(String(error), /private-token|private\.example/);
    return true;
  });
});

test('double decision is latched even if user code catches the rejection, with no second dispatch', async () => {
  const { socket, network: companion } = await network();
  await companion.route('**/api', async (route) => {
    await route.fulfill({ body: 'first' });
    await route.abort().catch(() => undefined);
  }, operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), /already decided/);
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.fulfillRequest').length, 1);
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.failRequest').length, 0);
});

test('settle tracks a decision that a handler forgot to await', async () => {
  const { socket, network: companion } = await network();
  let finish!: () => void;
  socket.respondTo = (command) => {
    if (command.method === 'Fetch.fulfillRequest') finish = () => socket.reply(command, {});
    else socket.reply(command, {});
  };
  await companion.route('**/api', (route) => { void route.fulfill({ body: 'done' }); }, operation());
  pause(socket);
  const settled = companion.settle(operation());
  let done = false;
  void settled.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  finish();
  await settled;
});

test('unroute removes equal patterns only and preserves already dispatched handlers', async () => {
  const { socket, network: companion } = await network();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await companion.route(/\/api$/g, async (route) => { await gate; await route.abort(); }, operation());
  pause(socket);
  await companion.unroute(/\/api$/g, operation());
  release();
  await companion.settle(operation());
  pause(socket, 'fetch-2');
  await companion.settle(operation());
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.failRequest').length, 1);
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.continueRequest').length, 1);
});

test('route option validation happens before committing and aborts instead of silently accepting unknown options', async () => {
  const { socket, network: companion } = await network();
  await companion.route('**/api', async (route) => {
    await route.fulfill({ body: 'x', unknownOption: true } as unknown as Parameters<typeof route.fulfill>[0]);
  }, operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), { code: 'INVALID_ARGUMENT' });
  assert.equal(socket.commands.some((command) => command.method === 'Fetch.fulfillRequest'), false);
  assert.equal(socket.commands.at(-1)!.method, 'Fetch.failRequest');
});

/** Emits a flattened attachment, including a parent-session id for nested frame targets. */
function attachEvent(socket: FakeWebSocket, targetId: string, sessionId: string, parent?: string, type = 'page', browserContextId?: string): void {
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    method: 'Target.attachedToTarget',
    params: { sessionId, targetInfo: { targetId, type, url: 'https://app.test/', ...(browserContextId ? { browserContextId } : {}) }, waitingForDebugger: true },
    ...(parent === undefined ? {} : { sessionId: parent }),
  }) }));
}

/** Starts browser-wide auto-attach against one existing document. */
async function networkHub(): Promise<{ connection: CdpConnection; socket: FakeWebSocket; hub: NetworkHub }> {
  const current = await transport();
  current.socket.respondTo = (command) => {
    if (command.method === 'Target.setAutoAttach' && command.sessionId === undefined) attachEvent(current.socket, 'main', 'active');
    current.socket.reply(command, {});
  };
  const hub = new NetworkHub(current.connection, {
    operation, resolveUrl: (value) => new URL(value, 'https://app.test').href, resolvePath: (value) => value,
  });
  await hub.start(operation());
  await hub.useTarget('main', operation());
  return { ...current, hub };
}

test('an explicitly exclusive browser retains browser-wide popup throttling with exact context filtering', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = command => {
    if (command.method === 'Target.setAutoAttach' && command.sessionId === undefined) attachEvent(socket, 'owned', 'active', undefined, 'page', 'attempt');
    socket.reply(command, {});
  };
  const hub = new NetworkHub(connection, {
    browserExclusive: true, browserContextId: 'attempt', operation, resolveUrl: value => value, resolvePath: value => value,
  });
  await hub.start(operation());
  await hub.useTarget('owned', operation());
  await hub.route('**/api', route => route.fulfill({ body: 'owned' }), operation());
  attachEvent(socket, 'popup', 'popup-session', undefined, 'page', 'attempt');
  await hub.settle(operation());
  assert.equal(socket.commands.filter(command => command.method === 'Target.setAutoAttach' && command.sessionId === undefined).length, 1);
  assert.equal(socket.commands.some(command => command.method === 'Target.autoAttachRelated'), false, 'Related-target mode would cancel the browser popup throttle');
  const enabled = socket.commands.findIndex(command => command.method === 'Fetch.enable' && command.sessionId === 'popup-session');
  const resumed = socket.commands.findIndex(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'popup-session');
  assert.ok(enabled >= 0 && resumed > enabled);
  hub.close();
});

test('browser-wide routes reach new popups and OOPIFs before those targets resume', async () => {
  const { socket, hub } = await networkHub();
  const handled: string[] = [];
  await hub.route('**/api', async (route) => { handled.push(route.request.url); await route.fulfill({ body: 'intercepted' }); }, operation());
  attachEvent(socket, 'popup', 'popup-session');
  attachEvent(socket, 'cross-origin-frame', 'frame-session', 'active', 'iframe');
  await hub.settle(operation());
  for (const sessionId of ['popup-session', 'frame-session']) {
    const enabled = socket.commands.findIndex((command) => command.method === 'Fetch.enable' && command.sessionId === sessionId);
    const resumed = socket.commands.findIndex((command) => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === sessionId);
    assert.ok(enabled >= 0 && resumed > enabled, `Interception must precede resume for ${sessionId}`);
    socket.event('Fetch.requestPaused', {
      requestId: sessionId, request: { url: 'https://app.test/api', method: 'GET', headers: {} },
    }, sessionId);
  }
  await hub.settle(operation());
  assert.equal(handled.length, 2);
  assert.deepEqual(socket.commands.filter((command) => command.method === 'Fetch.fulfillRequest').map((command) => command.sessionId).toSorted(), ['frame-session', 'popup-session']);
  assert.equal(socket.commands.some((command) => command.method === 'Target.createTarget'), false);
});

test('an unprotected hub observes current and future pages without installing Fetch interception', async () => {
  const { socket, hub } = await networkHub();
  attachEvent(socket, 'popup', 'popup-session');
  await hub.settle(operation());
  assert.deepEqual(socket.commands.filter(command => command.method === 'Network.enable').map(command => command.sessionId), ['active', 'popup-session']);
  assert.equal(socket.commands.some(command => command.method === 'Fetch.enable'), false);
});

test('hub response waits stay on the selected target while route registrations survive tab switches', async () => {
  const { socket, hub } = await networkHub();
  await hub.route('**/api', (route) => route.abort(), operation());
  attachEvent(socket, 'popup', 'popup-session');
  await hub.settle(operation());
  const pending = hub.waitForResponse('**/api', operation());
  socket.event('Network.responseReceived', { requestId: 'wrong', response: { url: 'https://app.test/api', status: 418, headers: {} } }, 'popup-session');
  await hub.useTarget('popup', operation());
  response(socket);
  assert.equal((await pending).status, 200);
  const popupResponse = hub.waitForResponse('**/api', operation());
  socket.event('Network.responseReceived', { requestId: 'popup-response', response: { url: 'https://app.test/api', status: 202, headers: {} } }, 'popup-session');
  assert.equal((await popupResponse).status, 202);
  socket.event('Fetch.requestPaused', { requestId: 'popup-fetch', request: { url: 'https://app.test/api', method: 'GET', headers: {} } }, 'popup-session');
  await hub.settle(operation());
  assert.equal(socket.commands.at(-1)!.method, 'Fetch.failRequest');
});

test('hub unroute updates all current targets and does not replay removed routes on future targets', async () => {
  const { socket, hub } = await networkHub();
  let called = 0;
  await hub.route('**/api', (route) => { called += 1; return route.abort(); }, operation());
  attachEvent(socket, 'popup', 'popup-session');
  await hub.settle(operation());
  await hub.unroute('**/api', operation());
  pause(socket);
  socket.event('Fetch.requestPaused', { requestId: 'popup-request', request: { url: 'https://app.test/api', method: 'GET', headers: {} } }, 'popup-session');
  attachEvent(socket, 'later', 'later-session');
  await hub.settle(operation());
  assert.equal(called, 0);
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.continueRequest').length, 2);
  assert.equal(socket.commands.some((command) => command.method === 'Fetch.enable' && command.sessionId === 'later-session'), false);
});

test('hub invokes instrumentation hooks before unpausing a newly created target', async () => {
  const { connection, socket, hub } = await networkHub();
  hub.onTarget(async (_target, sessionId, context) => { await connection.send('Runtime.enable', {}, context, sessionId); });
  attachEvent(socket, 'popup', 'popup-session');
  await hub.settle(operation());
  const enabled = socket.commands.findIndex((command) => command.method === 'Runtime.enable' && command.sessionId === 'popup-session');
  const pageEnabled = socket.commands.findIndex((command) => command.method === 'Page.enable' && command.sessionId === 'popup-session');
  const resumed = socket.commands.findIndex((command) => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'popup-session');
  assert.ok(pageEnabled >= 0 && enabled > pageEnabled && resumed > enabled);
});

test('initializer registration racing attachment waits for Page.enable before installing document scripts', async () => {
  const { connection, socket, hub } = await networkHub();
  let pageCommand: Command | undefined;
  socket.respondTo = command => {
    if (command.method === 'Page.enable' && command.sessionId === 'popup-session') pageCommand = command;
    else socket.reply(command, {});
  };
  attachEvent(socket, 'popup', 'popup-session');
  const registering = hub.registerSessionInitializer((sessionId, _targetId, context) =>
    connection.send<void>('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.fixtureHook = true' }, context, sessionId), operation());
  await tick();
  assert.ok(pageCommand);
  assert.equal(socket.commands.some(command => command.method === 'Page.addScriptToEvaluateOnNewDocument' && command.sessionId === 'popup-session'), false);
  socket.reply(pageCommand, {});
  await registering;
  await hub.settle(operation());
  const initialized = socket.commands.findIndex(command => command.method === 'Page.addScriptToEvaluateOnNewDocument' && command.sessionId === 'popup-session');
  const resumed = socket.commands.findIndex(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'popup-session');
  assert.ok(initialized > socket.commands.indexOf(pageCommand) && resumed > initialized);
});

test('fallback to the network preserves app-site headers and normalizes the original request headers', async () => {
  const { connection, socket } = await transport();
  const companion = new NetworkCompanion(connection, 'active', {
    operation, resolveUrl: (url) => url, resolvePath: (path) => path,
    siteHeaders: () => ({ 'X-APP': 'protected' }),
  });
  await companion.route('**/api', (route) => route.fallback(), operation());
  pause(socket);
  await companion.settle(operation());
  assert.deepEqual(socket.commands.at(-1)!.params.headers, [{ name: 'accept', value: '*/*' }, { name: 'x-app', value: 'protected' }]);
});

test('route headers reject prohibited control bytes while horizontal tabs remain allowed', async () => {
  const { socket, network: companion } = await network();
  await companion.route('**/api', (route) => route.fulfill({ headers: { test: 'bad\x07value' } }), operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), { code: 'INVALID_ARGUMENT' });
  await companion.unroute('**/api', operation());
  await companion.route('**/api', (route) => route.fulfill({ headers: { test: 'good\tvalue' } }), operation());
  pause(socket, 'fetch-2');
  await companion.settle(operation());
});

test('session initializer reaches current and future documents exactly once despite overlapping attachment', async () => {
  const { socket, hub } = await networkHub();
  attachEvent(socket, 'popup', 'popup-session');
  const applied: string[] = [];
  await hub.registerSessionInitializer((sessionId, targetId) => { applied.push(`${targetId}:${sessionId}`); }, operation());
  await hub.settle(operation());
  assert.deepEqual(applied.toSorted(), ['main:active', 'popup:popup-session']);
  attachEvent(socket, 'later', 'later-session');
  await hub.settle(operation());
  assert.deepEqual(applied.toSorted(), ['later:later-session', 'main:active', 'popup:popup-session']);
  const updated: string[] = [];
  await hub.forEachSession((sessionId) => { updated.push(sessionId); }, operation());
  assert.deepEqual(updated.toSorted(), ['active', 'later-session', 'popup-session']);
});

test('looking up a frame session does not migrate active-page response waits', async () => {
  const { socket, hub } = await networkHub();
  attachEvent(socket, 'cross-origin-frame', 'frame-session', 'active', 'iframe');
  await hub.settle(operation());
  assert.equal(await hub.sessionForTarget('cross-origin-frame', operation()), 'frame-session');
  assert.equal(hub.getSession('main'), 'active');
  assert.deepEqual(hub.sessions().map((entry) => entry.type).toSorted(), ['iframe', 'page']);
  const pending = hub.waitForResponse('**/api', operation());
  response(socket);
  assert.equal((await pending).status, 200);
});

test('closing while response body retrieval is in-flight rejects the read immediately', async () => {
  const { connection, socket, network: companion } = await network();
  socket.respondTo = (command) => { if (command.method !== 'Network.getResponseBody') socket.reply(command, {}); };
  const waiting = companion.waitForResponse('**/api', operation());
  response(socket);
  const matched = await waiting;
  socket.event('Network.loadingFinished', { requestId: 'network-1' });
  const body = matched.text();
  companion.close();
  await assert.rejects(body, { code: 'ACTION_FAILED' });
  connection.close();
});

test('a handler that resumes after its deadline cannot issue a late request decision', async () => {
  const { connection, socket } = await transport();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const companion = new NetworkCompanion(connection, 'active', {
    operation: () => operation(15), resolveUrl: (url) => url, resolvePath: (path) => path,
  });
  await companion.route('**/api', async (route) => { await gate; await route.fulfill({ body: 'too late' }); }, operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), { code: 'ACTION_FAILED' });
  release();
  await tick();
  assert.equal(socket.commands.some((command) => command.method === 'Fetch.fulfillRequest'), false);
  assert.equal(socket.commands.filter((command) => command.method === 'Fetch.failRequest').length, 1);
});

test('a timed-out route callback cannot obtain fresh fixture operations in the same live generation', async () => {
  const { connection, socket } = await transport();
  const owner = {};
  let release!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resumed = new Promise<void>(resolve => { finished = resolve; });
  const companion = new NetworkCompanion(connection, 'active', {
    callbackOwner: owner, operation: () => operation(15), resolveUrl: url => url, resolvePath: path => path,
  });
  await companion.route('**/api', async route => runCallbackScope(owner, () => {}, async () => {
    await gate;
    assert.throws(() => guardCallbackScope(owner), /no longer active/);
    await assert.rejects(async () => route.abort(), /no longer active/);
    finished();
  }), operation());
  pause(socket);
  await assert.rejects(companion.settle(operation()), { code: 'ACTION_FAILED' });
  release();
  await resumed;
  guardCallbackScope(owner);
  assert.equal(socket.commands.filter(command => command.method === 'Fetch.failRequest').length, 1);
});

test('completed route callbacks cannot launch deferred fixture work after returning a decision', async () => {
  const { connection, socket } = await transport();
  const owner = {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let deferred: Promise<void> | undefined;
  const companion = new NetworkCompanion(connection, 'active', {
    callbackOwner: owner, operation, resolveUrl: url => url, resolvePath: path => path,
  });
  await companion.route('**/api', async route => {
    deferred = gate.then(() => { guardCallbackScope(owner); });
    await route.fulfill({ body: 'complete' });
  }, operation());
  pause(socket);
  await companion.settle(operation());
  assert.ok(deferred);
  const rejection = assert.rejects(deferred, /no longer active|finished or expired/);
  release(); await rejection;
  guardCallbackScope(owner);
});

test('unawaited fallback keeps the older async handler live through its tracked decision', async () => {
  const { connection, socket } = await transport();
  const owner = {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const companion = new NetworkCompanion(connection, 'active', {
    callbackOwner: owner, operation, resolveUrl: url => url, resolvePath: path => path,
  });
  await companion.route('**/api', async route => {
    await gate;
    guardCallbackScope(owner);
    await route.fulfill({ body: 'older handler finished' });
  }, operation());
  await companion.route('**/api', route => { void route.fallback(); }, operation());
  pause(socket);
  await tick();
  release(); await companion.settle(operation());
  assert.equal(socket.commands.filter(command => command.method === 'Fetch.fulfillRequest').length, 1);
  assert.equal(socket.commands.filter(command => command.method === 'Fetch.failRequest').length, 0);
});

test('a route added during target initialization is fully installed before that target resumes', async () => {
  const { socket, hub } = await networkHub();
  let releaseAttach!: () => void;
  let releaseFetch!: () => void;
  socket.respondTo = (command) => {
    if (command.sessionId === 'popup-session' && command.method === 'Target.setAutoAttach') releaseAttach = () => socket.reply(command, {});
    else if (command.sessionId === 'popup-session' && command.method === 'Fetch.enable') releaseFetch = () => socket.reply(command, {});
    else socket.reply(command, {});
  };
  attachEvent(socket, 'popup', 'popup-session');
  await tick();
  const registration = hub.route('**/api', (route) => route.abort(), operation());
  await tick();
  releaseAttach();
  await tick();
  assert.equal(socket.commands.some((command) => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'popup-session'), false);
  releaseFetch();
  await registration;
  await hub.settle(operation());
  assert.equal(socket.commands.some((command) => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === 'popup-session'), true);
});

test('protected headers intercept requests without user routes and only owned values are removed off-site', async () => {
  const { connection, socket } = await transport();
  const companion = new NetworkCompanion(connection, 'active', {
    operation, resolveUrl: (url) => url, resolvePath: (path) => path,
    configuredHeaderNames: ['authorization', 'x-preview'],
    siteHeaders: (url) => new URL(url).hostname === 'app.test' ? { Authorization: 'Bearer protected', 'X-Preview': 'configured' } : undefined,
  });
  await companion.start(operation());
  assert.equal(socket.commands.some((command) => command.method === 'Fetch.enable'), true);
  pause(socket);
  await companion.settle(operation());
  const first = socket.commands.at(-1)!;
  assert.equal((first.params.headers as { name: string; value: string }[]).find((header) => header.name === 'authorization')?.value, 'Bearer protected');
  socket.event('Fetch.requestPaused', { requestId: 'redirected', request: { url: 'https://other.test/api', method: 'GET', headers: { Authorization: 'Bearer protected', 'X-Preview': 'configured', 'X-App': 'own' } } });
  await companion.settle(operation());
  assert.deepEqual(socket.commands.at(-1)!.params.headers, [{ name: 'x-app', value: 'own' }]);
  socket.event('Fetch.requestPaused', { requestId: 'application-owned', request: { url: 'https://other.test/api', method: 'GET', headers: { Authorization: 'Bearer application-owned' } } });
  await companion.settle(operation());
  assert.equal(socket.commands.at(-1)!.params.headers, undefined, 'Unrelated app Authorization remains unchanged');
});

test('Basic auth answers one matching server challenge and cancels repeats, proxy, mismatched, and off-scope challenges', async () => {
  const { connection, socket } = await transport();
  const companion = new NetworkCompanion(connection, 'active', {
    operation, resolveUrl: (url) => url, resolvePath: (path) => path,
    authorization: (url) => new URL(url).hostname === 'app.test' ? { username: 'test-user', password: 'synthetic-password' } : undefined,
  });
  await companion.start(operation());
  assert.equal(socket.commands.find((command) => command.method === 'Fetch.enable')!.params.handleAuthRequests, true);
  const auth = (id: string, requestUrl = 'https://app.test/private', origin = 'https://app.test', source = 'Server', scheme = 'basic') => {
    socket.event('Fetch.authRequired', { requestId: id, request: { url: requestUrl }, authChallenge: { source, origin, scheme, realm: 'test' } });
  };
  auth('one');
  await companion.settle(operation());
  assert.deepEqual(socket.commands.at(-1)!.params.authChallengeResponse, { response: 'ProvideCredentials', username: 'test-user', password: 'synthetic-password' });
  auth('one');
  auth('proxy', 'https://app.test/private', 'https://app.test', 'Proxy');
  auth('mismatch', 'https://app.test/private', 'https://other.test');
  auth('offscope', 'https://other.test/private', 'https://other.test');
  auth('digest', 'https://app.test/private', 'https://app.test', 'Server', 'digest');
  await companion.settle(operation());
  const answers = socket.commands.filter((command) => command.method === 'Fetch.continueWithAuth');
  assert.equal(answers.length, 6);
  for (const answer of answers.slice(1)) assert.deepEqual(answer.params.authChallengeResponse, { response: 'CancelAuth' });
  const encoded = Buffer.from('test-user:synthetic-password').toString('base64');
  socket.event('Fetch.requestPaused', { requestId: 'cross-site-redirect', request: { url: 'https://other.test/private', method: 'GET', headers: { Authorization: `Basic ${encoded}` } } });
  await companion.settle(operation());
  assert.deepEqual(socket.commands.at(-1)!.params.headers, []);
});

test('state probe reservation excludes its target before hooks or routes while unrelated popups are instrumented', async () => {
  const { socket, hub } = await networkHub();
  const initialized: string[] = [];
  await hub.registerSessionInitializer((_sessionId, targetId) => { initialized.push(targetId); }, operation());
  await hub.route('**/*', (route) => route.abort(), operation());
  let finishCreation!: () => void;
  socket.respondTo = (command) => {
    if (command.method === 'Target.createTarget') {
      attachEvent(socket, 'state-probe', 'probe-session');
      attachEvent(socket, 'unrelated-popup', 'popup-session');
      finishCreation = () => socket.reply(command, { targetId: 'state-probe' });
    } else socket.reply(command, command.method === 'Target.closeTarget' ? { success: true }
      : command.method === 'Target.getTargets' ? { targetInfos: [] } : {});
  };
  const creating = hub.createProbeTarget(operation());
  await tick();
  assert.deepEqual(initialized, ['main']);
  assert.equal(socket.commands.some((command) => command.sessionId === 'probe-session'), false);
  assert.equal(socket.commands.some((command) => command.sessionId === 'popup-session'), false);
  finishCreation();
  assert.equal(await creating, 'state-probe');
  await hub.settle(operation());
  assert.deepEqual(initialized, ['main', 'unrelated-popup']);
  assert.deepEqual(socket.commands.filter((command) => command.sessionId === 'probe-session').map((command) => command.method), ['Runtime.runIfWaitingForDebugger']);
  assert.equal(hub.getSession('state-probe'), undefined);
  assert.equal(hub.sessions().some((session) => session.targetId === 'state-probe'), false);
  assert.equal(socket.commands.some((command) => command.sessionId === 'popup-session' && command.method === 'Fetch.enable'), true);
  await assert.rejects(hub.sessionForTarget('state-probe', operation()), /cannot become application targets/);
  await hub.releaseProbeTarget('state-probe', operation());
  assert.deepEqual(socket.commands.findLast(command => command.method === 'Target.closeTarget')!.params, { targetId: 'state-probe' });
  await assert.rejects(hub.releaseProbeTarget('main', operation()), { code: 'INVALID_ARGUMENT' });
});

test('a closing state probe remains excluded until its exact target is no longer listed', async () => {
  const { socket, hub } = await networkHub();
  const initialized: string[] = [];
  await hub.registerSessionInitializer((_session, targetId) => { initialized.push(targetId); }, operation());
  let listing: Command | undefined;
  socket.respondTo = command => {
    if (command.method === 'Target.createTarget') {
      attachEvent(socket, 'probe', 'probe-session');
      socket.reply(command, { targetId: 'probe' });
    } else if (command.method === 'Target.closeTarget') socket.reply(command, { success: true });
    else if (command.method === 'Target.getTargets') listing = command;
    else socket.reply(command, {});
  };
  assert.equal(await hub.createProbeTarget(operation()), 'probe');
  let released = false;
  const release = hub.releaseProbeTarget('probe', operation()).then(() => { released = true; });
  await tick();
  assert.ok(listing);
  assert.equal(released, false, 'Close acknowledgement must not release probe ownership');
  attachEvent(socket, 'probe', 'late-probe-session');
  await tick();
  await assert.rejects(hub.sessionForTarget('probe', operation()), /cannot become application targets/);
  assert.deepEqual(initialized, ['main']);
  assert.equal(socket.commands.some(command => command.sessionId === 'late-probe-session' && command.method !== 'Runtime.runIfWaitingForDebugger'), false);
  socket.reply(listing, { targetInfos: [] });
  await release;
  assert.equal(released, true);
  assert.equal(socket.commands.filter(command => command.method === 'Target.closeTarget').length, 1);
});

test('uncertain probe creation closes the companion instead of admitting an unidentified late target', async () => {
  const { socket, hub } = await networkHub();
  const initialized: string[] = [];
  await hub.registerSessionInitializer((_sessionId, targetId) => { initialized.push(targetId); }, operation());
  socket.respondTo = (command) => {
    if (command.method === 'Target.createTarget') attachEvent(socket, 'unknown-probe', 'probe-session');
    else socket.reply(command, {});
  };
  await assert.rejects(hub.createProbeTarget(operation(10)), { code: 'ACTION_MAY_HAVE_COMMITTED' });
  await tick();
  assert.deepEqual(initialized, ['main']);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.commands.some((command) => command.sessionId === 'probe-session'), false);
});

test('Chromium verification rejects protocol emulators without exposing their product or protocol error', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = (command) => socket.reply(command, { product: 'HeadlessChrome/145.0.0.0', protocolVersion: '1.3' });
  await connection.verifyChromium(operation());
  socket.respondTo = (command) => socket.reply(command, { product: 'Lightpanda/secret-version', protocolVersion: '1.3' });
  await assert.rejects(connection.verifyChromium(operation()), (error: Error & { code?: string }) => error.code === 'UNSUPPORTED_CAPABILITY' && !error.message.includes('secret'));
  socket.respondTo = (command) => socket.protocolError(command);
  await assert.rejects(connection.verifyChromium(operation()), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('context ownership excludes foreign targets before routes, scripts, auth, or diagnostics and scopes state probes', async () => {
  const { connection, socket } = await transport();
  const target = (id: string, browserContextId?: string) => ({ targetId: id, type: 'page', url: 'about:blank', ...(browserContextId ? { browserContextId } : {}) });
  const owned = target('owned', 'attempt-context');
  const foreign = target('foreign', 'other-context');
  const excluded = target('excluded', 'attempt-context');
  const initialized: string[] = [];
  socket.respondTo = (command) => {
    if (command.method === 'Target.setDiscoverTargets') {
      for (const info of [owned, foreign, excluded]) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } }) }));
    }
    if (command.method === 'Target.autoAttachRelated') {
      const info = [owned, foreign, excluded].find(candidate => candidate.targetId === command.params.targetId)!;
      attachEvent(socket, info.targetId, `${info.targetId}-session`, undefined, 'page', info.browserContextId);
    }
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [owned, foreign, excluded] } : command.method === 'Target.createTarget' ? { targetId: 'probe' } : {});
  };
  const hub = new NetworkHub(connection, {
    operation, resolveUrl: (url) => url, resolvePath: (file) => file,
    browserContextId: 'attempt-context', includeTarget: (info) => info.targetId !== 'excluded',
    siteHeaders: () => ({ 'X-Secret': 'protected' }),
  });
  hub.onTarget((info) => { initialized.push(info.targetId); });
  await hub.start(operation());
  assert.deepEqual(initialized, ['owned']);
  assert.deepEqual(hub.sessions().map((session) => session.targetId), ['owned']);
  for (const id of ['foreign', 'excluded']) {
    assert.equal(socket.commands.some((command) => command.sessionId === `${id}-session` || command.params.targetId === id || command.params.sessionId === `${id}-session`), false);
    await assert.rejects(hub.sessionForTarget(id, operation()), /outside this attempt/);
  }
  assert.equal(socket.commands.some((command) => command.method === 'Target.attachToTarget'), false);
  assert.deepEqual(socket.commands.filter(command => command.method === 'Target.autoAttachRelated').map(command => command.params.targetId), ['owned']);
  assert.equal(socket.commands.some((command) => command.method === 'Target.setAutoAttach' && command.sessionId === undefined), false);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: target('foreign-new', 'other-context') } }) }));
  await hub.settle(operation());
  assert.equal(socket.commands.some((command) => command.params.targetId === 'foreign-new'), false);
  assert.equal(await hub.createProbeTarget(operation()), 'probe');
  assert.deepEqual(socket.commands.find((command) => command.method === 'Target.createTarget')!.params, { url: 'about:blank', background: true, browserContextId: 'attempt-context' });
});

test('exclusive default-context filtering never treats a hidden incognito context as an application target', async () => {
  const { connection, socket } = await transport();
  const hub = new NetworkHub(connection, { operation, resolveUrl: (url) => url, resolvePath: (file) => file, browserContextId: null });
  socket.respondTo = (command) => {
    if (command.method === 'Target.autoAttachRelated') {
      assert.equal(command.params.targetId, 'default');
      attachEvent(socket, 'default', 'default-session');
    }
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [
      { targetId: 'default', type: 'page', url: 'about:blank' },
      { targetId: 'hidden', type: 'page', url: 'about:blank', browserContextId: 'hidden-context' },
    ] } : {});
  };
  await hub.start(operation());
  assert.deepEqual(hub.sessions().map((session) => session.targetId), ['default']);
  assert.equal(socket.commands.some((command) => command.sessionId === 'hidden-session' && command.method === 'Network.enable'), false);
  assert.equal(socket.commands.some((command) => command.method === 'Target.setAutoAttach' && command.sessionId === undefined), false);
});

test('a verified concrete default context identity stays exact while default probe creation omits context parameters', async () => {
  const { connection, socket } = await transport();
  const configuration = {
    operation, resolveUrl: (url: string) => url, resolvePath: (file: string) => file,
    browserContextId: null, defaultBrowserContextId: 'verified-default',
  };
  const hub = new NetworkHub(connection, configuration);
  configuration.defaultBrowserContextId = 'foreign-context';
  const targets = [
    { targetId: 'default-page', type: 'page', url: 'about:blank', browserContextId: 'verified-default' },
    { targetId: 'foreign-page', type: 'page', url: 'about:blank', browserContextId: 'foreign-context' },
    { targetId: 'unidentified-page', type: 'page', url: 'about:blank' },
  ];
  socket.respondTo = command => {
    if (command.method === 'Target.autoAttachRelated') {
      assert.equal(command.params.targetId, 'default-page');
      attachEvent(socket, 'default-page', 'default-session', undefined, 'page', 'verified-default');
    }
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: targets }
      : command.method === 'Target.createTarget' ? { targetId: 'probe' } : {});
  };
  const initialized: string[] = [];
  hub.onTarget(target => { initialized.push(target.targetId); });
  await hub.start(operation());
  assert.equal(await hub.sessionForTarget('default-page', operation()), 'default-session');
  for (const target of targets.slice(1)) await assert.rejects(hub.sessionForTarget(target.targetId, operation()), /outside this attempt/);
  assert.deepEqual(initialized, ['default-page']);
  assert.deepEqual(socket.commands.filter(command => command.method === 'Target.autoAttachRelated').map(command => command.params.targetId), ['default-page']);
  assert.equal(await hub.createProbeTarget(operation()), 'probe');
  assert.deepEqual(socket.commands.find(command => command.method === 'Target.createTarget')!.params, { url: 'about:blank', background: true });
  assert.equal(socket.commands.some(command => command.method === 'Target.setAutoAttach' && command.sessionId === undefined), false);
});

test('a concrete default identity cannot broaden an unscoped or incognito scope', async () => {
  const { connection, socket } = await transport();
  const base = { operation, resolveUrl: (url: string) => url, resolvePath: (file: string) => file };
  for (const configuration of [
    { ...base, defaultBrowserContextId: 'default-id' },
    { ...base, browserContextId: 'incognito', defaultBrowserContextId: 'default-id' },
    ...['', 'private default', 'private\0default'].map(defaultBrowserContextId => ({ ...base, browserContextId: null, defaultBrowserContextId })),
  ]) assert.throws(() => new NetworkHub(connection, configuration), { code: 'INVALID_ARGUMENT' });
  assert.equal(socket.commands.length, 0);
});

test('scoped related-target monitoring configures owned popups and frames before resuming', async () => {
  const { connection, socket } = await transport();
  const owned = { targetId: 'owned', type: 'page', url: 'about:blank', browserContextId: 'context' };
  socket.respondTo = command => {
    if (command.method === 'Target.autoAttachRelated' && command.params.targetId === 'owned') attachEvent(socket, 'owned', 'owned-session', undefined, 'page', 'context');
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [owned] } : {});
  };
  const hub = new NetworkHub(connection, { operation, resolveUrl: url => url, resolvePath: file => file, browserContextId: 'context' });
  await hub.route('**/api', route => route.abort(), operation());
  const initialized: string[] = [];
  await hub.registerSessionInitializer((_session, target) => { initialized.push(target); }, operation());
  attachEvent(socket, 'popup', 'popup-session', 'owned-session', 'page', 'context');
  attachEvent(socket, 'frame', 'frame-session', 'owned-session', 'iframe', 'context');
  await hub.settle(operation());
  assert.deepEqual(initialized.toSorted(), ['frame', 'owned', 'popup']);
  for (const session of ['popup-session', 'frame-session']) {
    const enabled = socket.commands.findIndex(command => command.method === 'Fetch.enable' && command.sessionId === session);
    const resumed = socket.commands.findIndex(command => command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId === session);
    assert.ok(enabled >= 0 && resumed > enabled);
  }
  assert.deepEqual(socket.commands.filter(command => command.method === 'Target.autoAttachRelated').map(command => command.params.targetId), ['owned', 'popup']);
  assert.equal(socket.commands.some(command => command.method === 'Target.setAutoAttach' && command.sessionId === undefined), false);
});

test('scoped discovery waits for probe identity before attaching any newly discovered root', async () => {
  const { connection, socket } = await transport();
  const target = (id: string) => ({ targetId: id, type: 'page', url: 'about:blank', browserContextId: 'context' });
  const discover = (id: string) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: target(id) } }) }));
  let finishCreation: (() => void) | undefined;
  socket.respondTo = command => {
    if (command.method === 'Target.createTarget') {
      discover('probe'); discover('independent-page');
      finishCreation = () => socket.reply(command, { targetId: 'probe' });
      return;
    }
    if (command.method === 'Target.autoAttachRelated') attachEvent(socket, String(command.params.targetId), `${String(command.params.targetId)}-session`, undefined, 'page', 'context');
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [target('owned')] } : {});
  };
  const hub = new NetworkHub(connection, { operation, resolveUrl: url => url, resolvePath: file => file, browserContextId: 'context' });
  const initialized: string[] = [];
  hub.onTarget(info => { initialized.push(info.targetId); });
  await hub.start(operation());
  const creating = hub.createProbeTarget(operation());
  await tick();
  assert.deepEqual(initialized, ['owned']);
  assert.deepEqual(socket.commands.filter(command => command.method === 'Target.autoAttachRelated').map(command => command.params.targetId), ['owned']);
  assert.ok(finishCreation); finishCreation();
  assert.equal(await creating, 'probe');
  await hub.settle(operation());
  assert.deepEqual(initialized, ['owned', 'independent-page']);
  assert.equal(socket.commands.some(command => command.method === 'Target.autoAttachRelated' && command.params.targetId === 'probe'), false);
  assert.equal(hub.getSession('probe'), undefined);
});

test('scoped monitoring failure never falls back to browser-wide attachment', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = command => {
    if (command.method === 'Target.autoAttachRelated') { socket.protocolError(command); return; }
    socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'owned', type: 'page', url: 'about:blank', browserContextId: 'context' }] } : {});
  };
  const hub = new NetworkHub(connection, { operation, resolveUrl: url => url, resolvePath: file => file, browserContextId: 'context' });
  await assert.rejects(hub.start(operation()), { code: 'ENGINE_FAILURE' });
  assert.equal(socket.commands.some(command => command.method === 'Target.setAutoAttach' || command.method === 'Target.attachToTarget'), false);
});

test('closing a scoped hub cancels queued discovery before any target attachment', async () => {
  const { connection, socket } = await transport();
  socket.respondTo = command => socket.reply(command, command.method === 'Target.getTargets' ? { targetInfos: [] } : {});
  const hub = new NetworkHub(connection, { operation, resolveUrl: url => url, resolvePath: file => file, browserContextId: 'context' });
  await hub.start(operation());
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.targetCreated', params: {
    targetInfo: { targetId: 'late', type: 'page', url: 'about:blank', browserContextId: 'context' },
  } }) }));
  hub.close();
  await tick();
  assert.equal(socket.commands.some(command => command.method === 'Target.autoAttachRelated' || command.method === 'Target.attachToTarget'), false);
});

test('state and pixel readers may attach an additional owned-target session without being detached or reinstrumented', async () => {
  const { socket, hub } = await networkHub();
  const initialized: string[] = [];
  await hub.registerSessionInitializer((session) => { initialized.push(session); }, operation());
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.attachedToTarget', params: {
    sessionId: 'state-reader', targetInfo: { targetId: 'main', type: 'page', url: 'https://app.test/' }, waitingForDebugger: false,
  } }) }));
  attachEvent(socket, 'main', 'duplicate-paused-reader');
  await hub.settle(operation());
  assert.deepEqual(initialized, ['active']);
  assert.equal(hub.getSession('main'), 'active');
  assert.equal(socket.commands.some((command) => command.method === 'Target.detachFromTarget' && command.params.sessionId === 'state-reader'), false);
  assert.equal(socket.commands.some((command) => command.sessionId === 'state-reader'), false);
  assert.deepEqual(socket.commands.filter((command) => command.sessionId === 'duplicate-paused-reader').map((command) => command.method), ['Runtime.runIfWaitingForDebugger']);
});

test('non-finite CDP budgets fail before opening a socket or dispatching any command', async () => {
  for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) await assert.rejects(CdpConnection.connect('ws://localhost/browser', operation(timeout)), { code: 'OPERATION_TIMEOUT' });
  assert.equal(sockets.length, 0);
  const { connection, socket } = await transport();
  for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) await assert.rejects(connection.send('Page.navigate', {}, operation(timeout)), { code: 'OPERATION_TIMEOUT' });
  assert.equal(socket.commands.length, 0);
});

test('closing a hub suppresses a queued initializer and all continuation setup for a pending old target', async () => {
  const { socket, hub } = await networkHub();
  let initialized = 0;
  const registering = hub.registerSessionInitializer(() => { initialized += 1; }, operation());
  hub.close();
  await registering;
  assert.equal(initialized, 0);

  const fresh = await networkHub();
  let held: Command | undefined;
  let oldHooks = 0;
  fresh.hub.onTarget(() => { oldHooks += 1; });
  fresh.socket.respondTo = (command) => {
    if (command.method === 'Network.enable' && command.sessionId === 'late-old-target') held = command;
    else fresh.socket.reply(command, {});
  };
  attachEvent(fresh.socket, 'old-popup', 'late-old-target');
  await tick();
  assert.ok(held);
  fresh.hub.close();
  const before = fresh.socket.commands.length;
  fresh.socket.reply(held, {});
  await tick();
  assert.equal(oldHooks, 0);
  assert.equal(fresh.socket.commands.length, before, 'Late configuration must not issue any more commands after hub teardown');
  assert.equal(socket.commands.some((command) => command.method === 'Runtime.evaluate'), false);
});
