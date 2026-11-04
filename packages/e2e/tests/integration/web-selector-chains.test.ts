import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExistingWithConfigFile, workerConfigSource, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = String.raw`import { appendFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('selector chains retain ordered positions, captures, XPath and action targets', async ({ app, browser }) => {
  await app.open('/about');
  await browser.evaluate(() => {
    document.body.innerHTML = '<main id="chain"><section><ul><li>zero</li><li>one</li></ul></section><section><ul><li>two</li><li>three</li></ul></section></main>';
    const button = document.createElement('button');
    button.textContent = 'choose';
    button.onclick = () => { button.textContent = 'chosen'; };
    document.querySelectorAll('li')[3]!.append(button);
    return null;
  });
  expect(await browser.locator('css=#chain >> css=section >> *css=li').count()).toBe(4);
  expect(await browser.locator('#chain >> section >> nth=1 >> li >> nth=0').textContent()).toBe('two');
  expect(await browser.locator('#chain >> li >> nth=-2').textContent()).toBe('two');
  expect(await browser.locator('#chain >> li >> nth=99').count()).toBe(0);
  expect(await browser.locator('#chain >> li >> nth=-99').count()).toBe(0);
  expect(await browser.locator('#chain >> li >> nth=NaN').count()).toBe(0);
  expect(await browser.locator('#chain >> li >> nth=1.5').textContent()).toBe('one');
  expect(await browser.locator('#chain >> section >> nth=0 >> xpath=//li >> nth=-1').textContent()).toBe('one');
  expect(await browser.locator('(//section)[2] >> xpath=.//li >> nth=0').textContent()).toBe('two');
  await browser.locator('#chain >> section >> nth=-1 >> button').tap();
  expect(await browser.locator('#chain >> button').textContent()).toBe('chosen');
  expect(await browser.locator('#chain >> section').filter({ has: browser.locator('ul >> li >> nth=1') }).count()).toBe(2);
});

test('quoted and escaped chain delimiters remain selector bodies', async ({ app, browser }) => {
  await app.open('/about');
  await browser.evaluate(() => {
    document.body.innerHTML = '<div><span>quoted</span></div>';
    document.querySelector('div')!.setAttribute('data-chain', 'a" >> 日本');
    return null;
  });
  expect(await browser.locator('css=[data-chain="a\\\" >> 日本"] >> *css=span').textContent()).toBe('quoted');
  expect(await browser.locator("[data-chain='a\" >> 日本'] >> span").textContent()).toBe('quoted');
});

test('CSS chains pierce open roots but never closed roots', async ({ app, browser }) => {
  await app.open('/about');
  await browser.evaluate(() => {
    document.body.innerHTML = '<div id="open-chain"></div><div id="closed-chain"></div>';
    for (const mode of ['open', 'closed'] as const) {
      const root = document.getElementById(mode + '-chain')!.attachShadow({ mode });
      const button = document.createElement('button');
      button.textContent = mode;
      button.id = mode + '-chain-button';
      root.append(button);
    }
    return null;
  });
  expect(await browser.locator('#open-chain >> button').textContent()).toBe('open');
  expect(await browser.locator('#closed-chain >> button').count()).toBe(0);
  const light = browser.locator('css:light=button');
  const count = await light.count();
  const output = process.env['E2E_CHAIN_SHADOW_OUTPUT'];
  if (output === undefined) throw new Error('owned chain shadow evidence path required');
  if (!Number.isInteger(count) || count < 0 || count > 8) {
    appendFileSync(output, JSON.stringify({ count, stage: 'count-bound-refused' }) + '\n');
    throw new Error('synthetic shadow count outside bounded range');
  }
  const ids: Array<string | null> = [];
  for (let index = 0; index < count; index++) ids.push(await light.nth(index).getAttribute('id'));
  const facts = await browser.evaluate(() => ({
    closedRootExposed: document.getElementById('closed-chain')!.shadowRoot !== null,
    openRootPresent: document.getElementById('open-chain')!.shadowRoot !== null,
    lightButtons: Array.from(document.querySelectorAll('button')).slice(0, 8).map(button => ({
      id: button.id || null, lateArrival: button.id === '' && button.textContent === 'Late arrival',
    })),
  }));
  appendFileSync(output, JSON.stringify({ selector: 'css:light=button', count, ids, facts }) + '\n');
  expect(count).toBe(0);
});

test('syntax and non-final capture failures keep the public error class', async ({ app, browser }) => {
  await app.open();
  for (const [selector, expectedCode] of [
    ['css=[', 'ENGINE_FAILURE'],
    ['xpath=//*[', 'ENGINE_FAILURE'],
    ['div >>', 'ENGINE_FAILURE'],
    ['*css=ul >> li', 'INVALID_LOCATOR'],
  ] as const) {
    let code = 'no error';
    try { await browser.locator(selector).count(); } catch (error) { code = error.code; }
    expect(code).toBe(expectedCode);
  }
});
`;

describe('native web selector-chain compatibility', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let custodyError: unknown;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/chains.e2e.ts': SUITE, 'e2e.config.ts': workerConfigSource(1, "\n  cache: 'off',") });
    const output = path.join(project.dir, 'chain-shadow.jsonl');
    writeFileSync(output, '');
    const previousOutput = process.env['E2E_CHAIN_SHADOW_OUTPUT'];
    process.env['E2E_CHAIN_SHADOW_OUTPUT'] = output;
    try { outcome = await runExistingWithConfigFile(project, { appUrl: app.url }); }
    finally {
      if (previousOutput === undefined) delete process.env['E2E_CHAIN_SHADOW_OUTPUT'];
      else process.env['E2E_CHAIN_SHADOW_OUTPUT'] = previousOutput;
      console.log('CHAIN_SHADOW_RECORDS', readFileSync(output, 'utf8'));
      const projectDir = project.dir;
      const retainEvidence = () => {
      // Copy only this synthetic project's report and attempt artifacts before cleanup.
      const evidenceRoot = process.env['E2E_CHAIN_EVIDENCE_DIR'];
      if (evidenceRoot === undefined || !path.isAbsolute(evidenceRoot)) throw new Error('absolute chain evidence directory required');
      const destination = path.join(evidenceRoot, 'shadow');
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

  afterAll(async () => { project?.cleanup(); await app?.close(); });

  it('passes the original public locator API on the native runtime', () => {
    expect(custodyError).toBeUndefined();
    expect(outcome.results).toHaveLength(4);
    expect(outcome.results.map(result => result.status), JSON.stringify(outcome.report)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(outcome.report.run.errors).toEqual([]);
  });
});
