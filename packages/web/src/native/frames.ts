/** A malformed native frame never includes the potentially sensitive bytes in diagnostics. */
export class NativeFrameError extends Error {
  constructor() {
    super('The native browser returned an invalid protocol frame');
    this.name = 'NativeFrameError';
  }
}

/** Bounded JSON-line framing, independent of browser commands and protocol message validation. */
export class NativeFrames {
  private buffer: Buffer;
  private length = 0;
  private failed = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new NativeFrameError();
    this.buffer = Buffer.alloc(Math.min(4096, maximumBytes));
  }

  /** Applies a negotiated lower limit before reading the next frame, including coalesced frames. */
  limit(maximumBytes: number): void {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > this.maximumBytes || this.length > maximumBytes) throw new NativeFrameError();
    this.maximumBytes = maximumBytes;
  }

  /** Convenience reader for consumers that need an already bounded batch. */
  push(chunk: Uint8Array): readonly Record<string, unknown>[] {
    return Array.from(this.read(chunk));
  }

  /** Streams frames so negotiation and backpressure take effect between coalesced messages. */
  *read(chunk: Uint8Array): IterableIterator<Record<string, unknown>> {
    if (this.failed) throw new NativeFrameError();
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    try {
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        const size = this.length + end - start;
        if (size > this.maximumBytes) throw new NativeFrameError();
        if (size > this.buffer.length) {
          const next = Buffer.alloc(Math.min(this.maximumBytes, Math.max(size, this.buffer.length * 2)));
          this.buffer.copy(next, 0, 0, this.length);
          this.buffer = next;
        }
        bytes.copy(this.buffer, this.length, start, end);
        this.length = size;
        if (newline < 0) break;
        const text = this.decoder.decode(this.buffer.subarray(0, this.length));
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new NativeFrameError();
        this.buffer.fill(0, 0, this.length);
        this.length = 0;
        start = newline + 1;
        yield value as Record<string, unknown>;
      }
    } catch {
      this.failed = true;
      this.buffer.fill(0);
      this.length = 0;
      throw new NativeFrameError();
    }
  }

  /** EOF in a partial frame is a protocol failure, never a successful truncated response. */
  end(): void {
    if (this.failed || this.length !== 0) {
      this.failed = true;
      this.buffer.fill(0);
      this.length = 0;
      throw new NativeFrameError();
    }
    this.failed = true;
    this.buffer.fill(0);
  }
}
