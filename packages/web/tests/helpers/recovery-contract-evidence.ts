/** P07 only: retain the existing passive contract after cleanup, before its error propagates. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validSyntheticFact } from './synthetic-evidence.ts';
const sources = ['../integration/cdp-recovery.test.ts', './recovery-contract-evidence.ts', './native-terminal-close-observer.ts', './synthetic-native-outcomes.ts', './synthetic-evidence.ts', '../../src/native/client.ts'] as const;
function identity() {
  const hash = (path: string | URL) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }).trim();
  const executable = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
  return { sourceCommit: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'), worktreeDirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
    nativeBinarySha256: executable ? hash(executable) : null,
    sources: sources.map(file => ({ file, sha256: hash(new URL(file, import.meta.url)) })) };
}
/** Read only finite inert JSON data; never execute accessors or custom serialization. */
function inert(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error('depth');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length < 256) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) throw new Error('type');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 16 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('array');
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('descriptor');
      return inert(descriptor.value, depth + 1);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('prototype');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === 'toJSON') throw new Error('key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('descriptor');
    result[key] = inert(descriptor.value, depth + 1);
  }
  return result;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('keys');
  return value as Record<string, unknown>;
}
export function retainP07Contract(contract: unknown, outcome: unknown, emit: (line: string) => void = line => { process.stderr.write(line); }, readIdentity: () => unknown = identity): void {
  const report: Record<string, unknown> = { schemaVersion: 1, caseId: 'P07', invalid: false, contract: null, outcome: null, identity: null, coverage: 'observed-only', nativeOrigin: 'unknown' };
  try {
    const data = object(inert(contract), ['schemaVersion', 'caseId', 'invalid', 'facts', 'terminalCleanup']);
    if (data['schemaVersion'] !== 1 || data['caseId'] !== 'P07' || typeof data['invalid'] !== 'boolean' || !Array.isArray(data['facts']) || data['facts'].length > 3) throw new Error('contract');
    const slots = new Set<string>();
    for (const fact of data['facts']) {
      if (!validSyntheticFact(fact, 'P07') || (fact.kind !== 'selected-operation' && fact.kind !== 'cleanup-native')) throw new Error('fact');
      const slot = fact.kind === 'selected-operation' ? `selected-${fact.ordinal}` : 'cleanup';
      if (slots.has(slot)) throw new Error('duplicate'); slots.add(slot);
    }
    const terminal = object(data['terminalCleanup'], ['invalid', 'exchanges', 'pending', 'validatedClosed', 'generationMatched', 'terminalAtExchange', 'ordinaryPendingAtExchange', 'ordinaryPendingAfterClose', 'settled']);
    for (const key of ['invalid', 'generationMatched', 'terminalAtExchange']) if (typeof terminal[key] !== 'boolean') throw new Error('boolean');
    for (const key of ['exchanges', 'pending', 'validatedClosed', 'ordinaryPendingAtExchange', 'ordinaryPendingAfterClose']) {
      if (key === 'ordinaryPendingAfterClose' && terminal[key] === null) continue;
      if (!Number.isSafeInteger(terminal[key]) || (terminal[key] as number) < 0 || (terminal[key] as number) > 256) throw new Error('count');
    }
    if (!['not-observed', 'pending', 'fulfilled', 'rejected'].includes(terminal['settled'] as string)) throw new Error('settled');
    const phases = object(inert(outcome), ['setup', 'body', 'cleanup']);
    if (Object.values(phases).some(value => !['not-started', 'passed', 'failed', 'incomplete'].includes(value as string))) throw new Error('outcome');
    report['contract'] = data; report['outcome'] = phases;
  } catch { report['invalid'] = true; }
  try {
    const data = object(inert(readIdentity()), ['sourceCommit', 'sourceTree', 'worktreeDirty', 'nativeBinarySha256', 'sources']);
    if (!/^[a-f0-9]{40}$/.test(data['sourceCommit'] as string) || !/^[a-f0-9]{40}$/.test(data['sourceTree'] as string) || typeof data['worktreeDirty'] !== 'boolean'
      || !(data['nativeBinarySha256'] === null || /^[a-f0-9]{64}$/.test(data['nativeBinarySha256'] as string)) || !Array.isArray(data['sources']) || data['sources'].length !== sources.length) throw new Error('identity');
    data['sources'].forEach((entry, index) => { const source = object(entry, ['file', 'sha256']); if (source['file'] !== sources[index] || !/^[a-f0-9]{64}$/.test(source['sha256'] as string)) throw new Error('source'); });
    report['identity'] = data;
  } catch { report['invalid'] = true; }
  try { const text = JSON.stringify(report); if (text.length <= 16384) emit('P07_RECOVERY_CONTRACT ' + text + '\n'); } catch { /* Original result/cleanup error always wins; missing evidence is unknown. */ }
}
