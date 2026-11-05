/**
 * Regression control for a model target that names a listed node without the
 * engine's `@` decoration. The listing prints `#@e123`; a real run wrote
 * `e347` against observation b2, a screen the model had seen and that had
 * not changed, and the harness reported `LOCATOR_NOT_FOUND` with
 * "removed or never existed". The lookup now accepts the dropped `@` when
 * the screen lists that node, and the error names the listing when it does
 * not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

test('default agent taps a listed control whose id lost its engine decoration', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter and verify it shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

describe('a target id that lost the engine decoration', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('taps the node the screen lists when the model wrote it without its @', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) {
        // The listing read from the opening prompt, as a model copies it,
        // with the engine's @ dropped: `#@e347` becomes `e347`.
        const listed = nodeIdFor(call.prompt, /button "Increment"/);
        return [{ toolName: 'tap', input: { target: listed.replace(/^@/, '') } }];
      }
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'tapped Increment; the counter shows 1' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/target-reference.e2e.ts': SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'default agent taps a listed control whose id lost its engine decoration');
      const tap = loopCalls[1]!.toolResults[0]!;
      expect(tap).toMatch(/^Tapped #e\d+/);
      expect(tap).toContain('text="1"');
      expect(tap).not.toContain('LOCATOR_NOT_FOUND');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('names the current listing when the id is not on it', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) return [{ toolName: 'tap', input: { target: 'e9007199254740991' } }];
      return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'the id named no node, so nothing was tapped' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/target-missing.e2e.ts': SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'default agent taps a listed control whose id lost its engine decoration');
      expect(result.status).toBe('failed');
      const error = loopCalls[1]!.toolResults[0]!;
      expect(error).toContain('is not on the current screen (observation ');
      expect(error).toMatch(/The screen lists \d+ nodes, such as #@e\d+/);
      expect(error).toContain('quote an id exactly as the current listing prints it');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
