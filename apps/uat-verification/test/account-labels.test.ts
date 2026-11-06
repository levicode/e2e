import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountHasLabel, labelRemovalPayload, parseAccountLabelState } from '../src/account-labels.ts';

test('the edit response yields the account and both label lists', () => {
  const state = parseAccountLabelState({
    status: 'success',
    result: { account_id: 40012345, manual_mapping_label_ids: [101, 102], auto_mapping_label_ids: [201] },
  });
  assert.deepEqual(state, { accountId: '40012345', manual: ['101', '102'], auto: ['201'] });
});

test('the legacy label_ids field stands in when the manual list is absent', () => {
  const state = parseAccountLabelState({ result: { account_id: '42', label_ids: ['7'] } });
  assert.deepEqual(state, { accountId: '42', manual: ['7'], auto: [] });
});

test('a response without an account id is not a label state', () => {
  assert.equal(parseAccountLabelState({ result: { manual_mapping_label_ids: [1] } }), undefined);
  assert.equal(parseAccountLabelState(null), undefined);
});

test('presence covers both manual and automatic bindings', () => {
  const state = { accountId: '1', manual: ['10'], auto: ['20'] };
  assert.equal(accountHasLabel(state, '10'), true);
  assert.equal(accountHasLabel(state, '20'), true);
  assert.equal(accountHasLabel(state, '30'), false);
});

test('cleanup removes only the configured label and keeps every other binding', () => {
  const payload = labelRemovalPayload({ accountId: '1', manual: ['10', '11'], auto: ['20'] }, '10');
  assert.deepEqual(payload, { account_id: '1', manual_mapping_label_ids: ['11'], auto_mapping_label_ids: ['20'] });
});
