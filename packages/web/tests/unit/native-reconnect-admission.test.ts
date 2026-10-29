/** Framed in-memory results only; no native executable, browser, or socket. */
import { expect, it } from 'vitest';
import { EngineError } from 'e2e/engine';
import { EngineChannel, isNativeReconnectAdmissionRefusal } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer, type PeerOutcome } from '../helpers/native-protocol-peer.ts';

const operation = () => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'admission', attemptId: 'one', origin: 'test' as const });
const refused = { error: 'stale-scope', effects: 'not-dispatched', scopeState: 'quarantined' } as const;

async function failureFromWire(outcome: PeerOutcome, command: 'scope.reconnect' | 'scope.interop.identify' = 'scope.reconnect') {
  const peer = new NativeProtocolPeer(['terminal.close/1'], () => outcome);
  const client = await peer.connect(operation(), () => {});
  try {
    const channel = new EngineChannel(client);
    return await (command === 'scope.reconnect'
      ? channel.command(command, { identityScope: 'scope', endpoint: 'ws://synthetic.invalid', expectedBrowserIdentity: 'browser', expectedContextIdentity: 'context', expectedPageIdentity: 'page' }, operation())
      : channel.command(command, { identityScope: 'scope' }, operation())).catch((cause: unknown) => cause);
  } finally { try { await client.close(operation()); } finally { peer.dispose(); } }
}

it('brands only the actual validated quarantined reconnect admission refusal', async () => {
  const failure = await failureFromWire(refused);
  expect(failure).toMatchObject({ code: 'INVALID_STATE', retryable: false });
  expect(isNativeReconnectAdmissionRefusal(failure)).toBe(true);
  expect(isNativeReconnectAdmissionRefusal(new EngineError('INVALID_STATE', 'The native browser operation failed (stale-scope)', { retryable: false }))).toBe(false);
  expect(isNativeReconnectAdmissionRefusal({ code: 'INVALID_STATE', message: 'The native browser operation failed (stale-scope)' })).toBe(false);
});

it.each([
  { label: 'another command', command: 'scope.interop.identify', outcome: refused },
  { label: 'unknown effects', command: 'scope.reconnect', outcome: { ...refused, effects: 'unknown' } },
  { label: 'completed effects', command: 'scope.reconnect', outcome: { ...refused, effects: 'completed' } },
  { label: 'cleanup failure', command: 'scope.reconnect', outcome: { ...refused, error: 'cleanup-failed' } },
  { label: 'different rejection', command: 'scope.reconnect', outcome: { ...refused, error: 'browser-failure' } },
  { label: 'usable scope', command: 'scope.reconnect', outcome: { ...refused, scopeState: 'usable' } },
  { label: 'closed scope', command: 'scope.reconnect', outcome: { ...refused, scopeState: 'closed' } },
] as const)('does not grant admission-refusal attribution to $label', async ({ command, outcome }) => {
  expect(isNativeReconnectAdmissionRefusal(await failureFromWire(outcome, command))).toBe(false);
});
