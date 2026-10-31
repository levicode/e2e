/** Fixture-only, closed diagnostics. These identities confer no execution authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

type DiagnosticSuite = 'engine-secrets' | 'unserved-model-two-workers';
const ownedContexts = new WeakSet<SecretsContext>();
export interface SecretsProcessContext { readonly suite: DiagnosticSuite; readonly nonce: string }
const processContexts = new WeakSet<SecretsProcessContext>();
const processIds = new WeakMap<object, { readonly pid: number; readonly suite: DiagnosticSuite; readonly nonce: string }>();
const hex = /^[a-f0-9]{64}$/;
const admissions = ['callback-check', 'require-attempt', 'owner-check', 'pending-latch', 'caller-aborted', 'download-readiness', 'ensure-connected', 'final-owner-check'] as const;
const retirements = ['download-file', 'retire-attempt', 'finalized-video', 'recording-stop', 'late-recording-stop', 'connection-cleanup', 'native-video-retire', 'interop-retire', 'playwright-close', 'scope-end', 'native-close', 'provider-release', 'publication', 'worker-release', 'worker-acquisition-cleanup', 'native-resource-cleanup', 'unknown'] as const;
const codes = new Set(['frame-not-found', 'frame-ambiguous', 'invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable', 'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing', 'content-length-mismatch', 'redirect-body-unavailable', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'invalid-locator', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced', 'fill-unsupported-target', 'no-editable-focus', 'tap-target-replaced-before-press', 'locator-not-found', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted', 'unknown']);
export type SecretsAdmissionStage = typeof admissions[number];
export type SecretsRetirementStage = typeof retirements[number];
type SecretsPresence = 'undefined' | 'null' | 'value';
export interface SecretsContext { readonly suite: DiagnosticSuite; readonly captureNonce: string; readonly workerToken: string; readonly surface: number; readonly attempt: number }
export type SecretsCloseStage = 'preconditions' | 'decision-receipts' | 'close-exchange' | 'channel-settle' | 'post-settle' | 'existing-client-failure' | 'reuse-existing-close';
type SecretsEvent =
  | { readonly kind: 'first-cause'; readonly stage: SecretsRetirementStage; readonly code: 'unknown'; readonly category: 'unknown' }
  | { readonly kind: 'process-binding'; readonly client: number; readonly proxyPid: number }
  | { readonly kind: 'close'; readonly client: number; readonly stage: SecretsCloseStage; readonly outcome: 'observed' | 'completed' | 'failed'; readonly closedFrameConfirmed: boolean; readonly code: 'unknown'; readonly origin: 'unjoined' }
  | { readonly kind: 'start' }
  | { readonly kind: 'guard'; readonly workerRetired: boolean; readonly workerCleanupUnconfirmed: boolean; readonly retirementFailurePresent: boolean; readonly attemptPresent: boolean; readonly retiringAttemptPresent: boolean; readonly connectingPresent: boolean }
  | { readonly kind: 'admission'; readonly stage: SecretsAdmissionStage; readonly wire: 'absent'; readonly origin: 'unjoined' }
  | { readonly kind: 'retirement'; readonly stage: SecretsRetirementStage; readonly before: SecretsPresence; readonly after: SecretsPresence }
  | { readonly kind: 'cleanup'; readonly nativeRetired: boolean; readonly finalizedCleanupProven: boolean; readonly recordingsRetired: boolean; readonly released: boolean; readonly connectingCleanupFailurePresent: boolean; readonly retiringAttemptCleared: boolean; readonly reason: 'receipt-failed' | 'local-wait-departure' | 'unresolved-custody' | 'complete' | 'unknown'; readonly dirty: 'unknown' }
  | { readonly kind: 'overflow'; readonly limit: 8 }
  | { readonly kind: 'query'; readonly client: number; readonly generation: number; readonly operationSeq: number; readonly command: 'fixture.query' | 'fixture.read-fields' | 'browser.query'; readonly transmittedTimeoutMs: number; readonly selectedLocalCancel: 'none' | 'abort' | 'deadline'; readonly rawCode: string; readonly rawEffects: 'not-dispatched' | 'completed' | 'unknown'; readonly rawScopeState: 'usable' | 'quarantined' | 'closed' | 'unknown'; readonly returnedCode: string; readonly timeoutRewritten: boolean; readonly cancelAckSeen: boolean };

interface SecretsSurfaceObserver {
  start(): SecretsContext | undefined;
  emit(context: SecretsContext | undefined, event: SecretsEvent): void;
  loss(reason: 'owner-unjoined'): void;
}
type Rule = 'boolean' | 'integer' | 'timeout' | readonly (string | number)[];
const schema: Record<SecretsEvent['kind'], Readonly<Record<string, Rule>>> = {
  'first-cause': { stage: retirements, code: ['unknown'], category: ['unknown'] },
  'process-binding': { client: 'integer', proxyPid: 'integer' },
  close: { client: 'integer', stage: ['preconditions', 'decision-receipts', 'close-exchange', 'channel-settle', 'post-settle', 'existing-client-failure', 'reuse-existing-close'], outcome: ['observed', 'completed', 'failed'], closedFrameConfirmed: 'boolean', code: ['unknown'], origin: ['unjoined'] },
  start: {},
  guard: { workerRetired: 'boolean', workerCleanupUnconfirmed: 'boolean', retirementFailurePresent: 'boolean', attemptPresent: 'boolean', retiringAttemptPresent: 'boolean', connectingPresent: 'boolean' },
  admission: { stage: admissions, wire: ['absent'], origin: ['unjoined'] },
  retirement: { stage: retirements, before: ['undefined', 'null', 'value'], after: ['undefined', 'null', 'value'] },
  cleanup: { nativeRetired: 'boolean', finalizedCleanupProven: 'boolean', recordingsRetired: 'boolean', released: 'boolean', connectingCleanupFailurePresent: 'boolean', retiringAttemptCleared: 'boolean', reason: ['receipt-failed', 'local-wait-departure', 'unresolved-custody', 'complete', 'unknown'], dirty: ['unknown'] },
  overflow: { limit: [8] },
  query: { client: 'integer', generation: 'integer', operationSeq: 'integer', command: ['fixture.query', 'fixture.read-fields', 'browser.query'], transmittedTimeoutMs: 'timeout', selectedLocalCancel: ['none', 'abort', 'deadline'], rawCode: [...codes], rawEffects: ['not-dispatched', 'completed', 'unknown'], rawScopeState: ['usable', 'quarantined', 'closed', 'unknown'], returnedCode: [...codes], timeoutRewritten: 'boolean', cancelAckSeen: 'boolean' },
};
function observer(suite: DiagnosticSuite) {
const PREFIX = suite === 'engine-secrets' ? 'ENGINE_SECRETS_DIAGNOSTIC ' : 'UNSERVED_MODEL_DIAGNOSTIC ';
const firstCauses = new WeakSet<SecretsContext>();
const storage = new AsyncLocalStorage<SecretsContext>();
const contexts = new WeakSet<SecretsContext>();
const clients = new WeakMap<object, { ordinal: number; failures: number; bound: boolean }>();
let workerToken: string | undefined;
let nextSurface = 0;
let nextAttempt = 0;
let nextClient = 0;
let writing = false;
let emittedRows = 0;
type LossReason = 'surface-cap' | 'attempt-cap' | 'client-cap' | 'row-cap' | 'owner-unjoined';
let lost: { readonly reason: LossReason; readonly nonce: string } | undefined;
let lossWritten = false;
let stopped = false;

/** Read only inert own data; diagnostics never invoke an input's getter. */
function data(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
function enabledNonce(): string | undefined {
  const selected = process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'] ?? 'engine-secrets';
  if (selected !== suite) return undefined;
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
    if (!['surface-cap', 'attempt-cap', 'client-cap', 'row-cap', 'owner-unjoined'].includes(reason)) return;
    if (reason !== 'owner-unjoined') stopped = true;
    lost ??= { reason, nonce };
    flushLoss();
  } catch { /* No retry, new authority or business failure is introduced. */ }
}
function emit(context: SecretsContext | undefined, event: SecretsEvent): boolean | undefined {
  try {
    if (stopped || context === undefined || !contexts.has(context)) return;
    if (enabledNonce() !== context.captureNonce) { markLoss('owner-unjoined', context.captureNonce); return; }
    flushLoss();
    const kind = data(event, 'kind');
    if (typeof kind !== 'string' || !Object.hasOwn(schema, kind)) return;
    if ((kind === 'first-cause' && suite !== 'unserved-model-two-workers') || ((kind === 'process-binding' || kind === 'close') && suite !== 'engine-secrets')) return;
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
      return true;
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
      const context = Object.freeze({ suite, captureNonce: this.nonce, workerToken: this.token, surface: this.surface, attempt: ++this.attempt });
      contexts.add(context); ownedContexts.add(context); emit(context, { kind: 'start' }); return context;
    } catch { return undefined; }
  }
  /** A captured context keeps late receipt evidence with its original attempt. */
  emit(context: SecretsContext | undefined, event: SecretsEvent): void {
    const accepted = emit(context, event);
    if (accepted === true && suite === 'unserved-model-two-workers' && context !== undefined && contexts.has(context)
      && data(event, 'kind') === 'retirement' && !firstCauses.has(context)) {
      const stage = data(event, 'stage');
      if (typeof stage === 'string' && retirements.includes(stage as SecretsRetirementStage)) {
        firstCauses.add(context);
        emit(context, { kind: 'first-cause', stage: stage as SecretsRetirementStage, code: 'unknown', category: 'unknown' });
      }
    }
  }
  /** A genuine state transition without an owner is incomplete, never assigned to a nearby case. */
  loss(reason: 'owner-unjoined'): void { markLoss(reason, this.nonce); }
}
/** No randomness, identities or output is produced outside the exact fixture opt-in. */
function createSurface(): SecretsSurface | undefined {
  try {
    const nonce = enabledNonce();
    if (nonce === undefined || lost !== undefined) return undefined;
    if (nextSurface >= 16) { markLoss('surface-cap', nonce); return undefined; }
    workerToken ??= randomBytes(32).toString('hex');
    return new SecretsSurface(++nextSurface, nonce, workerToken);
  } catch { return undefined; }
}
/** Preserve the operation's exact return/throw; only its private diagnostic context changes. */
function withContext<T>(context: SecretsContext | undefined, run: () => T): T {
  return context === undefined || !contexts.has(context) ? run() : storage.run(context, run);
}
/** Capture once at exchange entry, before any asynchronous settlement callback. */
function captureContext(): SecretsContext | undefined { return storage.getStore(); }

/** Project existing settlement facts, never query arguments, error text or a live budget. */
function observeQuery(client: object, context: SecretsContext | undefined, command: 'fixture.query' | 'fixture.read-fields' | 'browser.query', raw: unknown, returned: unknown, wire: { readonly generation: unknown; readonly operationSeq: unknown; readonly transmittedTimeoutMs: unknown; readonly cancellation: 'CANCELLED' | 'OPERATION_TIMEOUT' | undefined; readonly timeoutRewritten: boolean; readonly cancelAckSeen: boolean }): void {
  try {
    if (stopped || context === undefined || !contexts.has(context)) return;
    if (enabledNonce() !== context.captureNonce) { markLoss('owner-unjoined', context.captureNonce); return; }
    flushLoss();
    const generation = data(wire, 'generation'); const operationSeq = data(wire, 'operationSeq'); const transmittedTimeoutMs = data(wire, 'transmittedTimeoutMs');
    if (!positive(generation) || !positive(operationSeq) || !positive(transmittedTimeoutMs) || transmittedTimeoutMs > 3_600_000) return;
    const record = clientRecord(client, context);
    if (record === undefined) return;
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

function admitClient(client: object, nonce: string) {
  if (stopped) return undefined;
  let record = clients.get(client);
  if (record === undefined) {
    if (nextClient >= 16) { markLoss('client-cap', nonce); return undefined; }
    record = { ordinal: ++nextClient, failures: 0, bound: false }; clients.set(client, record);
  }
  return record;
}
function clientRecord(client: object, context: SecretsContext) {
  const record = admitClient(client, context.captureNonce); if (record === undefined) return undefined;
  const binding = processIds.get(client);
  const proxyPid = binding?.suite === suite && binding.nonce === context.captureNonce ? binding.pid : undefined;
  if (suite === 'engine-secrets' && !record.bound && proxyPid !== undefined) {
    record.bound = true;
    emit(context, { kind: 'process-binding', client: record.ordinal, proxyPid });
  }
  return record;
}
function close(client: object, context: SecretsContext | undefined, stage: SecretsCloseStage, outcome: 'observed' | 'completed' | 'failed', closedFrameConfirmed: boolean): void {
  try {
    if (suite !== 'engine-secrets' || stopped || context === undefined || !contexts.has(context)) return;
    if (enabledNonce() !== context.captureNonce) { markLoss('owner-unjoined', context.captureNonce); return; }
    const record = clientRecord(client, context);
    if (record === undefined) return;
    emit(context, { kind: 'close', client: record.ordinal, stage, outcome, closedFrameConfirmed, code: 'unknown', origin: 'unjoined' });
  } catch { /* No observation changes the original close result. */ }
}
return { createSecretsSurface: createSurface, withSecretsContext: withContext, captureSecretsContext: captureContext, observeSecretsQuery: observeQuery, close, admitProcess: (client: object, nonce: string) => admitClient(client, nonce) !== undefined, process: (client: object, context: SecretsContext) => { if (contexts.has(context) && enabledNonce() === context.captureNonce) clientRecord(client, context); }, unjoined: (nonce: string) => markLoss('owner-unjoined', nonce) };
}
const observers = { 'engine-secrets': observer('engine-secrets'), 'unserved-model-two-workers': observer('unserved-model-two-workers') };
function owner(context: SecretsContext | undefined) {
  return context !== undefined && ownedContexts.has(context) ? observers[context.suite] : undefined;
}
export function createSecretsSurface(): SecretsSurfaceObserver | undefined {
  const suite = process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'] ?? 'engine-secrets';
  return suite === 'engine-secrets' || suite === 'unserved-model-two-workers' ? observers[suite].createSecretsSurface() : undefined;
}
export function withSecretsContext<T>(context: SecretsContext | undefined, run: () => T): T {
  const observed = owner(context); return observed === undefined ? run() : observed.withSecretsContext(context, run);
}
export function captureSecretsContext(): SecretsContext | undefined {
  const first = observers['engine-secrets'].captureSecretsContext();
  const second = observers['unserved-model-two-workers'].captureSecretsContext();
  if (first !== undefined && second !== undefined) { observers[first.suite].unjoined(first.captureNonce); observers[second.suite].unjoined(second.captureNonce); return undefined; }
  return first ?? second;
}
export function observeSecretsQuery(client: object, context: SecretsContext | undefined, command: 'fixture.query' | 'fixture.read-fields' | 'browser.query', raw: unknown, returned: unknown, wire: { readonly generation: unknown; readonly operationSeq: unknown; readonly transmittedTimeoutMs: unknown; readonly cancellation: 'CANCELLED' | 'OPERATION_TIMEOUT' | undefined; readonly timeoutRewritten: boolean; readonly cancelAckSeen: boolean }): void {
  owner(context)?.observeSecretsQuery(client, context, command, raw, returned, wire);
}
/** Private process adapter: caller is connectNativeProcess after the real spawn/connect. */
export function captureSecretsProcessContext(): SecretsProcessContext | undefined {
  try {
    const suite = process.env['E2E_NATIVE_DIAGNOSTIC_SUITE'] ?? 'engine-secrets';
    const nonce = process.env['E2E_ENGINE_SECRETS_CAPTURE_NONCE'];
    if (process.env['E2E_ENGINE_SECRETS_DIAGNOSTIC'] !== '1' || process.env['E2E_ENGINE_SECRETS_CAPTURE'] !== '1'
      || (suite !== 'engine-secrets' && suite !== 'unserved-model-two-workers') || nonce === undefined || !hex.test(nonce)) return undefined;
    const captured = Object.freeze({ suite, nonce }); processContexts.add(captured); return captured;
  } catch { return undefined; }
}
export function bindSecretsClientProcess(client: object, proxyPid: number | undefined, captured: SecretsProcessContext | undefined, context?: SecretsContext): void {
  try {
    if (captured === undefined || !processContexts.has(captured)) return;
    const { suite, nonce } = captured;
    if (typeof proxyPid !== 'number' || !Number.isSafeInteger(proxyPid) || proxyPid <= 0) return;
    if (!processIds.has(client)) {
      if (!observers[suite].admitProcess(client, nonce)) return;
      processIds.set(client, Object.freeze({ pid: proxyPid, suite, nonce }));
    }
    if (context !== undefined && ownedContexts.has(context) && context.suite === suite && context.captureNonce === nonce) owner(context)?.process(client, context);
  } catch { /* Diagnostic only. */ }
}
/** No thrown value is accepted or inspected by this observer. */
export function observeSecretsClose(client: object, context: SecretsContext | undefined, stage: SecretsCloseStage, outcome: 'observed' | 'completed' | 'failed', closedFrameConfirmed: boolean): void {
  const observed = owner(context);
  if (observed !== undefined) observed.close(client, context, stage, outcome, closedFrameConfirmed);
  else if (outcome === 'failed') {
    const binding = processIds.get(client);
    if (binding !== undefined) observers[binding.suite].unjoined(binding.nonce);
  }
}
