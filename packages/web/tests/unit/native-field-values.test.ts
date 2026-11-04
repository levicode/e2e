/** Closed native field wire contract, using only an in-memory protocol peer. */
import { PassThrough, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import type { EngineReadField, OperationContext } from 'e2e/engine';
import { NativeClient } from '../../src/native/client.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { decodeEngineResult } from '../../src/native/engine-decode.ts';
import { REQUIRED_CAPABILITIES } from '../../src/native/capabilities.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
const args = { identityScope: 'scope', expression: { kind: 'frame', selector: '#frame', source: { kind: 'selector', selector: '#field' } }, fields: ['text'], testIdAttribute: 'data-testid', secureFieldSelector: 'input[type=password]' } as const;
it('requires the negotiated capability before any ordinary operation and never falls back', async () => {
  const frames: Record<string, unknown>[] = []; const output = new PassThrough();
  const input = new Writable({ write(chunk: Buffer, _encoding, done) {
    const frame = JSON.parse(chunk.toString()) as Record<string, unknown>; frames.push(frame);
    if (frame['type'] === 'hello') queueMicrotask(() => output.write(JSON.stringify({ type: 'ready', id: frame['id'], protocol: 'agent-browser-session/1', sessionId: 'old-peer', generation: 1, capabilities: REQUIRED_CAPABILITIES.filter(cap => cap !== 'browser.fixture-read-fields/1'), limits: { maxFrameBytes: 1048576, maxPendingOperations: 64, maxPendingDecisions: 256, maxTimeoutMs: 3600000 }, scopeState: 'usable' }) + '\n'));
    done();
  } });
  await expect(NativeClient.connect({ readable: output, writable: input, dispose: () => { input.destroy(); output.destroy(); } }, REQUIRED_CAPABILITIES, operation(), () => {})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(frames.map(frame => frame['type'])).toEqual(['hello']);
});
it('retains exact frame diagnostics on the new field command', async () => {
  const peer = new NativeProtocolPeer([], () => ({ error: 'frame-not-found', frameSelection: { index: 0, count: 0 } }));
  const client = await peer.connect(operation(), () => {});
  try {
    await expect(new EngineChannel(client).command('fixture.read-fields', args, operation())).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', message: 'no frame matches #frame', retryable: true });
    expect(peer.requests).toHaveLength(1);
  } finally { await client.close(operation()); }
});
it.each([
  { identityScope: 'scope', revision: '1', values: [] },
  { identityScope: 'scope', values: [{ ref: { id: '@e1', revision: '1' }, states: { secure: false } }] },
  { identityScope: 'scope', values: [{ selector: '#unrequested', states: { secure: false } }] },
  { identityScope: 'scope', values: [{ text: 'secret', states: { secure: true } }] },
])('rejects reference authority or widened field data %#', data => {
  expect(() => decodeEngineResult('fixture.read-fields', data, args)).toThrow();
});
it('decodes every existing safe field without geometry or synthetic node references', () => {
  const value = { role: 'textbox', name: 'Name', text: 'text', value: 'value', selection: 'v', testId: 'field', inputPurpose: 'username', states: { secure: false, checked: false }, level: 1, attributes: { name: 'input' }, selector: '#field', framePath: ['#frame'] };
  const fields = Object.keys(value) as EngineReadField[];
  expect(decodeEngineResult('fixture.read-fields', { identityScope: 'scope', values: [value] }, { ...args, fields })).toEqual({ identityScope: 'scope', values: [value] });
});
