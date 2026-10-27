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

test('P14 requires both negotiations while every suite-level public runtime remains production', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  const web = workflow.slice(workflow.indexOf('id: web-browser\n'), workflow.indexOf('id: crosscheck-benchmark\n'));
  assert.match(web, /steps.native-proxy.outcome == 'success' && steps.fault-proxy.outcome == 'success'/);
  assert.match(web, /candidate-web.ts web-browser "\$RUNNER_TEMP\/native-candidate-bin\/production" .artifacts\/native-candidate\/negotiation.json .artifacts\/native-candidate "\$RUNNER_TEMP\/native-candidate-bin\/acceptance-faults" .artifacts\/native-candidate\/fault-negotiation.json/);
  for (const suite of ['web-unit', 'core-reference', 'crosscheck-fixtures', 'public-callbacks']) assert.match(workflow, new RegExp(`candidate-web.ts ${suite} "\\$RUNNER_TEMP/native-candidate-bin/production"`));
});
