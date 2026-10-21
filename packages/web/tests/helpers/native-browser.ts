/** Public fixture setup for integration tests, never a replacement backend or Page handle. */
import type { EngineHandle, OperationContext } from 'e2e/engine';
import { resolveConfig } from '../../../e2e/dist/config/resolve.js';
import { createEngineSession } from '../../../e2e/dist/engine/session.js';
import { Deadline } from '../../../e2e/dist/internal/time.js';
import { AttemptBudget } from '../../../e2e/dist/run/budget.js';
import { createFixtures } from '../../../e2e/dist/run/fixtures.js';
import { StepRecorder } from '../../../e2e/dist/run/steps.js';
import { WorkerModels } from '../../../e2e/dist/run/worker-models.js';
import type { Browser } from '../../src/index.ts';

/**
 * Test-only real core fixture graph over the already-started public engine.
 * These callers provide stable attempt fields. The graph has a bounded 30s
 * helper lifetime; each action uses the caller's initial per-action timeout.
 * No fabricated EngineFixtureContext or replacement locator implementation.
 */
export function nativeBrowser(engine: EngineHandle, operation: () => OperationContext, baseUrl = 'http://localhost/'): Browser {
  const current = operation();
  const config = resolveConfig({ targets: [{ name: 'web', platform: 'web', engine, app: { url: baseUrl } }], cache: 'off', timeout: 30_000, actionTimeout: current.timeoutMs, assertionTimeout: current.timeoutMs }, { projectRoot: process.cwd(), env: process.env });
  const steps = new StepRecorder(current.attemptId);
  const { fixtures } = createFixtures({
    config, target: config.targets[0]!, session: createEngineSession({ engine, targetName: 'web' }),
    steps, budget: new AttemptBudget(current.signal, new Deadline(30_000)), runId: current.runId, attemptId: current.attemptId,
    attempt: { testId: 'native-browser-fixture', attemptId: current.attemptId, index: 0, signal: current.signal, memory: new Map() },
    artifacts: { dir: process.cwd(), register: (_kind, relativePath) => relativePath, link: (relativePath) => relativePath }, priorSteps: () => steps.completed(),
    agentContext: undefined, saveSession: undefined, models: new WorkerModels(() => {}),
  });
  return Reflect.get(fixtures, 'browser') as Browser;
}

/** Replace a synthetic fixture document through trusted evaluation, including inline scripts. */
export async function nativeDocument(browser: Browser, html: string): Promise<void> {
  await browser.evaluate((content) => {
    document.open();
    document.write(content);
    document.close();
    return null;
  }, html);
}
