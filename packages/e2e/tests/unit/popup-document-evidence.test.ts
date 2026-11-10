/** Pure Node controls for the opt-in diagnostic; no browser or native runtime is started. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script, createContext } from 'node:vm';
import { parseSync } from 'oxc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from '@e2e-dev/web';
import { drainPopupDocumentEvidence, notePopupInitScriptResolved, popupDocumentDiagnosticFixture, popupDocumentDiagnosticHtml, validPopupDocumentEvidence, withPopupDocumentFailureEvidence } from '../helpers/popup-document-evidence.ts';

const original = readFileSync(new URL('../fixtures/popup-init-order/cases.txt', import.meta.url), 'utf8');
const post = 'opener.postMessage({kind: "init-document", path: location.pathname, snapshot: {first: globalThis.firstInline, final: globalThis.initOrder}}, location.origin);';
const shape = { present: false, type: 'undefined', isArray: false, length: 'not-array', lengthCapped: false };
const evidence = { schemaVersion: 2, readState: 'ok', readAttempts: 1, truncated: false, documentIdentitySource: 'same-origin-document-weakmap', registrationCallsResolved: 0, nativeRegistrationAck: 'unknown', frameTenure: 'unknown', documents: [
  { messageOrdinal: 0, documentIdentity: 0, readState: 'ok', final: shape, firstInline: { present: true, type: 'object', isArray: true, length: 0, lengthCapped: false } },
  { messageOrdinal: 1, documentIdentity: 1, readState: 'ok', final: shape, firstInline: { present: true, type: 'object', isArray: true, length: 0, lengthCapped: false } },
] };
const directories: string[] = [];
const target = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'popup-document-evidence-')); directories.push(dir); return pathToFileURL(path.join(dir, 'evidence.json')); };
const invalidResult = () => Object.assign(new Error('evaluate result must be JSON-safe'), { code: 'INVALID_ARGUMENT' });
const reader = (fn: () => Promise<unknown>) => ({ evaluate: vi.fn(fn) } as unknown as Pick<Browser, 'evaluate'>);
afterEach(() => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('popup document evidence schema and bounded failure handling', () => {
  it('keeps disabled source byte-identical and adds no message, open, reload, or assertion', () => {
    expect(popupDocumentDiagnosticFixture(original, false)).toBe(original);
    expect(popupDocumentDiagnosticHtml(post, false)).toBe(post);
    const generated = popupDocumentDiagnosticFixture(original, true);
    expect(parseSync('popup-init-order.e2e.ts', generated, { lang: 'ts', sourceType: 'module' }).errors).toEqual([]);
    for (const token of ["window.open('/popup')", 'child.location.reload()', 'resolve(snapshots)', 'snapshots.push(event.data.snapshot)', "{ first: ['first', 'second'], final: ['first', 'second'] }"]) {
      expect(generated.split(token).length).toBe(original.split(token).length);
    }
    expect(generated).toContain('withPopupDocumentFailureEvidence(browser');
    const html = popupDocumentDiagnosticHtml(post, true);
    expect(() => new Script(html)).not.toThrow();
    expect(html.match(/opener\.postMessage\(/g)).toHaveLength(1);
    expect(html).toContain(post);
    expect(html).not.toContain('snapshot, popupDocumentEvidence');
    const firstCase = original.indexOf("test('popup first inline");
    const blankCase = original.indexOf("test('blank popup");
    expect(generated).toContain(original.slice(0, firstCase));
    expect(generated.slice(generated.indexOf("test('blank popup"))).toBe(original.slice(blankCase));
    expect(generated.slice(generated.indexOf("test('popup first inline"), generated.indexOf("test('blank popup"))).toContain('withPopupDocumentFailureEvidence(browser');
    expect(generated.match(/withPopupDocumentFailureEvidence\(browser/g)).toHaveLength(1);
  });

  it('keeps both exact payloads and assigns ordinals by weak Document identity', () => {
    const messages: unknown[][] = [];
    const parent = { Object, Array, WeakMap, postMessage: (...args: unknown[]) => { messages.push(args); } };
    const script = new Script(popupDocumentDiagnosticHtml(post, true));
    const firstDocument = {};
    const secondDocument = {};
    const context = (document: object) => createContext({ opener: parent, document, location: { origin: 'fixture-origin', pathname: '/popup' }, firstInline: [] });
    const first = context(firstDocument);
    const second = context(secondDocument);
    script.runInContext(first); script.runInContext(second);
    expect(messages).toHaveLength(2);
    for (const args of messages) {
      expect(Object.keys(args[0] as object)).toEqual(['kind', 'path', 'snapshot']);
      expect(args[0]).toEqual({ kind: 'init-document', path: '/popup', snapshot: { first: [], final: undefined } });
    }
    const state = Reflect.get(parent, '__e2ePopupInitDocumentEvidence');
    expect(state.identities.get(firstDocument)).toBe(0);
    expect(state.identities.get(secondDocument)).toBe(1);
    expect(state.documents.map((row: { documentIdentity: number }) => row.documentIdentity)).toEqual([0, 1]);
    script.runInContext(first);
    expect(state.documents).toHaveLength(2);
    script.runInContext(context({}));
    expect(state.documents).toHaveLength(2);
    expect(state.truncated).toBe(true);
  });

  it('retains two message observations that refer to the same weak Document identity', () => {
    const parent = { Object, Array, WeakMap, postMessage: vi.fn() };
    const document = {};
    const context = createContext({ opener: parent, document, location: { origin: 'fixture-origin', pathname: '/popup' }, firstInline: [] });
    const script = new Script(popupDocumentDiagnosticHtml(post, true));
    script.runInContext(context); script.runInContext(context);
    const rows = Reflect.get(parent, '__e2ePopupInitDocumentEvidence').documents;
    expect(rows.map((row: { messageOrdinal: number }) => row.messageOrdinal)).toEqual([0, 1]);
    expect(rows.map((row: { documentIdentity: number }) => row.documentIdentity)).toEqual([0, 0]);
    expect(validPopupDocumentEvidence({ ...evidence, documents: rows })).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });

  it('does not invoke accessors for metadata or block the original message when the store is unavailable', () => {
    let reads = 0; const messages: unknown[] = [];
    const parent = { Object, Array, WeakMap, postMessage: (value: unknown) => { messages.push(value); } };
    const context = createContext({ opener: parent, document: {}, location: { origin: 'fixture-origin', pathname: '/popup' }, firstInline: [] });
    Object.defineProperty(context, 'initOrder', { get() { reads++; return undefined; } });
    const script = new Script(popupDocumentDiagnosticHtml(post, true));
    script.runInContext(context);
    expect(reads).toBe(1);
    expect(Reflect.get(parent, '__e2ePopupInitDocumentEvidence').documents[0].readState).toBe('failed');
    Object.defineProperty(parent, '__e2ePopupInitDocumentEvidence', { get() { throw new Error('unavailable'); } });
    script.runInContext(context);
    expect(messages).toHaveLength(2);
  });

  it('fails instrumentation closed when the known fixture changes', () => {
    expect(popupDocumentDiagnosticFixture('changed fixture', true)).toBe('changed fixture');
    expect(popupDocumentDiagnosticHtml('changed fixture', true)).toBe('changed fixture');
  });

  it('accepts undefined and empty-array shapes without substituting snapshot values', () => {
    expect(validPopupDocumentEvidence(evidence)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(evidence)) + 1).toBeLessThanOrEqual(4096);
  });

  it.each([
    { ...evidence, url: 'untrusted value' },
    { ...evidence, documents: [...evidence.documents, evidence.documents[0]] },
    { ...evidence, documents: [{ ...evidence.documents[0], messageOrdinal: 1 }] },
    { ...evidence, documents: [{ ...evidence.documents[0], final: { ...shape, type: 'untrusted value' } }] },
    { ...evidence, documents: [{ ...evidence.documents[0], final: { ...shape, isArray: true, type: 'object', length: 17 } }] },
    { ...evidence, readState: { toString: (): string => 'ok' } },
  ])('refuses extra, out-of-bound or coerced fields', value => { expect(validPopupDocumentEvidence(value)).toBe(false); });

  it('does no diagnostic read when disabled, successful, or a different error', async () => {
    const browser = reader(async () => evidence); const output = target();
    const originalError = invalidResult();
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '0');
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '1');
    expect(await withPopupDocumentFailureEvidence(browser, output, async () => 17)).toBe(17);
    const other = new Error('original failure');
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw other; })).rejects.toBe(other);
    await drainPopupDocumentEvidence(browser);
    expect(browser.evaluate).not.toHaveBeenCalled();
  });

  it('counts only resolved public registrations while keeping native ACK and tenure unknown', async () => {
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '1');
    const browser = reader(async () => ({ ...evidence, registrationCallsResolved: 2 }));
    notePopupInitScriptResolved(browser, 0); notePopupInitScriptResolved(browser, 0); notePopupInitScriptResolved(browser, 1);
    const output = target(); const originalError = invalidResult();
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    await drainPopupDocumentEvidence(browser);
    expect(browser.evaluate).toHaveBeenCalledWith(expect.any(Function), 2);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ registrationCallsResolved: 2, nativeRegistrationAck: 'unknown', frameTenure: 'unknown' });
  });

  it('reads once after invalidResult and rethrows the identical original error', async () => {
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '1');
    const browser = reader(async () => evidence); const output = target(); const originalError = invalidResult();
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    expect(browser.evaluate).not.toHaveBeenCalled();
    await drainPopupDocumentEvidence(browser);
    expect(browser.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(evidence);
    await drainPopupDocumentEvidence(browser);
    expect(browser.evaluate).toHaveBeenCalledTimes(1);
  });

  it('records a refused or failed read as unknown without printing its cause', async () => {
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '1');
    const browser = reader(async () => { throw new Error('must not reach evidence'); }); const output = target(); const originalError = invalidResult();
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    await drainPopupDocumentEvidence(browser);
    expect(browser.evaluate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ ...evidence, readState: 'failed', documents: [] });
  });

  it('drops an invalid returned object and cannot replace the original error on sink failure', async () => {
    vi.stubEnv('E2E_POPUP_DOCUMENT_DIAGNOSTIC', '1');
    const browser = reader(async () => ({ ...evidence, secret: 'must not reach evidence' })); const output = target(); const originalError = invalidResult();
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    await drainPopupDocumentEvidence(browser);
    expect(readFileSync(output, 'utf8')).not.toContain('must not reach evidence');
    expect(JSON.parse(readFileSync(output, 'utf8')).readState).toBe('invalid');
    await expect(withPopupDocumentFailureEvidence(browser, output, async () => { throw originalError; })).rejects.toBe(originalError);
    await drainPopupDocumentEvidence(browser);
  });
});
