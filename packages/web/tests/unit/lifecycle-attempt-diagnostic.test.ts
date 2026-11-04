import { expect, it } from 'vitest';
import { LifecycleAttemptDiagnostic } from '../helpers/lifecycle-attempt-diagnostic.ts';
it('preserves first body error independently from later cleanup masking', () => {
  const d = new LifecycleAttemptDiagnostic();
  const body = Object.assign(new Error('private body'), { code: 'OPERATION_TIMEOUT' });
  const cleanup = Object.assign(new Error('private cleanup'), { code: 'ENGINE_FAILURE' });
  d.enter('open-after'); d.failed(body); d.enter('end'); d.failed(cleanup);
  expect(d.snapshot().firstFailure).toEqual({ phase: 'open-after', code: 'OPERATION_TIMEOUT' });
  expect(d.snapshot().firstBodyFailure).toEqual(d.snapshot().firstFailure);
  expect(d.snapshot().cleanupFailures).toEqual([{ phase: 'end', code: 'ENGINE_FAILURE' }]);
  expect(JSON.stringify(d.snapshot())).not.toContain('private');
  expect(d.snapshot().events.some(event => event.phase === 'dispose')).toBe(false);
});
it('distinguishes a body success followed by dispose refusal', () => {
  const d = new LifecycleAttemptDiagnostic();
  d.enter('readback'); d.passed(); d.enter('end'); d.passed(); d.enter('dispose'); d.failed(new Error('private'));
  expect(d.snapshot().firstBodyFailure).toBeNull();
  expect(d.snapshot().firstFailure).toEqual({ phase: 'dispose', code: 'OTHER' });
});
it('bounds records and returns detached snapshots', () => {
  const d = new LifecycleAttemptDiagnostic();
  for (let i = 0; i < 40; i++) d.enter('body');
  expect(d.snapshot().events).toHaveLength(32); expect(d.snapshot().dropped).toBe(8);
  const snapshot = d.snapshot(); snapshot.events.length = 0;
  expect(d.snapshot().events).toHaveLength(32);
});
it('never reads arbitrary exception text or lets an error accessor throw', () => {
  const d = new LifecycleAttemptDiagnostic();
  const cause = new Error('secret'); Object.defineProperty(cause, 'code', { get() { throw new Error('accessor'); } });
  expect(() => d.failed(cause)).not.toThrow();
  expect(d.snapshot().firstFailure?.code).toBe('OTHER');
});
