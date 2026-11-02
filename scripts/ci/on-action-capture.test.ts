import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onActionCaptureEnvironment } from '../../packages/e2e/tests/helpers/on-action-capture.ts';
test('capture is opt-in and refuses conflicts without changing environment', () => {
  assert.equal(onActionCaptureEnvironment({}), undefined);
  for (const conflict of [{ AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: '/existing' }, { E2E_POPUP_EVAL_CAPTURE: '1' }]) {
    const env = { E2E_ON_ACTION_CAPTURE_DIR: '/missing', ...conflict }; const before = { ...env };
    assert.equal(onActionCaptureEnvironment(env), undefined); assert.deepEqual(env, before);
  }
});
test('only new owned private leaf is passed to this case; collisions do not overwrite', () => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'onaction-'));
  try {
    chmodSync(root, 0o700); const env = { E2E_ON_ACTION_CAPTURE_DIR: root, KEEP: 'synthetic' };
    const result = onActionCaptureEnvironment(env); assert.ok(result); assert.notEqual(result, env);
    assert.equal(result.KEEP, 'synthetic'); assert.equal('AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE' in env, false);
    const file = result.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE!; assert.equal(readFileSync(file).length, 0);
    assert.equal(onActionCaptureEnvironment(env), undefined); assert.equal(readFileSync(file).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('relative, symlink and public parents cannot become capture roots', () => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'onaction-'));
  const link = `${root}-link`;
  try {
    symlinkSync(root, link); assert.equal(onActionCaptureEnvironment({ E2E_ON_ACTION_CAPTURE_DIR: link }), undefined);
    assert.equal(onActionCaptureEnvironment({ E2E_ON_ACTION_CAPTURE_DIR: 'relative' }), undefined);
    chmodSync(root, 0o755); assert.equal(onActionCaptureEnvironment({ E2E_ON_ACTION_CAPTURE_DIR: root }), undefined);
  } finally { try { unlinkSync(link); } finally { rmSync(root, { recursive: true, force: true }); } }
});
