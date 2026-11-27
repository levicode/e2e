/** Agent steps report when any semantic observation was truncated. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEngine, type EngineSnapshot } from '../../src/engine/index.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { installFakeLoopModel, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('reports a truncated act observation', async ({ agent }) => {
  await agent.act('inspect the visible result');
});

test('reports a truncated judgment observation', async ({ agent }) => {
  await agent.assert('the Save button is visible');
});
`;

/** One small tree marked as cut by the engine, as a large page would be. */
function truncatedSnapshot(): EngineSnapshot {
  return {
    root: {
      ref: { id: 'root', revision: '' },
      children: [{ ref: { id: 'save', revision: '' }, role: 'button', name: 'Save' }],
    },
    location: 'https://fixture.test/result',
    viewport: { width: 800, height: 600 },
    truncated: true,
  };
}

describe('agent observation report fields', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    const engine = defineEngine({
      name: 'truncated-observation-fixture',
      version: '1',
      spiVersion: 1,
      platform: 'fixture',
      observe: async () => truncatedSnapshot(),
    });
    const model = installFakeLoopModel(() => [
      { toolName: 'complete_step', input: { status: 'passed', summary: 'the result is visible' } },
    ]);
    const judge = installFakeModel(() => judgment(true, 'the Save button is visible'));
    const result = await runProject(
      { 'tests/truncated.e2e.ts': SUITE },
      {
        appUrl: 'https://fixture.test',
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [{ name: 'fixture', engine }],
          agents: { default: { model, judge } },
        },
      },
    );
    outcome = result.outcome;
    project = result.project;
  });

  afterAll(() => project?.cleanup());

  it.each([
    ['reports a truncated act observation', 'agent.act'],
    ['reports a truncated judgment observation', 'agent.assert'],
  ] as const)('marks %s', (title, api) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('passed');
    expect(result.attempts[0]?.steps.find((step) => step.api === api)?.observationTruncated).toBe(true);
  });

  it('writes a valid report-1 document', () => {
    assertValidReport(outcome.report);
  });
});

const RECORDING_SUITE = `import { test } from 'e2e';

test('acts on the result screen', async ({ agent }) => {
  await agent.act('press Save');
  await agent.waitFor('the screen says Saved');
});
`;

/** The result screen, with the status a passing tap leaves and the engine's cut if asked for it. */
function tapSnapshot(saved: boolean, truncated: boolean): EngineSnapshot {
  return {
    root: {
      ref: { id: 'root', revision: saved ? 'saved' : 'open' },
      children: [
        { ref: { id: 'save', revision: 'open' }, role: 'button', name: 'Save' },
        ...(saved ? [{ ref: { id: 'status', revision: 'saved' }, role: 'status', name: 'Saved' }] : []),
      ],
    },
    location: 'https://fixture.test/result',
    viewport: { width: 800, height: 600 },
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Taps Save from its first look, whatever the tree is worth: an executor owes the cache nothing. */
const tapSave: StepExecutor = {
  name: 'tap-save',
  async runStep(context) {
    const observation = await context.observe();
    await context.actions.tap({ id: nodeIdFor(observation.text, /button "Save"/) });
    return { status: 'passed', summary: 'pressed Save' };
  },
};

/** One read-write run of the recording suite over a tree the engine may cut. */
async function runRecording(truncated: boolean): Promise<{ outcome: RunOutcome; project: FixtureProject }> {
  let saved = false;
  const engine = defineEngine({
    name: 'truncated-recording-fixture',
    version: '1',
    spiVersion: 1,
    platform: 'fixture',
    actions: ['tap'],
    perform: async () => { saved = true; },
    observe: async () => tapSnapshot(saved, truncated),
  });
  const judge = installFakeModel(() => judgment(true, 'the screen says Saved'));
  return runProject({ 'tests/recording.e2e.ts': RECORDING_SUITE }, {
    appUrl: 'https://fixture.test',
    config: {
      tests: 'tests/**/*.e2e.ts',
      cache: 'read-write',
      targets: [{ name: 'fixture', engine }],
      agents: { default: { executor: tapSave, judge } },
    },
  });
}

describe('a truncated tree before the first action', () => {
  let truncated: { outcome: RunOutcome; project: FixtureProject };
  let complete: { outcome: RunOutcome; project: FixtureProject };

  beforeAll(async () => {
    truncated = await runRecording(true);
    complete = await runRecording(false);
  }, 120_000);

  afterAll(() => {
    truncated?.project.cleanup();
    complete?.project.cleanup();
  });

  it('names the truncation as why the passing step was not recorded', () => {
    const result = resultByTitle(truncated.outcome, 'acts on the result screen');
    expect(result.status).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'agent.act')!;
    expect(step.observationTruncated).toBe(true);
    expect(step.cache).toMatchObject({ mode: 'missed', reason: 'no-entry', notRecorded: 'observation-truncated' });
    expect(step.cache?.write).toBeUndefined();
    assertValidReport(truncated.outcome.report);
  });

  it('records the same flow unchanged when the engine read the whole tree', () => {
    const result = resultByTitle(complete.outcome, 'acts on the result screen');
    expect(result.status).toBe('passed');
    const step = result.attempts[0]!.steps.find((candidate) => candidate.api === 'agent.act')!;
    expect(step.observationTruncated).toBeUndefined();
    expect(step.cache).toMatchObject({ mode: 'missed', reason: 'no-entry', write: 'saved' });
    expect(step.cache).not.toHaveProperty('notRecorded');
    assertValidReport(complete.outcome.report);
  });
});
