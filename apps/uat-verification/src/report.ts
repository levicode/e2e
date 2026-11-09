/**
 * Turns one run's raw `report.json` plus the native ledger into the redacted,
 * human-readable report the loop exists for.
 *
 * The raw report stays in the gitignored output directory because it carries
 * app log lines and a screen snapshot; this renderer copies only closed facts —
 * statuses, error codes, messages, observation phase timings, native settlement
 * enums, model rounds and token counts — and redacts the UAT host, the login
 * host, the queried account ID, and the configured label from every string it
 * keeps. Reports land under the user's state directory, never in the checkout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NativeIdentity, PackageIdentity } from './identity.ts';
import type { SetupRecord } from './setup.ts';
import type { UatSettings } from './settings.ts';

export interface NativeLedgerEntry {
  readonly at?: string;
  readonly command?: string;
  readonly operationSeq?: number;
  readonly timeoutMs?: number;
  readonly ok?: boolean;
  readonly effects?: string;
  readonly scopeState?: string;
  readonly code?: string;
  readonly retention?: {
    readonly retiredOperationSeq?: number;
    readonly producerState?: string;
    readonly inputDebt?: number;
    readonly objectDebt?: number;
  };
  readonly kind?: string;
}

export interface ReportInputs {
  readonly report: unknown;
  readonly ledger: readonly NativeLedgerEntry[];
  readonly native: NativeIdentity;
  readonly packages: { readonly e2e: PackageIdentity; readonly web: PackageIdentity };
  readonly settings: UatSettings;
  readonly accountId: string;
  readonly rawOutput: string;
  /** Which verification path produced this run. */
  readonly verifyPath: 'scripted' | 'model';
  /** Which browser launch the run used, and how the private settings reached it. */
  readonly browser: BrowserRun;
  /**
   * True when the run attached to a Chromium an operator already started: the
   * loop controls no window, so its mode is reported as unverified.
   */
  readonly operatorWindow?: boolean;
  /** The configured model, recorded even when the run failed before its first call. */
  readonly model?: ModelConfig;
  /** The setup's bounded connection retry, when the run wrote one. */
  readonly setup?: SetupRecord;
}

/** One browser launch: the user's engine launch, or the loop's external Chromium over CDP. */
export interface BrowserRun {
  readonly path: 'cdp' | 'engine';
  /** A visible window: the default, the user's headed run, and the login step; false only for an explicit `--headless`. */
  readonly headed: boolean;
  /** The page viewport, `1440x1000` for the engine launch and `1440x900` for CDP. */
  readonly viewport: string;
  /**
   * Where the private TLS/proxy settings were handed over: the engine's
   * environment (the user's `.env.local` route), the external launch arguments,
   * or nowhere because the private settings named none.
   */
  readonly privateSettings: 'engine-env' | 'external-launch-args' | 'none';
  /** Where CA trust came from: the engine's `AGENT_BROWSER_CA_CERT`, external launch args, or nowhere. */
  readonly caTrust: 'agent-browser-ca-cert' | 'external-launch-args' | 'none';
}

/** The model the run was configured to use; the key and gateway URL never reach a report. */
export interface ModelConfig {
  readonly label: string;
  readonly provider: string;
  readonly model: string;
}

/** One model-backed step's rounds, latency, tokens, and the decisions it made. */
interface ModelStep {
  readonly test: string;
  readonly step: string;
  readonly status?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUsd?: number;
  /** Wall time of the step's model turns, summed from its `model` events. */
  readonly durationMs: number;
  readonly turns: readonly ModelTurn[];
}

/** One model round: the tool calls it proposed and what came back, redacted and bounded. */
interface ModelTurn {
  readonly index: number;
  readonly calls: readonly string[];
  readonly outcome?: string;
}

/** The whole run's model cost: what was configured, what was spent, and where. */
interface ModelReport {
  readonly configured?: ModelConfig;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly durationMs: number;
  readonly tokenAccounting?: string;
  readonly steps: readonly ModelStep[];
}

export interface RenderedReport {
  readonly markdown: string;
  readonly json: Record<string, unknown>;
  /** Set when the run failed because the saved login state no longer works. */
  readonly sessionExpired: boolean;
  /** Set when the run failed because the app or its gateway answered 5xx or nothing at all. */
  readonly appUnreachable: boolean;
}

/** Parses the ledger tolerantly; a truncated or partial final line is dropped. */
export function parseLedger(text: string): NativeLedgerEntry[] {
  const entries: NativeLedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      entries.push(parsed as NativeLedgerEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Renders the redacted markdown and JSON report from one finished run. */
export function renderReport(inputs: ReportInputs): RenderedReport {
  const redact = createRedactor(inputs.settings, inputs.accountId);
  const run = record(inputs.report)?.['run'];
  const runRecord = record(run);
  const status = string(runRecord['status']) ?? 'unknown';
  const results = array(runRecord['results']).map(record);
  const runErrors = array(runRecord['errors']).map(record);
  const vcs = record(runRecord['vcs']);
  const environment = record(runRecord['environment']);
  const sessionExpired = [...runErrors, ...results.flatMap(result => allErrors(result))].some(error => (string(error['message']) ?? '').includes('UAT_SESSION_EXPIRED'));
  const appUnreachable = [...runErrors, ...results.flatMap(result => allErrors(result))].some(error => (string(error['message']) ?? '').includes('UAT_APP_UNREACHABLE'));

  const failures = collectFailures(results, redact);
  const observations = collectObservations(results, redact);
  const engineEvents = collectEngineEvents(results, redact);
  const model = collectModel(results, redact, inputs.model);

  const markdown = markdownReport({
    inputs, redact, status, runErrors, vcs, environment, failures, observations, engineEvents, sessionExpired, appUnreachable, model,
  });
  const json = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    path: inputs.verifyPath,
    browser: inputs.browser,
    exitCode: number(runRecord['exitCode']),
    runId: string(runRecord['id']),
    startedAt: string(runRecord['startedAt']),
    finishedAt: string(runRecord['finishedAt']),
    identity: {
      e2e: { ...inputs.packages.e2e, commit: string(vcs['commit']), branch: string(vcs['branch']), dirty: boolean(vcs['dirty']) },
      web: inputs.packages.web,
      native: inputs.native,
      environment: { os: string(environment['os']), arch: string(environment['arch']), runtime: string(environment['runtime']) },
    },
    scenario: scenarioText(inputs.verifyPath),
    sessionExpired,
    appUnreachable,
    ...(inputs.setup === undefined ? {} : { setup: inputs.setup }),
    model,
    failures,
    observations,
    engineEvents,
    native: {
      total: inputs.ledger.filter(entry => entry.kind === undefined).length,
      failures: inputs.ledger.filter(entry => entry.ok === false).map(redactLedger),
      entries: inputs.ledger.map(redactLedger),
    },
    rawOutput: inputs.rawOutput,
  };
  return { markdown, json, sessionExpired, appUnreachable };
}

/** Writes both report files under one run directory and returns their paths. */
export function writeReport(directory: string, report: RenderedReport): { markdown: string; json: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const markdown = path.join(directory, 'report.md');
  const json = path.join(directory, 'report.json');
  writeFileSync(markdown, report.markdown, { mode: 0o600 });
  writeFileSync(json, `${JSON.stringify(report.json, null, 2)}\n`, { mode: 0o600 });
  return { markdown, json };
}

/** A redactor that keeps every private value out of what the report repeats. */
function createRedactor(settings: UatSettings, accountId: string): (text: string) => string {
  const entry = new URL(settings.entryUrl);
  const rules: Array<readonly [RegExp, string]> = [];
  if (accountId.length >= 4) rules.push([new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(accountId)}(?![0-9A-Za-z])`, 'g'), '<account-id>']);
  if (settings.labelId !== undefined && settings.labelId.length >= 4) rules.push([new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(settings.labelId)}(?![0-9A-Za-z])`, 'g'), '<label-id>']);
  if (settings.labelName !== undefined && settings.labelName !== '') rules.push([new RegExp(escapeRegExp(settings.labelName), 'g'), '<label-name>']);
  rules.push([new RegExp(escapeRegExp(settings.entryUrl), 'g'), '<uat-entry>']);
  rules.push([new RegExp(escapeRegExp(entry.host), 'g'), '<uat-host>']);
  if (settings.loginUrl !== undefined) {
    const login = new URL(settings.loginUrl);
    rules.push([new RegExp(escapeRegExp(login.host), 'g'), '<sso-host>']);
  }
  return text => rules.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

function redactLedger(entry: NativeLedgerEntry): NativeLedgerEntry {
  return {
    ...(entry.at === undefined ? {} : { at: entry.at }),
    ...(entry.command === undefined ? {} : { command: entry.command }),
    ...(entry.operationSeq === undefined ? {} : { operationSeq: entry.operationSeq }),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.ok === undefined ? {} : { ok: entry.ok }),
    ...(entry.effects === undefined ? {} : { effects: entry.effects }),
    ...(entry.scopeState === undefined ? {} : { scopeState: entry.scopeState }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.retention === undefined ? {} : { retention: entry.retention }),
  };
}

interface Failure {
  readonly test: string;
  readonly where: string;
  readonly code?: string;
  readonly message?: string;
  readonly native?: { readonly code?: string; readonly effects?: string; readonly scopeState?: string };
}

interface Observation {
  readonly test: string;
  readonly step: string;
  readonly name?: string;
  readonly status?: string;
  readonly code?: string;
  readonly durationMs?: number;
  readonly count?: number;
  readonly bytes?: number;
  readonly phases?: Readonly<Record<string, number>>;
}

interface EngineEvent {
  readonly test: string;
  readonly step: string;
  readonly name?: string;
  readonly status?: string;
  readonly code?: string;
  readonly durationMs?: number;
  readonly detail?: string;
}

function collectFailures(results: readonly Record<string, unknown>[], redact: (text: string) => string): Failure[] {
  const failures: Failure[] = [];
  for (const result of results) {
    const test = testTitle(result, redact);
    for (const attempt of array(result['attempts']).map(record)) {
      pushFailure(failures, test, 'attempt', record(attempt['error']), redact);
      for (const step of array(attempt['steps']).map(record)) {
        const where = stepLabel(step, redact);
        pushFailure(failures, test, where, record(step['error']), redact);
        for (const event of array(step['events']).map(record)) {
          if (string(event['status']) !== 'failed' && string(event['status']) !== 'cancelled') continue;
          if (event['code'] === undefined) continue;
          const detail = string(event['detail']);
          const code = string(event['code']);
          const name = string(event['name']);
          failures.push({
            test,
            where: `${where} · ${string(event['kind']) ?? 'event'} ${name ?? ''}`.trim(),
            ...(code === undefined ? {} : { code }),
            ...(detail === undefined ? {} : { message: redact(detail) }),
            ...nativeEvidence(detail ?? ''),
          });
        }
      }
    }
  }
  return dedupe(failures);
}

function pushFailure(failures: Failure[], test: string, where: string, error: Record<string, unknown>, redact: (text: string) => string): void {
  const rawCode = string(error['code']);
  const message = string(error['message']);
  if (rawCode === undefined && message === undefined) return;
  // A plain thrown Error reaches the raw report as `ERROR`; this loop's own
  // codes live at the start of the message, so the report names them instead.
  const code = (rawCode === undefined || rawCode === 'ERROR') && message !== undefined ? appCode(message) ?? rawCode : rawCode;
  const redacted = message === undefined ? undefined : redact(message);
  failures.push({
    test,
    where,
    ...(code === undefined ? {} : { code }),
    ...(redacted === undefined ? {} : { message: redacted }),
    ...nativeEvidence(redacted ?? ''),
  });
}

/** This loop's own code, when a thrown message begins with it: `UAT_APP_UNREACHABLE: …`. */
function appCode(message: string): string | undefined {
  return /^(UAT_[A-Z0-9_]+):/.exec(message)?.[1];
}

/** The native tuple the web engine appends to an uncertain action's message, when present. */
function nativeEvidence(message: string): { native?: { code?: string; effects?: string; scopeState?: string } } {
  const match = /\(native ([^;)]+); effects ([^;)]+); scope ([^)]+)\)/.exec(message);
  if (match === null) return {};
  const [, code, effects, scopeState] = match;
  if (code === undefined || effects === undefined || scopeState === undefined) return {};
  return { native: { code, effects, scopeState } };
}

function collectObservations(results: readonly Record<string, unknown>[], redact: (text: string) => string): Observation[] {
  const observations: Observation[] = [];
  for (const result of results) {
    const test = testTitle(result, redact);
    for (const attempt of array(result['attempts']).map(record)) {
      for (const step of array(attempt['steps']).map(record)) {
        const stepName = stepLabel(step, redact);
        for (const event of array(step['events']).map(record)) {
          if (string(event['kind']) !== 'observation') continue;
          const name = string(event['name']);
          const status = string(event['status']);
          const code = string(event['code']);
          const durationMs = number(event['durationMs']);
          const count = number(event['count']);
          const bytes = number(event['bytes']);
          observations.push({
            test,
            step: stepName,
            ...(name === undefined ? {} : { name }),
            ...(status === undefined ? {} : { status }),
            ...(code === undefined ? {} : { code }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(count === undefined ? {} : { count }),
            ...(bytes === undefined ? {} : { bytes }),
            ...(isPhaseMap(event['phases']) ? { phases: event['phases'] as Record<string, number> } : {}),
          });
        }
      }
    }
  }
  return observations;
}

function collectEngineEvents(results: readonly Record<string, unknown>[], redact: (text: string) => string): EngineEvent[] {
  const events: EngineEvent[] = [];
  for (const result of results) {
    const test = testTitle(result, redact);
    for (const attempt of array(result['attempts']).map(record)) {
      for (const step of array(attempt['steps']).map(record)) {
        const stepName = stepLabel(step, redact);
        for (const event of array(step['events']).map(record)) {
          if (string(event['kind']) !== 'engine') continue;
          if (string(event['status']) === 'passed') continue;
          const name = string(event['name']);
          const status = string(event['status']);
          const code = string(event['code']);
          const durationMs = number(event['durationMs']);
          const detail = string(event['detail']);
          events.push({
            test,
            step: stepName,
            ...(name === undefined ? {} : { name }),
            ...(status === undefined ? {} : { status }),
            ...(code === undefined ? {} : { code }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(detail === undefined ? {} : { detail: redact(detail) }),
          });
        }
      }
    }
  }
  return events;
}

function collectModel(
  results: readonly Record<string, unknown>[],
  redact: (text: string) => string,
  configured: ModelConfig | undefined,
): ModelReport | undefined {
  const steps: ModelStep[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCostUsd = 0;
  let durationMs = 0;
  let tokenAccounting: string | undefined;
  for (const result of results) {
    const test = testTitle(result, redact);
    for (const attempt of array(result['attempts']).map(record)) {
      for (const step of array(attempt['steps']).map(record)) {
        const info = record(step['model']);
        const events = array(step['events']).map(record);
        const stepCalls = number(info['calls']) ?? events.filter(event => string(event['kind']) === 'model').length;
        if (stepCalls === 0 && Object.keys(info).length === 0) continue;
        const stepDuration = events
          .filter(event => string(event['kind']) === 'model')
          .reduce((total, event) => total + (number(event['durationMs']) ?? 0), 0);
        const stepInput = number(info['inputTokens']) ?? 0;
        const stepOutput = number(info['outputTokens']) ?? 0;
        const stepCacheRead = number(info['cacheReadTokens']);
        const stepCacheWrite = number(info['cacheWriteTokens']);
        const stepCost = number(info['estimatedCostUsd']);
        calls += stepCalls;
        inputTokens += stepInput;
        outputTokens += stepOutput;
        cacheReadTokens += stepCacheRead ?? 0;
        cacheWriteTokens += stepCacheWrite ?? 0;
        estimatedCostUsd += stepCost ?? 0;
        durationMs += stepDuration;
        tokenAccounting ??= string(info['tokenAccounting']);
        const stepStatus = string(step['status']);
        const stepProvider = string(info['provider']);
        const stepModel = string(info['model']);
        steps.push({
          test,
          step: stepLabel(step, redact),
          ...(stepStatus === undefined ? {} : { status: stepStatus }),
          ...(stepProvider === undefined ? {} : { provider: stepProvider }),
          ...(stepModel === undefined ? {} : { model: stepModel }),
          calls: stepCalls,
          inputTokens: stepInput,
          outputTokens: stepOutput,
          ...(stepCacheRead === undefined ? {} : { cacheReadTokens: stepCacheRead }),
          ...(stepCacheWrite === undefined ? {} : { cacheWriteTokens: stepCacheWrite }),
          ...(stepCost === undefined ? {} : { estimatedCostUsd: stepCost }),
          durationMs: stepDuration,
          turns: collectTurns(step, redact),
        });
      }
    }
  }
  if (steps.length === 0 && configured === undefined) return undefined;
  return {
    ...(configured === undefined ? {} : { configured }),
    calls,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(estimatedCostUsd === 0 ? {} : { estimatedCostUsd }),
    durationMs,
    ...(tokenAccounting === undefined ? {} : { tokenAccounting }),
    steps,
  };
}

/** The model's own rounds for one step: what it proposed and what the screen said back. */
function collectTurns(step: Record<string, unknown>, redact: (text: string) => string): ModelTurn[] {
  const turns: ModelTurn[] = [];
  for (const turn of array(step['turns']).map(record)) {
    const index = number(turn['index']);
    if (index === undefined) continue;
    const calls = array(turn['calls']).filter((call): call is string => typeof call === 'string').map(call => redact(call).slice(0, 400));
    const outcome = string(turn['outcome']);
    turns.push({
      index,
      calls,
      ...(outcome === undefined ? {} : { outcome: redact(outcome).slice(0, 800) }),
    });
  }
  return turns;
}

function markdownReport(input: {
  readonly inputs: ReportInputs;
  readonly redact: (text: string) => string;
  readonly status: string;
  readonly runErrors: readonly Record<string, unknown>[];
  readonly vcs: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly failures: readonly Failure[];
  readonly observations: readonly Observation[];
  readonly engineEvents: readonly EngineEvent[];
  readonly sessionExpired: boolean;
  readonly appUnreachable: boolean;
  readonly model: ModelReport | undefined;
}): string {
  const { inputs, redact } = input;
  const run = record(record(input.inputs.report)['run']);
  const lines: string[] = [];
  const e2eVersion = inputs.packages.e2e.version ?? 'unknown';
  const webVersion = inputs.packages.web.version ?? 'unknown';
  const commit = string(input.vcs['commit']);
  const dirty = boolean(input.vcs['dirty']);
  const nativeCommit = inputs.native.commit;
  const nativeVersion = inputs.native.version?.replace(/^agent-browser\s+/i, '');

  lines.push(`# UAT 验证报告 — ${input.status}（${windowText(inputs.browser, inputs.operatorWindow)}）`, '');
  // The window mode is part of the verdict: a headless pass is not the run the user sees.
  lines.push(windowNote(inputs.browser, inputs.operatorWindow), '');
  if (input.sessionExpired) lines.push('> **登录态已过期**：本次没有产生产品结论。重新运行 `pnpm --filter @e2e-dev/uat-verification login` 扫码一次后再验证。', '');
  if (input.appUnreachable) {
    lines.push('> **被测应用/网关不可达（连接类失败）**：本次没有产生产品结论，也不是登录态问题——不要重新扫码登录。失败码 `UAT_APP_UNREACHABLE` 带实际状态码与耗时，setup 的重试次数与间隔见下文。', '');
  }
  lines.push('## 运行', '');
  lines.push(`- 结论：\`${input.status}\`（exit ${String(number(run['exitCode']) ?? '?')}）`);
  lines.push(`- 开始：${string(run['startedAt']) ?? '?'}`);
  lines.push(`- 结束：${string(run['finishedAt']) ?? '?'}`);
  lines.push(`- 被测版本：`);
  lines.push(`  - \`e2e\` ${e2eVersion}${commit === undefined ? '' : ` @ \`${commit}${dirty === true ? ' (dirty)' : ''}\``}`);
  lines.push(`  - \`@e2e-dev/web\` ${webVersion}`);
  const native = [`\`agent-browser\` ${nativeVersion ?? 'unknown'}`];
  if (nativeCommit !== undefined) native.push(`@ \`${nativeCommit}\``);
  else if (inputs.native.source === 'executable-environment') native.push('· 构建提交未验证');
  if (inputs.native.source === 'executable-environment' && inputs.native.sha256 !== undefined) native.push(`· sha256 \`${inputs.native.sha256}\``);
  lines.push(`  - ${native.join(' ')}`);
  if (inputs.native.source === 'executable-environment' && nativeCommit === undefined) {
    lines.push('  - 原生提交未验证：没有与该 sha256 匹配的 native build record（`native-build.json`）；报告不会用所在 git 检出的 HEAD 代替。在 pin 检出构建后运行 `pnpm --filter @e2e-dev/uat-verification native:record` 记录。');
  }
  if (inputs.native.source === 'unknown') lines.push('  - 原生身份未知：没有 verified runtime 描述符，也没有设置 `E2E_AGENT_BROWSER_EXECUTABLE`。');
  lines.push(`- 环境：${string(input.environment['os']) ?? '?'} / ${string(input.environment['arch']) ?? '?'} · Node ${nodeVersion(string(input.environment['runtime']))}`);
  lines.push(`- 验证路径：\`${inputs.verifyPath}\`${inputs.verifyPath === 'model' ? '（真实模型决策，错误决策按原样保留，retries=0）' : '（脚本化确定性回归基线）'}`);
  lines.push(`- 浏览器启动：${browserLaunchText(inputs.browser, inputs.operatorWindow)}`);
  if (input.model?.configured !== undefined) lines.push(`- 模型：\`${input.model.configured.label}\``);
  lines.push(`- 场景：${scenarioText(inputs.verifyPath)}（账号 ID 与标签已脱敏）`);
  lines.push(`- 原始输出（本机、未提交）：\`${inputs.rawOutput}\``, '');

  lines.push('## 用例', '');
  lines.push('| 用例 | 状态 | 尝试 | 耗时 (ms) |', '| --- | --- | ---: | ---: |');
  for (const result of array(run['results']).map(record)) {
    const attempts = array(result['attempts']).map(record);
    const duration = attempts.reduce((total, attempt) => total + (number(attempt['durationMs']) ?? 0), 0);
    lines.push(`| ${cell(testTitle(result, redact))} | ${cell(string(result['status']) ?? '?')} | ${attempts.length} | ${duration} |`);
  }
  lines.push('');

  lines.push('## Setup 连接重试', '');
  const setup = inputs.setup;
  if (setup === undefined) {
    lines.push('本次没有 setup 尝试记录（报告不是由 `verify` 渲染，或 setup 未运行）。', '');
  } else {
    const retries = Math.max(0, setup.attempts.length - 1);
    const budget = setup.retryDelaysMs.map(ms => `${ms} ms`).join('、');
    lines.push(`- 结果：\`${setup.outcome}\`；尝试 ${setup.attempts.length} 次（重试 ${retries} 次）；重试预算 ${budget === '' ? '无' : budget}。`);
    lines.push('- 只有 setup 阶段的连接类失败（5xx、连接重置、超时）会重试；业务动作阶段保持 `retries: 0`，失败按原样保留。');
    lines.push('', '| 尝试 | 开始 | 耗时 (ms) | HTTP | 结果 |', '| ---: | --- | ---: | --- | --- |');
    for (const attempt of setup.attempts) {
      const http = attempt.status === undefined ? '—' : attempt.status === 0 ? '无响应' : String(attempt.status);
      lines.push(`| ${attempt.attempt} | ${attempt.startedAt} | ${attempt.durationMs} | ${http} | ${attempt.outcome} |`);
    }
    lines.push('');
  }

  lines.push('## 失败', '');
  if (input.failures.length === 0) lines.push('无。', '');
  for (const failure of input.failures) {
    lines.push(`### ${cell(failure.test)} · ${cell(failure.where)}`);
    lines.push('');
    lines.push(`- 错误码：\`${failure.code ?? 'unknown'}\``);
    if (failure.message !== undefined) lines.push(`- 消息：${failure.message.replace(/\n/g, ' ').slice(0, 2000)}`);
    if (failure.native !== undefined) {
      lines.push(`- 原生证据：code \`${failure.native.code ?? '?'}\` · effects \`${failure.native.effects ?? '?'}\` · scopeState \`${failure.native.scopeState ?? '?'}\``);
    }
    lines.push('');
  }
  if (input.runErrors.length > 0) {
    lines.push('### 运行级错误', '');
    for (const error of input.runErrors) {
      lines.push(`- \`${string(error['code']) ?? 'unknown'}\`：${(redact(string(error['message']) ?? '')).slice(0, 2000)}`);
    }
    lines.push('');
  }

  lines.push('## 模型轮次与成本', '');
  if (input.model === undefined || input.model.calls === 0 && input.model.configured === undefined) {
    lines.push('本路径不调用模型。', '');
  } else {
    const model = input.model;
    lines.push(`- 配置模型：${model.configured === undefined ? '`unknown`' : `\`${model.configured.label}\``}`);
    lines.push(`- 调用轮次：${model.calls}；模型耗时：${model.durationMs} ms；token：输入 ${model.inputTokens} / 输出 ${model.outputTokens}${model.tokenAccounting === undefined ? '' : `（${model.tokenAccounting}）`}${model.estimatedCostUsd === undefined ? '' : `；估算成本 $${model.estimatedCostUsd}`}`);
    if (model.steps.length > 0) {
      lines.push('', '| 步骤 | 状态 | 轮次 | 耗时 (ms) | 输入 token | 输出 token | 缓存读/写 | 估算成本 |', '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |');
      for (const step of model.steps) {
        lines.push(`| ${cell(step.step)} | ${cell(step.status ?? '?')} | ${step.calls} | ${step.durationMs} | ${step.inputTokens} | ${step.outputTokens} | ${step.cacheReadTokens ?? 0} / ${step.cacheWriteTokens ?? 0} | ${step.estimatedCostUsd === undefined ? '—' : `$${step.estimatedCostUsd}`} |`);
      }
      lines.push('');
      lines.push('- 模型耗时只统计 `model` 事件的轮次时间；整步耗时见上面的用例表，观察阶段见下一节。');
    }
    lines.push('');
  }

  lines.push('## 模型决策与动作', '');
  if (input.model === undefined || input.model.steps.length === 0) {
    lines.push('本路径没有模型决策记录。', '');
  } else {
    for (const step of input.model.steps) {
      lines.push(`### ${cell(step.test)} · ${cell(step.step)}`);
      lines.push('');
      if (step.turns.length === 0) {
        lines.push('没有保留的轮次记录；以失败与观察事件为准。', '');
        continue;
      }
      for (const turn of step.turns) {
        lines.push(`- 第 ${turn.index} 轮：${turn.calls.length === 0 ? '（无工具调用）' : turn.calls.map(call => `\`${cell(call)}\``).join('；')}${turn.outcome === undefined ? '' : ` → ${cell(turn.outcome)}`}`);
      }
      lines.push('');
    }
    lines.push('- 这些是模型实际提出的动作与得到的结果，未因结果不符而自动重试或替换；失败码与原生证据见上一节。', '');
  }

  lines.push('## 观察与阶段', '');
  if (input.observations.length === 0) lines.push('本次运行没有 agent 观察事件（固定场景需要通过 agent 步骤驱动才会产生 phases）。', '');
  if (input.observations.length > 0) {
    lines.push('| 步骤 | 状态 | 代码 | count | bytes | 耗时 (ms) | phases |', '| --- | --- | --- | ---: | ---: | ---: | --- |');
    for (const observation of input.observations) {
      lines.push(`| ${cell(observation.step)} | ${cell(observation.status ?? '?')} | ${observation.code === undefined ? '—' : `\`${observation.code}\``} | ${observation.count ?? ''} | ${observation.bytes ?? ''} | ${observation.durationMs ?? ''} | ${cell(phaseText(observation.phases))} |`);
    }
    lines.push('');
  }

  lines.push('## 引擎事件（失败/取消）', '');
  if (input.engineEvents.length === 0) lines.push('无。', '');
  for (const event of input.engineEvents) {
    lines.push(`- \`${event.code ?? 'unknown'}\` · ${event.name ?? 'engine'} · ${cell(event.status ?? '?')} · ${event.durationMs ?? '?'} ms${event.detail === undefined ? '' : ` · ${cell(event.detail)}`}`);
  }
  lines.push('');

  lines.push('## 原生操作（native ledger）', '');
  const entries = inputs.ledger.filter(entry => entry.kind === undefined);
  const failed = entries.filter(entry => entry.ok === false);
  lines.push(`- 共 ${entries.length} 条，失败 ${failed.length} 条。`);
  if (failed.length > 0) {
    lines.push('', '| seq | command | timeout (ms) | effects | scopeState | code | inputDebt | objectDebt |', '| ---: | --- | ---: | --- | --- | --- | ---: | ---: |');
    for (const entry of failed) {
      const retention = entry.retention ?? {};
      lines.push(`| ${entry.operationSeq ?? ''} | ${cell(entry.command ?? '')} | ${entry.timeoutMs ?? ''} | ${entry.effects ?? ''} | ${entry.scopeState ?? ''} | \`${entry.code ?? ''}\` | ${retention.inputDebt ?? ''} | ${retention.objectDebt ?? ''} |`);
    }
  }
  lines.push('');

  lines.push('## 说明与限制', '');
  lines.push('- 本报告只含状态、错误码、阶段耗时、模型轮次与 token、原生结算枚举；原始 report/trace/截图仅留在上面的本机目录，未提交、未发布。');
  lines.push('- `effects` / `scopeState` 来自原生操作记录（`E2E_NATIVE_RESULT_LEDGER`）；`phases` 来自 agent 观察事件。');
  lines.push('- `agent-browser` 的提交只在 native build record 的 sha256 与二进制一致时显示；记录与二进制不一致时会在启动浏览器前以 `UAT_NATIVE_IDENTITY_MISMATCH` 失败，而不是静默显示一个它没有构建的提交。');
  if (input.inputs.verifyPath === 'model') {
    lines.push('- 模型路径只对私有配置指定的账号执行“新增标签 → 断言 → 移除标签 → 断言复原”，不触碰其他账号或标签；中途失败时报告如实保留失败决策与残留状态，不自动重试掩盖。');
  } else {
    lines.push('- 脚本化路径只做查询；写入类验证由模型路径单独执行，需要私有配置指定账号与标签。');
  }
  if (inputs.browser.path === 'engine' && inputs.browser.privateSettings === 'engine-env') {
    lines.push('- 引擎自启路径把私有 `AGENT_BROWSER_*` 变量交给引擎，和用户项目的 `.env.local` 一样；原生隔离传输会在 Chromium 启动前剥离它们，所以它们是否生效要看该路径的结果，报告不假设已生效。');
  }
  lines.push('');
  return lines.join('\n');
}

function testTitle(result: Record<string, unknown>, redact: (text: string) => string): string {
  const titlePath = array(result['titlePath']).filter((part): part is string => typeof part === 'string');
  return redact(titlePath.length === 0 ? (string(result['testId']) ?? 'test') : titlePath.join(' › '));
}

function stepLabel(step: Record<string, unknown>, redact: (text: string) => string): string {
  const label = string(step['label']);
  const api = string(step['api']) ?? 'step';
  return redact(label === undefined || label === '' ? api : `${api} · ${label}`).slice(0, 160);
}

function allErrors(result: Record<string, unknown>): Record<string, unknown>[] {
  return array(result['attempts']).map(record).flatMap(attempt => [record(attempt['error']), ...array(attempt['steps']).map(record).map(step => record(step['error']))])
    .filter(error => Object.keys(error).length > 0);
}

function dedupe(failures: readonly Failure[]): Failure[] {
  const seen = new Set<string>();
  return failures.filter(failure => {
    const key = `${failure.test}\u0000${failure.where}\u0000${failure.code ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The slowest phases, with the count; the JSON report keeps every phase. */
function phaseText(phases: Readonly<Record<string, number>> | undefined): string {
  if (phases === undefined) return '';
  const entries = Object.entries(phases);
  if (entries.length === 0) return '';
  const slowest = entries.toSorted(([, left], [, right]) => right - left).slice(0, 5);
  const more = entries.length - slowest.length;
  return `${entries.length} phases · ${slowest.map(([name, ms]) => `${name} ${ms} ms`).join(', ')}${more > 0 ? ` (+${more})` : ''}`;
}

function nodeVersion(runtime: string | undefined): string {
  return runtime === undefined ? '?' : runtime.replace(/^node\s+/i, '');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Which launch opened the browser, in the words the report can show. */
function browserLaunchText(browser: BrowserRun, operatorWindow: boolean | undefined): string {
  const window = windowText(browser, operatorWindow);
  const settings = browser.privateSettings === 'engine-env'
    ? '代理经引擎环境变量（`AGENT_BROWSER_*`）'
    : browser.privateSettings === 'external-launch-args'
      ? '代理经外部启动参数'
      : '未配置私有代理';
  const ca = browser.caTrust === 'agent-browser-ca-cert'
    ? 'CA 信任经 `AGENT_BROWSER_CA_CERT`（内核按该文件放行）'
    : browser.caTrust === 'external-launch-args'
      ? 'CA 信任经外部启动参数'
      : '未配置私有 CA';
  return browser.path === 'engine'
    ? `${window} · 引擎自启（\`engine\`，${browser.viewport} 视口；${settings}；${ca}）`
    : `${window} · 外部启动 + CDP 连接（\`cdp\`，${browser.viewport} 视口；${settings}；${ca}）`;
}

/** The window mode the report and the console name. */
function windowText(browser: BrowserRun, operatorWindow: boolean | undefined): string {
  if (operatorWindow === true) return '窗口模式未验证';
  return browser.headed ? '有界面' : '无头';
}

/** The sentence under the report title that explains the window mode. */
function windowNote(browser: BrowserRun, operatorWindow: boolean | undefined): string {
  if (operatorWindow === true) {
    return '> 窗口模式：**未验证**（本次连接到操作者已启动的 Chromium，循环不控制该窗口；`--headless` 也不会隐藏它）';
  }
  return browser.headed
    ? '> 窗口模式：**有界面**（默认，与用户 `--headed` 运行一致）'
    : '> 窗口模式：**无头**（显式 `--headless`，与用户实际运行不同）';
}

/** What each path walked, in the words the report can show after redaction. */
function scenarioText(verifyPath: 'scripted' | 'model'): string {
  return verifyPath === 'model'
    ? 'login → home → 账号管理 → 账号标签管理 → account ID → 查询 → 新增标签 → 断言 → 移除标签 → 断言复原 (model-decided; writes only the configured account and label)'
    : 'login → home → 账号管理 → 账号标签管理 → account ID → 查询 (read-only, scripted)';
}

function isPhaseMap(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'number');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
