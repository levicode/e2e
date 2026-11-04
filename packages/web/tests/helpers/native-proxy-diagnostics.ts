/** Closed, bounded observations for the test-only child-pipe / Unix-proxy chain. */
import type { Writable } from 'node:stream';

const FAILURE_KINDS = ['broken-pipe', 'connection-reset', 'connection-aborted', 'interrupted', 'would-block', 'timed-out', 'unexpected-eof', 'not-connected', 'invalid-data', 'other'] as const;
type Failure = typeof FAILURE_KINDS[number];
type Phase = 'write-enter' | 'write-return' | 'write-callback' | 'write-throw' | 'peer-request' | 'peer-status' | 'peer-cancel' | 'peer-result' | 'peer-ack' | 'ts-result' | 'ts-ack' | 'settled' | 'fresh-request' | 'disposed';
interface Fact {
  readonly source: 'ts' | 'peer';
  readonly phase: Phase;
  readonly kind?: 'hello' | 'request' | 'decision' | 'cancel' | 'close' | 'other';
  readonly bytes?: number;
  readonly writableLength?: number;
  readonly accepted?: boolean;
  readonly error?: Failure;
}
interface ProxyFact {
  readonly source: 'proxy';
  readonly phase: 'stdin-read' | 'socket-write' | 'socket-read' | 'stdout-write';
  readonly ordinal: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly error: Failure | null;
  readonly captureLimit: boolean;
}

/** Reject arbitrary stderr or future fields instead of accidentally retaining payloads. */
export function proxyFact(line: string): ProxyFact {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid closed proxy observation');
  const record = parsed as Record<string, unknown>;
  const fields = ['schemaVersion', 'ordinal', 'leg', 'bytes', 'totalBytes', 'error', 'captureLimit'];
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)) || record['schemaVersion'] !== 1
    || !['stdin-read', 'socket-write', 'socket-read', 'stdout-write'].includes(String(record['leg']))
    || !['ordinal', 'bytes', 'totalBytes'].every(field => Number.isSafeInteger(record[field]) && Number(record[field]) >= 0)
    || (record['error'] !== null && !FAILURE_KINDS.includes(record['error'] as Failure)) || typeof record['captureLimit'] !== 'boolean') throw new Error('Invalid closed proxy observation');
  return { source: 'proxy', phase: record['leg'] as ProxyFact['phase'], ordinal: Number(record['ordinal']), bytes: Number(record['bytes']), totalBytes: Number(record['totalBytes']), error: record['error'] as Failure | null, captureLimit: record['captureLimit'] };
}

/** The dump contains no frames, commands, IDs, paths, argv, or exception messages. */
export class ProxyDiagnostics {
  private readonly records: (Fact | ProxyFact)[] = [];
  private dropped = 0;
  constructor(private readonly limit = 256) {}
  add(fact: Fact | ProxyFact): void {
    if (this.records.length < this.limit) this.records.push(fact);
    else this.dropped++;
  }
  snapshot(): { readonly dropped: number; readonly records: readonly (Fact | ProxyFact)[] } {
    return { dropped: this.dropped, records: [...this.records] };
  }
}

/** Observe the actual stream method, without adding a second Writable or buffering layer. */
export function observeProxyWrites(stream: Writable, diagnostics: ProxyDiagnostics): () => void {
  const original = stream.write;
  stream.write = function (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.byteLength;
    const done = typeof encoding === 'function' ? encoding : callback;
    let kind: NonNullable<Fact['kind']> = 'other';
    try {
      const parsed = JSON.parse(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()) as Record<string, unknown>;
      if (['hello', 'request', 'decision', 'cancel', 'close'].includes(String(parsed['type']))) kind = parsed['type'] as NonNullable<Fact['kind']>;
    } catch { /* Unknown input stays a closed enum, never copied into diagnostics. */ }
    diagnostics.add({ source: 'ts', phase: 'write-enter', kind, bytes, writableLength: stream.writableLength });
    try {
      const accepted = original.call(stream, chunk, typeof encoding === 'string' ? encoding : 'utf8', error => {
        diagnostics.add({ source: 'ts', phase: 'write-callback', kind, bytes, writableLength: stream.writableLength, ...(error ? { error: 'other' as const } : {}) });
        done?.(error);
      });
      diagnostics.add({ source: 'ts', phase: 'write-return', kind, bytes, writableLength: stream.writableLength, accepted });
      return accepted;
    } catch (error) {
      diagnostics.add({ source: 'ts', phase: 'write-throw', kind, bytes, writableLength: stream.writableLength, error: 'other' });
      throw error;
    }
  };
  return () => { stream.write = original; };
}
