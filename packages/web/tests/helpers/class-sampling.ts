/** Test-only runner boundary: use the same built e2e instance as the browser source. */
/** An actual runner fixture context over an in-memory, decoded field engine. */
import { afterEach, beforeEach, vi } from 'vitest';
import { defineEngine, type EngineFieldValues, type EngineFixtureContext, type EngineReadField, type LocatorExpression, type OperationContext, type SemanticNode } from 'e2e/engine';
import { createEngineSession } from '../../../e2e/dist/engine/session.js';
import { resolveConfig } from '../../../e2e/dist/config/resolve.js';
import { Deadline } from '../../../e2e/dist/internal/time.js';
import { AttemptBudget } from '../../../e2e/dist/run/budget.js';
import { createFixtures } from '../../../e2e/dist/run/fixtures.js';
import { StepRecorder } from '../../../e2e/dist/run/steps.js';
import { WorkerModels } from '../../../e2e/dist/run/worker-models.js';

const expression = { kind: 'selector', selector: '#class-card' } as const;
export const fields = (attributes: Record<string, string> = { class: 'card active' }): EngineFieldValues => ({ attributes, states: { secure: false } });
type Values = (operation: OperationContext) => readonly EngineFieldValues[] | Promise<readonly EngineFieldValues[]>;
export function samplingFixture(values: Values, options: { capability?: boolean; budgetMs?: number; legacy?: readonly SemanticNode[] } = {}) {
  const controller = new AbortController();
  const budget = new AttemptBudget(controller.signal, new Deadline(options.budgetMs ?? 10_000));
  let context!: EngineFixtureContext;
  const locate = vi.fn(async () => options.legacy ?? [{ ref: { id: 'field', revision: '1' }, attributes: { class: 'legacy' }, states: { secure: false } }]);
  const readFields = vi.fn(async (_expression: LocatorExpression, _fields: readonly EngineReadField[], operation: OperationContext) => values(operation));
  const observe = vi.fn(async () => ({ identityScope: 'scope', root: { ref: { id: 'root', revision: '1' } }, viewport: { width: 10, height: 10 } }));
  const engine = defineEngine({ name: 'sample', version: '1', spiVersion: 1, referenceRevisions: 'engine', observe, locate,
    ...(options.capability === false ? {} : { readFields }),
    fixtures: { probe: provided => { context = provided; return provided.fixture('probe', {}, {}); } },
  });
  const config = resolveConfig({ targets: [{ name: 'same-name', platform: 'custom', engine }], actionTimeout: 5_000, assertionTimeout: 1_000, cache: 'off' }, { projectRoot: process.cwd(), env: {} });
  const steps = new StepRecorder('attempt');
  const session = createEngineSession({ engine, targetName: 'same-name' });
  const read = vi.spyOn(session, 'read');
  const { fixtures } = createFixtures({ config, target: config.targets[0]!, session, steps, budget, runId: 'run', attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal: controller.signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'unused', link: () => 'unused' }, priorSteps: () => steps.completed(),
    agentContext: undefined, saveSession: undefined, models: new WorkerModels(() => {}),
  });
  void (fixtures as unknown as { probe: object }).probe;
  const target = context.locator(expression);
  return { context, target, controller, budget, locate, readFields, observe, read, session, steps };
}


/**
 * Runs every test in the calling file on fake timers that advance on their own
 * whenever the test awaits, so retry budgets, poll intervals, and negation
 * grace periods elapse instantly. `Date` and `performance` move with the
 * clock, so elapsed-time assertions still measure what the product waited.
 */
export function useFakeTime(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
