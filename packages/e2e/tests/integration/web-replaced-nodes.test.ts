/**
 * Visibility reads against a field the page swaps for an identical clone on
 * every animation frame. A read that lands on the node a frame already
 * replaced must re-resolve, never report the visible field hidden; a stable
 * field that shares its candidate set still reads as shown, and a field that
 * is really removed still reads as hidden. Among a crowd of fields replaced
 * every frame, a stable field resolves and an absent one reads as hidden
 * without waiting out the churn. A runner too starved to send two protocol
 * calls within one frame still reads the field as shown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { popupEvalDiagnosticOptions } from '../helpers/popup-eval-diagnostics.ts';
import { withShortReadDiagnostics } from '../helpers/short-read-diagnostics.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { closedFailureDiagnostic } from '../helpers/closed-failure-diagnostic.ts';
import { resultByTitle, createProject, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const READS = 10;

/**
 * Runs body while this process's event loop is blocked in 20 ms slices, so a
 * frame passes between any two protocol calls, as on a loaded CI runner.
 * Atomics.wait blocks without spinning a core the other workers need.
 */
const starved = async (body) => {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  const timer = setInterval(() => Atomics.wait(blocker, 0, 0, 20), 0);
  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
};

const fields = (screen) => ({
  testId: screen.getByTestId('nickname'),
  label: screen.getByLabel('Nickname', { exact: true }),
  displayValue: screen.getByDisplayValue('ada'),
});

/** How many of \`reads\` reads of each locator report it hidden. */
const hiddenReads = async (locators, reads = READS) => {
  const hidden = {};
  for (const [kind, locator] of Object.entries(locators)) {
    hidden[kind] = 0;
    for (let read = 0; read < reads; read += 1) {
      if (await locator.isHidden()) hidden[kind] += 1;
    }
  }
  return hidden;
};

test('a field replaced every frame never reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  expect(await hiddenReads(fields(screen))).toEqual({ testId: 0, label: 0, displayValue: 0 });
});

test('a field replaced every frame never reads as hidden on a starved runner', async ({ app, screen }) => {
  await app.open('/replaced');
  expect(await starved(() => hiddenReads(fields(screen), 3))).toEqual({ testId: 0, label: 0, displayValue: 0 });
});

test('a stable field beside one replaced every frame reads as shown', async ({ app, screen }) => {
  await app.open('/replaced');
  const city = {
    label: screen.getByLabel('City', { exact: true }),
    displayValue: screen.getByDisplayValue('paris'),
  };
  expect(await hiddenReads(city)).toEqual({ label: 0, displayValue: 0 });
});

for (const kind of ['testId', 'label', 'displayValue']) {
  test('toBeHidden fails on a field replaced every frame: ' + kind, async ({ app, screen }) => {
    await app.open('/replaced');
    await expect(fields(screen)[kind]).toBeHidden({ timeout: 500 });
  });
}

test('a stable field among fields replaced every frame resolves promptly', async ({ app, screen }) => {
  const diagnostic = process.env['E2E_REPLACED_FIELD_CAPTURE'] === '1';
  const previous = process.env['E2E_REPLACED_FIELD_ACTIVE'];
  if (diagnostic) process.env['E2E_REPLACED_FIELD_ACTIVE'] = '1';
  try {
    await app.open('/replaced-crowd');
    const city = [screen.getByLabel('City', { exact: true }), screen.getByDisplayValue('paris')];
    for (let round = 0; round < 5; round += 1) {
      for (const field of city) {
        await expect(field).toBeVisible({ timeout: 1_000 });
        await expect(field).toHaveCount(1, { timeout: 1_000 });
      }
    }
    for (const absent of [screen.getByLabel('Nickname', { exact: true }), screen.getByDisplayValue('ada')]) {
      await expect(absent).toBeHidden({ timeout: 1_000 });
    }
  } finally {
    if (diagnostic) {
      if (previous === undefined) delete process.env['E2E_REPLACED_FIELD_ACTIVE'];
      else process.env['E2E_REPLACED_FIELD_ACTIVE'] = previous;
    }
  }
});

test('a field removed while it is being replaced reads as hidden', async ({ app, screen }) => {
  await app.open('/replaced');
  await expect(screen.getByTestId('nickname')).toBeVisible();
  await screen.getByRole('button', { name: 'Remove' }).tap();
  for (const field of Object.values(fields(screen))) {
    await expect(field).toBeHidden();
    expect(await field.isHidden()).toBe(true);
  }
});
`;

/** A new destination and mandatory owned inputs prevent stale capture reuse. */
function archiveReplacedFieldCapture(projectDir: string | undefined, report: unknown, closedRows: string | undefined, captureNonce: string | undefined): void {
  const parent = path.resolve('.e2e/replaced-nodes');
  mkdirSync(parent, { recursive: true });
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('Invalid capture destination');
  const output = mkdtempSync(path.join(parent, 'run-'));
  if (projectDir === undefined || report === undefined || closedRows === undefined || captureNonce === undefined || !/^[0-9a-f]{64}$/.test(captureNonce)) throw new Error('Missing capture inputs');
  const source = path.join(projectDir, '.e2e', 'native-trace');
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Missing owned native trace');
  const files = readdirSync(source);
  if (files.length === 0 || files.some(file => !/^(native|query)-[0-9]+\.jsonl$/.test(file))) throw new Error('Invalid native trace inputs');
  for (const file of files) {
    const info = lstatSync(path.join(source, file));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid native trace input');
  }
  const trace = path.join(output, 'native-trace');
  mkdirSync(trace);
  // No merge/skip-existing behavior. A partial copy has no completed custody.
  for (const file of files) copyFileSync(path.join(source, file), path.join(trace, file));
  const reportText = JSON.stringify(report, null, 2);
  writeFileSync(path.join(output, 'report.json'), reportText);
  writeFileSync(path.join(output, 'closed-js.jsonl'), closedRows);
  const custody = {
    schemaVersion: 2, run: path.basename(output), captureNonce,
    reportSHA256: createHash('sha256').update(reportText).digest('hex'),
    closedJsSHA256: createHash('sha256').update(closedRows).digest('hex'),
  };
  writeFileSync(path.join(output, 'custody.json'), JSON.stringify(custody));
  // Bind this fresh directory to the current harness log. A stale archive alone
  // cannot satisfy field-only acceptance if this capture fails before creation.
  process.stderr.write(`REPLACED_FIELD_CAPTURE_ARCHIVE ${JSON.stringify(custody)}\n`);
}

describe('reads of a node replaced every frame', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let closedRows: string | undefined;
  let captureNonce: string | undefined;

  beforeAll(async () => {
    app = await startFixtureApp();
    // Thirty sequential reads against a page that swaps nodes every frame: on a
    // loaded CI runner each read takes far longer than locally, and the suite
    // asserts what the reads return, not how fast they are. The hook's own
    // budget covers all eight tests at that deadline.
    project = createProject({ 'tests/replaced.e2e.ts': SUITE });
    outcome = await withShortReadDiagnostics('replaced-nodes', onEvent => runExisting(project, {
      appUrl: app.url,
      runOptions: { ...popupEvalDiagnosticOptions(project.dir, app.url, 'E2E_REPLACED_FIELD_CAPTURE'), onEvent },
      config: { actionTimeout: 5_000, assertionTimeout: 4_000, timeout: 90_000 },
    }), (rows, nonce) => { closedRows = rows; captureNonce = nonce; });
  }, 750_000);

  afterAll(async () => {
    // Capture the original whole workload before its owned temporary project is
    // removed. Never rerun/select the failing case or change its deadline.
    if (process.env['E2E_REPLACED_FIELD_CAPTURE'] === '1') {
      try {
        archiveReplacedFieldCapture(project?.dir, outcome?.report, closedRows, captureNonce);
      } catch {
        // A custody failure is not a new test outcome. The independent capture
        // validator must reject missing/incomplete evidence; never infer success.
        try { process.stderr.write('REPLACED_FIELD_CAPTURE_CUSTODY_FAILED\n'); } catch { /* Preserve the original result. */ }
      }
    }
    project?.cleanup();
    await app?.close();
  });

  it('never reads the live field as hidden through a detached node', () => {
    const result = resultByTitle(outcome, 'a field replaced every frame never reads as hidden');
    expect(result.status, closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toBe('passed');
  });

  it('never reads the live field as hidden while the runner is starved', () => {
    const result = resultByTitle(outcome, 'a field replaced every frame never reads as hidden on a starved runner');
    expect(result.status, closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toBe('passed');
  });

  it('reads a stable neighbor of a replaced field without tripping on it', () => {
    const result = resultByTitle(outcome, 'a stable field beside one replaced every frame reads as shown');
    expect(result.status, closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toBe('passed');
  });

  it.each(['testId', 'label', 'displayValue'])('fails toBeHidden on the live field by %s', (kind) => {
    const result = resultByTitle(outcome, `toBeHidden fails on a field replaced every frame: ${kind}`);
    expect(result.status).toBe('failed');
    // A last sample that lands on a replaced node past the deadline reports the locator unresolved.
    expect(['ASSERTION_FAILED', 'LOCATOR_NOT_FOUND'], closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toContain(result.attempts[0]!.error?.code);
  });

  it('resolves a stable field among churning candidates within a short deadline', () => {
    const result = resultByTitle(outcome, 'a stable field among fields replaced every frame resolves promptly');
    expect(result.status, closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toBe('passed');
  });

  it('still reads a genuinely removed field as hidden', () => {
    const result = resultByTitle(outcome, 'a field removed while it is being replaced reads as hidden');
    expect(result.status, closedFailureDiagnostic(result.attempts, outcome.report.run.errors)).toBe('passed');
  });
});
