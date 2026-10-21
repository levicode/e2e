import { NativeFrameError } from './frames.ts';

export const NATIVE_PROTOCOL = 'agent-browser-session/1';
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_TIMEOUT_MS = 3_600_000;

export type ScopeState = 'usable' | 'quarantined' | 'closed';
export type Effects = 'not-dispatched' | 'completed' | 'unknown';
export interface WireError { readonly code: string }
export interface NativeLimits {
  readonly maxFrameBytes: number;
  readonly maxPendingOperations: number;
  readonly maxPendingDecisions: number;
  readonly maxTimeoutMs: number;
}
export interface NativeReady {
  readonly type: 'ready'; readonly id: string; readonly protocol: typeof NATIVE_PROTOCOL;
  readonly sessionId: string; readonly generation: number; readonly capabilities: readonly string[];
  readonly limits: NativeLimits; readonly scopeState: ScopeState;
}
export interface NativeResult {
  readonly type: 'result'; readonly id: string; readonly generation: number; readonly operationSeq: number;
  readonly ok: boolean; readonly data?: unknown; readonly error?: WireError;
  readonly effects: Effects; readonly scopeState: ScopeState;
}
export interface NativeControlResult {
  readonly type: 'control-result'; readonly id: string; readonly generation: number;
  readonly accepted: boolean; readonly error?: WireError; readonly scopeState: ScopeState;
}
export interface NativeEvent {
  readonly type: 'event'; readonly generation: number; readonly sequence: number;
  readonly event: string; readonly payload: unknown;
  readonly decision?: { readonly token: string; readonly timeoutMs: number };
}
export type ServerMessage = NativeReady | NativeResult | NativeControlResult | NativeEvent |
  { readonly type: 'error'; readonly id?: string; readonly error: WireError; readonly scopeState: ScopeState } |
  { readonly type: 'closed'; readonly id: string; readonly generation: number; readonly scopeState: 'closed' };

const ERROR_CODES = new Set([
  'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable',
  'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing',
  'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'locator-not-found', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted',
]);
const STATES = new Set(['usable', 'quarantined', 'closed']);
const EFFECTS = new Set(['not-dispatched', 'completed', 'unknown']);

/** Validate the negotiated server envelope before it can mutate client state. */
export function serverMessage(value: Record<string, unknown>): ServerMessage {
  if (!isServerMessage(value)) throw new NativeFrameError();
  return value;
}

function isServerMessage(value: Record<string, unknown>): value is Record<string, unknown> & ServerMessage {
  if (typeof value['type'] !== 'string') throw new NativeFrameError();
  validateJson(value);
  switch (value['type']) {
    case 'ready': {
      keys(value, ['type', 'id', 'protocol', 'sessionId', 'generation', 'capabilities', 'limits', 'scopeState']);
      identifier(value['id']); identifier(value['sessionId']); positive(value['generation']); state(value['scopeState']);
      if (value['protocol'] !== NATIVE_PROTOCOL || !Array.isArray(value['capabilities']) || value['capabilities'].length > 64) throw new NativeFrameError();
      for (const capability of value['capabilities']) identifier(capability);
      if (new Set(value['capabilities']).size !== value['capabilities'].length) throw new NativeFrameError();
      const limits = record(value['limits']);
      keys(limits, ['maxFrameBytes', 'maxPendingOperations', 'maxPendingDecisions', 'maxTimeoutMs']);
      for (const limit of Object.values(limits)) positive(limit);
      break;
    }
    case 'result':
      keys(value, ['type', 'id', 'generation', 'operationSeq', 'ok', 'effects', 'scopeState'], ['data', 'error']);
      identifier(value['id']); positive(value['generation']); positive(value['operationSeq']); state(value['scopeState']);
      if (typeof value['ok'] !== 'boolean' || (typeof value['effects'] !== 'string' || !EFFECTS.has(value['effects']))) throw new NativeFrameError();
      if (value['ok']) {
        if (!Object.hasOwn(value, 'data') || Object.hasOwn(value, 'error')) throw new NativeFrameError();
      } else {
        error(value['error']);
        if (Object.hasOwn(value, 'data')) throw new NativeFrameError();
      }
      if (value['effects'] === 'unknown' && (value['ok'] || value['scopeState'] === 'usable')) throw new NativeFrameError();
      break;
    case 'control-result':
      keys(value, ['type', 'id', 'generation', 'accepted', 'scopeState'], ['error']);
      identifier(value['id']); positive(value['generation']); state(value['scopeState']);
      if (typeof value['accepted'] !== 'boolean') throw new NativeFrameError();
      if (value['accepted']) {
        if (Object.hasOwn(value, 'error')) throw new NativeFrameError();
      } else error(value['error']);
      break;
    case 'event': {
      keys(value, ['type', 'generation', 'sequence', 'event', 'payload'], ['decision']);
      positive(value['generation']); positive(value['sequence']); identifier(value['event']);
      if (value['decision'] !== undefined) {
        const decision = record(value['decision']);
        keys(decision, ['token', 'timeoutMs']);
        identifier(decision['token']); positive(decision['timeoutMs']);
      }
      break;
    }
    case 'error':
      keys(value, ['type', 'error', 'scopeState'], ['id']);
      if (value['id'] !== undefined) identifier(value['id']);
      error(value['error']); state(value['scopeState']);
      break;
    case 'closed':
      keys(value, ['type', 'id', 'generation', 'scopeState']);
      identifier(value['id']); positive(value['generation']);
      if (value['scopeState'] !== 'closed') throw new NativeFrameError();
      break;
    default: throw new NativeFrameError();
  }
  return true;
}

/** Accept JSON values only within the native parser's structural depth bound. */
function validateJson(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.depth > 128) throw new NativeFrameError();
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new NativeFrameError();
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    } else if (!['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) throw new NativeFrameError();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new NativeFrameError();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new NativeFrameError();
}
function identifier(value: unknown): void {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > 128 || Array.from(value).some(character => { const point = character.codePointAt(0)!; return point < 32 || (point >= 127 && point <= 159); })) throw new NativeFrameError();
}
function positive(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new NativeFrameError();
}
function state(value: unknown): void {
  if (typeof value !== 'string' || !STATES.has(value)) throw new NativeFrameError();
}
function error(value: unknown): void {
  const object = record(value);
  keys(object, ['code']);
  if (typeof object['code'] !== 'string' || !ERROR_CODES.has(object['code'])) throw new NativeFrameError();
}
