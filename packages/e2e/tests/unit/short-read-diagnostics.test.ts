import { afterEach, expect, it, vi } from 'vitest';
import { withShortReadDiagnostics } from '../helpers/short-read-diagnostics.ts';
const original = { enabled: process.env['E2E_SHORT_READ_DIAGNOSTIC'], suite: process.env['E2E_QUERY_READ_DIAGNOSTIC'] };
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [['E2E_SHORT_READ_DIAGNOSTIC', original.enabled], ['E2E_QUERY_READ_DIAGNOSTIC', original.suite]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
it.each(['transformed-secrets', 'web-platform'] as const)('opts in only around the original %s fixture and restores prior environment', async suite => {
  process.env['E2E_SHORT_READ_DIAGNOSTIC'] = '1';
  process.env['E2E_QUERY_READ_DIAGNOSTIC'] = 'prior';
  const outcome = { failed: true, error: { code: 'UNKNOWN' }, cleanup: 'failed' };
  const returned = await withShortReadDiagnostics(suite, async () => {
    expect(process.env['E2E_QUERY_READ_DIAGNOSTIC']).toBe(suite);
    // Mirrors run-project's copied environment handed to the worker path.
    expect({ ...process.env }['E2E_QUERY_READ_DIAGNOSTIC']).toBe(suite);
    return outcome;
  });
  expect(returned).toBe(outcome);
  expect(process.env['E2E_QUERY_READ_DIAGNOSTIC']).toBe('prior');
});
it('restores absence and preserves the exact thrown failure', async () => {
  process.env['E2E_SHORT_READ_DIAGNOSTIC'] = '1'; delete process.env['E2E_QUERY_READ_DIAGNOSTIC'];
  const failure = new Error('synthetic cleanup failure');
  await expect(withShortReadDiagnostics('web-platform', async () => { throw failure; })).rejects.toBe(failure);
  expect(process.env['E2E_QUERY_READ_DIAGNOSTIC']).toBeUndefined();
});
it.each([undefined, '', '0'])('does not enable diagnostics without explicit opt-in: %s', async enabled => {
  if (enabled === undefined) delete process.env['E2E_SHORT_READ_DIAGNOSTIC']; else process.env['E2E_SHORT_READ_DIAGNOSTIC'] = enabled;
  delete process.env['E2E_QUERY_READ_DIAGNOSTIC'];
  await withShortReadDiagnostics('web-platform', async () => { expect(process.env['E2E_QUERY_READ_DIAGNOSTIC']).toBeUndefined(); });
});

const row = { phase: 'settled-failure', suite: 'web-platform', command: 'fixture.read-fields', transmittedTimeoutMs: 20, selectedLocalCancel: 'none', rawCode: 'cancelled', rawEffects: 'not-dispatched', rawScopeState: 'usable', returnedCode: 'cancelled', timeoutRewritten: false, cancelAckSeen: false };
const line = (value: unknown) => `QUERY_READ_RESULT_DIAGNOSTIC ${JSON.stringify(value)}\n`;
function sink() {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  process.env['E2E_SHORT_READ_DIAGNOSTIC'] = '1';
  return lines;
}
it('forwards only strictly validated worker rows after the run settles, including split writes', async () => {
  const lines = sink(); const outcome = { status: 'failed', cleanup: 'failed' };
  const returned = await withShortReadDiagnostics('web-platform', async onEvent => {
    const text = line(row);
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: `private raw stderr\n${text.slice(0, 37)}` });
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: text.slice(37) });
    for (const value of [{ ...row, secret: 'Tok-9f3aC0DeB1e7' }, { ...row, rawCode: 'private-native-text' }, { ...row, suite: 'transformed-secrets' }, { ...row, phase: 'capture-limit-reached' }]) {
      await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: line(value) });
    }
    expect(lines).toEqual([]); return outcome;
  });
  expect(returned).toBe(outcome);
  expect(lines[0]).toBe(line(row));
  expect(lines[1]).toContain('"workerRecords":1,"invalidRecords":4,"lineOverflow":false,"recordOverflow":false');
  expect(lines.join('')).not.toMatch(/private|Tok-9f3aC0DeB1e7|secret/);
});
it('keeps bounded first and latest worker facts with explicit overflow and no raw oversized line', async () => {
  const lines = sink();
  await withShortReadDiagnostics('web-platform', async onEvent => {
    for (let i = 1; i <= 70; i++) await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: line({ ...row, transmittedTimeoutMs: i }) });
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: 'private'.repeat(1000) + '\n' });
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stdout', text: line(row) });
  });
  expect(lines).toHaveLength(65);
  expect(lines[0]).toContain('"transmittedTimeoutMs":1');
  expect(lines[63]).toContain('"transmittedTimeoutMs":70');
  expect(lines[64]).toContain('"workerRecords":64,"invalidRecords":0,"lineOverflow":true,"recordOverflow":true');
  expect(lines.join('')).not.toContain('private');
});
it('retains the client overflow marker and flushes a final complete row without newline even on failure', async () => {
  const lines = sink(); const failure = new Error('original cleanup failure');
  const overflow = { ...row, phase: 'capture-limit-reached', limit: 8, laterFailuresOmitted: true };
  await expect(withShortReadDiagnostics('web-platform', async onEvent => {
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: line(overflow).trimEnd() });
    throw failure;
  })).rejects.toBe(failure);
  expect(lines[0]).toBe(line(overflow));
  expect(lines[1]).toContain('"workerRecords":1');
});
it('cannot replace the original result or failure when the custody sink fails', async () => {
  sink(); vi.mocked(process.stderr.write).mockImplementation(() => { throw new Error('sink failed'); });
  const result = { error: 'UNKNOWN', cleanup: 'failed' };
  expect(await withShortReadDiagnostics('web-platform', async () => result)).toBe(result);
  const failure = new Error('original failure');
  await expect(withShortReadDiagnostics('web-platform', async () => { throw failure; })).rejects.toBe(failure);
});
