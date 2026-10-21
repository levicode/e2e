import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** Publishing and deployment are upstream-only; a fork must not inherit consent. */
function assertReleaseScope(workflow: string): void {
  const jobs = workflow.split(/^jobs:\s*$/m)[1];
  assert.ok(jobs, 'Release workflow must have jobs');
  const entries = [...jobs.matchAll(/^  ([\w-]+):\s*\n([\s\S]*?)(?=^  [\w-]+:\s*$|$(?![\s\S]))/gm)];
  assert.ok(entries.length > 0, 'Release jobs must be discoverable');
  for (const entry of entries) {
    assert.match(entry[2] ?? '', /^    if: \$\{\{ github\.repository == 'tester-army\/e2e' && /m, `${entry[1]} must explicitly restrict all side effects to the official repository`);
  }
}

test('all inherited release, nightly, registration and deployment jobs exclude forks', () => {
  assertReleaseScope(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
});

test('new unguarded release jobs fail the policy check even when earlier jobs are guarded', () => {
  assert.throws(() => assertReleaseScope("jobs:\n  guarded:\n    if: ${{ github.repository == 'tester-army/e2e' && true }}\n    runs-on: ubuntu-latest\n  accidental:\n    runs-on: ubuntu-latest\n"), /accidental must explicitly/);
});
