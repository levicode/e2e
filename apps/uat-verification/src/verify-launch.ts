/**
 * What one verification invocation hands the e2e process, decided without
 * starting a browser.
 *
 * The two launches differ in more than a flag: the engine launch is headed,
 * uses the user's 1440×1000 page, and carries the private settings as
 * `AGENT_BROWSER_*` environment variables; the CDP launch may attach to a
 * Chromium an operator already started, otherwise the loop starts its own
 * headless 1440×900 browser and never exports the endpoint it must replace.
 */
import { browserViewport, type BrowserPath, type VerifyPath } from './browser-path.ts';

/** The choices one run makes, before the browser exists. */
export interface LaunchInput {
  readonly verifyPath: VerifyPath;
  readonly browserPath: BrowserPath;
  /** The environment the loop was started with. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** The private browser environment from `config.json`. */
  readonly privateEnv: Readonly<Record<string, string>>;
  /** True when the private settings name a Chromium, launch args, or env. */
  readonly trustedSettings: boolean;
  /** An endpoint an operator exported for the cdp launch, if any. */
  readonly exportedEndpoint: string | undefined;
  /** The run's private native-result ledger file. */
  readonly ledgerFile: string;
  /** A private CA file the engine launch should trust, when one is configured. */
  readonly caCert?: string;
}

export interface LaunchPlan {
  /** True when the loop starts its own Chromium (the endpoint is known only after it opens). */
  readonly launchesTrustedBrowser: boolean;
  readonly headed: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The e2e CLI arguments, with the config selected by the verification path. */
  readonly args: readonly string[];
  /** The child's environment; a launched trusted browser adds its endpoint afterwards. */
  readonly env: NodeJS.ProcessEnv;
  readonly privateSettings: 'engine-env' | 'external-launch-args' | 'none';
}

/** Decides the arguments, environment, and private-settings channel of one run. */
export function planVerificationLaunch(input: LaunchInput): LaunchPlan {
  const config = input.verifyPath === 'model' ? 'e2e.model.config.ts' : 'e2e.config.ts';
  // Verification is headless on both launches; only the one-time login step
  // asks for a window. The user confirmed headless is fine for verification.
  const headed = false;
  const viewport = browserViewport(input.browserPath);
  // The engine launch must launch its own Chromium even when the operator's
  // shell still exports an endpoint from an earlier cdp run.
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    UAT_BROWSER_PATH: input.browserPath,
    E2E_NATIVE_RESULT_LEDGER: input.ledgerFile,
  };
  delete env['UAT_CDP_ENDPOINT'];
  const args = ['run', '--config', config, ...(headed ? ['--headed'] : [])];

  if (input.browserPath === 'engine') {
    Object.assign(env, input.privateEnv);
    if (input.caCert !== undefined) env['AGENT_BROWSER_CA_CERT'] = input.caCert;
    // A private env entry that happens to carry the endpoint must not leak
    // either: this launch is the engine's own, whatever the variable says.
    delete env['UAT_CDP_ENDPOINT'];
    const privateSettings = Object.keys(input.privateEnv).length > 0 ? 'engine-env' as const : 'none' as const;
    return { launchesTrustedBrowser: false, headed, viewport, args, env, privateSettings };
  }

  // An operator-started Chromium is honored only when the private settings do
  // not name a browser of their own; otherwise its SPKI/proxy args must win.
  const useExportedEndpoint = input.exportedEndpoint !== undefined && !input.trustedSettings;
  if (useExportedEndpoint) env['UAT_CDP_ENDPOINT'] = input.exportedEndpoint;
  else if (input.trustedSettings) Object.assign(env, input.privateEnv);
  return {
    launchesTrustedBrowser: !useExportedEndpoint,
    headed,
    viewport,
    args,
    env,
    privateSettings: input.trustedSettings ? 'external-launch-args' : 'none',
  };
}
