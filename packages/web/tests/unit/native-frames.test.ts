import { describe, expect, it } from 'vitest';
import { NativeFrameError, NativeFrames } from '../../src/native/frames.ts';

describe('native protocol frames', () => {
  it('decodes split UTF-8 and multiple correlated messages without line assumptions', () => {
    const frames = new NativeFrames(1024);
    const input = Buffer.from('{"id":"one","text":"示例"}\n{"id":"two"}\n');
    const output: Record<string, unknown>[] = [];
    for (const byte of input) output.push(...frames.push(Uint8Array.of(byte)));
    expect(output).toEqual([{ id: 'one', text: '示例' }, { id: 'two' }]);
    expect(() => frames.end()).not.toThrow();
    expect(() => frames.push(Buffer.from('{}\n'))).toThrow(NativeFrameError);
  });

  it('enforces byte bounds while accumulating, not only after a newline', () => {
    const frames = new NativeFrames(8);
    expect(frames.push(Buffer.from('{"a":1}'))).toEqual([]);
    expect(frames.push(Buffer.from('\n'))).toEqual([{ a: 1 }]);
    expect(() => frames.push(Buffer.from('123456789'))).toThrow(NativeFrameError);
    expect(() => frames.push(Buffer.from('{}\n'))).toThrow(NativeFrameError);
  });

  it.each(['\n', 'null\n', '[]\n', '1\n', '"private-sample"\n', '{broken-private-sample}\n'])('rejects malformed or non-object data without echoing it', (text) => {
    const frames = new NativeFrames(1024);
    expect(() => frames.push(Buffer.from(text))).toThrow('The native browser returned an invalid protocol frame');
  });

  it('rejects invalid UTF-8 rather than replacing bytes in identifiers', () => {
    const frames = new NativeFrames(1024);
    expect(() => frames.push(Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]))).toThrow(NativeFrameError);
  });

  it('refuses EOF on partial data and preserves no recoverable parser state', () => {
    const frames = new NativeFrames(1024);
    frames.push(Buffer.from('{"id":"pending"'));
    expect(() => frames.end()).toThrow(NativeFrameError);
    expect(() => frames.push(Buffer.from('}\n'))).toThrow(NativeFrameError);
  });

  it('grows a bounded frame and resets its length for the next message', () => {
    const frames = new NativeFrames(8192);
    const first = { text: 'x'.repeat(7000) };
    expect(frames.push(Buffer.from(`${JSON.stringify(first)}\n{}\n`))).toEqual([first, {}]);
  });
});


describe('scalar acceptance framing state', () => {
  it('keeps partial bytes over empty chunks and reports the original closed refusal class', () => {
    const frames = new NativeFrames(16);
    expect(frames.push(Buffer.from('{"x":'))).toEqual([]);
    expect(frames.push(Buffer.alloc(0))).toEqual([]);
    expect(frames.acceptanceState()).toEqual({ pendingBytes: 5, failed: false });
    expect(frames.push(Buffer.from('1}\n{}\n'))).toEqual([{ x: 1 }, {}]);
    expect(frames.acceptanceState()).toEqual({ pendingBytes: 0, failed: false });
    expect(() => frames.push(Buffer.alloc(17, 120))).toThrow(expect.objectContaining({ kind: 'oversize' }));
    expect(frames.acceptanceState()).toEqual({ pendingBytes: 0, failed: true });
    expect(() => frames.push(Buffer.from('{}\n'))).toThrow(expect.objectContaining({ kind: 'already-failed' }));
  });
});
