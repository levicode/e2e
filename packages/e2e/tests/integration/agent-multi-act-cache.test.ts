/**
 * Two `agent.act()` calls in one test are two cache entries, and each replays
 * on its own. The documented way to reuse a shared prefix (`docs/cache.mdx`,
 * "Split a shared prefix into its own step") depends on that: editing the
 * later instruction must not cost the earlier call its recording, and the
 * later call must open on the screen the earlier replay left.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

/** The suite's two calls; `second` is the instruction that changes between runs. */
function suite(second: string): string {
  return `import { test, expect } from 'e2e';

test('splits a shared prefix into its own call', async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('increment the counter');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
  await agent.act(${JSON.stringify(second)});
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});
`;
}

const FIRST = 'increment it once more';
const SECOND = 'increment the counter again';

/** Taps Increment, then concludes after the updated screen arrives. */
function counterModel(call: LoopCall) {
  if (call.toolResults.length === 0) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }];
  return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'incremented' } }];
}

function actSteps(outcome: RunOutcome) {
  const attempt = resultByTitle(outcome, 'splits a shared prefix into its own call').attempts.at(-1)!;
  const steps = attempt.steps.filter((step) => step.api === 'agent.act');
  expect(steps).toHaveLength(2);
  return steps;
}

function entryCount(project: FixtureProject): number {
  return readdirSync(path.join(project.dir, '.e2e', 'cache')).filter((name) => name.endsWith('.json')).length;
}

let app: FixtureApp;
let project: FixtureProject;
let recorded: RunOutcome;
let replayed: RunOutcome;
let edited: RunOutcome;
let recordedEntries = 0;
let replayedEntries = 0;
let replayModelCalls = 0;

beforeAll(async () => {
  app = await startFixtureApp();
  project = createProject({ 'tests/act.e2e.ts': suite(SECOND) });
  const options = (model: ReturnType<typeof installFakeLoopModel>) => ({
    appUrl: app.url,
    config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } }, cache: 'read-write' as const },
  });
  recorded = await runExisting(project, options(installFakeLoopModel(counterModel)));
  recordedEntries = entryCount(project);
  // The second call's recording is present, so a full replay must reach the end without a model.
  replayed = await runExisting(project, options(installFakeLoopModel(counterModel)));
  replayedEntries = entryCount(project);
  replayModelCalls = loopCalls.length;
  writeFileSync(path.join(project.dir, 'tests', 'act.e2e.ts'), suite(FIRST), 'utf8');
  edited = await runExisting(project, options(installFakeLoopModel(counterModel)));
}, 240_000);

afterAll(async () => {
  project?.cleanup();
  await app?.close();
});

describe('two acts in one test', () => {
  it('records one entry per call and leaves the next call on the screen the first one reached', () => {
    expect(recorded.exitCode).toBe(0);
    expect(recordedEntries).toBe(2);
    expect(actSteps(recorded).map((step) => step.cache?.write)).toEqual(['saved', 'saved']);
  });

  it('replays both calls without a model call', () => {
    expect(replayed.exitCode).toBe(0);
    expect(replayModelCalls).toBe(0);
    expect(replayedEntries).toBe(2);
    expect(actSteps(replayed).map((step) => step.cache?.mode)).toEqual(['self-finalized', 'self-finalized']);
  });

  it('keeps the first call\'s recording when the second instruction changes, and misses only that call', () => {
    expect(edited.exitCode).toBe(0);
    const steps = actSteps(edited);
    expect(steps[0]!.cache).toMatchObject({ mode: 'self-finalized' });
    expect(steps[1]!.cache).toMatchObject({ mode: 'missed', reason: 'no-entry' });
    // The edited call records its own entry; the replaced one stays until a strict run reports it.
    expect(entryCount(project)).toBe(3);
  });
});
