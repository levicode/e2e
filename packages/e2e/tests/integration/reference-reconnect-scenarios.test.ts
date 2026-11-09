/**
 * The reference consumers across a browser reconnect: the same document
 * identity scope, the same descriptors, and every earlier id refused because
 * the engine re-issued it. A reconnect is not a verb of the engine contract,
 * so the engine boundary here is `reference-scenario.ts`, which does exactly
 * what the native adapter leaves behind after a dropped CDP connection — it
 * retires every listed id in one capture and lists the same controls under
 * fresh ones. The consumer under test is real: the built-in agent's screen
 * presenter, the trace's step screen diff, an `e2e mcp` session, and the
 * session's test lines.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { FAKE_APP } from '../helpers/fake-engine.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createReferenceScenario } from '../helpers/reference-scenario.ts';
import { createProject, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

/** Runs one catalog tool through the server's `call` tool. */
async function call(client: Client, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name: 'call', arguments: { tool, ...(Object.keys(args).length === 0 ? {} : { args }) } }, { timeout: 60_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((part) => part.text ?? '').join('\n'), isError: result.isError === true };
}

/** The id of the first screen line matching `pattern`. */
function idFor(text: string, pattern: RegExp): string {
  const line = text.split('\n').find((candidate) => pattern.test(candidate));
  const match = line === undefined ? null : /^\s*#(@e\d+)\s/.exec(line);
  if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
  return match[1]!;
}

/** The scenario target a run or an MCP session drives. */
const target = (scenario: ReturnType<typeof createReferenceScenario>) => [
  { name: 'scenario', platform: 'fake', engine: scenario.engine, app: FAKE_APP },
];

const AGENT_SUITE = `import { test, expect } from 'e2e';

test('a reconnect re-issues every id on the screen', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('reconnect the browser, then increment the counter');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});
`;

const DIFF_SUITE = `import { test, expect } from 'e2e';

test('the trace diff survives a reconnect', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Reconnect the browser' }).tap();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});
`;

const MCP_CONFIG = `import type { E2EConfig } from 'e2e';
import { FAKE_APP } from '../../helpers/fake-engine.ts';
import { createReferenceScenario } from '../../helpers/reference-scenario.ts';

const scenario = createReferenceScenario();

export default {
  targets: [{ name: 'scenario', platform: 'fake', engine: scenario.engine, app: FAKE_APP }],
} satisfies E2EConfig;
`;

describe('the screen across a reconnect', () => {
  it('sends the re-issued screen whole, then re-finds a control the model held', async () => {
    const scenario = createReferenceScenario();
    const model = installFakeLoopModel((request) => {
      if (request.turn === 1) return [{ toolName: 'tap', input: { target: nodeIdFor(request.prompt, /button "Reconnect the browser"/) } }];
      // The model quotes the id the opening screen listed. The reconnect
      // retired it, so the action can only land on the newest screen's own
      // issuance, never on the id the model held.
      if (request.turn === 2) return [{ toolName: 'tap', input: { target: nodeIdFor(request.prompt, /button "Increment"/) } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'incremented after the reconnect' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/reconnect.e2e.ts': AGENT_SUITE },
      { config: { tests: 'tests/**/*.e2e.ts', targets: target(scenario), agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'a reconnect re-issues every id on the screen');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      // The action that reconnects: the screen is replaced, not reported as an
      // incremental change keyed by ids the engine has already retired.
      const reconnect = loopCalls[1]!.lastToolResult;
      expect(reconnect).toContain('Tapped #@e4.');
      expect(reconnect).toContain('The screen changed substantially since revision');
      expect(reconnect).toContain('#@e5 heading "Scenario"');
      expect(reconnect).toContain('#@e7 button "Increment"');
      expect(reconnect).not.toContain('#@e1 ');
      expect(reconnect).not.toContain('#@e3 ');
      // The tap quoted the retired id, and the counter moved under the id the
      // re-issued screen listed for it.
      const increment = loopCalls[2]!.lastToolResult;
      expect(increment).toContain('Tapped #@e3.');
      expect(increment).toContain('changed #@e6 status "Counter" text="1"');
      expect(increment).not.toContain('#@e3 status');
      // The engine received the newest screen's own id, not the one the model
      // held: re-finding by descriptor is a fresh issuance.
      expect(scenario.dispatched).toEqual([
        { id: '@e4', action: 'tap', generation: 1 },
        { id: '@e7', action: 'tap', generation: 2 },
      ]);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('the trace screen diff across a reconnect', () => {
  it("pairs the re-issued screen by what it says, then reports the real change", async () => {
    const scenario = createReferenceScenario();
    const { outcome, project } = await runProject(
      { 'tests/diff.e2e.ts': DIFF_SUITE },
      { config: { tests: 'tests/**/*.e2e.ts', targets: target(scenario) } },
    );
    try {
      const result = resultByTitle(outcome, 'the trace diff survives a reconnect');
      expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
      const steps = result.attempts.at(-1)!.steps;
      const open = steps.find((step) => step.api === 'app.open')!;
      const reconnected = steps.find((step) => step.events.some((event) => event.name === 'tap' && event.detail === 'tap button "Reconnect the browser"'))!;
      const incremented = steps.find((step) => step.events.some((event) => event.name === 'tap' && event.detail === 'tap button "Increment"'))!;
      // Re-issued ids are not a screen change: the same controls are described
      // by the same lines, and the diff says so instead of reporting a
      // wholesale replacement.
      expect(reconnected.screen).toMatchObject({ since: open.index, nodes: 5, changes: [] });
      // What the screen does change is reported against the re-issued screen.
      expect(incremented.screen!.since).toBe(reconnected.index);
      expect(incremented.screen!.changes).toEqual([
        'changed status "Counter" text="1" (was: status "Counter" text="0")',
      ]);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('an mcp session across a reconnect', () => {
  let project: FixtureProject;
  let client: Client;
  it('keeps the session moving on the ids the re-issued screen lists', async () => {
    project = createProject({ 'e2e.config.ts': MCP_CONFIG });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: project.dir, env: { ...(process.env as Record<string, string>), CI: '' }, stderr: 'pipe' });
    client = new Client({ name: 'e2e-reference-reconnect', version: '0.0.0' });
    await client.connect(transport);
    try {
      const opened = await client.callTool({ name: 'open_session', arguments: { target: 'scenario' } });
      expect(opened.isError).not.toBe(true);
      const before = (await call(client, 'observe')).text;
      const stale = idFor(before, /button "Increment"/);

      const reconnected = await call(client, 'tap', { target: idFor(before, /button "Reconnect the browser"/) });
      expect(reconnected.isError, reconnected.text).toBe(false);
      expect(reconnected.text).toContain('The screen changed substantially since revision');

      const after = (await call(client, 'observe')).text;
      expect(after).toContain('#@e5 heading "Scenario"');
      expect(after).not.toContain(stale);
      // The control the session read before the reconnect is still there, and
      // the session acts on the id the newest screen gives it.
      const increment = idFor(after, /button "Increment"/);
      expect(increment).not.toBe(stale);
      const tapped = await call(client, 'tap', { target: increment });
      expect(tapped.isError, tapped.text).toBe(false);
      expect((await call(client, 'observe')).text).toContain('text="1"');
    } finally {
      await client.close().catch(() => undefined);
      project.cleanup();
    }
  }, 120_000);
});

describe('the test lines across a reconnect', () => {
  let project: FixtureProject;
  let client: Client;

  it('refuses a line for an id the reconnect retired and prints one for the new id', async () => {
    project = createProject({ 'e2e.config.ts': MCP_CONFIG });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: project.dir, env: { ...(process.env as Record<string, string>), CI: '' }, stderr: 'pipe' });
    client = new Client({ name: 'e2e-reference-lines', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect((await client.callTool({ name: 'open_session', arguments: { target: 'scenario' } })).isError).not.toBe(true);
      const before = (await call(client, 'observe')).text;
      const stale = idFor(before, /button "Increment"/);
      expect((await call(client, 'tap', { target: idFor(before, /button "Reconnect the browser"/) })).isError).toBe(false);

      // The id the session read before the reconnect is not on the newest
      // screen, so no line can name it, even though the action re-finds it.
      const staleTap = await call(client, 'tap', { target: stale });
      expect(staleTap.isError, staleTap.text).toBe(false);
      expect(staleTap.text).toContain(`No test line: #${stale} is not on the newest screen.`);

      const after = (await call(client, 'observe')).text;
      const current = idFor(after, /button "Increment"/);
      const currentTap = await call(client, 'tap', { target: current });
      expect(currentTap.isError, currentTap.text).toBe(false);
      expect(currentTap.text).toContain('Test line: await screen.getByRole("button", "Increment").tap();');

      // The draft keeps the line that works after a reconnect, and records the
      // retired id only in the comment explaining why no line was made.
      const drafted = (await call(client, 'test_lines')).text;
      expect(drafted.split('\n').filter((line) => line.startsWith('await '))).toEqual([
        'await app.open();',
        'await screen.getByRole("button", "Reconnect the browser").tap();',
        'await screen.getByRole("button", "Increment").tap();',
      ]);
      expect(drafted).toContain(`// tap: no test line: #${stale} is not on the newest screen`);
    } finally {
      await client.close().catch(() => undefined);
      project.cleanup();
    }
  }, 120_000);
});
