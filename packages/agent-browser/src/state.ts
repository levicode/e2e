/** Memory-only storage snapshots. The runner alone encrypts and persists these credentials. */
import { EngineError, type EngineState, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Pairs = [string, string][];
interface IndexState { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }
interface StoreState {
  name: string; keyPath: string | string[] | null; autoIncrement: boolean;
  nextKey?: number; indexes: IndexState[]; records: { key: Json; value: Json }[];
}
interface DatabaseState { name: string; version: number; stores: StoreState[] }
interface OriginState { origin: string; localStorage: Pairs; indexedDB: DatabaseState[] }
interface TabState { url: string; sessionStorage: { origin: string; values: Pairs }[] }
export interface BrowserStateData { cookies: Record<string, Json>[]; origins: OriginState[]; tabs: TabState[] }
/** Lets a live target coordinator exclude storage probes before installing user routes or init scripts. */
export interface StateProbeTargets {
  /** Creation/cookie scope; omitted for the default context. Resolved again after replacement. */
  browserContextId?(): string | undefined;
  /** TargetInfo ownership identity, which may be concrete even for the default context. */
  targetBrowserContextId?(): string | undefined;
  create(context: OperationContext): Promise<string>;
  release(targetId: string, context: OperationContext): Promise<void>;
}
interface FrameTree { frame: { id: string; url: string; securityOrigin?: string }; childFrames?: FrameTree[] }
interface Evaluation<T> { result: { value?: T }; exceptionDetails?: unknown }

const FORMAT = 'agent-browser-state';
const invalid = (): EngineError => new EngineError('INVALID_STATE', 'Unsupported or malformed agent-browser state', { retryable: false });
type StoragePhase = 'operation' | 'context-identity' | 'target-list' | 'tab-attach' | 'tab-frames' | 'tab-storage-key' | 'tab-world' | 'tab-session-storage' | 'tab-release' | 'origin-create' | 'origin-attach' | 'origin-enable' | 'origin-interception' | 'origin-navigation' | 'origin-world' | 'origin-verification' | 'origin-storage' | 'origin-release' | 'cookies' | 'snapshot-validation';
class StorageFailure extends EngineError {
  constructor(phase: StoragePhase) { super('ENGINE_FAILURE', `Storage state could not be captured or restored safely (${phase})`, { retryable: false }); }
}
const failed = (phase: StoragePhase = 'operation'): EngineError => new StorageFailure(phase);
const unsupported = (): EngineError => new EngineError('UNSUPPORTED_CAPABILITY', 'Storage contains unsupported structured-clone values, keys, or partitioned origins', { retryable: false });

/** Only fixed internal phase names enter diagnostics, never browser errors or storage values. */
async function storageStep<T>(phase: StoragePhase, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof StorageFailure || (error instanceof EngineError && ['CANCELLED', 'OPERATION_TIMEOUT', 'UNSUPPORTED_CAPABILITY'].includes(error.code))) throw error;
    throw failed(phase);
  }
}

function budget(context: OperationContext): () => OperationContext {
  const ends = Date.now() + context.timeoutMs;
  return () => ({ ...context, timeoutMs: Math.max(0, ends - Date.now()) });
}
function originOf(url: string): string | undefined {
  try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined; } catch { return undefined; }
}
function frames(tree: FrameTree): FrameTree['frame'][] { return [tree.frame, ...(tree.childFrames ?? []).flatMap(frames)]; }

/** Close acknowledgement precedes destruction; callers may discard only their exact owned probe. */
export async function releaseStateProbeTarget(cdp: CdpConnection, targetId: string, context: OperationContext, probes?: StateProbeTargets): Promise<void> {
  const current = budget(context);
  if (probes) await probes.release(targetId, current());
  else if ((await cdp.send<{ success: boolean }>('Target.closeTarget', { targetId }, current())).success !== true) throw failed('origin-release');
  while (true) {
    const remaining = current();
    if (remaining.signal.aborted) throw new EngineError('CANCELLED', 'Storage probe disposal cancelled', { retryable: false });
    if (remaining.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', 'Storage probe disposal was not confirmed', { retryable: false });
    if (!(await cdp.listTargets(remaining)).some(target => target.targetId === targetId)) return;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(10, current().timeoutMs)));
  }
}

/** Resolve default ownership from a target we created, never from an arbitrary existing page. */
async function targetContext(cdp: CdpConnection, context: OperationContext, probes?: StateProbeTargets): Promise<string | undefined> {
  if (probes?.targetBrowserContextId) return probes.targetBrowserContextId();
  const explicit = probes?.browserContextId?.();
  if (explicit !== undefined) return explicit;
  const current = budget(context);
  const targetId = probes ? await probes.create(current())
    : (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true }, current())).targetId;
  let identity: string | undefined;
  try {
    const { targetInfo } = await cdp.send<{ targetInfo: { targetId: string; type: string; browserContextId?: string } }>('Target.getTargetInfo', { targetId }, current());
    if (targetInfo.targetId !== targetId || targetInfo.type !== 'page' || (targetInfo.browserContextId !== undefined && (typeof targetInfo.browserContextId !== 'string' || !targetInfo.browserContextId))) throw failed('context-identity');
    identity = targetInfo.browserContextId;
  } finally {
    const cleanup = { ...context, signal: new AbortController().signal, timeoutMs: 2_000 };
    await releaseStateProbeTarget(cdp, targetId, cleanup, probes);
  }
  return identity;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function json(value: unknown, seen = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.length === Object.keys(value).length && value.every((entry) => json(entry, seen))
    : Object.values(value).every((entry) => json(entry, seen));
  seen.delete(value);
  return valid;
}
function key(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string' || (typeof value === 'number' && !Number.isNaN(value))) return true;
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (!Array.isArray(value) || seen.has(value) || value.length !== Object.keys(value).length) return false;
  seen.add(value); const valid = value.every((entry) => key(entry, seen)); seen.delete(value); return valid;
}
function pairs(value: unknown): value is Pairs { return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((v) => typeof v === 'string')); }
function path(value: unknown): value is string | string[] { return typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')); }
function unique(items: readonly string[]): boolean { return new Set(items).size === items.length; }

/** A JSON graph encoding for the structured-clone values IndexedDB persists. No source text is evaluated from a snapshot. */
const STRUCTURED_CODEC = `
const encode = async value => {
  const nodes = [], seen = new Map();
  const visit = async item => {
    if (item === null) return ['null'];
    if (item === undefined) return ['undefined'];
    if (typeof item === 'string' || typeof item === 'boolean') return [typeof item, item];
    if (typeof item === 'number') return ['number', Object.is(item, -0) ? '-0' : String(item)];
    if (typeof item === 'bigint') return ['bigint', String(item)];
    if (typeof item !== 'object') throw new Error('unsupported structured value');
    if (seen.has(item)) return ['ref', seen.get(item)];
    const id = nodes.length; seen.set(item, id); nodes.push(null);
    let node;
    if (item instanceof Date) node = { kind: 'date', time: String(item.getTime()) };
    else if (item instanceof RegExp) node = { kind: 'regexp', source: item.source, flags: item.flags };
    else if (item instanceof ArrayBuffer) node = { kind: 'buffer', bytes: Array.from(new Uint8Array(item)) };
    else if (ArrayBuffer.isView(item)) node = { kind: 'view', name: item.constructor.name, buffer: await visit(item.buffer), offset: item.byteOffset, length: item instanceof DataView ? item.byteLength : item.length };
    else if (typeof File !== 'undefined' && item instanceof File) node = { kind: 'file', name: item.name, type: item.type, modified: item.lastModified, bytes: Array.from(new Uint8Array(await item.arrayBuffer())) };
    else if (item instanceof Blob) node = { kind: 'blob', type: item.type, bytes: Array.from(new Uint8Array(await item.arrayBuffer())) };
    else if (item instanceof Map) {
      node = { kind: 'map', entries: [] };
      for (const [key, value] of item) node.entries.push([await visit(key), await visit(value)]);
    } else if (item instanceof Set) {
      node = { kind: 'set', entries: [] }; for (const value of item) node.entries.push(await visit(value));
    } else if (typeof DOMException !== 'undefined' && item instanceof DOMException) node = { kind: 'domException', name: item.name, message: item.message };
    else if (item instanceof Error) {
      const types = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];
      node = { kind: 'error', className: types.find(type => item instanceof type)?.name ?? 'Error', name: item.name, message: item.message, stack: item.stack ?? '', cause: await visit(item.cause) };
    } else if (item instanceof Number || item instanceof Boolean || item instanceof String) node = { kind: 'boxed', value: await visit(item.valueOf()) };
    else if (Array.isArray(item)) {
      node = { kind: 'array', length: item.length, entries: [] };
      for (const key of Object.keys(item)) node.entries.push([key, await visit(item[key])]);
    } else if (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) {
      node = { kind: 'object', nullPrototype: Object.getPrototypeOf(item) === null, entries: [] };
      for (const key of Object.keys(item)) node.entries.push([key, await visit(item[key])]);
    } else throw new Error('unsupported structured value');
    nodes[id] = node; return ['ref', id];
  };
  const root = await visit(value); return { root, nodes };
};
const decode = graph => {
  const fail = () => { throw new Error('invalid structured value'); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(graph) || !Array.isArray(graph.nodes)) fail();
  const nodes = graph.nodes, objects = new Array(nodes.length);
  const numeric = text => {
    if (typeof text !== 'string') return fail();
    if (text === '-0') return -0;
    if (text === 'NaN') return NaN;
    const value = Number(text); if (String(value) !== text) return fail(); return value;
  };
  const bytes = value => { if (!Array.isArray(value) || value.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return fail(); return new Uint8Array(value); };
  const string = value => { if (typeof value !== 'string') return fail(); return value; };
  const integer = value => { if (!Number.isSafeInteger(value) || value < 0) return fail(); return value; };
  const token = value => {
    if (!Array.isArray(value)) return fail();
    if (value.length === 1 && value[0] === 'null') return null;
    if (value.length === 1 && value[0] === 'undefined') return undefined;
    if (value.length !== 2) return fail();
    if (value[0] === 'boolean') { if (typeof value[1] !== 'boolean') return fail(); return value[1]; }
    if (value[0] === 'string') return string(value[1]);
    if (value[0] === 'number') return numeric(value[1]);
    if (value[0] === 'bigint') { const result = BigInt(string(value[1])); if (String(result) !== value[1]) return fail(); return result; }
    if (value[0] === 'ref') { const id = integer(value[1]); if (id >= objects.length) return fail(); return objects[id]; }
    return fail();
  };
  const pairs = value => { if (!Array.isArray(value) || value.some(pair => !Array.isArray(pair) || pair.length !== 2)) return fail(); return value; };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]; if (!object(node)) fail();
    switch (node.kind) {
      case 'date': objects[i] = new Date(numeric(node.time)); break;
      case 'regexp': objects[i] = new RegExp(string(node.source), string(node.flags)); break;
      case 'buffer': objects[i] = bytes(node.bytes).buffer; break;
      case 'blob': objects[i] = new Blob([bytes(node.bytes)], { type: string(node.type) }); break;
      case 'file': if (!Number.isSafeInteger(node.modified)) fail(); objects[i] = new File([bytes(node.bytes)], string(node.name), { type: string(node.type), lastModified: node.modified }); break;
      case 'map': objects[i] = new Map(); break;
      case 'set': objects[i] = new Set(); break;
      case 'array': { const length = integer(node.length); if (length > 4294967295) fail(); objects[i] = new Array(length); break; }
      case 'object': if (typeof node.nullPrototype !== 'boolean') fail(); objects[i] = node.nullPrototype ? Object.create(null) : {}; break;
      case 'error': {
        const types = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
        if (!Object.hasOwn(types, node.className)) fail();
        objects[i] = new types[node.className](string(node.message)); objects[i].name = string(node.name); objects[i].stack = string(node.stack); break;
      }
      case 'boxed': { const value = token(node.value); if (!['number', 'string', 'boolean'].includes(typeof value)) fail(); objects[i] = Object(value); break; }
      case 'domException': objects[i] = new DOMException(string(node.message), string(node.name)); break;
      case 'view': break;
      default: fail();
    }
  }
  const viewTypes = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
  if (typeof Float16Array !== 'undefined') viewTypes.Float16Array = Float16Array;
  for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === 'view') {
    const node = nodes[i]; if (!Object.hasOwn(viewTypes, node.name)) fail();
    const buffer = token(node.buffer); if (!(buffer instanceof ArrayBuffer)) fail();
    objects[i] = new viewTypes[node.name](buffer, integer(node.offset), integer(node.length));
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], target = objects[i];
    if (node.kind === 'map') for (const [key, value] of pairs(node.entries)) target.set(token(key), token(value));
    else if (node.kind === 'set') { if (!Array.isArray(node.entries)) fail(); for (const value of node.entries) target.add(token(value)); }
    else if (node.kind === 'object' || node.kind === 'array') {
      const seen = new Set();
      for (const [key, value] of pairs(node.entries)) {
        string(key); if (seen.has(key) || (node.kind === 'array' && key === 'length')) fail(); seen.add(key);
        Object.defineProperty(target, key, { value: token(value), configurable: true, writable: true, enumerable: true });
      }
    } else if (node.kind === 'error') {
      const cause = token(node.cause); if (cause !== undefined) Object.defineProperty(target, 'cause', { value: cause, configurable: true, writable: true });
    }
  }
  return token(graph.root);
};
`;

// The code compiled here is the fixed codec above, never snapshot or application text.
const codec = new Function(`${STRUCTURED_CODEC}; return { encode, decode };`)() as {
  encode(value: unknown): Promise<Json>;
  decode(value: Json): unknown;
};
export function encodeStateValue(value: unknown): Promise<Json> { return codec.encode(value); }
export function decodeStateValue(value: Json): unknown { return codec.decode(value); }
function validStateValue(value: unknown, isKey = false): boolean {
  try { if (!json(value)) return false; const decoded = decodeStateValue(value); return !isKey || key(decoded); } catch { return false; }
}

function stringFields(values: readonly unknown[], field: string): string[] {
  return values.map((value) => { if (!record(value) || typeof value[field] !== 'string') throw invalid(); return value[field]; });
}
function validateStateData(data: unknown): asserts data is BrowserStateData {
  if (!record(data) || !json(data)) throw invalid();
  if (!Array.isArray(data.cookies) || !data.cookies.every((cookie) => record(cookie)
    && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string' && typeof cookie.secure === 'boolean' && typeof cookie.httpOnly === 'boolean'
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.partitionKeyOpaque !== true)) throw invalid();
  if (!Array.isArray(data.origins) || !Array.isArray(data.tabs)) throw invalid();
  for (const entry of data.origins) {
    if (!record(entry) || typeof entry.origin !== 'string' || originOf(entry.origin) !== entry.origin || !pairs(entry.localStorage) || !Array.isArray(entry.indexedDB)) throw invalid();
    for (const db of entry.indexedDB) {
      if (!record(db) || typeof db.name !== 'string' || typeof db.version !== 'number' || !Number.isSafeInteger(db.version) || db.version < 1 || !Array.isArray(db.stores)) throw invalid();
      for (const store of db.stores) {
        if (!record(store) || typeof store.name !== 'string' || !(store.keyPath === null || path(store.keyPath)) || typeof store.autoIncrement !== 'boolean'
          || !Array.isArray(store.indexes) || !Array.isArray(store.records)) throw invalid();
        if (store.autoIncrement && (Array.isArray(store.keyPath) || store.keyPath === '')) throw invalid();
      if (store.autoIncrement && (typeof store.nextKey !== 'number' || !Number.isSafeInteger(store.nextKey) || store.nextKey < 1)) throw invalid();
        for (const index of store.indexes) if (!record(index) || typeof index.name !== 'string' || !path(index.keyPath) || typeof index.unique !== 'boolean' || typeof index.multiEntry !== 'boolean') throw invalid();
        for (const item of store.records) if (!record(item) || !validStateValue(item.key, true) || !validStateValue(item.value)) throw invalid();
        if (!unique(stringFields(store.indexes, 'name'))) throw invalid();
      }
      if (!unique(stringFields(db.stores, 'name'))) throw invalid();
    }
    if (!unique(stringFields(entry.indexedDB, 'name'))) throw invalid();
  }
  for (const tab of data.tabs) {
    if (!record(tab) || typeof tab.url !== 'string' || !(originOf(tab.url) || tab.url === 'about:blank') || !Array.isArray(tab.sessionStorage)) throw invalid();
    for (const entry of tab.sessionStorage) if (!record(entry) || typeof entry.origin !== 'string' || originOf(entry.origin) !== entry.origin || !pairs(entry.values)) throw invalid();
    if (!unique(stringFields(tab.sessionStorage, 'origin'))) throw invalid();
  }
  if (!unique(stringFields(data.origins, 'origin'))) throw invalid();
}

/** Validate completely before replacing the live browser; diagnostics never include payload data. */
export function readState(state: EngineState): BrowserStateData {
  try {
    if (state.format !== FORMAT || state.version !== 1) throw invalid();
    const data = state.data; validateStateData(data); return data;
  } catch { throw invalid(); }
}

async function evaluate<T>(cdp: CdpConnection, session: string, expression: string, context: OperationContext, contextId?: number): Promise<T> {
  const result = await cdp.send<Evaluation<T>>('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, ...(contextId === undefined ? {} : { contextId }),
  }, context, session);
  if (result.exceptionDetails || result.result.value === undefined) throw unsupported();
  return result.result.value;
}

async function navigateReady(cdp: CdpConnection, session: string, url: string, context: OperationContext): Promise<{ frameId: string }> {
  let unsubscribe = (): void => undefined;
  let unsubscribeNavigation = (): void => undefined;
  let committed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = (): void => rejectLoad(new EngineError('CANCELLED', 'Storage navigation cancelled', { retryable: false }));
  let rejectLoad: (error: EngineError) => void = () => undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    rejectLoad = reject;
    unsubscribeNavigation = cdp.on<{ frame: { url: string } }>('Page.frameNavigated', ({ frame }) => { if (frame.url === url) committed = true; }, session);
    unsubscribe = cdp.on('Page.loadEventFired', () => { if (committed) resolve(); }, session);
    timer = setTimeout(() => reject(new EngineError('OPERATION_TIMEOUT', 'Storage navigation timed out', { retryable: false })), context.timeoutMs);
    context.signal.addEventListener('abort', aborted, { once: true });
    if (context.signal.aborted) aborted();
  });
  try {
    const [navigation] = await Promise.all([
      cdp.send<{ frameId: string; errorText?: string }>('Page.navigate', { url }, context, session), loaded,
    ]);
    if (navigation.errorText) throw failed('origin-navigation');
    return navigation;
  } finally { unsubscribe(); unsubscribeNavigation(); clearTimeout(timer); context.signal.removeEventListener('abort', aborted); }
}

/** Opens an origin without contacting it or running application code. Always closes the temporary tab. */
async function withOrigin<T>(cdp: CdpConnection, origin: string, context: OperationContext, run: (session: string, contextId: number, current: () => OperationContext) => Promise<T>, existingTargetId?: string, probes?: StateProbeTargets): Promise<T> {
  const current = budget(context);
  const targetId = existingTargetId ?? await storageStep('origin-create', async () => probes ? probes.create(current()) : (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true }, current())).targetId);
  let session: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let interceptFailure = false;
  try {
    session = await storageStep('origin-attach', () => cdp.attachTarget(targetId, current()));
    const attached = session;
    unsubscribe = cdp.on<{ requestId: string }>('Fetch.requestPaused', ({ requestId }) => {
      void cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Content-Security-Policy', value: "default-src 'none'" }],
        body: Buffer.from('<!doctype html><html><head></head><body></body></html>').toString('base64'),
      }, current(), attached).catch(() => { interceptFailure = true; });
    }, session);
    await storageStep('origin-enable', () => cdp.send('Page.enable', {}, current(), attached));
    await storageStep('origin-interception', () => cdp.send('Network.setBypassServiceWorker', { bypass: true }, current(), attached));
    await storageStep('origin-interception', () => cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, current(), attached));
    const navigation = await storageStep('origin-navigation', () => navigateReady(cdp, attached, `${origin}/`, current()));
    if (interceptFailure) throw failed('origin-interception');
    const { executionContextId } = await storageStep('origin-world', () => cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: navigation.frameId, worldName: 'e2e-agent-browser-storage', grantUniveralAccess: false,
    }, current(), attached));
    if (await storageStep('origin-verification', () => evaluate<string>(cdp, attached, 'location.origin', current(), executionContextId)) !== origin) throw failed('origin-verification');
    return await storageStep('origin-storage', () => run(attached, executionContextId, current));
  } finally {
    unsubscribe?.();
    const cleanup = { ...context, signal: new AbortController().signal, timeoutMs: 2_000 };
    if (existingTargetId === undefined) {
      await storageStep('origin-release', () => releaseStateProbeTarget(cdp, targetId, cleanup, probes));
    }
    else if (session) {
      await cdp.send('Fetch.disable', {}, cleanup, session);
      await cdp.send('Network.setBypassServiceWorker', { bypass: false }, cleanup, session);
      try { await navigateReady(cdp, session, 'about:blank', cleanup); }
      finally { await cdp.send('Target.detachFromTarget', { sessionId: session }, cleanup); }
    }
  }
}

const CAPTURE_ORIGIN = `async () => {
  ${STRUCTURED_CODEC}
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('unsupported storage')); });
  const result = { origin: location.origin, localStorage: Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]), indexedDB: [] };
  if (typeof indexedDB.databases !== 'function') throw new Error('unsupported storage');
  for (const info of await indexedDB.databases()) {
    if (typeof info.name !== 'string' || !Number.isSafeInteger(info.version) || info.version < 1) throw new Error('unsupported storage');
    const db = await request(indexedDB.open(info.name));
    try {
      const database = { name: db.name, version: db.version, stores: [] };
      for (const name of db.objectStoreNames) {
        const tx = db.transaction(name, 'readonly');
        const store = tx.objectStore(name);
        const saved = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [], records: [] };
        for (const indexName of store.indexNames) {
          const index = store.index(indexName);
          saved.indexes.push({ name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry });
        }
        await new Promise((resolve, reject) => {
          tx.onabort = tx.onerror = () => reject(new Error('unsupported storage'));
          const cursor = store.openCursor();
          cursor.onerror = () => reject(new Error('unsupported storage'));
          cursor.onsuccess = async () => {
            const entry = cursor.result;
            if (!entry) { resolve(); return; }
            try {
              const item = { key: entry.primaryKey, value: entry.value };
              saved.records.push(item); entry.continue();
            } catch { reject(new Error('unsupported storage')); }
          };
        });
        saved.records = await Promise.all(saved.records.map(async item => ({ key: await encode(item.key), value: await encode(item.value) })));
        if (store.autoIncrement) {
          // Probe and abort: abort rolls the key generator back as well as the record.
          saved.nextKey = await new Promise((resolve, reject) => {
            const probe = db.transaction(name, 'readwrite'); let next;
            probe.onabort = () => Number.isSafeInteger(next) && next >= 1 ? resolve(next) : reject(new Error('unsupported storage'));
            probe.onerror = () => reject(new Error('unsupported storage'));
            const addition = probe.objectStore(name).add({});
            addition.onsuccess = () => { next = addition.result; probe.abort(); };
            addition.onerror = () => reject(new Error('unsupported storage'));
          });
        }
        database.stores.push(saved);
      }
      result.indexedDB.push(database);
    } finally { db.close(); }
  }
  return result;
}`;

/** Captures every tracked HTTP(S) origin, including IndexedDB structured-clone graphs. */
export async function captureState(cdp: CdpConnection, context: OperationContext, visitedOrigins: ReadonlySet<string> = new Set(), probes?: StateProbeTargets): Promise<EngineState> {
  const current = budget(context);
  try {
    const browserContextId = await storageStep('context-identity', () => targetContext(cdp, current(), probes));
    const origins = new Set([...visitedOrigins].filter((origin) => originOf(origin) === origin));
    const tabs: TabState[] = [];
    for (const target of await storageStep('target-list', () => cdp.listTargets(current()))) {
      if (target.type !== 'page' || target.browserContextId !== browserContextId) continue;
      const session = await storageStep('tab-attach', () => cdp.attachTarget(target.targetId, current()));
      try {
      const { frameTree } = await storageStep('tab-frames', () => cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, current(), session));
      const tab: TabState = { url: originOf(target.url) ? target.url : 'about:blank', sessionStorage: [] };
      const seen = new Set<string>();
      for (const frame of frames(frameTree)) {
        const origin = originOf(frame.securityOrigin ?? frame.url);
        if (!origin) continue;
        origins.add(origin);
        const { storageKey } = await storageStep('tab-storage-key', () => cdp.send<{ storageKey: string }>('Storage.getStorageKeyForFrame', { frameId: frame.id }, current(), session));
        if (storageKey !== origin && storageKey !== `${origin}/`) throw unsupported();
        if (seen.has(origin)) continue;
        seen.add(origin);
        const { executionContextId } = await storageStep('tab-world', () => cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
          frameId: frame.id, worldName: 'e2e-agent-browser-storage', grantUniveralAccess: false,
        }, current(), session));
        const values = await storageStep('tab-session-storage', () => evaluate<Pairs>(cdp, session, 'Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])', current(), executionContextId));
        if (!pairs(values)) throw unsupported();
        tab.sessionStorage.push({ origin, values });
      }
      tabs.push(tab);
      } finally {
        await storageStep('tab-release', () => cdp.send('Target.detachFromTarget', { sessionId: session }, { ...context, signal: new AbortController().signal, timeoutMs: 2_000 }));
      }
    }
    const storage: OriginState[] = [];
    for (const origin of origins) storage.push(await withOrigin(cdp, origin, current(), (session, contextId, remaining) =>
      evaluate<OriginState>(cdp, session, `(${CAPTURE_ORIGIN})()`, remaining(), contextId), undefined, probes));
    const { cookies } = await storageStep('cookies', () => cdp.send<{ cookies: Record<string, Json>[] }>('Storage.getCookies', probes?.browserContextId?.() ? { browserContextId: probes.browserContextId() } : {}, current()));
    const state: EngineState = { format: FORMAT, version: 1, data: { cookies, origins: storage, tabs } };
    await storageStep('snapshot-validation', async () => readState(state));
    return state;
  } catch (error) {
    if (error instanceof StorageFailure || (error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT' || error.code === 'UNSUPPORTED_CAPABILITY'))) throw error;
    throw failed();
  }
}

const RESTORE_ORIGIN = `async state => {
  ${STRUCTURED_CODEC}
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('storage restore failed')); req.onblocked = () => reject(new Error('storage restore blocked')); });
  localStorage.clear(); for (const [key, value] of state.localStorage) localStorage.setItem(key, value);
  for (const info of await indexedDB.databases()) await request(indexedDB.deleteDatabase(info.name));
  for (const data of state.indexedDB) {
    const opening = indexedDB.open(data.name, data.version);
    opening.onupgradeneeded = () => {
      for (const store of data.stores) {
        const created = opening.result.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
        for (const index of store.indexes) created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    };
    const db = await request(opening);
    try {
      for (const saved of data.stores) await new Promise((resolve, reject) => {
        const tx = db.transaction(saved.name, 'readwrite'); const store = tx.objectStore(saved.name);
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('storage restore failed'));
        for (const item of saved.records) {
          if (saved.keyPath === null) store.put(decode(item.value), decode(item.key)); else store.put(decode(item.value));
        }
        // Persist the original generator even when its highest records were deleted.
        if (saved.autoIncrement && saved.nextKey > 1 && !saved.records.some(item => typeof decode(item.key) === 'number' && decode(item.key) >= saved.nextKey - 1)) {
          const bump = {}; const value = saved.nextKey - 1;
          if (typeof saved.keyPath === 'string') {
            const parts = saved.keyPath.split('.'); let object = bump;
            for (let i = 0; i < parts.length - 1; i++) { const nested = {}; Object.defineProperty(object, parts[i], { value: nested, enumerable: true, configurable: true, writable: true }); object = nested; }
            Object.defineProperty(object, parts[parts.length - 1], { value, enumerable: true, configurable: true, writable: true });
          }
          if (saved.keyPath === null) store.put(bump, value); else store.put(bump);
          store.delete(value);
        }
      });
    } finally { db.close(); }
  }
  return true;
}`;

/** Replacement is mandatory: the callback must destroy the old profile, including untracked origins. */
export async function restoreState(state: EngineState, context: OperationContext, replaceBrowser: () => Promise<CdpConnection>, probes?: StateProbeTargets): Promise<CdpConnection> {
  const data = readState(state);
  const current = budget(context);
  const cdp = await replaceBrowser();
  try {
    const cookies = data.cookies.map((cookie) => {
      // Network.Cookie has read-only fields that CookieParam does not accept.
      const { size: _size, session: _session, partitionKeyOpaque: _opaque, ...rest } = cookie;
      return { ...rest, ...(cookie.expires === -1 ? { expires: undefined } : {}) };
    });
    await cdp.send('Storage.setCookies', { cookies, ...(probes?.browserContextId?.() ? { browserContextId: probes.browserContextId() } : {}) }, current());
    for (const origin of data.origins) await withOrigin(cdp, origin.origin, current(), (session, contextId, remaining) =>
      evaluate(cdp, session, `(${RESTORE_ORIGIN})(${JSON.stringify(origin)})`, remaining(), contextId), undefined, probes);
    const browserContextId = data.tabs.length ? await targetContext(cdp, current(), probes) : undefined;
    const initial = data.tabs.length ? (await cdp.listTargets(current())).find((target) => target.type === 'page' && target.browserContextId === browserContextId) : undefined;
    for (const [index, tab] of data.tabs.entries()) {
      const targetId = index === 0 && initial ? initial.targetId
        : (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true, ...(probes?.browserContextId?.() ? { browserContextId: probes.browserContextId() } : {}) }, current())).targetId;
      // Populate the tab's origin namespaces without running any application script.
      for (const entry of tab.sessionStorage) await withOrigin(cdp, entry.origin, current(), (session, contextId, remaining) =>
        evaluate(cdp, session, `(() => { sessionStorage.clear(); for (const [key, value] of ${JSON.stringify(entry.values)}) sessionStorage.setItem(key, value); return true; })()`, remaining(), contextId), targetId, probes);
    }
    return cdp;
  } catch (error) {
    if (error instanceof EngineError && (error.code === 'CANCELLED' || error.code === 'OPERATION_TIMEOUT')) throw error;
    throw failed();
  }
}
