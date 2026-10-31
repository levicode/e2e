/** Fixture-only, closed diagnostics. These identities confer no execution authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const PREFIX = 'ENGINE_SECRETS_DIAGNOSTIC ';
const hex = /^[a-f0-9]{64}$/;
const admissions = ['callback-check', 'require-attempt', 'owner-check', 'pending-latch', 'caller-aborted', 'download-readiness', 'ensure-connected', 'final-owner-check'] as const;
const retirements = ['download-file', 'retire-attempt', 'finalized-video', 'recording-stop', 'late-recording-stop', 'connection-cleanup', 'native-video-retire', 'interop-retire', 'playwright-close', 'scope-end', 'native-close', 'provider-release', 'publication', 'worker-release', 'worker-acquisition-cleanup', 'native-resource-cleanup', 'unknown'] as const;
const codes = new Set(['frame-not-found', 'frame-ambiguous', 'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable', 'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing', 'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'invalid-locator', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'fill-unsupported-target', 'no-editable-focus', 'tap-target-replaced-before-press', 'locator-not-found', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted', 'unknown']);
export type SecretsAdmissionStage = typeof admissions[number];
export type SecretsRetirementStage = typeof retirements[number];
type SecretsPresence = 'undefined' | 'null' | 'value';
export interface SecretsContext { readonly captureNonce: string; readonly workerToken: string; readonly surface: number; readonly attempt: number }
type SecretsEvent =
  | { readonly kind: 'start' }
  | { readonly kind: 'guard'; readonly workerRetired: boolean; readonly workerCleanupUnconfirmed: boolean; readonly retirementFailurePresent: boolean; readonly attemptPresent: boolean; readonly retiringAttemptPresent: boolean; readonly connectingPresent: boolean }
  | { readonly kind: 'admission'; readonly stage: SecretsAdmissionStage; readonly wire: 'absent'; readonly origin: 'unjoined' }
  | { readonly kind: 'retirement'; readonly stage: SecretsRetirementStage; readonly before: SecretsPresence; readonly after: SecretsPresence }
  | { readonly kind: 'cleanup'; readonly nativeRetired: boolean; readonly finalizedCleanupProven: boolean; readonly recordingsRetired: boolean; readonly released: boolean; readonly connectingCleanupFailurePresent: boolean; readonly retiringAttemptCleared: boolean; readonly reason: 'receipt-failed' | 'local-wait-departure' | 'unresolved-custody' | 'complete' | 'unknown'; readonly dirty: 'unknown' }
  | { readonly kind: 'overflow'; readonly limit: 8 }
  | { readonly kind: 'query'; readonly client: number; readonly generation: number; readonly operationSeq: number; readonly command: 'fixture.query' | 'fixture.read-fields' | 'browser.query'; readonly transmittedTimeoutMs: number; readonly selectedLocalCancel: 'none' | 'abort' | 'deadline'; readonly rawCode: string; readonly rawEffects: 'not-dispatched' | 'completed' | 'unknown'; readonly rawScopeState: 'usable' | 'quarantined' | 'closed' | 'unknown'; readonly returnedCode: string; readonly timeoutRewritten: boolean; readonly cancelAckSeen: boolean };

type Rule = 'boolean' | 'integer' | 'timeout' | readonly (string | number)[];
const schema: Record<SecretsEvent['kind'], Readonly<Record<string, Rule>>> = {
  start: {},
  guard: { workerRetired: 'boolean', workerCleanupUnconfirmed: 'boolean', retirementFailurePresent: 'boolean', attemptPresent: 'boolean', retiringAttemptPresent: 'boolean', connectingPresent: 'boolean' },
  admission: { stage: admissions, wire: ['absent'], origin: ['unjoined'] },
  retirement: { stage: retirements, before: ['undefined', 'null', 'value'], after: ['undefined', 'null', 'value'] },
  cleanup: { nativeRetired: 'boolean', finalizedCleanupProven: 'boolean', recordingsRetired: 'boolean', released: 'boolean', connectingCleanupFailurePresent: 'boolean', retiringAttemptCleared: 'boolean', reason: ['receipt-failed', 'local-wait-departure', 'unresolved-custody', 'complete', 'unknown'], dirty: ['unknown'] },
  overflow: { limit: [8] },
  query: { client: 'integer', generation: 'integer', operationSeq: 'integer', command: ['fixture.query', 'fixture.read-fields', 'browser.query'], transmittedTimeoutMs: 'timeout', selectedLocalCancel: ['none', 'abort', 'deadline'], rawCode: [...codes], rawEffects: ['not-dispatched', 'completed', 'unknown'], rawScopeState: ['usable', 'quarantined', 'closed', 'unknown'], returnedCode: [...codes], timeoutRewritten: 'boolean', cancelAckSeen: 'boolean' },
};
const storage = new AsyncLocalStorage<SecretsContext>();
const contexts = new WeakSet<SecretsContext>();
const clients = new WeakMap<object, { ordinal: number; failures: number }>();
let workerToken: string | undefined;
let nextSurface = 0;
let nextAttempt = 0;
let nextClient = 0;
let writing = false;
let emittedRows = 0;
type LossReason = 'surface-cap' | 'attempt-cap' | 'client-cap' | 'row-cap' | 'owner-unjoined';
let lost: { readonly reason: LossReason; readonly nonce: string } | undefined;
let lossWritten = false;

/** Read only inert own data; diagnostics never invoke an input's getter. */
function data(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
function enabledNonce(): string | undefined {
  if (process.env['E2E_ENGINE_SECRETS_CAPTURE'] !== '1' || process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] !== '1') return undefined;
  const nonce = process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE'];
  return nonce !== undefined && hex.test(nonce) ? nonce : undefined;
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
/** Reserve the last producer slot for sticky, owner-free loss evidence. */
function flushLoss(): void {
  try {
    if (lost === undefined || lossWritten || writing || workerToken === undefined || enabledNonce() !== lost.nonce) return;
    lossWritten = true; writing = true; emittedRows++;
    try {
      process.stderr.write(`${PREFIX}${JSON.stringify({ v: 1, captureNonce: lost.nonce, workerToken, kind: 'capture-loss', reason: lost.reason })}\n`);
    } finally { writing = false; }
  } catch { /* A failed sink cannot affect the original product path. */ }
}
function markLoss(reason: LossReason, nonce: string): void {
  try {
    if (enabledNonce() !== nonce || !['surface-cap', 'attempt-cap', 'client-cap', 'row-cap', 'owner-unjoined'].includes(reason)) return;
    lost ??= { reason, nonce };
    flushLoss();
  } catch { /* No retry, new authority or business failure is introduced. */ }
}
function emit(context: SecretsContext | undefined, event: SecretsEvent): void {
  try {
    if (lost !== undefined || context === undefined || !contexts.has(context) || enabledNonce() !== context.captureNonce) return;
    const kind = data(event, 'kind');
    if (typeof kind !== 'string' || !Object.hasOwn(schema, kind)) return;
    const rules = schema[kind as SecretsEvent['kind']];
    const descriptors = Object.getOwnPropertyDescriptors(event);
    if (Object.keys(descriptors).length !== Object.keys(rules).length + 1) return;
    const row: Record<string, string | number | boolean> = { v: 1, captureNonce: context.captureNonce, workerToken: context.workerToken, surface: context.surface, attempt: context.attempt, kind };
    for (const [key, rule] of Object.entries(rules)) {
      const value = data(event, key);
      const valid = rule === 'boolean' ? typeof value === 'boolean' : rule === 'integer' ? positive(value) : rule === 'timeout' ? positive(value) && value <= 3_600_000 : rule.includes(value as string | number);
      if (!valid) return;
      row[key] = value as string | number | boolean;
    }
    const line = `${PREFIX}${JSON.stringify(row)}\n`;
    if (line.length <= 2048 && !writing) {
      if (emittedRows >= 63) { markLoss('row-cap', context.captureNonce); return; }
      emittedRows++; writing = true;
      try { process.stderr.write(line); } finally { writing = false; flushLoss(); }
    }
  } catch { /* Capture cannot replace a result or cleanup receipt. */ }
}

/** One bounded diagnostic surface; not exported by the public engine entry point. */
class SecretsSurface {
  private attempt = 0;
  constructor(private readonly surface: number, private readonly nonce: string, private readonly token: string) {}
  /** Synchronous entry evidence binds to the worker's write-time runner pair. */
  start(): SecretsContext | undefined {
    try {
      if (enabledNonce() !== this.nonce || lost !== undefined) return undefined;
      if (nextAttempt >= 16) { markLoss('attempt-cap', this.nonce); return undefined; }
      nextAttempt++;
      const context = Object.freeze({ captureNonce: this.nonce, workerToken: this.token, surface: this.surface, attempt: ++this.attempt });
      contexts.add(context); emit(context, { kind: 'start' }); return context;
    } catch { return undefined; }
  }
  /** A captured context keeps late receipt evidence with its original attempt. */
  emit(context: SecretsContext | undefined, event: SecretsEvent): void { emit(context, event); }
  /** A genuine state transition without an owner is incomplete, never assigned to a nearby case. */
  loss(reason: 'owner-unjoined'): void { markLoss(reason, this.nonce); }
}
/** No randomness, identities or output is produced outside the exact fixture opt-in. */
export function createSecretsSurface(): SecretsSurface | undefined {
  try {
    const nonce = enabledNonce();
    if (nonce === undefined || lost !== undefined) return undefined;
    if (nextSurface >= 16) { markLoss('surface-cap', nonce); return undefined; }
    workerToken ??= randomBytes(32).toString('hex');
    return new SecretsSurface(++nextSurface, nonce, workerToken);
  } catch { return undefined; }
}
/** Preserve the operation's exact return/throw; only its private diagnostic context changes. */
export function withSecretsContext<T>(context: SecretsContext | undefined, run: () => T): T {
  return context === undefined || !contexts.has(context) ? run() : storage.run(context, run);
}
/** Capture once at exchange entry, before any asynchronous settlement callback. */
export function captureSecretsContext(): SecretsContext | undefined { return storage.getStore(); }

/** Project existing settlement facts, never query arguments, error text or a live budget. */
export function observeSecretsQuery(client: object, context: SecretsContext | undefined, command: 'fixture.query' | 'fixture.read-fields' | 'browser.query', raw: unknown, returned: unknown, wire: { readonly generation: unknown; readonly operationSeq: unknown; readonly transmittedTimeoutMs: unknown; readonly cancellation: 'CANCELLED' | 'OPERATION_TIMEOUT' | undefined; readonly timeoutRewritten: boolean; readonly cancelAckSeen: boolean }): void {
  try {
    if (lost !== undefined || context === undefined || !contexts.has(context) || enabledNonce() !== context.captureNonce) return;
    const generation = data(wire, 'generation'); const operationSeq = data(wire, 'operationSeq'); const transmittedTimeoutMs = data(wire, 'transmittedTimeoutMs');
    if (!positive(generation) || !positive(operationSeq) || !positive(transmittedTimeoutMs) || transmittedTimeoutMs > 3_600_000) return;
    let record = clients.get(client);
    if (record === undefined) {
      if (nextClient >= 16) { markLoss('client-cap', context.captureNonce); return; }
      record = { ordinal: ++nextClient, failures: 0 }; clients.set(client, record);
    }
    if (record.failures >= 9) return;
    if (++record.failures === 9) { emit(context, { kind: 'overflow', limit: 8 }); return; }
    const code = (value: unknown): string => { const candidate = data(data(value, 'error'), 'code'); return typeof candidate === 'string' && codes.has(candidate) ? candidate : 'unknown'; };
    const effects = data(raw, 'effects'); const scope = data(raw, 'scopeState');
    const cancellation = data(wire, 'cancellation');
    const timeoutRewritten = data(wire, 'timeoutRewritten'); const cancelAckSeen = data(wire, 'cancelAckSeen');
    if ((cancellation !== undefined && cancellation !== 'CANCELLED' && cancellation !== 'OPERATION_TIMEOUT') || typeof timeoutRewritten !== 'boolean' || typeof cancelAckSeen !== 'boolean') return;
    emit(context, { kind: 'query', client: record.ordinal, generation, operationSeq, command, transmittedTimeoutMs,
      selectedLocalCancel: cancellation === 'CANCELLED' ? 'abort' : cancellation === 'OPERATION_TIMEOUT' ? 'deadline' : 'none',
      rawCode: code(raw), returnedCode: code(returned), rawEffects: effects === 'not-dispatched' || effects === 'completed' ? effects : 'unknown',
      rawScopeState: scope === 'usable' || scope === 'quarantined' || scope === 'closed' ? scope : 'unknown',
      timeoutRewritten, cancelAckSeen,
    });
  } catch { /* Never influence settlement or the original caller's result. */ }
}
