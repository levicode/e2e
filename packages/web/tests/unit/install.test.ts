/**
 * Built public CLI boundary, not Chromium acquisition proof. The removed private
 * Playwright downloader/cache layout is no longer the production owner. Native
 * install.rs owns vendor downloads and cache/version behavior; the acceptance
 * gate separately requires acquiring and running Chromium. Native cache/version
 * selection and no unrelated cache deletion remain explicit evidence gaps.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const built = createRequire(import.meta.url).resolve('../../dist/bin.js');
let directory: string;
let receipt: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'e2e-native-install-'));
  receipt = path.join(directory, 'receipt.json');
  // Use the existing trusted Node executable as a platform-neutral command peer.
  // Its `install` argv resolves this synthetic script in the explicitly passed cwd.
  writeFileSync(path.join(directory, 'install'), `const fs = require('node:fs');
fs.writeFileSync(process.env.SYNTHETIC_RECEIPT, JSON.stringify({
  args: ['install', ...process.argv.slice(2)], cwd: process.cwd(),
  marker: process.env.SYNTHETIC_RUN_MARKER, path: process.env.PATH
}));
process.stdout.write('synthetic native installer progress\\n');
process.exitCode = Number(process.env.SYNTHETIC_INSTALL_EXIT || 0);
`);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [built, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: '', E2E_AGENT_BROWSER_EXECUTABLE: process.execPath,
      SYNTHETIC_RECEIPT: receipt, SYNTHETIC_RUN_MARKER: 'synthetic-run', ...extra },
  });
}

describe('built e2e-web native installer contract', () => {
  it.each([
    { cli: ['install'], native: ['install'] },
    { cli: ['install', 'chromium'], native: ['install'] },
    { cli: ['install', 'chromium', 'chromium'], native: ['install'] },
    { cli: ['install', 'chromium', '--with-deps'], native: ['install', '--with-deps'] },
  ])('forwards $cli to the exact explicit executable without PATH lookup', ({ cli, native }) => {
    const result = run(cli);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ args: native, cwd: directory, marker: 'synthetic-run', path: '' });
    expect(result.stdout).toContain('synthetic native installer progress');
  });
  it('preserves the native installer exit status', () => {
    expect(run(['install'], { SYNTHETIC_INSTALL_EXIT: '23' }).status).toBe(23);
  });
  it.each([['install', 'firefox'], ['install', 'webkit'], ['install', '--arbitrary-option']])('rejects unsupported public arguments %j before spawning', (...args) => {
    expect(run(args).status).toBe(2); expect(existsSync(receipt)).toBe(false);
  });
  it('fails closed without a matching runtime rather than installing implicitly or using PATH', () => {
    const result = run(['install'], { E2E_AGENT_BROWSER_EXECUTABLE: '' });
    expect(result.status).not.toBe(0); expect(existsSync(receipt)).toBe(false);
    expect(result.stderr).toContain('Install a verified matching Web runtime bundle');
  });
  it('does not echo an invalid private executable path', () => {
    const result = run(['install'], { E2E_AGENT_BROWSER_EXECUTABLE: '/synthetic-private-project/missing-binary' });
    expect(result.status).not.toBe(0); expect(existsSync(receipt)).toBe(false);
    expect(result.stderr).not.toContain('/synthetic-private-project/missing-binary');
  });
});
