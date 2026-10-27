import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A missing verifier must stop before any provider-module import, even with explicit opt-in. */
test('unverified native candidate cannot reach the model', async () => {
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync(process.execPath, ['run.ts', '--run-model'], { cwd, encoding: 'utf8', env: { ...process.env, HELDOUT_MODEL_MODULE: '/nonexistent/provider.mjs', HELDOUT_BUNDLE: '/nonexistent/bundle', HELDOUT_MANIFEST_SHA256: 'a'.repeat(64), E2E_AGENT_BROWSER_EXECUTABLE: '/nonexistent/native' } });
  assert.equal(result.status, 2);
  const summary = JSON.parse(result.stdout.trim()) as { artifact: string };
  try {
    const report = JSON.parse(await readFile(summary.artifact, 'utf8'));
    assert.equal(report.status, 'blocked');
    assert.equal(report.blockedAt, 'verified-native-candidate');
    assert.deepEqual(report.scenarios, []);
  } finally { await rm(dirname(summary.artifact), { recursive: true }); }
});
