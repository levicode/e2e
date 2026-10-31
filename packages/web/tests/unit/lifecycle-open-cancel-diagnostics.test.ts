import { afterEach, expect, it } from 'vitest';
import { withLifecycleOpenCancelDiagnostics } from '../helpers/lifecycle-open-cancel-diagnostics.ts';
const original = { enabled: process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'], suite: process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] };
afterEach(() => {
  for (const [key, value] of [['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE', original.enabled], ['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC', original.suite]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
it('scopes P32 diagnostics and preserves exact result and cleanup facts', async () => {
  process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] = '1';
  process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'] = 'prior';
  const outcome = { error: { code: 'ACTION_MAY_HAVE_COMMITTED' }, cleanup: 'failed' };
  expect(await withLifecycleOpenCancelDiagnostics(async () => {
    expect(process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC']).toBe('lifecycle-open-cancel');
    return outcome;
  })).toBe(outcome);
  expect(process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC']).toBe('prior');
});
it('restores absence and preserves the exact thrown failure', async () => {
  process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] = '1'; delete process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
  const failure = new Error('synthetic cleanup failure');
  await expect(withLifecycleOpenCancelDiagnostics(async () => { throw failure; })).rejects.toBe(failure);
  expect(process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC']).toBeUndefined();
});
it.each([undefined, '', '0'])('does not enable P32 diagnostics without explicit opt-in: %s', async enabled => {
  if (enabled === undefined) delete process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE']; else process.env['E2E_LIFECYCLE_OPEN_CANCEL_CAPTURE'] = enabled;
  delete process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC'];
  await withLifecycleOpenCancelDiagnostics(async () => { expect(process.env['E2E_LIFECYCLE_OPEN_CANCEL_DIAGNOSTIC']).toBeUndefined(); });
});

it('never creates case custody from worker opt-in alone', async () => {
  const previous = process.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'];
  process.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'] = '1';
  try { await withLifecycleOpenCancelDiagnostics(async env => { expect(env).toBeUndefined(); }); }
  finally { if (previous === undefined) delete process.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE']; else process.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'] = previous; }
});
