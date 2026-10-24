/** Required coordinated native operation-retirement contract. */
export const CONTINUE_EXACT_OWNER_CAPABILITY = 'operation.continue-exact-owner/1';

/** Optional AST support across browser.query, fixture.query, and fixture.read-fields. */
export const QUERY_UNION_CAPABILITY = 'browser.query-union/1';

/** Full public Web candidate contract. Advertising handlers is not acceptance certification. */
export const REQUIRED_CAPABILITIES = [
  CONTINUE_EXACT_OWNER_CAPABILITY,
  'terminal.close/1',
  'browser.scope/1', 'browser.lifecycle/1', 'browser.evaluate/1', 'browser.page/1',
  'browser.observe/1', 'browser.query/1', 'browser.actions/1', 'browser.network/1',
  'browser.fixture-read-fields/1',
  'browser.dialog/1', 'browser.download/1', 'browser.capture/1', 'browser.state/1',
  'browser.recording/1', 'browser.blobs/1',
] as const;
