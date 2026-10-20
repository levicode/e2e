import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditConnectionLifecycle } from './cdp-audit-proxy.ts';

test('audit forwarding stops at explicit peer closure before late upstream events', () => {
  const errors: string[] = [];
  const lifecycle = auditConnectionLifecycle(1, errors);
  assert.equal(lifecycle.closing, false);
  lifecycle.close();
  assert.equal(lifecycle.closing, true);
  lifecycle.fail('upstream socket', new Error('closed during handshake'));
  assert.deepEqual(errors, []);
});

test('active forwarding errors remain fatal and preserve their origin', () => {
  for (const stage of ['client frame', 'client socket', 'client close', 'upstream message', 'upstream socket', 'upstream close']) {
    const errors: string[] = [];
    const lifecycle = auditConnectionLifecycle(2, errors);
    lifecycle.fail(stage, new Error('sentinel failure'));
    assert.equal(lifecycle.closing, true);
    assert.deepEqual(errors, [`CDP forwarding connection 2 failed (${stage}): Error: sentinel failure`]);
    lifecycle.fail('upstream socket', new Error('secondary close error'));
    assert.equal(errors.length, 1, 'Teardown must not erase or multiply the original failure');
  }
});
