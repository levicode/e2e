/** Required coordinated native operation-retirement contract. */
export const CONTINUE_EXACT_OWNER_CAPABILITY = 'operation.continue-exact-owner/1';

/** Explicit reconnect control after a real CDP disconnect, never action replay. */
export const DISCONNECTED_RECOVERY_CAPABILITY = 'scope.reconnect-quarantined/1';

/** Optional AST support across browser.query, fixture.query, and fixture.read-fields. */
export const QUERY_UNION_CAPABILITY = 'browser.query-union/1';

/** Observation and trace apply the scope-configured frame-site policy before traversal. */
export const OBSERVE_FRAME_POLICY_CAPABILITY = 'browser.observe-frame-policy/1';

/** Full public Web candidate contract. Advertising handlers is not acceptance certification. */
export const REQUIRED_CAPABILITIES = [
  CONTINUE_EXACT_OWNER_CAPABILITY,
  DISCONNECTED_RECOVERY_CAPABILITY,
  OBSERVE_FRAME_POLICY_CAPABILITY,
  'terminal.close/1',
  'browser.scope/1', 'browser.lifecycle/1', 'browser.evaluate/1', 'browser.page/1',
  'browser.observe/1', 'browser.query/1', 'browser.actions/1', 'browser.network/1',
  'browser.trace-semantic/1',
  'browser.fixture-read-fields/1',
  'browser.dialog/1', 'browser.download/1', 'browser.capture/1', 'browser.state/1',
  'browser.recording/1', 'browser.blobs/1',
] as const;
