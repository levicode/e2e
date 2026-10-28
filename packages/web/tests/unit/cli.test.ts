import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';

/** Runs `e2e-web` with recorded output and a fake native CLI that exits with `exitCode`. */
async function run(args: readonly string[], exitCode = 0) {
  const calls: (readonly string[])[] = [];
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    run: async (forwarded) => {
      calls.push(forwarded);
      return exitCode;
    },
  });
  return { code, calls, stdout, stderr };
}

describe('e2e-web', () => {
  it('installs chromium when no browser is named', async () => {
    expect(await run(['install'])).toMatchObject({ code: 0, calls: [['install']] });
  });

  it('forwards Chromium installation and --with-deps without a redundant browser argument', async () => {
    expect((await run(['install', 'chromium', '--with-deps'])).calls).toEqual([['install', '--with-deps']]);
  });

  it("exits with the native CLI's code", async () => {
    expect((await run(['install'], 1)).code).toBe(1);
  });

  it.each([[['--help']], [['help']], [['install', 'webkit', '-h']]])(
    'prints usage for %j without running anything',
    async (args) => {
      const result = await run(args);
      expect(result).toMatchObject({ code: 0, calls: [] });
      expect(result.stdout).toContain('Usage: npx @e2e-dev/web install [chromium] [--with-deps]');
      expect(result.stdout).toContain('pnpm exec e2e-web install');
    },
  );

  it.each([
    [[], 'missing command'],
    [['show-report'], 'unknown command "show-report"'],
    [['install', '--force'], 'unknown option "--force"'],
    [['install', 'firefox'], 'unknown browser "firefox"; expected one of chromium'],
    [['install', 'webkit'], 'unknown browser "webkit"; expected one of chromium'],
    [['install', 'chrome'], 'unknown browser "chrome"; expected one of chromium'],
  ])('rejects %j with exit code 2', async (args, message) => {
    const result = await run(args);
    expect(result).toMatchObject({ code: 2, calls: [] });
    expect(result.stderr).toContain(message);
  });
});


describe('explicit local runtime installation', () => {
  const project = mkdtempSync(join(tmpdir(), 'cli-project with spaces-'));
  writeFileSync(join(project, 'package.json'), '{}');
  afterAll(() => rmSync(project, { recursive: true, force: true }));
  const digest = 'a'.repeat(64);
  const valid = ['runtime', 'install', '--bundle', '/bundle path', '--manifest-sha256', digest, '--package-manager', 'npm'];
  async function runtime(args: readonly string[], failure?: Error) {
    const calls: unknown[][] = []; let stdout = ''; let stderr = ''; let browserCalls = 0;
    const code = await main(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      run: async () => { browserCalls++; return 0; },
      installRuntime: async (...values) => { calls.push(values); if (failure) throw failure; },
    });
    return { code, calls, stdout, stderr, browserCalls };
  }
  it.each(['npm', 'pnpm'])('routes %s with explicit project, without browser installation', async manager => {
    const args = [...valid.slice(0, -1), manager, '--project', project];
    expect(await runtime(args)).toMatchObject({ code: 0, calls: [['/bundle path', digest, project, manager]], browserCalls: 0 });
  });
  it('defaults the project to cwd only', async () => {
    expect((await runtime(valid)).calls).toEqual([['/bundle path', digest, process.cwd(), 'npm']]);
  });
  it.each([
    ['runtime'], ['runtime', 'upgrade'], ['runtime', 'install'],
    [...valid, '--project'], [...valid, '--bundle', '/other'], [...valid, '--unknown', 'x'],
    [...valid.slice(0, -1), 'yarn'], [...valid, '--project', '--bundle'],
    valid.map(value => value === digest ? 'manifest.sha256' : value),
  ].map(args => [args]))('rejects invalid argv before any installer call: %j', async args => {
    expect(await runtime(args)).toMatchObject({ code: 2, calls: [], browserCalls: 0, stdout: '' });
  });
  it('rejects an empty target before calling the installer', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cli-empty-'));
    try {
      const result = await runtime([...valid, '--project', empty]);
      expect(result).toMatchObject({ code: 2, calls: [], browserCalls: 0 });
      expect(result.stderr).toContain('run e2e init first');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
  it('prints help without installing', async () => {
    expect(await runtime([...valid, '--help'])).toMatchObject({ code: 0, calls: [], browserCalls: 0 });
  });
  it('reports installer failure without a success message or browser fallback', async () => {
    const result = await runtime(valid, new Error('inventory mismatch'));
    expect(result).toMatchObject({ code: 1, stdout: '', browserCalls: 0 });
    expect(result.stderr).toContain('inventory mismatch');
  });
});
