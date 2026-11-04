/** Linux acceptance: real built CLI, native proxy/daemon and Chrome process ownership. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createProject } from '../helpers/run-project.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../../web/tests/helpers/cdp-host.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
interface Identity { pid: number; parent: number; group: number; state: string; started: string }

/** /proc identity only: no command lines, credentials, browser data or mutable name matching. */
function identity(pid: number): Identity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = fields[0]; const started = fields[19];
    if (state === undefined || started === undefined) throw new Error('Invalid process identity');
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), state, started };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    throw error;
  }
}
function stillLive(owned: Identity): boolean {
  const current = identity(owned.pid);
  return current !== undefined && current.started === owned.started && current.state !== 'Z' && current.state !== 'X';
}
function descendants(parent: number): Identity[] {
  const all = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    const row = identity(Number(name)); return row === undefined ? [] : [row];
  });
  const selected = new Set([parent]);
  for (let previous = 0; previous !== selected.size;) {
    previous = selected.size;
    for (const row of all) if (selected.has(row.parent)) selected.add(row.pid);
  }
  return all.filter(row => row.pid !== parent && selected.has(row.pid));
}
async function until(check: () => boolean, budget: number, label: string): Promise<void> {
  const deadline = Date.now() + budget;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

/** Kill/reap only identities this fixture actually observed, never a borrowed host or name match. */
async function runOwnershipCase(borrowed: boolean, stop: 'interrupt-twice' | 'worker-death'): Promise<void> {
  const app = await startFixtureApp();
  let host: RemoteChrome | undefined;
  const owned: Identity[] = [];
  let project: ReturnType<typeof createProject> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<number | null> | undefined;
  try {
    if (borrowed) host = await launchRemoteChrome();
    const connect = host === undefined ? '' : `connect: { cdpEndpoint: () => ${JSON.stringify(host.endpoint)} }`;
    project = createProject({
      'e2e.config.ts': `import { web } from '@e2e-dev/web';
export default { tests: 'tests/*.e2e.ts', targets: [{ name: 'web', engine: web({ ${connect} }), app: { url: ${JSON.stringify(app.url)} } }], timeout: 60000, cleanupTimeout: 5000, workers: 1, cache: 'off' };`,
      'tests/sleep.e2e.ts': `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';
const log = event => appendFileSync(process.env.SIGNAL_LOG, process.pid + ' ' + event + '\\n');
test.afterEach(async () => { log('afterEach.start'); await new Promise(resolve => setTimeout(resolve, 600000)); });
test('holds a browser', async ({ app }) => { await app.open('/'); log('test.start'); await new Promise(resolve => setTimeout(resolve, 600000)); });`,
    });
    const log = path.join(project.dir, 'ownership.log');
    let output = '';
    child = spawn(process.execPath, [CLI, 'run'], { cwd: project.dir, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '', SIGNAL_LOG: log } });
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    exited = new Promise(resolve => child!.once('exit', code => resolve(code)));
    const lines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    await until(() => lines().some(line => line.endsWith(' test.start')), 25_000, 'the real browser test to start');
    const worker = Number(lines().find(line => line.endsWith(' test.start'))!.split(' ')[0]);
    owned.push(...descendants(worker));
    // Both dedicated proxy and daemon must be present; the browser is additional when owned.
    expect(owned.length).toBeGreaterThanOrEqual(borrowed ? 2 : 3);
    const proxy = owned.find(row => row.parent === worker);
    expect(proxy).toBeDefined();
    expect(proxy!.group).toBe(proxy!.pid);
    expect(owned.every(row => row.group !== child!.pid)).toBe(true);
    if (host?.proc.pid !== undefined) expect(owned.some(row => row.pid === host!.proc.pid)).toBe(false);

    if (stop === 'interrupt-twice') {
      process.kill(-child.pid!, 'SIGINT');
      await until(() => lines().some(line => line.endsWith(' afterEach.start')), 10_000, 'the cleanup hook');
      process.kill(-child.pid!, 'SIGINT');
      expect(await exited, output).toBe(130);
      expect(output).not.toContain('WORKER_EXIT');
      const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8')) as {
        run: { errors: unknown[]; results: { status: string; attempts: unknown[] }[] };
      };
      expect(report.run.errors, output).toEqual([]);
      // Force abandons the unfinished unit: the unchanged scheduler preserves
      // only completed attempts. The original one-Ctrl-C test still requires
      // one interrupted attempt; this stuck afterEach has not published one.
      expect(report.run.results).toMatchObject([{
        status: 'skipped', attempts: [],
        skip: { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' },
      }]);
    } else {
      // No engine dispose can run: native cleanup must follow the dead owner's pipe EOF.
      process.kill(worker, 'SIGKILL');
      expect(await exited, output).not.toBe(0);
      expect(output).toContain('WORKER_EXIT');
    }
    await until(() => owned.every(row => !stillLive(row)), 15_000, `owned native/browser children to retire: ${JSON.stringify(owned)}`);
    if (host !== undefined) {
      expect(host.proc.exitCode).toBeNull(); expect(host.proc.signalCode).toBeNull();
      const version = new URL('/json/version', host.endpoint.replace(/^ws:/, 'http:'));
      const response = await fetch(version, { signal: AbortSignal.timeout(3_000) });
      expect(response.ok).toBe(true);
      expect((await response.json() as { Browser?: string }).Browser).toMatch(/Chrome|Chromium/);
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Foreground job already gone. */ }
    }
    await exited;
    for (const row of owned) if (stillLive(row)) {
      try { process.kill(row.pid, 'SIGKILL'); } catch { /* Exact observed child already gone. */ }
    }
    if (host !== undefined) await closeRemoteChrome(host);
    project?.cleanup();
    await app.close();
  }
}

describe.skipIf(process.platform !== 'linux')('native interrupt process ownership', () => {
  it.each([false, true])('two Ctrl-C signals retire owned children and preserve borrowed=%s browser', borrowed =>
    runOwnershipCase(borrowed, 'interrupt-twice'), 60_000);
  it.each([false, true])('worker death retires pipe-bound native children and preserves borrowed=%s browser', borrowed =>
    runOwnershipCase(borrowed, 'worker-death'), 60_000);
});
