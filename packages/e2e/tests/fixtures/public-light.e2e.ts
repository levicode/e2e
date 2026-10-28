/** Run unchanged against e557 Playwright and the exact native candidate. */
import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';

const ENGINES = ['id:light', 'data-testid:light', 'data-test-id:light', 'data-test:light', 'xpath:light'] as const;
type Engine = (typeof ENGINES)[number];
function selector(engine: Engine, value: string): string {
  return engine === 'xpath:light' ? `xpath:light=//*[@data-probe="${value}"]` : `${engine}=${value}`;
}

async function fixture(browser: Browser): Promise<void> {
  await browser.evaluate(() => {
    const mark = (element: Element, name: string): void => {
      for (const attribute of ['id', 'data-testid', 'data-test-id', 'data-test', 'data-probe']) element.setAttribute(attribute, name);
    };
    document.body.replaceChildren();
    const scope = document.createElement('section'); mark(scope, 'scope');
    const row = document.createElement('div'); mark(row, 'row'); row.textContent = 'ordinary row';
    const field = document.createElement('input'); mark(field, 'field'); field.value = 'actual'; field.setAttribute('aria-label', 'Label');
    const select = document.createElement('select'); mark(select, 'select'); select.setAttribute('aria-label', 'Choice');
    const option = document.createElement('option'); mark(option, 'option'); option.value = 'pick'; option.textContent = 'Pick'; option.selected = true;
    select.append(option); scope.append(row, field, select);
    const hit = document.createElement('div'); mark(hit, 'hit'); hit.textContent = 'ordinary hit';
    document.body.append(scope, hit);
    return null;
  });
}

async function count(label: string, read: () => Promise<number>, expected: number): Promise<void> {
  expect({ label, count: await read() }).toEqual({ label, count: expected });
}

async function rejected(
  label: string,
  read: () => Promise<number>,
  expected = { category: 'infrastructure', code: 'ENGINE_FAILURE', causeCode: 'ENGINE_FAILURE', causeRetryable: false },
): Promise<void> {
  let failure: unknown;
  try { await read(); } catch (cause) { failure = cause; }
  if (!(failure instanceof Error)) throw new Error(`${label}: expected a public error, received ${String(failure)}`);
  const error = failure as Error & { category?: unknown; code?: unknown; retryable?: unknown };
  if (!(error.cause instanceof Error)) throw new Error(`${label}: public error lost its engine cause`);
  const cause = error.cause as Error & { code?: unknown; retryable?: unknown };
  expect({ label, category: error.category, code: error.code, retryable: error.retryable, causeCode: cause.code, causeRetryable: cause.retryable })
    .toEqual({ label, ...expected, retryable: false });
}

for (const engine of ENGINES) {
  test(`public light projection: ${engine}`, async ({ app, browser }) => {
    await app.open(); await fixture(browser);
    const light = (value: string) => browser.locator(selector(engine, value));
    const cssScope = browser.locator('#scope');
    await rejected('ordinary hit', () => light('row').count());
    await count('ordinary empty', () => light('absent').count(), 0);
    await count('inline nth empty', () => browser.locator(`${selector(engine, 'row')} >> nth=99`).count(), 0);
    await count('outer nth empty', () => light('row').nth(99).count(), 0);
    await count('inline hasText removes hit', () => light('row').filter({ hasText: 'absent' }).count(), 0);
    await rejected('left light miss with right hit', () => light('absent').or(browser.locator('#hit')).count());
    await count('right light hit remains nested', () => browser.locator('#absent').or(light('row')).count(), 1);
    await rejected('inner has hit', () => cssScope.filter({ has: light('row') }).count());
    await count('inner has miss', () => cssScope.filter({ has: light('absent') }).count(), 0);
    await rejected('inner has precedes outer empty nth', () => cssScope.filter({ has: light('row') }).nth(99).count());
    await count('scope alone is not a public boundary', () => light('scope').getByLabel('Absent', { exact: true }).count(), 0);
    await rejected('displayValue raw candidates precede value miss', () => light('scope').getByDisplayValue('absent', { exact: true }).count());
    await rejected('exact label position is deferred', () => light('scope').getByLabel('Label', { exact: true }).nth(99).count());
    await rejected('late hasText is deferred', () => light('scope').getByLabel('Label', { exact: true }).first().filter({ hasText: 'absent' }).count());
    await count('early hasText empties raw projection', () => light('scope').getByLabel('Label', { exact: true }).filter({ hasText: 'absent' }).first().count(), 0);
    await rejected('deferred has is a public count boundary', () => cssScope.getByDisplayValue('pick', { exact: true }).first().filter({ has: light('option') }).count());
    await count('empty deferred index skips has', () => cssScope.getByDisplayValue('pick', { exact: true }).nth(99).filter({ has: light('option') }).count(), 0);
    await rejected('inline has runs before value predicate', () => cssScope.getByDisplayValue('absent', { exact: true }).filter({ has: light('option') }).count());
    await count('post-position has skips value miss', () => cssScope.getByDisplayValue('absent', { exact: true }).first().filter({ has: light('option') }).count(), 0);
    await count('css:light is not deprecated', () => browser.locator('css:light=#hit').count(), 1);
    await count('ordinary query still works after refusals', () => browser.locator('#row').count(), 1);
  });
}

test('public light projection: open and closed shadow boundaries', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  await browser.evaluate(() => {
    const mark = (element: Element, name: string): void => {
      for (const attribute of ['id', 'data-testid', 'data-test-id', 'data-test', 'data-probe']) element.setAttribute(attribute, name);
    };
    for (const mode of ['open', 'closed'] as const) {
      const host = document.createElement('div'); mark(host, `${mode}-host`); document.body.append(host);
      const root = host.attachShadow({ mode });
      const input = document.createElement('input'); mark(input, `${mode}-row`); input.setAttribute('aria-label', `${mode} label`); root.append(input);
    }
    return null;
  });
  for (const engine of ENGINES) {
    await count(`${engine} cannot pierce open root`, () => browser.locator(selector(engine, 'open-row')).count(), 0);
    await count(`${engine} cannot pierce closed root`, () => browser.locator(selector(engine, 'closed-row')).count(), 0);
    await rejected(`${engine} closed semantic child has raw match before deferred nth`, () => browser.locator(selector(engine, 'closed-host')).getByLabel('closed label', { exact: true }).nth(99).count());
    const ordinary = selector(engine, 'open-row').replace(':light=', '=');
    await count(`${engine} ordinary engine keeps its own piercing rule`, () => browser.locator(ordinary).count(), engine === 'xpath:light' ? 0 : 1);
  }
  await count('css:light excludes open root content', () => browser.locator('css:light=#open-row').count(), 0);
  await count('css pierces open root', () => browser.locator('css=#open-row').count(), 1);
  await count('css excludes closed root', () => browser.locator('css=#closed-row').count(), 0);
});

test('public light projection: frame owner and inner document boundaries', async ({ app, browser }) => {
  await app.open(); await fixture(browser);
  await browser.evaluate(async () => {
    const frame = document.createElement('iframe');
    for (const attribute of ['id', 'data-testid', 'data-test-id', 'data-test', 'data-probe']) frame.setAttribute(attribute, 'frame');
    frame.srcdoc = '<!doctype html><html><body><div id="inside" data-testid="inside" data-test-id="inside" data-test="inside" data-probe="inside">ordinary frame row</div></body></html>';
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture frame load timed out')), 10_000);
      frame.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    document.body.append(frame); await loaded; return null;
  });
  await count('ordinary frame is ready', () => browser.frameLocator('#frame').locator('#inside').count(), 1);
  for (const engine of ENGINES) {
    await rejected(`${engine} frame owner count is checked`, () => browser.frameLocator(selector(engine, 'frame')).locator('#inside').count());
    await rejected(`${engine} inner frame result is checked`, () => browser.frameLocator('#frame').locator(selector(engine, 'inside')).count());
    await count(`${engine} inner frame miss remains empty`, () => browser.frameLocator('#frame').locator(selector(engine, 'absent')).count(), 0);
    await rejected(`${engine} empty owner keeps frame-not-found taxonomy`, () => browser.frameLocator(selector(engine, 'absent')).locator('#inside').count(), {
      category: 'test', code: 'LOCATOR_NOT_FOUND', causeCode: 'FRAME_NOT_FOUND', causeRetryable: true,
    });
  }
  await count('css:light frame owner and child remain supported', () => browser.frameLocator('css:light=#frame').locator('css:light=#inside').count(), 1);
});
