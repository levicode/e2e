/**
 * The two ways the loop opens Chromium, the one command-line argument that
 * chooses between them, and the one that hides the window.
 *
 * `engine` is the user's real launch: the target's `web()` starts Chromium, the
 * page is 1440×1000, and the private machine settings reach the browser as
 * `AGENT_BROWSER_*` environment variables, the way the user's project loads
 * `.env.local`.
 *
 * Both launches open a visible window by default, because that is how the user
 * runs the flow (`--headed`); `--headless` asks for the hidden window instead.
 *
 * `cdp` is the loop's external launch: `trusted-browser.ts` starts Chromium
 * with the private SPKI and proxy arguments and the target attaches over CDP.
 * It stays because the native isolated transport currently strips every
 * `AGENT_BROWSER_*` variable before the browser starts, so the engine-launch
 * path cannot be told about the internal CA on a machine that does not trust it
 * in the OS keychain.
 */
import type { ViewportSize } from 'e2e/engine';

/** Which browser launch one verification run uses. */
export type BrowserPath = 'cdp' | 'engine';

/** The user's own launch is the UAT loop's main path; CDP is the optional SPKI escape hatch. */
export const DEFAULT_BROWSER_PATH: BrowserPath = 'engine';

/** Which verification path one run executes. */
export type VerifyPath = 'scripted' | 'model';

export interface VerifyInvocation {
  readonly verifyPath: VerifyPath;
  /** The launch asked for on the command line; undefined means `DEFAULT_BROWSER_PATH`. */
  readonly browserPath: BrowserPath | undefined;
  /** True only when `--headless` asks for a hidden window; the default window is visible. */
  readonly headless: boolean;
}

export const VERIFY_USAGE =
  'Usage: node scripts/verify.ts [scripted|model] [--browser engine|cdp] [--headless]\n'
  + '  scripted  the fixed read-only baseline (default)\n'
  + '  model     the same read path plus the model-decided label loop\n'
  + '  --browser engine  the main launch, the user\'s own: 1440x1000, AGENT_BROWSER_* environment (default)\n'
  + '  --browser cdp     optional: external Chromium over CDP with the private SPKI/proxy launch args\n'
  + '  --headless        hide the window; the default is a visible window, as the user runs it\n'
  + '  UAT_HEADLESS=1    the same as --headless, for a caller that cannot pass arguments\n'
  + '  Without --browser, the engine launch runs.';

/** True when `UAT_HEADLESS=1` asks for a hidden window; the fixed runner passes the mode this way. */
export function headlessFromEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['UAT_HEADLESS'] === '1';
}

/** Parses one `verify.ts` invocation without touching settings, a browser, or a model. */
export function parseVerifyInvocation(argv: readonly string[]): VerifyInvocation {
  let verifyPath: VerifyPath | undefined;
  let browserPath: BrowserPath | undefined;
  let headless = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--browser') {
      if (browserPath !== undefined) throw new Error('UAT_VERIFY_USAGE: --browser was given twice');
      const value = argv[index + 1];
      index += 1;
      if (value !== 'engine' && value !== 'cdp') {
        throw new Error(`UAT_VERIFY_USAGE: --browser needs "engine" or "cdp", not "${value ?? ''}"`);
      }
      browserPath = value;
    } else if (argument === '--headless') {
      if (headless) throw new Error('UAT_VERIFY_USAGE: --headless was given twice');
      headless = true;
    } else if (argument === 'scripted' || argument === 'model') {
      if (verifyPath !== undefined) throw new Error(`UAT_VERIFY_USAGE: two verification paths ("${verifyPath}", "${argument}")`);
      verifyPath = argument;
    } else {
      throw new Error(`UAT_VERIFY_USAGE: unknown argument "${argument}"`);
    }
  }
  return { verifyPath: verifyPath ?? 'scripted', browserPath, headless };
}

/**
 * The launch a config file's `uatEngine()` should build. `UAT_BROWSER_PATH` is
 * set by the script that starts the run. Without it, attach when the script
 * exported `UAT_CDP_ENDPOINT`, launch otherwise.
 */
export function browserPathFromEnvironment(env: Readonly<Record<string, string | undefined>>): BrowserPath {
  const configured = env['UAT_BROWSER_PATH'];
  if (configured === 'engine' || configured === 'cdp') return configured;
  if (configured !== undefined && configured !== '') {
    throw new Error(`UAT_BROWSER_PATH_INVALID: "${configured}" is not "engine" or "cdp"`);
  }
  const endpoint = env['UAT_CDP_ENDPOINT'];
  return endpoint === undefined || endpoint === '' ? 'engine' : 'cdp';
}

/** The viewport each launch matches: the user's 1440×1000, or the loop's original 1440×900. */
export function browserViewport(path: BrowserPath): ViewportSize {
  return path === 'engine' ? { width: 1440, height: 1000 } : { width: 1440, height: 900 };
}
