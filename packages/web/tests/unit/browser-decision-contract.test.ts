import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBrowserDecision } from '../../src/native/browser-decode.ts';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/client-protocol-v1.json', import.meta.url), 'utf8')) as { validDecision: unknown[]; invalidDecision: unknown[] };

describe('native Browser decision contract', () => {
  it('accepts the byte-identical native body-source corpus', () => {
    for (const decision of vectors.validDecision) expect(() => validateBrowserDecision(decision)).not.toThrow();
  });

  it('rejects the native invalid body-source corpus before token selection', () => {
    for (const decision of vectors.invalidDecision) expect(() => validateBrowserDecision(decision)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it.each([
    { kind: 'fulfill', status: 200, headers: [], bodyBase64: 'AB==' },
    { kind: 'fulfill', status: 200, headers: [{ name: 'x-fixture', value: 'a\r\nb' }], bodyBase64: '' },
    { kind: 'fulfill', status: 200, headers: [], bodyHandle: '../not-an-opaque-handle' },
    { kind: 'continue', overrides: { method: 'GET\nPOST' } },
    { kind: 'continue', overrides: { url: 'http://fixture.test/\u0080' } },
    { kind: 'dialog', accept: false, promptText: 'not valid for dismissal' },
    { kind: 'abort', privateField: 'not diagnostic text' },
  ])('rejects malformed decision without echoing its content', decision => {
    expect(() => validateBrowserDecision(decision)).toThrow('The native browser decision does not match its capability contract');
  });

  it('preserves duplicate header pairs and valid empty bodies', () => {
    const decision = { kind: 'fulfill', status: 200, headers: [{ name: 'set-cookie', value: 'first=1' }, { name: 'set-cookie', value: 'second=2' }], bodyBase64: '' };
    validateBrowserDecision(decision);
    expect(decision.headers).toHaveLength(2);
  });
});
