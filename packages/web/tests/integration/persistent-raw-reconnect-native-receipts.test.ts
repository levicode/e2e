/** Candidate-only wrapper: all interceptions await/return actual native results. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import type { NativeResult } from '../../src/native/protocol.ts';

let closed = 0;
let closeFailures = 0;
const receipts: { command: string; result: NativeResult }[] = [];
beforeEach(() => {
  closed = 0; closeFailures = 0; receipts.length = 0;
  const close = NativeClient.prototype.close;
  vi.spyOn(NativeClient.prototype, 'close').mockImplementation(async function (this: NativeClient, ...args) {
    try { await Reflect.apply(close, this, args); closed++; }
    catch (cause) { closeFailures++; throw cause; }
  });
  const request = NativeClient.prototype.request;
  vi.spyOn(NativeClient.prototype, 'request').mockImplementation(async function (this: NativeClient, ...args) {
    const result = await Reflect.apply(request, this, args);
    if (['page.navigate', 'page.activate', 'scope.interop.identify', 'scope.reconnect'].includes(args[0])) receipts.push({ command: args[0], result });
    return result;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'persistent-raw-reconnect-native-receipts.json'), JSON.stringify({ closed, closeFailures, receipts }, null, 2));
  }
  expect(closed).toBe(1); expect(closeFailures).toBe(0);
  const navigations = receipts.filter(receipt => receipt.command === 'page.navigate');
  expect(navigations).toHaveLength(2);
  expect(navigations.every(receipt => receipt.result.ok)).toBe(true);
  // Raw-only disconnect does not require reconnecting the still-live native
  // channel. Do not manufacture a native reconnect requirement for this case.
});

// Register the identical public test, with no runtime skips or weaker assertions.
import './persistent-raw-reconnect.test.ts';
