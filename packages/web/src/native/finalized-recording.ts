/** Terminal-only immutable recording transfer, never a browser operation. */
import { createHash } from 'node:crypto';
import { EngineError, type JsonValue } from 'e2e/engine';

export interface FinalizedRecordingIdentity { readonly identityScope: string; readonly failedOperationSeq: number }
export interface FinalizedVideoBytes { readonly bytes: Buffer; readonly startedAt: string; readonly ordinal: number }
export type FinalizedRecordingCommand = 'recording.finalized.collect' | 'recording.finalized.read' | 'recording.finalized.release';
type Exchange = (command: FinalizedRecordingCommand, args: Readonly<Record<string, JsonValue>>) => Promise<unknown>;
interface Segment { readonly handle: string; readonly size: number; readonly sha256: string; readonly startedAt: string; readonly ordinal: number }
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_HANDLES = 128;
const CHUNK_BYTES = 256 * 1024;
const invalid = (): never => { throw new EngineError('ENGINE_FAILURE', 'The native finalized recording contract was invalid', { retryable: false }); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 256 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

/** A closed decoder binds the complete manifest before any byte handle is used. */
export function finalizedRecordingManifest(value: unknown, expected: FinalizedRecordingIdentity): { readonly token: string; readonly segments: readonly Segment[] } {
  const batch = record(value);
  keys(batch, ['identityScope', 'failedOperationSeq', 'token', 'segments']);
  if (batch['identityScope'] !== expected.identityScope || batch['failedOperationSeq'] !== expected.failedOperationSeq) invalid();
  const token = identity(batch['token']);
  if (!Array.isArray(batch['segments']) || batch['segments'].length === 0 || batch['segments'].length > MAX_HANDLES) return invalid();
  const seen = new Set<string>(); let total = 0; let ordinal = 0;
  const segments = batch['segments'].map(entry => {
    const segment = record(entry);
    keys(segment, ['handle', 'size', 'sha256', 'mediaType', 'startedAt', 'ordinal']);
    const handle = identity(segment['handle']);
    if (seen.has(handle)) invalid();
    seen.add(handle);
    const size = integer(segment['size'], 1, MAX_BYTES); total += size;
    const nextOrdinal = integer(segment['ordinal'], 1, Number.MAX_SAFE_INTEGER);
    if (total > MAX_TOTAL || nextOrdinal <= ordinal) invalid();
    ordinal = nextOrdinal;
    const sha256 = segment['sha256']; const startedAt = segment['startedAt'];
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || segment['mediaType'] !== 'video/webm'
      || typeof startedAt !== 'string' || startedAt.length > 64 || !Number.isFinite(Date.parse(startedAt))) return invalid();
    return { handle, size, sha256, startedAt, ordinal };
  });
  return { token, segments };
}

/** No retries or producer work. The caller supplies one unrenewed cleanup clock. */
export async function collectFinalizedRecording(owner: FinalizedRecordingIdentity, exchange: Exchange): Promise<readonly FinalizedVideoBytes[]> {
  const batch = finalizedRecordingManifest(await exchange('recording.finalized.collect', { ...owner }), owner);
  const output: FinalizedVideoBytes[] = [];
  for (const segment of batch.segments) {
    const base = { ...owner, token: batch.token, handle: segment.handle };
    const chunks: Buffer[] = []; const hash = createHash('sha256'); let offset = 0;
    for (;;) {
      const chunk = record(await exchange('recording.finalized.read', { ...base, offset, maxBytes: CHUNK_BYTES }));
      keys(chunk, ['base64', 'nextOffset', 'eof']);
      if (typeof chunk['base64'] !== 'string' || chunk['base64'].length > 4 * Math.ceil(CHUNK_BYTES / 3) || typeof chunk['eof'] !== 'boolean') invalid();
      const bytes = Buffer.from(chunk['base64'] as string, 'base64');
      if (bytes.toString('base64') !== chunk['base64'] || bytes.length > CHUNK_BYTES || bytes.length === 0
        || chunk['nextOffset'] !== offset + bytes.length || offset + bytes.length > segment.size) invalid();
      chunks.push(bytes); hash.update(bytes); offset += bytes.length;
      if (chunk['eof']) {
        if (offset !== segment.size || hash.digest('hex') !== segment.sha256) invalid();
        break;
      }
      if (offset === segment.size) invalid();
    }
    const released = record(await exchange('recording.finalized.release', base));
    keys(released, ['released']);
    if (released['released'] !== true) invalid();
    output.push({ bytes: Buffer.concat(chunks, segment.size), startedAt: segment.startedAt, ordinal: segment.ordinal });
  }
  return output;
}
