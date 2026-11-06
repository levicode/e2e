/**
 * The writable half of the model path: add the configured label to the
 * configured account, assert it, remove it, and assert the account is back to
 * the state the run found.
 *
 * The model decides every UI action; this test owns only the deterministic
 * proof around them. It reads the same endpoint the edit dialog reads, so the
 * assertion does not depend on how the page renders a tag. `retries: 0` and no
 * repair here mean a wrong model decision stays in the report instead of being
 * retried away; `finally` restores the account's binding to its baseline so a
 * half-finished run does not leave the environment changed.
 */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { accountHasLabel, parseAccountLabelState, type AccountLabelState } from '../src/account-labels.ts';
import { waitForHome } from '../src/app-location.ts';
import { SCENARIO_INSTRUCTION } from '../src/scenario.ts';
import { loadUatSettings } from '../src/settings.ts';

const settings = loadUatSettings({ requireAccountId: true, requireLabel: true });
const accountId = required(settings.accountId, 'UAT_ACCOUNT_ID');
const labelName = required(settings.labelName, 'UAT_LABEL_NAME');
const labelId = required(settings.labelId, 'UAT_LABEL_ID');

const ACCOUNT_QUERY = /\/account\/label\/query_account\?(?:[^#]*&)?account_id=[^&]+/;
const ADD_INSTRUCTION = `给当前查询到的账号添加标签“${labelName}”，只添加这一个标签，完成后保存。`;
const REMOVE_INSTRUCTION = `从当前账号移除标签“${labelName}”，保留其他标签，完成后保存。`;

test('the model adds then removes the configured account label', { session: 'uat', timeout: 300_000 }, async ({ agent, app, browser, screen }) => {
  await app.open(settings.entryUrl);
  await waitForHome(browser, settings, { foreignOrigin: 'expired', timeoutMs: 20_000 });
  await agent.act(SCENARIO_INSTRUCTION, { params: { accountId } });
  await expect(screen.getByPlaceholder('请输入账号ID')).toHaveValue(accountId);
  const apiBase = await queryAccount(screen, browser);
  const baseline = await readLabelState(browser, apiBase, accountId);
  if (accountHasLabel(baseline, labelId)) {
    throw new Error(`UAT_LABEL_ALREADY_PRESENT: the configured account already carries label ${labelId}; the add/remove loop needs it absent so it can restore the initial state`);
  }

  try {
    await agent.act(ADD_INSTRUCTION, { params: { accountId, labelId } });
    await expectLabel(browser, apiBase, labelId, true);
    await agent.act(REMOVE_INSTRUCTION, { params: { accountId, labelId } });
    await expectLabel(browser, apiBase, labelId, false);
  } finally {
    await restoreBaseline(browser, apiBase, accountId, baseline);
  }
});

/** Queries the account through the page and returns the API base from the response URL. */
async function queryAccount(screen: Screen, browser: Browser): Promise<string> {
  const [waited, tapped] = await Promise.allSettled([
    browser.waitForResponse(ACCOUNT_QUERY, { timeout: 60_000 }),
    screen.getByRole('button', '查询').tap(),
  ]);
  if (tapped.status === 'rejected') throw tapped.reason;
  if (waited.status === 'rejected') throw waited.reason;
  const url = new URL(waited.value.url);
  const marker = '/account/label/query_account';
  const index = url.pathname.indexOf(marker);
  if (index < 0) throw new Error(`UAT_API_SHAPE: the account query answered from ${url.pathname}, not ${marker}`);
  return `${url.origin}${url.pathname.slice(0, index)}`;
}

/** Reads the account's label binding through the endpoint the edit dialog uses. */
async function readLabelState(browser: Browser, apiBase: string, account: string): Promise<AccountLabelState> {
  const body = await browser.evaluate(async (target: string) => {
    const response = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.json() };
  }, `${apiBase}/account/label/query_account/${encodeURIComponent(account)}`);
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (record['status'] !== 200) throw new Error(`UAT_API_FAILED: reading the account label state answered ${String(record['status'])}`);
  const state = parseAccountLabelState(record['body']);
  if (state === undefined) throw new Error('UAT_API_SHAPE: the account label state had no account_id');
  return state;
}

/** Polls the account label state until the configured label is present or absent. */
async function expectLabel(browser: Browser, apiBase: string, label: string, present: boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await readLabelState(browser, apiBase, accountId);
    if (accountHasLabel(state, label) === present) return;
    if (Date.now() >= deadline) {
      throw new Error(
        present
          ? `UAT_LABEL_NOT_ADDED: label ${label} never appeared on the account; the model report above keeps the decision that failed`
          : `UAT_LABEL_NOT_REMOVED: label ${label} is still bound to the account; the model report above keeps the decision that failed`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Restores the binding the run found, whatever the model changed on this one
 * account. This is recovery for a half-finished run, not a retry of the model:
 * the model's failure remains in the report.
 */
async function restoreBaseline(browser: Browser, apiBase: string, account: string, baseline: AccountLabelState): Promise<void> {
  const current = await readLabelState(browser, apiBase, account);
  if (sameIds(current.manual, baseline.manual) && sameIds(current.auto, baseline.auto)) return;
  const result = await browser.evaluate(async ({ target, payload }: { target: string; payload: { account_id: string; manual_mapping_label_ids: readonly string[]; auto_mapping_label_ids: readonly string[] } }) => {
    const response = await fetch(target, {
      method: 'PUT',
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, text: (await response.text()).slice(0, 500) };
  }, {
    target: `${apiBase}/account/label/binding`,
    payload: { account_id: account, manual_mapping_label_ids: baseline.manual, auto_mapping_label_ids: baseline.auto },
  });
  if (result.status !== 200) {
    throw new Error(`UAT_LABEL_RESTORE_FAILED: restoring the account label binding answered ${result.status}; the account may still carry the run's changes`);
  }
  const restored = await readLabelState(browser, apiBase, account);
  if (!sameIds(restored.manual, baseline.manual) || !sameIds(restored.auto, baseline.auto)) {
    throw new Error('UAT_LABEL_RESTORE_FAILED: the account label binding did not read back as the baseline');
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = (ids: readonly string[]): string[] => ids.toSorted();
  const a = sorted(left);
  const b = sorted(right);
  return a.every((id, index) => id === b[index]);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`UAT_CONFIG_MISSING: set ${name} or write it to the private settings file`);
  return value;
}
