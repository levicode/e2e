import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProjectWithConfigFile, workerConfigSource, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = String.raw`import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('selector chains retain ordered positions, captures, XPath and action targets', async ({ app, browser }) => {
  await app.open();
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
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<div><span>quoted</span></div>';
    document.querySelector('div')!.setAttribute('data-chain', 'a" >> 日本');
    return null;
  });
  expect(await browser.locator('css=[data-chain="a\\\" >> 日本"] >> *css=span').textContent()).toBe('quoted');
  expect(await browser.locator("[data-chain='a\" >> 日本'] >> span").textContent()).toBe('quoted');
});

test('CSS chains pierce open roots but never closed roots', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<div id="open-chain"></div><div id="closed-chain"></div>';
    for (const mode of ['open', 'closed'] as const) {
      const root = document.getElementById(mode + '-chain')!.attachShadow({ mode });
      const button = document.createElement('button');
      button.textContent = mode;
      root.append(button);
    }
    return null;
  });
  expect(await browser.locator('#open-chain >> button').textContent()).toBe('open');
  expect(await browser.locator('#closed-chain >> button').count()).toBe(0);
  expect(await browser.locator('css:light=button').count()).toBe(0);
});

test('syntax and non-final capture failures keep the public error class', async ({ app, browser }) => {
  await app.open();
  for (const selector of ['css=[', 'xpath=//*[', 'div >>', '*css=ul >> li']) {
    let code = 'no error';
    try { await browser.locator(selector).count(); } catch (error) { code = error.code; }
    expect(code).toBe('INVALID_LOCATOR');
  }
});
`;

describe('native web selector-chain compatibility', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/chains.e2e.ts': SUITE },
      { appUrl: app.url, configSource: workerConfigSource(1, "\n  cache: 'off',") },
    ));
  }, 240_000);

  afterAll(async () => { project?.cleanup(); await app?.close(); });

  it('passes the original public locator API on the native runtime', () => {
    expect(outcome.results).toHaveLength(4);
    expect(outcome.results.map(result => result.status), JSON.stringify(outcome.report)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(outcome.report.run.errors).toEqual([]);
  });
});
