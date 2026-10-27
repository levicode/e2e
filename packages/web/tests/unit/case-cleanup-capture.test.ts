import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { beginCaseCleanupCapture } from '../helpers/case-cleanup-capture.ts';
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
