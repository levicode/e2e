import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { beginCaseCleanupCapture, prepareWebCaseNativeCapture } from '../helpers/case-cleanup-capture.ts';
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'case-capture-unit-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
it('leaves default environment unchanged', () => {
  const env = { AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: 'inherited' }; const meta = {};
  beginCaseCleanupCapture('p01', meta, env).finish();
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBe('inherited');
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'disabled', restored: false } });
});
it('creates an exclusive private file before spawn and restores inherited setting only at finish', () => {
  const dir = directory(); const env = { E2E_CASE_CLEANUP_DIAGNOSTIC_DIR: dir, AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: 'inherited' }; const meta = {};
  const capture = beginCaseCleanupCapture('p01', meta, env);
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBe(join(dir, 'p01.cleanup.jsonl'));
  expect(statSync(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).mode & 0o777).toBe(0o600);
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'ready', restored: false } });
  capture.finish(); capture.finish();
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBe('inherited');
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'ready', restored: true } });
  expect(JSON.stringify(meta)).not.toContain(dir);
});
it('restores absence, and separates P01 and video files', () => {
  const dir = directory(); const env: NodeJS.ProcessEnv = { E2E_CASE_CLEANUP_DIAGNOSTIC_DIR: dir };
  beginCaseCleanupCapture('p01', {}, env).finish(); expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBeUndefined();
  beginCaseCleanupCapture('video-refusal', {}, env).finish();
  expect(statSync(join(dir, 'p01.cleanup.jsonl')).isFile()).toBe(true);
  expect(statSync(join(dir, 'video-refusal.cleanup.jsonl')).isFile()).toBe(true);
});
it('never overwrites an existing capture', () => {
  const dir = directory(); writeFileSync(join(dir, 'p01.cleanup.jsonl'), 'existing');
  const env = { E2E_CASE_CLEANUP_DIAGNOSTIC_DIR: dir, AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: 'inherited' }; const meta = {};
  beginCaseCleanupCapture('p01', meta, env).finish();
  expect(readFileSync(join(dir, 'p01.cleanup.jsonl'), 'utf8')).toBe('existing');
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBe('inherited');
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'unavailable', restored: false } });
});
it('rejects a symlink directory without writing to its target', () => {
  const root = directory(); const real = directory(); symlinkSync(real, join(root, 'alias'));
  const env: NodeJS.ProcessEnv = { E2E_CASE_CLEANUP_DIAGNOSTIC_DIR: join(root, 'alias') }; const meta = {};
  beginCaseCleanupCapture('p01', meta, env).finish();
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'unavailable' } });
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBeUndefined();
});
it('does not clobber an unexpected environment owner', () => {
  const env = { E2E_CASE_CLEANUP_DIAGNOSTIC_DIR: directory(), AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE: 'prior' }; const meta = {};
  const capture = beginCaseCleanupCapture('p01', meta, env); env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE = 'other-owner'; capture.finish();
  expect(env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE).toBe('other-owner');
  expect(meta).toMatchObject({ caseCleanupCapture: { state: 'environment-conflict', restored: false } });
});

function webCaseFixture() {
  const workspace = directory();
  const evidence = join(workspace, 'evidence'); const scripts = join(workspace, 'scripts', 'ci');
  const selector = process.versions.node.split('.')[0]!;
  for (const name of [join(evidence, 'tools'), join(evidence, 'fixtures', selector, 'web'), scripts, join(evidence, 'fixture-invocations'), join(evidence, 'web-case-native')]) mkdirSync(name, { recursive: true, mode: 0o700 });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const native = join(workspace, 'native'); const wrapper = join(evidence, 'tools', 'web-native-trace.sh');
  writeFileSync(native, 'NEVER_EXECUTE_NATIVE', { mode: 0o700 }); writeFileSync(wrapper, 'NEVER_EXECUTE_WRAPPER', { mode: 0o700 }); writeFileSync(join(scripts, 'native-trace-wrapper.sh'), 'NEVER_EXECUTE_WRAPPER');
  writeFileSync(join(evidence, 'source.commit'), 'a'.repeat(40)+'\n'); writeFileSync(join(evidence, 'source.tree'), 'b'.repeat(40)+'\n'); writeFileSync(join(evidence, 'node.version'), process.version+'\n');
  const bindingFile = join(evidence, 'fixtures', selector, 'web', 'binding.json');
  const binding = { selector, lane: 'web', run: '123', attempt: '1', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), nodeVersion: process.version, nativeSha256: { ordinary: hash('NEVER_EXECUTE_NATIVE') } };
  writeFileSync(bindingFile, JSON.stringify(binding));
  const env: NodeJS.ProcessEnv = { E2E_WEB_THREE_CASE_NATIVE_CAPTURE: '1', GITHUB_WORKSPACE: workspace, NODE_SELECTOR: selector, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), E2E_AGENT_BROWSER_EXECUTABLE: native };
  return { workspace, evidence, env, native, wrapper, binding, bindingFile };
}
it.each(['hung-recovery', 'lifecycle-open-cancel', 'popup-replacement'] as const)('binds only owned %s env without mutating the caller', caseId => {
  const f = webCaseFixture(); const before = { ...f.env }; const capture = prepareWebCaseNativeCapture(caseId, f.env);
  expect(capture).toBeDefined(); expect(f.env).toEqual(before); expect(Object.isFrozen(capture!.env)).toBe(true);
  expect(capture!.env['E2E_AGENT_BROWSER_EXECUTABLE']).toBe(f.wrapper); expect(capture!.env['E2E_DIAGNOSTIC_NATIVE_EXECUTABLE']).toBe(f.native);
  const root = join(f.evidence, 'web-case-native', caseId); const header = JSON.parse(readFileSync(join(root, 'case.json'), 'utf8'));
  expect(header).toMatchObject({ caseId, nativeExecutable: f.native, run: '123', sourceCommit: 'a'.repeat(40) }); expect(header.nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(readdirSync(join(root, 'trace'))).toEqual([]); capture!.finish(); capture!.finish();
  expect(JSON.parse(readFileSync(join(root, 'finished.json'), 'utf8'))).toEqual({ schemaVersion: 1, caseId, nonce: header.nonce, state: 'scope-finished' });
  expect(prepareWebCaseNativeCapture(caseId, f.env)).toBeUndefined();
});
it.each(['disabled', 'wrong-node', 'wrong-run', 'wrong-source', 'binary-drift', 'wrapper-drift', 'directory-mode', 'wrapper-symlink'] as const)('fails closed for %s without changing business env', edit => {
  const f = webCaseFixture();
  if (edit === 'disabled') delete f.env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'];
  if (edit === 'wrong-node') { f.binding.nodeVersion = 'v26.0.1'; writeFileSync(f.bindingFile, JSON.stringify(f.binding)); }
  if (edit === 'wrong-run') f.env['GITHUB_RUN_ID'] = '999';
  if (edit === 'wrong-source') f.env['GITHUB_SHA'] = 'c'.repeat(40);
  if (edit === 'binary-drift') writeFileSync(f.native, 'DIFFERENT');
  if (edit === 'wrapper-drift') writeFileSync(f.wrapper, 'DIFFERENT');
  if (edit === 'directory-mode') chmodSync(join(f.evidence, 'fixture-invocations'), 0o755);
  if (edit === 'wrapper-symlink') { rmSync(f.wrapper); symlinkSync(f.native, f.wrapper); }
  const before = { ...f.env }; expect(prepareWebCaseNativeCapture('hung-recovery', f.env)).toBeUndefined(); expect(f.env).toEqual(before);
});
it('keeps the old hung capture fallback and cannot overwrite a finished receipt', () => {
  const f = webCaseFixture(); const capture = beginCaseCleanupCapture('hung-recovery', Object.freeze({}), f.env);
  expect(capture.env).toBeDefined(); const finish = join(f.evidence, 'web-case-native', 'hung-recovery', 'finished.json'); writeFileSync(finish, 'PREEXISTING');
  expect(() => capture.finish()).not.toThrow(); expect(readFileSync(finish, 'utf8')).toBe('PREEXISTING');
});
