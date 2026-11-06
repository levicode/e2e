/**
 * Self-check of the loop's mechanics against `test/fixture/server.mjs`.
 *
 * It never touches the real UAT environment: the fixture signs itself in,
 * serves the same menu/route/query shape, and the check runs the login step
 * (which saves the session), then `verify` (which restores it, walks the fixed
 * scenario, and writes the report), then a run with an expired session (which
 * must exit 2 with `UAT_SESSION_EXPIRED`). It needs the built packages, a
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
writeFileSync(configFile, `${JSON.stringify({ entryUrl: `${base}/app/`, loginUrl: `${base}/login.html`, accountId: '1234567890' }, null, 2)}\n`);
const env: NodeJS.ProcessEnv = { ...process.env, UAT_CONFIG_FILE: configFile, UAT_SESSION_FILE: sessionFile, UAT_REPORTS_DIR: reportsDirectory };

try {
  const login = await run(process.execPath, [e2eCli(), 'run', '--config', 'e2e.login.config.ts'], env);
  assert(login.code === 0, `login run exited ${login.code}\n${login.stdout}\n${login.stderr}`);
  assert((statSync(sessionFile).mode & 0o777) === 0o600, 'the saved session is not 0600');

  const verified = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(verified.code === 0, `verify exited ${verified.code}\n${verified.stdout}\n${verified.stderr}`);
  const reportDirectory = onlyDirectory(reportsDirectory);
  const report = JSON.parse(readFileSync(path.join(reportDirectory, 'report.json'), 'utf8')) as { status?: unknown; native?: { total?: unknown }; failures?: unknown };
  const markdown = readFileSync(path.join(reportDirectory, 'report.md'), 'utf8');
  assert(report.status === 'passed', `report status is ${String(report.status)}: ${markdown}`);
  assert(typeof report.native?.total === 'number' && report.native.total > 0, 'the report carries no native operations');
  assert(Array.isArray(report.failures) && report.failures.length === 0, 'a passing run reported failures');
  assert(markdown.includes('effects') && markdown.includes('scopeState'), 'the report does not show native settlement fields');
  assert(!markdown.includes('1234567890'), 'the report repeated the queried account ID');

  writeFileSync(sessionFile, `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entryOrigin: base, cookies: [{ name: 'uat_session', value: 'ok', domain: '127.0.0.1', path: '/', expires: 1 }], localStorage: {} })}\n`);
  const expired = await run(process.execPath, [path.join(appRoot, 'scripts', 'verify.ts')], env);
  assert(expired.code === 2, `an expired session exited ${expired.code}`);
  assert(`${expired.stdout}${expired.stderr}`.includes('UAT_SESSION_EXPIRED'), 'an expired session did not name its reason');

  console.log('UAT loop check passed: login saved the session, verify produced a passing redacted report, and an expired session exits 2.');
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

function onlyDirectory(directory: string): string {
  const entries = readdirSync(directory);
  assert(entries.length === 1, `expected one report directory, found ${entries.length}`);
  return path.join(directory, entries[0]!);
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
