/**
 * The reference consumers across navigation, a viewport swipe, a drag, and a
 * batched pair of actions: the scenarios #142's matrix left without a
 * consumer-level test. Every scenario runs against the built `e2e` runner and
 * a real Chromium page: the built-in agent's screen presenter, the trace's
 * step screen diff, an `e2e mcp` session's catalog, and a custom executor's
 * `ctx.actions`. Ids are the engine's own, listed as `#@e<n>`, so a failure
 * names the consumer and the reference it lost.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { StepRecord } from '../../src/run/steps.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** The id in the `changed`/`removed`/`added` line whose text matches `pattern`. */
function idsIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(`#(@e\\d+) [^\\n]*${pattern.source}`, 'g'))].map((match) => match[1]!);
}

describe('the screen consumer', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('sends a navigation as a new document rather than an id-keyed delta', async () => {
    const NAVIGATION = `import { test, expect } from 'e2e';

test('the about page replaces the home screen', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('open the About page, then go back home through its Home link');
  await expect(screen.getByRole('heading')).toHaveText('Home');
});
`;
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /link "About"/) } }];
      if (call.turn === 2) return [{ toolName: 'tap', input: { target: nodeIdFor(call.toolResults.at(-1)!, /link "Home"/) } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'navigated there and back' } }];
    });
    const { outcome, project } = await runProject({ 'tests/navigation.e2e.ts': NAVIGATION }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } });
    try {
      const result = resultByTitle(outcome, 'the about page replaces the home screen');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const about = loopCalls[1]!.lastToolResult;
      expect(about).toContain('The screen changed substantially since revision');
      expect(about).toContain('Current screen (revision');
      expect(about).toContain('heading "About"');
      expect(about).toContain('link "Home"');
      // Every id the home page listed is gone: a new document, not a delta.
      for (const id of idsIn(loopCalls[0]!.prompt, /button "Increment"/)) expect(about).not.toContain(`#${id} `);
      // Back home, the same control carries a new issuance: navigation retired
      // the ids it had, they were not re-bound to the returning document.
      const home = loopCalls[2]!.lastToolResult;
      expect(home).toContain('heading "Home"');
      const before = nodeIdFor(loopCalls[0]!.prompt, /button "Increment"/);
      expect(home).not.toContain(`#${before} `);
      expect(nodeIdFor(home, /button "Increment"/)).not.toBe(before);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('reports a viewport scroll by the node it moved, keeping every id it did not', async () => {
    const VIEWPORT = `import { test, expect } from 'e2e';

test('the footnote comes into view with the ids it had', async ({ app, agent, screen }) => {
  await app.open('/gestures');
  await agent.act('scroll down to the footnote, then look once more');
  await expect(screen.getByRole('status', { name: 'Footnote state' })).toHaveText('in view');
});
`;
    const model = installFakeLoopModel((call) => {
      if (call.turn <= 2) return [{ toolName: 'scroll', input: { direction: 'down', times: 6 } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'scrolled to the footnote' } }];
    });
    const { outcome, project } = await runProject({ 'tests/viewport.e2e.ts': VIEWPORT }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } });
    try {
      const result = resultByTitle(outcome, 'the footnote comes into view with the ids it had');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const changed = loopCalls[1]!.lastToolResult;
      expect(changed).toContain('Screen changes since revision');
      const match = /changed #(@e\d+) status "Footnote state" text="in view" \(was: #(@e\d+) status "Footnote state" text="out of view"\)/.exec(changed);
      expect(match, changed).not.toBeNull();
      // A viewport move changes what a node says, never the reference to it.
      expect(match![1]).toBe(match![2]);
      expect(changed).not.toMatch(/^(added|removed) /m);
      // A second look says the screen and its ids are unchanged, rather than
      // re-issuing references after a scroll.
      const unchanged = loopCalls[2]!.lastToolResult;
      expect(unchanged).toContain('Screen unchanged since revision');
      expect(unchanged).toContain('the ids you have stay valid');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('the trace screen diff', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });

  /** The index of the tap on the locator whose description holds `text`. */
  const tapOn = (steps: readonly StepRecord[], text: string): number =>
    steps.findIndex((step) => step.api === 'locator.tap' && step.label.includes(text));

  it('follows a navigation across documents', async () => {
    const NAVIGATION = `import { test } from 'e2e';

test('the diff follows a navigation', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await app.open('/about');
});
`;
    const { outcome, project } = await runProject({ 'tests/diff-navigation.e2e.ts': NAVIGATION }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts' } });
    try {
      const result = resultByTitle(outcome, 'the diff follows a navigation');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const steps = result.attempts.at(-1)!.steps;
      const tapped = tapOn(steps, '"Increment"');
      const about = steps.at(-1)!;
      expect(about.screen).toMatchObject({ since: steps[tapped]!.index });
      const changes = about.screen!.changes.join('\n');
      expect(changes).toContain('added heading "About"');
      expect(changes).toContain('added link "Home"');
      expect(changes).toContain('removed heading "Home"');
      // A navigation replaces the document: nothing is reported as changed in
      // place, and the home page's ids never reappear as re-bound lines.
      expect(about.screen!.changes.every((line) => line.startsWith('added ') || line.startsWith('removed '))).toBe(true);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('keeps ids still across a viewport swipe and reports the next real change', async () => {
    const VIEWPORT = `import { test } from 'e2e';

test('the diff after a viewport swipe', async ({ app, screen }) => {
  await app.open('/gestures');
  await screen.swipe({ direction: 'down', momentum: 'fast' });
  await screen.getByRole('button', { name: 'Hold me' }).tap();
});
`;
    const { outcome, project } = await runProject({ 'tests/diff-viewport.e2e.ts': VIEWPORT }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts' } });
    try {
      const result = resultByTitle(outcome, 'the diff after a viewport swipe');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const steps = result.attempts.at(-1)!.steps;
      const swiped = steps.findIndex((step) => step.api === 'screen.swipe');
      const tapped = steps.findIndex((step) => step.api === 'locator.tap');
      // A viewport move is not a tree change: the step reports no added,
      // removed, or changed line.
      expect(steps[swiped]!.screen).toMatchObject({ since: 0, nodes: 33, changes: [] });
      // The action after it is diffed against the swipe's screen.
      expect(steps[tapped]!.screen!.since).toBe(steps[swiped]!.index);
      expect(steps[tapped]!.screen!.changes).toEqual([
        'added status "Gesture state" text="tapped"',
        'removed status "Gesture state" text="idle"',
      ]);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('reports both ends of a drag by the state they changed', async () => {
    const DRAG = `import { test } from 'e2e';

test('the diff after a drag', async ({ app, screen }) => {
  await app.open('/gestures');
  await screen.getByText('Design review').dragTo(screen.getByRole('region', { name: 'Done column' }));
});
`;
    const { outcome, project } = await runProject({ 'tests/diff-drag.e2e.ts': DRAG }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts' } });
    try {
      const result = resultByTitle(outcome, 'the diff after a drag');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const steps = result.attempts.at(-1)!.steps;
      const dragged = steps.at(-1)!;
      expect(dragged.screen).toMatchObject({ since: 0, nodes: 33 });
      expect(dragged.screen!.changes).toEqual([
        'added status "Gesture state" text="Design review is done"',
        'removed status "Gesture state" text="idle"',
      ]);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('an mcp session', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const result = (await client.callTool({ name: 'call', arguments: { tool, ...(Object.keys(args).length === 0 ? {} : { args }) } }, { timeout: 60_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
  };
  const idFor = (text: string, pattern: RegExp): string => {
    const line = text.split('\n').find((candidate) => pattern.test(candidate));
    const match = line === undefined ? null : /^\s*#(@e\d+)\s/.exec(line);
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': `import type { E2EConfig } from 'e2e';\nimport { web } from '@e2e-dev/web';\n\nexport default {\n  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],\n} satisfies E2EConfig;\n` });
    client = new Client({ name: 'e2e-reference-scenarios', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: project.dir, env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' }, stderr: 'pipe' }));
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it('drag addresses both endpoints by the ids the screen listed', async () => {
    expect((await client.callTool({ name: 'open_session', arguments: {} })).isError).not.toBe(true);
    expect((await call('navigate', { url: `${app.url}/gestures` })).isError).toBe(false);
    const screen = (await call('observe')).text;
    const card = idFor(screen, /listitem "Design review"/);
    const done = idFor(screen, /region "Done column"/);
    const dragged = await call('drag', { target: card, to: done });
    expect(dragged.isError, dragged.text).toBe(false);
    expect(dragged.text.split('\n')[0]).toBe(`Dragged #${card} to #${done}.`);
    // The line names both ends by locator, so a replay does not hold either id.
    expect(dragged.text).toContain('.dragTo(screen.getByRole(');
    expect((await call('observe')).text).toContain('status "Gesture state" text="Design review is done"');
    expect((await client.callTool({ name: 'close_session', arguments: {} })).isError).not.toBe(true);
  }, 120_000);

  it('scroll moves the viewport and reports the node it changed', async () => {
    expect((await client.callTool({ name: 'open_session', arguments: {} })).isError).not.toBe(true);
    expect((await call('navigate', { url: `${app.url}/gestures` })).isError).toBe(false);
    const scrolled = await call('scroll', { direction: 'down', times: 6 });
    expect(scrolled.isError, scrolled.text).toBe(false);
    expect(scrolled.text).toContain('Scrolled down 6 screens.');
    expect(scrolled.text).toMatch(/changed #@e\d+ status "Footnote state" text="in view"/);
    expect(scrolled.text).not.toMatch(/^(added|removed) /m);
    // No test line for a viewport scroll: the test action brings its own node into view.
    expect(scrolled.text).toContain('No test line:');
    expect((await client.callTool({ name: 'close_session', arguments: {} })).isError).not.toBe(true);
  }, 120_000);
});

describe('a custom executor', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('keeps addressing the screen a batched pair of taps saw', async () => {
    const SUITE = `import { test, expect } from 'e2e';

test('two taps from one observation', async ({ app, agent, screen }) => {
  await app.open('/churn');
  await agent.act('tap the "Tap me" button twice');
  await expect(screen.getByRole('status', { name: 'Progress' })).toHaveText('2 / 3');
});
`;
    let observedId = '';
    const executor: StepExecutor = {
      name: 'batch-consumer', version: '1', cache: 'off',
      async runStep(context) {
        const first = await context.observe();
        observedId = nodeIdFor(first.text, /button "Tap me"/);
        // Both taps quote the observation the step opened with. The page
        // remounts the row on hover, so after the first tap that id names a
        // detached element: the second tap can only work by re-finding the
        // control the newest screen lists.
        await context.actions.tap({ id: observedId });
        await context.actions.tap({ id: observedId });
        return { status: 'passed', summary: 'tapped the re-rendered control twice' };
      },
    };
    const { outcome, project } = await runProject({ 'tests/batch.e2e.ts': SUITE }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } } });
    try {
      const result = resultByTitle(outcome, 'two taps from one observation');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.actionSteps).toBe(2);
      // The relocated tap was a fresh capture, not a silent retry of the old id.
      expect(step.events.filter((event) => event.kind === 'observation' && event.name === 'relocate').length).toBeGreaterThanOrEqual(1);
      expect(observedId).toMatch(/^@e\d+$/);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('drags between the two ids one observation listed', async () => {
    const SUITE = `import { test, expect } from 'e2e';

test('an executor drag moves the card', async ({ app, agent, screen }) => {
  await app.open('/gestures');
  await agent.act('drag the design review card into the done column');
  await expect(screen.getByRole('status', { name: 'Gesture state' })).toHaveText('Design review is done');
});
`;
    const endpoints: string[] = [];
    const executor: StepExecutor = {
      name: 'drag-consumer', version: '1', cache: 'off',
      async runStep(context) {
        const observation = await context.observe();
        const from = nodeIdFor(observation.text, /listitem "Design review"/);
        const to = nodeIdFor(observation.text, /region "Done column"/);
        endpoints.push(from, to);
        await context.actions.drag({ id: from }, { id: to });
        const after = await context.observe();
        expect(after.text).toContain('Design review is done');
        return { status: 'passed', summary: 'dragged the card' };
      },
    };
    const { outcome, project } = await runProject({ 'tests/drag.e2e.ts': SUITE }, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } } });
    try {
      const result = resultByTitle(outcome, 'an executor drag moves the card');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      expect(endpoints).toHaveLength(2);
      expect(endpoints[0]).not.toBe(endpoints[1]);
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.events.some((event) => event.name === 'dragTo')).toBe(true);
      expect(step.events.some((event) => event.name === 'dragTo' && event.status === 'failed')).toBe(false);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
