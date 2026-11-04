/** The built runner must not recover a model target into a replacement context. */
import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { defineEngine } from '../helpers/engine-runtime.ts';
import { EngineError } from '../../src/engine/index.ts';
import { runProject } from '../helpers/run-project.ts';

describe('built runner live identity boundary', () => {
  it.each([false, true])('fences context replacement during action=%s', async duringAction => {
    let phase = 0;
    const performed: string[] = [];
    const engine = defineEngine({
      name: 'identity-fixture', version: '1', spiVersion: 1, actions: ['tap'],
      observe: async () => ({
        identityScope: `context-${phase}`,
        root: { ref: { id: 'root', revision: '' }, children: [
          { ref: { id: phase === 0 ? 'old' : 'new', revision: '' }, role: 'button', name: 'Save' },
        ] }, viewport: { width: 800, height: 600 },
      }),
      perform: async ref => {
        performed.push(ref.id);
        if (duringAction && phase === 0) {
          phase = 1;
          throw new EngineError('NODE_STALE', 'synthetic context replacement', { retryable: true });
        }
      },
    });
    const executor: StepExecutor = {
      name: 'scope-boundary-consumer', cache: 'off',
      async runStep(context) {
        await context.observe();
        if (!duringAction) { phase = 1; await context.observe(); }
        await expect(context.actions.tap({ id: 'old' })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
        return { status: 'passed', summary: 'old target refused' };
      },
    };
    const { project, outcome } = await runProject({
      'tests/scope.e2e.ts': `import { test } from 'e2e'; test('scope boundary', async ({ agent }) => { await agent.act('Save'); });`,
    }, { config: { targets: [{ name: 'fixture', platform: 'custom', engine }], cache: 'off', agents: { default: { executor } } } });
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.report.run.results[0]?.status, JSON.stringify(outcome.report.run.results[0]?.attempts[0]?.error)).toBe('passed');
      expect(performed).toEqual(duringAction ? ['old'] : []);
    } finally { project.cleanup(); }
  });
});
