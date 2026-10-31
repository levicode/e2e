import { afterEach, expect, it, vi } from 'vitest';
import { withShortReadDiagnostics } from '../helpers/short-read-diagnostics.ts';
const original = { enabled: process.env['E2E_SHORT_READ_DIAGNOSTIC'], suite: process.env['E2E_QUERY_READ_DIAGNOSTIC'], fields: process.env['E2E_REPLACED_FIELD_CAPTURE'] };
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [['E2E_SHORT_READ_DIAGNOSTIC', original.enabled], ['E2E_QUERY_READ_DIAGNOSTIC', original.suite], ['E2E_REPLACED_FIELD_CAPTURE', original.fields]] as const) {
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

it('forwards the exact replaced-field wire join through the existing worker output pipe and restores its tag', async () => {
  const lines = sink();
  process.env['E2E_REPLACED_FIELD_CAPTURE'] = '1';
  process.env['E2E_QUERY_READ_DIAGNOSTIC'] = 'prior';
  const joined = { ...row, suite: 'replaced-nodes', generation: 4, operationSeq: 19 };
  const outcome = { failed: true, cleanup: 'failed' };
  const returned = await withShortReadDiagnostics('replaced-nodes', async onEvent => {
    expect({ ...process.env }['E2E_QUERY_READ_DIAGNOSTIC']).toBe('replaced-nodes');
    const text = line(joined);
    for (const piece of [text.slice(0, 31), text.slice(31)]) {
      await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: piece });
    }
    for (const invalid of [{ ...row, suite: 'replaced-nodes' }, { ...joined, operationSeq: true }, { ...joined, generation: 0 }, { ...joined, query: 'private-query' }]) {
      await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: line(invalid) });
    }
    return outcome;
  });
  expect(returned).toBe(outcome);
  expect(process.env['E2E_QUERY_READ_DIAGNOSTIC']).toBe('prior');
  expect(JSON.parse(lines[0]!.slice('QUERY_READ_RESULT_DIAGNOSTIC '.length))).toEqual(joined);
  expect(lines.join('')).not.toContain('private-query');
  expect(lines.at(-1)).toContain('"invalidRecords":4');
});
it('does not turn on replaced-field capture through the unrelated short-read opt-in', async () => {
  process.env['E2E_SHORT_READ_DIAGNOSTIC'] = '1';
  delete process.env['E2E_REPLACED_FIELD_CAPTURE'];
  await withShortReadDiagnostics('replaced-nodes', async onEvent => { expect(onEvent).toBeUndefined(); });
});

it('archives exactly the bounded closed forwarded rows and custody without raw worker output', async () => {
  const lines = sink();
  process.env['E2E_REPLACED_FIELD_CAPTURE'] = '1';
  const joined = { ...row, suite: 'replaced-nodes', generation: 4, operationSeq: 19 };
  const captured: string[] = [];
  const result = { status: 'failed', cleanup: 'failed' };
  expect(await withShortReadDiagnostics('replaced-nodes', async onEvent => {
    await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: `PRIVATE RAW\n${line(joined)}` });
    return result;
  }, text => { captured.push(text); })).toBe(result);
  expect(captured).toEqual([lines.slice(1, -1).join('')]);
  const begin = JSON.parse(lines[0]!.slice('QUERY_READ_DIAGNOSTIC_BEGIN '.length));
  expect(begin.captureNonce).toMatch(/^[0-9a-f]{64}$/);
  expect(lines.at(-1)).toBe(`QUERY_READ_DIAGNOSTIC_END ${JSON.stringify(begin)}\n`);
  expect(captured[0]).not.toContain('PRIVATE');
  expect(captured[0]).toContain('QUERY_READ_DIAGNOSTIC_CUSTODY');
});

it('a failed archive callback preserves forwarding and the exact business failure', async () => {
  const lines = sink();
  const businessFailure = new Error('original failure');
  await expect(withShortReadDiagnostics('web-platform', async () => { throw businessFailure; }, () => { throw new Error('archive failed'); })).rejects.toBe(businessFailure);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('QUERY_READ_DIAGNOSTIC_CUSTODY');
});

it('disabled diagnostics never invoke the archive callback', async () => {
  delete process.env['E2E_REPLACED_FIELD_CAPTURE'];
  const capture = vi.fn();
  expect(await withShortReadDiagnostics('replaced-nodes', async () => 'unchanged', capture)).toBe('unchanged');
  expect(capture).not.toHaveBeenCalled();
});


it('binds actual inline stderr to a fresh current fixture boundary without changing writes or results', async () => {
  const lines = sink(); process.env['E2E_REPLACED_FIELD_CAPTURE'] = '1';
  const joined = { ...row, suite: 'replaced-nodes', generation: 1, operationSeq: 165 };
  const result = { status: 'failed', cleanup: 'complete' };
  let archive = ''; let nonce: string | undefined;
  expect(await withShortReadDiagnostics('replaced-nodes', async () => {
    process.stderr.write(line(joined)); return result;
  }, (text, current) => { archive = text; nonce = current; })).toBe(result);
  expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain(`"captureNonce":"${nonce}"`);
  expect(lines[1]).toBe(line(joined));
  expect(archive).toContain('"workerRecords":0');
  expect(archive).not.toContain('settled-failure');
  expect(lines[3]).toBe(lines[0]!.replace('_BEGIN ', '_END '));
});

it('uses a distinct nonce for each run and closes the exact boundary on the original exception', async () => {
  const lines = sink(); process.env['E2E_REPLACED_FIELD_CAPTURE'] = '1';
  const nonces: (string | undefined)[] = [];
  const failure = new Error('original workload failure');
  for (let i = 0; i < 2; i++) {
    await expect(withShortReadDiagnostics('replaced-nodes', async () => { throw failure; }, (_text, nonce) => { nonces.push(nonce); })).rejects.toBe(failure);
  }
  expect(new Set(nonces).size).toBe(2);
  for (let i = 0; i < 2; i++) expect(lines[i * 3 + 2]).toBe(lines[i * 3]!.replace('_BEGIN ', '_END '));
});

it('attempts END in finally despite a failed custody write and preserves original exception', async () => {
  process.env['E2E_REPLACED_FIELD_CAPTURE'] = '1';
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    lines.push(String(chunk));
    if (String(chunk).startsWith('QUERY_READ_DIAGNOSTIC_CUSTODY ')) throw new Error('broken custody sink');
    return true;
  });
  const failure = new Error('original workload failure');
  await expect(withShortReadDiagnostics('replaced-nodes', async () => { throw failure; }, () => {})).rejects.toBe(failure);
  expect(lines[0]).toContain('QUERY_READ_DIAGNOSTIC_BEGIN ');
  expect(lines.at(-1)).toBe(lines[0]!.replace('_BEGIN ', '_END '));
});


it('forwards closed class sample attribution and rejects extra user-content keys', async () => {
  const lines = sink();
  const sample = { ordinal: 1, priorSample: false, priorMismatch: false, startRemainingMs: 300, endRemainingMs: 0, elapsedMs: 300, outcome: 'threw' };
  const record = { schemaVersion: 1, fixture: 'web-platform-class300', api: 'toHaveClass', invocationOrdinal: 1, outcome: 'threw', sampleCount: 1, overflow: false, samples: [sample] };
  const closed = (value: unknown) => `CLASS_SAMPLE_DIAGNOSTIC ${JSON.stringify(value)}\n`;
  await withShortReadDiagnostics('web-platform', async onEvent => {
    for (const value of [record, { ...record, classValue: 'must-not-forward' }, { ...record, samples: [{ ...sample, selector: 'must-not-forward' }] }]) {
      await onEvent!({ seq: 1, at: '2026-10-29T12:00:00.000Z', type: 'output', target: 'web', pair: undefined, stream: 'stderr', text: closed(value) });
    }
  });
  expect(lines[0]).toBe(closed(record));
  expect(lines[1]).toContain('"invalidRecords":2');
  expect(lines.join('')).not.toContain('must-not-forward');
});
