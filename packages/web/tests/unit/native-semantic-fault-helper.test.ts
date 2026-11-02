import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const connect = vi.hoisted(() => vi.fn());
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: (...args: unknown[]) => connect(...args) }));
import { connectNativeProcess } from '../../src/native/process.ts';
import { semanticFaultControl } from '../helpers/native-semantic-fault.ts';
import { SEMANTIC_FAULT_BINDING_ENV, SEMANTIC_FAULT_EXECUTABLE_ENV, semanticFaultEnvironment } from '../helpers/semantic-fault-runtime.ts';
const options = { executable: '/synthetic/native', cwd: '/synthetic', env: {}, capabilities: ['browser.observe/1'] };
const context = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' as const };
let directory: string; let binary: string;
beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'semantic-fault-helper-'));
  binary = join(directory, 'fault-native'); writeFileSync(binary, 'verified fixture bytes, never executed');
  const env = semanticFaultEnvironment(process.env, { binary, binding: {
    binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), negotiationProofSha256: '1'.repeat(64),
  } });
  vi.stubEnv(SEMANTIC_FAULT_EXECUTABLE_ENV, env[SEMANTIC_FAULT_EXECUTABLE_ENV]);
  vi.stubEnv(SEMANTIC_FAULT_BINDING_ENV, env[SEMANTIC_FAULT_BINDING_ENV]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); connect.mockReset(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const request = vi.fn(); const client = { request }; connect.mockResolvedValue(client);
  const faults = semanticFaultControl(); const onEvent = () => undefined;
  expect(await connectNativeProcess(options, context, onEvent)).toBe(client);
  expect(connect).toHaveBeenCalledWith({ ...options, executable: binary, capabilities: [...options.capabilities, 'acceptance.faults/1'] }, context, onEvent);
  return { faults, request };
}
describe('acceptance-only semantic fault helper', () => {
  it('selects only the fixture executable, requires fault negotiation and retains scoped one-use control tokens', async () => {
    const { faults, request } = await fixture();
    request.mockResolvedValueOnce({ ok: true, data: { token: 'owned' } })
      .mockResolvedValueOnce({ ok: true, data: { phase: 'semantic-publish', state: 'expired', allocatedRefs: ['@e7'] } })
      .mockResolvedValueOnce({ ok: true, data: { released: true } });
    const hold = await faults.holdNext('semantic-publish', 'scope-1');
    expect(await hold.reached()).toMatchObject({ state: 'expired', allocatedRefs: ['@e7'] });
    await hold.release();
    expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['test.fault.arm', { identityScope: 'scope-1', phase: 'semantic-publish' }],
      ['test.fault.status', { identityScope: 'scope-1', token: 'owned' }],
      ['test.fault.release', { identityScope: 'scope-1', token: 'owned' }],
    ]);
  });
  it('closes an unexpected second real client before rejecting ownership', async () => {
    await fixture(); const close = vi.fn().mockResolvedValue(undefined);
    connect.mockResolvedValueOnce({ request: vi.fn(), close });
    await expect(connectNativeProcess(options, context, () => undefined)).rejects.toThrow('exactly one native client');
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]![0].signal.aborted).toBe(false);
  });
  it('surfaces failed cleanup of an unexpected second client', async () => {
    await fixture(); const cleanup = new Error('synthetic cleanup failure');
    connect.mockResolvedValueOnce({ request: vi.fn(), close: vi.fn().mockRejectedValue(cleanup) });
    await expect(connectNativeProcess(options, context, () => undefined)).rejects.toMatchObject({ errors: [expect.any(Error), cleanup] });
  });
  it('fails rather than skips when a production binary rejects test controls', async () => {
    const { faults, request } = await fixture();
    request.mockResolvedValue({ ok: false, error: { code: 'unsupported-capability' } });
    await expect(faults.holdNext('semantic-acquire', 'scope-1')).rejects.toThrow('production binaries must reject');
  });
  it('requires explicit observed scope before any request', async () => {
    const { faults, request } = await fixture();
    await expect(faults.holdNext('semantic-acquire', undefined)).rejects.toThrow('identity scope');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects duplicate or noncanonical staged reference evidence', async () => {
    const { faults, request } = await fixture();
    request.mockResolvedValueOnce({ ok: true, data: { token: 'owned' } })
      .mockResolvedValueOnce({ ok: true, data: { phase: 'semantic-publish', state: 'reached', allocatedRefs: ['@e7', '@e7'] } });
    const hold = await faults.holdNext('semantic-publish', 'scope-1');
    await expect(hold.reached()).rejects.toThrow('Invalid acceptance fault status');
  });
  it('keeps the production executable and inherited environment unchanged', async () => {
    vi.stubEnv('E2E_AGENT_BROWSER_EXECUTABLE', '/production/native');
    const binding = process.env[SEMANTIC_FAULT_BINDING_ENV];
    await fixture();
    expect(process.env['E2E_AGENT_BROWSER_EXECUTABLE']).toBe('/production/native');
    expect(process.env[SEMANTIC_FAULT_BINDING_ENV]).toBe(binding);
    expect(options.executable).toBe('/synthetic/native');
    expect(options.capabilities).toEqual(['browser.observe/1']);
  });
  it('rejects a missing verified binding before connecting', async () => {
    vi.stubEnv(SEMANTIC_FAULT_BINDING_ENV, undefined);
    semanticFaultControl();
    await expect(connectNativeProcess(options, context, () => undefined)).rejects.toThrow('verified semantic fault');
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects the installer role and extra binding fields before connecting', async () => {
    const binding = JSON.parse(process.env[SEMANTIC_FAULT_BINDING_ENV]!);
    for (const value of [{ ...binding, purpose: 'installer-cancellation-loopback' }, { ...binding, caseId: 'P14' }]) {
      vi.stubEnv(SEMANTIC_FAULT_BINDING_ENV, JSON.stringify(value));
      const faults = semanticFaultControl();
      await expect(connectNativeProcess(options, context, () => undefined)).rejects.toThrow('verified semantic fault');
      faults.restore();
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects changed bytes or a wrong binary SHA before connecting', async () => {
    const binding = JSON.parse(process.env[SEMANTIC_FAULT_BINDING_ENV]!);
    for (const digest of ['2'.repeat(64), binding.binarySha256]) {
      vi.stubEnv(SEMANTIC_FAULT_BINDING_ENV, JSON.stringify({ ...binding, binarySha256: digest }));
      if (digest === binding.binarySha256) writeFileSync(binary, 'changed fixture bytes');
      const faults = semanticFaultControl();
      await expect(connectNativeProcess(options, context, () => undefined)).rejects.toThrow('verified semantic fault');
      faults.restore();
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects an executable alias before connecting', async () => {
    const alias = join(directory, 'alias'); symlinkSync(binary, alias);
    vi.stubEnv(SEMANTIC_FAULT_EXECUTABLE_ENV, alias);
    semanticFaultControl();
    await expect(connectNativeProcess(options, context, () => undefined)).rejects.toThrow('verified semantic fault');
    expect(connect).not.toHaveBeenCalled();
  });
});
