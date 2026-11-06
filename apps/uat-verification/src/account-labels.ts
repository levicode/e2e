/**
 * The label binding the account-label page's own edit dialog reads and writes.
 *
 * The writable UAT path needs a closed loop around exactly one account and one
 * label: read the account's current manual/auto label ids, assert the label's
 * presence, and restore the original state if a step fails part-way. The page
 * exposes that through its own endpoints, and these helpers keep the parsing
 * and the cleanup payload in one testable place. They never name an account or
 * a label themselves; the caller passes the private settings values.
 */

/** One account's label binding, as the edit dialog fetches it. */
export interface AccountLabelState {
  readonly accountId: string;
  /** Labels a person assigns in the edit dialog's 手动打标 section. */
  readonly manual: readonly string[];
  /** Labels the automation rules assign in 自动打标; never written by this loop. */
  readonly auto: readonly string[];
}

/** Parses the edit dialog's `query_account/<id>` response, or nothing when it is not one. */
export function parseAccountLabelState(body: unknown): AccountLabelState | undefined {
  const result = record(record(body)['result']);
  const accountId = idString(result['account_id']);
  if (accountId === undefined) return undefined;
  return {
    accountId,
    manual: idList(result['manual_mapping_label_ids']) ?? idList(result['label_ids']) ?? [],
    auto: idList(result['auto_mapping_label_ids']) ?? [],
  };
}

/** True when the label is bound manually or automatically; a clean loop starts absent. */
export function accountHasLabel(state: AccountLabelState, labelId: string): boolean {
  return state.manual.includes(labelId) || state.auto.includes(labelId);
}

/**
 * The PUT `/account/label/binding` body that removes the label from the manual
 * list and leaves every other binding untouched, so a failed run restores the
 * state it found.
 */
export function labelRemovalPayload(
  state: AccountLabelState,
  labelId: string,
): { account_id: string; manual_mapping_label_ids: readonly string[]; auto_mapping_label_ids: readonly string[] } {
  return {
    account_id: state.accountId,
    manual_mapping_label_ids: state.manual.filter(id => id !== labelId),
    auto_mapping_label_ids: state.auto,
  };
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    const id = idString(entry);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
