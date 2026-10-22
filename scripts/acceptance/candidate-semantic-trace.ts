/** Read-only receipt validation for the actual four-case cancellation trace, not peer diagnostics. */
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exactKeys, natural, traceObject, validTsTraceRecord, NATIVE_TRACE_FILE, SEMANTIC_TRACE_CASES, TRACE_BYTES, TRACE_COMMON_KEYS, TRACE_IO, TRACE_RECORD_BYTES, TS_TRACE_RECORDS, tsTraceFile, type TraceObject } from '../../packages/web/tests/helpers/acceptance-trace-files.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const settlement = ['ExecuteStarted', 'ExecuteReturned', 'CancelObserved', 'DeadlineObserved', 'GraceReturned', 'GraceExpired', 'CompletionJoined', 'ResultQueued', 'ResultFlushed', 'ControlFlushed', 'CancelReceived', 'CancelAccepted', 'CancelRejected', 'CancelQueued', 'ReaderEnded', 'ReaderRefused', 'WriterFailed', 'PublicationExpired', 'HealthFailed', 'CompletionLost', 'ResultQueueFailed', 'UnknownOutcome', 'CloseReceived', 'ControlQueueFailed', 'ShutdownStarted', 'ShutdownProven', 'ShutdownUnproven', 'PendingResultQueued'];
const settlementFacts = ['generation', 'effects', 'scopeState', 'error', 'accepted'];
const protocolErrors = new Set(['invalid-frame', 'unsupported-protocol', 'unsupported-capability', 'stale-generation', 'scope-unavailable', 'sequence-reused', 'invalid-sequence', 'invalid-timeout', 'capacity-exceeded', 'operation-missing', 'decision-missing', 'decision-expired', 'decision-kind-mismatch', 'registry-missing', 'registry-in-use', 'identifier-exhausted', 'unsupported-command', 'deadline-exceeded', 'cancelled', 'invalid-arguments', 'browser-failure', 'stale-scope', 'cleanup-failed', 'stale-reference', 'policy-denied', 'not-actionable', 'locator-not-found', 'content-length-mismatch', 'redirect-body-unavailable', 'intercepted-pointer', 'checked-state-unchanged', 'checked-control-replaced']);
const legFacts = ['leg', 'total', 'calls', 'outstanding'];
const frameFacts = ['consumedBytes', 'pendingBytes', 'calls', 'seedKnown'];
const nativeFields: Record<string, readonly string[]> = {
  CaptureStarted: [], CaptureLimitReached: [],
  FrameComplete: [...frameFacts, 'frameBytes'], FrameCleanEof: frameFacts, FramePartialEof: frameFacts,
  FrameIoError: [...frameFacts, 'io'], FrameOversize: [...frameFacts, 'frameBytes'], FrameParseRefused: [...frameFacts, 'frameBytes'],
  FrameDecoded: [...frameFacts, 'messageKind', 'generation'], FrameAdmissionRefused: [...frameFacts, 'messageKind', 'generation'],
  FrameSummary: frameFacts, DetailLimit: frameFacts,
};
const proxyFields: Record<string, readonly string[]> = {
  CaptureStarted: [], CaptureLimitReached: [], ProxyDaemonSpawned: ['daemonPid'], PrefaceReturned: ['io', 'length'],
  CopyStarted: legFacts, CopyReturned: [...legFacts, 'io', 'length'], ProxySummary: legFacts,
  SocketWriteEntered: [...legFacts, 'length'], SocketWriteReturned: [...legFacts, 'io', 'length'],
  SocketReadEntered: [...legFacts, 'length'], SocketReadReturned: [...legFacts, 'io', 'length'],
  InputHalfCloseEntered: [], InputHalfCloseReturned: ['io'], OutputFlushEntered: [], OutputFlushReturned: ['io'], DetailLimit: legFacts,
};
/** Legacy v1 is recognizable but can never satisfy v2 completeness or source correlation. */
export function nativeTraceVersion(value: unknown): 1 | 2 | undefined {
  if (!traceObject(value) || typeof value['phase'] !== 'string') return undefined;
  const phase = value['phase'];
  if (value['schemaVersion'] === 1) {
    if (![...settlement, 'CaptureLimitReached'].includes(phase) || !exactKeys(value, ['schemaVersion', 'pid', 'record', 'operationSeq', 'phase', 'droppedBefore'], ['schemaVersion', 'pid', 'record', 'operationSeq', 'phase', 'droppedBefore', ...settlementFacts])) return undefined;
  } else if (value['schemaVersion'] === 2 && (value['source'] === 'native' || value['source'] === 'proxy')) {
    const source = value['source'];
    const fields = source === 'native' ? nativeFields : proxyFields;
    const extra = source === 'native' && settlement.includes(phase) ? settlementFacts : Object.hasOwn(fields, phase) ? fields[phase] : undefined;
    if (extra === undefined || !exactKeys(value, [...TRACE_COMMON_KEYS, 'operationSeq'], [...TRACE_COMMON_KEYS, 'operationSeq', ...extra])) return undefined;
    // Expanded source-specific records require their scalar facts. Returned lengths and
    // decoded hello generation are absent by design on errors / hello respectively.
    if (!(source === 'native' && settlement.includes(phase))) {
      const optional = source === 'proxy' && ['CopyReturned', 'SocketWriteReturned', 'SocketReadReturned'].includes(phase) ? ['length'] : source === 'native' && ['FrameDecoded', 'FrameAdmissionRefused'].includes(phase) ? ['generation'] : [];
      if (!extra.filter(key => !optional.includes(key)).every(key => Object.hasOwn(value, key))) return undefined;
    }
  } else return undefined;
  for (const [key, fact] of Object.entries(value)) {
    if (['schemaVersion', 'source', 'phase'].includes(key)) continue;
    if (['overflow', 'accepted', 'outstanding', 'seedKnown'].includes(key)) { if (typeof fact !== 'boolean') return undefined; }
    else if (key === 'effects') { if (typeof fact !== 'string' || !['not-dispatched', 'completed', 'unknown'].includes(fact)) return undefined; }
    else if (key === 'scopeState') { if (typeof fact !== 'string' || !['usable', 'quarantined', 'closed'].includes(fact)) return undefined; }
    else if (key === 'error') { if (typeof fact !== 'string' || !protocolErrors.has(fact)) return undefined; }
    else if (key === 'io') { if (typeof fact !== 'string' || !TRACE_IO.includes(fact)) return undefined; }
    else if (key === 'leg') { if (typeof fact !== 'string' || !['to-native', 'from-native'].includes(fact)) return undefined; }
    else if (key === 'messageKind') { if (typeof fact !== 'string' || !['hello', 'request', 'cancel', 'decision', 'close'].includes(fact)) return undefined; }
    else if (!natural(fact)) return undefined;
  }
  return value['pid'] === 0 ? undefined : value['schemaVersion'] as 1 | 2;
}

type CaptureStatus = 'complete' | 'incomplete' | 'unavailable';
interface SourceReceipt { source: string; pid: number; records: number; lastRecord: number; dropped: number; suppressed: number; emitted: number; overflow: boolean; status: CaptureStatus }
interface FileReceipt { file: string; sha256?: string; bytes?: number; records: number; status: CaptureStatus; reasons: string[]; sources: SourceReceipt[] }
function readBounded(file: string, maximum: number): Buffer {
  if (!constants.O_NOFOLLOW) throw new Error('No no-follow file support');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('Unavailable evidence');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > maximum) throw new Error('Changing evidence');
    return bytes;
  } finally { closeSync(fd); }
}
function inspectFile(output: string, file: string, native: boolean): { receipt: FileReceipt; records: TraceObject[] } {
  const receipt: FileReceipt = { file, records: 0, status: 'unavailable', reasons: [], sources: [] };
  const records: TraceObject[] = [];
  let bytes: Buffer;
  try { bytes = readBounded(join(output, file), TRACE_BYTES); }
  catch { receipt.reasons.push('unavailable-file'); return { receipt, records }; }
  receipt.sha256 = hash(bytes); receipt.bytes = bytes.length;
  if (bytes.length === 0) { receipt.reasons.push('empty-file'); return { receipt, records }; }
  receipt.status = 'complete';
  if (bytes.at(-1) !== 10) receipt.reasons.push('partial-record');
  const lines = bytes.toString('utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
  receipt.records = lines.length;
  if (lines.length > (native ? 2048 : TS_TRACE_RECORDS)) receipt.reasons.push('record-cap');
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { receipt.reasons.push('invalid-record'); continue; }
    if (Buffer.byteLength(line) + 1 > TRACE_RECORD_BYTES || (native ? nativeTraceVersion(value) === undefined : !validTsTraceRecord(value))) { receipt.reasons.push('invalid-record'); continue; }
    const item = value as TraceObject;
    if (item['schemaVersion'] === 1) { receipt.reasons.push('legacy-schema'); continue; }
    records.push(item);
  }
  const groups = new Map<string, TraceObject[]>();
  for (const record of records) {
    const key = `${record['source']}:${record['pid']}`;
    const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!; const last = group.at(-1)!; const source = String(first['source']);
    let complete = first['phase'] === 'CaptureStarted' && first['record'] === 0 && group.filter(record => record['phase'] === 'CaptureStarted').length === 1;
    // Never sort append order into alleged cross-thread/process causality.
    complete &&= group.every((record, index) => record['record'] === index && record['emittedBefore'] === index && record['droppedBefore'] === 0 && record['suppressedBefore'] === 0 && record['overflow'] === false && !['CaptureLimitReached', 'DetailLimit'].includes(String(record['phase'])));
    if (source === 'ts') complete &&= first['seedKnown'] === true && first['initialSubmittedBytes'] === 0 && last['phase'] === 'CaptureFinished' && last['pendingWriteCallbacks'] === 0 && ['ProcessExit', 'ProcessClose'].every(phase => group.some(record => record['phase'] === phase));
    else if (source === 'native') complete &&= group.some(record => record['phase'] === 'FrameSummary' && record['seedKnown'] === true);
    else {
      complete &&= ['to-native', 'from-native'].every(leg => group.some(record => record['phase'] === 'CopyReturned' && record['leg'] === leg) && group.some(record => record['phase'] === 'ProxySummary' && record['leg'] === leg && record['outstanding'] === false));
      complete &&= group.some(record => record['phase'] === 'InputHalfCloseReturned');
      if (group.some(record => record['phase'] === 'CopyReturned' && record['leg'] === 'from-native' && record['io'] === 'ok')) complete &&= group.some(record => record['phase'] === 'OutputFlushReturned');
    }
    receipt.sources.push({ source, pid: Number(first['pid']), records: group.length, lastRecord: Number(last['record']), dropped: Math.max(...group.map(record => Number(record['droppedBefore']))), suppressed: Math.max(...group.map(record => Number(record['suppressedBefore']))), emitted: Math.min(Number.MAX_SAFE_INTEGER, Number(last['emittedBefore']) + 1), overflow: group.some(record => record['overflow'] === true) || Number(last['emittedBefore']) === Number.MAX_SAFE_INTEGER, status: complete ? 'complete' : 'incomplete' });
    if (!complete) receipt.reasons.push('loss-or-missing-terminal');
  }
  if (groups.size === 0) receipt.reasons.push('missing-source');
  if (!native && (groups.size !== 1 || !records.some(record => record['phase'] === 'CaptureStarted'))) receipt.reasons.push('unexpected-owner');
  receipt.reasons = [...new Set(receipt.reasons)];
  if (receipt.reasons.length) receipt.status = 'incomplete';
  return { receipt, records };
}
function compilerReceipt(output: string) {
  try {
    const bytes = readBounded(join(output, 'fault-rustc-version.txt'), 4096);
    const text = bytes.toString('utf8');
    const release = /^release: ([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)$/m.exec(text)?.[1];
    const commit = /^commit-hash: ([a-f0-9]{40})$/m.exec(text)?.[1];
    if (!release || !commit) return { status: 'unavailable' as const };
    return { status: 'complete' as const, file: 'fault-rustc-version.txt', sha256: hash(bytes), release, commit };
  } catch { return { status: 'unavailable' as const }; }
}
export function collectSemanticTraceEvidence(output: string, prepared = true) {
  const native = inspectFile(output, NATIVE_TRACE_FILE, true);
  const cases = SEMANTIC_TRACE_CASES.map(name => ({ name, ...inspectFile(output, tsTraceFile(name), false) }));
  const files = [native.receipt, ...cases.map(item => item.receipt)];
  const reasons: string[] = prepared ? [] : ['preparation-refused'];
  const links: { case: string; tsPid: number; proxyPid: number; daemonPid: number }[] = [];
  const proxyOwners = new Set<number>(); const nativeOwners = new Set<number>();
  for (const item of cases) {
    try {
      const owner = lstatSync(join(output, `${tsTraceFile(item.name)}.owner`));
      if (!owner.isDirectory() || (owner.mode & 0o777) !== 0o700 || readdirSync(join(output, `${tsTraceFile(item.name)}.owner`)).length !== 0) throw new Error('Invalid claim');
    } catch { reasons.push('missing-owner-claim'); }
    const spawns = item.records.filter(record => record['phase'] === 'ProcessSpawned');
    if (spawns.length !== 1 || !natural(spawns[0]!['proxyPid']) || spawns[0]!['proxyPid'] === 0) { reasons.push('missing-process-link'); continue; }
    const proxyPid = Number(spawns[0]!['proxyPid']);
    const daemons = native.records.filter(record => record['source'] === 'proxy' && record['pid'] === proxyPid && record['phase'] === 'ProxyDaemonSpawned');
    if (proxyOwners.has(proxyPid) || daemons.length !== 1 || !natural(daemons[0]!['daemonPid']) || daemons[0]!['daemonPid'] === 0 || nativeOwners.has(Number(daemons[0]!['daemonPid']))) { reasons.push('duplicate-or-missing-process-link'); continue; }
    const daemonPid = Number(daemons[0]!['daemonPid']);
    proxyOwners.add(proxyPid); nativeOwners.add(daemonPid);
    links.push({ case: item.name, tsPid: Number(spawns[0]!['pid']), proxyPid, daemonPid });
  }
  if (native.receipt.sources.length !== 8 || native.receipt.sources.some(source => !(source.source === 'proxy' ? proxyOwners : nativeOwners).has(source.pid))) reasons.push('unexpected-native-owner');
  const totalRecords = files.reduce((total, file) => total + file.records, 0);
  const totalBytes = files.reduce((total, file) => total + (file.bytes ?? 0), 0);
  if (totalRecords > 4096 || totalBytes > 1280 * 1024) reasons.push('aggregate-cap');
  const compiler = compilerReceipt(output);
  if (compiler.status !== 'complete') reasons.push('compiler-unavailable');
  const status: CaptureStatus = files.every(file => file.status === 'unavailable') ? 'unavailable' : reasons.length || files.some(file => file.status !== 'complete') ? 'incomplete' : 'complete';
  return { schemaVersion: 2, prepared, status, interpretation: status === 'complete' ? 'capture-only' : 'inconclusive', files, ownershipDirectories: SEMANTIC_TRACE_CASES.map(name => `${tsTraceFile(name)}.owner`), links, compiler, totalRecords, totalBytes, reasons: [...new Set(reasons)], limits: { traceFiles: 5, ownershipDirectories: 4, records: 4096, bytes: 1280 * 1024, recordBytes: TRACE_RECORD_BYTES }, note: 'Process-local records only. Append order is not global order; write completion is not a protocol ACK. Instrumentation can change scheduling. Functional outcome is independent.' };
}
/** Re-read all five artifacts; a receipt is not proof of bytes that have since changed. */
export function verifySemanticTraceEvidence(output: string, expected: unknown): void {
  if (!traceObject(expected) || JSON.stringify(collectSemanticTraceEvidence(output, expected['prepared'] === true)) !== JSON.stringify(expected)) throw new Error('Semantic diagnostic evidence changed or is missing');
}
