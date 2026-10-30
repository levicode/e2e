/** An actual runner fixture context over an in-memory, decoded field engine. */
import { vi } from 'vitest';
import { defineEngine, type EngineFieldValues, type EngineFixtureContext, type EngineReadField, type LocatorExpression, type OperationContext, type SemanticNode } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';

export const expression = { kind: 'selector', selector: '#class-card' } as const;
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
