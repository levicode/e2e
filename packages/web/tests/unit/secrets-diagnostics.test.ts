/** Browser-free diagnostic controls; no engine, browser or native process is started. */
import { test } from 'vitest';
import assert from 'node:assert/strict';

const source = new URL('../../src/native/secrets-diagnostics.ts', import.meta.url);
const names = ['E2E_ENGINE_SECRETS_CAPTURE', 'E2E_ENGINE_SECRETS_DIAGNOSTIC', 'E2E_ENGINE_SECRETS_CAPTURE_NONCE'] as const;
let fixture = 0;
async function controlled(run: (module: typeof import('../../src/native/secrets-diagnostics.ts'), lines: string[]) => void | Promise<void>): Promise<void> {
  const previous = names.map(name => process.env[name]);
  const write = process.stderr.write;
  const lines: string[] = [];
  try {
    process.env[names[0]] = '1'; process.env[names[1]] = '1'; process.env[names[2]] = 'a'.repeat(64);
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    await run(await import(`${source.href}?control=${++fixture}`), lines);
  } finally {
    process.stderr.write = write;
    names.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  }
}
function rows(lines: string[]): Record<string, unknown>[] { return lines.filter(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC ')).map(line => JSON.parse(line.slice('ENGINE_SECRETS_DIAGNOSTIC '.length))); }
const result = { error: { code: 'cancelled' }, effects: 'unknown', scopeState: 'closed' };
const wire = { generation: 1, operationSeq: 7, transmittedTimeoutMs: 500, cancellation: 'OPERATION_TIMEOUT' as const, timeoutRewritten: false, cancelAckSeen: false };

test('opt-in and nonce are mandatory; disabled wrapper preserves exact throw', async () => controlled((m, lines) => {
  delete process.env[names[0]];
  assert.equal(m.createSecretsSurface(), undefined);
  const failure = {};
  assert.throws(() => m.withSecretsContext(undefined, () => { throw failure; }), value => value === failure);
  process.env[names[0]] = '1'; process.env[names[2]] = 'not-a-nonce';
  assert.equal(m.createSecretsSurface(), undefined); assert.equal(lines.length, 0);
}));

test('worker identity is stable; two surfaces and clients with equal wire IDs do not collide', async () => controlled((m, lines) => {
  const a = m.createSecretsSurface()!; const b = m.createSecretsSurface()!;
  const ca = a.start()!; const cb = b.start()!;
  const clientA = {}; const clientB = {};
  m.observeSecretsQuery(clientA, ca, 'fixture.query', result, result, wire);
  m.observeSecretsQuery(clientB, cb, 'fixture.query', result, result, wire);
  m.observeSecretsQuery(clientA, ca, 'fixture.query', result, result, wire);
  const projected = rows(lines); const query = projected.filter(row => row['kind'] === 'query');
  assert.equal(ca.workerToken, cb.workerToken); assert.match(ca.workerToken, /^[a-f0-9]{64}$/);
  assert.notEqual(ca.surface, cb.surface); assert.equal(ca.attempt, cb.attempt);
  assert.notEqual(query[0]?.['client'], query[1]?.['client']); assert.equal(query[0]?.['client'], query[2]?.['client']);
  assert.ok(Object.isFrozen(ca));
}));

test('async contexts preserve original receipt owner across interleaving', async () => controlled(async (m) => {
  const a = m.createSecretsSurface()!.start()!; const b = m.createSecretsSurface()!.start()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = m.withSecretsContext(a, async () => { await gate; assert.equal(m.captureSecretsContext(), a); });
  await m.withSecretsContext(b, async () => { await Promise.resolve(); assert.equal(m.captureSecretsContext(), b); release(); });
  await delayed; assert.equal(m.captureSecretsContext(), undefined);
}));

test('unknown code and private payload are never serialized; getters are not invoked', async () => controlled((m, lines) => {
  const surface = m.createSecretsSurface()!; const context = surface.start()!; const canary = 'PRIVATE_DIAGNOSTIC_CANARY';
  let reads = 0;
  const raw = { error: { code: canary, message: canary }, effects: 'unknown', scopeState: 'closed', payload: canary };
  m.observeSecretsQuery({}, context, 'fixture.query', raw, raw, wire);
  const hostile = Object.defineProperty({ effects: 'unknown', scopeState: 'closed' }, 'error', { get() { reads++; throw new Error(canary); } });
  m.observeSecretsQuery({}, context, 'fixture.query', hostile, raw, wire);
  const budget = Object.defineProperty({ ...wire }, 'transmittedTimeoutMs', { get() { reads++; throw new Error(canary); } });
  m.observeSecretsQuery({}, context, 'fixture.query', raw, raw, budget);
  surface.emit(context, { kind: 'start', payload: canary } as never);
  surface.emit(context, Object.defineProperty({}, 'kind', { get() { reads++; return canary; } }) as never);
  assert.equal(reads, 0); assert.ok(!lines.join('').includes(canary));
  const query = rows(lines).filter(row => row['kind'] === 'query'); assert.equal(query[0]?.['rawCode'], 'unknown');
}));

test('eight query failures and one overflow marker, no unbounded repeated rows', async () => controlled((m, lines) => {
  const context = m.createSecretsSurface()!.start()!; const client = {};
  for (let index = 0; index < 1000; index++) m.observeSecretsQuery(client, context, 'fixture.query', result, result, wire);
  assert.equal(rows(lines).filter(row => row['kind'] === 'query').length, 8);
  assert.equal(rows(lines).filter(row => row['kind'] === 'overflow').length, 1);
  assert.ok(lines.every(line => line.length <= 2048));
}));

test('sink failure cannot replace exact result or thrown object', async () => controlled((m) => {
  const surface = m.createSecretsSurface()!; const context = surface.start()!; const original = { result: true };
  process.stderr.write = (() => { throw new Error('sink unavailable'); }) as typeof process.stderr.write;
  assert.equal(m.withSecretsContext(context, () => { surface.emit(context, { kind: 'start' }); return original; }), original);
  const error = {};
  assert.throws(() => m.withSecretsContext(context, () => { m.observeSecretsQuery({}, context, 'fixture.query', result, result, wire); throw error; }), value => value === error);
}));

test('bounded identities and changed invocation suppress stale context', async () => controlled((m, lines) => {
  const surface = m.createSecretsSurface()!; const first = surface.start()!;
  for (let index = 1; index < 16; index++) assert.ok(surface.start());
  assert.equal(surface.start(), undefined);
  const before = lines.length; process.env[names[2]] = 'b'.repeat(64);
  surface.emit(first, { kind: 'start' }); assert.equal(lines.length, before);
}));


test('forged context is inert and reentrant sink cannot recurse or replace assigned state', async () => controlled((m) => {
  const surface = m.createSecretsSurface()!; const context = surface.start()!;
  const forged = { captureNonce: 'a'.repeat(64), workerToken: 'b'.repeat(64), surface: 99, attempt: 99 };
  assert.equal(m.withSecretsContext(forged, () => m.captureSecretsContext()), undefined);
  let state: unknown; const first = {}; let calls = 0;
  process.stderr.write = (() => {
    calls++; assert.equal(state, first);
    state ??= {};
    surface.emit(context, { kind: 'retirement', stage: 'unknown', before: 'value', after: 'value' });
    return true;
  }) as typeof process.stderr.write;
  const before = state === undefined ? 'undefined' : 'value';
  state ??= first;
  surface.emit(context, { kind: 'retirement', stage: 'unknown', before, after: 'value' });
  assert.equal(state, first); assert.equal(calls, 1);
}));


test('malformed closed facts stay unknown or omitted rather than fabricating cancellation/closure', async () => controlled((m, lines) => {
  const context = m.createSecretsSurface()!.start()!;
  const invalid = { error: { code: 'secret-value' }, effects: 'secret-value', scopeState: 'secret-value' };
  m.observeSecretsQuery({}, context, 'fixture.query', invalid, invalid, { ...wire, cancellation: undefined });
  const row = rows(lines).find(value => value['kind'] === 'query')!;
  assert.equal(row['rawScopeState'], 'unknown'); assert.equal(row['rawEffects'], 'unknown'); assert.equal(row['rawCode'], 'unknown');
  assert.equal(row['selectedLocalCancel'], 'none'); assert.equal(row['cancelAckSeen'], false);
  const before = lines.length;
  m.observeSecretsQuery({}, context, 'fixture.query', result, result, { ...wire, cancellation: 'secret-value' } as never);
  m.observeSecretsQuery({}, context, 'fixture.query', result, result, { ...wire, cancelAckSeen: undefined } as never);
  assert.equal(lines.length, before); assert.ok(!lines.join('').includes('secret-value'));
}));

test('client identity loss is visible and sticky even without exhausting row budget', async () => controlled((m, lines) => {
  const surface = m.createSecretsSurface()!; const context = surface.start()!;
  for (let index = 0; index < 100; index++) m.observeSecretsQuery({}, context, 'fixture.query', result, result, wire);
  const observed = rows(lines); assert.equal(observed.filter(row => row['kind'] === 'query').length, 16);
  assert.deepEqual(observed.filter(row => row['kind'] === 'capture-loss').map(row => row['reason']), ['client-cap']);
  assert.equal(observed.length, 18); assert.equal(m.createSecretsSurface(), undefined);
  const loss = observed.at(-1)!; assert.ok(!('surface' in loss)); assert.ok(!('attempt' in loss));
}));

test('surface cap and attempt cap produce one owner-free loss row each', async () => {
  await controlled((m, lines) => {
    for (let index = 0; index < 16; index++) assert.ok(m.createSecretsSurface());
    for (let index = 0; index < 100; index++) assert.equal(m.createSecretsSurface(), undefined);
    assert.equal(rows(lines).length, 1); assert.equal(rows(lines)[0]?.['reason'], 'surface-cap');
  });
  await controlled((m, lines) => {
    const surface = m.createSecretsSurface()!;
    for (let index = 0; index < 16; index++) assert.ok(surface.start());
    for (let index = 0; index < 100; index++) assert.equal(surface.start(), undefined);
    assert.equal(rows(lines).length, 17); assert.equal(rows(lines).at(-1)?.['reason'], 'attempt-cap');
  });
});

test('producer output is capped at 63 ordinary rows plus one reserved sticky loss', async () => controlled((m, lines) => {
  const surface = m.createSecretsSurface()!; const context = surface.start()!;
  for (let index = 0; index < 1000; index++) surface.emit(context, { kind: 'retirement', stage: 'unknown', before: 'null', after: 'value' });
  const observed = rows(lines); assert.equal(observed.length, 64);
  assert.equal(observed.at(-1)?.['kind'], 'capture-loss'); assert.equal(observed.at(-1)?.['reason'], 'row-cap');
  surface.loss('owner-unjoined'); assert.equal(rows(lines).length, 64);
}));

test('missing owner emits explicit worker loss without inventing nearby attempt identity', async () => controlled((m, lines) => {
  const surface = m.createSecretsSurface()!;
  surface.loss('owner-unjoined'); surface.loss('owner-unjoined');
  const observed = rows(lines); assert.equal(observed.length, 1);
  assert.equal(observed[0]?.['reason'], 'owner-unjoined'); assert.ok(!('surface' in observed[0]!)); assert.ok(!('attempt' in observed[0]!));
  assert.equal(surface.start(), undefined);
}));
