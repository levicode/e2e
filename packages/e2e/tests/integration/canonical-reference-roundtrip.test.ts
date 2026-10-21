/** Canonical IDs pass through the real observation feed and checked action dispatcher. */
import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

describe('canonical reference round trip', () => {
  it.each(['@e7', '#@e7'])('resolves %s to the same engine reference', async target => {
    const seen: string[] = [];
    const fake = createFakeEngine({
      tree: { ref: { id: '@e7', revision: '' }, role: 'button', name: 'Save' },
      perform: ref => { seen.push(ref.id); },
    });
    const executor: StepExecutor = {
      name: 'canonical-ref-consumer', version: '1', cache: 'off',
      async runStep(ctx) {
        const observation = await ctx.observe({ tree: true });
        expect(observation.tree?.id).toBe('@e7');
        expect(observation.text).toContain('@e7 button');
        expect(observation.text).not.toContain('#@');
        await ctx.actions.tap({ id: target });
        return { status: 'passed', summary: 'used the observed canonical reference' };
      },
    };
    let project: FixtureProject | undefined;
    try {
      const result = await runProject({
        'tests/reference.e2e.ts': `import { test } from 'e2e';
          test('uses canonical ref', async ({ agent }) => { await agent.act('Save'); });`,
      }, { config: { targets: [{ name: 'synthetic', platform: 'fake', engine: fake.engine, app: FAKE_APP }], agents: { default: { executor } } } });
      project = result.project;
      expect(resultByTitle(result.outcome, 'uses canonical ref').status, JSON.stringify(result.outcome.report.run.errors)).toBe('passed');
      expect(seen).toEqual(['@e7']);
    } finally {
      project?.cleanup();
    }
  });
});
