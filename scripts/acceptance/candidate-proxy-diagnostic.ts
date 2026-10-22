/** Explicit synthetic child-pipe/Unix-proxy diagnostic. Never browser or broker acceptance. */
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../public-packages.ts';
import { sha256 } from './bundle.ts';
import { hashFile, sourceIdentity } from './candidate-native.ts';
import { verifyReport, type TestReport } from './report.ts';

export const PROXY_SCENARIOS = ['early-result', 'scheduled-before', 'scheduled-same-tick', 'scheduled-after', 'explicit-abort-ack-first', 'missing-ack', 'unknown-result'] as const;
export const PROXY_TEST = 'tests/proxy/native-proxy-settlement.test.ts';
const LABEL = 'retains authoritative settlement through the production byte proxy: ';
const LIMIT = 1024 * 1024;
const NOTE = 'Scripted-peer production byte-proxy diagnostic only. Not native broker execution, isolated daemon startup, browser-backed semantic recovery, candidate acceptance or release readiness. Failure traces are emitted only when available; their absence proves no phase ordering.';
type Outcome = 'success' | 'failure' | 'skipped' | 'cancelled' | 'missing';
type Status = 'passed' | 'failed' | 'skipped';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const within = (root: string, file: string): boolean => { const path = relative(root, file); return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const exactKeys = (value: ObjectValue, required: readonly string[], optional: readonly string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** Compiler-only summary: never retain rendered messages, source paths or stderr text. */
export function proxyCompileEvidence(stdout: string, stderr: string) {
  const errorCodes = new Set<string>(); let incomplete = false; let records = 0;
  // The process owner already bounds each stream. Independently bound JSON inspection.
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (++records > 8192) { incomplete = true; break; }
    if (Buffer.byteLength(line) > 64 * 1024) { incomplete = true; continue; }
    let value: unknown;
    try { value = JSON.parse(line); } catch { incomplete = true; continue; }
    if (!object(value) || value['reason'] !== 'compiler-message' || !object(value['message'])) continue;
    const message = value['message'];
    if (message['level'] !== 'error') continue;
    if (!object(message['code'])) { incomplete = true; continue; }
    const code = message['code']['code'];
    if (typeof code !== 'string' || !/^E[0-9]{4}$/.test(code)) { incomplete = true; continue; }
    if (errorCodes.size >= 32 && !errorCodes.has(code)) { incomplete = true; continue; }
    errorCodes.add(code);
  }
  return { stdoutSha256: sha256(Buffer.from(stdout)), stderrSha256: sha256(Buffer.from(stderr)),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    compilerErrorCodes: [...errorCodes].toSorted(), compilerCodesIncomplete: incomplete };
}

/** harness=false/test=false does NOT imply profile.test=true. Select the explicit test target. */
export function proxyCompilerArtifact(jsonLines: string, source: string, target: string) {
  if (Buffer.byteLength(jsonLines) > 8 * LIMIT) throw new Error('Compiler output exceeds bound');
  const candidates: ObjectValue[] = []; let finished = 0;
  for (const line of jsonLines.trim().split('\n')) {
    const item: unknown = JSON.parse(line);
    if (!object(item)) throw new Error('Invalid compiler record');
    if (item['reason'] === 'build-finished') {
      if (item['success'] !== true) throw new Error('Unsuccessful compiler output');
      finished++;
    }
    if (item['reason'] !== 'compiler-artifact' || !object(item['target']) || item['target']['name'] !== 'client-proxy-fixture') continue;
    candidates.push(item);
  }
  if (finished !== 1 || candidates.length !== 1) throw new Error('Missing or ambiguous explicit proxy fixture compilation');
  const item = candidates[0]!; const metadata = item['target'] as ObjectValue;
  const expectedSource = resolve(source, 'cli/tests/fixtures/client_proxy_fixture.rs');
  if (JSON.stringify(metadata['kind']) !== JSON.stringify(['test']) || metadata['src_path'] !== expectedSource
    || item['manifest_path'] !== resolve(source, 'cli/Cargo.toml')
    || JSON.stringify(item['features']) !== JSON.stringify(['acceptance-faults'])
    || typeof item['executable'] !== 'string' || !isAbsolute(item['executable'])
    || !within(resolve(target), item['executable'])) throw new Error('Proxy artifact is not the explicit feature-gated source/target');
  if (realpathSync(expectedSource) !== expectedSource) throw new Error('Proxy fixture source is not canonical');
  const executable = realpathSync(item['executable']);
  if (!within(realpathSync(target), executable) || !statSync(executable).isFile()) throw new Error('Proxy executable escapes the target or is not a file');
  accessSync(executable, constants.X_OK);
  return { name: 'client-proxy-fixture', source: expectedSource, executable, sha256: hashFile(executable), features: ['acceptance-faults'], kind: ['test'] };
}

/** Closed schemas only: neither raw stderr nor Vitest assertion messages reach the artifact. */
function safeTraceRecord(value: unknown): boolean {
  if (!object(value)) return false;
  const errors = new Set(['broken-pipe', 'connection-reset', 'connection-aborted', 'interrupted', 'would-block', 'timed-out', 'unexpected-eof', 'not-connected', 'invalid-data', 'other']);
  if (value['source'] === 'proxy') return exactKeys(value, ['source', 'phase', 'ordinal', 'bytes', 'totalBytes', 'error', 'captureLimit'])
    && ['stdin-read', 'socket-write', 'socket-read', 'stdout-write'].includes(String(value['phase']))
    && ['ordinal', 'bytes', 'totalBytes'].every(key => natural(value[key]))
    && (value['error'] === null || errors.has(String(value['error']))) && typeof value['captureLimit'] === 'boolean';
  return exactKeys(value, ['source', 'phase'], ['kind', 'bytes', 'writableLength', 'accepted', 'error'])
    && ['ts', 'peer'].includes(String(value['source']))
    && ['write-enter', 'write-return', 'write-callback', 'write-throw', 'peer-request', 'peer-status', 'peer-cancel', 'peer-result', 'peer-ack', 'ts-result', 'ts-ack', 'settled', 'fresh-request', 'disposed'].includes(String(value['phase']))
    && (!Object.hasOwn(value, 'kind') || ['hello', 'request', 'decision', 'cancel', 'close', 'other'].includes(String(value['kind'])))
    && ['bytes', 'writableLength'].every(key => !Object.hasOwn(value, key) || natural(value[key]))
    && (!Object.hasOwn(value, 'accepted') || typeof value['accepted'] === 'boolean')
    && (!Object.hasOwn(value, 'error') || errors.has(String(value['error'])));
}
export function collectProxyDiagnostics(log: string) {
  if (Buffer.byteLength(log) > 2 * LIMIT + 1) throw new Error('Diagnostic output exceeds bound');
  const traces: ObjectValue[] = []; let rejected = 0;
  const counters = ['targetCount', 'statusCount', 'cancelCount', 'ackCount', 'tsAckCount', 'resultCount', 'freshCount', 'disposalCount'];
  for (const line of log.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    let item: unknown; try { item = JSON.parse(line); } catch { rejected++; continue; }
    if (!object(item) || !exactKeys(item, ['scenario', ...counters, 'trace'], ['observed'])
      || !(PROXY_SCENARIOS as readonly unknown[]).includes(item['scenario']) || !counters.every(key => natural(item[key]))
      || (Object.hasOwn(item, 'observed') && !['result-before-cancel', 'cancel-before-result'].includes(String(item['observed'])))
      || !object(item['trace']) || !exactKeys(item['trace'], ['dropped', 'records']) || !natural(item['trace']['dropped'])
      || !Array.isArray(item['trace']['records']) || item['trace']['records'].length > 256 || !item['trace']['records'].every(safeTraceRecord)
      || traces.some(trace => trace['scenario'] === item['scenario']) || traces.length === PROXY_SCENARIOS.length) { rejected++; continue; }
    traces.push(item);
  }
  return { traces, rejected, emission: 'failure-only' as const };
}

export function proxyReportSummary(report: TestReport, testFile: string) {
  const assertions = verifyReport(report, [testFile]);
  const actual = report.testResults.flatMap(suite => suite.assertionResults.map(assertion => assertion.fullName));
  const expected = PROXY_SCENARIOS.map(scenario => `${LABEL}${scenario}`);
  if (assertions !== expected.length || new Set(actual).size !== expected.length || expected.some(name => !actual.includes(name))) throw new Error('Missing or unexpected proxy scenarios');
  return PROXY_SCENARIOS.map(scenario => ({ scenario, status: 'passed' as const }));
}

export function proxyCommands(reportFile: string) {
  return {
    compile: ['test', '--locked', '--profile', 'ci', '--no-default-features', '--features', 'acceptance-faults', '--test', 'client-proxy-fixture', '--no-run', '--message-format=json'],
    test: ['--filter', '@e2e-dev/web', 'exec', 'vitest', 'run', '--config', 'tests/proxy/vitest.config.ts', '--reporter=json', `--outputFile=${reportFile}`],
  };
}

type Termination = 'completed' | 'timeout' | 'output-limit' | 'output-error' | 'interrupted' | 'spawn-error' | 'leftover-processes';
interface ProxyProcessResult {
  status: number | null; signal: NodeJS.Signals | null; termination: Termination;
  cleanupConfirmed: boolean; groupRetired: boolean; stdout: string; stderr: string; pid: number | undefined;
}
type GroupSignal = (pid: number, signal: NodeJS.Signals | 0) => unknown;
/** ESRCH permanently ends ownership of this numeric PGID, regardless of inherited open pipes. */
export function proxyProcessGroup(pid: number | undefined, send: GroupSignal = process.kill) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid owned proxy process group');
  let retired = pid === undefined;
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ESRCH';
  const exists = (): boolean => {
    if (retired) return false;
    try { send(-pid!, 0); return true; }
    catch (error) { if (missing(error)) retired = true; return !retired; }
  };
  return {
    exists,
    signal(value: NodeJS.Signals): void {
      if (!exists()) return;
      try { send(-pid!, value); } catch (error) { if (missing(error)) retired = true; }
    },
    get retired() { return retired; },
  };
}
/** This diagnostic owns the command's group, never a timeout supervisor that can orphan it. */
export async function runProxyCommand(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number;
  signal?: AbortSignal; termGraceMs?: number; killGraceMs?: number;
}, model?: { child: ChildProcessByStdio<null, Readable, Readable>; signal: GroupSignal }): Promise<ProxyProcessResult> {
  if (process.platform !== 'linux') throw new Error('Proxy process groups require Linux');
  const termGrace = options.termGraceMs ?? 5_000; const killGrace = options.killGraceMs ?? 3_000;
  if (![options.timeoutMs, options.maxBuffer, termGrace, killGrace].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid proxy process bounds');
  if (options.signal?.aborted) return { status: null, signal: null, termination: 'interrupted', cleanupConfirmed: true, groupRetired: true, stdout: '', stderr: '', pid: undefined };
  return new Promise(resolveResult => {
    // The optional model exercises pipe/exit races without executing any command or real signal.
    const child = model?.child ?? spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const group = proxyProcessGroup(child.pid, model?.signal);
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    let status: number | null = null; let signal: NodeJS.Signals | null = null;
    let termination: Termination = 'completed'; let closed = false; let stopping = false; let finished = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (cleanupConfirmed: boolean): void => {
      if (finished) return;
      finished = true; clearTimeout(deadline); clearTimeout(forceKill); clearTimeout(cleanupDeadline); clearInterval(poll);
      options.signal?.removeEventListener('abort', interrupted);
      // An unconfirmed OS cleanup is a failed receipt, never a successful command or an unbounded wait.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolveResult({ status, signal, termination, cleanupConfirmed, groupRetired: group.retired, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'), pid: child.pid });
    };
    // Poll ownership even while a descendant outside this group holds an inherited pipe open.
    const check = (): void => { const gone = !group.exists(); if (closed && gone) finish(true); };
    const stop = (reason: Termination): void => {
      if (finished) return;
      if (termination === 'completed') termination = reason;
      if (stopping) return;
      stopping = true; clearTimeout(deadline);
      // Kill the owned group on EVERY stop path, including overflow and leader exit with live descendants.
      group.signal('SIGTERM');
      forceKill = setTimeout(() => { group.signal('SIGKILL'); check(); }, termGrace);
      cleanupDeadline = setTimeout(() => { group.signal('SIGKILL'); const gone = !group.exists(); finish(closed && gone); }, termGrace + killGrace);
      poll = setInterval(check, 20);
      check();
    };
    const interrupted = (): void => stop('interrupted');
    for (const name of ['stdout', 'stderr'] as const) {
      child[name].on('data', (chunk: Buffer) => {
        if (finished) return;
        const available = options.maxBuffer - bytes[name];
        if (available > 0) { const retained = chunk.subarray(0, available); chunks[name].push(retained); bytes[name] += retained.length; }
        if (chunk.length > available) stop('output-limit');
      });
      child[name].on('error', () => stop('output-error'));
    }
    child.on('error', () => stop('spawn-error'));
    child.on('exit', (code, exitSignal) => {
      status = code; signal = exitSignal;
      const liveGroup = group.exists();
      stop(!stopping && liveGroup ? 'leftover-processes' : 'completed');
    });
    child.on('close', (code, exitSignal) => { status = code; signal = exitSignal; closed = true; stop('completed'); check(); });
    deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', interrupted, { once: true });
    if (options.signal?.aborted) interrupted();
  });
}
export function proxyEnvironment(inherited: NodeJS.ProcessEnv, executable?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const name of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'E2E_AGENT_BROWSER_EXECUTABLE', 'E2E_AGENT_BROWSER_PROXY_FIXTURE', 'AGENT_BROWSER_ACCEPTANCE_PHASE_FILE']) delete env[name];
  if (executable !== undefined) env['E2E_AGENT_BROWSER_PROXY_FIXTURE'] = executable;
  return env;
}
interface Execution {
  schemaVersion: 1; kind: 'production-byte-proxy-diagnostic'; status: Status;
  stage: string; releaseEligible: false; note: string;
  [key: string]: unknown;
}
const base = (status: Status, stage: string): Execution => ({ schemaVersion: 1, kind: 'production-byte-proxy-diagnostic', status, stage, releaseEligible: false, note: NOTE });
const outcome = (value: unknown): Outcome => ['success', 'failure', 'skipped', 'cancelled'].includes(String(value)) ? value as Outcome : 'missing';
/** GitHub's step outcome is authoritative, including runner interruption before a receipt. */
export function finalizeProxyReceipt(steps: Record<string, { outcome?: string }>, execution?: Execution) {
  const step = outcome(steps['proxy-diagnostic']?.outcome);
  const prerequisites = Object.fromEntries(['toolchain', 'packages', 'native-build', 'fault-build'].map(id => [id, outcome(steps[id]?.outcome)]));
  const valid = execution?.schemaVersion === 1 && execution.kind === 'production-byte-proxy-diagnostic' && execution.status === 'passed' && execution.stage === 'verified' && execution.releaseEligible === false
    && JSON.stringify(execution['scenarios']) === JSON.stringify(PROXY_SCENARIOS.map(scenario => ({ scenario, status: 'passed' })));
  const status = step === 'skipped' || step === 'cancelled' ? 'skipped' : step === 'success' && valid && Object.values(prerequisites).every(value => value === 'success') ? 'passed' : 'failed';
  return { ...base(status, 'finalized'), step, prerequisites, executionStatus: execution?.status ?? 'missing', executionStage: execution?.stage ?? 'missing' };
}

async function run(args: string[]): Promise<void> {
  const [sourceArg, targetArg, productionArg, faultArg, outputArg, expectedSha] = args;
  if (!sourceArg || !targetArg || !productionArg || !faultArg || !outputArg || !expectedSha) throw new Error('usage: candidate-proxy-diagnostic.ts run source target production acceptance-faults evidence expected-native-sha');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true });
  const receipt = join(output, 'proxy-diagnostic.execution.json');
  const execution = base('failed', 'started');
  writeFileSync(receipt, JSON.stringify(execution, null, 2), { flag: 'wx', mode: 0o600 });
  const checkpoint = (stage: string) => { execution.stage = stage; writeFileSync(receipt, JSON.stringify(execution, null, 2)); };
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, interrupted);
  let scratch: string | undefined;
  try {
    if (process.platform !== 'linux') throw new Error('Hosted proxy diagnostic requires Linux');
    const source = resolve(sourceArg); const target = resolve(targetArg);
    const production = resolve(productionArg); const fault = resolve(faultArg);
    const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    checkpoint('identity');
    const sourceRevision = git('rev-parse', 'HEAD');
    if (git('status', '--porcelain')) throw new Error('Diagnostic requires clean committed source');
    const nativeSource = sourceIdentity(source, expectedSha);
    const binaries = { productionBinarySha256: hashFile(production), acceptanceFaultBinarySha256: hashFile(fault) };
    if (realpathSync(production) === realpathSync(fault) || binaries.productionBinarySha256 === binaries.acceptanceFaultBinarySha256) throw new Error('Protected runtime identities are not separate');
    execution['binding'] = { sourceRevision, nativeSource, ...binaries };
    scratch = mkdtempSync(join(tmpdir(), 'candidate-proxy-diagnostic-'));
    const reportFile = join(scratch, 'vitest.json'); const commands = proxyCommands(reportFile);
    checkpoint('compile');
    const compile = await runProxyCommand('cargo', commands.compile, { cwd: join(source, 'cli'), env: { ...proxyEnvironment(process.env), CARGO_TARGET_DIR: target }, maxBuffer: 8 * LIMIT, timeoutMs: 900_000, signal: controller.signal });
    execution['compile'] = { exitCode: compile.status, signal: compile.signal, termination: compile.termination, cleanupConfirmed: compile.cleanupConfirmed, groupRetired: compile.groupRetired, ...proxyCompileEvidence(compile.stdout, compile.stderr) };
    if (compile.termination !== 'completed' || !compile.cleanupConfirmed || compile.status !== 0) throw new Error('Explicit proxy fixture compilation did not complete');
    checkpoint('select-artifact');
    const fixture = proxyCompilerArtifact(compile.stdout, source, target);
    if ([production, fault].some(file => realpathSync(file) === fixture.executable) || [binaries.productionBinarySha256, binaries.acceptanceFaultBinarySha256].includes(fixture.sha256)) throw new Error('Fixture aliases a protected runtime');
    execution['fixture'] = fixture;
    checkpoint('execute');
    const result = await runProxyCommand('pnpm', commands.test, { cwd: REPO_ROOT, env: proxyEnvironment(process.env, fixture.executable), maxBuffer: LIMIT, timeoutMs: 240_000, signal: controller.signal });
    execution['test'] = { exitCode: result.status, signal: result.signal, termination: result.termination, cleanupConfirmed: result.cleanupConfirmed, groupRetired: result.groupRetired };
    // Only the existing closed failure observations survive; raw reporter output is never uploaded.
    const diagnostics = collectProxyDiagnostics(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    writeFileSync(join(output, 'proxy-diagnostic.traces.json'), JSON.stringify(diagnostics, null, 2), { flag: 'wx', mode: 0o600 });
    checkpoint('verify');
    if (result.termination !== 'completed' || !result.cleanupConfirmed || result.status !== 0 || diagnostics.rejected !== 0) throw new Error('Proxy suite failed or emitted invalid diagnostic data');
    if (statSync(reportFile).size > LIMIT) throw new Error('Vitest report exceeds bound');
    execution['scenarios'] = proxyReportSummary(JSON.parse(readFileSync(reportFile, 'utf8')) as TestReport, join(REPO_ROOT, 'packages/web', PROXY_TEST));
    if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceRevision || JSON.stringify(sourceIdentity(source, expectedSha)) !== JSON.stringify(nativeSource)
      || hashFile(fixture.executable) !== fixture.sha256 || hashFile(production) !== binaries.productionBinarySha256 || hashFile(fault) !== binaries.acceptanceFaultBinarySha256) throw new Error('Diagnostic source or protected runtime changed');
    if (controller.signal.aborted) throw new Error('Diagnostic was interrupted');
    execution.stage = 'verified'; execution.status = 'passed';
  } catch {
    // The failed stage and bounded exit facts suffice. Never echo arbitrary tool/error payloads.
    process.stderr.write(`Production byte-proxy diagnostic failed at ${execution.stage}; see its separate receipt.\n`);
    process.exitCode = 1;
  } finally {
    for (const signal of signals) process.off(signal, interrupted);
    try { if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true }); }
    catch { execution.status = 'failed'; execution.stage = 'cleanup'; process.exitCode = 1; }
    writeFileSync(receipt, JSON.stringify(execution, null, 2));
  }
}
async function main(args: string[]): Promise<void> {
  if (args[0] === 'run') { await run(args.slice(1)); return; }
  if (args[0] !== 'receipt' || !args[1]) throw new Error('usage: candidate-proxy-diagnostic.ts run|receipt ...');
  const output = resolve(args[1]); mkdirSync(output, { recursive: true });
  let execution: Execution | undefined;
  try {
    const file = join(output, 'proxy-diagnostic.execution.json');
    if (statSync(file).size <= LIMIT) execution = JSON.parse(readFileSync(file, 'utf8')) as Execution;
  } catch { /* Missing/invalid execution is explicitly failed or skipped, never passing. */ }
  const result = finalizeProxyReceipt(JSON.parse(process.env['GATE_OUTCOMES'] ?? '{}') as Record<string, { outcome?: string }>, execution);
  writeFileSync(join(output, 'proxy-diagnostic.result.json'), JSON.stringify({ ...result, ...(execution === undefined ? {} : { executionSha256: hashFile(join(output, 'proxy-diagnostic.execution.json')) }) }, null, 2));
  if (result.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
