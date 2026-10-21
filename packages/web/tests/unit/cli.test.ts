import { describe, expect, it } from 'vitest';
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
