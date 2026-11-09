/**
 * Secret-pixel acceptance for the six paths #151 lists, through the real web
 * engine and the real runner. Every masking claim is read off decoded pixels —
 * the capture's size, the field's region, and a public marker beside it —
 * rather than a boolean on the record.
 *
 * The fixture page keeps its own password input; the test moves it to a known
 * rectangle and paints it red, and adds a cyan public marker. A masked capture
 * is then black over the field and still cyan over the marker, so an unmasked
 * or blanked capture cannot pass by accident.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel, judgment, type FakeCall } from '../helpers/fake-model.ts';
import { resultByTitle, runProject, webTarget, type FixtureProject } from '../helpers/run-project.ts';
import type { RunOutcome } from '../helpers/run-project.ts';

/** The viewport every full capture in this file is taken in. */
const VIEWPORT = { width: 1280, height: 720 };
/** Where the fixture's password input is painted, in CSS pixels. */
const FIELD_CENTER = { x: 100, y: 40 };
/** A public element beside the field, so a capture that blanked the screen cannot pass. */
const MARKER_CENTER = { x: 640, y: 330 };
const BLACK = [0, 0, 0] as const;
const CYAN = [0, 255, 255] as const;

/**
 * The field is painted red, so a masked capture reads black over it and an
 * unmasked one red; the marker is a public element that must survive.
 */
const PAGE_SETUP = `const CSS = ${JSON.stringify(
  'input[type=password]{position:fixed !important;left:20px !important;top:20px !important;' +
    'width:160px !important;height:40px !important;border:0 !important;padding:0 !important;' +
    'background:#f00 !important;color:#f00 !important;z-index:99999 !important}',
)};
async function paint(browser) {
  await browser.evaluate((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;left:600px;top:300px;width:80px;height:60px;background:#00ffff;z-index:99999';
    document.body.append(marker);
    return null;
  }, CSS);
}`;

const JUDGMENT_SUITE = `import { test } from '@e2e-dev/web';
import { credentials } from 'e2e';
${PAGE_SETUP}

test('masks the HOME password for a vision judgment', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.assert('the password field is visible', { vision: true });
});

test('masks a plain secure input on another page', async ({ app, browser, agent }) => {
  await app.open('/test-lines');
  await paint(browser);
  await agent.assert('the password field is visible on this page', { vision: true });
});

test('sends masked pixels alone under vision only', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.assert('the password field is the whole screen', { vision: 'only' });
});

test('keeps a masked explicit screenshot after a secret fill', async ({ app, browser, screen, agent }) => {
  await app.open();
  await paint(browser);
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await app.screenshot('after-fill');
  await agent.assert('the password field is visible after the fill', { vision: true });
});

test('denies vision only after a secret fill instead of reading the tree', async ({ app, browser, screen, agent }) => {
  await app.open();
  await paint(browser);
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('judge the filled field from pixels alone', { vision: 'only' });
});

test('denies vision only after a fill on a plain secure-input page', async ({ app, browser, screen, agent }) => {
  await app.open('/test-lines');
  await paint(browser);
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await agent.assert('judge this page from pixels alone', { vision: 'only' });
});

test('keeps masked verdict evidence for a passing judgment', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.assert('the password field is painted', { vision: true });
});

test('keeps masked verdict evidence for a failing judgment', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.assert('the checkout page is visible', { vision: true });
});
`;

const EXECUTOR_SUITE = `import { test, credentials } from 'e2e';
${PAGE_SETUP}

test('shows the executor masked pixels', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.act('observe the painted password');
});

test('withholds executor pixels after it fills a secret', async ({ app, browser, agent }) => {
  await app.open();
  await paint(browser);
  await agent.act('fill the password and observe again', { params: { password: credentials.user('member').password } });
});
`;

function respond(call: FakeCall): unknown {
  return judgment(!call.instruction.includes('checkout'), 'judged from the screenshot');
}

/** Decodes one PNG from the attempt's artifact directory. */
function artifactPng(project: FixtureProject, relative: string): PNG {
  return PNG.sync.read(readFileSync(path.join(project.dir, '.e2e', 'results', relative)));
}

/** The RGB colour at a CSS coordinate of a capture, whatever image scale it was saved at. */
function pixelAt(png: PNG, x: number, y: number): readonly number[] {
  const column = Math.min(png.width - 1, Math.round((x * png.width) / VIEWPORT.width));
  const row = Math.min(png.height - 1, Math.round((y * png.height) / VIEWPORT.height));
  const at = (row * png.width + column) * 4;
  return [png.data[at]!, png.data[at + 1]!, png.data[at + 2]!];
}

/** The masking claim on its own: black over the secure field, cyan on the public marker. */
function expectMaskedPixels(png: PNG): void {
  expect(pixelAt(png, FIELD_CENTER.x, FIELD_CENTER.y)).toEqual(BLACK);
  expect(pixelAt(png, MARKER_CENTER.x, MARKER_CENTER.y)).toEqual(CYAN);
}

/** A full-viewport capture (an explicit or evidence screenshot) is the viewport size and masked. */
function expectMaskedCapture(png: PNG): void {
  expect({ width: png.width, height: png.height }).toEqual(VIEWPORT);
  expectMaskedPixels(png);
}

/** A model image may be resampled; its shape and its masking are what matter. */
function expectMaskedModelImage(data: Uint8Array): void {
  const png = PNG.sync.read(Buffer.from(data));
  expect(png.width / png.height).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 2);
  expectMaskedPixels(png);
}

type Attempt = ReturnType<typeof resultByTitle>['attempts'][number];
type Step = Attempt['steps'][number];

function attemptOf(outcome: RunOutcome, title: string): Attempt {
  return resultByTitle(outcome, title).attempts.at(-1)!;
}

function stepOf(attempt: Attempt, api: string): Step {
  const step = attempt.steps.find((candidate) => candidate.api === api);
  if (step === undefined) throw new Error(`no ${api} step`);
  return step;
}

/** A screenshot artifact attached to one step, decoded. */
function stepScreenshot(project: FixtureProject, attempt: Attempt, step: Step): PNG {
  const artifact = attempt.artifacts.find(
    (candidate) => candidate.kind === 'screenshot' && step.artifacts.includes(candidate.id),
  );
  if (artifact?.path === undefined) throw new Error(`no screenshot artifact on ${step.api}`);
  return artifactPng(project, artifact.path);
}

/** The artifact the runner took when the attempt failed, decoded. */
function failureCapture(project: FixtureProject, attempt: Attempt): PNG {
  const artifact = attempt.artifacts.find((candidate) => candidate.id === attempt.failure?.screenshot);
  if (artifact?.path === undefined) throw new Error('no failure screenshot');
  return artifactPng(project, artifact.path);
}

describe('secret pixels: judgment, vision, explicit screenshot, and verdict evidence', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const model = installFakeModel(respond, { modelId: 'scripted-text' });
    const run = await runProject(
      { 'tests/pixels.e2e.ts': JUDGMENT_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [webTarget('web', app.url, { viewport: VIEWPORT })],
          agents: { default: { model } },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const callFor = (instruction: string): FakeCall => {
    const call = fakeCalls.find((candidate) => candidate.instruction === instruction);
    if (call === undefined) throw new Error(`no model call for "${instruction}"`);
    return call;
  };

  it('masks the HOME page password in the judgment image and keeps public pixels', () => {
    const title = 'masks the HOME password for a vision judgment';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(stepOf(attemptOf(outcome, title), 'agent.assert').visionInput).toBe(true);
    const call = callFor('the password field is visible');
    expect(call.images).toHaveLength(1);
    expectMaskedModelImage(call.images[0]!.data);
  });

  it('masks a plain secure input on another page the same way', () => {
    const title = 'masks a plain secure input on another page';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const call = callFor('the password field is visible on this page');
    expect(call.images).toHaveLength(1);
    expectMaskedModelImage(call.images[0]!.data);
  });

  it('withholds the tree but not the masking under vision only', () => {
    const title = 'sends masked pixels alone under vision only';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const step = stepOf(attemptOf(outcome, title), 'agent.assert');
    expect(step.visionOnly).toBe(true);
    expect(step.visionInput).toBe(true);
    expect(step.metrics!.observationBytes).toBe(0);
    const call = callFor('the password field is the whole screen');
    expect(call.observation).toBe('');
    expect(call.images).toHaveLength(1);
    expectMaskedModelImage(call.images[0]!.data);
  });

  it('keeps a masked explicit screenshot after a secret fill', () => {
    const title = 'keeps a masked explicit screenshot after a secret fill';
    const attempt = attemptOf(outcome, title);
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const explicit = attempt.artifacts.find(
      (artifact) => artifact.kind === 'screenshot' && artifact.path?.includes('after-fill'),
    );
    expect(explicit?.path).toBeDefined();
    expectMaskedCapture(artifactPng(project, explicit!.path!));
  });

  it('withholds model pixels after a secret fill while the step still keeps a masked evidence screenshot', () => {
    const title = 'keeps a masked explicit screenshot after a secret fill';
    const attempt = attemptOf(outcome, title);
    const step = stepOf(attempt, 'agent.assert');
    expect(step.visionDegraded).toBe('PIXEL_TAINTED');
    expect(step.visionInput).toBeUndefined();
    // Same step, two separate protections: the model gets no pixels, the
    // artifact is still kept and was masked at the source.
    expectMaskedCapture(stepScreenshot(project, attempt, step));
    const call = callFor('the password field is visible after the fill');
    expect(call.images).toEqual([]);
    expect(call.prompt).not.toContain('hunter2-secret');
    // The value reaches neither the model request nor the report.
    expect(JSON.stringify(outcome.report)).not.toContain('hunter2-secret');
  });

  /** A pixels-only judge after a fill: POLICY_DENIED, no model call, and a masked failure capture. */
  const expectTaintedDenial = (title: string): void => {
    const attempt = attemptOf(outcome, title);
    expect(attempt.error?.code).toBe('POLICY_DENIED');
    expect(attempt.error?.message).toContain('PIXEL_TAINTED');
    const step = stepOf(attempt, 'agent.assert');
    expect(step.visionDegraded).toBe('PIXEL_TAINTED');
    expect(step.metrics?.modelCalls).toBe(0);
    expectMaskedCapture(failureCapture(project, attempt));
  };

  it('denies pixels-only with POLICY_DENIED after a secret fill and keeps a masked failure capture', () => {
    expectTaintedDenial('denies vision only after a secret fill instead of reading the tree');
  });

  it('denies pixels-only after a fill on a plain secure-input page the same way', () => {
    expectTaintedDenial('denies vision only after a fill on a plain secure-input page');
  });

  it('keeps masked verdict evidence for a passing judgment', () => {
    const title = 'keeps masked verdict evidence for a passing judgment';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const attempt = attemptOf(outcome, title);
    const step = stepOf(attempt, 'agent.assert');
    expect(step.explanation).toBe('judged from the screenshot');
    expectMaskedCapture(stepScreenshot(project, attempt, step));
  });

  it('keeps masked verdict evidence for a failing judgment, beside the failure capture', () => {
    const title = 'keeps masked verdict evidence for a failing judgment';
    const attempt = attemptOf(outcome, title);
    expect(attempt.error?.code).toBe('ASSERTION_FAILED');
    const step = stepOf(attempt, 'agent.assert');
    expect(step.explanation).toBe('judged from the screenshot');
    expectMaskedCapture(stepScreenshot(project, attempt, step));
    expectMaskedCapture(failureCapture(project, attempt));
  });
});

describe('secret pixels: executor observations', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const seen = new Map<string, string>();

  const peeking: StepExecutor = {
    name: 'pixel-peeker',
    version: '1',
    async runStep(context) {
      if (context.step.instruction.includes('fill')) {
        const observation = await context.observe({ tree: true });
        const findSecure = (node: NonNullable<typeof observation.tree>): NonNullable<typeof observation.tree> | undefined => {
          if (node.states?.secure === true) return node;
          for (const child of node.children ?? []) {
            const found = findSecure(child);
            if (found !== undefined) return found;
          }
          return undefined;
        };
        const password = findSecure(observation.tree!);
        if (password === undefined) throw new Error('no secure node to fill');
        await context.actions.typeSecret({ id: password.id }, 'member.password');
        const after = await context.observe({ pixels: true });
        const summary =
          `${after.pixelsWithheld ?? 'pixels'};tainted=${String(context.pixelsTainted)};` +
          `${after.pixels === undefined ? 'pixels=none' : `pixels=${after.pixels.width}x${after.pixels.height}`}`;
        seen.set(context.step.instruction, summary);
        return {
          status: after.pixels === undefined && after.pixelsWithheld === 'PIXEL_TAINTED' ? 'passed' : 'failed',
          summary,
        };
      }
      const observation = await context.observe({ tree: true, pixels: true });
      if (observation.pixels === undefined) return { status: 'failed', summary: `pixels withheld: ${observation.pixelsWithheld}` };
      await context.attachScreenshot(observation.pixels, 'executor-pixels');
      const summary = `masked-regions=${observation.pixels.maskedRegionCount};${observation.pixels.width}x${observation.pixels.height}`;
      seen.set(context.step.instruction, summary);
      return { status: 'passed', summary };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const run = await runProject(
      { 'tests/executor-pixels.e2e.ts': EXECUTOR_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [webTarget('web', app.url, { viewport: VIEWPORT })],
          agents: { default: { executor: peeking } },
          credentials: { member: { username: 'ada', password: 'hunter2-secret' } },
        },
      },
    );
    outcome = run.outcome;
    project = run.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands the executor masked pixels with a proved region count and a kept artifact', () => {
    const title = 'shows the executor masked pixels';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    const attempt = attemptOf(outcome, title);
    const step = stepOf(attempt, 'agent.act');
    expect(step.visionInput).toBe(true);
    // The executor-facing capture is sized for a model; the count is the
    // engine's proof that at least the one secure node was masked. The cap
    // itself is a tuned constant, so this asserts the shape, not the number.
    const capture = /^masked-regions=(\d+);(\d+)x(\d+)$/.exec(seen.get('observe the painted password') ?? '');
    expect(capture).not.toBeNull();
    expect(Number(capture![1])).toBeGreaterThanOrEqual(1);
    expect(Number(capture![2]) / Number(capture![3])).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 2);
    expect(Number(capture![2])).toBeLessThanOrEqual(VIEWPORT.width);
    expect(step.metrics!.pixelBytes).toBeGreaterThan(0);
    expectMaskedPixels(stepScreenshot(project, attempt, step));
  });

  it('withholds executor pixels after its own secret fill, naming PIXEL_TAINTED', () => {
    const title = 'withholds executor pixels after it fills a secret';
    expect(resultByTitle(outcome, title).status).toBe('passed');
    expect(seen.get('fill the password and observe again')).toBe('PIXEL_TAINTED;tainted=true;pixels=none');
    expect(stepOf(attemptOf(outcome, title), 'agent.act').visionDegraded).toBe('PIXEL_TAINTED');
  });
});
