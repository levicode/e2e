import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordNativeResult } from '../../src/native/result-ledger.ts';

const NATIVE_RESULT_LEDGER_ENV = 'E2E_NATIVE_RESULT_LEDGER';
import type { NativeResult } from '../../src/native/protocol.ts';

const previous = process.env[NATIVE_RESULT_LEDGER_ENV];
const directories: string[] = [];

afterEach(() => {
  if (previous === undefined) delete process.env[NATIVE_RESULT_LEDGER_ENV];
  else process.env[NATIVE_RESULT_LEDGER_ENV] = previous;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function ledgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'native-result-ledger-'));
  directories.push(directory);
  const file = join(directory, 'native-results.jsonl');
  process.env[NATIVE_RESULT_LEDGER_ENV] = file;
  return file;
}

function result(extra: Partial<NativeResult> = {}): NativeResult {
  return { type: 'result', id: 'frame', generation: 1, operationSeq: 7, ok: true, data: { privatePayload: 'must-not-be-written' }, effects: 'completed', scopeState: 'usable', ...extra };
}

describe('native result ledger', () => {
  it('appends one line of closed protocol facts per result', () => {
    const file = ledgerPath();
    recordNativeResult('browser.observe', 7, 15000, result({
      ok: false,
      effects: 'unknown',
      scopeState: 'quarantined',
      error: { code: 'capacity-exceeded' },
      retention: { version: 1, retiredOperationSeq: 6, producerState: 'retiring', inputDebt: 2, objectDebt: 3 },
    }));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      schemaVersion: 1,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      command: 'browser.observe',
      operationSeq: 7,
      timeoutMs: 15000,
      ok: false,
      effects: 'unknown',
      scopeState: 'quarantined',
      code: 'capacity-exceeded',
      retention: { retiredOperationSeq: 6, producerState: 'retiring', inputDebt: 2, objectDebt: 3 },
    });
  });

  it('never writes result data, arguments, IDs, or an error message', () => {
    const file = ledgerPath();
    recordNativeResult('page.evaluate', 3, 1000, result({ error: { code: 'stale-reference' } }));
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('must-not-be-written');
    expect(text).not.toContain('frame');
    expect(JSON.parse(text)).toMatchObject({ command: 'page.evaluate', operationSeq: 3 });
  });

  it('ignores a relative or empty path instead of failing the operation', () => {
    process.env[NATIVE_RESULT_LEDGER_ENV] = 'relative/native-results.jsonl';
    expect(() => recordNativeResult('browser.query', 1, 1000, result())).not.toThrow();
    process.env[NATIVE_RESULT_LEDGER_ENV] = '';
    expect(() => recordNativeResult('browser.query', 1, 1000, result())).not.toThrow();
  });

  it('disables a path it cannot write without changing the caller result', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-result-ledger-'));
    directories.push(directory);
    process.env[NATIVE_RESULT_LEDGER_ENV] = directory;
    expect(() => recordNativeResult('browser.query', 1, 1000, result())).not.toThrow();
  });

  it('stops at the per-file cap and marks the truncation once', () => {
    const file = ledgerPath();
    writeFileSync(file, '');
    for (let sequence = 1; sequence <= 4097; sequence++) recordNativeResult('browser.query', sequence, 1000, result());
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4097);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'truncated', limit: 4096 });
  });
});
