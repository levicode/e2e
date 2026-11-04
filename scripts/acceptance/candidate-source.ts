/** Final native delivery cannot retain unreachable production backends or stage tests elsewhere. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../public-packages.ts';

export const LEGACY_PRODUCTION_FILES = [
  'app-log.ts', 'read-node.ts', 'observe.ts', 'capture-scope.ts', 'cdp-recovery.ts',
  'provider-video.ts', 'browser-connection.ts', 'surface.ts', 'observation.ts', 'downloads.ts',
  'actions.ts', 'cdp-selectors.ts', 'selector-engines.ts', 'install.ts', 'video.ts', 'trace-feed.ts',
  'attempt-session.ts', 'shown-selector.ts', 'closed-shadow.ts', 'label-selector.ts', 'read-selector.ts',
  'locators.ts', 'dialogs.ts', 'refs.ts', 'support.ts', 'observation-capture.ts',
] as const;
/** Keep the assertion-bearing suites in normal discovery while their implementations migrate. */
export const REQUIRED_MIGRATED_TEST_FILES = [
  'integration/read-node-names.test.ts', 'integration/observation.test.ts',
  'unit/closed-shadow.test.ts', 'unit/actions.test.ts', 'unit/observation-capture.test.ts',
  'unit/cdp-selectors.test.ts', 'unit/surface-lifecycle.test.ts', 'unit/locators.test.ts',
  'unit/provider-video.test.ts', 'unit/semantic-fallback.test.ts', 'unit/attempt-session.test.ts',
  'unit/refs-disposal.test.ts', 'unit/video.test.ts', 'unit/observe.test.ts',
] as const;
export function candidateSourceProblems(root: string): string[] {
  const web = join(root, 'packages/web'); const problems: string[] = [];
  for (const file of LEGACY_PRODUCTION_FILES) if (existsSync(join(web, 'src', file))) problems.push(`Legacy production backend remains: packages/web/src/${file}`);
  for (const file of REQUIRED_MIGRATED_TEST_FILES) if (!existsSync(join(web, 'tests', file))) problems.push(`Required migration assertions left normal discovery: packages/web/tests/${file}`);
  const tests = join(web, 'tests');
  if (existsSync(tests)) for (const file of readdirSync(tests, { recursive: true, encoding: 'utf8' })) {
    if (file.split(/[\\/]/).includes('legacy-oracle')) problems.push(`Legacy staging is not final delivery: packages/web/tests/${file}`);
    if (!file.endsWith('.ts')) continue;
    const content = readFileSync(join(tests, file), 'utf8');
    for (const backend of LEGACY_PRODUCTION_FILES) {
      if (content.includes(`/src/${backend}`) || content.includes(`/src/${backend.slice(0, -3)}.js`)) problems.push(`Test still imports a removed backend: packages/web/tests/${file} -> ${backend}`);
    }
  }
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2]; if (!output) throw new Error('usage: candidate-source.ts output');
  mkdirSync(output, { recursive: true }); const problems = candidateSourceProblems(REPO_ROOT);
  writeFileSync(join(output, 'source-removal.result.json'), JSON.stringify({ schemaVersion: 1, status: problems.length ? 'failed' : 'passed', problems, releaseEligible: false }, null, 2));
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length) process.exitCode = 1;
}
