/**
 * One command for one verification path: `scripted` (the deterministic
 * read-only baseline) or `model` (the same read path plus the writable label
 * loop, decided by a real model), on one of the two browser launches: `engine`
 * (the user's own `web()` launch) or `cdp` (the loop's external Chromium).
 *
 * The raw `report.json`, trace pages, and any screenshots stay in the project's
 * gitignored output directory (`.e2e` or `.e2e-model`); the rendered report goes
 * under the user's state directory with the UAT host, login host, account ID,
 * and label redacted. Exit codes separate the two things a rerun must not
 * confuse: `2` means the saved login state (or the private model settings) is
 * unusable, anything else means the run itself did not pass.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BROWSER_PATH,
  parseVerifyInvocation,
  VERIFY_USAGE,
  type BrowserPath,
  type VerifyPath,
} from '../src/browser-path.ts';
import { appRoot, runE2e } from '../src/e2e-cli.ts';
import { readPackageIdentities, resolveNativeIdentity } from '../src/identity.ts';
import { loadUatModelSettings, uatModelLabel, type UatModelSettings } from '../src/model.ts';
import { parseLedger, renderReport, writeReport, type BrowserRun } from '../src/report.ts';
import { readUatSession } from '../src/session.ts';
import { loadUatSettings, uatCaCertFile, uatConfigFile, uatReportsDirectory, type UatSettings } from '../src/settings.ts';
import { launchTrustedBrowser, needsTrustedBrowser, type TrustedBrowser } from '../src/trusted-browser.ts';
import { planVerificationLaunch } from '../src/verify-launch.ts';
import { UAT_UNUSABLE_EXIT, verifyExitCode } from '../src/verify-exit.ts';

let verifyPath: VerifyPath;
let requestedBrowser: BrowserPath | undefined;
let headless = false;
try {
  const invocation = parseVerifyInvocation(process.argv.slice(2));
  verifyPath = invocation.verifyPath;
  requestedBrowser = invocation.browserPath;
  headless = invocation.headless;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  console.error('');
  console.error(VERIFY_USAGE);
  process.exit(UAT_UNUSABLE_EXIT);
}

let settings: UatSettings;
let modelSettings: UatModelSettings | undefined;
try {
  settings = loadUatSettings({ requireAccountId: true, requireLabel: verifyPath === 'model' });
  if (settings.accountId === undefined) {
    // loadUatSettings already fails without it; this narrows the type for the report.
    throw new Error(`UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID or write accountId to ${uatConfigFile()}`);
  }
  // Fail before opening a browser when the private model settings are unusable.
  modelSettings = verifyPath === 'model' ? loadUatModelSettings() : undefined;
  readUatSession(settings);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(UAT_UNUSABLE_EXIT);
}

const browserPath: BrowserPath = requestedBrowser ?? DEFAULT_BROWSER_PATH;
const exportedEndpoint = process.env['UAT_CDP_ENDPOINT'] === undefined || process.env['UAT_CDP_ENDPOINT'] === ''
  ? undefined
  : process.env['UAT_CDP_ENDPOINT'];

let caCert: string | undefined;
try {
  caCert = uatCaCertFile();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(UAT_UNUSABLE_EXIT);
}

const output = path.join(appRoot, verifyPath === 'model' ? '.e2e-model' : '.e2e');
mkdirSync(output, { recursive: true });
const ledgerFile = path.join(output, 'native-results.jsonl');
writeFileSync(ledgerFile, '');
const plan = planVerificationLaunch({
  verifyPath,
  browserPath,
  baseEnv: process.env,
  privateEnv: settings.env,
  trustedSettings: needsTrustedBrowser(settings),
  exportedEndpoint,
  ledgerFile,
  headless,
  ...(caCert === undefined ? {} : { caCert }),
});
const { headed, viewport } = plan;
let resolved: ReturnType<typeof resolveNativeIdentity>;
try {
  resolved = resolveNativeIdentity(appRoot, process.env);
} catch (cause) {
  // An unprovable native build is a setup failure, not a product verdict: stop
  // before opening a browser instead of printing a commit the binary did not build.
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(UAT_UNUSABLE_EXIT);
}
const native = resolved.identity;
if (resolved.recordError !== undefined) {
  // A refused record still leaves an honest report; say why the commit is
  // unverified instead of swallowing the reason.
  console.error(`Native build record not written: ${resolved.recordError} The report marks the commit unverified.`);
}
const packages = readPackageIdentities(appRoot);

const windowMode = headed ? 'headed' : 'headless';
const launchText = `${windowMode} ${viewport.width}×${viewport.height}; ${browserPath === 'engine' ? 'engine launches Chromium' : 'external Chromium over CDP'}`;
if (!headed) {
  // The user's real run is headed; a hidden-window pass is not the configuration the user sees.
  console.log('Running headless (--headless): the user runs this flow with a visible window, so a headless pass is not the run the user sees.');
}
console.log(
  verifyPath === 'model'
    ? `Running the model-driven UAT path via ${browserPath} (${launchText}) (${uatModelLabel(modelSettings!)}). Model decisions are recorded as made, never retried.`
    : `Running the fixed scripted read-only UAT scenario via ${browserPath} (${launchText}).`,
);
if (browserPath === 'engine' && (settings.chromiumArgs !== undefined || settings.chromeExecutable !== undefined)) {
  console.error('UAT_ENGINE_LAUNCH_LIMITS: the engine-launch path has no channel for chromiumArgs or chromeExecutable; only the cdp path applies them. Use --browser cdp when the private Chromium settings are required.');
}
if (browserPath === 'engine' && Object.keys(settings.env).length > 0) {
  // The user's project loads these like `.env.local`; the native isolated
  // transport strips them, so the report must not claim they took effect.
  console.error('UAT_ENGINE_LAUNCH_ENV: passing the private AGENT_BROWSER_* variables to the engine as the user\'s project does. The native isolated transport removes them before Chromium starts; see the "Browser launch paths" section in README.md.');
}

// The cdp path needs its own Chromium unless an operator already started one
// whose endpoint they exported. The engine path always lets the target launch.
let trustedBrowser: TrustedBrowser | undefined;
try {
  trustedBrowser = plan.launchesTrustedBrowser ? await launchTrustedBrowser(settings, { headed }) : undefined;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(UAT_UNUSABLE_EXIT);
}
const childEnv: NodeJS.ProcessEnv = { ...plan.env };
if (trustedBrowser !== undefined) childEnv['UAT_CDP_ENDPOINT'] = trustedBrowser.endpoint;

let exitCode: number;
try {
  exitCode = await runE2e(plan.args, childEnv);
} finally {
  await trustedBrowser?.close();
}

const reportFile = path.join(output, 'report.json');
if (!existsSync(reportFile)) {
  console.error('UAT_VERIFY_NO_REPORT: the run produced no report.json; the run could not start (see the e2e output above).');
  process.exit(exitCode === 0 ? 1 : verifyExitCode(exitCode, false));
}

const browser: BrowserRun = {
  path: browserPath,
  headed,
  viewport: `${viewport.width}x${viewport.height}`,
  privateSettings: plan.privateSettings,
  caTrust: browserPath === 'engine'
    ? (caCert === undefined ? 'none' : 'agent-browser-ca-cert')
    : (trustedBrowser === undefined ? 'none' : 'external-launch-args'),
};
const report: unknown = JSON.parse(readFileSync(reportFile, 'utf8'));
const ledger = parseLedger(existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '');
const rendered = renderReport({
  report,
  ledger,
  native,
  packages,
  settings,
  accountId: settings.accountId,
  rawOutput: output,
  verifyPath,
  browser,
  ...(modelSettings === undefined
    ? {}
    : { model: { label: uatModelLabel(modelSettings), provider: `openai.${modelSettings.api}`, model: modelSettings.model } }),
});
const directory = path.join(uatReportsDirectory(), new Date().toISOString().replace(/[:.]/g, '-'));
const written = writeReport(directory, rendered);

const status = typeof rendered.json['status'] === 'string' ? rendered.json['status'] : 'unknown';
const failures = Array.isArray(rendered.json['failures']) ? rendered.json['failures'] : [];
const codes = [...new Set(failures.map(failure => (failure !== null && typeof failure === 'object' && 'code' in failure ? String(failure.code) : 'unknown')))];
const nativeFailed = ledger.filter(entry => entry.ok === false).length;
const model = rendered.json['model'];

console.log(`UAT verification (${verifyPath}, ${browserPath} browser, ${windowMode}): ${status}.`);
if (codes.length > 0) console.log(`Failure codes: ${codes.join(', ')}.`);
if (model !== null && typeof model === 'object' && 'calls' in model) {
  const total = model as { calls?: number; inputTokens?: number; outputTokens?: number; durationMs?: number };
  console.log(`Model: ${String(total.calls ?? 0)} calls, ${String(total.durationMs ?? 0)} ms, ${String(total.inputTokens ?? 0)} in + ${String(total.outputTokens ?? 0)} out tokens.`);
}
console.log(`Native operations: ${ledger.filter(entry => entry.kind === undefined).length} recorded, ${nativeFailed} failed.`);
console.log(`Report: ${written.markdown}`);
console.log(`Raw output (private, gitignored): ${output}`);
if (rendered.sessionExpired) {
  console.error('The saved UAT session expired. Run pnpm --filter @e2e-dev/uat-verification login and scan the QR once, then verify again.');
}
process.exitCode = verifyExitCode(exitCode, rendered.sessionExpired);
