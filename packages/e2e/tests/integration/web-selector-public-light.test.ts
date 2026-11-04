import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProjectWithConfigFile, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

// Same file and expected outcomes on original e557 and exact native candidate.
// Only browser ownership uses the Playwright helper. Queries run through the
// built public web engine and worker runner, including the native transport.
const SUITE = readFileSync(new URL('../fixtures/public-light.e2e.ts', import.meta.url), 'utf8');

describe('public supported-light selector compatibility on real Chromium', () => {
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
    ({ outcome, project } = await runProjectWithConfigFile({ 'tests/public-light.e2e.ts': SUITE }, { appUrl: app.url, configSource }));
  }, 300_000);

  afterAll(async () => {
    project?.cleanup();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    await app?.close();
  });

  it('executes all five engine families plus shadow and frame public boundaries', () => {
    expect(outcome).toBeDefined();
    expect(outcome!.results).toHaveLength(7);
    expect(outcome!.results.map(result => result.test.title).toSorted()).toEqual([
      'public light projection: id:light', 'public light projection: data-testid:light',
      'public light projection: data-test-id:light', 'public light projection: data-test:light',
      'public light projection: xpath:light', 'public light projection: open and closed shadow boundaries',
      'public light projection: frame owner and inner document boundaries',
    ].toSorted());
    expect(outcome!.results.map(result => result.status), JSON.stringify(outcome!.report))
      .toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
    expect(outcome!.report.run.errors).toEqual([]);
  });
});
