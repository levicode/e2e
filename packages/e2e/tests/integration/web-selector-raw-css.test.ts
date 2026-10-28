import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExistingWithConfigFile, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

// Same file and expected outcomes on original e557 and exact native candidate.
// Only browser ownership uses the Playwright helper. Queries run through the
// built public web engine and worker runner, including the native transport.
const SUITE = readFileSync(new URL('../fixtures/public-raw-css.e2e.ts', import.meta.url), 'utf8');

describe('public raw CSS exact baseline parity on real Chromium', () => {
  let app: FixtureApp | undefined;
  let chrome: RemoteChrome | undefined;
  let project: FixtureProject | undefined;
  let outcome: RunOutcome | undefined;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome();
    const configSource = `import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
export default {
  targets: [{ name: 'web', engine: web({ connect: { cdpEndpoint: () => ${JSON.stringify(chrome.endpoint)} } }), app: { url: process.env.APP_URL! } }],
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;`;
    project = createProject({ 'tests/public-raw-css.e2e.ts': SUITE, 'e2e.config.ts': configSource });
    outcome = await runExistingWithConfigFile(project, { appUrl: app.url });
  }, 300_000);

  afterAll(async () => {
    const failures: Error[] = [];
    try { project?.cleanup(); } catch (cause) { failures.push(new Error('fixture project cleanup failed', { cause })); }
    try { if (chrome !== undefined) await closeRemoteChrome(chrome); } catch (cause) { failures.push(new Error('Chrome cleanup failed', { cause })); }
    try { await app?.close(); } catch (cause) { failures.push(new Error('fixture app cleanup failed', { cause })); }
    if (failures.length > 0) throw new AggregateError(failures, 'public raw-css fixture cleanup failed');
  });

  it('executes all six original CSS observations with strict public taxonomy', () => {
    expect(outcome).toBeDefined();
    expect(outcome!.results).toHaveLength(1);
    expect(outcome!.results.map(result => result.test.title)).toEqual(['public raw CSS: exact original baseline parity']);
    expect(outcome!.results.map(result => result.status), JSON.stringify(outcome!.report)).toEqual(['passed']);
    expect(outcome!.report.run.errors).toEqual([]);
  });
});
