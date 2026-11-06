/**
 * Turns one run's raw `report.json` plus the native ledger into the redacted,
 * human-readable report the loop exists for.
 *
 * The raw report stays in the gitignored output directory because it carries
 * app log lines and a screen snapshot; this renderer copies only closed facts —
 * statuses, error codes, messages, observation phase timings, native settlement
 * enums, retention counters — and redacts the UAT host, the login host, and the
 * queried account ID from every string it keeps. Reports land under the user's
 * state directory, never in the checkout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NativeIdentity, PackageIdentity } from './identity.ts';
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
}

export interface RenderedReport {
  readonly markdown: string;
  readonly json: Record<string, unknown>;
  /** Set when the run failed because the saved login state no longer works. */
  readonly sessionExpired: boolean;
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

  const failures = collectFailures(results, redact);
  const observations = collectObservations(results, redact);
  const engineEvents = collectEngineEvents(results, redact);

  const markdown = markdownReport({
    inputs, redact, status, runErrors, vcs, environment, failures, observations, engineEvents, sessionExpired,
  });
  const json = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
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
    scenario: 'login → home → 账号管理 → 账号标签管理 → account ID → 查询 (read-only)',
    sessionExpired,
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
  return { markdown, json, sessionExpired };
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
  if (settings.labelId !== undefined && settings.labelId !== '') rules.push([new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(settings.labelId)}(?![0-9A-Za-z])`, 'g'), '<label-id>']);
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
  const code = string(error['code']);
  const message = string(error['message']);
  if (code === undefined && message === undefined) return;
  const redacted = message === undefined ? undefined : redact(message);
  failures.push({
    test,
    where,
    ...(code === undefined ? {} : { code }),
    ...(redacted === undefined ? {} : { message: redacted }),
    ...nativeEvidence(redacted ?? ''),
  });
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

  lines.push(`# UAT 验证报告 — ${input.status}`, '');
  if (input.sessionExpired) lines.push('> **登录态已过期**：本次没有产生产品结论。重新运行 `pnpm --filter @e2e-dev/uat-verification login` 扫码一次后再验证。', '');
  lines.push('## 运行', '');
  lines.push(`- 结论：\`${input.status}\`（exit ${String(number(run['exitCode']) ?? '?')}）`);
  lines.push(`- 开始：${string(run['startedAt']) ?? '?'}`);
  lines.push(`- 结束：${string(run['finishedAt']) ?? '?'}`);
  lines.push(`- 被测版本：`);
  lines.push(`  - \`e2e\` ${e2eVersion}${commit === undefined ? '' : ` @ \`${commit}${dirty === true ? ' (dirty)' : ''}\``}`);
  lines.push(`  - \`@e2e-dev/web\` ${webVersion}`);
  lines.push(`  - \`agent-browser\` ${nativeVersion ?? 'unknown'}${nativeCommit === undefined ? '' : ` @ \`${nativeCommit}\``}${inputs.native.source === 'executable-environment' && inputs.native.sha256 !== undefined ? ` · sha256 \`${inputs.native.sha256}\`` : ''}`);
  if (inputs.native.source === 'unknown') lines.push('  - 原生身份未知：没有 verified runtime 描述符，也没有设置 `E2E_AGENT_BROWSER_EXECUTABLE`。');
  lines.push(`- 环境：${string(input.environment['os']) ?? '?'} / ${string(input.environment['arch']) ?? '?'} · Node ${nodeVersion(string(input.environment['runtime']))}`);
  lines.push('- 场景：登录 → 首页 → 账号管理 → 账号标签管理 → 输入账号 ID → 查询（默认只读，账号 ID 已脱敏）');
  lines.push(`- 原始输出（本机、未提交）：\`${inputs.rawOutput}\``, '');

  lines.push('## 用例', '');
  lines.push('| 用例 | 状态 | 尝试 | 耗时 (ms) |', '| --- | --- | ---: | ---: |');
  for (const result of array(run['results']).map(record)) {
    const attempts = array(result['attempts']).map(record);
    const duration = attempts.reduce((total, attempt) => total + (number(attempt['durationMs']) ?? 0), 0);
    lines.push(`| ${cell(testTitle(result, redact))} | ${cell(string(result['status']) ?? '?')} | ${attempts.length} | ${duration} |`);
  }
  lines.push('');

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
  lines.push('- 本报告只含状态、错误码、阶段耗时和原生结算枚举；原始 report/trace/截图仅留在上面的本机目录，未提交、未发布。');
  lines.push('- `effects` / `scopeState` 来自原生操作记录（`E2E_NATIVE_RESULT_LEDGER`）；`phases` 来自 agent 观察事件。');
  lines.push('- 场景只做查询；任何写入类验证需要单独确认，不包含在本循环里。');
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
