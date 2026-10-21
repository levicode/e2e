/** GitHub expression-context regression, not runtime acceptance evidence. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('candidate runner-specific Cargo paths are initialized only after a runner exists', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  // runner is unavailable in jobs.<job_id>.env, even though this is valid YAML.
  // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
  const jobEnvs = [...workflow.matchAll(/^    env:\n((?:^      .*\n)+)/gm)];
  assert.ok(jobEnvs.length > 0, 'discover the candidate job environment');
  for (const [, env] of jobEnvs) {
    assert.doesNotMatch(env!, /\$\{\{[^}]*\brunner(?:\.|\[)/);
    assert.doesNotMatch(env!, /\bCARGO_(?:HOME|TARGET_DIR):/);
  }
  const setup = workflow.slice(workflow.indexOf('id: source\n'), workflow.indexOf('id: native-checkout\n'));
  assert.match(setup, /echo "CARGO_TARGET_DIR=\$RUNNER_TEMP\/native-candidate-target" >> "\$GITHUB_ENV"/);
  assert.match(setup, /echo "CARGO_HOME=\$RUNNER_TEMP\/native-candidate-cargo" >> "\$GITHUB_ENV"/);
});
