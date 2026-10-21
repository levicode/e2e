import { afterEach, describe, expect, it, vi } from 'vitest';
const connect = vi.hoisted(() => vi.fn());
vi.mock('../../src/native/process.ts', () => ({ connectNativeProcess: (...args: unknown[]) => connect(...args) }));
import { connectNativeProcess } from '../../src/native/process.ts';
import { semanticFaultControl } from '../helpers/native-semantic-fault.ts';
const options = { executable: '/synthetic/native', cwd: '/synthetic', env: {}, capabilities: ['browser.observe/1'] };
const context = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'test', attemptId: 'test', origin: 'test' as const };
afterEach(() => { vi.restoreAllMocks(); connect.mockReset(); });
async function fixture() {
  const request = vi.fn(); const client = { request }; connect.mockResolvedValue(client);
  const faults = semanticFaultControl(); const onEvent = () => undefined;
  expect(await connectNativeProcess(options, context, onEvent)).toBe(client);
  expect(connect).toHaveBeenCalledWith(options, context, onEvent);
  return { faults, request };
}
describe('acceptance-only semantic fault helper', () => {
  it('delegates startup unchanged and retains scoped one-use control tokens', async () => {
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
});
