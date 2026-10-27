/** Pure renderer-callback checks: no browser, native engine, network, or synthetic DOM dispatch. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { pointerEvents, primitiveFixtureDocument, waitForPointerWheel } from '../../packages/web/tests/helpers/public-primitive-fixture.ts';
import { SYNTHETIC_CASE_MANIFEST, validSyntheticFact } from '../../packages/web/tests/helpers/synthetic-evidence.ts';

const EXACT_EVENTS = ['down:30:130:1', 'up:30:130:0', 'wheel:40'];
type Listener = (event: Record<string, unknown>) => void;

/** Run the actual fixture script and serialized callback against a minimal event/timer model. */
function renderer() {
  const listeners = new Map<string, Set<Listener>>();
  const timers = new Map<number, { callback: () => void; timeoutMs: number }>();
  let timerId = 0;
  const context = createContext({
    sessionStorage: { getItem: () => null, setItem: () => undefined },
    addEventListener: (type: string, listener: Listener) => {
      const group = listeners.get(type) ?? new Set<Listener>(); group.add(listener); listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener); },
    setTimeout: (callback: () => void, timeoutMs: number) => { timers.set(++timerId, { callback, timeoutMs }); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const script = primitiveFixtureDocument('/a').match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInContext(script, context);
  const read = runInContext(`(${pointerEvents.toString()})`, context) as typeof pointerEvents;
  const wait = runInContext(`(${waitForPointerWheel.toString()})`, context) as typeof waitForPointerWheel;
  const notify = (type: string, event: Record<string, unknown>): void => {
    const currentListeners = [...(listeners.get(type) ?? [])];
    for (const listener of currentListeners) listener(event);
  };
  notify('mousedown', { clientX: 30, clientY: 130, buttons: 1 });
  notify('mouseup', { clientX: 30, clientY: 130, buttons: 0 });
  return { read: () => Array.from(read()), wait, notify, timers, listeners };
}

test('shared frame fixture separates the button and input without disabling pointer hit testing', () => {
  for (const path of ['/a', '/frame']) {
    const html = primitiveFixtureDocument(path);
    assert.match(html, /id="input" class="fixture-input" style="position:absolute;left:10px;top:10px"/);
    assert.match(html, /id="frame-button" style="position:absolute;left:10px;top:50px" onclick="this.dataset.clicked='yes'"/);
    assert.doesNotMatch(html, /pointer-events|dispatchEvent|\.click\(/);
  }
  assert.match(primitiveFixtureDocument('/a'), /<iframe src="\/frame" style="position:absolute;left:400px;top:100px">/);
  assert.doesNotMatch(primitiveFixtureDocument('/frame'), /<iframe/);
});

test('serialized wheel witness waits for trusted delivery and retains exact pointer coordinates/buttons', async () => {
  const page = renderer();
  const before = page.read();
  const pending = page.wait(1_000);
  assert.deepEqual(before, EXACT_EVENTS.slice(0, 2));
  assert.equal(page.listeners.get('wheel')?.size, 2);
  assert.deepEqual([...page.timers.values()].map(timer => timer.timeoutMs), [1_000]);
  page.notify('wheel', { isTrusted: true, deltaY: 40 });
  assert.deepEqual(Array.from(await pending), EXACT_EVENTS);
  assert.deepEqual(before, EXACT_EVENTS.slice(0, 2));
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.get('wheel')?.size, 1);
});

test('already delivered wheel is read without another listener, timer, or input dispatch', async () => {
  const page = renderer();
  page.notify('wheel', { isTrusted: true, deltaY: 40 });
  assert.deepEqual(Array.from(await page.wait(1_000)), EXACT_EVENTS);
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.get('wheel')?.size, 1);
});

test('missing delivery times out with unchanged evidence and still fails the exact event contract', async () => {
  const page = renderer();
  const pending = page.wait(1_000);
  const pendingTimers = [...page.timers.values()];
  for (const timer of pendingTimers) timer.callback();
  const events = Array.from(await pending);
  assert.deepEqual(events, EXACT_EVENTS.slice(0, 2));
  assert.throws(() => assert.deepEqual(events, EXACT_EVENTS));
  assert.equal(page.timers.size, 0);
  assert.equal(page.listeners.get('wheel')?.size, 1);
});

test('untrusted wheel callbacks neither populate the ledger nor satisfy the delivery witness', async () => {
  const page = renderer();
  const pending = page.wait(1_000);
  page.notify('wheel', { isTrusted: false, deltaY: 40 });
  assert.deepEqual(page.read(), EXACT_EVENTS.slice(0, 2));
  assert.equal(page.timers.size, 1);
  assert.equal(page.listeners.get('wheel')?.size, 2);
  const pendingTimers = [...page.timers.values()];
  for (const timer of pendingTimers) timer.callback();
  assert.throws(() => assert.deepEqual(Array.from(page.read()), EXACT_EVENTS));
  assert.deepEqual(Array.from(await pending), EXACT_EVENTS.slice(0, 2));
});

test('wrong delta and duplicate wheel delivery remain failures rather than being normalized away', async () => {
  for (const deltas of [[41], [40, 40]]) {
    const page = renderer();
    for (const deltaY of deltas) page.notify('wheel', { isTrusted: true, deltaY });
    const events = Array.from(await page.wait(1_000));
    assert.deepEqual(events.slice(2), deltas.map(delta => `wheel:${delta}`));
    assert.throws(() => assert.deepEqual(events, EXACT_EVENTS));
  }
});

test('witness budgets cannot exceed one second or become unbounded', () => {
  const page = renderer();
  for (const budget of [0, -1, 1_001, Infinity, NaN]) assert.throws(() => page.wait(budget), /bounded by 1,000 ms/);
  assert.equal(page.timers.size, 0);
});

test('public and both backend controls use the identical witness and retain exact event assertions', () => {
  const source = readFileSync(new URL('../../packages/e2e/tests/integration/web-native-primitives-contract.test.ts', import.meta.url), 'utf8');
  const control = readFileSync(new URL('../../packages/web/tests/integration/events-synthetic-controls.test.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/\.evaluate\(waitForPointerWheel, 1_000\)/g)?.length, 1);
  assert.equal(control.match(/\.evaluate\(waitForPointerWheel, 1_000\)/g)?.length, 2);
  const exact = "expect(events).toEqual(['down:30:130:1', 'up:30:130:0', 'wheel:40'])";
  assert.equal(source.split(exact).length - 1, 1);
  assert.equal(control.split(exact).length - 1, 2);
  assert.match(source, /await frame\.locator\('#frame-button'\)\.tap\(\)/);
  assert.match(source, /getAttribute\('data-clicked'\)\)\.toBe\('yes'\)/);
  assert.match(source, /not\.toHaveClass\(browser\.locator\('#input'\), 'missing'\)/);
  assert.doesNotMatch(source + control, /(?:test|it)\.(?:skip|todo)\(/);
});

test('shared fixture and witness are bound into every consuming evidence source closure', () => {
  for (const id of ['C01', 'C02', 'C01N', 'C01PW', 'P05PW'] as const) {
    assert.ok(SYNTHETIC_CASE_MANIFEST[id].sources.some(source => source === 'packages/web/tests/helpers/public-primitive-fixture.ts'));
  }
});

test('delivery-witness evidence stays distinct from immediate samples and cannot claim a CDP ACK', () => {
  const witness = { kind: 'wheel-sample', phase: 'delivery-witness', sampleOrdinal: 2,
    downCount: 1, upCount: 1, wheelCount: 1, expectedDeltaSeen: true, nativePublicResultObserved: false, cdpAckObserved: null };
  for (const id of ['C01', 'C01N', 'C01PW'] as const) {
    assert.equal(validSyntheticFact(witness, id), true);
    assert.equal(validSyntheticFact({ ...witness, wheelCount: 0, expectedDeltaSeen: false }, id), true);
    assert.equal(validSyntheticFact({ ...witness, sampleOrdinal: 0 }, id), false);
    assert.equal(validSyntheticFact({ ...witness, phase: 'original-sample' }, id), false);
    assert.equal(validSyntheticFact({ ...witness, cdpAckObserved: true }, id), false);
  }
  assert.equal(validSyntheticFact(witness, 'C02'), false);
});
