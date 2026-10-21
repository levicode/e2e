/** Observe the actual ready frame through Web's real process wrapper, not --version. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sha256 } from './bundle.ts';
import { REPO_ROOT } from '../public-packages.ts';

interface ProbeClient {
  request(command: string, args: Readonly<Record<string, unknown>>, context: { signal: AbortSignal; timeoutMs: number }): Promise<{ ok: boolean; effects: string; scopeState: string; data?: unknown }>;
  negotiation(): { protocol: string; capabilities: readonly string[]; limits: unknown };
  /** The production wrapper must settle natural proxy exit after the native closed frame. */
  close(context: { signal: AbortSignal; timeoutMs: number }): Promise<void>;
}
interface ProcessModule {
  connectNativeProcess(options: { executable: string; cwd: string; env: Readonly<Record<string, string | undefined>>; capabilities: readonly string[] }, context: { signal: AbortSignal; timeoutMs: number }, onEvent: () => void): Promise<ProbeClient>;
}
const [binaryArg, capabilitiesFile, outputArg] = process.argv.slice(2);
if (!binaryArg || !capabilitiesFile || !outputArg) throw new Error('usage: probe-native.ts binary required-capabilities.json output.json');
const output = resolve(outputArg);
mkdirSync(dirname(output), { recursive: true });
let status: 'blocked' | 'passed' | 'failed' = 'blocked';
let problem: string | undefined;
let negotiation: ReturnType<ProbeClient['negotiation']> | undefined;
let binarySha256: string | undefined;
const home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'abp-'));
const sockets = join(home, 'sockets');
const env: Record<string, string | undefined> = { ...process.env, HOME: home, AGENT_BROWSER_SOCKET_DIR: sockets, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_DASHBOARD: '1', AGENT_BROWSER_EXECUTABLE_PATH: '/must-not-use-inherited-browser', AGENT_BROWSER_PROFILE: join(home, 'must-not-use-profile') };
delete env['AGENT_BROWSER_NAMESPACE'];
mkdirSync(join(home, '.agent-browser'));
const hostileConfig = JSON.stringify({ executablePath: '/must-not-use-config-browser', profile: join(home, 'must-not-use-profile') });
writeFileSync(join(home, 'agent-browser.json'), hostileConfig);
writeFileSync(join(home, '.agent-browser', 'config.json'), hostileConfig);
let cleanupConfirmed = false;
let client: ProbeClient | undefined;
let scopeExercisePassed = false;
let chromium: { sha256: string; version: string } | undefined;
try {
  const capabilities: unknown = JSON.parse(readFileSync(capabilitiesFile, 'utf8'));
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 64 || capabilities.some((item) => typeof item !== 'string' || !item)) throw new Error('Full browser acceptance requires a nonempty reviewed capability set');
  const binary = resolve(binaryArg);
  binarySha256 = sha256(readFileSync(binary));
  const module = await import(pathToFileURL(resolve(process.env['NATIVE_PROCESS_MODULE'] ?? resolve(REPO_ROOT, 'packages/web/dist/native/process.js'))).href) as ProcessModule;
  status = 'failed';
  client = await module.connectNativeProcess({ executable: binary, cwd: home, env, capabilities }, { signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 }, () => { throw new Error('Unexpected event during capability-only probe'); });
  negotiation = client.negotiation();
  const request = async (command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client!.request(command, args, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 });
    if (!result.ok || result.effects !== 'completed' || result.scopeState !== 'usable' || typeof result.data !== 'object' || result.data === null) throw new Error(`Native scope exercise failed: ${command}`);
    return result.data as Record<string, unknown>;
  };
  const chrome = process.env['E2E_CHROMIUM_EXECUTABLE'];
  if (!chrome) throw new Error('Scope exercise requires the explicitly installed Chromium executable');
  chromium = { sha256: sha256(readFileSync(resolve(chrome))), version: execFileSync(resolve(chrome), ['--version'], { encoding: 'utf8' }).trim() };
  const opened = await request('scope.open', { source: 'launch', executablePath: resolve(chrome), headless: true });
  if (typeof opened['identityScope'] !== 'string' || !opened['identityScope']) throw new Error('Scope open returned no identity');
  const token = randomUUID();
  await request('page.evaluate', { source: '(token) => { document.title = "Native foundation"; document.body.dataset.probe = token; return true; }', argument: token });
  const readback = await request('page.evaluate', { source: '() => document.body.dataset.probe', argument: null });
  const title = await request('page.title', {});
  if (readback['value'] !== token || title['title'] !== 'Native foundation') throw new Error('Independent native page readback disagreed');
  scopeExercisePassed = true;
  await client.close({ signal: AbortSignal.timeout(10_000), timeoutMs: 10_000 });
  if (existsSync(sockets) && readdirSync(sockets).some((name) => /\.(sock|pid|port)$/.test(name))) throw new Error('Owned daemon transport cleanup was not confirmed');
  cleanupConfirmed = true;
  if (sha256(readFileSync(binary)) !== binarySha256) throw new Error('Native executable changed during negotiation');
  status = 'passed';
} catch (error) {
  problem = error instanceof Error ? error.message : String(error);
} finally {
  if (client && !cleanupConfirmed) {
    try { await client.close({ signal: AbortSignal.timeout(10_000), timeoutMs: 10_000 }); }
    catch { status = 'failed'; problem ??= 'Native scope cleanup was not confirmed'; }
  }
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, kind: 'native-runtime-negotiation', status, binarySha256, negotiation, scopeExercisePassed, chromium, cleanupConfirmed, problem, releaseEligible: false, note: 'Owned scope open/evaluate/readback and acknowledged scope/proxy closure only; not browser behavior, installed consumer, or real-model proof.' }, null, 2));
}
process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
