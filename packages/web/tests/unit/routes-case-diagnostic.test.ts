import { expect, it } from 'vitest';
import type { NativeClient } from '../../src/native/client.ts';
import type { NativeResult } from '../../src/native/protocol.ts';
import { observeScopeEnd, RoutesCaseDiagnostic } from '../helpers/routes-case-diagnostic.ts';
const result: NativeResult = { type: 'result', id: 'must-not-copy', generation: 1, operationSeq: 9,
  ok: false, error: { code: 'cleanup-failed' }, effects: 'unknown', scopeState: 'quarantined', data: { private: 'secret' } };
const args = () => {
  const context = {};
  Object.defineProperty(context, 'timeoutMs', { get() { throw new Error('context must not be inspected'); } });
  return ['scope.end', { identityScope: 'private-scope' }, context] as unknown as Parameters<NativeClient['request']>;
};
it('preserves receiver, original Promise and exact validated metadata without context access', async () => {
  let resolve!: (value: NativeResult) => void;
  const promise = new Promise<NativeResult>(done => { resolve = done; });
  const parameters = args(); const diagnostic = new RoutesCaseDiagnostic(); let invalid = false;
  const client = { request(...received: unknown[]) { expect(this).toBe(client); expect(received).toEqual(parameters); return promise; } } as unknown as NativeClient;
  const original = client.request; const restore = observeScopeEnd(client, () => diagnostic, () => { invalid = true; });
  expect(client.request(...parameters)).toBe(promise); expect(diagnostic.data.scopeEnd.pending).toBe(1);
  resolve(result); await promise;
  expect(diagnostic.data.scopeEnd).toMatchObject({ calls: 1, pending: 0, rejected: 0, results: [{ sequence: 9, generation: 1, ok: false, code: 'cleanup-failed', effects: 'unknown', scopeState: 'quarantined' }] });
  expect(JSON.stringify(diagnostic.data)).not.toContain('secret'); expect(JSON.stringify(diagnostic.data)).not.toContain('must-not-copy');
  restore(); expect(client.request).toBe(original); expect(invalid).toBe(false);
});
it('captures the originating test even when a later test becomes current', async () => {
  let resolve!: (value: NativeResult) => void; const promise = new Promise<NativeResult>(done => { resolve = done; });
  const first = new RoutesCaseDiagnostic(); const second = new RoutesCaseDiagnostic(); let current = first;
  const client = { request: () => promise } as unknown as NativeClient;
  const restore = observeScopeEnd(client, () => current, () => {});
  client.request(...args()); current = second; resolve(result); await promise;
  expect(first.data.scopeEnd.results).toHaveLength(1); expect(second.data.scopeEnd.calls).toBe(0); restore();
});
it('preserves synchronous throw identity', () => {
  const failure = new Error('private'); const diagnostic = new RoutesCaseDiagnostic();
  const client = { request() { throw failure; } } as unknown as NativeClient;
  const restore = observeScopeEnd(client, () => diagnostic, () => {});
  let caught; try { client.request(...args()); } catch (error) { caught = error; }
  expect(caught).toBe(failure); expect(diagnostic.data.scopeEnd).toMatchObject({ pending: 0, thrown: 1 }); restore();
});
it('preserves rejected Promise and rejection object', async () => {
  const failure = new Error('private'); const promise = Promise.reject<NativeResult>(failure); const diagnostic = new RoutesCaseDiagnostic();
  const client = { request: () => promise } as unknown as NativeClient;
  const restore = observeScopeEnd(client, () => diagnostic, () => {});
  expect(client.request(...args())).toBe(promise); await expect(promise).rejects.toBe(failure);
  expect(diagnostic.data.scopeEnd).toMatchObject({ pending: 0, rejected: 1 }); restore();
});
it('does not observe other commands and bounds stored receipts', async () => {
  const promise = Promise.resolve(result); const diagnostic = new RoutesCaseDiagnostic();
  const client = { request: () => promise } as unknown as NativeClient;
  const restore = observeScopeEnd(client, () => diagnostic, () => {});
  const other = args(); other[0] = 'scope.open'; expect(client.request(...other)).toBe(promise);
  for (let index = 0; index < 6; index++) await client.request(...args());
  expect(diagnostic.data.scopeEnd).toMatchObject({ calls: 6, pending: 0, dropped: 2 });
  expect(diagnostic.data.scopeEnd.results).toHaveLength(4); restore();
});
it('separates setup, first body and cleanup errors without reading error text', () => {
  const diagnostic = new RoutesCaseDiagnostic(); diagnostic.setupPassed(); diagnostic.bodyEntered();
  diagnostic.bodyFailed(Object.assign(new Error('secret'), { code: 'OPERATION_TIMEOUT' }));
  diagnostic.cleanupEntered(); diagnostic.cleanupFailed(Object.assign(new Error('secret'), { code: 'ACTION_MAY_HAVE_COMMITTED' }));
  expect(diagnostic.data).toMatchObject({ firstSetupFailure: null, firstBodyFailure: 'OPERATION_TIMEOUT', firstCleanupFailure: 'ACTION_MAY_HAVE_COMMITTED' });
  expect(JSON.stringify(diagnostic.data)).not.toContain('secret');
});
it('marks observer restoration conflict without overwriting another wrapper', () => {
  const client = { request: () => Promise.resolve(result) } as unknown as NativeClient; let invalid = false;
  const restore = observeScopeEnd(client, () => undefined, () => { invalid = true; });
  const replacement = () => Promise.resolve(result); client.request = replacement; restore();
  expect(invalid).toBe(true); expect(client.request).toBe(replacement);
});
