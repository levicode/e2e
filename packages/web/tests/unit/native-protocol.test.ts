import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NativeFrameError } from '../../src/native/frames.ts';
import { serverMessage } from '../../src/native/protocol.ts';
import { serverMessage as legacyServerMessage } from '../fixtures/client-protocol-ci17.ts';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/client-protocol-v1.json', import.meta.url), 'utf8')) as { server: Record<string, unknown>[]; errorCodes: string[]; frameErrors: Record<string, unknown>[]; invalidFrameErrors: Record<string, unknown>[] };

describe('native session wire contract', () => {
  it('accepts byte-identical native server vectors', () => {
    for (const message of vectors.server) expect(serverMessage(message)).toBe(message);
  });

  it('accepts every static error code in the shared native schema', () => {
    for (const code of vectors.errorCodes) expect(serverMessage({ type: 'error', error: { code }, scopeState: 'quarantined' })).toMatchObject({ error: { code } });
  });

  it('rejects unknown fields without including their values in errors', () => {
    for (const message of vectors.server) expect(() => serverMessage({ ...message, privateSample: 'not diagnostic text' })).toThrow(NativeFrameError);
  });

  it('does not confuse an acknowledged cancellation with a terminal operation', () => {
    const message = serverMessage({ type: 'control-result', id: 'c1', generation: 1, accepted: true, scopeState: 'usable' });
    expect(message.type).toBe('control-result');
    expect(message).not.toHaveProperty('effects');
  });

  it('refuses unknown effects paired with a reusable scope or a successful result', () => {
    const message = { type: 'result', id: 'r1', generation: 1, operationSeq: 1, ok: false, error: { code: 'scope-unavailable' }, effects: 'unknown', scopeState: 'usable' };
    expect(() => serverMessage(message)).toThrow(NativeFrameError);
    expect(() => serverMessage({ ...message, ok: true, error: undefined, data: {}, scopeState: 'quarantined' })).toThrow(NativeFrameError);
  });

  it('requires exclusive success data or a static error code', () => {
    const result = vectors.server.find(message => message['type'] === 'result')!;
    expect(() => serverMessage({ ...result, error: { code: 'invalid-frame' } })).toThrow(NativeFrameError);
    expect(() => serverMessage({ ...result, operationSeq: 1.5 })).toThrow(NativeFrameError);
    expect(() => serverMessage({ type: 'error', error: { code: 'privateSample' }, scopeState: 'closed' })).toThrow(NativeFrameError);
  });

  it('rejects non-finite JSON numbers and excessive depth before consumer traversal', () => {
    const event = { type: 'event', generation: 1, sequence: 1, event: 'diagnostic', payload: Infinity };
    expect(() => serverMessage(event)).toThrow(NativeFrameError);
    let payload: unknown = null;
    for (let depth = 0; depth < 130; depth++) payload = { child: payload };
    expect(() => serverMessage({ ...event, payload })).toThrow(NativeFrameError);
  });
});

it('requires a coordinated decoder update: the legacy decoder rejects every new result', () => {
  for (const message of vectors.frameErrors) {
    expect(() => legacyServerMessage(message)).toThrow(NativeFrameError);
    const error = message['error'] as Record<string, unknown>;
    // Either extension independently fails the old closed decoder.
    expect(() => legacyServerMessage({ ...message, error: { code: error['code'] } })).toThrow(NativeFrameError);
    expect(() => legacyServerMessage({ ...message, error: { ...error, code: 'invalid-arguments' } })).toThrow(NativeFrameError);
  }
  for (const code of vectors.errorCodes) {
    const decode = () => legacyServerMessage({ type: 'error', error: { code }, scopeState: 'quarantined' });
    if (code === 'fill-unsupported-target' || code === 'no-editable-focus' || code === 'tap-target-replaced-before-press') expect(decode).toThrow(NativeFrameError);
    else expect(decode).not.toThrow();
  }
});

it('accepts bounded terminal frame facts and rejects every paired invalid vector', () => {
  for (const message of vectors.frameErrors) expect(serverMessage(message)).toBe(message);
  for (const message of vectors.invalidFrameErrors) expect(() => serverMessage(message)).toThrow(NativeFrameError);
});

it('refuses non-JSON, non-integer, and contradictory frame facts', () => {
  const message = vectors.frameErrors[0]!;
  for (const field of ['index', 'count']) for (const value of [NaN, Infinity, -Infinity, undefined, null, true, [], {}]) {
    expect(() => serverMessage({ ...message, error: { code: 'frame-not-found', frameSelection: { index: 0, count: 0, [field]: value } } })).toThrow(NativeFrameError);
  }
  expect(() => serverMessage({ ...message, effects: 'unknown' })).toThrow(NativeFrameError);
  expect(() => serverMessage({ ...message, data: {} })).toThrow(NativeFrameError);
});
