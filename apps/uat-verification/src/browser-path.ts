/**
 * The two ways the loop opens Chromium, and the one command-line argument that
 * chooses between them.
 *
 * `engine` is the user's real launch: the target's `web()` starts Chromium, the
 * run is headed, the page is 1440×1000, and the private machine settings reach
 * the browser as `AGENT_BROWSER_*` environment variables, the way the user's
 * project loads `.env.local`.
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
}

export const VERIFY_USAGE =
  'Usage: node scripts/verify.ts [scripted|model] [--browser engine|cdp]\n'
  + '  scripted  the fixed read-only baseline (default)\n'
  + '  model     the same read path plus the model-decided label loop\n'
  + '  --browser engine  the main launch, the user\'s own: 1440x1000, AGENT_BROWSER_* environment (default)\n'
  + '  --browser cdp     optional: external Chromium over CDP with the private SPKI/proxy launch args\n'
  + '  Without --browser, the engine launch runs.';

/** Parses one `verify.ts` invocation without touching settings, a browser, or a model. */
export function parseVerifyInvocation(argv: readonly string[]): VerifyInvocation {
  let verifyPath: VerifyPath | undefined;
  let browserPath: BrowserPath | undefined;
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
    } else if (argument === 'scripted' || argument === 'model') {
      if (verifyPath !== undefined) throw new Error(`UAT_VERIFY_USAGE: two verification paths ("${verifyPath}", "${argument}")`);
      verifyPath = argument;
    } else {
      throw new Error(`UAT_VERIFY_USAGE: unknown argument "${argument}"`);
    }
  }
  return { verifyPath: verifyPath ?? 'scripted', browserPath };
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
