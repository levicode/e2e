import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateReceiptProblem } from './candidate-receipt.ts';

test('final receipt never retains rejected JSON fragments but preserves existing validation labels', () => {
  let failure: unknown;
  try { JSON.parse('synthetic-private-fragment'); } catch (error) { failure = error; }
  assert.equal(candidateReceiptProblem(failure), 'Candidate receipt JSON is invalid');
  assert.equal(candidateReceiptProblem(new Error('Fault runtime identity is not separate and bound')), 'Error: Fault runtime identity is not separate and bound');
});

test('P14 secondary receipt is mandatory, closed, unchanged and equal to the verified fault binding', async () => {
  const { verifyInstallerFixtureReceipt } = await import('./candidate-receipt.ts');
  const production = 'a'.repeat(64);
  const expected = { caseId: 'P14', purpose: 'installer-cancellation-loopback', binarySha256: 'b'.repeat(64), negotiationProofSha256: 'c'.repeat(64) } as const;
  const receipt = { ...expected, postRunIdentityVerified: true };
  assert.deepEqual(verifyInstallerFixtureReceipt('web-browser', receipt, production, expected), receipt);
  for (const value of [undefined, {}, expected, { ...receipt, extra: 'unverified' }, { ...receipt, caseId: 'P13' }, { ...receipt, purpose: 'production' }, { ...receipt, postRunIdentityVerified: false }, { ...receipt, binarySha256: production }, { ...receipt, binarySha256: 'd'.repeat(64) }, { ...receipt, negotiationProofSha256: 'd'.repeat(64) }]) {
    assert.throws(() => verifyInstallerFixtureReceipt('web-browser', value, production, expected));
  }
  for (const suite of ['public-callbacks', 'semantic-faults', 'web-unit', 'package-imports']) {
    assert.equal(verifyInstallerFixtureReceipt(suite, undefined, production, expected), undefined);
    assert.throws(() => verifyInstallerFixtureReceipt(suite, receipt, production, expected), /Unexpected/);
  }
  const source = (await import('node:fs')).readFileSync(new URL('./candidate-receipt.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('verifyFeatureMatrixReceipt(output') < source.indexOf('const expectedInstallerRuntime'));
  assert.ok(source.indexOf('verifyInstallerFixtureReceipt(suite.id') < source.indexOf('if (syntheticRequested)'));
  assert.match(source, /verifyCandidateRuntime\(faultProbe, fault.binarySha256, true\)/);
});
