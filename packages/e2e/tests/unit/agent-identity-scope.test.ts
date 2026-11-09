/** Live target history must not rebind an old reference across engine identity scopes. */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine, EngineError, type EngineSnapshot } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';

runAgentStepsOnFakeTime();

/** Exercise the real fixture, session, feed, and action dispatcher with synthetic snapshots. */
async function exercise(scopes: readonly (string | undefined)[], staleDuringAction: boolean, scroll?: 'during' | 'after' | 'viewport') {
  let phase = 0;
  const actions: string[] = [];
  const engine = defineEngine({
    name: 'scope-fixture', version: '1', spiVersion: 1,
    observe: async (): Promise<EngineSnapshot> => {
      const identityScope = scopes[phase];
      return {
        ...(identityScope === undefined ? {} : { identityScope }),
        ...(scroll === 'viewport' ? { viewportRef: { id: 'viewport-only', revision: '' } } : {}),
        root: { ref: { id: scroll === 'viewport' ? `document-${phase}` : 'root', revision: '' }, role: 'document', children: [
          { ref: { id: phase === 0 ? 'old' : 'new', revision: '' }, role: 'button', name: 'Save' },
        ] }, viewport: { width: 800, height: 600 },
      };
    },
    actions: ['tap', 'swipe'],
    async perform(ref) {
      actions.push(ref.id);
      if (scroll !== undefined) { phase = 1; return; }
      if (staleDuringAction && phase === 0) {
        phase = 1;
        throw new EngineError('NODE_STALE', 'synthetic context replacement', { retryable: true });
      }
    },
  });
  let failure: unknown;
  const executor: StepExecutor = {
    name: 'scope-consumer', version: '1', cache: 'off',
    async runStep(ctx) {
      const first = await ctx.observe();
      expect(first).not.toHaveProperty('identityScope');
      expect(first).not.toHaveProperty('viewportRef');
      expect(first.text).not.toContain('viewport-only');
      expect(first.text).not.toContain('identityScope');
      if (!staleDuringAction && scroll !== 'during') { phase = 1; await ctx.observe(); }
      try {
        if (scroll === 'viewport') { await ctx.actions.scroll('down'); await ctx.actions.scrollUntil('Missing row', 'down'); }
        else if (scroll === undefined) await ctx.actions.tap({ id: 'old' });
        else await ctx.actions.scrollUntil('Missing row', 'down', { id: 'old' });
      } catch (cause) { failure = cause; }
      return { status: 'passed', summary: 'checked scope boundary' };
    },
  };
  await runAgentStep(engine, executor);
  return { actions, failure };
}

/** Runs one agent step through the real fixture, session, feed, and action dispatcher. */
async function runAgentStep(engine: ReturnType<typeof defineEngine>, executor: StepExecutor): Promise<void> {
  const config = resolveConfig({ targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', agents: { default: { executor } } }, { projectRoot: process.cwd(), env: {} });
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config, target: config.targets[0]!, session: createEngineSession({ engine, targetName: 'fake' }), steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)), runId: 'run', attemptId: 'attempt',
    attempt: { titlePath: ['identity-scope'], testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(), agentContext: undefined, saveSession: undefined, models: new WorkerModels(() => {}),
  });
  await fixtures.agent.act('Save');
}

describe('engine identity scopes', () => {
  it('routes untargeted scroll and scrollUntil through the separate viewport capability', async () => {
    const result = await exercise(['a', 'b'], false, 'viewport');
    expect(result.actions.length).toBeGreaterThanOrEqual(2);
    expect(result.actions.every(id => id === 'viewport-only')).toBe(true);
  });
  it('stops multi-page scrolling when the context changes', async () => {
    const result = await exercise(['a', 'b'], false, 'during');
    expect(result.actions).toEqual(['old']);
    expect(result.failure).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });
  it('does not turn a retired list target into a viewport swipe', async () => {
    const result = await exercise(['a', 'b'], false, 'after');
    expect(result.actions).toEqual([]);
    expect(result.failure).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });
  for (const scopes of [['a', 'b'], [undefined, 'b'], ['a', undefined]] as const) {
    it(`does not refind history across ${String(scopes[0])} to ${String(scopes[1])}`, async () => {
      const result = await exercise(scopes, false);
      expect(result.actions).toEqual([]);
      expect(result.failure).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    });
    it(`does not retry a stale target across ${String(scopes[0])} to ${String(scopes[1])}`, async () => {
      const result = await exercise(scopes, true);
      expect(result.actions).toEqual(['old']);
      expect(result.failure).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    });
  }
  for (const scopes of [['a', 'a'], [undefined, undefined]] as const) {
    it(`preserves same-scope history recovery for ${String(scopes[0])}`, async () => {
      expect(await exercise(scopes, false)).toEqual({ actions: ['new'], failure: undefined });
    });
    it(`preserves same-scope stale recovery for ${String(scopes[0])}`, async () => {
      expect(await exercise(scopes, true)).toEqual({ actions: ['old', 'new'], failure: undefined });
    });
  }
});

/**
 * The owner decision #9 asks for: after navigation or a same-scope reconnect,
 * re-finding an old target by its descriptor is a *new issuance*, not a
 * rebinding. The old id is dropped, and the engine is asked to act on the
 * newest screen's own reference and revision.
 */
describe('a target re-found by its descriptor', () => {
  it("dispatches the newest screen's own issuance, never the old id", async () => {
    let phase = 0;
    const dispatched: { id: string; revision: string }[] = [];
    const engine = defineEngine({
      name: 'refound-fixture', version: '1', spiVersion: 1, referenceRevisions: 'engine',
      actions: ['tap'],
      async observe(): Promise<EngineSnapshot> {
        return {
          identityScope: 'document-1',
          root: {
            ref: { id: 'root', revision: `issue-${phase}` }, role: 'document', children: [
              { ref: { id: phase === 0 ? '@e1' : '@e2', revision: `issue-${phase}` }, role: 'button', name: 'Save' },
            ],
          },
          viewport: { width: 800, height: 600 },
        };
      },
      async perform(ref) {
        dispatched.push({ id: ref.id, revision: ref.revision });
      },
    });
    let newest = '';
    const executor: StepExecutor = {
      name: 'refound-consumer', version: '1', cache: 'off',
      async runStep(ctx) {
        expect((await ctx.observe()).text).toContain('#@e1');
        // The same document re-renders the control: the engine retires the old
        // element and issues a new id with a new issuance revision.
        phase = 1;
        newest = (await ctx.observe()).text;
        await ctx.actions.tap({ id: '@e1' });
        return { status: 'passed', summary: 'tapped the re-rendered Save' };
      },
    };
    await runAgentStep(engine, executor);
    expect(newest).toContain('#@e2');
    expect(newest).not.toContain('#@e1');
    expect(dispatched).toEqual([{ id: '@e2', revision: 'issue-1' }]);
  });
});
