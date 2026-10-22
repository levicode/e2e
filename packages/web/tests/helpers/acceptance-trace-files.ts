/** Test/runner-only bounded collector. Never imported by published runtime code. */
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { AcceptanceRecord } from '../../src/native/acceptance-trace.ts';

export const SEMANTIC_TRACE_CASES = ['deadline', 'cancellation', 'fallback', 'abandoned-ids'] as const;
export type SemanticTraceCase = typeof SEMANTIC_TRACE_CASES[number];
export const TS_TRACE_RECORDS = 512;
export const TRACE_BYTES = 256 * 1024;
export const TRACE_RECORD_BYTES = 512;
export const NATIVE_TRACE_FILE = 'semantic-faults.native-phases.jsonl';
export const tsTraceFile = (name: SemanticTraceCase): string => `semantic-faults.${name}.ts-phases.jsonl`;
export const TRACE_COMMON_KEYS = ['schemaVersion', 'source', 'pid', 'record', 'phase', 'droppedBefore', 'emittedBefore', 'suppressedBefore', 'overflow'] as const;
const write = ['kind', 'operationSeq', 'start', 'end', 'length'];
const fields: Record<string, readonly string[]> = {
  CaptureStarted: ['initialSubmittedBytes', 'seedKnown'], CaptureFinished: ['submittedBytes', 'pendingWriteCallbacks'], CaptureLimitReached: [], ProcessSpawned: ['proxyPid'],
  LocalCancelSelected: ['operationSeq', 'reason'], ExchangeRefused: ['kind', 'operationSeq', 'reason'],
  WriteEntered: [...write, 'writableLength', 'writableEnded', 'destroyed'], WriteReturned: [...write, 'returned'],
  WriteThrew: [...write, 'io'], WriteCallback: [...write, 'io'], ReceiveChunk: ['length', 'failed'],
  FrameComplete: [], FrameRefused: ['reason'], ReceiveEof: ['pendingBytes', 'failed', 'clean'],
  ResultValidated: ['operationSeq', 'generation'], CancelAckValidated: ['operationSeq', 'generation', 'accepted'],
  CancelExchangeResolved: ['operationSeq'], SettlementExpired: ['operationSeq', 'resultSeen', 'cancelAckSeen'],
  ClientFail: ['reason'], DisposeEntered: [], StdinEndEntered: [], StreamsDestroyEntered: [],
  ProcessExit: ['codeKnown', 'exitCode', 'signalled'], ProcessClose: ['codeKnown', 'exitCode', 'signalled'],
};
const optional: Record<string, readonly string[]> = {
  ProcessSpawned: ['proxyPid'], ExchangeRefused: ['operationSeq'], WriteEntered: ['operationSeq'], WriteReturned: ['operationSeq'], WriteThrew: ['operationSeq'], WriteCallback: ['operationSeq'], CancelAckValidated: ['operationSeq'], ProcessExit: ['exitCode'], ProcessClose: ['exitCode'],
};
export const TRACE_IO = ['ok', 'eof', 'interrupted', 'would-block', 'broken-pipe', 'connection-reset', 'connection-aborted', 'not-connected', 'timed-out', 'unexpected-eof', 'write-zero', 'other'];
const reasons = new Set(['deadline', 'abort', 'already-failed', 'capacity', 'timeout', 'frame-bound', 'serialization', 'identity-exhausted', 'schema', 'parse', 'oversize', 'event-order', 'response-correlation', 'response-kind', 'callback-proof', 'native-refusal', 'receive', 'stream', 'settlement', 'delivery', 'engine-failure', 'cancelled', 'unsupported-capability']);
export type TraceObject = Record<string, unknown>;
export const traceObject = (value: unknown): value is TraceObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const exactKeys = (value: TraceObject, required: readonly string[], allowed: readonly string[] = required): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.includes(key));
export function validTsTraceRecord(value: unknown): value is AcceptanceRecord {
  if (!traceObject(value) || value['schemaVersion'] !== 2 || value['source'] !== 'ts' || typeof value['phase'] !== 'string' || !Object.hasOwn(fields, value['phase'])) return false;
  const phase = value['phase'];
  const extra = fields[phase]!;
  const required = [...TRACE_COMMON_KEYS, ...extra.filter(key => !optional[phase]?.includes(key))];
  if (!exactKeys(value, required, [...TRACE_COMMON_KEYS, ...extra])) return false;
  const booleans = new Set(['overflow', 'seedKnown', 'writableEnded', 'destroyed', 'returned', 'accepted', 'resultSeen', 'cancelAckSeen', 'failed', 'clean', 'codeKnown', 'signalled']);
  for (const [key, fact] of Object.entries(value)) {
    if (['schemaVersion', 'source', 'phase'].includes(key)) continue;
    if (booleans.has(key)) { if (typeof fact !== 'boolean') return false; }
    else if (key === 'kind') { if (typeof fact !== 'string' || !['hello', 'request', 'decision', 'cancel', 'close'].includes(fact)) return false; }
    else if (key === 'reason') { if (typeof fact !== 'string' || !reasons.has(fact)) return false; }
    else if (key === 'io') { if (typeof fact !== 'string' || !TRACE_IO.includes(fact)) return false; }
    else if (!natural(fact)) return false;
  }
  return value['pid'] !== 0;
}

export interface TraceCollector { readonly available: boolean; observe(record: Readonly<AcceptanceRecord>): boolean; close(): void }
const disabled = (): TraceCollector => ({ available: false, observe: () => false, close() {} });
/** Fixed mkdir claims are never reclaimed. They prevent stale/duplicate writers across processes. */
export function openSemanticTrace(name: SemanticTraceCase, nativeFile: string | undefined): TraceCollector {
  if (!constants.O_NOFOLLOW || !nativeFile || !isAbsolute(nativeFile) || !SEMANTIC_TRACE_CASES.includes(name)) return disabled();
  const file = join(dirname(nativeFile), tsTraceFile(name));
  let fd: number | undefined;
  try {
    mkdirSync(`${file}.owner`, { mode: 0o700 });
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('Unavailable trace');
  } catch { if (fd !== undefined) { try { closeSync(fd); } catch { /* Capture remains unavailable. */ } } return disabled(); }
  let stopped = false; let count = 0; let bytes = 0;
  const handle = fd;
  return {
    available: true,
    observe(record) {
      if (stopped) return false;
      try {
        // Snapshot own values once; never serialize a caller's getters or inherited toJSON.
        const snapshot: unknown = Object.fromEntries(Object.entries(record));
        if (!validTsTraceRecord(snapshot)) { stopped = true; return false; }
        let line = Buffer.from(JSON.stringify(snapshot) + '\n');
        if (line.length > TRACE_RECORD_BYTES) { stopped = true; return false; }
        // Reserve one maximum-sized record for the unique cap marker.
        const limited = count >= TS_TRACE_RECORDS - 1 || bytes + line.length > TRACE_BYTES - TRACE_RECORD_BYTES;
        if (limited) {
          const { schemaVersion, source, pid, record: ordinal, droppedBefore, emittedBefore, suppressedBefore, overflow } = snapshot;
          line = Buffer.from(JSON.stringify({ schemaVersion, source, pid, record: ordinal, phase: 'CaptureLimitReached', droppedBefore, emittedBefore, suppressedBefore, overflow }) + '\n');
        }
        if (count >= TS_TRACE_RECORDS || bytes + line.length > TRACE_BYTES) { stopped = true; return false; }
        // A short/failed append is terminal. Never retry, repair, truncate, or reopen.
        if (writeSync(handle, line) !== line.length) { stopped = true; return false; }
        count++; bytes += line.length;
        if (limited) stopped = true;
        return !limited;
      } catch { stopped = true; return false; }
    },
    close() { if (!stopped) stopped = true; try { closeSync(handle); } catch { /* no runtime consequence */ } },
  };
}
