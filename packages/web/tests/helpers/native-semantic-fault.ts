/** Acceptance-only controls. This module is never part of the published build. */
import { setTimeout as delay } from 'node:timers/promises';
import { vi } from 'vitest';
import type { JsonValue, OperationContext } from 'e2e/engine';
import type { NativeClient } from '../../src/native/client.ts';
import * as transport from '../../src/native/process.ts';

export type SemanticFaultPhase = 'semantic-acquire' | 'semantic-publish';
export interface SemanticFaultStatus {
  readonly phase: SemanticFaultPhase;
  readonly state: 'armed' | 'reached' | 'expired' | 'released';
  readonly allocatedRefs: readonly string[];
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid acceptance fault response');
  return value as Record<string, unknown>;
}
function status(value: unknown, phase: SemanticFaultPhase): SemanticFaultStatus {
  const data = record(value);
  if (data['phase'] !== phase || !['armed', 'reached', 'expired', 'released'].includes(String(data['state'])) ||
    !Array.isArray(data['allocatedRefs']) || data['allocatedRefs'].length > 4096 ||
    !data['allocatedRefs'].every((ref: unknown) => typeof ref === 'string' && /^@e[1-9]\d*$/.test(ref)) ||
    new Set(data['allocatedRefs']).size !== data['allocatedRefs'].length) throw new Error('Invalid acceptance fault status');
  return { phase, state: data['state'] as SemanticFaultStatus['state'], allocatedRefs: data['allocatedRefs'] as string[] };
}

/** Capture the actual client, without replacing startup, negotiation, or browser work. */
export function semanticFaultControl() {
  let client: NativeClient | undefined;
  const connect = transport.connectNativeProcess;
  const spy = vi.spyOn(transport, 'connectNativeProcess').mockImplementation(async (...args) => {
    const connected = await connect(...args);
    if (client !== undefined) {
      const failure = new Error('Acceptance fault fixture must own exactly one native client');
      try {
        await connected.close({ signal: new AbortController().signal, timeoutMs: 5000, runId: 'acceptance-fault-cleanup', attemptId: 'acceptance-fault-cleanup', origin: 'test' });
      } catch (cleanup) {
        throw new AggregateError([failure, cleanup], 'Unexpected acceptance client failed cleanup', { cause: cleanup });
      }
      throw failure;
    }
    client = connected;
    return connected;
  });
  async function request(command: string, args: Record<string, JsonValue>, timeoutMs = 5000): Promise<unknown> {
    if (client === undefined) throw new Error('Acceptance fault fixture has no connected native client');
    const operation: OperationContext = { signal: new AbortController().signal, timeoutMs, runId: 'acceptance-fault', attemptId: 'acceptance-fault', origin: 'test' };
    const result = await client.request(command, args, operation);
    if (!result.ok) throw new Error(`Acceptance fault control failed: ${result.error?.code ?? 'invalid-response'}. Build the native acceptance-faults feature; production binaries must reject these commands.`);
    return result.data;
  }
  return {
    restore: () => spy.mockRestore(),
    async holdNext(phase: SemanticFaultPhase, identityScope: string | undefined) {
      if (!identityScope) throw new Error('Acceptance fault requires the observed native identity scope');
      const armed = record(await request('test.fault.arm', { identityScope, phase }));
      if (typeof armed['token'] !== 'string' || armed['token'].length === 0) throw new Error('Invalid acceptance fault token');
      const token = armed['token'];
      return {
        async reached(): Promise<SemanticFaultStatus> {
          const deadline = performance.now() + 5000;
          while (performance.now() < deadline) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) break;
            const value = status(await request('test.fault.status', { identityScope, token }, remaining), phase);
            if (value.state === 'reached' || value.state === 'expired') return value;
            if (value.state === 'released') throw new Error('Acceptance fault was released before reaching its phase');
            await delay(5);
          }
          throw new Error('Native semantic fault was not reached');
        },
        async release(): Promise<void> {
          const value = record(await request('test.fault.release', { identityScope, token }));
          if (value['released'] !== true) throw new Error('Native semantic fault was not released');
        },
      };
    },
  };
}
