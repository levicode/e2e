/**
 * The one command: reuse the saved session, run the fixed read-only scenario,
 * and write a redacted report.
 *
 * The raw `report.json`, trace pages, and any screenshots stay in the project's
 * gitignored `.e2e` directory; the rendered report goes under the user's state
 * directory with the UAT host, login host, and account ID redacted. Exit codes
 * separate the two things a rerun must not confuse: `2` means the saved login
 * state expired (scan again), anything else means the run itself did not pass.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot, runE2e } from '../src/e2e-cli.ts';
import { readNativeIdentity, readPackageIdentities } from '../src/identity.ts';
import { parseLedger, renderReport, writeReport } from '../src/report.ts';
import { readUatSession } from '../src/session.ts';
import { launchTrustedBrowser } from '../src/trusted-browser.ts';
import { loadUatSettings, uatConfigFile, uatReportsDirectory } from '../src/settings.ts';

const settings = loadUatSettings({ requireAccountId: true });
if (settings.accountId === undefined) {
  // loadUatSettings already fails without it; this narrows the type for the report.
  console.error(`UAT_CONFIG_MISSING: set UAT_ACCOUNT_ID or write accountId to ${uatConfigFile()}`);
  process.exit(2);
}

try {
  readUatSession(settings);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(2);
}

const output = path.join(appRoot, '.e2e');
mkdirSync(output, { recursive: true });
const ledgerFile = path.join(output, 'native-results.jsonl');
writeFileSync(ledgerFile, '');
const native = readNativeIdentity(appRoot, process.env);
const packages = readPackageIdentities(appRoot);

console.log('Running the fixed read-only UAT scenario (headless).');
const browser = await launchTrustedBrowser(settings);
let exitCode: number;
try {
  exitCode = await runE2e(['run', '--config', 'e2e.config.ts'], {
    ...process.env,
    ...settings.env,
    E2E_NATIVE_RESULT_LEDGER: ledgerFile,
    UAT_CDP_ENDPOINT: browser.endpoint,
  });
} finally {
  await browser.close();
}

const reportFile = path.join(output, 'report.json');
if (!existsSync(reportFile)) {
  console.error('UAT_VERIFY_NO_REPORT: the run produced no report.json; the run could not start (see the e2e output above).');
  process.exit(exitCode === 0 ? 1 : exitCode);
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
});
const directory = path.join(uatReportsDirectory(), new Date().toISOString().replace(/[:.]/g, '-'));
const written = writeReport(directory, rendered);

const status = typeof rendered.json['status'] === 'string' ? rendered.json['status'] : 'unknown';
const failures = Array.isArray(rendered.json['failures']) ? rendered.json['failures'] : [];
const codes = [...new Set(failures.map(failure => (failure !== null && typeof failure === 'object' && 'code' in failure ? String(failure.code) : 'unknown')))];
const nativeFailed = ledger.filter(entry => entry.ok === false).length;

console.log(`UAT verification: ${status}.`);
if (codes.length > 0) console.log(`Failure codes: ${codes.join(', ')}.`);
console.log(`Native operations: ${ledger.filter(entry => entry.kind === undefined).length} recorded, ${nativeFailed} failed.`);
console.log(`Report: ${written.markdown}`);
console.log(`Raw output (private, gitignored): ${output}`);
if (rendered.sessionExpired) {
  console.error('The saved UAT session expired. Run pnpm --filter @e2e-dev/uat-verification login and scan the QR once, then verify again.');
  process.exitCode = 2;
} else {
  process.exitCode = exitCode;
}
