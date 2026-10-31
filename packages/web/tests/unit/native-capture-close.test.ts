/** Pure close/process custody controls: no browser or native executable is started. */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
// Use the exact source engine contract, not an unrelated installed dist build.
vi.mock('e2e/engine', async () => import('../../../e2e/src/engine/index.ts'));
const ENV = ['E2E_ENGINE_SECRETS_CAPTURE', 'E2E_ENGINE_SECRETS_DIAGNOSTIC', 'E2E_ENGINE_SECRETS_CAPTURE_NONCE', 'E2E_NATIVE_DIAGNOSTIC_SUITE'] as const;
let saved: (string | undefined)[];
let lines: string[];
beforeEach(() => {
  vi.resetModules(); spawn.mockReset(); saved = ENV.map(key => process.env[key]); lines = [];
  process.env[ENV[0]] = '1'; process.env[ENV[1]] = '1'; process.env[ENV[2]] = 'a'.repeat(64); delete process.env[ENV[3]];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  ENV.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
});
const operation = (): OperationContext => ({ runId: 'pure-run', attemptId: 'pure-attempt', origin: 'test', signal: new AbortController().signal, timeoutMs: 1000 });
const closedRows = () => lines.filter(line => /^(ENGINE_SECRETS|UNSERVED_MODEL)_DIAGNOSTIC /.test(line)).map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)) as Record<string, unknown>);
const closes = () => closedRows().filter(row => row['kind'] === 'close');
async function modules() {
  const diagnostics = await import('../../src/native/secrets-diagnostics.ts');
  const { NativeClient } = await import('../../src/native/client.ts');
  const surface = diagnostics.createSecretsSurface()!; const owner = surface.start()!;
  return { diagnostics, NativeClient, surface, owner };
}
async function opened(options: { settle?: (context: OperationContext) => Promise<void>; writeFailure?: boolean; capabilities?: readonly string[] } = {}) {
  const m = await modules(); const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>; requests.push(request);
    callback(request['type'] === 'close' && options.writeFailure ? new Error('PRIVATE_WRITE_CANARY') : undefined);
  } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const settle = vi.fn(options.settle ?? (async () => {}));
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const connecting = m.NativeClient.connect({ readable: output, writable: input, dispose, settle }, options.capabilities ?? [], operation(), () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'pure', generation: 1, capabilities: options.capabilities ?? [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const client = await connecting;
  const confirm = () => send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' });
  return { ...m, client, requests, output, input, dispose, settle, send, confirm };
}
function unreadableBudget() {
  let reads = 0;
  const context = { ...operation(), get timeoutMs(): number { reads++; throw new Error('PRIVATE_BUDGET_CANARY'); } };
  return { context, reads: () => reads };
}

describe('actual NativeClient close branches', () => {
  it('preserves the existing failure object without a close exchange or budget read', async () => {
    const f = await opened(); const error = f.client.invalidate(); const budget = unreadableBudget();
    await expect(f.diagnostics.withSecretsContext(f.owner, () => f.client.close(budget.context))).rejects.toBe(error);
    expect(f.requests.map(row => row['type'])).toEqual(['hello']); expect(f.settle).not.toHaveBeenCalled(); expect(budget.reads()).toBe(0);
    expect(closes()).toEqual([expect.objectContaining({ stage: 'existing-client-failure', outcome: 'failed', closedFrameConfirmed: false })]);
  });
  it('runs close exchange then settle once, without reading the expired caller budget', async () => {
    const f = await opened(); const budget = unreadableBudget();
    const pending = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(budget.context));
    expect(f.settle).not.toHaveBeenCalled(); f.confirm(); await pending;
    expect(f.requests.map(row => row['type'])).toEqual(['hello', 'close']); expect(f.settle).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce(); expect(budget.reads()).toBe(0);
    expect(f.settle.mock.calls[0]![0].timeoutMs).toBeGreaterThan(0); expect(f.settle.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(15000);
    expect(closes()).toEqual([expect.objectContaining({ stage: 'post-settle', outcome: 'completed', closedFrameConfirmed: true })]);
  });
  it('reuses the exact promise and preserves the first receipt owner through later invocation', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await opened({ settle: () => gate });
    const first = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation())); f.confirm(); await Promise.resolve();
    const newer = f.surface.start()!;
    const second = f.diagnostics.withSecretsContext(newer, () => f.client.close(operation()));
    expect(second).toBe(first); expect(f.requests.filter(row => row['type'] === 'close')).toHaveLength(1);
    release(); await first;
    expect(closes().find(row => row['stage'] === 'reuse-existing-close')?.['attempt']).toBe(newer.attempt);
    expect(closes().find(row => row['outcome'] === 'completed')?.['attempt']).toBe(f.owner.attempt);
    expect(f.settle).toHaveBeenCalledOnce();
  });
  it('observes a real exchange rejection before Closed without calling channel settle', async () => {
    const f = await opened({ writeFailure: true });
    await expect(f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation()))).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(f.settle).not.toHaveBeenCalled(); expect(closes()).toEqual([expect.objectContaining({ stage: 'close-exchange', outcome: 'failed', closedFrameConfirmed: false })]);
    expect(lines.join('')).not.toContain('PRIVATE_WRITE_CANARY');
  });
  it('hits the defensive non-Closed branch only via an explicit private exchange-result mock', async () => {
    const f = await opened();
    // The real wire reader rejects this earlier: this is defensive-branch evidence, not a valid wire scenario.
    const exchange = vi.spyOn(f.client as unknown as { exchange: (...args: unknown[]) => Promise<unknown> }, 'exchange').mockResolvedValue({ type: 'result' });
    await expect(f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation()))).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(exchange).toHaveBeenCalledOnce(); expect(f.settle).not.toHaveBeenCalled();
    expect(closes()).toEqual([expect.objectContaining({ stage: 'close-exchange', outcome: 'failed', closedFrameConfirmed: false })]);
  });
  it('distinguishes Closed followed by settle rejection without inspecting the thrown payload', async () => {
    let reads = 0; const cause = Object.defineProperties({}, { message: { get() { reads++; return 'PRIVATE_CAUSE_CANARY'; } }, code: { get() { reads++; return 'PRIVATE_CAUSE_CANARY'; } } });
    const f = await opened({ settle: async () => { throw cause; } });
    const pending = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation())); f.confirm();
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(reads).toBe(0); expect(f.settle).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce();
    expect(closes()).toEqual([expect.objectContaining({ stage: 'channel-settle', outcome: 'failed', closedFrameConfirmed: true, code: 'unknown' })]);
    expect(lines.join('')).not.toContain('PRIVATE_CAUSE_CANARY');
  });
  it('preserves an exact failure discovered after settle', async () => {
    let failure: unknown; let fail!: () => unknown;
    const f = await opened({ settle: async () => { failure = fail(); } }); fail = () => f.client.invalidate();
    const pending = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation())); f.confirm();
    const rejected = await pending.catch(error => error); expect(rejected).toBe(failure);
    expect(closes()).toEqual([expect.objectContaining({ stage: 'post-settle', outcome: 'failed', closedFrameConfirmed: true })]);
  });
  it('diagnostic sink failure changes neither success nor the original failure object', async () => {
    const f = await opened(); const budget = unreadableBudget();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('PRIVATE_SINK_CANARY'); });
    const pending = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(budget.context)); f.confirm(); await pending;
    expect(f.settle).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce(); expect(budget.reads()).toBe(0);
    const g = await opened(); const error = g.client.invalidate();
    await expect(g.diagnostics.withSecretsContext(g.owner, () => g.client.close(budget.context))).rejects.toBe(error);
  });
  it('automatic close without a process binding stays unjoined rather than inventing a slot', async () => {
    const f = await opened({ capabilities: ['terminal.close/1'] });
    const query = f.diagnostics.withSecretsContext(f.owner, () => f.client.request('fixture.query', {}, operation()));
    const request = f.requests.at(-1)!;
    f.send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'stale-scope' }, effects: 'unknown', scopeState: 'quarantined' });
    await query; expect(f.requests.at(-1)!['type']).toBe('close');
    const later = f.surface.start()!;
    const joined = f.diagnostics.withSecretsContext(later, () => f.client.close(operation())); f.confirm(); await joined;
    expect(closes().filter(row => row['outcome'] === 'completed')).toHaveLength(0);
    expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toHaveLength(0);
  });
});

async function processOpened(pid = 45123, capabilities: readonly string[] = [], beforeReady?: () => void) {
  const m = await modules(); const { connectNativeProcess } = await import('../../src/native/process.ts');
  const requests: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn() });
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) { requests.push(JSON.parse(chunk.toString())); callback(); }, final(callback) { child.exitCode = 0; child.emit('exit', 0, null); callback(); } });
  const processChild = Object.assign(child, { stdin }); spawn.mockReturnValueOnce(processChild);
  const pending = m.diagnostics.withSecretsContext(m.owner, () => connectNativeProcess({ executable: '/verified/synthetic-native', cwd: '/synthetic', env: { PRIVATE_ENV_CANARY: 'PRIVATE_ENV_CANARY' }, capabilities }, operation(), () => {}));
  beforeReady?.();
  child.stdout.write(`${JSON.stringify({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'pure-process', generation: 1, capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' })}\n`);
  const client = await pending;
  const close = async () => { const work = m.diagnostics.withSecretsContext(m.owner, () => client.close(operation())); child.stdout.write(`${JSON.stringify({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' })}\n`); await work; };
  return { ...m, child: processChild, client, requests, close };
}

describe('private process identity and suite isolation', () => {
  it('uses the exact spawned child PID before the connected client is returned', async () => {
    const f = await processOpened(45123); await f.close();
    expect(spawn).toHaveBeenCalledOnce(); expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false }); expect(f.child.kill).not.toHaveBeenCalled();
    expect(closedRows().filter(row => row['kind'] === 'process-binding')).toEqual([expect.objectContaining({ client: 1, proxyPid: 45123 })]);
    expect(lines.join('')).not.toContain('PRIVATE_ENV_CANARY'); expect(lines.join('')).not.toContain('/verified/synthetic-native');
  });
  it('reports failed automatic close through only its original private process slot', async () => {
    const f = await processOpened(45125, ['terminal.close/1']);
    const query = f.diagnostics.withSecretsContext(f.owner, () => f.client.request('fixture.query', {}, operation()));
    const request = f.requests.at(-1)!;
    f.child.stdout.write(`${JSON.stringify({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false, error: { code: 'stale-scope' }, effects: 'unknown', scopeState: 'quarantined' })}\n`);
    await query; expect(f.requests.at(-1)!['type']).toBe('close');
    const joined = f.client.close(operation()); f.child.exitCode = 1;
    f.child.stdout.write(`${JSON.stringify({ type: 'closed', id: f.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' })}\n`);
    await expect(joined).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(closedRows().filter(row => row['kind'] === 'close')).toHaveLength(0);
    expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toEqual([expect.objectContaining({ reason: 'owner-unjoined', captureNonce: 'a'.repeat(64) })]);
  });
  it('keeps two real process-adapter clients with the same generation distinct', async () => {
    const first = await processOpened(45131); const second = await processOpened(45132);
    await first.close(); await second.close();
    const bindings = closedRows().filter(row => row['kind'] === 'process-binding');
    expect(bindings.map(row => row['proxyPid'])).toEqual([45131, 45132]);
    expect(bindings[0]!['client']).not.toBe(bindings[1]!['client']);
    expect(closes().map(row => row['client'])).toEqual(bindings.map(row => row['client']));
  });
  it('does not mint a binding from a missing-positive process identifier', async () => {
    const f = await processOpened(0); await f.close();
    expect(closedRows().filter(row => row['kind'] === 'process-binding')).toHaveLength(0);
  });
  it('freezes process suite and nonce before awaiting connect rather than binding ambient replacement', async () => {
    const f = await processOpened(45141, [], () => { process.env[ENV[3]] = 'unserved-model-two-workers'; process.env[ENV[2]] = 'b'.repeat(64); });
    const other = f.diagnostics.createSecretsSurface()!; other.start();
    const closing = f.client.close(operation()); f.child.exitCode = 1;
    f.child.stdout.write(`${JSON.stringify({ type: 'closed', id: f.requests.at(-1)!['id'], generation: 1, scopeState: 'closed' })}\n`);
    await expect(closing).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    const replacement = lines.filter(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC ')).map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)));
    expect(replacement.filter(row => row.kind === 'capture-loss' || row.kind === 'process-binding')).toHaveLength(0);
    delete process.env[ENV[3]]; process.env[ENV[2]] = 'a'.repeat(64);
    f.surface.emit(f.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
    expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toEqual([expect.objectContaining({ reason: 'owner-unjoined', captureNonce: 'a'.repeat(64) })]);
  });
  it('does not invent a PID binding for a client created directly from a pure channel', async () => {
    const f = await opened(); const pending = f.diagnostics.withSecretsContext(f.owner, () => f.client.close(operation())); f.confirm(); await pending;
    expect(closedRows().filter(row => row['kind'] === 'process-binding')).toHaveLength(0);
  });
  it('separates each suite cap and never routes a retained owner into the current suite', async () => {
    const m = await modules();
    for (let index = 0; index < 100; index++) m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
    expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toHaveLength(1);
    process.env[ENV[3]] = 'unserved-model-two-workers'; process.env[ENV[2]] = 'b'.repeat(64);
    const other = m.diagnostics.createSecretsSurface()!; const owner = other.start()!;
    other.emit(owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
    expect(lines.filter(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC '))).toHaveLength(3);
    expect(lines.filter(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC ')).every(line => JSON.parse(line.slice(line.indexOf(' ') + 1)).captureNonce === 'b'.repeat(64))).toBe(true);
  });
  it('retains a late owner when the ambient suite and nonce have changed', async () => {
    const m = await modules(); process.env[ENV[3]] = 'unserved-model-two-workers'; process.env[ENV[2]] = 'b'.repeat(64);
    const other = m.diagnostics.createSecretsSurface()!; other.start();
    m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
    expect(lines.filter(line => line.startsWith('UNSERVED_MODEL_DIAGNOSTIC '))).toHaveLength(1);
    delete process.env[ENV[3]]; process.env[ENV[2]] = 'a'.repeat(64);
    m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
    const old = lines.filter(line => line.startsWith('ENGINE_SECRETS_DIAGNOSTIC ')).map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)));
    expect(old.filter(row => row.kind === 'capture-loss')).toEqual([expect.objectContaining({ captureNonce: 'a'.repeat(64), reason: 'owner-unjoined' })]);
    expect(old.filter(row => row.kind === 'retirement')).toEqual([expect.objectContaining({ captureNonce: 'a'.repeat(64), attempt: m.owner.attempt })]);
  });
});


it('owner-unjoined remains visible while later legitimate rows stay under the shared producer bound', async () => {
  const m = await modules(); m.surface.loss('owner-unjoined');
  for (let index = 0; index < 1000; index++) m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
  const rows = closedRows(); expect(rows.length).toBeLessThanOrEqual(64);
  expect(rows.filter(row => row['kind'] === 'capture-loss')).toHaveLength(1);
  expect(rows.some(row => row['kind'] === 'retirement')).toBe(true);
});

it('caps no-owner process binding at the same sixteen admitted clients', async () => {
  const m = await modules(); const ticket = m.diagnostics.captureSecretsProcessContext(); const clients = Array.from({ length: 17 }, () => ({}));
  for (let i = 0; i < 16; i++) m.diagnostics.bindSecretsClientProcess(clients[i]!, 47000 + i, ticket);
  for (let i = 0; i < 16; i++) m.diagnostics.observeSecretsClose(clients[i]!, m.owner, 'post-settle', 'completed', true);
  expect(closedRows().filter(row => row['kind'] === 'process-binding')).toHaveLength(16);
  m.diagnostics.bindSecretsClientProcess(clients[16]!, 47016, ticket);
  const count = lines.length;
  m.diagnostics.observeSecretsClose(clients[16]!, m.owner, 'post-settle', 'completed', true);
  m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
  expect(lines).toHaveLength(count); expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toEqual([expect.objectContaining({ reason: 'client-cap' })]);
});
it('a later cap stops emission after owner-unjoined without allocating another loss slot', async () => {
  const m = await modules(); const ticket = m.diagnostics.captureSecretsProcessContext(); m.surface.loss('owner-unjoined');
  for (let i = 0; i < 17; i++) m.diagnostics.bindSecretsClientProcess({}, 48000 + i, ticket);
  const count = lines.length; m.surface.emit(m.owner, { kind: 'retirement', stage: 'unknown', before: 'undefined', after: 'value' });
  expect(lines).toHaveLength(count); expect(closedRows().filter(row => row['kind'] === 'capture-loss')).toEqual([expect.objectContaining({ reason: 'owner-unjoined' })]);
  expect(closedRows().length).toBeLessThanOrEqual(64);
});
