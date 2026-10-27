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
    const body = entry[2] ?? '';
    const guard = body.match(/^    if: (.+)$/m)?.[1] ?? '';
    assert.ok(!guard.includes('||'), `${entry[1]} must not allow a disjunctive repository bypass`);
    assert.match(body, /^    if: \$\{\{ github\.repository == 'tester-army\/e2e'(?: && | \}\})/m, `${entry[1]} must explicitly restrict all side effects to the official repository`);
  }
}

test('all inherited release, nightly, registration and deployment jobs exclude forks', () => {
  assertReleaseScope(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
});

test('new unguarded release jobs fail the policy check even when earlier jobs are guarded', () => {
  assert.throws(() => assertReleaseScope("jobs:\n  guarded:\n    if: ${{ github.repository == 'tester-army/e2e' && true }}\n    runs-on: ubuntu-latest\n  accidental:\n    runs-on: ubuntu-latest\n"), /accidental must explicitly/);
});

for (const file of ['mcp-registry.yml', 'agent.yml']) {
  test(`${file} independently guards every executable job against fork side effects`, () => {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assertReleaseScope(workflow);
    const guards = [...workflow.matchAll(/^    if: \$\{\{ github\.repository == 'tester-army\/e2e' \}\}\n/gm)];
    assert.ok(guards.length > 0);
    for (const guard of guards) {
      const withoutGuard = workflow.slice(0, guard.index) + workflow.slice(guard.index + guard[0].length);
      assert.throws(() => assertReleaseScope(withoutGuard), /must explicitly restrict/);
    }
  });
}

test('repository guard lint rejects disjunctions, comments and other repositories', () => {
  for (const guard of [
    "    if: ${{ github.repository == 'tester-army/e2e' && true || true }}",
    "    # if: ${{ github.repository == 'tester-army/e2e' }}",
    "    if: ${{ github.repository == 'levicode/e2e' }}",
  ]) assert.throws(() => assertReleaseScope(`jobs:\n  publish:\n${guard}\n    runs-on: ubuntu-latest\n`));
});

const forkLinuxRunner = "    runs-on: ${{ github.repository == 'tester-army/e2e' && 'blacksmith-4vcpu-ubuntu-2404' || 'ubuntu-24.04' }}";

test('ordinary Linux CI retains all jobs and uses standard runners on forks', () => {
  for (const [file, count] of [['spec.yml', 4], ['docs.yml', 3], ['benchmark.yml', 4]] as const) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const runners = workflow.split('\n').filter((line) => line.startsWith('    runs-on:'));
    assert.deepEqual(runners, Array.from({ length: count }, () => forkLinuxRunner), file);
  }
  const benchmark = readFileSync(new URL('../.github/workflows/benchmark.yml', import.meta.url), 'utf8');
  assert.match(benchmark, /web-agent:[\s\S]*?if: >-\n      \$\{\{ github\.repository == 'tester-army\/e2e' && needs\.changes\.outputs\.web/);
});

test('fork mobile planning is explicit non-device coverage and cannot schedule expensive jobs', () => {
  const mobile = readFileSync(new URL('../.github/workflows/mobile.yml', import.meta.url), 'utf8');
  assert.equal(mobile.split('\n').filter((line) => line === forkLinuxRunner).length, 2);
  for (const job of ['ios', 'android', 'warm']) {
    const body = mobile.split(`  ${job}:\n`)[1]?.split(/^  [\w-]+:\s*$/m)[0] ?? '';
    assert.match(body, /^    if: \$\{\{ github\.repository == 'tester-army\/e2e' && /m);
  }
  assert.ok(mobile.includes('this gate checks planning only, not mobile acceptance.'));
});

test('shared local setup actions do not invoke a Blacksmith service', () => {
  for (const name of ['expo-app', 'example-packages', 'mcp-publisher']) {
    const action = readFileSync(new URL(`../.github/actions/${name}/action.yml`, import.meta.url), 'utf8');
    assert.doesNotMatch(action, /blacksmith/i);
  }
});
