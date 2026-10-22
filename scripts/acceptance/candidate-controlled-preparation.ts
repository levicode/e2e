/** Two diagnostic schedules, separate from every mandatory preparation test. Raw output stays in memory. */
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from '../public-packages.ts';
import { sha256 } from './bundle.ts';
import { hashFile, sourceIdentity } from './candidate-native.ts';
import { assessClosedTest, assessExactTest, exactListing, matrixCompilerHarness, normalizedTest, type ProcessFacts } from './candidate-native-matrix.ts';
import { proxyEnvironment, runProxyCommand } from './candidate-proxy-diagnostic.ts';

export const CONTROLLED_PREPARATION_CASES = [
  { id: 'preparation-positive-window', name: 'native::client_actions::tests::preparation_controlled_inside_window_acked_refusal_is_completed_and_reusable' },
  { id: 'preparation-lower-floor', name: 'native::client_actions::tests::preparation_controlled_below_floor_unknown_retires_before_original_deadline' },
] as const;
export const CONTROLLED_PREPARATION_SOURCE = 'cli/src/native/client_actions.rs';
export const CONTROLLED_PREPARATION_SOURCE_HASH = '1263838285a9072eeaf6f3ee0f6113c249cc78114ddd8e9da01fabf5105b91a4';
export const CONTROLLED_PREPARATION_BUDGET = { cases: 2, recordsPerCase: 1, recordBytes: 4096, savedBytes: 32768, streamBytes: 65536, processTimeoutMs: 30000 } as const;
type RowId = typeof CONTROLLED_PREPARATION_CASES[number]['id'];
type Value = Record<string, unknown>;
type Result = Awaited<ReturnType<typeof runProxyCommand>>;
const object = (v: unknown): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Value, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uint = (v: unknown, cap: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= cap;
const digest = (v: string) => ({ bytes: Buffer.byteLength(v), sha256: sha256(Buffer.from(v)) });
const facts = (r: Result): ProcessFacts => ({ status: r.status, signal: r.signal, termination: r.termination, cleanupConfirmed: r.cleanupConfirmed, groupRetired: r.groupRetired });
const finished = (r: ProcessFacts) => r.termination === 'completed' && r.signal === null && r.status !== null && r.cleanupConfirmed && r.groupRetired;
const hex = (v: unknown, size = 64) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(v);
function validBinding(v: unknown): v is Value {
  if (!object(v) || !exact(v, ['sourceRevision', 'nativeSource', 'fixtureSha256', 'productionBinarySha256', 'compiler', 'harness']) || !hex(v.sourceRevision, 40)
    || v.fixtureSha256 !== CONTROLLED_PREPARATION_SOURCE_HASH || !hex(v.productionBinarySha256) || !object(v.nativeSource) || !object(v.compiler) || !object(v.harness)) return false;
  const native = v.nativeSource; const compiler = v.compiler; const harness = v.harness;
  return exact(native, ['repository', 'commit', 'tree', 'cargoLockSha256']) && native.repository === 'levicode/agent-browser' && hex(native.commit, 40) && hex(native.tree, 40) && hex(native.cargoLockSha256)
    && exact(compiler, ['bytes', 'sha256']) && uint(compiler.bytes, 8 * 1024 * 1024) && hex(compiler.sha256)
    && exact(harness, ['name', 'source', 'kind', 'features', 'profile', 'executable', 'sha256']) && harness.name === 'agent-browser' && harness.source === 'cli/src/main.rs'
    && isDeepStrictEqual(harness.kind, ['bin']) && isDeepStrictEqual(harness.features, []) && harness.profile === 'ci' && typeof harness.executable === 'string'
    && /^ci\/deps\/agent_browser-[a-f0-9]{8,64}$/.test(harness.executable) && hex(harness.sha256) && harness.sha256 !== v.productionBinarySha256;
}
const BOOLS = ['entry_ack', 'entry_above_upper', 'release_valid', 'counts_bounded', 'exact_release_acked', 'authority_expired_at_retirement', 'action_finished_before_deadline', 'broker_settled_before_deadline', 'retained_drained_before_deadline', 'contract_valid', 'retired_before_deadline', 'complete'] as const;
const TIMES = ['entry_remaining_ms', 'longest_attempt_ms', 'release_remaining_ms'] as const;
const COUNTS = ['scrolls', 'inputs', 'releases'] as const;
export function validControlledRecord(v: unknown, id: RowId): v is Value {
  return object(v) && exact(v, ['schema', 'case', 'status', ...BOOLS, ...TIMES, ...COUNTS]) && v.schema === 1 && v.case === id
    && ['pass', 'fail', 'incomplete'].includes(v.status as string) && BOOLS.every(k => typeof v[k] === 'boolean')
    && TIMES.every(k => v[k] === null || uint(v[k], 800)) && COUNTS.every(k => uint(v[k], 128));
}
export function controlledRecord(stdout: string, stderr: string, id: RowId): Value | null {
  if (Buffer.byteLength(stdout) > CONTROLLED_PREPARATION_BUDGET.streamBytes || Buffer.byteLength(stderr) > CONTROLLED_PREPARATION_BUDGET.streamBytes) return null;
  const prefix = 'native-preparation-controlled ';
  const lines = `${stdout}\n${stderr}`.split('\n').filter(line => line.startsWith(prefix));
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > CONTROLLED_PREPARATION_BUDGET.recordBytes) return null;
  try { const value: unknown = JSON.parse(lines[0]!.slice(prefix.length)); return validControlledRecord(value, id) ? value : null; } catch { return null; }
}
/** Only a canonical tracked owning file and bounded line/column survive; never panic text. */
export function controlledPanic(stdout: string, stderr: string, source: string): { file: string; line: number; column: number } | null {
  const matches = [...`${stdout}\n${stderr}`.matchAll(/^thread [^\r\n]{0,512} panicked at ([^\r\n]{1,4096}):(\d{1,7}):(\d{1,5}):$/gm)];
  if (matches.length !== 1) return null;
  const match = matches[0]!; const emitted = match[1]!;
  if (emitted.split(/[\\/]/).includes('..')) return null;
  const file = isAbsolute(emitted) ? relative(resolve(source), emitted) : emitted.startsWith('cli/') ? emitted : `cli/${emitted}`;
  const line = Number(match[2]); const column = Number(match[3]);
  if (file !== CONTROLLED_PREPARATION_SOURCE || !uint(line, 1000000) || line === 0 || !uint(column, 65535) || column === 0) return null;
  try {
    const path = resolve(source, file); if (realpathSync(path) !== path || hashFile(path) !== CONTROLLED_PREPARATION_SOURCE_HASH) return null;
    execFileSync('git', ['-C', source, 'ls-files', '--error-unmatch', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return line <= readFileSync(path, 'utf8').split('\n').length ? { file, line, column } : null;
  } catch { return null; }
}
export function controlledClassification(id: RowId, record: Value | null, observation: ReturnType<typeof assessExactTest>, process: ProcessFacts, panic: { line: number } | null): 'passed' | 'known-red' | 'failed' | 'unknown' {
  if (!finished(process) || observation.testStatus === 'unknown' || record === null || !validControlledRecord(record, id) || record.complete !== true || record.status === 'incomplete'
    || record.entry_ack !== true || record.entry_above_upper !== true || record.release_valid !== true || record.counts_bounded !== true
    || TIMES.some(key => record[key] === null)
    || record.retired_before_deadline !== (record.action_finished_before_deadline === true && record.broker_settled_before_deadline === true && record.retained_drained_before_deadline === true)
    || (record.contract_valid === true && (record.exact_release_acked !== true || record.releases !== 1 || record.inputs !== 0 || !uint(record.scrolls, 128) || record.scrolls < 1))) return 'unknown';
  if (observation.testStatus === 'passed') return record.status === 'pass' && record.contract_valid === true && record.retired_before_deadline === true && record.scrolls === 1 && record.inputs === 0 ? 'passed' : 'unknown';
  // Fixed owning source hash binds line 7027 to the precise retirement assertion.
  if (id === 'preparation-lower-floor' && observation.testStatus === 'failed' && record.status === 'fail' && record.contract_valid === true
    && record.inputs === 0 && record.exact_release_acked === true && record.retired_before_deadline === false && panic?.line === 7027) return 'known-red';
  return 'failed';
}
interface Row { id: RowId; name: string; status: 'passed' | 'known-red' | 'failed' | 'unknown'; discovery: unknown; process: ProcessFacts | null; stdout: ReturnType<typeof digest> | null; stderr: ReturnType<typeof digest> | null; test: ReturnType<typeof normalizedTest> | null; record: Value | null; panic: ReturnType<typeof controlledPanic>; problem: 'not-run' | 'discovery-incomplete' | 'execution-incomplete' | null }
/** Trusts only the execution-time parser facts, not a reconstruction of discarded raw text. */
export function verifyControlledReceipt(value: unknown, expectedBinding: unknown): 'passed' | 'failed' | 'unknown' {
  const validDigest = (v: unknown) => object(v) && exact(v, ['bytes', 'sha256']) && uint(v.bytes, CONTROLLED_PREPARATION_BUDGET.streamBytes) && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256);
  if (!object(value) || !exact(value, ['schemaVersion', 'kind', 'acceptanceEvidence', 'releaseEligible', 'budget', 'binding', 'sourceVerifiedAfter', 'status', 'complete', 'problem', 'rows'])
    || value.schemaVersion !== 1 || value.kind !== 'controlled-preparation-diagnostic' || value.acceptanceEvidence !== false || value.releaseEligible !== false
    || !isDeepStrictEqual(value.budget, CONTROLLED_PREPARATION_BUDGET) || !validBinding(expectedBinding) || !isDeepStrictEqual(value.binding, expectedBinding)
    || value.sourceVerifiedAfter !== true || value.complete !== true || value.problem !== null || !Array.isArray(value.rows) || value.rows.length !== 2) return 'unknown';
  const statuses: string[] = [];
  for (const [index, expected] of CONTROLLED_PREPARATION_CASES.entries()) {
    const row: unknown = value.rows[index];
    if (!object(row) || !exact(row, ['id', 'name', 'status', 'discovery', 'process', 'stdout', 'stderr', 'test', 'record', 'panic', 'problem']) || row.id !== expected.id || row.name !== expected.name || row.problem !== null
      || !object(row.discovery) || !exact(row.discovery, ['process', 'stdout', 'stderr', 'exact']) || row.discovery.exact !== true
      || !isDeepStrictEqual(row.discovery.process, { status: 0, signal: null, termination: 'completed', cleanupConfirmed: true, groupRetired: true })
      || !validDigest(row.discovery.stdout) || !validDigest(row.discovery.stderr) || !validDigest(row.stdout) || !validDigest(row.stderr)
      || !object(row.process) || !validControlledRecord(row.record, expected.id)) return 'unknown';
    const observation = assessClosedTest(row.test, row.process);
    if (observation.testStatus === 'unknown') return 'unknown';
    const panic = row.panic;
    if (panic !== null && (!object(panic) || !exact(panic, ['file', 'line', 'column']) || panic.file !== CONTROLLED_PREPARATION_SOURCE || !uint(panic.line, 1000000) || panic.line === 0 || !uint(panic.column, 65535) || panic.column === 0)) return 'unknown';
    const status = controlledClassification(expected.id, row.record, observation, row.process as unknown as ProcessFacts, panic as ReturnType<typeof controlledPanic>);
    if (status === 'unknown' || row.status !== status) return 'unknown';
    statuses.push(status);
  }
  const status = statuses.every(entry => entry === 'passed') ? 'passed' : 'failed';
  return value.status === status ? status : 'unknown';
}
export async function runControlledPreparation(args: string[]): Promise<void> {
  const [sourceArg, targetArg, productionArg, outputArg, expectedSha] = args;
  if (!sourceArg || !targetArg || !productionArg || !outputArg || !expectedSha) throw new Error('controlled-preparation-arguments');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true });
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('controlled-preparation-nofollow-unavailable');
  const file = join(output, 'controlled-preparation-diagnostic.json');
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const rows: Row[] = CONTROLLED_PREPARATION_CASES.map(item => ({ ...item, status: 'unknown', discovery: null, process: null, stdout: null, stderr: null, test: null, record: null, panic: null, problem: 'not-run' }));
  const receipt = { schemaVersion: 1, kind: 'controlled-preparation-diagnostic', acceptanceEvidence: false, releaseEligible: false, budget: CONTROLLED_PREPARATION_BUDGET,
    binding: null as Value | null, sourceVerifiedAfter: false, status: 'unknown' as 'passed' | 'failed' | 'unknown', complete: false, problem: 'not-started' as string | null, rows };
  const save = () => { const data = JSON.stringify(receipt, null, 2); if (Buffer.byteLength(data) > CONTROLLED_PREPARATION_BUDGET.savedBytes || !fstatSync(fd).isFile()) throw new Error('controlled-preparation-evidence-bound'); writeFileSync(fd, data); };
  const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (process.platform !== 'linux') throw new Error('controlled-preparation-linux-required');
    const source = resolve(sourceArg); const target = resolve(targetArg); const production = resolve(productionArg);
    const git = (...v: string[]) => execFileSync('git', v, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const sourceRevision = git('rev-parse', 'HEAD'); if (git('status', '--porcelain')) throw new Error('controlled-preparation-dirty-source');
    const nativeSource = sourceIdentity(source, expectedSha); const fixtureSha256 = hashFile(join(source, CONTROLLED_PREPARATION_SOURCE));
    if (fixtureSha256 !== CONTROLLED_PREPARATION_SOURCE_HASH) throw new Error('controlled-preparation-fixture-mismatch');
    const productionBinarySha256 = hashFile(production); const rawCompiler = readFileSync(join(output, 'compiler.jsonl'), 'utf8');
    const harness = matrixCompilerHarness(rawCompiler, source, target, false);
    if (realpathSync(production) === harness.executable || productionBinarySha256 === harness.identity.sha256) throw new Error('controlled-preparation-harness-alias');
    receipt.binding = { sourceRevision, nativeSource, fixtureSha256, productionBinarySha256, compiler: digest(rawCompiler), harness: harness.identity };
    const pinned = () => { if (git('rev-parse', 'HEAD') !== sourceRevision || git('status', '--porcelain') || JSON.stringify(sourceIdentity(source, expectedSha)) !== JSON.stringify(nativeSource)
      || hashFile(join(source, CONTROLLED_PREPARATION_SOURCE)) !== fixtureSha256 || hashFile(harness.executable) !== harness.identity.sha256 || hashFile(production) !== productionBinarySha256) throw new Error('controlled-preparation-binding-changed'); };
    const run = (testArgs: string[]) => { pinned(); return runProxyCommand(harness.executable, testArgs, { cwd: join(source, 'cli'), env: proxyEnvironment(process.env), timeoutMs: CONTROLLED_PREPARATION_BUDGET.processTimeoutMs, maxBuffer: CONTROLLED_PREPARATION_BUDGET.streamBytes, signal: controller.signal }); };
    for (const row of rows) {
      if (controller.signal.aborted) break;
      try {
        const discovery = await run([row.name, '--ignored', '--exact', '--list', '--format=terse']);
        row.discovery = { process: facts(discovery), stdout: digest(discovery.stdout), stderr: digest(discovery.stderr), exact: exactListing(discovery.stdout, row.name) };
        if (!finished(facts(discovery)) || discovery.status !== 0 || !exactListing(discovery.stdout, row.name)) { row.problem = 'discovery-incomplete'; continue; }
        const result = await run([row.name, '--ignored', '--exact', '--test-threads=1', '--format=pretty', '--color=never', '--nocapture']);
        row.process = facts(result); row.stdout = digest(result.stdout); row.stderr = digest(result.stderr); row.test = normalizedTest(row.name, result.stdout);
        row.record = controlledRecord(result.stdout, result.stderr, row.id); row.panic = controlledPanic(result.stdout, result.stderr, source);
        row.status = controlledClassification(row.id, row.record, assessExactTest(row.name, result.stdout, row.process), row.process, row.panic); row.problem = row.status === 'unknown' ? 'execution-incomplete' : null;
      } catch { row.status = 'unknown'; row.problem = 'execution-incomplete'; }
    }
    pinned(); receipt.sourceVerifiedAfter = true; receipt.complete = rows.every(row => row.status !== 'unknown');
    receipt.status = !receipt.complete ? 'unknown' : rows.every(row => row.status === 'passed') ? 'passed' : 'failed'; receipt.problem = null;
  } catch { receipt.problem = 'binding-or-execution-unavailable'; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); try { save(); } finally { closeSync(fd); } }
  const read = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(read);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > CONTROLLED_PREPARATION_BUDGET.savedBytes || verifyControlledReceipt(JSON.parse(readFileSync(read, 'utf8')), receipt.binding) !== 'passed') process.exitCode = 1;
  } finally { closeSync(read); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runControlledPreparation(process.argv.slice(2)); }
  catch { process.stderr.write('controlled-preparation-runner-unavailable\n'); process.exitCode = 1; }
}
