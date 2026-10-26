/** Optional closed cleanup, trace-screenshot and read-only preparation evidence. Never an acceptance gate or PID attestation. */
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SYNTHETIC_CODES } from '../../packages/web/tests/helpers/synthetic-evidence.ts';
export const CLEANUP_ENV = 'AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE';
export const CLEANUP_BYTES = 256 * 1024;
export const CLEANUP_RECORDS = 2048;
const common = ['schemaVersion', 'source', 'pid', 'record', 'operationSeq', 'phase', 'droppedBefore', 'emittedBefore', 'suppressedBefore', 'overflow'];
const identity = ['generation', 'cleanupOwner', 'cleanupAttempt', 'cleanupLifecycle'];
const inventoryFields = ['generation', 'inventoryPoint', 'inventorySealed', 'inventoryIntegrityLost', 'inventoryReservations', 'inventoryUnconfigured', 'inventoryObserved'];
const screenshotFields = ['generation', 'screenshotStage', 'capturePhase', 'inventoryAfterFailure', 'error'];
const frameFields = ['generation', 'pass', 'sealed', 'revisionMismatch', 'reservations', 'exact', 'lastEvent', 'lastTarget'];
const revisionEvents = ['attach', 'detach', 'info', 'navigate', 'same-document', 'frame-detach', 'unknown'];
const workerFields = ['generation', 'workerOrdinal', 'admissionStep', 'admissionState', 'waitingForDebugger'];
const workerSteps = new Set(['owned-attachment', 'auxiliary-classification', 'register', 'purpose', 'config-gate', 'network-enable', 'network-bypass', 'fetch-enable', 'runtime-enable', 'recursive-autoattach', 'configured', 'resume-permit', 'resume-debugger', 'configuration-committed']);
const terminalStages = new Set(['task-proof', 'owner-preconditions', 'runtime-release', 'persistent-probe', 'enrollment-proof', 'ledger-commands-present', 'physical-close', 'ordinary-close', 'shutdown-joins', 'final-commit']);
const readonlyFields = ['generation', 'entryUs', 'ack', 'window', 'deadline', 'zeroInput', 'cleanup', 'error'];
// Native restart diagnostics use process-local bounded ordinals, never native IDs.
const targetFields: Record<string, readonly string[]> = {
  TargetAttribution: ['generation', 'attachmentOrdinal', 'targetOrdinal', 'targetKind', 'targetOrigin', 'parentAttachmentOrdinal', 'rootAttachmentOrdinal'],
  TargetLifecycle: ['generation', 'attachmentOrdinal', 'targetStage', 'targetPurpose', 'targetClassification', 'targetConfigured', 'targetResumed'],
  TargetInventory: ['generation', 'inventoryPoint', 'inventoryOrdinal', 'attachmentOrdinal', 'targetPurpose', 'targetClassification', 'targetConfigured', 'targetResumed'],
  TargetInventorySummary: ['generation', 'inventoryPoint', 'inventoryOrdinal', 'targetCount', 'targetSampled', 'targetObserved'],
  TargetObservationLost: ['generation'],
};
const inventoryPoints = new Set(['restart-begin', 'restart-ready', 'settlement-refused']);
const targetEnums: Record<string, readonly string[]> = {
  targetKind: ['other', 'page', 'iframe', 'worker', 'shared-worker', 'service-worker', 'browser', 'browser-ui', 'tab', 'webview', 'background-page'],
  targetOrigin: ['unclassified', 'initial-discovery', 'auto-attach'],
  targetPurpose: ['unclassified', 'application', 'state-bootstrap'],
  targetClassification: ['pending-reservation', 'unreserved-application', 'reserved-application', 'reserved-bootstrap', 'reservation-remainder'],
  targetStage: ['registered', 'configure-started', 'configure-ack', 'configure-failed', 'resumed', 'detached', 'restart-retiring', 'purpose-assigned'],
};
const screenshotStages = new Set(['prepare-scope', 'prepare-permit', 'prepare-policy', 'prepare-owner', 'prepare-fence', 'run-scope', 'debt-admission', 'ui-admission', 'publication-admission', 'producer-reservation', 'initial-frames', 'frame-inventory-fence', 'protected-barrier', 'animation-stabilization', 'protected-frames', 'geometry', 'trace-metadata', 'capture', 'restoration', 'final-geometry', 'final-barrier', 'final-frames', 'final-viewport', 'blob-publication', 'publication']);
const capturePhases = new Set(['not-entered', 'admission', 'independent-coverage', 'source-protection', 'raw-capture', 'post-capture-validation']);
const components = new Set(['callback', 'dialog', 'interception', 'script', 'detach', 'recording', 'upload', 'containment', 'release', 'input', 'download', 'blob', 'enrollment-fallback', 'retained-task-fallback', 'owner-fallback']);
const errors = new Set<string>([...SYNTHETIC_CODES, 'frame-not-found', 'frame-ambiguous']);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
type RecordValue = Record<string, unknown>;
export function validCleanupRecord(value: unknown): value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as RecordValue;
  if (item.schemaVersion !== 2 || item.source !== 'native' || !natural(item.pid) || item.pid === 0 || typeof item.overflow !== 'boolean') return false;
  const phase = item.phase;
  if (typeof phase !== 'string') return false;
  const lifecycle = ['CleanupStarted', 'CleanupFirstFailure', 'CleanupResult'].includes(phase);
  const inventory = phase === 'InventorySnapshot';
  const screenshot = phase === 'ScreenshotFirstFailure';
  const frame = phase === 'FrameInventoryRejection';
  const readonly = phase === 'ReadonlyPrepareFailure';
  const target = Object.hasOwn(targetFields, phase);
  const worker = phase === 'ServiceWorkerAdmission';
  const terminal = phase === 'TerminalCleanupCheckpoint';
  if (!lifecycle && !inventory && !screenshot && !frame && !readonly && !target && !worker && !terminal && phase !== 'CaptureStarted' && phase !== 'CaptureLimitReached') return false;
  const required = [...common, ...(terminal ? ['terminalCleanupStage', 'terminalCleanupOk'] : []), ...(lifecycle ? identity : []), ...(inventory ? inventoryFields : []), ...(screenshot ? screenshotFields : []), ...(frame ? frameFields : []), ...(readonly ? readonlyFields : []), ...(worker ? workerFields : []), ...(targetFields[phase] ?? []), ...(phase === 'CleanupFirstFailure' ? ['cleanupComponent'] : []), ...(phase === 'CleanupResult' ? ['cleanupResult'] : [])];
  const allowed = new Set([...required, ...(frame ? ['delta', 'events'] : []), ...(['CleanupResult', 'TargetLifecycle'].includes(phase) ? ['error'] : []), ...(readonly ? ['ackUs', 'wakeUs', 'failUs'] : []), ...(inventory ? ['inventoryOrdinal'] : []), ...(phase === 'TargetAttribution' ? ['inventoryPoint', 'inventoryOrdinal'] : [])]);
  if (!required.every(key => Object.hasOwn(item, key)) || Object.keys(item).some(key => !allowed.has(key))) return false;
  for (const key of ['record', 'operationSeq', 'droppedBefore', 'emittedBefore', 'suppressedBefore', ...(lifecycle ? ['generation', 'cleanupOwner', 'cleanupAttempt'] : inventory || screenshot || frame || readonly || target || worker ? ['generation'] : [])]) if (!natural(item[key])) return false;
  if (lifecycle && (item.cleanupOwner === 0 || item.cleanupAttempt === 0)) return false;
  if (!lifecycle && !inventory && !screenshot && !frame && !readonly && !target && !worker && item.operationSeq !== 0) return false;
  if (terminal && (item.operationSeq !== 0 || typeof item.terminalCleanupStage !== 'string' || !terminalStages.has(item.terminalCleanupStage) || typeof item.terminalCleanupOk !== 'boolean')) return false;
  if (worker) {
    if (item.operationSeq !== 0 || !natural(item.workerOrdinal) || item.workerOrdinal < 1 || item.workerOrdinal > 8) return false;
    if (typeof item.admissionStep !== 'string' || !workerSteps.has(item.admissionStep)) return false;
    if (typeof item.admissionState !== 'string' || !['enter', 'done', 'failed'].includes(item.admissionState)) return false;
    if (item.waitingForDebugger !== true && item.waitingForDebugger !== false && item.waitingForDebugger !== 'unknown') return false;
    if (item.admissionStep === 'owned-attachment' && item.admissionState !== 'done') return false;
  }
  if (inventory || target) {
    for (const key of ['inventoryOrdinal', 'attachmentOrdinal', 'targetOrdinal', 'parentAttachmentOrdinal', 'rootAttachmentOrdinal']) if (Object.hasOwn(item, key) && (!natural(item[key]) || item[key] > 65535)) return false;
    if (Object.hasOwn(item, 'inventoryPoint') && (typeof item.inventoryPoint !== 'string' || !inventoryPoints.has(item.inventoryPoint))) return false;
  }
  if (target) {
    for (const [key, values] of Object.entries(targetEnums)) if (Object.hasOwn(item, key) && (typeof item[key] !== 'string' || !values.includes(item[key]))) return false;
    for (const key of ['targetConfigured', 'targetResumed', 'targetObserved']) if (Object.hasOwn(item, key) && typeof item[key] !== 'boolean') return false;
    if (phase === 'TargetAttribution' && Object.hasOwn(item, 'inventoryPoint') !== Object.hasOwn(item, 'inventoryOrdinal')) return false;
    if (phase === 'TargetLifecycle' && Object.hasOwn(item, 'error') && (typeof item.error !== 'string' || !errors.has(item.error))) return false;
    if (phase === 'TargetInventorySummary') {
      if (!natural(item.targetCount) || item.targetCount > 8192 || !natural(item.targetSampled) || item.targetSampled > 16 || item.targetSampled > item.targetCount) return false;
      if (item.targetObserved && item.targetCount !== item.targetSampled) return false;
    }
  }
  if (frame) {
    if (item.operationSeq === 0 || typeof item.pass !== 'string' || !['initial', 'protected', 'final'].includes(item.pass)) return false;
    for (const key of ['sealed', 'revisionMismatch', 'reservations', 'exact']) if (typeof item[key] !== 'boolean') return false;
    if (!item.sealed && !item.revisionMismatch && !item.reservations) return false;
    if (typeof item.lastEvent !== 'string' || ![...revisionEvents, 'none'].includes(item.lastEvent)) return false;
    if (typeof item.lastTarget !== 'string' || !['same', 'other', 'unknown'].includes(item.lastTarget)) return false;
    if (['none', 'unknown'].includes(item.lastEvent) && item.lastTarget !== 'unknown') return false;
    if (Object.hasOwn(item, 'delta') && (!natural(item.delta) || item.delta > 65535 || item.revisionMismatch !== (item.delta > 0))) return false;
    const counts = item.events;
    if (Object.hasOwn(item, 'events') && (!Array.isArray(counts) || counts.length !== 7 || !counts.every(count => natural(count) && count <= 65535))) return false;
    if (item.exact) {
      if (!natural(item.delta) || !Array.isArray(counts) || counts[6] !== 0 || counts.reduce((sum: number, count: number) => sum + count, 0) !== item.delta) return false;
      if (item.delta === 0 ? item.lastEvent !== 'none' : item.lastEvent === 'none' || item.lastEvent === 'unknown' || !(counts[revisionEvents.indexOf(item.lastEvent)] > 0)) return false;
    }
  }
  if (readonly) {
    if (item.operationSeq === 0 || typeof item.ack !== 'string' || !['none', 'current', 'retired'].includes(item.ack)) return false;
    if (typeof item.window !== 'string' || !['entered', 'not-entered'].includes(item.window)) return false;
    if (typeof item.deadline !== 'boolean' || item.zeroInput !== true) return false;
    if (typeof item.cleanup !== 'string' || !['failure-observed', 'not-observed'].includes(item.cleanup)) return false;
    if (typeof item.error !== 'string' || !errors.has(item.error)) return false;
    if ((item.ack === 'none') === Object.hasOwn(item, 'ackUs')) return false;
    for (const key of ['entryUs', 'ackUs', 'wakeUs', 'failUs']) if (Object.hasOwn(item, key) && (!natural(item[key]) || item[key] > 60_000_000)) return false;
  }
  if (screenshot) {
    if (item.operationSeq === 0 || typeof item.screenshotStage !== 'string' || !screenshotStages.has(item.screenshotStage)) return false;
    if (typeof item.capturePhase !== 'string' || !capturePhases.has(item.capturePhase)) return false;
    if (item.screenshotStage !== 'capture' && item.capturePhase !== 'not-entered') return false;
    if (typeof item.inventoryAfterFailure !== 'string' || !['not-sampled', 'unavailable', 'unchanged', 'changed'].includes(item.inventoryAfterFailure)) return false;
    if (typeof item.error !== 'string' || !errors.has(item.error)) return false;
  }
  if (inventory) {
    if (typeof item.inventoryPoint !== 'string' || !inventoryPoints.has(item.inventoryPoint)) return false;
    for (const key of ['inventorySealed', 'inventoryIntegrityLost', 'inventoryObserved']) if (typeof item[key] !== 'boolean') return false;
    for (const key of ['inventoryReservations', 'inventoryUnconfigured']) if (!natural(item[key]) || item[key] > 8192) return false;
  }
  if (lifecycle && (typeof item.cleanupLifecycle !== 'string' || !['scope-end', 'restart'].includes(item.cleanupLifecycle))) return false;
  if (phase === 'CleanupFirstFailure' && (typeof item.cleanupComponent !== 'string' || !components.has(item.cleanupComponent))) return false;
  if (phase === 'CleanupResult') {
    if (typeof item.cleanupResult !== 'string' || !['passed', 'failed'].includes(item.cleanupResult)) return false;
    if (item.cleanupResult === 'passed' && Object.hasOwn(item, 'error')) return false;
    if (item.cleanupResult === 'failed' && (typeof item.error !== 'string' || !errors.has(item.error))) return false;
  }
  return true;
}
export interface CleanupBinding { sourceRevision: string; nativeSourceRevision: string; testSourceDigest: string; binarySha256: string; collectorSha256: string }
export interface CleanupCapture { directory: string; file: string; device: number; inode: number; binding: CleanupBinding; env: NodeJS.ProcessEnv }
export function cleanCleanupEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv { const env = { ...inherited }; delete env[CLEANUP_ENV]; return env; }
export function prepareCleanupCapture(binding: CleanupBinding, inherited: NodeJS.ProcessEnv): CleanupCapture {
  if (Object.keys(binding).toSorted().join(',') !== 'binarySha256,collectorSha256,nativeSourceRevision,sourceRevision,testSourceDigest' || !Object.entries(binding).every(([key, value]) => (key.endsWith('Revision') ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(value))) throw new Error('Invalid cleanup source binding');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-cleanup-')));
  const file = join(directory, 'native.jsonl');
  try {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    const stat = lstatSync(file);
    return { directory, file, device: stat.dev, inode: stat.ino, binding, env: { ...cleanCleanupEnvironment(inherited), [CLEANUP_ENV]: file } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
export function inspectCleanupBytes(bytes: Buffer) {
  const reasons = new Set<string>(); const records: RecordValue[] = [];
  if (bytes.length > CLEANUP_BYTES) return { status: 'unknown' as const, reasons: ['byte-limit'], records };
  if (!bytes.length) reasons.add('empty');
  if (bytes.length && bytes.at(-1) !== 10) reasons.add('partial-line');
  const lines = bytes.toString('utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.length > CLEANUP_RECORDS) return { status: 'unknown' as const, reasons: ['record-limit'], records };
  const pids = new Map<number, number>(); const attempts = new Map<string, { phase: string; identity: string }>();
  const workers = new Map<string, { identity: string; count: number; pending?: string; terminal: boolean }>();
  // At most CLEANUP_RECORDS groups, each with at most 16 sampled attachments.
  // This checks only one declared inventory, not target lifetime or ancestry.
  const targetInventories = new Map<string, { identity: string; snapshot: boolean; sampled?: number; attribution: Set<number>; inventory: Set<number> }>();
  for (const line of lines) {
    let item: unknown;
    try { item = JSON.parse(line); } catch { reasons.add('invalid-record'); continue; }
    if (Buffer.byteLength(line) + 1 > 512 || !validCleanupRecord(item)) { reasons.add('invalid-record'); continue; }
    const value = item; records.push(value);
    const pid = value.pid as number; const ordinal = value.record as number;
    if (ordinal !== (pids.get(pid) ?? -1) + 1) reasons.add('record-gap');
    if (!pids.has(pid) && value.phase !== 'CaptureStarted') reasons.add('missing-capture-start');
    if (value.emittedBefore !== ordinal) reasons.add('emission-gap');
    pids.set(pid, ordinal);
    if (value.droppedBefore !== 0 || value.suppressedBefore !== 0 || value.overflow !== false) reasons.add('dropped-or-overflow');
    if (value.phase === 'CaptureLimitReached') reasons.add('capture-limit');
    if (value.phase === 'CaptureStarted') { if (ordinal !== 0) reasons.add('reused-pid'); continue; }
    if (value.phase === 'CaptureLimitReached') continue;
    if (value.phase === 'TerminalCleanupCheckpoint') continue; // Independent stage fact, never cleanup success or complete lifecycle evidence.
    if (value.phase === 'ServiceWorkerAdmission') {
      const key = `${pid}:${value.workerOrdinal}`;
      const exact = JSON.stringify([value.generation, value.waitingForDebugger]);
      let worker = workers.get(key);
      if (!worker) {
        worker = { identity: exact, count: 0, terminal: false }; workers.set(key, worker);
        if (value.admissionStep !== 'owned-attachment' || value.admissionState !== 'done') reasons.add('worker-admission-unobserved');
      } else if (value.admissionStep === 'owned-attachment') reasons.add('invalid-worker-admission');
      if (worker.identity !== exact || ++worker.count > 32 || worker.terminal) reasons.add('invalid-worker-admission');
      if (value.admissionStep !== 'owned-attachment') {
        if (value.admissionState === 'enter') {
          if (worker.pending !== undefined) reasons.add('invalid-worker-admission');
          worker.pending = value.admissionStep as string;
        } else {
          if (worker.pending !== value.admissionStep) reasons.add('worker-admission-unobserved');
          delete worker.pending;
          worker.terminal = value.admissionState === 'failed' || value.admissionStep === 'configuration-committed';
        }
      }
      continue; // A stage observation never creates or repairs cleanup/case association.
    }
    if (value.phase === 'FrameInventoryRejection') {
      if (!value.exact) reasons.add('frame-inventory-inexact');
      continue; // Atomic rejection evidence, never cleanup coverage or case association.
    }
    if (value.phase === 'ScreenshotFirstFailure' || value.phase === 'ReadonlyPrepareFailure') continue; // Not a cleanup lifecycle or atomic inventory snapshot.
    if (value.phase === 'InventorySnapshot' || Object.hasOwn(targetFields, value.phase as string)) {
      if (value.phase === 'TargetObservationLost') reasons.add('target-observation-lost');
      if (value.targetObserved === false) reasons.add('target-inventory-unobserved');
      // Parent/root zero is only unknown ancestry; it does not invalidate a sample.
      if (['inventoryOrdinal', 'attachmentOrdinal', 'targetOrdinal'].some(key => value[key] === 0)) reasons.add('target-ordinal-unobserved');
      if (typeof value.inventoryOrdinal === 'number' && value.inventoryOrdinal > 0) {
        const key = `${pid}:${value.inventoryOrdinal}`;
        const exact = JSON.stringify([value.generation, value.operationSeq, value.inventoryPoint]);
        let group = targetInventories.get(key);
        if (!group) { group = { identity: exact, snapshot: false, attribution: new Set(), inventory: new Set() }; targetInventories.set(key, group); }
        if (group.identity !== exact) reasons.add('invalid-target-inventory');
        if (value.phase === 'InventorySnapshot') {
          if (group.snapshot) reasons.add('invalid-target-inventory');
          group.snapshot = true;
        } else if (value.phase === 'TargetInventorySummary') {
          if (group.sampled !== undefined) reasons.add('invalid-target-inventory');
          group.sampled = value.targetSampled as number;
        } else {
          const samples = value.phase === 'TargetAttribution' ? group.attribution : group.inventory;
          const attachment = value.attachmentOrdinal as number;
          if (samples.has(attachment) || samples.size >= 16) reasons.add('invalid-target-inventory');
          else samples.add(attachment);
        }
      }
      if (value.phase !== 'InventorySnapshot') continue; // Cannot start/finish/repair cleanup.
    }
    if (value.phase === 'InventorySnapshot') {
      // Lock-unavailable placeholders and saturated counts both explicitly lack a complete observation.
      if (value.inventoryObserved === false) reasons.add('inventory-unobserved');
      continue; // Independent read-only facts cannot start, finish or repair a cleanup attempt.
    }
    const key = `${pid}:${value.cleanupOwner}:${value.cleanupAttempt}`;
    const exact = JSON.stringify([value.generation, value.operationSeq, value.cleanupLifecycle]);
    const previous = attempts.get(key);
    if (value.phase === 'CleanupStarted') {
      if (previous) reasons.add('duplicate-attempt');
    } else if (!previous || previous.identity !== exact || previous.phase === 'CleanupResult' || (value.phase === 'CleanupFirstFailure' && previous.phase !== 'CleanupStarted')) reasons.add('invalid-lifecycle');
    attempts.set(key, { phase: value.phase as string, identity: exact });
  }
  for (const value of records.filter(record => record.phase === 'FrameInventoryRejection')) {
    const matches = records.filter(record => record.pid === value.pid && record.generation === value.generation && record.operationSeq === value.operationSeq);
    const first = matches.filter(record => record.phase === 'ScreenshotFirstFailure');
    if (matches.filter(record => record.phase === 'FrameInventoryRejection').length !== 1 || first.length !== 1 || first[0]?.screenshotStage !== 'frame-inventory-fence' || first[0]?.error !== 'stale-scope') reasons.add('unpaired-frame-inventory');
  }
  for (const group of targetInventories.values()) {
    if (!group.snapshot || group.sampled === undefined || group.attribution.size !== group.sampled || group.inventory.size !== group.sampled || [...group.attribution].some(attachment => !group.inventory.has(attachment))) reasons.add('incomplete-target-inventory');
  }
  if ([...workers.values()].some(worker => worker.pending !== undefined || !worker.terminal)) reasons.add('worker-admission-incomplete');
  if (!attempts.size) reasons.add('no-cleanup-attempt');
  if ([...attempts.values()].some(value => value.phase !== 'CleanupResult')) reasons.add('missing-terminal');
  return { status: reasons.size ? 'unknown' as const : 'complete-observed-snapshots' as const, reasons: [...reasons], records };
}
/** Even valid snapshots do not attest unobserved processes, case association, or overall cleanup. */
export function collectCleanupCapture(output: string, suite: string, capture: CleanupCapture | undefined, identityUnchanged: boolean) {
  if (!['web-browser', 'public-callbacks'].includes(suite)) return { status: 'unknown', reasons: ['unsupported-suite'], diagnosticOnly: true, releaseEligible: false };
  if (!capture) return { status: 'unknown', reasons: ['capture-unavailable'], diagnosticOnly: true, releaseEligible: false };
  try {
    const fd = openSync(capture.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== capture.device || stat.ino !== capture.inode || stat.size > CLEANUP_BYTES) throw new Error('Unsafe cleanup evidence');
      const buffer = Buffer.alloc(CLEANUP_BYTES + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, length);
      const after = fstatSync(fd);
      if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Changing cleanup evidence');
    } finally { closeSync(fd); }
    const inspected = inspectCleanupBytes(bytes);
    if (!identityUnchanged) { inspected.status = 'unknown'; inspected.reasons.push('source-runtime-changed'); }
    const result = { schemaVersion: 1, diagnosticOnly: true, releaseEligible: false, caseAssociation: 'unproven', processCoverage: 'unproven', binding: capture.binding, ...inspected };
    const saved = Buffer.from(JSON.stringify(result)); const file = `${suite}.cleanup-diagnostics.json`;
    writeFileSync(join(output, file), saved, { flag: 'wx', mode: 0o600 });
    return { status: result.status, reasons: result.reasons, file, sha256: hash(saved), bytes: saved.length, binding: capture.binding, diagnosticOnly: true, releaseEligible: false };
  } catch { return { status: 'unknown', reasons: ['collection-unavailable'], diagnosticOnly: true, releaseEligible: false }; }
  finally { try { rmSync(capture.directory, { recursive: true, force: true }); } catch { /* Cleanup diagnostics cannot replace the suite result. */ } }
}
