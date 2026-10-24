import { appendFileSync } from 'node:fs';
import { afterAll, vi } from 'vitest';
import { NativeClient } from '__E2E_SOURCE_ROOT__/packages/web/src/native/client.ts';

const file = process.env['STARTUP_NEGOTIATION_FILE'];
if (!file) throw new Error('Missing negotiation evidence file');
const original = NativeClient.prototype.request;
const observed = new WeakSet<NativeClient>();
const spy = vi.spyOn(NativeClient.prototype, 'request').mockImplementation(function (this: NativeClient, ...args) {
  if (!observed.has(this)) {
    observed.add(this);
    try {
      appendFileSync(file, JSON.stringify({ schemaVersion: 1, kind: 'validated-native-negotiation', observedMonotonicUs: Number(process.hrtime.bigint() / 1000n), ordinal: nextOrdinal++, ...this.negotiation() }) + '\n');
    } catch { /* Missing negotiation evidence stays unknown; preserve the original operation. */ }
  }
  return original.apply(this, args);
});
let nextOrdinal = 0;
afterAll(() => spy.mockRestore());
