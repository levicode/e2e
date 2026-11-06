/**
 * The configured pixel policy reaches the real act loop: `on-request` keeps
 * an ordinary action result text-only after an explicit screenshot while a
 * point action refreshes the image, `off` offers no pixel tool at all, and the
 * default `always` stays sticky.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, type LoopCall } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('always keeps the step in pixel mode', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('always pixel policy');
});

test('on-request carries pixels only on request', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('lean pixel policy', { agent: 'lean' });
});

test('off offers no pixel tool', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('dark pixel policy', { agent: 'dark' });
});
`;

const complete = (status: 'passed' | 'failed') => [
  { toolName: 'complete_step', input: { status, summary: 'done' } },
];

/** The screenshot result is content with a file part; a text-only result is not. */
function hasImage(call: LoopCall): boolean {
  return call.lastToolResult.includes('"type":"file"');
}

function resetTarget(prompt: string): string {
  return /#(\S+) button "Reset"/.exec(prompt)?.[1] ?? 'missing';
}

/** The scripted act model: a screenshot, a listed tap, a point action, then a verdict. */
function actModel(call: LoopCall) {
  const calls = call.toolResults.length;
  if (call.prompt.includes('always pixel policy')) {
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap', input: { target: resetTarget(call.prompt) } }];
    return complete('passed');
  }
  if (call.prompt.includes('lean pixel policy')) {
    if (calls === 0) return [{ toolName: 'screenshot', input: {} }];
    if (calls === 1) return [{ toolName: 'tap', input: { target: resetTarget(call.prompt) } }];
    if (calls === 2) return [{ toolName: 'tap_at', input: { x: 180, y: 36 } }];
    return complete('passed');
  }
  return complete('passed');
}

describe('the configured pixel policy', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let calls: readonly LoopCall[];

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeLoopModel(actModel);
    const run = await runProject(
      { 'tests/pixel-policy.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agents: {
            default: { model },
            lean: { model, pixels: 'on-request' },
            dark: { model, pixels: 'off' },
          },
        },
      },
    );
    outcome = run.outcome;
    project = run.project;
    calls = [...loopCalls];
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const turnsOf = (instruction: string) => calls.filter((call) => call.prompt.includes(instruction));

  it('stays in pixel mode under the default always policy', () => {
    expect(resultByTitle(outcome, 'always keeps the step in pixel mode').status).toBe('passed');
    const [, second, third] = turnsOf('always pixel policy');
    expect(hasImage(second!)).toBe(true);
    expect(hasImage(third!)).toBe(true);
  });

  it('sends pixels only when the model asks under on-request', () => {
    expect(resultByTitle(outcome, 'on-request carries pixels only on request').status).toBe('passed');
    const [first, shot, tapped, pointed] = turnsOf('lean pixel policy');
    expect(first!.system).toContain('This agent sends pixels only when you ask');
    expect(first!.system).not.toContain('once you have one, every action result carries a fresh screenshot');
    expect(first!.toolNames).toContain('screenshot');
    // The explicit screenshot carries the image; the tap after it does not.
    expect(hasImage(shot!)).toBe(true);
    expect(tapped!.lastToolResult).toContain('Tapped');
    expect(hasImage(tapped!)).toBe(false);
    // A point action is read off the image and its own result carries a fresh one.
    expect(hasImage(pointed!)).toBe(true);
  });

  it('offers no pixel tool under off and sends no image', () => {
    expect(resultByTitle(outcome, 'off offers no pixel tool').status).toBe('passed');
    const [first] = turnsOf('dark pixel policy');
    expect(first!.toolNames).not.toContain('screenshot');
    for (const name of ['tap_at', 'hover_at', 'type_at', 'press_at', 'select_at']) {
      expect(first!.toolNames, name).not.toContain(name);
    }
    expect(first!.toolNames).toContain('tap');
    expect(first!.system).toContain('No pixel tools are offered');
    expect(first!.imageParts).toBe(0);
  });
});
