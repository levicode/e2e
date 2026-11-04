import { appendFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';

test('public chain syntax observation without guessed taxonomy', async ({ app, browser }) => {
  await app.open('/about');
  await browser.evaluate(() => { document.body.innerHTML = '<ul id="syntax-list"><li id="syntax-item">synthetic</li></ul>'; return null; });
  const output = process.env['E2E_CHAIN_SYNTAX_OUTPUT'];
  if (output === undefined) throw new Error('owned syntax evidence path required');
  for (const [id, selector] of [['css-syntax', 'css=['], ['xpath-syntax', 'xpath=//*['], ['empty-chain-tail', 'div >>'], ['non-final-capture', '*css=ul >> li']] as const) {
    let stage = 'locator';
    let result: unknown;
    try {
      const locator = browser.locator(selector);
      stage = 'count';
      const count = await locator.count();
      result = { kind: 'count', count };
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      const error = failure as Error & { category?: unknown; code?: unknown; retryable?: unknown; cause?: { name?: unknown; code?: unknown; retryable?: unknown } };
      result = { kind: 'error', stage, name: error.name, category: error.category ?? null, code: error.code ?? null, retryable: error.retryable ?? null,
        causeName: error.cause?.name ?? null, causeCode: error.cause?.code ?? null, causeRetryable: error.cause?.retryable ?? null };
    }
    appendFileSync(output, JSON.stringify({ id, selector, action: 'locator.count', result, expectation: 'observation-only' }) + '\n');
  }
});
