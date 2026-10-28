/** Test-only observation. No result replacement, retries, dialog choices, or native ownership. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { test as webTest } from '@e2e-dev/web';

const directory = process.env['E2E_PLATFORM_DIALOG_DIAGNOSTIC_DIR'];
const state = { handlerEntered: false, acceptCalled: false, acceptPromiseResolved: false, acceptPromiseRejected: false, handlerReturned: false, handlerThrew: false, assertionThrown: false };
const CODES = ['invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable', 'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'invalid-locator', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'locator-not-found', 'content-length-mismatch', 'redirect-body-unavailable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'fill-unsupported-target', 'no-editable-focus', 'tap-target-replaced-before-press', 'frame-not-found', 'frame-ambiguous'] as const;
const EFFECTS = ['not-dispatched', 'completed', 'unknown'] as const;
const SCOPES = ['usable', 'quarantined', 'closed'] as const;
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const token = (value: unknown, allowed: readonly string[]): string => typeof value === 'string' && allowed.includes(value) ? value : value === undefined ? 'absent' : 'other';
let emitted = 0;
let dropped = 0;
function record(phase: 'installed' | 'handler-entered' | 'accept-called' | 'accept-resolved' | 'accept-rejected' | 'handler-returned' | 'handler-threw' | 'perform-result' | 'attempt-ended', result?: unknown): void {
  if (directory === undefined) return;
  if (emitted >= 32) { dropped++; return; }
  const receipt = object(result);
  const row = { schemaVersion: 1, phase, sequence: emitted++, cap: 32, droppedBefore: dropped, ...state,
    ...(result === undefined ? {} : { ok: receipt['ok'] === true, code: token(object(receipt['error'])['code'], CODES), effects: token(receipt['effects'], EFFECTS), scopeState: token(receipt['scopeState'], SCOPES) }) };
  // Diagnostic I/O cannot change the native result, handler result, or assertion.
  try { mkdirSync(directory, { recursive: true }); appendFileSync(path.join(directory, `dialog-${process.pid}.jsonl`), JSON.stringify(row) + '\n'); } catch { /* observation lost */ }
}

if (directory !== undefined) {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@e2e-dev/web');
  const clientModule = pathToFileURL(path.join(path.dirname(entry), 'native/client.js')).href;
  type Request = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  const { NativeClient } = await import(clientModule) as { NativeClient: { prototype: { request: Request } } };
  const original = NativeClient.prototype.request;
  NativeClient.prototype.request = async function (...args: unknown[]): Promise<unknown> {
    const result = await original.apply(this, args);
    if (args[0] === 'browser.perform') record('perform-result', result);
    return result;
  };
  record('installed');
}

export function installDialogReceipt(test: typeof webTest): void {
  test.beforeEach(async ({ browser }) => {
    const original = browser.onDialog.bind(browser);
    Object.defineProperty(browser, 'onDialog', { configurable: true, enumerable: true, value: (handler: Parameters<typeof original>[0]) => original(typeof handler === 'string' ? handler : async dialog => {
      state.handlerEntered = true; record('handler-entered');
      try {
        await handler({ ...dialog, accept: async text => {
          state.acceptCalled = true; record('accept-called');
          try { await dialog.accept(text); state.acceptPromiseResolved = true; record('accept-resolved'); }
          catch (cause) { state.acceptPromiseRejected = true; record('accept-rejected'); throw cause; }
        } });
        state.handlerReturned = true; record('handler-returned');
      } catch (cause) {
        state.handlerThrew = true;
        state.assertionThrown = object(cause)['code'] === 'ASSERTION_FAILED';
        record('handler-threw'); throw cause;
      }
    }) });
  });
  test.afterEach(() => { record('attempt-ended'); });
}
