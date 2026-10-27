import { describe, expect, it } from 'vitest';
import { decodeEngineResult } from '../../src/native/engine-decode.ts';

const snapshot = () => ({ identityScope: 'scope-1', revision: '18446744073709551615', viewport: { width: 100, height: 80 }, root: { ref: { id: '@e7', revision: '18446744073709551615' }, role: 'document', children: [{ ref: { id: '@e8', revision: '18446744073709551615' }, role: 'button', name: 'Submit' }] } });

describe('native engine result boundary', () => {
  it('preserves exact native references and decimal revisions without JS number coercion', () => {
    expect(decodeEngineResult('browser.observe', snapshot())).toEqual(snapshot());
    expect(() => decodeEngineResult('browser.observe', { ...snapshot(), revision: 42 })).toThrow();
    expect(() => decodeEngineResult('browser.observe', { ...snapshot(), root: { ref: { id: 'invented-uuid', revision: '1' } } })).toThrow();
  });
  it('requires explicit scope and typed node fields', () => {
    expect(() => decodeEngineResult('browser.observe', { ...snapshot(), identityScope: '' })).toThrow();
    expect(() => decodeEngineResult('browser.observe', { ...snapshot(), root: { ...snapshot().root, states: { secure: 'true' } } })).toThrow();
    expect(() => decodeEngineResult('browser.observe', { ...snapshot(), root: { ...snapshot().root, rect: { x: 0, y: 0, width: -1, height: 10 } } })).toThrow();
  });
  it('does not relabel legacy state as native storage state', () => {
    const blob = { identityScope: 'scope-1', handle: 'blob-1', size: 1, sha256: '0'.repeat(64), version: 1 };
    expect(() => decodeEngineResult('state.capture', { ...blob, format: 'playwright-storage-state' })).toThrow();
    expect(decodeEngineResult('state.capture', { ...blob, format: 'agent-browser-storage-state' })).toMatchObject({ format: 'agent-browser-storage-state' });
  });
  it('rejects malformed chunk encodings and nonfinalized image metadata', () => {
    expect(() => decodeEngineResult('blob.read', { base64: 'not base64', nextOffset: 1, eof: true })).toThrow();
    expect(() => decodeEngineResult('capture.screenshot', { identityScope: 'scope-1', handle: 'image-1', size: 1, sha256: '0'.repeat(64), mediaType: 'image/png', width: 100, height: 80, scale: 0, maskedRegionCount: 0 })).toThrow();
  });
  it.each(['scope.open', 'scope.restart'] as const)('requires opaque verified recovery identity on %s', (command) => {
    expect(() => decodeEngineResult(command, { identityScope: 'scope-1' })).toThrow();
    expect(decodeEngineResult(command, { identityScope: 'scope-1', recoveryIdentity: { browser: 'browser-opaque', context: 'context-opaque', page: 'page-opaque' } })).toMatchObject({ recoveryIdentity: { page: 'page-opaque' } });
  });
  it('does not relabel another native video codec as the promised Chromium WebM output', () => {
    const segment = { identityScope: 'scope-1', handle: 'video', size: 1, sha256: '0'.repeat(64), startedAt: '2026-10-21T00:00:00.000Z' };
    expect(() => decodeEngineResult('recording.stop', { identityScope: 'scope-1', segments: [{ ...segment, mediaType: 'video/mp4' }] })).toThrow();
    expect(decodeEngineResult('recording.stop', { identityScope: 'scope-1', segments: [{ ...segment, mediaType: 'video/webm' }] })).toMatchObject({ segments: [{ mediaType: 'video/webm' }] });
  });

  it('requires exact successful activation proof without a permissive truthy value', () => {
    expect(decodeEngineResult('page.activate', { activated: true })).toEqual({ activated: true });
    for (const value of [null, {}, { activated: false }, { activated: 'true' }, { activated: true, extra: 1 }]) expect(() => decodeEngineResult('page.activate', value)).toThrow();
  });

  it('accepts a bounded missing ordinal alongside independently finalized segments', () => {
    expect(decodeEngineResult('recording.stop', { identityScope: 'scope-1', missingSegment: 2 })).toEqual({ identityScope: 'scope-1', missingSegment: 2 });
    for (const missingSegment of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
      expect(() => decodeEngineResult('recording.stop', { identityScope: 'scope-1', missingSegment })).toThrow();
    }
    expect(decodeEngineResult('recording.stop', { identityScope: 'scope-1', missingSegment: 1, segments: [] })).toEqual({ identityScope: 'scope-1', missingSegment: 1, segments: [] });
    for (const result of [
      { identityScope: 'scope-1', missingSegment: 1, rawError: 'private backend text' },
      { identityScope: 'scope-1', segments: [], extra: true },
      { identityScope: '', missingSegment: 1 },
    ]) expect(() => decodeEngineResult('recording.stop', result)).toThrow();
  });

});

it('requires native trace metadata only for trace purpose and never fabricates a semantic revision', () => {
  const plain = { identityScope: 'scope-1', handle: 'image-1', size: 1, sha256: '0'.repeat(64), mediaType: 'image/png', width: 100, height: 80, scale: 1, maskedRegionCount: 0 };
  const args = { identityScope: 'scope-1', secureFieldSelector: 'input', purpose: 'trace' as const };
  const trace = { ...plain, viewportRef: { id: '@e7', revision: '18446744073709551615' }, viewport: { width: 100, height: 80 }, location: 'https://synthetic.test/' };
  expect(decodeEngineResult('capture.screenshot', plain)).toEqual(plain);
  expect(decodeEngineResult('capture.screenshot', trace, args)).toEqual(trace);
  for (const key of ['viewportRef', 'viewport', 'location'] as const) expect(() => decodeEngineResult('capture.screenshot', { ...trace, [key]: undefined }, args)).toThrow();
  for (const revision of ['0', '01', '-1', '18446744073709551616']) expect(() => decodeEngineResult('capture.screenshot', { ...trace, viewportRef: { id: '@e7', revision } }, args)).toThrow();
  expect(decodeEngineResult('capture.screenshot', trace)).toEqual(plain);
});
