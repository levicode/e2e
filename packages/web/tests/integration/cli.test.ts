import { beginSyntheticCase } from '../helpers/synthetic-evidence.ts';
import { SyntheticRecoveryEvidence } from '../helpers/synthetic-native-outcomes.ts';
/**
 * The built `e2e-web` command as a user runs it: a real process spawning the
 * real native installer. P14 alone uses the verified acceptance-faults runtime
 * and loopback archive source; it does not establish public-source cold installation.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInstallerFixture } from '../helpers/installer-fixture.ts';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '../../dist/bin.js');

/** Spawns the command with `args` and the given extra environment. */
function runBin(args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [BIN, ...args], { stdio: 'ignore', env: { ...process.env, ...env } });
}

/** Resolves with the exit code and signal once `child` exits. */
function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

const cleanups: (() => Promise<void>)[] = [];
let bodyFailed = false;
let installEvidence: SyntheticRecoveryEvidence | undefined;

afterEach(async () => {
  const evidence = installEvidence;
  let cleanupFailed = false;
  evidence?.enter('backstop', 'cleanup');
  try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
  catch (cause) { cleanupFailed = true; if (!bodyFailed) throw cause; console.error(cause); }
  finally { evidence?.finishBackstop(cleanupFailed); installEvidence = undefined; bodyFailed = false; }
});

describe('e2e-web', () => {
  it('exits 0 when the browser is already installed', async () => {
    expect(await exited(runBin(['install', 'chromium']))).toEqual({ code: 0, signal: null });
  });

  it('ends the download when the command gets SIGTERM, and exits 143', async () => {
    const evidence = new SyntheticRecoveryEvidence(beginSyntheticCase('P14'));
    installEvidence = evidence;
    evidence.enter('host');
    try {
    const fixture = createInstallerFixture(BIN);
    cleanups.push(() => fixture.close());
    evidence.evidence.record({ kind: 'installer-runtime', ...fixture.binding });
    evidence.enter('download-trigger', 'setup');
    const { cancel, exited: installerExited, downloadClosed } = await fixture.start();
    evidence.enter('download-event');
    evidence.passed('setup');
    evidence.enter('cancel', 'body');
    expect(cancel()).toBe(true);

    evidence.enter('assertion');
    expect(await installerExited()).toEqual({ code: 143, signal: null });
    await downloadClosed();
    evidence.passed('body');
    } catch (cause) { bodyFailed = true; evidence.failed(); throw cause; }
  });
});
