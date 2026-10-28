/** Diagnostic only: exact original kitchen literal, one selected route case. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { closedFailureDiagnostic } from '../helpers/closed-failure-diagnostic.ts';
import { resultByTitle, runProjectWithConfigFile, workerConfigSource, type FixtureProject } from '../helpers/run-project.ts';

const KITCHEN_SINK = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('deterministic queries and reads', async ({ app, screen, browser }) => {
  await app.open();

  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(screen.getByLabel('Email')).toBeVisible();
  await expect(screen.getByPlaceholder('you@example.test')).toBeVisible();
  await expect(screen.getByText('Item Alpha')).toBeVisible();
  await expect(screen.getByDisplayValue('hello-value')).toBeVisible();
  await expect(screen.getByTestId('items')).toBeVisible();

  await expect(screen.getByTestId('item')).toHaveCount(3);
  await expect(
    screen.getByTestId('item').filter({ hasText: 'Beta' }),
  ).toHaveCount(1);

  const count = await screen.getByTestId('item').count();
  expect(count).toBe(3);

  const items = await screen.getByTestId('item').all();
  const texts: string[] = [];
  for (const item of items) texts.push((await item.textContent()) ?? '');
  expect(texts).toEqual(['Item Alpha', 'Item Beta', 'Item Gamma']);
  expect(await screen.getByTestId('item').allTextContents()).toEqual(texts);
  expect(await screen.getByTestId('missing').all()).toEqual([]);
  await expect(screen.getByTestId('item')).toHaveText(['Item Alpha', /Beta/, 'Item Gamma']);
  await expect(screen.getByTestId('item')).toContainText(['Alpha', 'Beta', 'Gamma']);
  await expect(screen.getByTestId('item')).toContainText(['Alpha', 'Gamma']);
  await expect(screen.getByTestId('item')).not.toContainText(['Gamma', 'Alpha'], { timeout: 200 });
  await expect(screen.getByTestId('item')).not.toHaveText(['Item Alpha', 'Item Beta'], { timeout: 200 });

  expect(await screen.getByTestId('items').getAttribute('class')).toBeNull();
  expect(await browser.locator('#class-card').getAttribute('class')).toBe('card active');
  expect(await screen.getByLabel('Readonly').getAttribute('readonly')).toBe('');
  expect(await browser.locator('#fixture-image').getAttribute('src')).toBe('/fixture.png');
  expect(await browser.locator('#class-card').getAttribute('constructor')).toBe('own');
  expect(await screen.getByTestId('items').getAttribute('constructor')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('toString')).toBeNull();
  expect(await screen.getByTestId('items').getAttribute('__proto__')).toBeNull();
});

test('class assertions report the observed class on failure', async ({ app, browser }) => {
  await app.open();
  try {
    await expect(browser).toHaveClass(browser.locator('#class-card'), 'card inactive', { timeout: 300 });
    throw new Error('toHaveClass unexpectedly passed');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('class "card active"')) throw error;
  }
});

test('a textarea value compares raw', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1\\n\\nline2  ');
  await expect(screen.getByLabel('Notes')).toHaveValue(/^line1\\n\\nline2 {2}$/);
  await expect(screen.getByLabel('Notes')).not.toHaveValue('line1 line2', { timeout: 200 });
});

test('a textarea value is never normalized to match', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByLabel('Notes')).toHaveValue('line1 line2', { timeout: 500 });
});

test('toHaveAttribute reads the value attribute of plain fields', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Plain')).toHaveAttribute('value', 'marker-5e0c');
  await expect(screen.getByLabel('Blank')).not.toHaveAttribute('value', { timeout: 200 });
});

test('toHaveAttribute never judges a secure field', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Secret')).toHaveAttribute('value');
});

test('a negated toHaveAttribute never judges a secure field', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Secret')).not.toHaveAttribute('value');
});

test('a negated toHaveAttribute fails on a plain field that holds the same marker', async ({ app, screen }) => {
  await app.open('/value-attributes');
  await expect(screen.getByLabel('Plain')).not.toHaveAttribute('value', { timeout: 500 });
});

test('secure fields refuse value reads', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill('hunter2');
  await screen.getByLabel('Password').inputValue();
});

test('toHaveValue never judges a secure field', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Password').fill('marker-9b1f');
  await expect(screen.getByLabel('Password')).toHaveValue('');
});

test('toHaveValue reads a plain field that holds the same marker', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Email').fill('marker-9b1f');
  await expect(screen.getByLabel('Email')).toHaveValue('', { timeout: 500 });
});

test('routes are attempt-scoped: registered before the first page, kept across restart and clearState', async ({
  app,
  browser,
  screen,
}) => {
  await browser.route('**/api/flags', (route) => route.fulfill({ json: { betaBoard: true } }));
  await app.open('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.restart();
  await browser.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
  await app.clearState();
  await browser.goto('/flags');
  await expect(screen.getByRole('status', { name: 'Flags' })).toHaveText('beta on');
});

test('evaluate keeps a nested named binding the loader compiled', async ({ app, browser }) => {
  await app.open();
  // A nested named binding survives serialization whatever the loader
  // compiled it to (esbuild keepNames once wrapped it in a \`__name\` helper).
  const total = await browser.evaluate((input: { a: number; b: number }) => {
    const pick = (key: 'a' | 'b') => input[key];
    return pick('a') + pick('b');
  }, { a: 2, b: 40 });
  expect(total).toBe(42);
});

test('reads under an absent frame answer with no match', async ({ app, browser }) => {
  await app.open('/frame');
  const absent = browser.frameLocator('#absent').getByRole('button');
  expect(await absent.count()).toBe(0);
  expect(await absent.all()).toEqual([]);
  expect(await absent.allTextContents()).toEqual([]);
  expect(await absent.isVisible()).toBe(false);
  expect(await absent.isHidden()).toBe(true);
});

test('a nested absent frame counts as zero matches at once', async ({ app, browser }) => {
  await app.open('/frame-nested');
  expect(await browser.frameLocator('#outer').frameLocator('#absent').getByRole('button').count()).toBe(0);
});

test('absence matchers and waits under an absent frame pass at once', async ({ app, browser }) => {
  await app.open('/frame');
  const absent = browser.frameLocator('#absent').getByRole('button');
  await expect(absent).toBeAttached({ attached: false, timeout: 3000 });
  await expect(absent).toBeVisible({ visible: false, timeout: 3000 });
  await expect(absent).toBeHidden({ timeout: 3000 });
  await absent.waitFor({ state: 'detached', timeout: 3000 });
  await absent.waitFor({ state: 'hidden', timeout: 3000 });
});

test('an action under an absent frame polls for the frame until its timeout', async ({ app, browser }) => {
  await app.open('/frame');
  await browser.frameLocator('#absent').getByRole('button').tap({ timeout: 800 });
});

test('downloads are captured as artifacts', async ({ app, browser }) => {
  await app.open('/downloads');
  const download = await browser.waitForDownload(() => browser.locator('a[download]').tap());
  if (download.suggestedFilename !== 'report.csv') throw new Error(download.suggestedFilename);
  if (!download.path.startsWith('downloads/')) throw new Error(download.path);
});

test('clicks hold the modifiers they name', async ({ app, screen, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<button>Pick</button><p role="status"></p>';
    const button = document.querySelector('button')!;
    const status = document.querySelector('p')!;
    const held = (event: MouseEvent) =>
      [event.type, event.shiftKey && 'shift', event.altKey && 'alt', event.ctrlKey && 'ctrl', event.metaKey && 'meta']
        .filter(Boolean)
        .join(' ');
    button.addEventListener('click', (event) => { status.textContent = held(event); });
    button.addEventListener('dblclick', (event) => { status.textContent = held(event); });
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); status.textContent = held(event); });
    return null;
  });
  const pick = screen.getByRole('button', { name: 'Pick' });
  const status = screen.getByRole('status');
  await pick.click({ modifiers: ['Shift'] });
  await expect(status).toHaveText('click shift');
  await pick.doubleTap({ modifiers: ['Alt'] });
  await expect(status).toHaveText('dblclick alt');
  await pick.secondaryTap({ modifiers: ['Shift', 'Control'] });
  await expect(status).toHaveText('contextmenu shift ctrl');
  await pick.tap();
  await expect(status).toHaveText('click');
});

test('a trigger that starts no download times out saying so', async ({ app, browser }) => {
  await app.open('/downloads');
  await browser.waitForDownload(() => new Promise((resolve) => setTimeout(resolve, 200)), { timeout: 500 });
});

test('a viewport set before the first navigation holds through app.open', async ({ app, browser }) => {
  const size = { width: 390, height: 600 };
  await browser.setViewport(size);
  size.width = 1000;
  await app.open();
  const width = await browser.evaluate(() => window.innerWidth);
  if (width !== 390) throw new Error('innerWidth ' + width);
  await app.restart();
  const restarted = await browser.evaluate(() => window.innerWidth);
  if (restarted !== 390) throw new Error('innerWidth after restart ' + restarted);
  await app.clearState();
  await app.open();
  const cleared = await browser.evaluate(() => window.innerWidth);
  if (cleared !== 390) throw new Error('innerWidth after clearState ' + cleared);
});

test('a viewport set before the first navigation opens no page', async ({ screen, browser }) => {
  await browser.setViewport({ width: 390, height: 600 });
  await screen.getByTestId('items').tap({ timeout: 200 });
});

test('a *css= capture is refused before the last selector part', async ({ app, browser }) => {
  await app.open();
  await expect(browser.locator('css=ul[data-testid="items"] >> *css=li')).toHaveCount(3);
  let capture = 'no error';
  try {
    await browser.locator('*css=ul[data-testid="items"] >> li').count();
  } catch (error) {
    capture = (error as Error).message;
  }
  expect(capture).toContain('a selector that captures with * (*css=article >> text=Hello) is not supported');
});

test('forbidden URL schemes are refused', async ({ app }) => {
  await app.open();
  await app.open('javascript:alert(1)');
});

test('a route handler assertion that no step follows', async ({ app, browser }) => {
  await browser.route('**/api/flags.js', async (route) => {
    await route.fulfill({ body: '', contentType: 'text/javascript' });
    expect(route.request.method).toBe('POST');
  });
  await app.open('/script-flags');
});

test('a dialog handler assertion that no step follows', async ({ app, browser, screen }) => {
  await app.open('/dialog');
  await browser.onDialog(async (dialog) => {
    await dialog.accept();
    expect(dialog.message).toBe('Are you sure?');
  });
  await screen.getByRole('button', { name: 'Ask' }).tap();
});

`;

it('diagnoses the unchanged route attempt-scoped consumer', async () => {
  const app = await startFixtureApp();
  let project: FixtureProject | undefined;
  try {
    const result = await runProjectWithConfigFile(
      { 'tests/kitchen.e2e.ts': KITCHEN_SINK },
      {
        appUrl: app.url,
        configSource: workerConfigSource(1, "\n  cache: 'off',\n  actionTimeout: 5_000,\n  assertionTimeout: 4_000,\n  timeout: 30_000,"),
        runOptions: { grep: [/^routes are attempt-scoped: registered before the first page, kept across restart and clearState$/] },
      },
    );
    project = result.project;
    const { outcome } = result;
    const selected = resultByTitle(outcome, 'routes are attempt-scoped: registered before the first page, kept across restart and clearState');
    const receipt = {
      selected: outcome.report.run.summary.selected,
      executed: outcome.report.run.summary.executed,
      selectedResults: outcome.report.run.results.filter(item => item.selected).length,
      status: selected.status,
      closed: JSON.parse(closedFailureDiagnostic(selected.attempts, outcome.report.run.errors)),
    };
    const evidence = process.env['E2E_PLATFORM_ROUTE_EVIDENCE_DIR'];
    if (evidence) writeFileSync(path.join(evidence, 'inner-route-receipt.json'), JSON.stringify(receipt, null, 2));
    console.error('PLATFORM_ROUTE_CLOSED_RECEIPT', JSON.stringify(receipt));
    expect(receipt.selected).toBe(1);
    expect(receipt.executed).toBe(1);
    expect(receipt.selectedResults).toBe(1);
    expect(selected.status, closedFailureDiagnostic(selected.attempts, outcome.report.run.errors)).toBe('passed');
  } finally {
    project?.cleanup();
    await app.close();
  }
}, 240_000);
