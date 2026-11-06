import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLedger, renderReport } from '../src/report.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'http://uat.example.test/ad-manager/',
  loginUrl: 'http://sso.example.test/login.html',
  accountId: '1234567890',
  homeHash: '#/home',
  sessionFile: '/private/session.json',
};

function report(status: 'passed' | 'failed', messages: readonly string[] = []): unknown {
  return {
    schemaVersion: 'report-1',
    run: {
      id: '0199c0de-0000-7000-8000-000000000000',
      status,
      exitCode: status === 'passed' ? 0 : 1,
      startedAt: '2026-11-06T02:00:00.000Z',
      finishedAt: '2026-11-06T02:00:10.000Z',
      vcs: { commit: 'a'.repeat(40), branch: 'main', dirty: true },
      environment: { os: 'darwin', arch: 'x64', runtime: 'v24.22.1' },
      errors: messages.map(message => ({ category: 'test', code: 'ERROR', message, retryable: false })),
      results: [
        {
          titlePath: ['account label page queries the configured account read-only'],
          status,
          attempts: [
            {
              status,
              durationMs: 1234,
              error: status === 'failed' ? { code: 'ENGINE_FAILURE', message: messages[0] ?? 'The native browser operation failed' } : undefined,
              steps: [
                {
                  api: 'agent.act',
                  label: 'query the account label page',
                  status,
                  durationMs: 900,
                  error: status === 'failed' ? { code: 'ENGINE_FAILURE', message: `tap at http://uat.example.test/ad-manager/#/account_label for 1234567890` } : undefined,
                  events: status === 'passed' ? [] : [
                    { kind: 'observation', name: 'page', status: 'failed', code: 'ENGINE_FAILURE', durationMs: 12, count: 4, bytes: 3200, phases: { capture: 9, decode: 3 } },
                    { kind: 'engine', name: 'tap', status: 'failed', code: 'ENGINE_FAILURE', durationMs: 4, detail: 'tap at (10, 20)' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const ledger = parseLedger([
  '{"schemaVersion":1,"at":"2026-11-06T02:00:05.000Z","command":"browser.observe","operationSeq":9,"timeoutMs":30000,"ok":false,"effects":"unknown","scopeState":"quarantined","code":"capacity-exceeded","retention":{"retiredOperationSeq":8,"producerState":"retiring","inputDebt":2,"objectDebt":3}}',
  '{"schemaVersion":1,"at":"2026-11-06T02:00:06.000Z","command":"page.title","operationSeq":10,"timeoutMs":1000,"ok":true,"effects":"completed","scopeState":"usable"}',
  'not json',
].join('\n'));

function render(status: 'passed' | 'failed', messages: readonly string[] = []): ReturnType<typeof renderReport> {
  return renderReport({
    report: report(status, messages),
    ledger,
    native: { source: 'executable-environment', version: 'agent-browser 0.39.4', commit: 'b'.repeat(40), sha256: 'c'.repeat(64) },
    packages: { e2e: { version: '0.21.3' }, web: { version: '0.15.3' } },
    settings,
    accountId: '1234567890',
    rawOutput: '/checkout/apps/uat-verification/.e2e',
  });
}

test('the report carries code, native effects/scopeState, phases, and exact builds', () => {
  const rendered = render('failed');
  for (const expected of ['ENGINE_FAILURE', 'capacity-exceeded', 'unknown', 'quarantined', 'capture 9 ms', '0.39.4', '0.21.3', '0.15.3', 'b'.repeat(40)]) {
    assert.equal(rendered.markdown.includes(expected), true, `markdown is missing ${expected}`);
  }
  assert.equal(rendered.sessionExpired, false);
});

test('the report never repeats the host, login host, or account id', () => {
  const rendered = render('failed', ['login at http://sso.example.test/login.html for 1234567890']);
  const text = `${rendered.markdown}\n${JSON.stringify(rendered.json)}`;
  for (const secret of ['uat.example.test', 'sso.example.test', '1234567890']) {
    assert.equal(text.includes(secret), false, `report leaked ${secret}`);
  }
  assert.equal(rendered.markdown.includes('<account-id>'), true);
});

test('an expired session is called out and no product verdict is implied', () => {
  const rendered = render('failed', ['UAT_SESSION_EXPIRED: no saved session exists at /home/u/.config/e2e-uat/session.json. Sign in again: pnpm --filter @e2e-dev/uat-verification login']);
  assert.equal(rendered.sessionExpired, true);
  assert.equal(rendered.markdown.includes('登录态已过期'), true);
});

test('a passed run reports no failures', () => {
  const rendered = render('passed');
  assert.equal(Array.isArray(rendered.json['failures']), true);
  assert.equal((rendered.json['failures'] as unknown[]).length, 0);
  assert.equal(rendered.markdown.includes('无。'), true);
});
