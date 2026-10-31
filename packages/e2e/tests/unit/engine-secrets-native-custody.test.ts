/** Temporary-filesystem custody controls. Fake executable bytes are never executed. */
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareEngineSecretsNativeCustody } from '../helpers/engine-secrets-native-custody.ts';

const statControl = vi.hoisted(() => ({ field: undefined as 'uid' | 'mode' | 'nlink' | 'ctimeMs' | 'mtimeMs' | undefined, calls: 0 }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, fstatSync: (fd: number) => {
    const value = actual.fstatSync(fd); statControl.calls++;
    if (statControl.field !== undefined && statControl.calls === 2) return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { [statControl.field]: value[statControl.field] + 1 });
    return value;
  } };
});
const envKeys = ['GITHUB_WORKSPACE', 'E2E_AGENT_BROWSER_EXECUTABLE', 'E2E_DIAGNOSTIC_INVOCATIONS'] as const;
let previous: (string | undefined)[];
let roots: string[];
beforeEach(() => { statControl.field = undefined; statControl.calls = 0; previous = envKeys.map(key => process.env[key]); roots = []; });
afterEach(() => { vi.restoreAllMocks(); envKeys.forEach((key, i) => { const value = previous[i]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value) + '\n';
const identity = { consumerRun: '12345', consumerAttempt: '2', selector: process.version.slice(1), nodeVersion: process.version, sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40) };
const nonce = 'a'.repeat(64); const invocationNonce = 'b'.repeat(64);
function fixture(prepare = true, fixtureIdentity = identity) {
  const identity = fixtureIdentity;
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'secrets-native-pure-')); roots.push(workspace);
  const evidence = path.join(workspace, 'evidence'); const invocations = path.join(evidence, 'fixture-invocations');
  const tools = path.join(evidence, 'tools'); const scripts = path.join(workspace, 'scripts', 'ci');
  const fixtureRoot = path.join(evidence, 'fixtures', identity.selector, 'core');
  for (const directory of [invocations, tools, scripts, fixtureRoot]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const project = path.join(workspace, 'p-0123456789ab'); mkdirSync(project, { mode: 0o700 });
  const native = path.join(workspace, 'fake-native'); const wrapper = path.join(tools, 'popup-trace.sh');
  const nativeBytes = '# synthetic ordinary binary: never execute\n'; const wrapperBytes = '# synthetic wrapper: never execute\n';
  writeFileSync(native, nativeBytes, { mode: 0o700 }); writeFileSync(wrapper, wrapperBytes, { mode: 0o700 });
  writeFileSync(path.join(scripts, 'native-trace-wrapper.sh'), wrapperBytes, { mode: 0o700 });
  writeFileSync(path.join(scripts, 'native-closed-trace-schema.json'), readFileSync(new URL('../../../../scripts/ci/native-closed-trace-schema.json', import.meta.url)));
  const bindingFile = path.join(fixtureRoot, 'binding.json');
  const binding = { run: identity.consumerRun, attempt: identity.consumerAttempt, selector: identity.selector, nodeVersion: identity.nodeVersion, sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree, lane: 'core', nativeSha256: { ordinary: sha(nativeBytes) } };
  writeFileSync(bindingFile, json(binding));
  process.env['GITHUB_WORKSPACE'] = workspace; process.env['E2E_AGENT_BROWSER_EXECUTABLE'] = native; process.env['E2E_DIAGNOSTIC_INVOCATIONS'] = invocations;
  const create = () => prepareEngineSecretsNativeCustody(nonce, identity, project);
  const prepared = prepare ? create() : undefined;
  const trace = path.join(project, '.e2e', 'native-trace'); const output = path.join(evidence, 'engine-secrets-native', nonce);
  const row = (pid: number) => ({ schemaVersion: 2, source: 'native', pid, record: 0, operationSeq: 0, phase: 'CaptureStarted', droppedBefore: 0, emittedBefore: 0, suppressedBefore: 0, overflow: false });
  const seed = (proxyPid = 41001, daemonPid = 51001, token = invocationNonce) => {
    const invocation = { schemaVersion: 2, pid: proxyPid, nonce: token, traceDirectory: trace, nativeExecutable: native, nativeSHA256: sha(nativeBytes), wrapperSHA256: sha(wrapperBytes), run: identity.consumerRun, attempt: identity.consumerAttempt, sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree };
    const bytes = json(invocation); writeFileSync(path.join(invocations, `invocation-${proxyPid}.json`), bytes, { mode: 0o600 });
    const mapping = { schemaVersion: 1, kind: 'spawn-owned-daemon', proxyPID: proxyPid, daemonPID: daemonPid, nonce: token, invocationSHA256: sha(bytes) };
    writeFileSync(path.join(invocations, `daemon-${proxyPid}.json`), json(mapping), { mode: 0o600 });
    for (const kind of ['native', 'query']) writeFileSync(path.join(trace, `${kind}-${proxyPid}.jsonl`), json(row(daemonPid)), { mode: 0o600 });
    return { invocation, mapping, proxyPid, daemonPid };
  };
  const rows = (proxyPid = 41001, client = 1) => [{ v: 1, kind: 'process-binding', workerOrdinal: 1, surface: 1, attempt: 1, caseOrdinal: 1, client, proxyPid }];
  return { workspace, evidence, invocations, native, wrapper, scripts, bindingFile, binding, project, create, prepared, trace, output, row, seed, rows };
}

describe('original native invocation custody without executable launch', () => {
  it('prepares only the explicit wrapper overlay and archives exact owned v2/daemon/closed files', () => {
    const f = fixture(); expect(f.prepared).toBeDefined(); f.seed();
    expect(f.prepared!.env['E2E_AGENT_BROWSER_EXECUTABLE']).toBe(f.wrapper);
    expect(f.prepared!.env['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE']).toBe(f.native);
    expect(f.prepared!.env['E2E_DIAGNOSTIC_DIR']).toBe(f.trace);
    expect(process.env['E2E_AGENT_BROWSER_EXECUTABLE']).toBe(f.native);
    expect(f.prepared!.archive(f.rows())).toBe(true);
    expect(readdirSync(f.output).sort()).toEqual(['custody.json', 'daemon-41001.json', 'invocation-41001.json', 'native-41001.jsonl', 'query-41001.jsonl']);
    const extra = fixture(false); const extendedIdentity = { ...identity, caseSchema: 'engine-secrets-five-v1', payload: 'PRIVATE_IDENTITY_CANARY' };
    const prepared = prepareEngineSecretsNativeCustody(nonce, extendedIdentity, extra.project); extra.seed();
    expect(prepared?.archive(extra.rows())).toBe(true);
    const metadata = readFileSync(path.join(extra.output, 'custody.json'), 'utf8');
    expect(metadata).not.toContain('caseSchema'); expect(metadata).not.toContain('PRIVATE_IDENTITY_CANARY');
    const custody = JSON.parse(readFileSync(path.join(f.output, 'custody.json'), 'utf8'));
    expect(custody).toMatchObject({ captureNonce: nonce, proxyPids: [41001], coverage: 'observed-only', exhaustive: false, ...identity });
    expect(readFileSync(path.join(f.output, 'native-41001.jsonl'))).toEqual(readFileSync(path.join(f.trace, 'native-41001.jsonl')));
    expect(nonce).not.toBe(invocationNonce);
  });
  it('joins two distinct proxy/daemon pairs without using generation as process identity', () => {
    const f = fixture(); f.seed(); f.seed(41002, 51002, 'c'.repeat(64));
    expect(f.prepared!.archive([...f.rows(), ...f.rows(41002, 2)])).toBe(true);
    expect(JSON.parse(readFileSync(path.join(f.output, 'custody.json'), 'utf8')).proxyPids).toEqual([41001, 41002]);
  });
  it.each(['run', 'attempt', 'sourceCommit', 'sourceTree', 'nodeVersion'] as const)('refuses mismatched independent %s before preparing an overlay', field => {
    const f = fixture(false); writeFileSync(f.bindingFile, json({ ...f.binding, [field]: 'mismatch' })); expect(f.create()).toBeUndefined();
  });
  it('refuses hash drift or symlink executables without resolving a fallback', () => {
    const f = fixture(false); writeFileSync(f.native, 'different synthetic bytes'); expect(f.create()).toBeUndefined();
    const target = path.join(f.workspace, 'alternate'); writeFileSync(target, '# never execute', { mode: 0o700 }); rmSync(f.native); symlinkSync(target, f.native); expect(f.create()).toBeUndefined();
  });
  it('refuses unsafe invocation directory mode and a multiply-linked executable', () => {
    const f = fixture(false); chmodSync(f.invocations, 0o755); expect(f.create()).toBeUndefined(); chmodSync(f.invocations, 0o700);
    linkSync(f.native, path.join(f.workspace, 'native-alias')); expect(f.create()).toBeUndefined();
  });
  it('refuses a non-owned project naming shape and repeated trace-directory creation', () => {
    const f = fixture(false); expect(prepareEngineSecretsNativeCustody(nonce, identity, f.workspace)).toBeUndefined();
    expect(f.create()).toBeDefined(); expect(f.create()).toBeUndefined();
  });
  it.each(['sourceCommit', 'sourceTree', 'nonce', 'nativeSHA256', 'wrapperSHA256', 'traceDirectory', 'run', 'attempt'] as const)('refuses invocation %s mismatch without copying any trace', field => {
    const f = fixture(); const receipt = f.seed();
    const edited = json({ ...receipt.invocation, [field]: 'mismatch' }); writeFileSync(path.join(f.invocations, 'invocation-41001.json'), edited);
    writeFileSync(path.join(f.invocations, 'daemon-41001.json'), json({ ...receipt.mapping, invocationSHA256: sha(edited) }));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it.each(['proxyPID', 'daemonPID', 'nonce', 'invocationSHA256'] as const)('refuses daemon mapping %s mismatch', field => {
    const f = fixture(); const receipt = f.seed(); writeFileSync(path.join(f.invocations, 'daemon-41001.json'), json({ ...receipt.mapping, [field]: field.endsWith('PID') ? 99999 : 'd'.repeat(64) }));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects duplicated process/client bindings and reused invocation nonces', () => {
    const f = fixture(); f.seed(); expect(f.prepared!.archive([...f.rows(), ...f.rows()])).toBe(false);
    f.seed(41002, 51002); expect(f.prepared!.archive([...f.rows(), ...f.rows(41002, 2)])).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects missing daemon receipts, unknown PIDs, and extra trace files', () => {
    const f = fixture(); f.seed(); expect(f.prepared!.archive(f.rows(49999))).toBe(false);
    rmSync(path.join(f.invocations, 'daemon-41001.json')); expect(f.prepared!.archive(f.rows())).toBe(false);
    f.seed(); writeFileSync(path.join(f.trace, 'unknown.jsonl'), 'PRIVATE_TRACE_CANARY'); expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects symlinked trace or invocation files without reading their payload', () => {
    const f = fixture(); f.seed(); const target = path.join(f.workspace, 'private'); writeFileSync(target, 'PRIVATE_TRACE_CANARY');
    rmSync(path.join(f.trace, 'query-41001.jsonl')); symlinkSync(target, path.join(f.trace, 'query-41001.jsonl'));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
    rmSync(path.join(f.trace, 'query-41001.jsonl')); writeFileSync(path.join(f.trace, 'query-41001.jsonl'), json(f.row(51001)));
    rmSync(path.join(f.invocations, 'invocation-41001.json')); symlinkSync(target, path.join(f.invocations, 'invocation-41001.json'));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects unknown trace fields and a secret canary before copying even the valid earlier file', () => {
    const f = fixture(); f.seed(); const error = vi.spyOn(process.stderr, 'write');
    // Exact ordinary944 source emits Record schemaVersion2; v1 is not compatible.
    writeFileSync(path.join(f.trace, 'query-41001.jsonl'), json({ ...f.row(51001), schemaVersion: 1 }));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
    writeFileSync(path.join(f.trace, 'query-41001.jsonl'), json({ ...f.row(51001), header: 'PRIVATE_TRACE_CANARY' }));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]); expect(error).not.toHaveBeenCalled();
  });
  it('rejects unknown invocation fields before archiving a secret-bearing receipt', () => {
    const f = fixture(); const receipt = f.seed(); const bytes = json({ ...receipt.invocation, header: 'PRIVATE_RECEIPT_CANARY' });
    writeFileSync(path.join(f.invocations, 'invocation-41001.json'), bytes);
    writeFileSync(path.join(f.invocations, 'daemon-41001.json'), json({ ...receipt.mapping, invocationSHA256: sha(bytes) }));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it.each(['invocation', 'daemon'] as const)('rejects oversized or non-private %s receipt files', kind => {
    const f = fixture(); f.seed(); const file = path.join(f.invocations, `${kind}-41001.json`);
    chmodSync(file, 0o644); expect(f.prepared!.archive(f.rows())).toBe(false); chmodSync(file, 0o600);
    writeFileSync(file, Buffer.alloc((kind === 'invocation' ? 4096 : 1024) + 1, 32));
    expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects two proxies mapped to the same daemon even with distinct invocation nonces', () => {
    const f = fixture(); f.seed(); f.seed(41002, 51001, 'c'.repeat(64));
    expect(f.prepared!.archive([...f.rows(), ...f.rows(41002, 2)])).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it('rejects duplicate JSON fields and wrong daemon PID in otherwise valid native rows', () => {
    const f = fixture(); f.seed(); const line = json(f.row(51001));
    writeFileSync(path.join(f.trace, 'query-41001.jsonl'), line.replace('{', '{"pid":51001,')); expect(f.prepared!.archive(f.rows())).toBe(false);
    writeFileSync(path.join(f.trace, 'query-41001.jsonl'), json(f.row(51002))); expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
  it.each(['line', 'query-rows', 'native-bytes', 'query-bytes'] as const)('enforces the original %s bound', bound => {
    const f = fixture(); f.seed(); const target = path.join(f.trace, bound.startsWith('native') ? 'native-41001.jsonl' : 'query-41001.jsonl');
    const bytes = bound === 'line' ? json(f.row(51001)).trimEnd() + ' '.repeat(513) + '\n' : bound === 'query-rows' ? Array.from({ length: 129 }, (_, i) => json({ ...f.row(51001), record: i })).join('') : Buffer.alloc((bound === 'native-bytes' ? 256 : 64) * 1024 + 1, 32);
    writeFileSync(target, bytes); expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
  });
});

it.each(['uid', 'mode', 'nlink', 'ctimeMs', 'mtimeMs'] as const)('rejects a changed %s after the bounded descriptor read', field => {
  const f = fixture(); f.seed(); statControl.calls = 0; statControl.field = field;
  expect(f.prepared!.archive(f.rows())).toBe(false); expect(readdirSync(f.output)).toEqual([]);
});

describe('direct custody selector admission before path lookup', () => {
  it.each([["22", "v22.23.4", true], ["24", "v24.22.1", true], ["26", "v26.0.0", true], ["22.22.3", "v22.22.3", true], ["24.8.0", "v24.8.0", true], ["22.23.4", "v22.23.4", true], ["24.22.1", "v24.22.1", true], ["26.1.2", "v26.1.2", true], ["26", "v26.999.999", true], ["26.999.999", "v26.999.999", true], ["22", "v24.22.1", false], ["24", "v26.0.0", false], ["26", "v22.23.4", false], ["22.22.3", "v22.22.4", false], ["24.8.0", "v24.8.1", false], ["26.1.2", "v26.1.3", false], ["20", "v20.1.0", false], ["25.1.0", "v25.1.0", false], ["27", "v27.0.0", false], ["026", "v26.0.0", false], ["26.01.0", "v26.01.0", false], ["26.0.00", "v26.0.00", false], ["26.1000.0", "v26.1000.0", false], ["26", "v26.1000.0", false], ["v26.0.0", "v26.0.0", false], ["26", "26.0.0", false], ["26.0", "v26.0.0", false], ["26.0.0.0", "v26.0.0.0", false], ["26\n", "v26.0.0", false], ["26.0.0", "v26.0.0\n", false], [" 26", "v26.0.0", false], ["26 ", "v26.0.0", false], ["../26", "v26.0.0", false], ["/26", "v26.0.0", false], ["26.0.0-beta", "v26.0.0-beta", false], ["26.0.0+build", "v26.0.0+build", false]]) ('binds %s to %s with acceptance %s', (selector, nodeVersion, accepted) => {
    const selected = { ...identity, selector: selector as string, nodeVersion: nodeVersion as string };
    const f = fixture(false, selected); const prepared = prepareEngineSecretsNativeCustody(nonce, selected, f.project);
    if (accepted) { expect(prepared).toBeDefined(); f.seed(); expect(prepared!.archive(f.rows())).toBe(true); const meta = JSON.parse(readFileSync(path.join(f.output, 'custody.json'), 'utf8')); expect(meta.selector).toBe(selector); expect(meta.nodeVersion).toBe(nodeVersion); } else expect(prepared).toBeUndefined();
  });
});
