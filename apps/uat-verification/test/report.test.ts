import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLedger, renderReport } from '../src/report.ts';
import type { UatSettings } from '../src/settings.ts';

const settings: UatSettings = {
  entryUrl: 'http://uat.example.test/ad-manager/',
  loginUrl: 'http://sso.example.test/login.html',
  accountId: '1234567890',
  labelId: '87654321',
  labelName: '内部标签',
  homeHash: '#/home',
  sessionFile: '/private/session.json',
  env: {},
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

/** One failed model step: a wrong decision, its two rounds, and the usage the provider reported. */
function modelReport(): unknown {
  const base = report('failed');
  const run = (base as { run: { results: Array<{ attempts: Array<{ steps: unknown[] }> }> } }).run;
  const step = run.results[0]!.attempts[0]!.steps[0] as Record<string, unknown>;
  step['status'] = 'failed';
  step['model'] = {
    provider: 'openai.responses',
    model: 'deepseek-v4.1-flash',
    endpoint: 'provider-default',
    adapterVersion: '7.0.153',
    policyVersion: '1',
    calls: 2,
    tokenAccounting: 'provider',
    peakTokensPerCall: 80,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 10,
    estimatedCostUsd: 0.0012,
  };
  step['turns'] = [
    { index: 1, calls: ['tap({"target":"n19"})'], outcome: 'tapped 编辑' },
    { index: 2, calls: ['tap({"target":"n404"})'], outcome: 'LOCATOR_NOT_FOUND: node not on screen' },
  ];
  step['events'] = [
    { kind: 'model', status: 'passed', durationMs: 400, inputTokens: 60, outputTokens: 15 },
    { kind: 'model', status: 'failed', durationMs: 250, inputTokens: 60, outputTokens: 15 },
    { kind: 'observation', status: 'passed', durationMs: 12, count: 4, bytes: 3200, phases: { capture: 9, decode: 3 } },
  ];
  step['error'] = { code: 'LOCATOR_NOT_FOUND', message: 'node n404 is not on the current screen' };
  return base;
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
    verifyPath: 'scripted',
  });
}

test('the report carries code, native effects/scopeState, phases, and exact builds', () => {
  const rendered = render('failed');
  for (const expected of ['ENGINE_FAILURE', 'capacity-exceeded', 'unknown', 'quarantined', 'capture 9 ms', '0.39.4', '0.21.3', '0.15.3', 'b'.repeat(40)]) {
    assert.equal(rendered.markdown.includes(expected), true, `markdown is missing ${expected}`);
  }
  assert.equal(rendered.sessionExpired, false);
  assert.equal(rendered.json['path'], 'scripted');
});

test('the report never repeats the host, login host, account id, or configured label', () => {
  const rendered = render('failed', [`login at http://sso.example.test/login.html for 1234567890 with 内部标签 87654321`]);
  const text = `${rendered.markdown}\n${JSON.stringify(rendered.json)}`;
  for (const secret of ['uat.example.test', 'sso.example.test', '1234567890', '内部标签', '87654321']) {
    assert.equal(text.includes(secret), false, `report leaked ${secret}`);
  }
  assert.equal(rendered.markdown.includes('<account-id>'), true);
  assert.equal(rendered.markdown.includes('<label-name>'), true);
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

test('the model path records rounds, latency, tokens, and the wrong decision as made', () => {
  const rendered = renderReport({
    report: modelReport(),
    ledger,
    native: { source: 'runtime-descriptor', commit: 'b'.repeat(40) },
    packages: { e2e: { version: '0.21.3' }, web: { version: '0.15.3' } },
    settings,
    accountId: '1234567890',
    rawOutput: '/checkout/apps/uat-verification/.e2e-model',
    verifyPath: 'model',
    model: { label: 'openai.responses/deepseek-v4.1-flash', provider: 'openai.responses', model: 'deepseek-v4.1-flash' },
  });
  assert.equal(rendered.json['path'], 'model');
  const model = rendered.json['model'] as Record<string, unknown>;
  assert.equal(model['calls'], 2);
  assert.equal(model['durationMs'], 650);
  assert.equal(model['inputTokens'], 120);
  assert.equal(model['outputTokens'], 30);
  assert.equal(model['cacheReadTokens'], 10);
  const steps = model['steps'] as Array<Record<string, unknown>>;
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!['turns'], [
    { index: 1, calls: ['tap({"target":"n19"})'], outcome: 'tapped 编辑' },
    { index: 2, calls: ['tap({"target":"n404"})'], outcome: 'LOCATOR_NOT_FOUND: node not on screen' },
  ]);
  for (const expected of ['openai.responses/deepseek-v4.1-flash', 'LOCATOR_NOT_FOUND', '第 1 轮', '第 2 轮', 'n404', '模型轮次与成本', '模型决策与动作']) {
    assert.equal(rendered.markdown.includes(expected), true, `markdown is missing ${expected}`);
  }
});

test('an explicit binary without a build record shows its digest and marks the commit unverified', () => {
  const rendered = renderReport({
    report: report('passed'),
    ledger,
    native: {
      source: 'executable-environment',
      version: 'agent-browser 0.39.4',
      sha256: 'c'.repeat(64),
      checkout: { commit: 'd'.repeat(40), dirty: false },
    },
    packages: { e2e: { version: '0.21.3' }, web: { version: '0.15.3' } },
    settings,
    accountId: '1234567890',
    rawOutput: '/checkout/apps/uat-verification/.e2e',
    verifyPath: 'scripted',
  });
  assert.equal(rendered.markdown.includes('构建提交未验证'), true);
  assert.equal(rendered.markdown.includes(`sha256 \`${'c'.repeat(64)}\``), true);
  assert.equal(rendered.markdown.includes(`@ \`${'d'.repeat(40)}\``), false);
  const native = (rendered.json['identity'] as Record<string, unknown>)['native'] as Record<string, unknown>;
  assert.equal(native['commit'], undefined);
  assert.equal(native['sha256'], 'c'.repeat(64));
});

test('a model run that failed before its first call still names the configured model', () => {
  const rendered = renderReport({
    report: report('failed'),
    ledger,
    native: { source: 'runtime-descriptor', commit: 'b'.repeat(40) },
    packages: { e2e: { version: '0.21.3' }, web: { version: '0.15.3' } },
    settings,
    accountId: '1234567890',
    rawOutput: '/checkout/apps/uat-verification/.e2e-model',
    verifyPath: 'model',
    model: { label: 'openai.responses/deepseek-v4.1-flash', provider: 'openai.responses', model: 'deepseek-v4.1-flash' },
  });
  const model = rendered.json['model'] as Record<string, unknown>;
  assert.equal(model['calls'], 0);
  assert.equal(rendered.markdown.includes('openai.responses/deepseek-v4.1-flash'), true);
});
