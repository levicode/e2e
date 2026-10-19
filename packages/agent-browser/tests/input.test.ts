import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError, KEY_NAMES, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from '../src/cdp.ts';
import { InputController } from '../src/input.ts';

const operation = (): OperationContext => ({ runId: 'run', attemptId: 'attempt', origin: 'test', timeoutMs: 1_000, signal: new AbortController().signal });
function setup() {
  const calls: Array<{ method: string; params: Record<string, unknown>; session?: string }> = [];
  let poisoned = false;
  let session = 'first';
  let send: (() => Promise<unknown>) | undefined;
  const cdp = { async send(method: string, params: Record<string, unknown>, _context: OperationContext, sessionId?: string) {
    calls.push({ method, params, ...(sessionId === undefined ? {} : { session: sessionId }) });
    return await send?.();
  } };
  const input = new InputController({
    cdp: () => cdp as unknown as CdpConnection, session: () => session,
    assertUsable() { if (poisoned) throw new EngineError('INVALID_STATE', 'Poisoned', { retryable: false }); },
    markUncertain(): never { poisoned = true; throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Unknown input outcome', { retryable: false }); },
  });
  return { input, calls, get poisoned() { return poisoned; }, failWith(callback: () => Promise<unknown>) { send = callback; }, session(value: string) { session = value; } };
}

test('fractional pointer coordinates and held button masks are shared across movements and wheels', async () => {
  const { input, calls } = setup();
  await input.mouseMove(1.25, 2.75, operation());
  await input.mouseDown('left', operation(), 2);
  await input.mouseDown('right', operation());
  await input.mouseMove(3.125, 4.5, operation());
  await input.mouseWheel(-0.25, 3.75, operation());
  await input.mouseUp('left', operation(), 2);
  assert.deepEqual(calls[0]?.params, { type: 'mouseMoved', x: 1.25, y: 2.75, button: 'none', buttons: 0, modifiers: 0 });
  assert.equal(calls[1]?.params.clickCount, 2);
  assert.equal(calls[3]?.params.button, 'right');
  assert.equal(calls[3]?.params.buttons, 3);
  assert.deepEqual(calls[4]?.params, { type: 'mouseWheel', x: 3.125, y: 4.5, deltaX: -0.25, deltaY: 3.75, buttons: 3, modifiers: 0 });
  assert.equal(calls[5]?.params.clickCount, 2);
  assert.equal(input.buttons, 2);
  assert.deepEqual(input.position, { x: 3.125, y: 4.5 });
});

test('keyboard modifiers affect following key and mouse events without releasing unrelated keys', async () => {
  const { input, calls } = setup();
  await input.keyDown('Control', operation());
  await input.keyDown('Shift', operation());
  await input.keyDown('a', operation());
  await input.mouseDown('left', operation());
  await input.keyUp('Control', operation());
  await input.keyUp('a', operation());
  assert.equal(calls[0]?.params.modifiers, 2);
  assert.equal(calls[1]?.params.modifiers, 10);
  assert.deepEqual(calls[2]?.params, { type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, location: 0, text: '', unmodifiedText: 'A', modifiers: 10, autoRepeat: false });
  assert.equal(calls[3]?.params.modifiers, 10);
  assert.equal(calls[4]?.params.modifiers, 8);
  assert.equal(calls[5]?.params.type, 'keyUp');
  assert.equal(calls[5]?.params.modifiers, 8);
  assert.equal(input.modifiers, 8);
  assert.equal(input.isKeyDown('Shift'), true);
  assert.equal(input.isKeyDown('a'), false);
});

test('held physical keys emit repeat and printable key text follows held Shift', async () => {
  const { input, calls } = setup();
  await input.keyDown('a', operation());
  await input.keyDown('A', operation());
  await input.keyUp('a', operation());
  await input.keyDown('a', operation());
  await input.keyDown('Shift', operation());
  await input.keyDown('1', operation());
  await input.keyDown('/', operation());
  assert.equal(calls[0]?.params.autoRepeat, false);
  assert.equal(calls[1]?.params.autoRepeat, true);
  assert.equal(calls[1]?.params.text, 'A');
  assert.equal(calls[3]?.params.autoRepeat, false);
  assert.equal(calls[5]?.params.text, '!');
  assert.equal(calls[5]?.params.code, 'Digit1');
  assert.equal(calls[6]?.params.text, '?');
  assert.equal(calls[6]?.params.code, 'Slash');
});

test('all named keys and non-US printable keys use the public grammar', async () => {
  const { input, calls } = setup();
  for (const key of KEY_NAMES) { await input.keyDown(key, operation()); await input.keyUp(key, operation()); }
  await input.keyDown('🦊', operation());
  assert.equal(calls.at(-1)?.params.text, '🦊');
  assert.equal(calls.at(-1)?.params.code, '');
  await input.keyDown('ControlOrMeta', operation());
  assert.equal(calls.at(-1)?.params.modifiers, process.platform === 'darwin' ? 4 : 2);
  assert.equal(input.isKeyDown(process.platform === 'darwin' ? 'Meta' : 'Control'), true);
});

test('invalid coordinates, keys, buttons, and click counts never dispatch or expose arguments', async () => {
  const { input, calls } = setup();
  for (const task of [
    () => input.mouseMove(NaN, 0, operation()), () => input.mouseWheel(0, Infinity, operation()),
    () => input.mouseDown('private-button' as 'left', operation()), () => input.mouseDown('left', operation(), 0),
    () => input.keyDown('Control+private-secret', operation()), () => input.keyUp('Control+a', operation()),
  ]) await assert.rejects(task(), (error: unknown) => error instanceof Error && !error.message.includes('private') && 'code' in error && error.code === 'INVALID_ARGUMENT');
  assert.equal(calls.length, 0);
});

test('pre-cancelled and expired commands leave the browser usable without dispatching', async () => {
  const fixture = setup();
  await assert.rejects(fixture.input.keyDown('Shift', { ...operation(), timeoutMs: 100, signal: AbortSignal.abort('private-reason') }), { code: 'CANCELLED' });
  await assert.rejects(fixture.input.mouseMove(1, 2, { ...operation(), timeoutMs: 0 }), { code: 'OPERATION_TIMEOUT' });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.poisoned, false);
  assert.equal(fixture.input.modifiers, 0);
});

test('unknown dispatched mutation outcome poisons the surface and never updates acknowledged state', async () => {
  const fixture = setup();
  fixture.failWith(async () => { throw new Error('private protocol payload'); });
  await assert.rejects(fixture.input.keyDown('Shift', operation()), (error: unknown) => error instanceof EngineError && error.code === 'ACTION_MAY_HAVE_COMMITTED' && !error.retryable && !error.message.includes('private'));
  assert.equal(fixture.input.modifiers, 0);
  assert.equal(fixture.poisoned, true);
  await assert.rejects(fixture.input.mouseMove(2, 3, operation()), { code: 'INVALID_STATE' });
  assert.equal(fixture.calls.length, 1);
});

test('overlapping input rejects immediately while independent dialog handling can complete the command', async () => {
  const fixture = setup();
  let complete: (() => void) | undefined;
  fixture.failWith(() => new Promise<void>((resolve) => { complete = resolve; }));
  const first = fixture.input.keyDown('Shift', operation());
  assert.equal(fixture.input.isBusy, true);
  await assert.rejects(fixture.input.mouseMove(2, 3, operation()), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.throws(() => fixture.input.reset(), { code: 'INVALID_STATE' });
  assert.equal(fixture.calls.length, 1);
  assert.ok(complete); complete(); await first;
  assert.equal(fixture.input.isBusy, false);
  assert.equal(fixture.input.modifiers, 8);
  assert.equal(fixture.poisoned, false);
});

test('active target getters and reset do not retain state from the destroyed browser', async () => {
  const fixture = setup();
  await fixture.input.mouseMove(5.5, 7.75, operation());
  await fixture.input.keyDown('Alt', operation());
  await fixture.input.mouseDown('middle', operation());
  fixture.session('second');
  await fixture.input.mouseWheel(1, 2, operation());
  assert.equal(fixture.calls.at(-1)?.session, 'second');
  fixture.input.reset();
  assert.equal(fixture.input.modifiers, 0);
  assert.equal(fixture.input.buttons, 0);
  assert.equal(fixture.input.isKeyDown('Alt'), false);
  assert.deepEqual(fixture.input.position, { x: 0, y: 0 });
});

test('native pointer state updates the next companion event without rounding coordinates', async () => {
  const { input, calls } = setup();
  input.adoptPointer({ x: 45.125, y: 70.75, buttons: 0 });
  await input.mouseDown('left', operation());
  assert.equal(calls[0]?.params.x, 45.125);
  assert.equal(calls[0]?.params.y, 70.75);
  assert.throws(() => input.adoptPointer({ x: 1, y: 2, buttons: 0 }), { code: 'INVALID_STATE' });
});

test('native pointer state rejects malformed and ambiguous button masks before changing state', () => {
  const { input, calls } = setup();
  for (const value of [null, {}, { x: 1, y: Infinity, buttons: 0 }, { x: 1, y: 2, buttons: 32 },
    { x: 1, y: 2, buttons: 3 }, { x: 1, y: 2, buttons: 0, secret: 'private' }]) {
    assert.throws(() => input.adoptPointer(value), { code: 'ENGINE_FAILURE' });
    assert.deepEqual(input.position, { x: 0, y: 0 });
  }
  assert.equal(calls.length, 0);
});

test('a retired operation cannot dispatch input or let a late acknowledgement mutate the next attempt', async () => {
  let active = true;
  let dispatched = 0;
  let poisoned = 0;
  let resolve: (() => void) | undefined;
  const input = new InputController({
    cdp: () => ({ send: async () => { dispatched++; await new Promise<void>((done) => { resolve = done; }); } }) as unknown as CdpConnection,
    session: () => 'session', assertUsable() {},
    guardOperation() { if (!active) throw new EngineError('INVALID_STATE', 'Retired operation', { retryable: false }); },
    markUncertain(): never { poisoned++; throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'Unknown outcome', { retryable: false }); },
  });
  const pending = input.keyDown('Shift', operation());
  active = false;
  assert.ok(resolve); resolve();
  await assert.rejects(pending, { code: 'INVALID_STATE' });
  assert.equal(input.modifiers, 0);
  assert.equal(input.isBusy, false);
  assert.equal(poisoned, 0);
  await assert.rejects(input.mouseMove(1, 2, operation()), { code: 'INVALID_STATE' });
  assert.equal(dispatched, 1);
});
