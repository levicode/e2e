/**
 * Self-check of the loop's mechanics against `test/fixture/server.mjs`.
 *
 * It never touches the real UAT environment: the fixture signs itself in,
 * serves the same menu/route/query shape, and the check runs the login step
 * (which saves the session), then `verify` (which restores it, walks the fixed
 * scenario, and writes the report). It then runs the failure shapes the report
 * exists to tell apart: a gateway page on the first setup open (retried, then
 * passing, with the retry in the report), a gateway that never recovers
 * (`UAT_APP_UNREACHABLE` with the status and the retry schedule, not exit 2), a
 * cross-origin login redirect (`UAT_SESSION_EXPIRED`, not retried, exit 2), and
 * an expired session file (also exit 2). It needs the built packages, a
 * Chromium, and a native agent-browser build, exactly like a real run.
 *
 * Usage: `E2E_AGENT_BROWSER_EXECUTABLE=/absolute/path/to/agent-browser pnpm --filter @e2e-dev/uat-verification test:loop`
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { appRoot, e2eCli } from '../src/e2e-cli.ts';

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const executable = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
if (executable === undefined || executable === '') {
  console.error('Set E2E_AGENT_BROWSER_EXECUTABLE to a trusted native agent-browser build before running the loop check.');
  process.exit(2);
}

const root = mkdtempSync(path.join(tmpdir(), 'uat-loop-check-'));
const sessionFile = path.join(root, 'session.json');
const reportsDirectory = path.join(root, 'reports');
const configFile = path.join(root, 'config.json');
const server = spawn(process.execPath, [path.join(appRoot, 'test', 'fixture', 'server.mjs'), '0'], { cwd: appRoot, stdio: ['ignore', 'pipe', 'inherit'] });
const port = await listeningPort(server);
const base = `http://127.0.0.1:${port}`;
writeConfig(`${base}/app/`);
const env: NodeJS.ProcessEnv = { ...process.env, UAT_CONFIG_FILE: configFile, UAT_SESSION_FILE: sessionFile, UAT_REPORTS_DIR: reportsDirectory };

try {
  const login = await run(process.execPath, [e2eCli(), 'run', '--config', 'e2e.login.config.ts'], env);
  assert(login.code === 0, `login run exited ${login.code}\n${login.stdout}\n${login.stderr}`);
  assert((statSync(sessionFile).mode & 0o777) === 0o600, 'the saved session is not 0600');

  const verified = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(verified.code === 0, `verify exited ${verified.code}\n${verified.stdout}\n${verified.stderr}`);
  const reportDirectory = latestReport(reportsDirectory);
  const report = readReport(reportDirectory);
  const markdown = readFileSync(path.join(reportDirectory, 'report.md'), 'utf8');
  assert(report.status === 'passed', `report status is ${String(report.status)}: ${markdown}`);
  assert(typeof report.native?.total === 'number' && report.native.total > 0, 'the report carries no native operations');
  assert(Array.isArray(report.failures) && report.failures.length === 0, 'a passing run reported failures');
  assert(markdown.includes('effects') && markdown.includes('scopeState'), 'the report does not show native settlement fields');
  assert(!markdown.includes('1234567890'), 'the report repeated the queried account ID');

  // A gateway page on the first setup open must be retried, not reported as an
  // expired session, and the retry schedule must be visible in the report.
  writeConfig(`${base}/flaky/`);
  const retried = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(retried.code === 0, `a gateway page the retry recovered still exited ${retried.code}\n${retried.stdout}\n${retried.stderr}`);
  const retriedReport = readReport(latestReport(reportsDirectory));
  const retriedMarkdown = readFileSync(path.join(latestReport(reportsDirectory), 'report.md'), 'utf8');
  assert(retriedReport.status === 'passed', `a retried gateway page did not pass:\n${retriedMarkdown}`);
  assert(retriedMarkdown.includes('## Setup 连接重试'), 'the report has no setup retry section');
  assert(retriedMarkdown.includes('| 1 |') && retriedMarkdown.includes('504') && retriedMarkdown.includes('unreachable'), 'the report does not name the retried 504 attempt');
  assert(retriedMarkdown.includes('1000 ms'), 'the report does not name the retry interval');
  assert(!retriedMarkdown.includes('UAT_SESSION_EXPIRED'), 'a retried gateway page was reported as an expired session');
  assert(!retriedMarkdown.includes('被测应用/网关不可达'), 'a run the retry recovered was still called unreachable');

  // A gateway that never comes back is unreachable, not an expired session: it
  // names the status and the bounded retry schedule, and exits as a run failure
  // (not the settings/session exit 2).
  writeConfig(`${base}/down/`);
  const unreachable = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(unreachable.code !== 0 && unreachable.code !== 2, `an unreachable app exited ${unreachable.code}, not a run failure\n${unreachable.stdout}\n${unreachable.stderr}`);
  const unreachableReport = readReport(latestReport(reportsDirectory));
  const unreachableMarkdown = readFileSync(path.join(latestReport(reportsDirectory), 'report.md'), 'utf8');
  const unreachableText = `${unreachableMarkdown}\n${unreachable.stdout}${unreachable.stderr}`;
  assert(unreachableMarkdown.includes('UAT_APP_UNREACHABLE'), 'an unreachable app did not name its code');
  assert(unreachableMarkdown.includes('HTTP 503'), 'the report does not name the gateway status');
  assert(unreachableMarkdown.includes('gave up after 3 setup attempts'), 'the report does not name the bounded retry count');
  assert(unreachableMarkdown.includes('1000 ms and 3000 ms'), 'the report does not name the retry intervals');
  assert(unreachableMarkdown.includes('被测应用/网关不可达'), 'the report does not call out the gateway failure');
  assert(!unreachableMarkdown.includes('UAT_SESSION_EXPIRED'), 'a gateway 503 was reported as an expired session');
  assert(!unreachableText.includes('The saved UAT session expired'), 'the console told the operator to sign in again for a gateway failure');
  assert(outcomeOf(unreachableReport) !== 'passed', 'an unreachable app reported a passing run');

  // A real login redirect (a cross-origin SSO page) is an expired session, never
  // a gateway failure, and is not retried.
  writeConfig(`${base}/signed-out/`);
  const redirected = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(redirected.code === 2, `a login redirect exited ${redirected.code}, not the session exit 2\n${redirected.stdout}\n${redirected.stderr}`);
  assert(`${redirected.stdout}${redirected.stderr}`.includes('The saved UAT session expired'), 'a login redirect did not name the expired session on the console');
  const redirectedReport = readReport(latestReport(reportsDirectory));
  const redirectedMarkdown = readFileSync(path.join(latestReport(reportsDirectory), 'report.md'), 'utf8');
  assert(redirectedReport.sessionExpired === true, 'a login redirect was not reported as an expired session');
  assert(redirectedReport.appUnreachable === false, 'a login redirect was reported as an unreachable app');
  assert(redirectedMarkdown.includes('UAT_SESSION_EXPIRED') && redirectedMarkdown.includes('the app redirected to the login page'), 'the report does not name the login redirect');
  assert(!redirectedMarkdown.includes('UAT_APP_UNREACHABLE'), 'a login redirect was called a gateway failure');
  assert(redirectedReport.setup?.attempts?.length === 1 && redirectedReport.setup.outcome === 'session-expired', 'a login redirect was retried');

  writeConfig(`${base}/app/`);
  writeFileSync(sessionFile, `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entryOrigin: base, cookies: [{ name: 'uat_session', value: 'ok', domain: '127.0.0.1', path: '/', expires: 1 }], localStorage: {} })}\n`);
  const expired = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(expired.code === 2, `an expired session exited ${expired.code}`);
  assert(`${expired.stdout}${expired.stderr}`.includes('UAT_SESSION_EXPIRED'), 'an expired session did not name its reason');

  console.log('UAT loop check passed: login saved the session; verify produced a passing redacted report; a 504 setup open was retried and recorded; a gateway that stayed down was reported as UAT_APP_UNREACHABLE with status and retry schedule; a cross-origin login redirect stayed UAT_SESSION_EXPIRED and was not retried; an expired session file exits 2.');
} finally {
  server.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function listeningPort(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`fixture exited before listening (code ${String(code)})`)));
    lines.once('line', line => {
      const match = /^LISTEN (\d+)$/.exec(line);
      if (match === null) reject(new Error(`fixture said ${line}`));
      else resolve(Number(match[1]));
    });
  });
}

function writeConfig(entryUrl: string): void {
  writeFileSync(configFile, `${JSON.stringify({ entryUrl, loginUrl: `${base}/login.html`, accountId: '1234567890' }, null, 2)}\n`);
}

/** The newest report directory; report names are ISO timestamps, so sorting is chronological. */
function latestReport(directory: string): string {
  const entries = readdirSync(directory).toSorted();
  assert(entries.length > 0, 'the run wrote no report directory');
  return path.join(directory, entries[entries.length - 1]!);
}

interface LoopReport {
  readonly status?: unknown;
  readonly sessionExpired?: unknown;
  readonly appUnreachable?: unknown;
  readonly native?: { readonly total?: unknown };
  readonly failures?: unknown;
  readonly setup?: { readonly attempts?: readonly unknown[]; readonly outcome?: unknown };
}

function readReport(directory: string): LoopReport {
  return JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8')) as LoopReport;
}

function outcomeOf(report: LoopReport): string {
  return typeof report.status === 'string' ? report.status : 'unknown';
}

function run(command: string, args: readonly string[], childEnv: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
