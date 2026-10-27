/** Decode only the typed engine wire contract; no backend objects enter e2e. */
import { decodeEngineFieldValues, type SemanticNode } from 'e2e/engine';
import type { EngineCommandMap, NativeBlob, NativeImage, NativeObservation, NativeTraceImage, Scoped } from './engine-contract.ts';

const invalid = (): never => { throw new Error('Invalid native engine contract'); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const text = (value: unknown): string => typeof value === 'string' ? value : invalid();
const identity = (value: unknown): string => text(value).length > 0 ? text(value) : invalid();
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : invalid();
const count = (value: unknown): number => Number.isSafeInteger(value) && number(value) >= 0 ? number(value) : invalid();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const scoped = (value: unknown): Scoped => ({ identityScope: identity(record(value)['identityScope']) });
const viewport = (value: unknown) => { const item = record(value); return { width: count(item['width']), height: count(item['height']) }; };
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();

function blob(value: unknown): NativeBlob {
  const item = record(value);
  const sha256 = text(item['sha256']);
  if (!/^[a-f0-9]{64}$/.test(sha256)) invalid();
  return { ...scoped(item), handle: identity(item['handle']), size: count(item['size']), sha256 };
}
function image(value: unknown): NativeImage {
  const item = record(value);
  if (item['mediaType'] !== 'image/png' || number(item['scale']) <= 0) invalid();
  return { ...blob(item), ...viewport(item), mediaType: 'image/png', scale: number(item['scale']), maskedRegionCount: count(item['maskedRegionCount']) };
}
function traceImage(value: unknown): NativeTraceImage {
  const item = record(value);
  const viewportRef = node({ ref: item['viewportRef'] }).ref;
  if (!/^[1-9][0-9]{0,19}$/.test(viewportRef.revision) || BigInt(viewportRef.revision) > 18446744073709551615n) invalid();
  const capturedViewport = viewport(item['viewport']);
  if (capturedViewport.width === 0 || capturedViewport.height === 0) invalid();
  return { ...image(item), viewportRef, viewport: capturedViewport, location: text(item['location']) };
}
function node(value: unknown, depth = 0): SemanticNode {
  if (depth > 512) invalid();
  const item = record(value);
  const ref = record(item['ref']);
  const id = identity(ref['id']);
  if (!/^@e[1-9][0-9]*$/.test(id)) invalid();
  const result: { -readonly [K in keyof SemanticNode]: SemanticNode[K] } = { ref: { id, revision: text(ref['revision']) } };
  for (const key of ['role', 'name', 'text', 'value', 'selection', 'testId', 'selector'] as const) if (item[key] !== undefined) result[key] = text(item[key]);
  if (item['inputPurpose'] !== undefined) {
    if (!['username', 'password', 'one-time-code', 'generic-secret', 'none'].includes(text(item['inputPurpose']))) invalid();
    const purpose = item['inputPurpose'];
    if (purpose === 'username' || purpose === 'password' || purpose === 'one-time-code' || purpose === 'generic-secret' || purpose === 'none') result.inputPurpose = purpose;
    else invalid();
  }
  if (item['states'] !== undefined) {
    const states = record(item['states']);
    if (Object.keys(states).some(key => !['checked', 'disabled', 'selected', 'expanded', 'pressed', 'focused', 'hidden', 'secure'].includes(key))) invalid();
    result['states'] = Object.fromEntries(Object.entries(states).map(([key, field]) => [key, bool(field)]));
  }
  if (item['attributes'] !== undefined) result['attributes'] = Object.fromEntries(Object.entries(record(item['attributes'])).map(([key, field]) => [key, text(field)]));
  if (item['rect'] !== undefined) { const box = record(item['rect']); result['rect'] = { x: number(box['x']), y: number(box['y']), width: number(box['width']), height: number(box['height']) }; if (number(box['width']) < 0 || number(box['height']) < 0) invalid(); }
  if (item['level'] !== undefined) result['level'] = count(item['level']);
  if (item['framePath'] !== undefined) result['framePath'] = list(item['framePath']).map(text);
  if (item['children'] !== undefined) result['children'] = list(item['children']).map(child => node(child, depth + 1));
  // All admitted fields have been projected and validated above.
  return result;
}
function observation(value: unknown): NativeObservation {
  const item = record(value);
  return { ...scoped(item), revision: text(item['revision']), root: node(item['root']), viewport: viewport(item['viewport']),
    ...(item['viewportRef'] === undefined ? {} : { viewportRef: node({ ref: item['viewportRef'] }).ref }),
    ...(item['location'] === undefined ? {} : { location: text(item['location']) }),
    ...(item['truncated'] === undefined ? {} : { truncated: bool(item['truncated']) }),
    ...(item['treeUnavailable'] === undefined ? {} : { treeUnavailable: bool(item['treeUnavailable']) }),
    ...(item['pixels'] === undefined ? {} : { pixels: image(item['pixels']) }),
    ...(item['maskedRegionCount'] === undefined ? {} : { maskedRegionCount: count(item['maskedRegionCount']) }),
  };
}
const empty = (value: unknown): null => value === null ? null : invalid();
const recoveryScope = (value: unknown) => { const item = record(value); const recovery = record(item['recoveryIdentity']); return { ...scoped(item), recoveryIdentity: { browser: identity(recovery['browser']), context: identity(recovery['context']), page: identity(recovery['page']) } }; };
const decoders = {
  'scope.open': recoveryScope,
  'scope.interop.prepare': (value: unknown) => { const item = record(value); if (Object.keys(item).length !== 2) invalid(); return { preparationId: identity(item['preparationId']), endpoint: text(item['endpoint']) }; },
  'scope.interop.adopt': recoveryScope,
  'scope.interop.abort': empty,
  'scope.interop.retire': empty,
  'scope.interop.identify': (value: unknown) => { const item = record(value); if (Object.keys(item).length !== 3) invalid(); return { contextId: identity(item['contextId']), targetId: identity(item['targetId']), persistent: bool(item['persistent']) }; },
  'page.activate': (value: unknown): { activated: true } => { const item = record(value); if (Object.keys(item).length !== 1 || item['activated'] !== true) invalid(); return { activated: true }; },
  'scope.configure': empty, 'scope.end': empty, 'scope.restart': recoveryScope, 'scope.reset': scoped, 'scope.reconnect': scoped,
  'browser.observe': observation,
  'browser.trace': (value: unknown): NativeObservation => {
    const item = record(value);
    if (item['pixels'] !== undefined || item['treeUnavailable'] === true) invalid();
    return observation(item);
  },
  'fixture.query': (value: unknown) => { const item = record(value); return { ...scoped(item), revision: text(item['revision']), nodes: list(item['nodes']).map(child => node(child)) }; },
  'fixture.read-fields': (_value: unknown): EngineCommandMap['fixture.read-fields']['result'] => invalid(),
  'browser.query': (value: unknown) => { const item = record(value); return { ...scoped(item), revision: text(item['revision']), nodes: list(item['nodes']).map(child => node(child)) }; },
  'browser.perform': empty, 'browser.pointer': empty, 'browser.keyboard.type': empty, 'browser.keyboard.press': empty,
  'capture.screenshot': image,
  'state.capture': (value: unknown) => { const item = record(value); if (item['format'] !== 'agent-browser-storage-state' || item['version'] !== 1) invalid(); return { ...blob(item), format: 'agent-browser-storage-state' as const, version: 1 as const }; },
  'state.restore': scoped,
  'recording.start': empty,
  'recording.stop': (value: unknown) => { const item = record(value);
    const missing = Object.hasOwn(item, 'missingSegment');
    const hasSegments = Object.hasOwn(item, 'segments');
    const keys = ['identityScope', ...(hasSegments ? ['segments'] : []), ...(missing ? ['missingSegment'] : [])];
    if ((!missing && !hasSegments) || Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))) invalid();
    const missingSegment = missing ? count(item['missingSegment']) : undefined;
    if (missingSegment === 0) invalid();
    if (!hasSegments) return { ...scoped(item), missingSegment: missingSegment! };
    return { ...scoped(item), ...(missingSegment === undefined ? {} : { missingSegment }), segments: list(item['segments']).map(entry => { const segment = record(entry); const startedAt = text(segment['startedAt']); if (!Number.isFinite(Date.parse(startedAt)) || segment['mediaType'] !== 'video/webm') invalid(); return { ...blob(segment), mediaType: 'video/webm' as const, startedAt }; }) }; },
  'session.environment': (value: unknown) => { const item = record(value); return { ...scoped(item), browser: text(item['browser']), ...(item['userAgent'] === undefined ? {} : { userAgent: text(item['userAgent']) }) }; },
  'blob.read': (value: unknown) => { const item = record(value); const base64 = text(item['base64']); if (Buffer.from(base64, 'base64').toString('base64') !== base64) invalid(); return { base64, nextOffset: count(item['nextOffset']), eof: bool(item['eof']) }; },
} satisfies { [K in keyof EngineCommandMap]: (value: unknown) => EngineCommandMap[K]['result'] };

export function decodeEngineResult<K extends keyof EngineCommandMap>(name: K, value: unknown, args?: EngineCommandMap[K]['args']): EngineCommandMap[K]['result'] {
  if (name === 'fixture.read-fields') {
    const item = record(value);
    if (Object.keys(item).length !== 2 || Object.keys(item).some(key => key !== 'identityScope' && key !== 'values')) invalid();
    const fields = (args as EngineCommandMap['fixture.read-fields']['args'] | undefined)?.fields;
    if (fields === undefined) return invalid();
    return { ...scoped(item), values: decodeEngineFieldValues(item['values'], fields) } as EngineCommandMap[K]['result'];
  }
  if (name === 'capture.screenshot' && (args as EngineCommandMap['capture.screenshot']['args'] | undefined)?.purpose === 'trace') return traceImage(value) as EngineCommandMap[K]['result'];
  return decoders[name](value) as EngineCommandMap[K]['result'];
}
