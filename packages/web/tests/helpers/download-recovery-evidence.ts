/** Passive P12-only diagnostics: never changes admission, cancellation, or test outcome. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { validSyntheticFact, type SyntheticEvidence, type SyntheticFact } from './synthetic-evidence.ts';

export const DOWNLOAD_RECOVERY_SOURCE_FILES = [
  '../integration/cdp-recovery.test.ts', './download-recovery-evidence.ts', './synthetic-evidence.ts', './synthetic-native-outcomes.ts',
  '../../src/browser.ts', '../../src/native/browser-channel.ts', '../../src/native/client.ts',
] as const;
/** Synchronous pre-body identity collection can perturb scheduling; it does not add a retry or await to business operations. */
function identity() {
  const digest = (file: string | URL) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const worktreeDirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
  const declaredNativeCommit: unknown = JSON.parse(readFileSync(new URL('../../../../.github/native-candidate.json', import.meta.url), 'utf8')).commit;
  const claimedCommit = process.env['GITHUB_SHA'];
  const executable = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
  return {
    claimedCommit: claimedCommit && /^[a-f0-9]{40}$/.test(claimedCommit) ? claimedCommit : null,
    sourceCommit, sourceTree, worktreeDirty,
    declaredNativeCommit: typeof declaredNativeCommit === 'string' && /^[a-f0-9]{40}$/.test(declaredNativeCommit) ? declaredNativeCommit : null,
    runtimeIdentity: executable ? 'binary-hashed' : 'unavailable',
    nodeVersion: process.version,
    nativeBinarySha256: executable ? digest(executable) : null,
    sources: DOWNLOAD_RECOVERY_SOURCE_FILES.map(file => ({ file, sha256: digest(new URL(file, import.meta.url)) })),
  };
}

/** Reject getters, inherited/custom serialization, symbols and undeclared fields before reading any value. */
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid diagnostic object');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('Invalid diagnostic keys');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid diagnostic descriptor');
    copy[key] = descriptor.value;
  }
  return copy;
}
function projectIdentity(value: unknown) {
  const data = closed(value, ['claimedCommit', 'sourceCommit', 'sourceTree', 'worktreeDirty', 'declaredNativeCommit', 'runtimeIdentity', 'nodeVersion', 'nativeBinarySha256', 'sources']);
  const digest = (candidate: unknown, size: number) => typeof candidate === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(candidate);
  if (!digest(data['sourceCommit'], 40) || !digest(data['sourceTree'], 40)
    || !(data['claimedCommit'] === null || digest(data['claimedCommit'], 40))
    || !(data['declaredNativeCommit'] === null || digest(data['declaredNativeCommit'], 40))
    || typeof data['worktreeDirty'] !== 'boolean'
    || typeof data['nodeVersion'] !== 'string' || !/^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(data['nodeVersion'])
    || !(data['runtimeIdentity'] === 'binary-hashed' && digest(data['nativeBinarySha256'], 64)
      || data['runtimeIdentity'] === 'unavailable' && data['nativeBinarySha256'] === null)) throw new Error('Invalid diagnostic identity');
  const sources = data['sources'];
  if (!Array.isArray(sources) || Object.getPrototypeOf(sources) !== Array.prototype
    || Reflect.ownKeys(sources).length !== DOWNLOAD_RECOVERY_SOURCE_FILES.length + 1
    || Object.getOwnPropertyDescriptor(sources, 'length')?.value !== DOWNLOAD_RECOVERY_SOURCE_FILES.length) throw new Error('Invalid diagnostic sources');
  data['sources'] = DOWNLOAD_RECOVERY_SOURCE_FILES.map((file, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(sources, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid diagnostic source');
    const source = closed(descriptor.value, ['file', 'sha256']);
    if (source['file'] !== file || !digest(source['sha256'], 64)) throw new Error('Invalid diagnostic source identity');
    return source;
  });
  return data;
}
function projectOutcome(value: unknown) {
  const outcome = closed(value, ['setup', 'body', 'cleanup']);
  for (const status of Object.values(outcome)) if (!['not-started', 'passed', 'failed', 'incomplete'].includes(status as string)) throw new Error('Invalid diagnostic outcome');
  return outcome as unknown as Parameters<SyntheticEvidence['finish']>[0];
}

export function downloadRecoveryEvidence(sink: SyntheticEvidence, meta: Record<string, unknown>,
  emit: (line: string) => void = line => { process.stderr.write(line); },
  readIdentity: () => unknown = identity): SyntheticEvidence {
  const report = { schemaVersion: 1, caseId: 'P12', invalid: false, finished: false,
    identity: null as unknown, facts: [] as SyntheticFact[], outcome: null as unknown };
  const safely = (body: () => void): void => { try { body(); } catch { report.invalid = true; } };
  safely(() => { report.identity = projectIdentity(readIdentity()); });
  safely(() => { meta['downloadRecoveryDiagnostic'] = report; });
  const capture = (fact: SyntheticFact): boolean => {
    let accepted = false;
    safely(() => {
      if (!validSyntheticFact(fact, 'P12') || report.facts.length >= 32 || report.finished) { report.invalid = true; return; }
      report.facts.push(structuredClone(fact)); accepted = true;
    });
    return accepted;
  };
  return {
    available: sink.available,
    record(fact) { capture(fact); safely(() => sink.record(fact)); },
    tryRecord(fact) { const accepted = capture(fact); safely(() => { sink.tryRecord(fact); }); return accepted; },
    observe(read) { safely(() => { const fact = read(); capture(fact); sink.record(fact); }); },
    invalidate() { report.invalid = true; safely(() => sink.invalidate()); },
    finish(outcome) {
      if (report.finished) { report.invalid = true; return; }
      safely(() => { report.outcome = projectOutcome(outcome); });
      if (report.outcome !== null) safely(() => sink.finish(report.outcome as Parameters<SyntheticEvidence['finish']>[0]));
      report.finished = true;
      safely(() => emit(`DOWNLOAD_RECOVERY_DIAGNOSTIC ${JSON.stringify(report)}\n`));
    },
  };
}
