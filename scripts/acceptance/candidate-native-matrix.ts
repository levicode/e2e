/** Raw compiler/harness output is parsed in memory. New artifacts contain closed facts only. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../public-packages.ts';
import { sha256 } from './bundle.ts';
import { hashFile, sourceIdentity } from './candidate-native.ts';
import { proxyCompileEvidence, proxyEnvironment, runProxyCommand } from './candidate-proxy-diagnostic.ts';
import { PREPARATION_SETTLEMENT_TESTS, REQUIRED_NATIVE_FEATURE_TESTS } from './candidate-native-matrix-manifest.ts';

export type MatrixMode = 'preparation' | 'feature';
type Status = 'passed' | 'failed' | 'unknown';
type ObjectValue = Record<string, unknown>;
type ProcessResult = Awaited<ReturnType<typeof runProxyCommand>>;
export type ProcessFacts = Pick<ProcessResult, 'status' | 'signal' | 'termination' | 'cleanupConfirmed' | 'groupRetired'>;
export interface Observation { status: Status; testStatus: Status; problem: string | null }
interface Digest { sha256: string; bytes: number }
interface RelativeHarness { name: 'agent-browser'; source: 'cli/src/main.rs'; kind: ['bin']; features: string[]; profile: 'ci'; executable: string; sha256: string }
interface SelectedHarness { identity: RelativeHarness; executable: string }
interface CompilerProof { command: string[]; process: ProcessFacts; stdout: Digest; stderr: Digest; errorCodes: string[]; codesIncomplete: boolean; selected: RelativeHarness | null }
export interface PanicSite { file: string; line: number; column: number }
interface TestFacts { runningOne: boolean; runningRecords: number; runningTests: number | null; resultRecords: number; nameMatches: boolean; outcome: 'ok' | 'FAILED' | 'ignored' | null; summaryRecords: number; summary: 'ok' | 'FAILED' | null; passed: number | null; failed: number | null; ignored: number | null; measured: number | null; filtered: number | null }
interface StreamInventory { process: ProcessFacts; stdout: Digest; stderr: Digest; entries: number; duplicates: number; knownNames: string[] }
interface InventoryProof { schemaVersion: 1; kind: 'closed-native-inventory'; mode: MatrixMode; verified: boolean; default: StreamInventory; feature: StreamInventory | null; ignored: StreamInventory; required: { name: string; inDefault: boolean; inFeature: boolean; ignored: boolean }[]; delta: { added: string[]; addedCount: number; unexpectedAddedCount: number; removedDefaultCount: number } | null }
interface ListingProof { schemaVersion: 1; kind: 'closed-native-discovery'; name: string; process: ProcessFacts; stdout: Digest; stderr: Digest; entries: number; duplicates: number; exact: boolean }
interface TestProof { schemaVersion: 1; kind: 'closed-native-test'; name: string; process: ProcessFacts; stdout: Digest; stderr: Digest; test: TestFacts; panicSite: PanicSite | null }
export interface MatrixRow extends Observation {
  name: string; expectation: 'must-pass'; listing: ProcessFacts | null; execution: ProcessFacts | null;
  listingFile: string | null; listingSha256: string | null; file: string | null; proofSha256: string | null;
}
export interface MatrixExecution {
  schemaVersion: 1; kind: 'required-preparation-settlement-tests' | 'required-native-feature-tests'; mode: MatrixMode; stage: string; status: Status;
  required: readonly string[]; results: MatrixRow[]; binding?: ObjectValue; inventory?: { file: string; sha256: string }; compile?: CompilerProof; problem?: string;
  releaseEligible: false; acceptanceEvidence: boolean;
}
const LIMIT = 1024 * 1024;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: ObjectValue, required: readonly string[], optional: readonly string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const member = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hex = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const within = (root: string, file: string) => { const path = relative(root, file); return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const names = (mode: MatrixMode): readonly string[] => mode === 'preparation' ? PREPARATION_SETTLEMENT_TESTS : REQUIRED_NATIVE_FEATURE_TESTS;
const allNames: readonly string[] = [...PREPARATION_SETTLEMENT_TESTS, ...REQUIRED_NATIVE_FEATURE_TESTS];
const stem = (mode: MatrixMode) => mode === 'preparation' ? 'preparation-diagnostic' : 'native-feature';
const kind = (mode: MatrixMode): MatrixExecution['kind'] => mode === 'preparation' ? 'required-preparation-settlement-tests' : 'required-native-feature-tests';
const digest = (value: string): Digest => ({ sha256: sha256(Buffer.from(value)), bytes: Buffer.byteLength(value) });
const validDigest = (value: unknown): value is Digest => object(value) && keys(value, ['sha256', 'bytes']) && hex(value['sha256']) && natural(value['bytes']) && value['bytes'] <= 8 * LIMIT;
const facts = (result: ProcessResult): ProcessFacts => ({ status: result.status, signal: result.signal, termination: result.termination, cleanupConfirmed: result.cleanupConfirmed, groupRetired: result.groupRetired });
const validProcess = (value: unknown): value is ProcessFacts => object(value) && keys(value, ['status', 'signal', 'termination', 'cleanupConfirmed', 'groupRetired'])
  && (value['status'] === null || natural(value['status'])) && (value['signal'] === null || ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ'].includes(String(value['signal'])))
  && member(value['termination'], ['completed', 'timeout', 'output-limit', 'output-error', 'interrupted', 'spawn-error', 'leftover-processes']) && typeof value['cleanupConfirmed'] === 'boolean' && typeof value['groupRetired'] === 'boolean';
const completed = (value: ProcessFacts) => validProcess(value) && value.termination === 'completed' && value.signal === null && value.status !== null && value.cleanupConfirmed && value.groupRetired;
const fileName = (mode: MatrixMode, name: string) => `${stem(mode)}-${sha256(Buffer.from(name))}.proof.json`;
const rows = (mode: MatrixMode): MatrixRow[] => names(mode).map(name => ({ name, expectation: 'must-pass', status: 'unknown', testStatus: 'unknown', problem: 'not-executed', listing: null, execution: null, listingFile: null, listingSha256: null, file: null, proofSha256: null }));
const base = (mode: MatrixMode): MatrixExecution => ({ schemaVersion: 1, kind: kind(mode), mode, stage: 'started', status: 'unknown', required: names(mode), results: rows(mode), releaseEligible: false, acceptanceEvidence: true });
export const featureCompileArgs = ['test', '--locked', '--profile', 'ci', '--no-default-features', '--features', 'acceptance-faults', '--bin', 'agent-browser', '--no-run', '--message-format=json'];

function validHarness(value: unknown, feature: boolean): value is RelativeHarness {
  return object(value) && keys(value, ['name', 'source', 'kind', 'features', 'profile', 'executable', 'sha256']) && value['name'] === 'agent-browser' && value['source'] === 'cli/src/main.rs'
    && JSON.stringify(value['kind']) === '["bin"]' && JSON.stringify(value['features']) === JSON.stringify(feature ? ['acceptance-faults'] : []) && value['profile'] === 'ci'
    && typeof value['executable'] === 'string' && /^ci\/deps\/agent_browser-[a-f0-9]{8,64}$/.test(value['executable']) && hex(value['sha256']);
}
function resolveHarness(identity: RelativeHarness, source: string, target: string): string {
  if (realpathSync(join(source, identity.source)) !== resolve(source, identity.source)) throw new Error('Source is not canonical');
  const path = resolve(target, identity.executable);
  if (!within(resolve(target, 'ci'), path) || realpathSync(path) !== path || !within(realpathSync(target), path) || !statSync(path).isFile()) throw new Error('Harness escapes canonical compiled target');
  accessSync(path, constants.X_OK);
  if (hashFile(path) !== identity.sha256) throw new Error('Harness identity changed');
  return path;
}
/** Strong raw Cargo selection is unchanged; only the returned serializable identity is relative. */
export function matrixCompilerHarness(jsonLines: string, source: string, target: string, feature: boolean): SelectedHarness {
  if (Buffer.byteLength(jsonLines) > 8 * LIMIT) throw new Error('Compiler output exceeds bound');
  const candidates: ObjectValue[] = []; let finished = 0;
  for (const line of jsonLines.trim().split('\n')) {
    const item: unknown = JSON.parse(line); if (!object(item)) throw new Error('Invalid compiler record');
    if (item['reason'] === 'build-finished') { if (item['success'] !== true) throw new Error('Unsuccessful compilation'); finished++; }
    if (item['reason'] === 'compiler-artifact' && object(item['target']) && item['target']['name'] === 'agent-browser' && object(item['profile']) && item['profile']['test'] === true) candidates.push(item);
  }
  if (finished !== 1 || candidates.length !== 1) throw new Error('Missing or ambiguous successful harness compilation');
  const item = candidates[0]!; const metadata = item['target'] as ObjectValue;
  if (JSON.stringify(metadata['kind']) !== '["bin"]' || metadata['src_path'] !== resolve(source, 'cli/src/main.rs') || item['manifest_path'] !== resolve(source, 'cli/Cargo.toml')
    || JSON.stringify(item['features']) !== JSON.stringify(feature ? ['acceptance-faults'] : []) || typeof item['executable'] !== 'string' || !isAbsolute(item['executable']) || !within(resolve(target, 'ci'), item['executable'])) throw new Error('Harness is not from the exact source/profile/features');
  const identity: RelativeHarness = { name: 'agent-browser', source: 'cli/src/main.rs', kind: ['bin'], features: feature ? ['acceptance-faults'] : [], profile: 'ci', executable: relative(resolve(target), item['executable']), sha256: '0'.repeat(64) };
  if (!validHarness(identity, feature)) throw new Error('Unexpected selected artifact identity');
  const executable = resolve(target, identity.executable);
  if (realpathSync(executable) !== executable || !within(realpathSync(target), executable) || !statSync(executable).isFile()) throw new Error('Harness escapes canonical compiled target');
  identity.sha256 = hashFile(executable);
  return { identity, executable: resolveHarness(identity, source, target) };
}
export function compilerProof(stdout: string, stderr: string, processResult: ProcessFacts, selected: RelativeHarness | null): CompilerProof {
  const summary = proxyCompileEvidence(stdout, stderr);
  return { command: featureCompileArgs, process: { ...processResult }, stdout: digest(stdout), stderr: digest(stderr), errorCodes: summary.compilerErrorCodes,
    codesIncomplete: summary.compilerCodesIncomplete || ((!completed(processResult) || processResult.status !== 0) && summary.compilerErrorCodes.length === 0), selected };
}
function validCompiler(value: unknown): value is CompilerProof {
  return object(value) && keys(value, ['command', 'process', 'stdout', 'stderr', 'errorCodes', 'codesIncomplete', 'selected']) && JSON.stringify(value['command']) === JSON.stringify(featureCompileArgs)
    && validProcess(value['process']) && validDigest(value['stdout']) && validDigest(value['stderr']) && Array.isArray(value['errorCodes']) && value['errorCodes'].length <= 32
    && value['errorCodes'].every(code => typeof code === 'string' && /^E[0-9]{4}$/.test(code)) && new Set(value['errorCodes']).size === value['errorCodes'].length
    && typeof value['codesIncomplete'] === 'boolean' && (value['selected'] === null || validHarness(value['selected'], true));
}
const inventoryNames = (listing: string) => { if (Buffer.byteLength(listing) > LIMIT) throw new Error('Test inventory exceeds bound'); return listing.split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -6)); };
export function matrixInventory(listing: string): string[] { const found = inventoryNames(listing); if (!found.length || new Set(found).size !== found.length) throw new Error('Missing or duplicate test inventory'); return found; }
export function verifyFeatureDelta(defaults: readonly string[], features: readonly string[], ignored: readonly string[]) {
  if ([defaults, features, ignored].some(values => new Set(values).size !== values.length)) throw new Error('Duplicate test inventory');
  const added = features.filter(name => !defaults.includes(name)).toSorted(); const removed = defaults.filter(name => !features.includes(name)).toSorted();
  if (removed.length || JSON.stringify(added) !== JSON.stringify(REQUIRED_NATIVE_FEATURE_TESTS.toSorted())) throw new Error('Unexplained feature/default test inventory difference');
  if (ignored.some(name => !features.includes(name))) throw new Error('Ignored inventory contains an undiscovered test');
  if (REQUIRED_NATIVE_FEATURE_TESTS.some(name => ignored.includes(name))) throw new Error('A mandatory feature test is ignored');
  return { added, removed };
}
export function exactListing(listing: string, name: string) { try { return JSON.stringify(matrixInventory(listing)) === JSON.stringify([name]); } catch { return false; } }
const streamInventory = (result: ProcessResult): StreamInventory => { const found = inventoryNames(result.stdout); return { process: facts(result), stdout: digest(result.stdout), stderr: digest(result.stderr), entries: found.length, duplicates: found.length - new Set(found).size, knownNames: allNames.filter(name => found.includes(name)) }; };
/** Real full-set verification happens here in memory, before a closed proof may say verified. */
export function inventoryProof(mode: MatrixMode, normal: ProcessResult, feature: ProcessResult | null, ignored: ProcessResult): InventoryProof {
  const defaults = inventoryNames(normal.stdout); const features = feature === null ? [] : inventoryNames(feature.stdout); const skips = inventoryNames(ignored.stdout);
  const added = features.filter(name => !defaults.includes(name)); const removed = defaults.filter(name => !features.includes(name));
  const proof: InventoryProof = { schemaVersion: 1, kind: 'closed-native-inventory', mode, verified: false, default: streamInventory(normal), feature: feature === null ? null : streamInventory(feature), ignored: streamInventory(ignored),
    required: names(mode).map(name => ({ name, inDefault: defaults.includes(name), inFeature: features.includes(name), ignored: skips.includes(name) })),
    delta: mode === 'feature' ? { added: REQUIRED_NATIVE_FEATURE_TESTS.filter(name => added.includes(name)), addedCount: added.length, unexpectedAddedCount: added.filter(name => !(REQUIRED_NATIVE_FEATURE_TESTS as readonly string[]).includes(name)).length, removedDefaultCount: removed.length } : null };
  try {
    for (const result of [normal, ignored, ...(feature === null ? [] : [feature])]) { if (!completed(facts(result)) || result.status !== 0) return proof; matrixInventory(result.stdout); }
    if (mode === 'feature') { if (feature === null) return proof; verifyFeatureDelta(defaults, features, skips); }
    else if (PREPARATION_SETTLEMENT_TESTS.some(name => !defaults.includes(name) || skips.includes(name))) return proof;
    proof.verified = true;
  } catch { /* Counts/digests remain truthful; unverified sets never pass. */ }
  return proof;
}
function validInventoryStream(value: unknown): value is StreamInventory {
  return object(value) && keys(value, ['process', 'stdout', 'stderr', 'entries', 'duplicates', 'knownNames']) && validProcess(value['process']) && validDigest(value['stdout']) && validDigest(value['stderr']) && natural(value['entries']) && natural(value['duplicates'])
    && Array.isArray(value['knownNames']) && value['knownNames'].every(name => allNames.includes(name)) && new Set(value['knownNames']).size === value['knownNames'].length;
}
function validInventory(value: unknown, mode: MatrixMode): value is InventoryProof {
  if (!object(value) || !keys(value, ['schemaVersion', 'kind', 'mode', 'verified', 'default', 'feature', 'ignored', 'required', 'delta']) || value['schemaVersion'] !== 1 || value['kind'] !== 'closed-native-inventory' || value['mode'] !== mode || typeof value['verified'] !== 'boolean'
    || !validInventoryStream(value['default']) || !validInventoryStream(value['ignored']) || !(value['feature'] === null || validInventoryStream(value['feature'])) || !Array.isArray(value['required']) || value['required'].length !== names(mode).length) return false;
  if (!value['required'].every((entry: unknown, index) => object(entry) && keys(entry, ['name', 'inDefault', 'inFeature', 'ignored']) && entry['name'] === names(mode)[index] && ['inDefault', 'inFeature', 'ignored'].every(key => typeof entry[key] === 'boolean'))) return false;
  const delta = value['delta'];
  return mode === 'preparation' ? delta === null && value['feature'] === null : object(delta) && keys(delta, ['added', 'addedCount', 'unexpectedAddedCount', 'removedDefaultCount']) && Array.isArray(delta['added']) && delta['added'].every(name => (REQUIRED_NATIVE_FEATURE_TESTS as readonly string[]).includes(name)) && new Set(delta['added']).size === delta['added'].length && ['addedCount', 'unexpectedAddedCount', 'removedDefaultCount'].every(key => natural(delta[key]));
}
function inventoryPassed(proof: InventoryProof): boolean {
  const streams = [proof.default, proof.ignored, ...(proof.feature === null ? [] : [proof.feature])];
  if (!proof.verified || streams.some(value => !completed(value.process) || value.process.status !== 0 || value.entries === 0 || value.duplicates !== 0 || value.knownNames.length > value.entries)) return false;
  if (proof.mode === 'preparation') return proof.required.every(row => row.inDefault && !row.ignored && proof.default.knownNames.includes(row.name) && !proof.ignored.knownNames.includes(row.name));
  return proof.feature !== null && proof.delta !== null && JSON.stringify(proof.delta.added) === JSON.stringify(REQUIRED_NATIVE_FEATURE_TESTS) && proof.delta.addedCount === 31 && proof.delta.unexpectedAddedCount === 0 && proof.delta.removedDefaultCount === 0
    && proof.feature.entries === proof.default.entries + 31 && proof.required.every(row => !row.inDefault && row.inFeature && !row.ignored && !proof.default.knownNames.includes(row.name) && proof.feature!.knownNames.includes(row.name) && !proof.ignored.knownNames.includes(row.name));
}
export function normalizedTest(name: string, stdout: string): TestFacts {
  const running = [...stdout.matchAll(/^running (\d+) tests?$/gm)]; const results = [...stdout.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored[^\n]*)$/gm)];
  const summaries = [...stdout.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [^\n]+$/gm)];
  const number = (text: string | undefined) => text !== undefined && natural(Number(text)) ? Number(text) : null;
  const outcome = results[0]?.[2]; const summary = summaries[0];
  return { runningOne: /^running 1 test$/m.test(stdout), runningRecords: running.length, runningTests: number(running[0]?.[1]), resultRecords: results.length, nameMatches: results.length === 1 && results[0]?.[1] === name,
    outcome: outcome === 'ok' || outcome === 'FAILED' ? outcome : outcome?.startsWith('ignored') ? 'ignored' : null, summaryRecords: summaries.length, summary: summary?.[1] === 'ok' ? 'ok' : summary?.[1] === 'FAILED' ? 'FAILED' : null,
    passed: number(summary?.[2]), failed: number(summary?.[3]), ignored: number(summary?.[4]), measured: number(summary?.[5]), filtered: number(summary?.[6]) };
}
function validTestFacts(value: unknown): value is TestFacts {
  return object(value) && keys(value, ['runningOne', 'runningRecords', 'runningTests', 'resultRecords', 'nameMatches', 'outcome', 'summaryRecords', 'summary', 'passed', 'failed', 'ignored', 'measured', 'filtered'])
    && typeof value['runningOne'] === 'boolean' && ['runningRecords', 'resultRecords', 'summaryRecords'].every(key => natural(value[key])) && ['runningTests', 'passed', 'failed', 'ignored', 'measured', 'filtered'].every(key => value[key] === null || natural(value[key]))
    && typeof value['nameMatches'] === 'boolean' && [null, 'ok', 'FAILED', 'ignored'].includes(value['outcome'] as null) && [null, 'ok', 'FAILED'].includes(value['summary'] as null);
}
function assessFacts(test: TestFacts, processResult: ProcessFacts): Observation {
  if (!completed(processResult)) return { status: 'unknown', testStatus: 'unknown', problem: 'execution-incomplete' };
  if (!validTestFacts(test) || !test.runningOne || test.runningRecords !== 1 || test.runningTests !== 1 || test.resultRecords !== 1 || !test.nameMatches || test.summaryRecords !== 1) return { status: 'failed', testStatus: 'unknown', problem: 'invalid-test-output' };
  if (test.ignored !== 0 || test.measured !== 0 || test.passed === null || test.failed === null || test.passed + test.failed !== 1) return { status: 'failed', testStatus: 'unknown', problem: 'skipped-or-invalid-counts' };
  if (test.outcome === 'ok' && test.summary === 'ok' && test.passed === 1 && processResult.status === 0) return { status: 'passed', testStatus: 'passed', problem: null };
  if (test.outcome === 'FAILED' && test.summary === 'FAILED' && test.failed === 1 && processResult.status !== 0) return { status: 'failed', testStatus: 'failed', problem: 'test-failed' };
  return { status: 'failed', testStatus: 'unknown', problem: 'exit-output-disagreement' };
}
export function assessExactTest(name: string, stdout: string, processResult: ProcessFacts): Observation { return assessFacts(normalizedTest(name, stdout), processResult); }
export function matrixTestArgs(mode: MatrixMode, name: string): string[] { if (!names(mode).includes(name)) throw new Error('Test name is not in the exact matrix'); return [name, '--exact', '--test-threads=1', '--format=pretty', '--color=never']; }
const panicFile = (name: string) => { if (!allNames.includes(name)) return null; const module = name.split('::')[1]; return `cli/src/native/${module}.rs`; };
function validPanic(value: unknown, name: string): value is PanicSite | null { return value === null || (object(value) && keys(value, ['file', 'line', 'column']) && value['file'] === panicFile(name) && natural(value['line']) && value['line'] > 0 && value['line'] <= 1_000_000 && natural(value['column']) && value['column'] > 0 && value['column'] <= 65_535); }
function checkPanic(site: PanicSite, name: string, source: string): boolean {
  if (!validPanic(site, name)) return false;
  if (site === null) return false;
  const path = resolve(source, site.file);
  if (realpathSync(path) !== path || !within(realpathSync(source), path)) return false;
  execFileSync('git', ['-C', source, 'ls-files', '--error-unmatch', '--', site.file], { stdio: ['ignore', 'pipe', 'pipe'] });
  return site.line <= readFileSync(path, 'utf8').split('\n').length;
}
/** At most the first Rust panic location, from the exact test's canonical tracked owning file. */
export function panicSite(name: string, stdout: string, stderr: string, source: string): PanicSite | null {
  const match = `${stdout}\n${stderr}`.match(/^thread [^\r\n]{0,512} panicked at ([^\r\n]{1,4096}):(\d{1,7}):(\d{1,5}):$/m);
  if (!match) return null;
  const emitted = match[1]!; if (emitted.split(/[\\/]/).includes('..')) return null; const file = isAbsolute(emitted) ? relative(resolve(source), emitted) : emitted.startsWith('cli/') ? emitted : `cli/${emitted}`;
  const site = { file, line: Number(match[2]), column: Number(match[3]) };
  try { return checkPanic(site, name, source) ? site : null; } catch { return null; }
}
export function closedListing(name: string, result: ProcessResult): ListingProof { if (!allNames.includes(name)) throw new Error('Unlisted exact test'); const found = inventoryNames(result.stdout); return { schemaVersion: 1, kind: 'closed-native-discovery', name, process: facts(result), stdout: digest(result.stdout), stderr: digest(result.stderr), entries: found.length, duplicates: found.length - new Set(found).size, exact: exactListing(result.stdout, name) }; }
export function closedTest(name: string, result: ProcessResult, source: string): TestProof { if (!allNames.includes(name)) throw new Error('Unlisted exact test'); return { schemaVersion: 1, kind: 'closed-native-test', name, process: facts(result), stdout: digest(result.stdout), stderr: digest(result.stderr), test: normalizedTest(name, result.stdout), panicSite: panicSite(name, result.stdout, result.stderr, source) }; }
function validListing(value: unknown, name: string): value is ListingProof { return object(value) && keys(value, ['schemaVersion', 'kind', 'name', 'process', 'stdout', 'stderr', 'entries', 'duplicates', 'exact']) && value['schemaVersion'] === 1 && value['kind'] === 'closed-native-discovery' && value['name'] === name && validProcess(value['process']) && validDigest(value['stdout']) && validDigest(value['stderr']) && natural(value['entries']) && natural(value['duplicates']) && typeof value['exact'] === 'boolean'; }
function validTest(value: unknown, name: string): value is TestProof { return object(value) && keys(value, ['schemaVersion', 'kind', 'name', 'process', 'stdout', 'stderr', 'test', 'panicSite']) && value['schemaVersion'] === 1 && value['kind'] === 'closed-native-test' && value['name'] === name && validProcess(value['process']) && validDigest(value['stdout']) && validDigest(value['stderr']) && validTestFacts(value['test']) && validPanic(value['panicSite'], name); }
function validBinding(value: unknown, mode: MatrixMode): value is ObjectValue {
  if (!object(value) || !keys(value, ['sourceRevision', 'nativeSource', 'productionBinarySha256', 'platform', 'architecture', 'profile', 'defaultCompiler', 'defaultHarness', 'harness'], mode === 'feature' ? ['acceptanceFaultBinarySha256'] : []) || !hex(value['sourceRevision'], 40) || !hex(value['productionBinarySha256']) || value['platform'] !== 'linux' || !member(value['architecture'], ['x64', 'arm64']) || value['profile'] !== 'ci' || !validDigest(value['defaultCompiler']) || !validHarness(value['defaultHarness'], false) || !(value['harness'] === null || validHarness(value['harness'], mode === 'feature'))) return false;
  const source = value['nativeSource'];
  return object(source) && keys(source, ['repository', 'commit', 'tree', 'cargoLockSha256']) && source['repository'] === 'levicode/agent-browser' && hex(source['commit'], 40) && hex(source['tree'], 40) && hex(source['cargoLockSha256']) && (mode !== 'feature' || hex(value['acceptanceFaultBinarySha256']));
}
function validateRows(mode: MatrixMode, value: unknown): value is MatrixRow[] {
  return Array.isArray(value) && value.length === names(mode).length && value.every((row: unknown, index) => object(row) && keys(row, ['name', 'expectation', 'status', 'testStatus', 'problem', 'listing', 'execution', 'listingFile', 'listingSha256', 'file', 'proofSha256'])
    && row['name'] === names(mode)[index] && row['expectation'] === rows(mode)[index]!.expectation && member(row['status'], ['passed', 'failed', 'unknown']) && member(row['testStatus'], ['passed', 'failed', 'unknown'])
    && [null, 'not-executed', 'execution-incomplete', 'invalid-test-output', 'skipped-or-invalid-counts', 'exit-output-disagreement', 'test-failed', 'exact-discovery-incomplete', 'execution-evidence-error'].includes(row['problem'] as null)
    && (row['listing'] === null || validProcess(row['listing'])) && (row['execution'] === null || validProcess(row['execution']))
    && (row['file'] === null || row['file'] === fileName(mode, String(row['name']))) && (row['listingFile'] === null || row['listingFile'] === `${fileName(mode, String(row['name']))}.list.json`) && (row['proofSha256'] === null || hex(row['proofSha256'])) && (row['listingSha256'] === null || hex(row['listingSha256']))
    && (row['status'] !== 'passed' || (row['testStatus'] === 'passed' && row['problem'] === null)));
}
const stages = ['started', 'identity', 'compile', 'inventory', 'execute', 'verified', 'identity-changed', 'interrupted'];
function validExecution(mode: MatrixMode, value: unknown): value is MatrixExecution {
  return object(value) && keys(value, ['schemaVersion', 'kind', 'mode', 'stage', 'status', 'required', 'results', 'releaseEligible', 'acceptanceEvidence'], ['binding', 'inventory', 'compile', 'problem']) && value['schemaVersion'] === 1 && value['kind'] === kind(mode) && value['mode'] === mode && member(value['stage'], stages) && member(value['status'], ['passed', 'failed', 'unknown'])
    && value['releaseEligible'] === false && value['acceptanceEvidence'] === true && JSON.stringify(value['required']) === JSON.stringify(names(mode)) && validateRows(mode, value['results'])
    && (!Object.hasOwn(value, 'binding') || validBinding(value['binding'], mode)) && (!Object.hasOwn(value, 'compile') || (mode === 'feature' && validCompiler(value['compile'])))
    && (!Object.hasOwn(value, 'problem') || stages.some(stage => value['problem'] === `matrix-stopped-at-${stage}`))
    && (!Object.hasOwn(value, 'inventory') || (object(value['inventory']) && keys(value['inventory'], ['file', 'sha256']) && value['inventory']['file'] === `${stem(mode)}-inventory.proof.json` && hex(value['inventory']['sha256'])));
}
const aggregate = (results: MatrixRow[]): Status => results.some(row => row.status === 'unknown') ? 'unknown' : results.every(row => row.status === 'passed') ? 'passed' : 'failed';
const knownOutcome = (value: unknown) => member(value, ['success', 'failure', 'skipped', 'cancelled']) ? value : 'missing';
export function finalizeMatrixReceipt(mode: MatrixMode, steps: Record<string, { outcome?: string }>, input?: MatrixExecution) {
  const execution = validExecution(mode, input) ? input : undefined;
  const step = knownOutcome(steps[stem(mode)]?.outcome); const prerequisites = Object.fromEntries(['native-build', ...(mode === 'feature' ? ['fault-build'] : [])].map(id => [id, knownOutcome(steps[id]?.outcome)]));
  const results = execution?.results ?? rows(mode);
  const compileComplete = mode === 'preparation' || (execution?.compile !== undefined && completed(execution.compile.process) && execution.compile.process.status === 0 && execution.compile.stdout.bytes > 0 && execution.compile.errorCodes.length === 0 && execution.compile.selected !== null && JSON.stringify(execution.compile.selected) === JSON.stringify(execution.binding?.['harness']));
  const complete = compileComplete && execution !== undefined && execution.stage === 'verified' && execution.binding !== undefined && execution.binding['harness'] !== null && execution.inventory !== undefined
    && results.every(row => row.testStatus !== 'unknown' && row.execution !== null && completed(row.execution) && row.listing !== null && completed(row.listing) && row.listing.status === 0 && row.file !== null && row.listingFile !== null && row.proofSha256 !== null && row.listingSha256 !== null);
  const eligible = step === 'success' && Object.values(prerequisites).every(value => value === 'success') && complete && execution.status === 'passed' && aggregate(results) === 'passed';
  const status: Status = eligible ? 'passed' : ['missing', 'skipped', 'cancelled'].includes(step) || execution === undefined ? 'unknown' : execution.status === 'unknown' ? 'unknown' : 'failed';
  return { schemaVersion: 1, kind: kind(mode), mode, status, step, prerequisites, complete, required: names(mode), results, binding: execution?.binding ?? null, inventory: execution?.inventory ?? null, compile: execution?.compile ?? null,
    executionStatus: execution?.status ?? 'missing', stage: execution?.stage ?? 'missing', releaseEligible: false, acceptanceEvidence: true,
    note: mode === 'preparation' ? 'Required default-harness preparation regression: all eight exact tests must execute, none ignored, and all must pass. Historical CI14 RED is not rewritten.' : 'Required closed execution-time proof. Raw listings are not retained or reconstructed from hashes; current source/harness identity is rechecked. All 31 exact tests must pass.' };
}
const readProof = (path: string): unknown => { if (statSync(path).size > 4 * LIMIT) throw new Error('Proof exceeds bound'); return JSON.parse(readFileSync(path, 'utf8')); };
/** Verify closed execution-time facts, NOT a reconstruction of discarded raw output from its hashes. */
export function verifyFeatureMatrixReceipt(output: string, expectedBinding: ObjectValue, paths: { source: string; target: string }): void {
  try { verifyMatrixProof('feature', output, expectedBinding, paths); } catch { throw new Error('Required native feature closed proof is invalid or incomplete'); }
}
export function verifyPreparationMatrixReceipt(output: string, expectedBinding: ObjectValue, paths: { source: string; target: string }): void {
  try { verifyMatrixProof('preparation', output, expectedBinding, paths); } catch { throw new Error('Required preparation closed proof is invalid or incomplete'); }
}
function verifyMatrixProof(mode: MatrixMode, output: string, expectedBinding: ObjectValue, paths: { source: string; target: string }): void {
  const receipt = readProof(join(output, `${stem(mode)}.result.json`)); const executionFile = join(output, `${stem(mode)}.execution.json`); const execution = readProof(executionFile);
  if (!object(receipt) || !keys(receipt, ['schemaVersion', 'kind', 'mode', 'status', 'step', 'prerequisites', 'complete', 'required', 'results', 'binding', 'inventory', 'compile', 'executionStatus', 'stage', 'releaseEligible', 'acceptanceEvidence', 'note', 'executionSha256']) || !validExecution(mode, execution)
    || receipt['executionSha256'] !== hashFile(executionFile)) throw new Error('Missing closed feature matrix receipt');
  const expectedReceipt = finalizeMatrixReceipt(mode, { 'native-build': { outcome: 'success' }, 'fault-build': { outcome: 'success' }, [stem(mode)]: { outcome: 'success' } }, execution);
  if (JSON.stringify(receipt) !== JSON.stringify({ ...expectedReceipt, executionSha256: hashFile(executionFile) }) || expectedReceipt.status !== 'passed' || !execution.binding || !execution.inventory || (mode === 'feature' && !execution.compile)) throw new Error('Feature matrix is not completely passing');
  const binding = execution.binding;
  for (const [key, value] of Object.entries(expectedBinding)) if (JSON.stringify(binding[key]) !== JSON.stringify(value)) throw new Error('Feature matrix binding mismatch');
  if (!isAbsolute(paths.source) || !isAbsolute(paths.target) || binding['architecture'] !== process.arch) throw new Error('Trusted current runner paths/platform are required');
  const native = binding['nativeSource'] as ObjectValue;
  if (JSON.stringify(sourceIdentity(paths.source, String(native['commit']))) !== JSON.stringify(native)) throw new Error('Feature native source changed');
  const compilerFile = join(output, 'compiler.jsonl'); const rawDefault = readFileSync(compilerFile, 'utf8');
  const defaultHarness = matrixCompilerHarness(rawDefault, paths.source, paths.target, false);
  if (JSON.stringify(binding['defaultCompiler']) !== JSON.stringify(digest(rawDefault)) || JSON.stringify(binding['defaultHarness']) !== JSON.stringify(defaultHarness.identity)) throw new Error('Default compiler/harness identity changed');
  if (mode === 'feature') {
  const compiled = execution.compile!;
  if (!completed(compiled.process) || compiled.process.status !== 0 || compiled.selected === null || compiled.errorCodes.length !== 0 || JSON.stringify(compiled.selected) !== JSON.stringify(binding['harness'])) throw new Error('Successful feature compilation is unproved');
  resolveHarness(compiled.selected, paths.source, paths.target);
  } else if (JSON.stringify(binding['harness']) !== JSON.stringify(defaultHarness.identity) || execution.compile !== undefined) {
    throw new Error('Preparation must use the verified default test harness');
  }
  const inventoryFile = join(output, execution.inventory.file); if (hashFile(inventoryFile) !== execution.inventory.sha256) throw new Error('Inventory proof changed');
  const inventory = readProof(inventoryFile); if (!validInventory(inventory, mode) || !inventoryPassed(inventory)) throw new Error('Closed feature inventory delta is unproved');
  for (const row of execution.results) {
    if (row.file === null || row.listingFile === null || row.status !== 'passed' || row.proofSha256 !== hashFile(join(output, row.file)) || row.listingSha256 !== hashFile(join(output, row.listingFile))) throw new Error('Feature exact proof is missing or changed');
    const discovery = readProof(join(output, row.listingFile)); const proof = readProof(join(output, row.file));
    if (!validListing(discovery, row.name) || !validTest(proof, row.name) || !discovery.exact || discovery.entries !== 1 || discovery.duplicates !== 0 || !completed(discovery.process) || discovery.process.status !== 0
      || JSON.stringify(discovery.process) !== JSON.stringify(row.listing) || JSON.stringify(proof.process) !== JSON.stringify(row.execution) || assessFacts(proof.test, proof.process).status !== 'passed') throw new Error('Closed exact execution proof is invalid');
    if (proof.panicSite !== null && !checkPanic(proof.panicSite, row.name, paths.source)) throw new Error('Unverified panic location');
  }
}
function persistProof(output: string, file: string, value: unknown) { writeFileSync(join(output, file), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); return { file, sha256: hashFile(join(output, file)) }; }
async function runMatrix(mode: MatrixMode, args: string[]): Promise<void> {
  const [sourceArg, targetArg, productionArg, faultArg, outputArg, expectedSha] = args;
  if (!sourceArg || !targetArg || !productionArg || !faultArg || !outputArg || !expectedSha) throw new Error('Explicit source, target, runtime, evidence and source SHA required');
  const output = resolve(outputArg); mkdirSync(output, { recursive: true }); const execution = base(mode); const executionFile = join(output, `${stem(mode)}.execution.json`);
  writeFileSync(executionFile, JSON.stringify(execution, null, 2), { flag: 'wx', mode: 0o600 });
  const checkpoint = (stage: string) => { execution.stage = stage; if (!validExecution(mode, execution)) throw new Error('Nonclosed execution facts'); writeFileSync(executionFile, JSON.stringify(execution, null, 2)); };
  const controller = new AbortController(); const interrupted = () => controller.abort(); const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const; for (const signal of signals) process.on(signal, interrupted);
  let pinned: (() => void) | undefined;
  try {
    if (process.platform !== 'linux') throw new Error('Linux harness matrix required'); checkpoint('identity');
    const source = resolve(sourceArg); const target = resolve(targetArg); const production = resolve(productionArg); const fault = mode === 'feature' ? resolve(faultArg) : undefined;
    const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const sourceRevision = git('rev-parse', 'HEAD'); if (git('status', '--porcelain')) throw new Error('Matrix requires clean E2E source');
    const nativeSource = sourceIdentity(source, expectedSha); const productionBinarySha256 = hashFile(production); const acceptanceFaultBinarySha256 = fault === undefined ? undefined : hashFile(fault);
    if (fault !== undefined && (realpathSync(fault) === realpathSync(production) || acceptanceFaultBinarySha256 === productionBinarySha256)) throw new Error('Runtime identities are not separate');
    pinned = () => { if (git('rev-parse', 'HEAD') !== sourceRevision || git('status', '--porcelain') || JSON.stringify(sourceIdentity(source, expectedSha)) !== JSON.stringify(nativeSource) || hashFile(production) !== productionBinarySha256 || (fault !== undefined && hashFile(fault) !== acceptanceFaultBinarySha256)) throw new Error('Pinned source/runtime changed'); };
    const rawDefault = readFileSync(join(output, 'compiler.jsonl'), 'utf8'); const defaultHarness = matrixCompilerHarness(rawDefault, source, target, false); let selected = defaultHarness;
    execution.binding = { sourceRevision, nativeSource, productionBinarySha256, ...(acceptanceFaultBinarySha256 === undefined ? {} : { acceptanceFaultBinarySha256 }), platform: process.platform, architecture: process.arch, profile: 'ci', defaultCompiler: digest(rawDefault), defaultHarness: defaultHarness.identity, harness: mode === 'feature' ? null : defaultHarness.identity };
    if (mode === 'feature') {
      checkpoint('compile'); const compile = await runProxyCommand('cargo', featureCompileArgs, { cwd: join(source, 'cli'), env: { ...proxyEnvironment(process.env), CARGO_TARGET_DIR: target }, timeoutMs: 900_000, maxBuffer: 8 * LIMIT, signal: controller.signal });
      execution.compile = compilerProof(compile.stdout, compile.stderr, facts(compile), null); pinned();
      if (!completed(facts(compile)) || compile.status !== 0) { execution.status = completed(facts(compile)) ? 'failed' : 'unknown'; throw new Error('Feature compilation incomplete'); }
      selected = matrixCompilerHarness(compile.stdout, source, target, true); execution.compile.selected = selected.identity; execution.binding['harness'] = selected.identity;
    }
    if ([productionBinarySha256, acceptanceFaultBinarySha256].includes(selected.identity.sha256) || realpathSync(production) === selected.executable || (fault !== undefined && realpathSync(fault) === selected.executable)) throw new Error('Harness aliases runtime');
    const run = async (harness: SelectedHarness, testArgs: string[], timeoutMs: number) => { resolveHarness(harness.identity, source, target); return runProxyCommand(harness.executable, testArgs, { cwd: join(source, 'cli'), env: proxyEnvironment(process.env), timeoutMs, maxBuffer: LIMIT, signal: controller.signal }); };
    checkpoint('inventory');
    const normal = await run(defaultHarness, ['--list', '--format=terse'], 30_000); const ignored = await run(selected, ['--ignored', '--list', '--format=terse'], 30_000); const feature = mode === 'feature' ? await run(selected, ['--list', '--format=terse'], 30_000) : null;
    const inventory = inventoryProof(mode, normal, feature, ignored); execution.inventory = persistProof(output, `${stem(mode)}-inventory.proof.json`, inventory);
    if (!inventory.verified) { execution.status = [normal, ignored, ...(feature === null ? [] : [feature])].every(value => completed(facts(value))) ? 'failed' : 'unknown'; throw new Error('Inventory not verified'); }
    checkpoint('execute');
    for (const row of execution.results) {
      if (controller.signal.aborted) break;
      try {
        const discovery = await run(selected, [row.name, '--exact', '--list', '--format=terse'], 30_000); const listing = closedListing(row.name, discovery);
        row.listing = facts(discovery); const listed = persistProof(output, `${fileName(mode, row.name)}.list.json`, listing); row.listingFile = listed.file; row.listingSha256 = listed.sha256;
        if (!completed(row.listing) || row.listing.status !== 0 || !listing.exact) { row.problem = 'exact-discovery-incomplete'; row.status = completed(row.listing) ? 'failed' : 'unknown'; continue; }
        const result = await run(selected, matrixTestArgs(mode, row.name), mode === 'preparation' ? 30_000 : 180_000); const proof = closedTest(row.name, result, source);
        row.execution = facts(result); const saved = persistProof(output, fileName(mode, row.name), proof); row.file = saved.file; row.proofSha256 = saved.sha256; Object.assign(row, assessFacts(proof.test, proof.process));
      } catch { row.problem = 'execution-evidence-error'; row.status = 'unknown'; row.testStatus = 'unknown'; }
      finally { checkpoint('execute'); }
    }
    pinned(); resolveHarness(selected.identity, source, target); resolveHarness(defaultHarness.identity, source, target); execution.status = aggregate(execution.results); checkpoint('verified');
  } catch { execution.problem = `matrix-stopped-at-${execution.stage}`; if (execution.status === 'passed') execution.status = 'failed'; process.stderr.write(`${stem(mode)} did not establish a passing matrix.\n`); }
  finally {
    try { pinned?.(); } catch { execution.status = 'failed'; execution.stage = 'identity-changed'; }
    if (controller.signal.aborted) { execution.status = 'unknown'; execution.stage = 'interrupted'; } for (const signal of signals) process.off(signal, interrupted);
    const safe = validExecution(mode, execution) ? execution : base(mode);
    writeFileSync(executionFile, JSON.stringify(safe, null, 2)); if (safe.status !== 'passed') process.exitCode = 1;
  }
}
function finalize(mode: MatrixMode, outputArg: string): void {
  const output = resolve(outputArg); mkdirSync(output, { recursive: true }); const file = join(output, `${stem(mode)}.execution.json`); let execution: MatrixExecution | undefined;
  try { const parsed = readProof(file); if (validExecution(mode, parsed)) execution = parsed; } catch { /* Missing/unparseable means unknown. */ }
  let steps: Record<string, { outcome?: string }> = {}; try { const parsed: unknown = JSON.parse(process.env['GATE_OUTCOMES'] ?? '{}'); if (object(parsed)) steps = parsed as typeof steps; } catch { /* Missing step facts cannot pass. */ }
  const result = finalizeMatrixReceipt(mode, steps, execution); writeFileSync(join(output, `${stem(mode)}.result.json`), JSON.stringify({ ...result, ...(execution === undefined ? {} : { executionSha256: hashFile(file) }) }, null, 2)); if (result.status !== 'passed') process.exitCode = 1;
}
async function main(args: string[]): Promise<void> { const receipt = args[0] === 'receipt'; const mode = args[receipt ? 1 : 0]; if (mode !== 'preparation' && mode !== 'feature') throw new Error('Expected preparation or feature matrix'); if (receipt) { if (!args[2]) throw new Error('Evidence directory required'); finalize(mode, args[2]); } else await runMatrix(mode, args.slice(1)); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
