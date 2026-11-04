import { resolve } from 'node:path';

interface Assertion { status: string; fullName?: string }
interface SuiteResult { name: string; status?: string; assertionResults: Assertion[] }
export interface TestReport { success: boolean; testResults: SuiteResult[] }

/** A process exit code cannot prove discovery, execution, or absence of skips. */
export function verifyReport(report: TestReport, expected: readonly string[]): number {
  if (report.success !== true || !Array.isArray(report.testResults)) throw new Error('Test process did not report success');
  if (expected.length === 0) throw new Error('Acceptance discovered zero files');
  const wanted = new Set(expected.map((file) => resolve(file)));
  const seen = new Set<string>();
  let count = 0;
  for (const result of report.testResults) {
    const file = resolve(result.name);
    if (!wanted.has(file)) throw new Error(`Unexpected test file: ${file}`);
    if (seen.has(file)) throw new Error(`Duplicate test file: ${file}`);
    seen.add(file);
    if (result.status !== 'passed' || !Array.isArray(result.assertionResults) || result.assertionResults.length === 0) throw new Error(`No passing assertions in ${file}`);
    for (const test of result.assertionResults) {
      if (test.status !== 'passed') throw new Error(`Required assertion ${test.fullName ?? file} is ${test.status}; skipped/todo is not acceptance`);
      count++;
    }
  }
  for (const file of wanted) if (!seen.has(file)) throw new Error(`Required test file was not executed: ${file}`);
  return count;
}
