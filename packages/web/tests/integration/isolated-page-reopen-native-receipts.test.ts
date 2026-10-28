/** Candidate-only real receipts; never loaded by the original public gate. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { NativeClient } from '../../src/native/client.ts';
import type { NativeResult } from '../../src/native/protocol.ts';

let closed = 0; let closeFailures = 0;
const receipts: { command: string; expectedPage: unknown; result: NativeResult }[] = [];
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
    if (['page.navigate', 'page.activate', 'scope.interop.identify', 'scope.reconnect'].includes(args[0])) receipts.push({ command: args[0], expectedPage: args[1]['expectedPage'], result });
    return result;
  });
});
afterEach(context => {
  vi.restoreAllMocks();
  const ownership = context.task.name.includes('(borrowed)') ? 'borrowed' : 'owned';
  const directory = process.env['E2E_INTEROP_EVIDENCE_DIR'];
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true });
    // Preserve real receipts before any acceptance assertion can throw.
    writeFileSync(path.join(directory, `isolated-page-reopen-native-${ownership}.json`), JSON.stringify({ closed, closeFailures, receipts }, null, 2));
  }
  expect(closed).toBe(1); expect(closeFailures).toBe(0);
  const navigations = receipts.filter(receipt => receipt.command === 'page.navigate');
  expect(navigations).toHaveLength(3); expect(navigations.every(receipt => receipt.result.ok)).toBe(true);
  if (directory === undefined) throw new Error('Native identity receipts require E2E_INTEROP_EVIDENCE_DIR');
  const publicEvidence = JSON.parse(readFileSync(path.join(directory, `isolated-page-reopen-${ownership}.json`), 'utf8')) as {
    before: { contextId: string; targetId: string };
    observations: { after: { contextId: string; targetId: string } }[];
  };
  const identities = [publicEvidence.before, ...publicEvidence.observations.map(observation => observation.after)];
  expect(identities).toHaveLength(3);
  for (const [index, receipt] of navigations.entries()) {
    const identity = identities[index]!;
    expect(receipt.expectedPage).toEqual({ contextId: identity.contextId, targetId: identity.targetId });
  }
});

// Same public scenarios and assertions, not a replacement/synthetic case.
import './isolated-page-reopen.test.ts';
