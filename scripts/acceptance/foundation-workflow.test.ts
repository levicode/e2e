import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/native-foundation.yml', import.meta.url), 'utf8');

test('independent native diagnostics retain a mandatory all-success gate', () => {
  assert.doesNotMatch(workflow, /continue-on-error/);
  for (const id of ['native-build', 'native-units', 'chromium-install', 'native-browser', 'native-proxy']) {
    assert.equal(workflow.split(`id: ${id}\n`).length - 1, 1);
  }
  assert.match(workflow, /id: native-units\n\s+if: \$\{\{ !cancelled\(\) && steps\.native-build\.outcome == 'success' }}/);
  for (const id of ['native-browser', 'native-proxy']) {
    assert.ok(workflow.includes(`id: ${id}\n        if: \${{ !cancelled() && steps.chromium-install.outcome == 'success' }}`));
  }
  const gate = workflow.indexOf('- name: Require every foundation gate');
  const seal = workflow.indexOf('- name: Seal exact producer identity');
  assert.ok(gate > 0 && seal > gate);
  for (const name of ['BUILD', 'UNITS', 'BROWSER', 'PROXY']) {
    assert.ok(workflow.slice(gate, seal).includes(`[ "$${name}" = success ]`));
  }
  assert.doesNotMatch(workflow.slice(seal, workflow.indexOf('- uses: actions/upload-artifact', seal)), /if:\s*\$\{\{ (?:always|!cancelled)/);
});
