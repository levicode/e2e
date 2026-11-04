import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReport, type TestReport } from './report.ts';
const report = (status = 'passed'): TestReport => ({ success: true, testResults: [{ name: '/tmp/contract.test.ts', status: 'passed', assertionResults: [{ status, fullName: 'contract' }] }] });
test('acceptance proves every discovered file ran passing assertions', () => { assert.equal(verifyReport(report(), ['/tmp/contract.test.ts']), 1); });
test('critical skipped, pending, todo and failed assertions cannot turn green', () => {
  for (const status of ['skipped', 'pending', 'todo', 'failed']) assert.throws(() => verifyReport(report(status), ['/tmp/contract.test.ts']), /not acceptance/);
});
test('missing, extra, duplicate, empty files and zero discovery fail closed', () => {
  assert.throws(() => verifyReport(report(), []), /zero files/);
  assert.throws(() => verifyReport(report(), ['/tmp/other.test.ts']), /Unexpected/);
  assert.throws(() => verifyReport({ success: true, testResults: [] }, ['/tmp/contract.test.ts']), /not executed/);
  const doubled = report(); doubled.testResults.push(doubled.testResults[0]!);
  assert.throws(() => verifyReport(doubled, ['/tmp/contract.test.ts']), /Duplicate/);
  const empty = report(); empty.testResults[0]!.assertionResults = [];
  assert.throws(() => verifyReport(empty, ['/tmp/contract.test.ts']), /No passing/);
});
