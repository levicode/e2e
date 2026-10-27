/** Runtime validation for the typed native fixture boundary. */
import { EngineError, validateJsonValue, type JsonValue, type NodeRef } from 'e2e/engine';
import type { Cookie, CookieFields } from '../browser.ts';
import type { BrowserCommandMap, BrowserDecision, BrowserEventMap, NativeBodyChunk } from './browser-contract.ts';

/** A malformed native response cannot become a successful browser operation. */
function invalid(): never {
  throw new EngineError('ENGINE_FAILURE', 'native browser response does not match its command contract', { retryable: false });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === undefined || typeof value === 'boolean' ? value : invalid();
}

function cookie(value: unknown): Cookie {
  const item = record(value);
  const name = string(item['name']);
  const valueText = string(item['value']);
  const expires = item['expires'];
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires))) return invalid();
  const httpOnly = optionalBoolean(item['httpOnly']);
  const secure = optionalBoolean(item['secure']);
  const sameSite = item['sameSite'];
  if (sameSite !== undefined && sameSite !== 'Strict' && sameSite !== 'Lax' && sameSite !== 'None') return invalid();
  const common: CookieFields = {
    name, value: valueText,
    ...(expires === undefined || expires < 0 ? {} : { expires: Math.floor(expires) }),
    ...(httpOnly === undefined ? {} : { httpOnly }),
    ...(secure === undefined ? {} : { secure }),
    ...(sameSite === undefined ? {} : { sameSite }),
  };
  if (item['url'] !== undefined) {
    if (item['domain'] !== undefined || item['path'] !== undefined) return invalid();
    return { ...common, url: string(item['url']) };
  }
  return { ...common, domain: string(item['domain']), ...(item['path'] === undefined ? {} : { path: string(item['path']) }) };
}

function chunk(value: unknown): NativeBodyChunk {
  const item = record(value);
  const base64 = string(item['base64']);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return invalid();
  const nextOffset = item['nextOffset'];
  if (typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset) || nextOffset < 0) return invalid();
  const eof = item['eof'];
  if (typeof eof !== 'boolean') return invalid();
  return { base64, nextOffset, eof };
}

function empty(value: unknown): null {
  return value === null ? null : invalid();
}

function subscription(value: unknown): { subscriptionId: string } {
  const subscriptionId = string(record(value)['subscriptionId']);
  if (subscriptionId.length === 0) return invalid();
  return { subscriptionId };
}

function sealed(value: unknown): { handle: string; size: number; sha256: string } {
  const item = record(value);
  const handle = string(item['handle']);
  const sha256 = string(item['sha256']);
  if (!handle || !/^[a-f0-9]{64}$/.test(sha256)) return invalid();
  return { handle, size: counter(item['size']), sha256 };
}

const MAX_CORRELATION_CANDIDATES = 100_000;
const MAX_U64 = '18446744073709551615';
type CorrelationArgs = BrowserCommandMap['fixture.correlate']['args'];

/** Correlation never admits aliases, extra fields, or noncanonical native references. */
function correlationRef(value: unknown): NodeRef {
  const item = record(value);
  exactKeys(item, ['id', 'revision']);
  const id = string(item['id']);
  const revision = string(item['revision']);
  if (!/^@e[1-9][0-9]*$/.test(id) || !/^[1-9][0-9]*$/.test(revision)) invalid();
  const bounded = (digits: string): boolean => digits.length < MAX_U64.length || (digits.length === MAX_U64.length && digits <= MAX_U64);
  if (!bounded(id.slice(2)) || !bounded(revision)) invalid();
  return { id, revision };
}

/** This closed seam must not silently accept a future command/result shape. */
function exactKeys(item: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) invalid();
}

/** Snapshot request values before admission/transport can yield to caller mutation. */
export function snapshotCorrelationArgs(value: unknown): CorrelationArgs {
  try {
    const item = record(value);
    exactKeys(item, ['located', 'observed']);
    const located = item['located'];
    const observed = item['observed'];
    if (!Array.isArray(located) || !Array.isArray(observed) || located.length + observed.length > MAX_CORRELATION_CANDIDATES) return invalid();
    const refs = (values: unknown[]): NodeRef[] => {
      const seen = new Set<string>();
      return Array.from(values, candidate => {
        const ref = correlationRef(candidate);
        if (seen.has(ref.id)) invalid();
        seen.add(ref.id);
        return ref;
      });
    };
    return { located: refs(located), observed: refs(observed) };
  } catch {
    throw new EngineError('INVALID_STATE', 'The native fixture correlation request does not match its contract', { retryable: false });
  }
}

/** A successful correlation is valid only relative to the exact dispatched candidates. */
function correlationResult(value: unknown, request: CorrelationArgs, expectedScope: string): BrowserCommandMap['fixture.correlate']['result'] {
  const item = record(value);
  exactKeys(item, ['identityScope', 'matches']);
  const identityScope = scope(item['identityScope']);
  const matches = item['matches'];
  if (identityScope !== expectedScope || !Array.isArray(matches) || matches.length !== request.located.length) return invalid();
  const observed = new Map(request.observed.map(ref => [ref.id, ref.revision]));
  return { identityScope, matches: Array.from(matches, match => {
    if (match === null) return null;
    const ref = correlationRef(match);
    if (observed.get(ref.id) !== ref.revision) return invalid();
    return ref;
  }) };
}

const decoders = {
  'blob.create': (value: unknown) => {
    const maxChunkBytes = counter(record(value)['maxChunkBytes']);
    if (maxChunkBytes < 1 || maxChunkBytes > 262144) return invalid();
    return { ...sealed(value), maxChunkBytes };
  },
  'blob.write': (value: unknown) => ({ nextOffset: counter(record(value)['nextOffset']) }),
  'blob.seal': sealed,
  'blob.release': (value: unknown): { released: true } => record(value)['released'] === true ? { released: true } : invalid(),
  'page.navigate': empty,
  'page.reload': empty,
  'page.back': empty,
  'page.forward': empty,
  'page.url': (value: unknown) => ({ url: string(record(value)['url']) }),
  'page.title': (value: unknown) => ({ title: string(record(value)['title']) }),
  'page.evaluate': (value: unknown) => {
    const result = record(value)['value'];
    validateJsonValue(result, 'native evaluate result');
    // validateJsonValue validates recursively; TypeScript cannot narrow through its void signature.
    return { value: result as JsonValue };
  },
  'context.cookies.get': (value: unknown) => {
    const cookies = record(value)['cookies'];
    if (!Array.isArray(cookies)) return invalid();
    return { cookies: cookies.map(cookie) };
  },
  'context.cookies.set': empty,
  'context.init-script': empty,
  'context.media': empty,
  'context.viewport': empty,
  'input.keyboard': empty,
  'input.mouse': empty,
  'network.routes.replace': empty,
  'network.responses.subscribe': subscription,
  'network.responses.unsubscribe': empty,
  'network.body.read': chunk,
  'network.body.release': empty,
  'dialog.register': empty,
  'download.metadata': (value: unknown) => { const item = record(value); const identityScope = scope(item['identityScope']); if (item['source'] === 'local') return { identityScope, source: 'local' as const }; if (item['source'] !== 'provider') return invalid(); const basename = string(item['basename']); if (!/^[A-Za-z0-9_-]+$/.test(basename)) return invalid(); return { identityScope, source: 'provider' as const, basename }; },
  'download.unsubscribe': empty,
  'download.read': chunk,
  'download.release': empty,
} satisfies { [K in Exclude<keyof BrowserCommandMap, 'fixture.correlate' | 'download.subscribe'>]: (value: unknown) => BrowserCommandMap[K]['result'] };

/** Decode first; the cast only restores the mapped command/result correlation. */
export function decodeBrowserResult<K extends keyof BrowserCommandMap>(command: K, value: unknown, owner?: { identityScope: string; args?: CorrelationArgs }): BrowserCommandMap[K]['result'] {
  if (command === 'fixture.correlate') {
    if (owner?.args === undefined) return invalid();
    return correlationResult(value, owner.args, owner.identityScope) as BrowserCommandMap[K]['result'];
  }
  if (command === 'download.subscribe') {
    if (owner === undefined) return invalid();
    return { ...subscription(value), identityScope: owner.identityScope } as BrowserCommandMap[K]['result'];
  }
  return decoders[command as Exclude<K, 'fixture.correlate' | 'download.subscribe'>](value) as BrowserCommandMap[K]['result'];
}

/** Read an exact nonnegative counter without accepting coercion or unsafe integers. */
function counter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}

function headers(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([name, field]) => [name, string(field)]));
}

function scope(value: unknown): string {
  const identity = string(value);
  return identity.length > 0 ? identity : invalid();
}

const eventDecoders = {
  'registry-released': (value: unknown) => ({ identityScope: scope(record(value)['identityScope']), registryVersion: counter(record(value)['registryVersion']) }),
  'network.request': (value: unknown) => {
    const event = record(value);
    const request = record(event['request']);
    const registrationIds = event['registrationIds'];
    if (!Array.isArray(registrationIds)) return invalid();
    const postData = request['postData'];
    const postDataBase64 = request['postDataBase64'];
    const postDataHandle = request['postDataHandle'];
    if ([postData, postDataBase64, postDataHandle].filter(field => field !== undefined).length > 1) invalid();
    if (postDataBase64 !== undefined && Buffer.from(string(postDataBase64), 'base64').toString('base64') !== postDataBase64) invalid();
    return {
      identityScope: scope(event['identityScope']), token: string(event['token']), timeoutMs: counter(event['timeoutMs']), version: counter(event['version']),
      registrationIds: registrationIds.map(string),
      ...(event['fallbackOf'] === undefined ? {} : { fallbackOf: string(event['fallbackOf']) }),
      request: { url: string(request['url']), method: string(request['method']), headers: headers(request['headers']),
        ...(postData === undefined ? {} : { postData: string(postData) }),
        ...(postDataBase64 === undefined ? {} : { postDataBase64: string(postDataBase64) }),
        ...(postDataHandle === undefined ? {} : { postDataHandle: scope(postDataHandle) }),
      },
    };
  },
  'network.response': (value: unknown) => {
    const event = record(value);
    const status = counter(event['status']);
    if (status < 100 || status > 599) return invalid();
    return { identityScope: scope(event['identityScope']), activePage: boolean(event['activePage']), handle: string(event['handle']), url: string(event['url']), status, headers: headers(event['headers']) };
  },
  'dialog.opened': (value: unknown) => {
    const event = record(value);
    const type = event['type'];
    if (type !== 'alert' && type !== 'confirm' && type !== 'prompt' && type !== 'beforeunload') return invalid();
    return { identityScope: scope(event['identityScope']), token: string(event['token']), timeoutMs: counter(event['timeoutMs']), type, message: string(event['message']) };
  },
  'download.started': (value: unknown) => {
    const event = record(value);
    return { identityScope: scope(event['identityScope']), activePage: boolean(event['activePage']), handle: string(event['handle']), suggestedFilename: string(event['suggestedFilename']) };
  },
} satisfies { [K in keyof BrowserEventMap]: (value: unknown) => BrowserEventMap[K] };

/** Validate the payload after the client validates its generation and decision envelope. */
export function decodeBrowserEvent<K extends keyof BrowserEventMap>(event: K, value: unknown): BrowserEventMap[K] {
  return eventDecoders[event](value) as BrowserEventMap[K];
}

/** Validate one outgoing Browser decision before a one-use resource token is touched. */
export function validateBrowserDecision(decision: unknown): asserts decision is BrowserDecision {
  try {
    const item = record(decision);
    const keys = (object: Record<string, unknown>, allowed: readonly string[]): void => {
      if (Object.keys(object).some(key => !allowed.includes(key))) invalid();
    };
    const token = (value: unknown): void => {
      if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) invalid();
    };
    const pairs = (value: unknown): void => {
      if (!Array.isArray(value) || value.length > 1024) return invalid();
      for (const entry of value) {
        const pair = record(entry);
        keys(pair, ['name', 'value']);
        token(pair['name']);
        if (/[\r\n\0]/.test(string(pair['value']))) invalid();
      }
    };
    const body = (object: Record<string, unknown>, required: boolean): void => {
      const inline = object['bodyBase64'];
      const handle = object['bodyHandle'];
      if (inline !== undefined && handle !== undefined) invalid();
      if (required && inline === undefined && handle === undefined) invalid();
      if (inline !== undefined) {
        if (typeof inline !== 'string' || inline.length > 1048576 || Buffer.from(inline, 'base64').toString('base64') !== inline) invalid();
      }
      if (handle !== undefined && (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(handle))) invalid();
    };
    switch (item['kind']) {
      case 'fulfill': {
        keys(item, ['kind', 'status', 'headers', 'bodyBase64', 'bodyHandle']);
        const status = counter(item['status']);
        if (status < 100 || status > 599) invalid();
        pairs(item['headers']);
        body(item, true);
        break;
      }
      case 'continue':
      case 'fallback': {
        keys(item, ['kind', 'overrides']);
        const overrides = record(item['overrides']);
        keys(overrides, ['url', 'method', 'headers', 'bodyBase64', 'bodyHandle']);
        if (overrides['url'] !== undefined && (string(overrides['url']).length === 0 || /\p{Cc}/u.test(string(overrides['url'])))) invalid();
        if (overrides['method'] !== undefined) token(overrides['method']);
        if (overrides['headers'] !== undefined) pairs(overrides['headers']);
        body(overrides, false);
        break;
      }
      case 'abort': keys(item, ['kind']); break;
      case 'dialog':
        keys(item, ['kind', 'accept', 'promptText']);
        boolean(item['accept']);
        if (item['promptText'] !== undefined) { string(item['promptText']); if (item['accept'] !== true) invalid(); }
        break;
      default: invalid();
    }
  } catch {
    throw new EngineError('INVALID_STATE', 'The native browser decision does not match its capability contract', { retryable: false });
  }
}
