/** Optional closed cleanup evidence. Never a functional acceptance gate or PID attestation. */
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
  if (!lifecycle && phase !== 'CaptureStarted' && phase !== 'CaptureLimitReached') return false;
  const required = [...common, ...(lifecycle ? identity : []), ...(phase === 'CleanupFirstFailure' ? ['cleanupComponent'] : []), ...(phase === 'CleanupResult' ? ['cleanupResult'] : [])];
  const allowed = new Set([...required, ...(phase === 'CleanupResult' ? ['error'] : [])]);
  if (!required.every(key => Object.hasOwn(item, key)) || Object.keys(item).some(key => !allowed.has(key))) return false;
  for (const key of ['record', 'operationSeq', 'droppedBefore', 'emittedBefore', 'suppressedBefore', ...(lifecycle ? ['generation', 'cleanupOwner', 'cleanupAttempt'] : [])]) if (!natural(item[key])) return false;
  if (lifecycle && (item.cleanupOwner === 0 || item.cleanupAttempt === 0)) return false;
  if (!lifecycle && item.operationSeq !== 0) return false;
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
    const key = `${pid}:${value.cleanupOwner}:${value.cleanupAttempt}`;
    const exact = JSON.stringify([value.generation, value.operationSeq, value.cleanupLifecycle]);
    const previous = attempts.get(key);
    if (value.phase === 'CleanupStarted') {
      if (previous) reasons.add('duplicate-attempt');
    } else if (!previous || previous.identity !== exact || previous.phase === 'CleanupResult' || (value.phase === 'CleanupFirstFailure' && previous.phase !== 'CleanupStarted')) reasons.add('invalid-lifecycle');
    attempts.set(key, { phase: value.phase as string, identity: exact });
  }
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
