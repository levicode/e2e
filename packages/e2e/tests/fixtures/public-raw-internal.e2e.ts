/** Exact original 40663028464 internal records, now strict on both paired sides. */
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

test('public raw internal: exact original baseline parity', async ({ app, browser }) => {
  await app.open();
  await browser.evaluate(() => {
    document.body.innerHTML = '<section id="one"><span id="a" class="item">Alpha</span><span id="b" class="item">Beta</span></section><section id="two"><span id="c" class="item">Gamma</span></section>';
    return null;
  });
  const nested = (outer: string, engine: string, inner: string): string => `${outer} >> ${engine}=${JSON.stringify(inner)}`;
  await expectRaw(browser, 'internal-has', nested('css=section', 'internal:has', 'css=#a'), ['one']);
  await expectRaw(browser, 'internal-has-not', nested('css=section', 'internal:has-not', 'css=#a'), ['two']);
  await expectRaw(browser, 'internal-and', nested('css=.item', 'internal:and', 'css=#b'), ['b']);
  await expectRaw(browser, 'internal-or-order', nested('css=#c', 'internal:or', 'css=#a'), ['a', 'c']);
  await expectRaw(browser, 'internal-chain', nested('css=#one', 'internal:chain', 'css=.item'), ['a', 'b']);
  await expectRaw(browser, 'internal-malformed-public-observation', 'css=section >> internal:has={"selector":"css=#a"}');
});
