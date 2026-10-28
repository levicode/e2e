/** Exact original 40663028464 CSS records, now strict on both paired sides. */
import { appendFileSync } from 'node:fs';
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
  const output = process.env['E2E_RAW_CSS_PAIR_OUTPUT'];
  if (output === undefined) throw new Error('owned CSS pair evidence path required');
  const count = await locator.count();
  if (!Number.isInteger(count) || count < 0 || count > 8) {
    appendFileSync(output, `${JSON.stringify({ id, count, stage: 'count-bound-refused' })}\n`);
    throw new Error('synthetic CSS fixture count outside bounded range');
  }
  const ids: Array<string | null> = [];
  for (let index = 0; index < count; index++) ids.push(await locator.nth(index).getAttribute('id'));
  const visibilityFacts = id === 'css-visible' ? await browser.evaluate(() =>
    Array.from(document.querySelectorAll('button')).slice(0, 8).map(button => {
      const rect = button.getBoundingClientRect();
      return { id: button.id || null, displayNone: getComputedStyle(button).display === 'none',
        positiveBox: rect.width > 0 && rect.height > 0,
        lateArrival: button.id === '' && button.textContent === 'Late arrival' };
    })) : null;
  // Record exact ordered synthetic IDs before assertions, including a mismatch.
  appendFileSync(output, `${JSON.stringify({ id, count, ids, visibilityFacts })}\n`);
  expect({ id, count }).toEqual({ id, count: expectedIds.length });
  expect({ id, ids }).toEqual({ id, ids: expectedIds });
}

test('public raw CSS: exact original baseline parity', async ({ app, browser }) => {
  // Static route: Home has a 400ms timer that survives body.innerHTML replacement.
  await app.open('/about');
  await browser.evaluate(() => {
    document.body.innerHTML = '<section><div class="row" id="css-a">Alpha <span>Beta</span></div><div class="row" id="css-b">Alpha Beta</div><button id="css-shown">Save</button><button id="css-hidden" style="display:none">Save</button></section>';
    return null;
  });
  await expectRaw(browser, 'css-has-text', 'css=.row:has-text("Alpha")', ['css-a', 'css-b']);
  await expectRaw(browser, 'css-text', 'css=.row:text("Alpha")', ['css-a', 'css-b']);
  await expectRaw(browser, 'css-text-is', 'css=.row:text-is("Alpha Beta")', ['css-b']);
  await expectRaw(browser, 'css-text-matches', 'css=.row:text-matches("^Alpha Beta$")', ['css-a', 'css-b']);
  await expectRaw(browser, 'css-visible', 'css=button:visible', ['css-shown']);
  await expectRaw(browser, 'css-nth-match', 'css=:nth-match(.row, 2)', ['css-b']);
});
