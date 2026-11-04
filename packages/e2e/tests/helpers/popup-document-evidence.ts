/** Opt-in facts for the managed two-document popup fixture; never a production reader. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Browser } from '@e2e-dev/web';

const FLAG = 'E2E_POPUP_DOCUMENT_DIAGNOSTIC';
const STORE = '__e2ePopupInitDocumentEvidence';
const TYPES = ['undefined', 'boolean', 'number', 'string', 'bigint', 'symbol', 'function', 'object'] as const;
const registrations = new WeakMap<Pick<Browser, 'evaluate'>, Set<0 | 1>>();
const pending = new WeakMap<Pick<Browser, 'evaluate'>, { output: URL; resolved: number }>();
export interface PopupValueShape {
  present: boolean | 'unknown'; type: typeof TYPES[number] | 'unknown'; isArray: boolean | 'unknown';
  length: number | 'not-array' | 'unknown'; lengthCapped: boolean | 'unknown';
}
export interface PopupDocumentFact {
  /** Equality of a same-origin JS Document weak key only, never a native frame/session identity. */
  messageOrdinal: 0 | 1; documentIdentity: 0 | 1 | 'unknown'; readState: 'ok' | 'failed'; final: PopupValueShape; firstInline: PopupValueShape;
}
export interface PopupDocumentEvidence {
  schemaVersion: 2; readState: 'ok' | 'absent' | 'failed' | 'invalid'; readAttempts: 1; truncated: boolean;
  documentIdentitySource: 'same-origin-document-weakmap'; registrationCallsResolved: number;
  nativeRegistrationAck: 'unknown'; frameTenure: 'unknown'; documents: PopupDocumentFact[];
}
const keys = (value: Record<string, unknown>, expected: string[]): boolean => Object.keys(value).toSorted().join(',') === expected.toSorted().join(',');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Closed schema: two Document ordinals, typeof enums, booleans and lengths capped at 16. */
export function validPopupDocumentEvidence(value: unknown): value is PopupDocumentEvidence {
  try {
    const shape = (item: unknown, observed: boolean): boolean => {
      if (!object(item) || !keys(item, ['present', 'type', 'isArray', 'length', 'lengthCapped'])) return false;
      if (!observed) return Object.values(item).every(field => field === 'unknown');
      return typeof item['present'] === 'boolean' && TYPES.includes(item['type'] as typeof TYPES[number])
        && typeof item['isArray'] === 'boolean' && typeof item['lengthCapped'] === 'boolean'
        && (item['isArray'] ? item['type'] === 'object' && Number.isInteger(item['length']) && Number(item['length']) >= 0 && Number(item['length']) <= 16
          && (!item['lengthCapped'] || item['length'] === 16) : item['length'] === 'not-array' && item['lengthCapped'] === false);
    };
    return object(value) && keys(value, ['schemaVersion', 'readState', 'readAttempts', 'truncated', 'documentIdentitySource', 'registrationCallsResolved', 'nativeRegistrationAck', 'frameTenure', 'documents'])
      && value['schemaVersion'] === 2 && value['readAttempts'] === 1 && value['documentIdentitySource'] === 'same-origin-document-weakmap'
      && value['nativeRegistrationAck'] === 'unknown' && value['frameTenure'] === 'unknown'
      && Number.isInteger(value['registrationCallsResolved']) && Number(value['registrationCallsResolved']) >= 0 && Number(value['registrationCallsResolved']) <= 2
      && typeof value['readState'] === 'string' && ['ok', 'absent', 'failed', 'invalid'].includes(value['readState']) && typeof value['truncated'] === 'boolean'
      && Array.isArray(value['documents']) && value['documents'].length <= 2
      && Object.keys(value['documents']).join(',') === Array.from({ length: value['documents'].length }, (_item, ordinal) => String(ordinal)).join(',')
      && value['documents'].every((item: unknown, ordinal: number) => object(item)
        && keys(item, ['messageOrdinal', 'documentIdentity', 'readState', 'final', 'firstInline']) && item['messageOrdinal'] === ordinal
        && (item['documentIdentity'] === 0 || item['documentIdentity'] === 1 || item['documentIdentity'] === 'unknown')
        && (item['readState'] === 'ok' || item['readState'] === 'failed')
        && shape(item['final'], item['readState'] === 'ok') && shape(item['firstInline'], item['readState'] === 'ok'))
      && (value['readState'] === 'ok' || value['documents'].length === 0);
  } catch { return false; }
}

const POST = 'opener.postMessage({kind: "init-document", snapshot: {first: globalThis.firstInline, final: globalThis.initOrder}}, location.origin);';
/** Write bounded private metadata first, then execute the exact original postMessage and payload. */
export function popupDocumentDiagnosticHtml(html: string, enabled = process.env[FLAG] === '1'): string {
  if (!enabled || html.split(POST).length !== 2) return html;
  return html.replace(POST, `(() => {
    try {
      const parent = opener;
      let state = parent.${STORE};
      if (state === undefined) {
        state = new parent.Object();
        state.documents = new parent.Array(); state.identities = new parent.WeakMap(); state.nextDocumentOrdinal = 0; state.truncated = false;
        Object.defineProperty(parent, '${STORE}', {value: state, configurable: true});
      }
      if (Array.isArray(state.documents) && typeof state.truncated === 'boolean') {
        if (state.documents.length < 2) {
          const record = new parent.Object();
          record.messageOrdinal = state.documents.length; record.documentIdentity = 'unknown'; record.readState = 'failed';
          try {
            let identity = WeakMap.prototype.get.call(state.identities, document);
            if (identity === undefined && Number.isInteger(state.nextDocumentOrdinal) && state.nextDocumentOrdinal >= 0 && state.nextDocumentOrdinal < 2) {
              identity = state.nextDocumentOrdinal++;
              WeakMap.prototype.set.call(state.identities, document, identity);
            }
            if (identity === 0 || identity === 1) record.documentIdentity = identity;
          } catch {}
          const unknown = () => Object.assign(new parent.Object(), {present: 'unknown', type: 'unknown', isArray: 'unknown', length: 'unknown', lengthCapped: 'unknown'});
          record.final = unknown(); record.firstInline = unknown();
          try {
            const shape = (value, present) => {
              const isArray = Array.isArray(value);
              return Object.assign(new parent.Object(), {present, type: typeof value, isArray, length: isArray ? Math.min(value.length, 16) : 'not-array', lengthCapped: isArray && value.length > 16});
            };
            const ownShape = name => {
              const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
              if (descriptor === undefined) return name in globalThis ? unknown() : shape(undefined, false);
              return Object.hasOwn(descriptor, 'value') ? shape(descriptor.value, true) : unknown();
            };
            record.final = ownShape('initOrder'); record.firstInline = ownShape('firstInline');
            if (record.final.type !== 'unknown' && record.firstInline.type !== 'unknown') record.readState = 'ok';
            else { record.final = unknown(); record.firstInline = unknown(); }
          } catch {}
          state.documents.push(record);
        } else { state.truncated = true; }
      }
    } catch {}
    ${POST}
  })();`);
}

const CASE = "test('popup first inline sees each init once and reload starts a fresh document', { timeout: 12_000 }, async ({ browser }) => {";
const NEXT = "\ntest('blank popup has each init once before explicit first navigation'";
const OPEN = '  const snapshots = await browser.evaluate(() => new Promise((resolve, reject) => {';
const CLOSE = '  }));\n  expect(snapshots).toEqual([';
/** Scope every replacement to the named reload case; the other OPEN occurrence is untouched. */
export function popupDocumentDiagnosticFixture(source: string, enabled = process.env[FLAG] === '1'): string {
  const start = source.indexOf(CASE); const end = source.indexOf(NEXT, start);
  if (!enabled || start < 0 || end < 0 || source.split(CASE).length !== 2) return source;
  const body = source.slice(start, end);
  const first = '  await browser.addInitScript(first);'; const second = '  await browser.addInitScript(second);';
  if ([OPEN, CLOSE, first, second].some(anchor => body.split(anchor).length !== 2)) return source;
  const instrumented = body
    .replace(first, `${first}\n  notePopupInitScriptResolved(browser, 0);`)
    .replace(second, `${second}\n  notePopupInitScriptResolved(browser, 1);`)
    .replace(OPEN, "  const snapshots = await withPopupDocumentFailureEvidence(browser, new URL('../.e2e/popup-document-evidence.json', import.meta.url), () => browser.evaluate(() => new Promise((resolve, reject) => {")
    .replace(CLOSE, '  })));\n  expect(snapshots).toEqual([');
  return `import { drainPopupDocumentEvidence, notePopupInitScriptResolved, withPopupDocumentFailureEvidence } from ${JSON.stringify(import.meta.url)};
test.afterEach(async ({ browser }) => { await drainPopupDocumentEvidence(browser); });
${source.slice(0, start)}${instrumented}${source.slice(end)}`;
}

/** Observe only an original public await resolving, never infer a Chrome registration ACK. */
export function notePopupInitScriptResolved(browser: Pick<Browser, 'evaluate'>, ordinal: 0 | 1): void {
  if (ordinal !== 0 && ordinal !== 1) return;
  const resolved = registrations.get(browser) ?? new Set<0 | 1>();
  resolved.add(ordinal); registrations.set(browser, resolved);
}

/** Register a one-shot cleanup read without delaying or replacing the original body failure. */
export async function withPopupDocumentFailureEvidence<T>(browser: Pick<Browser, 'evaluate'>, output: URL, run: () => Promise<T>): Promise<T> {
  if (process.env[FLAG] !== '1') return run();
  try { return await run(); }
  catch (cause) {
    let invalidResult = false;
    try { invalidResult = object(cause) && cause['code'] === 'INVALID_ARGUMENT' && cause['message'] === 'evaluate result must be JSON-safe'; } catch {}
    if (invalidResult && !pending.has(browser)) pending.set(browser, { output, resolved: registrations.get(browser)?.size ?? 0 });
    throw cause;
  }
}

/** The existing afterEach owns this one read before engine cleanup, with its existing cleanup budget. */
export async function drainPopupDocumentEvidence(browser: Pick<Browser, 'evaluate'>): Promise<void> {
  const entry = pending.get(browser);
  registrations.delete(browser);
  if (entry === undefined) return;
  pending.delete(browser);
  try {
    const failureRecord = (readState: PopupDocumentEvidence['readState']): PopupDocumentEvidence => ({ schemaVersion: 2, readState, readAttempts: 1, truncated: false, documentIdentitySource: 'same-origin-document-weakmap', registrationCallsResolved: entry.resolved, nativeRegistrationAck: 'unknown', frameTenure: 'unknown', documents: [] });
    let evidence = failureRecord('failed');
    try {
      const read: unknown = await browser.evaluate((registrationCallsResolved: number) => {
        const empty = (readState: 'absent' | 'failed' | 'invalid') => ({ schemaVersion: 2, readState, readAttempts: 1, truncated: false, documentIdentitySource: 'same-origin-document-weakmap', registrationCallsResolved, nativeRegistrationAck: 'unknown', frameTenure: 'unknown', documents: [] });
        try {
          const state = (globalThis as unknown as Record<string, unknown>)['__e2ePopupInitDocumentEvidence'];
          if (state === null || typeof state !== 'object' || Array.isArray(state)) return empty('absent');
          const store = state as Record<string, unknown>; const rows = store['documents'];
          if (Object.keys(store).toSorted().join(',') !== 'documents,identities,nextDocumentOrdinal,truncated') return empty('invalid');
          if (!Array.isArray(rows) || typeof store['truncated'] !== 'boolean' || !Number.isInteger(store['nextDocumentOrdinal']) || Number(store['nextDocumentOrdinal']) < 0 || Number(store['nextDocumentOrdinal']) > 2) return empty('absent');
          const types = new Set(['undefined', 'boolean', 'number', 'string', 'bigint', 'symbol', 'function', 'object']);
          const unknown = () => ({ present: 'unknown', type: 'unknown', isArray: 'unknown', length: 'unknown', lengthCapped: 'unknown' });
          const shape = (value: unknown) => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
            const item = value as Record<string, unknown>;
            if (Object.keys(item).toSorted().join(',') !== 'isArray,length,lengthCapped,present,type'
              || typeof item['present'] !== 'boolean' || typeof item['type'] !== 'string' || !types.has(item['type'])
              || typeof item['isArray'] !== 'boolean' || typeof item['lengthCapped'] !== 'boolean') return undefined;
            const length = item['length'];
            if (item['isArray'] ? item['type'] !== 'object' || !Number.isInteger(length) || Number(length) < 0 || Number(length) > 16 || item['lengthCapped'] && length !== 16 : length !== 'not-array' || item['lengthCapped']) return undefined;
            return { present: item['present'], type: item['type'], isArray: item['isArray'], length: length as number | 'not-array', lengthCapped: item['lengthCapped'] };
          };
          return { ...empty('absent'), readState: 'ok', truncated: store['truncated'] || rows.length > 2, documents: rows.slice(0, 2).map((value: unknown, messageOrdinal: number) => {
            const failed = (documentIdentity: 0 | 1 | 'unknown' = 'unknown') => ({ messageOrdinal, documentIdentity, readState: 'failed', final: unknown(), firstInline: unknown() });
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return failed();
            const row = value as Record<string, unknown>;
            if (Object.keys(row).toSorted().join(',') !== 'documentIdentity,final,firstInline,messageOrdinal,readState' || row['messageOrdinal'] !== messageOrdinal) return failed();
            const identity = row['documentIdentity'];
            const documentIdentity = identity === 0 || identity === 1 ? identity : 'unknown';
            const final = shape(row['final']); const firstInline = shape(row['firstInline']);
            return row['readState'] === 'ok' && final !== undefined && firstInline !== undefined
              ? { messageOrdinal, documentIdentity, readState: 'ok', final, firstInline } : failed(documentIdentity);
          }) };
        } catch { return empty('failed'); }
      }, entry.resolved);
      evidence = validPopupDocumentEvidence(read) ? read : failureRecord('invalid');
    } catch { /* Read failure is unknown evidence, never a replacement test error. */ }
    const bytes = JSON.stringify(evidence);
    if (Buffer.byteLength(bytes) + 1 <= 4096) {
      const file = fileURLToPath(entry.output);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${bytes}\n`, { flag: 'wx', mode: 0o600 });
    }
  } catch { /* Diagnostics cannot replace or suppress the original failure. */ }
}
