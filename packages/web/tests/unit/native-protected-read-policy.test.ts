import { PassThrough, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { isNativeNotDispatched, resultError } from '../../src/native/browser-channel.ts';
import type { NativeResult } from '../../src/native/protocol.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
async function fixture(effects: NativeResult['effects'], retired = false) {
  const output = new PassThrough();
  const requests: string[] = [];
  const send = (value: unknown) => queueMicrotask(() => output.write(`${JSON.stringify(value)}\n`));
  let live = true;
  const input = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request['type'] === 'hello') send({ type: 'ready', id: request['id'], protocol: 'agent-browser-session/1', sessionId: 'fixture', generation: 1, capabilities: [], limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
    else if (request['type'] === 'close') send({ type: 'closed', id: request['id'], generation: 1, scopeState: 'closed' });
    else {
      requests.push(request['command'] as string);
      if (retired) live = false;
      send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], ok: false,
        error: { code: 'policy-denied' }, effects, scopeState: 'usable' });
    }
    callback();
  } });
  const client = await NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, [], operation(), () => {});
  return { channel: new EngineChannel(client, () => () => live), client, requests };
}

for (const name of ['browser.observe', 'capture.screenshot'] as const) {
  it(`${name} preserves restored completed policy refusal without a no-dispatch/retry grant`, async () => {
    const f = await fixture('completed');
    try {
      const failure: unknown = await f.channel.command(name, { identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: '[data-secure]', options: { pixels: true } }, operation()).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: 'POLICY_DENIED', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(false);
      expect(f.requests).toEqual([name]);
    } finally { await f.client.close(operation()); }
  });
  it(`${name} still preserves a genuine not-dispatched refusal`, async () => {
    const f = await fixture('not-dispatched');
    try {
      const failure: unknown = await f.channel.command(name, { identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: '[data-secure]', options: { pixels: true } }, operation()).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: 'POLICY_DENIED', retryable: false });
      expect(isNativeNotDispatched(failure)).toBe(true);
    } finally { await f.client.close(operation()); }
  });
  it(`${name} cannot publish policy semantics after the captured owner retires`, async () => {
    const f = await fixture('completed', true);
    try { await expect(f.channel.command(name, { identityScope: 'scope', testIdAttribute: 'data-testid', secureFieldSelector: '[data-secure]', options: { pixels: true } }, operation())).rejects.toMatchObject({ code: 'CANCELLED' }); }
    finally { await f.client.close(operation()); }
  });
}
it('does not broaden completed policy mappings for other commands or dirty/unknown results', async () => {
  const f = await fixture('completed');
  try { await expect(f.channel.command('recording.stop', { identityScope: 'scope' }, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false }); }
  finally { await f.client.close(operation()); }
  for (const effects of ['completed', 'unknown'] as const) {
    const result: NativeResult = { type: 'result', id: 'r', generation: 1, operationSeq: 1, ok: false, error: { code: 'policy-denied' }, effects, scopeState: 'quarantined' };
    const failure = resultError(result);
    expect(failure).toMatchObject({ code: effects === 'unknown' ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', retryable: false });
    expect(isNativeNotDispatched(failure)).toBe(false);
  }
});
