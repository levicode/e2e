import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SETUP_RETRY_DELAYS_MS,
  classifySetupFailure,
  openEntryForSetup,
  readSetupRecord,
  retrySchedule,
  writeSetupRecord,
  type SetupTarget,
} from '../src/setup.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'http://uat.example.test/app/',
  loginUrl: 'https://sso.example.test/login.html',
  accountId: undefined,
  labelId: undefined,
  labelName: undefined,
  homeHash: '#/home',
  sessionFile: '',
  env: {},
};

const HOME = 'http://uat.example.test/app/#/home';

class CodedError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

interface Behavior {
  /** Thrown by `open` instead of a successful navigation. */
  readonly failure?: Error;
  /** The document status the page reports after the open. */
  readonly status?: number;
  /** The location the attempt lands on; defaults to home. */
  readonly url?: string;
}

/** A target whose every open consumes one scripted behavior. */
function scriptedTarget(behaviors: readonly Behavior[]): SetupTarget & { readonly opens: number } {
  const queue = [...behaviors];
  let current: Behavior | undefined;
  const target = {
    opens: 0,
    async open(_url: string, _timeoutMs: number): Promise<void> {
      target.opens += 1;
      current = queue.shift();
      if (current?.failure !== undefined) throw current.failure;
    },
    async url(): Promise<string> {
      return current?.url ?? HOME;
    },
    async navigationStatus(): Promise<number | undefined> {
      return current?.status;
    },
  };
  return target;
}

function temporaryRecord(): { directory: string; file: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'uat-setup-'));
  return { directory, file: path.join(directory, 'setup-attempts.json') };
}

test('the setup budget is at most two retries, with increasing waits', () => {
  assert.equal(SETUP_RETRY_DELAYS_MS.length, 2);
  assert.deepEqual(SETUP_RETRY_DELAYS_MS, [1_000, 3_000]);
  assert.ok(SETUP_RETRY_DELAYS_MS[1]! > SETUP_RETRY_DELAYS_MS[0]!);
});

test('a 504 gateway page is retried, and the attempts and waits reach the record', async () => {
  const { directory, file } = temporaryRecord();
  try {
    const target = scriptedTarget([
      { status: 504, url: 'http://uat.example.test/app/' },
      { status: 200, url: HOME },
    ]);
    const result = await openEntryForSetup(target, settings, { attemptsFile: file, retryDelaysMs: [1, 2] });
    assert.equal(result.url, HOME);
    assert.equal(target.opens, 2);
    assert.deepEqual(result.attempts.map(entry => [entry.status, entry.outcome]), [[504, 'unreachable'], [200, 'passed']]);
    const record = readSetupRecord(file);
    assert.equal(record?.outcome, 'passed');
    assert.deepEqual(record?.retryDelaysMs, [1, 2]);
    assert.deepEqual(record?.attempts.map(entry => entry.outcome), ['unreachable', 'passed']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a reset connection is retried from the failed navigation status', async () => {
  const failure = new CodedError('operation failed in browser.goto', 'ACTION_FAILED', {
    cause: new CodedError('The native browser action outcome is unknown', 'ACTION_MAY_HAVE_COMMITTED'),
  });
  const target = scriptedTarget([
    { failure, status: 0, url: 'chrome-error://chromewebdata/' },
    { status: 200, url: HOME },
  ]);
  const result = await openEntryForSetup(target, settings, { retryDelaysMs: [1, 2] });
  assert.equal(result.url, HOME);
  assert.equal(target.opens, 2);
  assert.deepEqual(result.attempts.map(entry => entry.outcome), ['unreachable', 'passed']);
});

test('a login redirect is not retried and keeps its own code', async () => {
  const target = scriptedTarget([{ status: 200, url: 'https://sso.example.test/login.html' }]);
  await assert.rejects(openEntryForSetup(target, settings, { retryDelaysMs: [1, 2] }), /UAT_SESSION_EXPIRED: the app redirected to the login page/);
  assert.equal(target.opens, 1);
});

test('a session problem is never treated as a retryable network failure', async () => {
  const target = scriptedTarget([{ failure: new Error('UAT_SESSION_EXPIRED: no saved session exists'), status: 0 }]);
  await assert.rejects(openEntryForSetup(target, settings, { retryDelaysMs: [1, 2] }), /UAT_SESSION_EXPIRED/);
  assert.equal(target.opens, 1);
});

test('an unrelated failure is not retried', async () => {
  const target = scriptedTarget([{ failure: new Error('UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID'), status: 200 }]);
  await assert.rejects(openEntryForSetup(target, settings, { retryDelaysMs: [1, 2] }), /UAT_CONFIG_MISSING/);
  assert.equal(target.opens, 1);
});

test('when every attempt meets the gateway, the failure names the statuses and the waits', async () => {
  const { directory, file } = temporaryRecord();
  try {
    const target = scriptedTarget([
      { status: 504, url: 'http://uat.example.test/app/' },
      { status: 504, url: 'http://uat.example.test/app/' },
      { status: 503, url: 'http://uat.example.test/app/' },
    ]);
    await assert.rejects(
      openEntryForSetup(target, settings, { attemptsFile: file, retryDelaysMs: [1, 2] }),
      /UAT_APP_UNREACHABLE: GET http:\/\/uat\.example\.test\/app\/ got HTTP 503 after \d+ ms; gave up after 3 setup attempts \(HTTP 504, HTTP 504, HTTP 503\), separated by waits of 1 ms and 2 ms.*do not sign in again/,
    );
    assert.equal(target.opens, 3);
    const record = readSetupRecord(file);
    assert.equal(record?.outcome, 'unreachable');
    assert.equal(record?.attempts.length, 3);
    assert.ok(record?.attempts.every(entry => entry.outcome === 'unreachable'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a session failure after a retry is recorded, not disguised as passing', async () => {
  const { directory, file } = temporaryRecord();
  try {
    const target = scriptedTarget([
      { status: 504, url: 'http://uat.example.test/app/' },
      { status: 200, url: 'https://sso.example.test/login.html' },
    ]);
    await assert.rejects(openEntryForSetup(target, settings, { attemptsFile: file, retryDelaysMs: [1, 2] }), /UAT_SESSION_EXPIRED/);
    const record = readSetupRecord(file);
    assert.equal(record?.outcome, 'session-expired');
    assert.deepEqual(record?.attempts.map(entry => entry.outcome), ['unreachable', 'session-expired']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the record round-trips at 0600 and a malformed file yields nothing', () => {
  const { directory, file } = temporaryRecord();
  try {
    writeSetupRecord(file, {
      schemaVersion: 1,
      retryDelaysMs: [1_000, 3_000],
      attempts: [{ attempt: 1, startedAt: '2026-11-09T00:00:00.000Z', durationMs: 12, status: 504, outcome: 'unreachable' }],
      outcome: 'unreachable',
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readSetupRecord(file)?.attempts[0]?.status, 504);
    assert.equal(readSetupRecord(path.join(directory, 'absent.json')), undefined);
    writeSetupRecord(file, { schemaVersion: 1, retryDelaysMs: [], attempts: [], outcome: 'passed' });
    assert.equal(readSetupRecord(file)?.attempts.length, 0);
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
    const broken = path.join(directory, 'broken.json');
    writeFileSync(broken, '{ not json');
    assert.equal(readSetupRecord(broken), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the exhaustion sentence counts attempts and waits', () => {
  const sentence = retrySchedule([
    { attempt: 1, startedAt: '', durationMs: 1, status: 0, outcome: 'unreachable' },
    { attempt: 2, startedAt: '', durationMs: 1, outcome: 'failed' },
  ], [1_000, 3_000]);
  assert.equal(sentence, '; gave up after 2 setup attempts (no response, no response), separated by waits of 1000 ms and 3000 ms');
});

test('the setup failure taxonomy keeps gateway, session, and other failures apart', () => {
  const connection = new CodedError('operation failed in browser.goto', 'ACTION_FAILED', {
    cause: new CodedError('The native browser action outcome is unknown', 'ACTION_MAY_HAVE_COMMITTED'),
  });
  assert.equal(classifySetupFailure(connection, 0), 'unreachable');
  assert.equal(classifySetupFailure(new CodedError('slow', 'OPERATION_TIMEOUT'), 0), 'unreachable');
  assert.equal(classifySetupFailure(new Error('UAT_APP_UNREACHABLE: GET /app/ got HTTP 502 after 5 ms'), 502), 'unreachable');
  assert.equal(classifySetupFailure(new Error('UAT_SESSION_EXPIRED: the app redirected to the login page'), 200), 'session-expired');
  assert.equal(classifySetupFailure(new Error('UAT_CONFIG_MISSING'), 200), 'failed');
  assert.equal(classifySetupFailure(connection, 200), 'failed');
});
