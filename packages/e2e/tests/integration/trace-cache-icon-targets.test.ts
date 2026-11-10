/**
 * An icon-only control in the replay cache. A glyph-only action target has no
 * role, name, or text a replay could re-find, while the page identifies it by
 * its own `id`/`class`; the recording keeps that identifier, so the second run
 * replays the click with no model call. A target the page identifies by
 * nothing is still recorded, but the first run reports the written recording
 * as one the next run cannot replay, naming the action, instead of `saved`.
 */

import { readFileSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor, type LoopCall, type LoopToolCall } from '../helpers/fake-loop-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { actSteps, cacheConfig, entriesFor, expectPassed, expectReplayed, readEntries } from '../helpers/trace-cache.ts';
import type { ModelInstance } from '../../src/index.ts';
import type { StepRecord } from '../../src/run/steps.ts';

const tap = (target: string): LoopToolCall => ({ toolName: 'tap', input: { target } });

/** How a model finds the icon: the page's own class, or the only unnamed clickable the screen lists. */
interface IconSelector {
  readonly listed: RegExp;
  readonly line: RegExp;
}

const IDENTIFIED: IconSelector = { listed: /class="icon icon-add"/u, line: /class="icon icon-add"/u };
const ANONYMOUS: IconSelector = { listed: /#\S+ \[clickable\]\s*$/mu, line: /#\S+ \[clickable\]\s*$/u };

/**
 * A model for one icon flow: open the toolbar by its named button, click the
 * icon once the screen change lists it, and conclude when the status reads
 * "added". The icon is addressed from the tool result that listed it, the way
 * a model reads a screen change.
 */
function iconModel(icon: IconSelector): ModelInstance {
  return installFakeLoopModel((call: LoopCall) => {
    if (/"Result" text="added"/u.test(call.lastToolResult)) {
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'added the tag' } }];
    }
    if (call.lastToolResult === '') return [tap(nodeIdFor(call.prompt, /button "Edit tags"/u))];
    if (!icon.listed.test(call.lastToolResult)) throw new Error(`the icon did not appear:\n${call.lastToolResult}`);
    return [tap(nodeIdFor(call.lastToolResult, icon.line))];
  });
}

function suite(title: string, path: string): string {
  return `import { test, expect } from 'e2e';

test(${JSON.stringify(title)}, async ({ app, agent, screen }) => {
  await app.open(${JSON.stringify(path)});
  await agent.act(${JSON.stringify(title)});
  await expect(screen.getByRole('status', { name: 'Result' })).toHaveText('added');
});
`;
}

function actStep(outcome: RunOutcome, title: string): StepRecord {
  const steps = actSteps(outcome, title);
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

/** The one entry the project holds, as bytes and modification time. */
function entryFile(project: FixtureProject): { readonly file: string; readonly bytes: string; readonly mtimeMs: number } {
  const entries = readEntries(project);
  expect(entries).toHaveLength(1);
  const file = entries[0]!.file;
  return { file, bytes: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs };
}

describe('trace cache: an icon-only control records a target a new session can re-find', () => {
  const TITLE = 'adds a tag through the icon';
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let recordedModelCalls = 0;
  let recordedEntry: { bytes: string; mtimeMs: number };
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/act.e2e.ts': suite(TITLE, '/icon-targets') });
    recorded = await runExisting(project, { appUrl: app.url, config: cacheConfig(iconModel(IDENTIFIED)) });
    recordedModelCalls = loopCalls.length;
    const { bytes, mtimeMs } = entryFile(project);
    recordedEntry = { bytes, mtimeMs };
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(iconModel(IDENTIFIED)) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes the step on both runs and reports both in the schema', () => {
    expectPassed(recorded);
    expectPassed(replayed);
    assertValidReport(recorded.report);
    assertValidReport(replayed.report);
  });

  it('records the page id as the icon target, and saves the recording as replayable', () => {
    expect(recordedModelCalls).toBeGreaterThan(0);
    const entry = entriesFor(project, TITLE)[0]!;
    expect(entry.payload.truncated).toBeUndefined();
    expect(entry.payload.actions).toHaveLength(2);
    expect(entry.payload.actions[1]).toMatchObject({ name: 'tap', target: { domId: 'tag-add' }, summary: 'tap node "tag-add"' });
    expect(actStep(recorded, TITLE).cache).toMatchObject({ mode: 'missed', reason: 'no-entry', write: 'saved' });
  });

  it('replays the icon click with no model call on the second run', () => {
    expect(loopCalls).toHaveLength(0);
    expectReplayed(actStep(replayed, TITLE), 2);
    expect(actStep(replayed, TITLE).cache?.write).toBe('kept');
  });

  it('leaves the entry as recorded: the replay proved it, so it is not rewritten', () => {
    const { bytes, mtimeMs } = entryFile(project);
    expect({ bytes, mtimeMs }).toEqual(recordedEntry);
  });
});

describe('trace cache: a recording no target can re-find says so when it is written', () => {
  const TITLE = 'adds a tag through the anonymous icon';
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let replayed: RunOutcome;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/act.e2e.ts': suite(TITLE, '/icon-anonymous') });
    recorded = await runExisting(project, { appUrl: app.url, config: cacheConfig(iconModel(ANONYMOUS)) });
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(iconModel(ANONYMOUS)) });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('writes the entry, but reports it as written and not replayable, naming the action', () => {
    expectPassed(recorded);
    assertValidReport(recorded.report);
    const entry = entriesFor(project, TITLE)[0]!;
    expect(entry.payload.truncated).toBe(true);
    expect(entry.payload.actions).toHaveLength(2);
    expect(entry.payload.actions[1]).toMatchObject({ name: 'tap', target: { role: 'unknown' } });
    expect(actStep(recorded, TITLE).cache).toMatchObject({
      mode: 'missed',
      reason: 'no-entry',
      write: 'saved-unreplayable',
      writeDetail: 'action 2 has no target a replay can re-find',
    });
  });

  it('refuses the entry before any action on the second run, and runs the step live again', () => {
    expectPassed(replayed);
    assertValidReport(replayed.report);
    expect(loopCalls.length).toBeGreaterThan(0);
    expect(actStep(replayed, TITLE).cache).toMatchObject({ mode: 'missed', reason: 'truncated', replayedActions: 0, totalActions: 2 });
    // Re-recording the same unnameable flow keeps it unnameable.
    expect(entriesFor(project, TITLE)[0]!.payload.truncated).toBe(true);
  });
});
