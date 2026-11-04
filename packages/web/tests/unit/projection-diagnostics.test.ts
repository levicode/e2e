import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PROJECTION_MAX_BYTES, PROJECTION_MAX_RECORDS, projectionDiagnostics } from '../helpers/projection-diagnostics.ts';

describe('synthetic projection failure messages', () => {
  it('emits only closed facts, never names, values, URLs, credentials, or error strings', () => {
    const malicious = 'https://user:password@example.test/?token=secret\n"records":'.repeat(10_000);
    const unexpected = {
      ordinal: 0, missing: false, roleMatches: true, nameMatches: false,
      name: malicious, value: malicious, href: malicious, error: new Error(malicious),
      expected: malicious, toJSON: () => malicious,
    };
    const result = projectionDiagnostics(malicious)('hrefs', { observedCount: 1, expectedCount: 1 }, [unexpected]);
    expect(JSON.parse(result)).toEqual({
      schema: 'synthetic-projection-v1', sourceSha256: createHash('sha256').update(malicious).digest('hex'), group: 'hrefs',
      observedCount: 1, expectedCount: 1,
      records: [{ ordinal: 0, missing: false, roleMatches: true, nameMatches: false }], omittedRecords: 0, truncated: false,
    });
    expect(result).not.toContain('password');
    expect(result).not.toContain('example.test');
    expect(result).not.toContain('secret');
  });

  it('rejects strings in allowed fields and unknown group IDs instead of echoing them', () => {
    const diagnostic = projectionDiagnostics('synthetic fixture');
    const malformed = { ordinal: 0, missing: 'secret', nameLength: 'secret', hrefLength: Number.NaN, valueLength: -1 };
    // Deliberately exercise the runtime boundary as well as the TypeScript contract.
    const result = diagnostic('hrefs', { observedCount: Number.POSITIVE_INFINITY, expectedCount: 1 }, [malformed as never]);
    expect(JSON.parse(result)).toMatchObject({ observedCount: null, records: [{ ordinal: 0 }], truncated: false });
    const invalid = diagnostic('https://secret.test' as never, { observedCount: 1, expectedCount: 1 }, [malformed as never]);
    expect(JSON.parse(invalid)).toMatchObject({ group: 'invalid', records: [], omittedRecords: 1, truncated: true });
    expect(result + invalid).not.toContain('secret');
  });

  it('caps the record count with an explicit omitted count and truncation marker', () => {
    const facts = Array.from({ length: PROJECTION_MAX_RECORDS + 20 }, (_, ordinal) => ({ ordinal, missing: false }));
    const result = projectionDiagnostics('synthetic fixture')('headers', { observedCount: facts.length, expectedCount: facts.length }, facts);
    const parsed = JSON.parse(result) as { records: unknown[]; omittedRecords: number; truncated: boolean };
    expect(parsed.records).toHaveLength(PROJECTION_MAX_RECORDS);
    expect(parsed.omittedRecords).toBe(20);
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(PROJECTION_MAX_BYTES);
  });

  it('caps total bytes even before reaching the record limit', () => {
    const facts = Array.from({ length: PROJECTION_MAX_RECORDS }, (_, ordinal) => ({
      ordinal, missing: false, roleMatches: false, nameMatches: false, valueMatches: false, hrefMatches: false,
      nameMissing: false, valueMissing: false, hrefMissing: false,
      presentCount: Number.MAX_SAFE_INTEGER, nameLength: Number.MAX_SAFE_INTEGER,
      valueLength: Number.MAX_SAFE_INTEGER, hrefLength: Number.MAX_SAFE_INTEGER,
    }));
    const result = projectionDiagnostics('synthetic fixture')('vocabulary', { observedCount: facts.length, expectedCount: facts.length }, facts);
    const parsed = JSON.parse(result) as { records: unknown[]; omittedRecords: number; truncated: boolean };
    expect(parsed.records.length).toBeGreaterThan(0);
    expect(parsed.records.length).toBeLessThan(PROJECTION_MAX_RECORDS);
    expect(parsed.omittedRecords).toBe(facts.length - parsed.records.length);
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(PROJECTION_MAX_BYTES);
  });

  it('binds ordinal mapping to exact source bytes, including reordered fixture cases', () => {
    const first = 'const fixtures = ["first", "second"];';
    const second = 'const fixtures = ["second", "first"];';
    const message = (source: string) => JSON.parse(projectionDiagnostics(source)('headers', { observedCount: 1, expectedCount: 1 }, [{ ordinal: 0, roleMatches: false }])) as { sourceSha256: string };
    expect(message(first).sourceSha256).toBe(createHash('sha256').update(first).digest('hex'));
    expect(message(second).sourceSha256).not.toBe(message(first).sourceSha256);
    expect(message(`${first}\n`).sourceSha256).not.toBe(message(first).sourceSha256);
  });

  it('only adds a message: the original assertion still rejects the same mismatch and success does not log', () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      const actual = { role: 'columnheader' };
      const expected = { role: 'rowheader' };
      const diagnostic = projectionDiagnostics('synthetic fixture')('headers', { observedCount: 1, expectedCount: 1 }, [{ ordinal: 0, roleMatches: false }]);
      expect(() => expect(actual).toEqual(expected)).toThrow();
      expect(() => expect(actual, diagnostic).toEqual(expected)).toThrow('synthetic-projection-v1');
      expect(actual, diagnostic).toEqual({ role: 'columnheader' });
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
