/**
 * A Chromium this loop launches and the e2e engine attaches to over CDP.
 *
 * The engine's own launch path isolates the browser transport and strips every
 * `AGENT_BROWSER_*` variable, so it cannot be told to trust the internal CA or
 * to use the local proxy. Launching the browser here, with the private
 * machine-local args, keeps TLS trust limited to the exact SPKI hashes named by
 * `chromiumArgs` and lets the engine drive the same browser through its public
 * `connect` option.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { UatSettings } from './settings.ts';

export interface TrustedBrowser {
  /** The DevTools endpoint the target's `connect.cdpEndpoint` returns. */
  readonly endpoint: string;
  close(): Promise<void>;
}

/** How the loop's own Chromium should open. */
export interface TrustedBrowserOptions {
  /** Show the window, for the one-time QR scan; off for a normal verification run. */
  readonly headed?: boolean;
}

/** Launches the bundled Chromium with the private TLS and proxy args and waits for CDP. */
export async function launchTrustedBrowser(settings: UatSettings, options: TrustedBrowserOptions = {}): Promise<TrustedBrowser> {
  const executable = chromeExecutable(settings);
  const profile = mkdtempSync(path.join(tmpdir(), 'uat-chrome-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headed === true ? [] : ['--headless=new']),
    ...(settings.chromiumArgs ?? []),
  ];
  const proxy = settings.env['AGENT_BROWSER_PROXY'];
  if (proxy !== undefined && proxy !== '') args.push(`--proxy-server=${proxy}`);
  const bypass = settings.env['AGENT_BROWSER_PROXY_BYPASS'];
  if (bypass !== undefined && bypass !== '') args.push(`--proxy-bypass-list=${bypass.split(',').join(';')}`);
  const child = spawn(executable, args, { stdio: 'ignore' });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 3_000).unref();
    });
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A profile the browser is still releasing is left for the OS to clean.
    }
  };
  try {
    const port = await waitForDevToolsPort(profile, child);
    return { endpoint: `http://127.0.0.1:${port}`, close };
  } catch (cause) {
    close();
    throw cause;
  }
}

/**
 * The Chromium the private settings name, else the browser the native runtime
 * installs under `~/.agent-browser/browsers/`.
 */
function chromeExecutable(settings: UatSettings): string {
  const explicit = settings.chromeExecutable ?? process.env['UAT_CHROME_EXECUTABLE'];
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`UAT_CHROME_MISSING: ${explicit} does not exist`);
    return explicit;
  }
  const root = path.join(homedir(), '.agent-browser', 'browsers');
  if (existsSync(root)) {
    for (const name of readdirSync(root).filter(entry => entry.startsWith('chrome-')).toSorted().toReversed()) {
      const candidate = path.join(root, name, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('UAT_CHROME_MISSING: set chromeExecutable in the private settings or install the engine\'s Chromium');
}

async function waitForDevToolsPort(profile: string, child: ReturnType<typeof spawn>): Promise<number> {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]?.trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (child.exitCode !== null) throw new Error(`UAT_CHROME_EXITED: Chromium exited with code ${String(child.exitCode)} before opening DevTools`);
    if (Date.now() >= deadline) throw new Error('UAT_CHROME_TIMEOUT: Chromium did not open its DevTools port');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** True when the private environment names browser settings only its own launch can apply. */
export function needsTrustedBrowser(settings: UatSettings): boolean {
  return settings.chromiumArgs !== undefined || settings.chromeExecutable !== undefined || Object.keys(settings.env).length > 0;
}
