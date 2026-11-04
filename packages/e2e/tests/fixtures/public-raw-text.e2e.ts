/** Exact original 40663028464 text records, now strict on both paired sides. */
import { test, type Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
async function expectRaw(browser: Browser, id: string, selector: string, expectedIds?: string[]): Promise<void> {
  const locator = browser.locator(selector);
  if (expectedIds === undefined) {
    let failure: unknown;
    try { await locator.count(); } catch (cause) { failure = cause; }
    if (!(failure instanceof Error)) throw new Error(`${id}: expected count-stage public failure`);
    const error = failure as Error & { category?: unknown; code?: unknown; retryable?: unknown };
    if (!(error.cause instanceof Error)) throw new Error(`${id}: engine cause is missing`);
    const cause = error.cause as Error & { code?: unknown; retryable?: unknown };
    expect({ id, name: error.name, category: error.category, code: error.code, retryable: error.retryable, causeCode: cause.code, causeRetryable: cause.retryable })
      .toEqual({ id, name: 'E2EError', category: 'infrastructure', code: 'ENGINE_FAILURE', retryable: false, causeCode: 'ENGINE_FAILURE', causeRetryable: false });
    return;
  }
  const count = await locator.count();
  expect({ id, count }).toEqual({ id, count: expectedIds.length });
  const ids: Array<string | null> = [];
  for (let index = 0; index < count; index++) ids.push(await locator.nth(index).getAttribute('id'));
  expect({ id, ids }).toEqual({ id, ids: expectedIds });
}

test('public raw text: exact original baseline parity', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<section><div id="text-a">Alpha   Beta</div><div id="text-b">Alpha <span id="text-child">Beta</span></div><div id="text-gamma">Gamma</div></section>';
    return null;
  });
  await expectRaw(browser, 'text-lax', 'text=alpha beta', ['text-a', 'text-b']);
  await expectRaw(browser, 'text-exact-immediate', 'text="Alpha Beta"', ['text-a']);
  await expectRaw(browser, 'text-regexp-full', 'text=/^Alpha\\s+Beta$/', ['text-a', 'text-b']);
  await expectRaw(browser, 'text-implicit-quoted', '"Alpha Beta"', ['text-a']);
  await expectRaw(browser, 'text-element-root', 'css=#text-a >> text=Alpha', ['text-a']);
  await expectRaw(browser, 'text-light-public-observation', 'text:light=Gamma');
});
