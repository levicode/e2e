/**
 * Attached-browser setup must fail before locator or secure-pixel use.
 * Playwright's private registerSelectorEngine channel and duplicate-name English
 * errors are obsolete mechanics. Their replacement is exact native capability
 * negotiation and typed configuration settlement, never error-string tolerance.
 * These peer tests do NOT prove selector matching or secure masking behavior;
 * real query/capture browser fixtures remain required independently.
 */
import { PassThrough, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';

const operation = (): OperationContext => ({ timeoutMs: 500, signal: new AbortController().signal, runId: 'setup', attemptId: 'a1', origin: 'test' });
function peer(capabilities: readonly string[] = REQUIRED_CAPABILITIES) {
  const output = new PassThrough(); const requests: Record<string, unknown>[] = [];
  const input = new Writable({ write(chunk: Buffer, _encoding, done) { requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>); done(); } });
  const dispose = vi.fn(() => { input.destroy(); output.destroy(); });
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const connecting = NativeClient.connect({ readable: output, writable: input, dispose }, [...REQUIRED_CAPABILITIES], operation(), () => {});
  send({ type: 'ready', id: requests[0]!['id'], protocol: 'agent-browser-session/1', sessionId: 'setup-peer', generation: 1, capabilities, limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' });
  const result = (extra: Record<string, unknown>) => {
    const request = requests.at(-1)!;
    send({ type: 'result', id: request['id'], generation: 1, operationSeq: request['operationSeq'], scopeState: 'usable', ...extra });
  };
  const close = async (client: NativeClient) => {
    const closing = client.close(operation()); send({ type: 'closed', id: requests.at(-1)!['id'], generation: 1, scopeState: 'closed' }); await closing;
  };
  return { connecting, requests, result, dispose, close };
}
const configuration = { identityScope: 'scope-1', testIdAttribute: 'data-testid', secureFieldSelector: 'input[type="password" i]', requestPolicy: {}, downloads: { source: 'local' } } as const;

it.each(['browser.query/1', 'browser.capture/1'])('refuses missing %s before any locator or capture command', async missing => {
  const fixture = peer(REQUIRED_CAPABILITIES.filter(capability => capability !== missing));
  await expect(fixture.connecting).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(fixture.requests.map(request => request['type'])).toEqual(['hello']);
  expect(fixture.dispose).toHaveBeenCalledTimes(1);
});

it('accepts only typed native configuration success, without selector-registration replay', async () => {
  const fixture = peer(); const client = await fixture.connecting; const channel = new EngineChannel(client);
  const configured = channel.command('scope.configure', configuration, operation());
  fixture.result({ ok: true, data: null, effects: 'completed' }); await expect(configured).resolves.toBeNull();
  expect(fixture.requests.filter(request => request['type'] === 'request').map(request => request['command'])).toEqual(['scope.configure']);
  await fixture.close(client);
});

it('does not tolerate an unrelated native setup rejection or retry it as a duplicate', async () => {
  const fixture = peer(); const client = await fixture.connecting; const channel = new EngineChannel(client);
  const configured = channel.command('scope.configure', configuration, operation());
  fixture.result({ ok: false, error: { code: 'unsupported-capability' }, effects: 'not-dispatched' });
  await expect(configured).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(fixture.requests.filter(request => request['type'] === 'request')).toHaveLength(1);
  await fixture.close(client);
});

it('rejects a malformed setup result even when it claims the old owned-selector duplicate message', async () => {
  const fixture = peer(); const client = await fixture.connecting; const channel = new EngineChannel(client);
  const configured = channel.command('scope.configure', configuration, operation());
  fixture.result({ ok: true, data: { message: '"e2e-read" selector engine has been already registered' }, effects: 'completed' });
  await expect(configured).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  expect(fixture.dispose).toHaveBeenCalledTimes(1);
});
