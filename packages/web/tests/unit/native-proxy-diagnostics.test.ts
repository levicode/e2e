import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { observeProxyWrites, ProxyDiagnostics, proxyFact } from '../helpers/native-proxy-diagnostics.ts';

it('observes the original writable return and callback without retaining synthetic frame bytes', async () => {
  const diagnostics = new ProxyDiagnostics();
  const delivered: Buffer[] = [];
  const stream = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, done) { delivered.push(chunk); queueMicrotask(done); } });
  const restore = observeProxyWrites(stream, diagnostics);
  const bytes = Buffer.from('synthetic-secret-frame');
  await new Promise<void>((resolve, reject) => {
    expect(stream.write(bytes, error => error ? reject(error) : resolve())).toBe(false);
  });
  expect(Buffer.concat(delivered)).toEqual(bytes);
  expect(diagnostics.snapshot().records.map(record => record.phase)).toEqual(['write-enter', 'write-return', 'write-callback']);
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain(bytes.toString());
  expect(diagnostics.snapshot().records[0]).toMatchObject({ bytes: bytes.length, writableLength: 0 });
  restore(); stream.destroy();
});

it('caps observations with a visible loss count', () => {
  const diagnostics = new ProxyDiagnostics(2);
  for (let index = 0; index < 5; index++) diagnostics.add({ source: 'peer', phase: 'peer-cancel', bytes: 42 });
  expect(diagnostics.snapshot()).toMatchObject({ dropped: 3 });
  expect(diagnostics.snapshot().records).toHaveLength(2);
});

it('allows only native closed-schema counts and error enums', () => {
  const record = { schemaVersion: 1, ordinal: 0, leg: 'socket-write', bytes: 17, totalBytes: 17, error: null, captureLimit: false };
  expect(proxyFact(JSON.stringify(record))).toMatchObject({ source: 'proxy', phase: 'socket-write', bytes: 17 });
  for (const changed of [{ ...record, payload: 'synthetic-secret' }, { ...record, error: 'synthetic-secret' }, { ...record, leg: 'synthetic-secret' }, { ...record, bytes: -1 }]) {
    expect(() => proxyFact(JSON.stringify(changed))).toThrow('Invalid closed proxy observation');
  }
});
