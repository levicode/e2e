import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExistingWithConfigFile, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

// Identical observation-only fixture on e557 and current; not a parity acceptance gate.
// Queries run through the built public web engine and worker runner.
// Freeze the observed public error taxonomy before defining candidate parity.
const SUITE = readFileSync(new URL('../fixtures/public-chain-syntax-observation.e2e.ts', import.meta.url), 'utf8');

describe('original public raw selector baseline acquisition', () => {
  let app: FixtureApp | undefined;
  let chrome: RemoteChrome | undefined;
  let custodyError: unknown;
  let project: FixtureProject | undefined;
  let outcome: RunOutcome | undefined;
  let records: Array<{ id: string; result: { kind: string }; expectation: string }> = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    const executablePath = process.env['E2E_CHAIN_CHROME_EXECUTABLE'];
    if (executablePath === undefined) throw new Error('paired syntax Chrome executable is required');
    chrome = await launchRemoteChrome(executablePath);
    const configSource = `import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
export default {
  targets: [{ name: 'web', engine: web({ connect: { cdpEndpoint: () => ${JSON.stringify(chrome.endpoint)} } }), app: { url: process.env.APP_URL! } }],
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;`;
    project = createProject({ 'tests/public-chain-syntax-observation.e2e.ts': SUITE, 'e2e.config.ts': configSource });
    const output = path.join(project.dir, 'chain-syntax-observation.jsonl');
    writeFileSync(output, '');
    const previousOutput = process.env['E2E_CHAIN_SYNTAX_OUTPUT'];
    process.env['E2E_CHAIN_SYNTAX_OUTPUT'] = output;
    try { outcome = await runExistingWithConfigFile(project, { appUrl: app.url }); }
    finally {
      if (previousOutput === undefined) delete process.env['E2E_CHAIN_SYNTAX_OUTPUT'];
      else process.env['E2E_CHAIN_SYNTAX_OUTPUT'] = previousOutput;
      records = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as (typeof records)[number]);
      console.log('CHAIN_SYNTAX_OBSERVATIONS', JSON.stringify(records));
      const projectDir = project.dir;
      const retainEvidence = () => {
      // Copy only this synthetic project's report and attempt artifacts before cleanup.
      const evidenceRoot = process.env['E2E_CHAIN_EVIDENCE_DIR'];
      if (evidenceRoot === undefined || !path.isAbsolute(evidenceRoot)) throw new Error('absolute chain evidence directory required');
      const destination = path.join(evidenceRoot, 'syntax');
      const relation = path.relative(projectDir, destination);
      if (relation === '' || (!relation.startsWith('..' + path.sep) && !path.isAbsolute(relation))) throw new Error('evidence must survive project cleanup');
      mkdirSync(destination, { recursive: true });
      cpSync(output, path.join(destination, 'observations.jsonl'));
      for (const name of ['report.json', 'results']) {
        const source = path.join(projectDir, '.e2e', name);
        if (existsSync(source)) cpSync(source, path.join(destination, name), {
          recursive: true,
          filter: entry => {
            if (lstatSync(entry).isSymbolicLink()) throw new Error('synthetic evidence symlink refused');
            return true;
          },
        });
      }
      if (outcome !== undefined) writeFileSync(path.join(destination, 'outcome-report.json'), JSON.stringify(outcome.report));
      };
      try { retainEvidence(); } catch (cause) {
        custodyError = cause;
        console.error("CHAIN_EVIDENCE_CUSTODY_FAILED", cause);
      }
    }
  }, 240_000);

  afterAll(async () => {
    const failures: Error[] = [];
    try { project?.cleanup(); } catch (cause) { failures.push(new Error('fixture project cleanup failed', { cause })); }
    try { if (chrome !== undefined) await closeRemoteChrome(chrome); } catch (cause) { failures.push(new Error('Chrome cleanup failed', { cause })); }
    try { await app?.close(); } catch (cause) { failures.push(new Error('fixture app cleanup failed', { cause })); }
    if (failures.length > 0) throw new AggregateError(failures, 'raw selector baseline fixture cleanup failed');
  });

  it('records all four syntax and capture outcomes without asserting taxonomy', () => {
    expect(custodyError).toBeUndefined();
    expect(outcome).toBeDefined();
    expect(outcome!.results).toHaveLength(1);
    expect(outcome!.results.map(result => result.test.title)).toEqual(['public chain syntax observation without guessed taxonomy']);
    expect(outcome!.results.map(result => result.status), JSON.stringify(outcome!.report)).toEqual(['passed']);
    expect(records.map(record => record.id)).toEqual(['css-syntax', 'xpath-syntax', 'empty-chain-tail', 'non-final-capture']);
    expect(records).toEqual([
      ...[
        ['css-syntax', 'css=['],
        ['xpath-syntax', 'xpath=//*['],
        ['empty-chain-tail', 'div >>'],
      ].map(([id, selector]) => ({ id, selector, action: 'locator.count', expectation: 'observation-only', result: {
        kind: 'error', stage: 'count', name: 'E2EError', category: 'infrastructure', code: 'ENGINE_FAILURE', retryable: false,
        causeName: 'EngineError', causeCode: 'ENGINE_FAILURE', causeRetryable: false,
      } })),
      { id: 'non-final-capture', selector: '*css=ul >> li', action: 'locator.count', expectation: 'observation-only', result: {
        kind: 'error', stage: 'count', name: 'TestError', category: 'test', code: 'INVALID_LOCATOR', retryable: false,
        causeName: null, causeCode: null, causeRetryable: null,
      } },
    ]);
    expect(outcome!.report.run.errors).toEqual([]);
  });
});
