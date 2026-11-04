import type { NativeClient } from '../../src/native/client.ts';

/** Read only the original client's schema/correlation-validated, unclaimed exact-scope ticket. */
export function exactRecoveryTicketReady(client: NativeClient, expectedScope: string): boolean {
  if (expectedScope === '' || client.recoveryScope() !== expectedScope) return false;
  try {
    // This read-only checkpoint refuses failed, terminal, closed, closing,
    // claimed and callback-owned clients. It neither reconnects nor replays.
    client.reconnectCheckpoint(expectedScope);
    return true;
  } catch { return false; }
}
