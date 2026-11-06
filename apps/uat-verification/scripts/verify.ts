/**
 * One command for one verification path: `scripted` (the deterministic
 * read-only baseline) or `model` (the same read path plus the writable label
 * loop, decided by a real model).
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
import { appRoot, runE2e } from '../src/e2e-cli.ts';
import { readNativeIdentity, readPackageIdentities } from '../src/identity.ts';
import { loadUatModelSettings, uatModelLabel, type UatModelSettings } from '../src/model.ts';
import { parseLedger, renderReport, writeReport } from '../src/report.ts';
import { readUatSession } from '../src/session.ts';
import { loadUatSettings, uatConfigFile, uatReportsDirectory, type UatSettings } from '../src/settings.ts';
import { launchTrustedBrowser, needsTrustedBrowser } from '../src/trusted-browser.ts';
import { UAT_UNUSABLE_EXIT, verifyExitCode } from '../src/verify-exit.ts';

/** The two paths: the fixed scripted baseline, and the real-model decision path. */
export type VerifyPath = 'scripted' | 'model';

const requested = process.argv[2] ?? 'scripted';
if (requested !== 'scripted' && requested !== 'model') {
  console.error(`UAT_VERIFY_USAGE: unknown path "${requested}"; use "scripted" or "model"`);
  process.exit(UAT_UNUSABLE_EXIT);
}
const verifyPath: VerifyPath = requested;

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

const output = path.join(appRoot, verifyPath === 'model' ? '.e2e-model' : '.e2e');
mkdirSync(output, { recursive: true });
const ledgerFile = path.join(output, 'native-results.jsonl');
writeFileSync(ledgerFile, '');
const native = readNativeIdentity(appRoot, process.env);
const packages = readPackageIdentities(appRoot);

console.log(
  verifyPath === 'model'
    ? `Running the model-driven UAT path (${uatModelLabel(modelSettings!)}; headless). Model decisions are recorded as made, never retried.`
    : 'Running the fixed scripted read-only UAT scenario (headless).',
);
// The private environment needs its own Chromium: an internal CA and a proxy
// the engine's isolated launch cannot be told about. Everywhere else the engine
// launches its own browser as usual.
const trustedBrowser = needsTrustedBrowser(settings) ? await launchTrustedBrowser(settings) : undefined;
let exitCode: number;
try {
  exitCode = await runE2e(['run', '--config', verifyPath === 'model' ? 'e2e.model.config.ts' : 'e2e.config.ts', ], {
    ...process.env,
    ...(trustedBrowser === undefined ? {} : { ...settings.env, UAT_CDP_ENDPOINT: trustedBrowser.endpoint }),
    E2E_NATIVE_RESULT_LEDGER: ledgerFile,
  });
} finally {
  await trustedBrowser?.close();
}

const reportFile = path.join(output, 'report.json');
if (!existsSync(reportFile)) {
  console.error('UAT_VERIFY_NO_REPORT: the run produced no report.json; the run could not start (see the e2e output above).');
  process.exit(exitCode === 0 ? 1 : verifyExitCode(exitCode, false));
}

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

console.log(`UAT verification (${verifyPath}): ${status}.`);
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
