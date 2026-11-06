/**
 * The fixed UAT scenario: home → 账号管理 → 账号标签管理 → the account ID field
 * → 查询, read-only. The scripted executor (`src/scenario.ts`) walks it through
 * the agent step path; this test only checks the read the scenario asks for:
 * the account ID reached its field and the 查询 response is the app's success
 * envelope. No business write happens, and nothing private is asserted into the
 * report.
 */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { waitForHome } from '../src/app-location.ts';
import { SCENARIO_INSTRUCTION } from '../src/scenario.ts';
import { loadUatSettings } from '../src/settings.ts';

const settings = loadUatSettings({ requireAccountId: true });
const accountId = settings.accountId;
if (accountId === undefined) throw new Error('UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID or write accountId to the private settings file');

/**
 * The page's own account query, with a nonempty account ID: the page's first
 * load still queries with an empty one, and the waiting step's label must not
 * carry the configured ID.
 */
const QUERY_REQUEST = /\/account\/label\/query_account\?(?:[^#]*&)?account_id=[^&]+/;

test('account label page queries the configured account read-only', { session: 'uat', timeout: 150_000 }, async ({ agent, app, browser, screen }) => {
  // A restored session carries cookies and storage, not a page: open the app entry in this attempt.
  await app.open(settings.entryUrl);
  await waitForHome(browser, settings, { foreignOrigin: 'expired', timeoutMs: 20_000 });
  await agent.act(SCENARIO_INSTRUCTION);
  await expect(screen.getByPlaceholder('请输入账号ID')).toHaveValue(accountId);
  // The scenario's own 查询 is the fixed path; this awaited second query is what
  // makes the read itself deterministic in the report.
  const [waited, tapped] = await Promise.allSettled([
    browser.waitForResponse(QUERY_REQUEST, { timeout: 60_000 }),
    screen.getByRole('button', '查询').tap(),
  ]);
  if (tapped.status === 'rejected') throw tapped.reason;
  if (waited.status === 'rejected') throw waited.reason;
  const response = waited.value;
  // The one request this attempt must see is the query for the configured account.
  if (new URL(response.url).searchParams.get('account_id') !== accountId) {
    throw new Error('UAT_SCENARIO_ACCOUNT_MISMATCH: the query did not name the configured account');
  }
  expect(response.status).toBe(200);
  const body = await response.json<{ result?: { data?: unknown; total_count?: unknown } }>();
  expect(Array.isArray(body.result?.data)).toBe(true);
  expect(typeof body.result?.total_count).toBe('number');
});
