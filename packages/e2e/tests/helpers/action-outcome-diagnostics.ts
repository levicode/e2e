/** Observation-only projection for the original action parity consumers. Never emit arbitrary report strings. */
const CASES: Readonly<Record<string, string>> = {
  'uploads a project file': 'upload',
  'default agent reads the second view': 'delayed-action-diff',
  'drags the card onto the done column': 'drag',
  'hovers a bare point in the screenshot': 'point-hover',
  'types into a listed widget the engine cannot fill': 'keyboard-fallback',
  'refuses focused typing when nothing editable has focus': 'keyboard-no-focus',
};
const STATUSES = ['passed', 'failed', 'flaky', 'timed-out', 'interrupted', 'skipped', 'blocked', 'cancelled', 'complete', 'forced'];
const KINDS = ['agent', 'locator', 'assertion', 'screen', 'app', 'session', 'resource', 'poll', 'observation', 'model', 'policy', 'engine', 'schema', 'navigation'];
const TOOLS = ['dragTo', 'setInputFiles', 'screenshot', 'hover', 'hover_at', 'tap', 'tap_at', 'drag', 'upload', 'type', 'type_at', 'typeText', 'press', 'check', 'scroll', 'scroll_to', 'complete_step', 'observe', 'relocate', 'page'];
const APIS = ['agent.act', 'expect.toBeVisible', 'expect.toHaveText', 'expect.toBeChecked', 'browser.goto', 'screen.navigate'];
const CODES = ['ASSERTION_FAILED', 'LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS', 'ACTION_FAILED', 'NOT_ACTIONABLE', 'ACTION_MAY_HAVE_COMMITTED', 'NODE_STALE', 'OPERATION_TIMEOUT', 'ENGINE_FAILURE', 'POLICY_DENIED', 'INVALID_STATE', 'CANCELLED', 'EXPECT_FAILED', 'AGENT_FAILED', 'AGENT_TIMEOUT', 'STEP_TIMEOUT', 'TEST_TIMEOUT', 'PIXEL_TAINTED', 'INVALID_ARGUMENT'];
const NATIVE_REASONS = ['fill-unsupported-target', 'no-editable-focus', 'not-actionable', 'stale-reference', 'deadline-exceeded', 'browser-failure', 'cleanup-failed', 'stale-scope', 'scope-unavailable', 'invalid-arguments', 'policy-denied', 'intercepted-pointer'];
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];
const token = (value: unknown, allowed: readonly string[]): string | undefined => value === undefined ? undefined : typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
const duration = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000 ? Math.round(value) : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;

/** Extract closed labels only; no substrings, messages, paths, selectors, or opaque identities leave this projection. */
function reason(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const text = value.substring(0, 16_384);
  const facts = [...CODES, ...NATIVE_REASONS].filter(code => text.includes(code));
  if (text.includes('outcome is unknown') || text.includes('action may have committed')) facts.push('unknown-effects');
  if (text.includes('not an input') || text.includes('not editable')) facts.push('unsupported-fill');
  if (text.includes('nothing that takes keystrokes has focus')) facts.push('no-key-receiver');
  if (text.includes('nothing the screen lists is at')) facts.push('no-listed-point-target');
  if (text.includes('Screen changes since revision')) facts.push('screen-diff');
  if (text.includes('Current screen')) facts.push('full-screen');
  if (text.includes('had no visible effect')) facts.push('no-visible-effect');
  return facts.length === 0 ? ['unknown'] : [...new Set(facts)];
}
function error(value: unknown) {
  const item = object(value);
  return { code: token(item['code'], CODES), reason: reason(item['message']) };
}
function tool(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return TOOLS.find(name => value === name || value.startsWith(`${name}(`)) ?? 'unknown';
}

/** Bounded closed rows from known fixtures only; called after run, never during execution or settlement. */
export function actionOutcomeDiagnostics(outcome: unknown): readonly unknown[] {
  return list(object(outcome)['results'], 256).flatMap(resultValue => {
    const result = object(resultValue);
    const title = object(result['test'])['title'];
    const id = typeof title === 'string' && Object.hasOwn(CASES, title) ? CASES[title] : undefined;
    if (id === undefined) return [];
    return [{
      case: id, status: token(result['status'], STATUSES),
      attempts: list(result['attempts'], 4).map(attemptValue => {
        const attempt = object(attemptValue);
        return {
          status: token(attempt['status'], STATUSES), cleanup: token(attempt['cleanup'], STATUSES), error: error(attempt['error']),
          steps: list(attempt['steps'], 32).map(stepValue => {
            const step = object(stepValue);
            const cache = object(step['cache']);
            return {
              kind: token(step['kind'], KINDS), api: token(step['api'], APIS), status: token(step['status'], STATUSES), error: error(step['error']),
              durationMs: duration(step['durationMs']), modelCalls: count(object(step['metrics'])['modelCalls']),
              cache: { mode: token(cache['mode'], ['self-finalized', 'agent-concluded', 'missed']), replayedActions: count(cache['replayedActions']), totalActions: count(cache['totalActions']), detail: reason(cache['detail']) },
              events: list(step['events'], 128).map(eventValue => {
                const event = object(eventValue);
                return { durationMs: duration(event['durationMs']), kind: token(event['kind'], KINDS), name: tool(event['name']), status: token(event['status'], STATUSES), code: token(event['code'], CODES), reason: reason(event['detail']) };
              }),
              turns: list(step['turns'], 32).map(turnValue => {
                const turn = object(turnValue);
                return { tools: list(turn['calls'], 16).map(tool), reason: reason(turn['outcome']), image: typeof turn['outcome'] === 'string' && turn['outcome'].includes('"type":"file"') };
              }),
            };
          }),
        };
      }),
    }];
  });
}
