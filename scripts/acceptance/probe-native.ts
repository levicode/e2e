/** Observe the actual ready frame through Web's real process wrapper, not --version. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sha256 } from './bundle.ts';
import { REPO_ROOT } from '../public-packages.ts';
import type { NativeEvent, NativeResult } from '../../packages/web/src/native/protocol.ts';

interface ProbeClient {
  request(command: string, args: Readonly<Record<string, unknown>>, context: { signal: AbortSignal; timeoutMs: number }): Promise<Pick<NativeResult, 'ok' | 'effects' | 'scopeState' | 'data' | 'error'>>;
  negotiation(): { protocol: string; capabilities: readonly string[]; limits: unknown };
  /** The production wrapper must settle natural proxy exit after the native closed frame. */
  close(context: { signal: AbortSignal; timeoutMs: number }): Promise<void>;
}
interface ProcessModule {
  connectNativeProcess(options: { executable: string; cwd: string; env: Readonly<Record<string, string | undefined>>; capabilities: readonly string[] }, context: { signal: AbortSignal; timeoutMs: number }, onEvent: (event: NativeEvent) => void): Promise<ProbeClient>;
}
const [binaryArg, capabilitiesFile, outputArg] = process.argv.slice(2);
if (!binaryArg || !capabilitiesFile || !outputArg) throw new Error('usage: probe-native.ts binary required-capabilities.json output.json');
const output = resolve(outputArg);
mkdirSync(dirname(output), { recursive: true });
let status: 'blocked' | 'passed' | 'failed' = 'blocked';
let stage = 'preflight';
let problem: string | undefined;
// Metadata from the production client's already validated result, never wire IDs,
// arbitrary payloads, error messages, page contents, paths, or URLs.
let failedOperation: { command: string; ok: boolean; effects: NativeResult['effects']; scopeState: NativeResult['scopeState']; errorCode?: string } | undefined;
let fallbackClose: 'not-needed' | 'fulfilled' | 'rejected' = 'not-needed';
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
let identityScope: string | undefined;
let pageActivationStarted = false;
let pageActivationConfirmed = false;
let navigationEventsObserved = 0;
let unexpectedEvent: Error | undefined;
let chromium: { sha256: string; version: string } | undefined;
try {
  const capabilities: unknown = JSON.parse(readFileSync(capabilitiesFile, 'utf8'));
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 64 || capabilities.some((item) => typeof item !== 'string' || !item)) throw new Error('Full browser acceptance requires a nonempty reviewed capability set');
  const binary = resolve(binaryArg);
  binarySha256 = sha256(readFileSync(binary));
  stage = 'production-module-import';
  const module = await import(pathToFileURL(resolve(process.env['NATIVE_PROCESS_MODULE'] ?? resolve(REPO_ROOT, 'packages/web/dist/native/process.js'))).href) as ProcessModule;
  status = 'failed';
  stage = 'native-negotiation';
  client = await module.connectNativeProcess({ executable: binary, cwd: home, env, capabilities }, { signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 }, (event) => {
    const payload = event.payload as Record<string, unknown> | null;
    // The wrapper validates generation/sequence. Accept only our explicit blank
    // navigation's projected notification, never decisions or arbitrary app events.
    if (pageActivationStarted && identityScope !== undefined && event.decision === undefined && event.event === 'app.navigation'
      && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === 4 && payload['identityScope'] === identityScope
      && payload['kind'] === 'main' && payload['url'] === 'about:blank' && payload['initiatedByOperation'] === true) {
      navigationEventsObserved++;
      return;
    }
    throw (unexpectedEvent ??= new Error('Unexpected event during native scope probe'));
  });
  negotiation = client.negotiation();
  const completed = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await client!.request(command, args, { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 });
    if (unexpectedEvent) throw unexpectedEvent;
    if (!result.ok || result.effects !== 'completed' || result.scopeState !== 'usable') {
      failedOperation = { command, ok: result.ok, effects: result.effects, scopeState: result.scopeState, ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }) };
      throw new Error(`Native scope exercise failed: ${command}`);
    }
    return result.data;
  };
  const request = async (command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const data = await completed(command, args);
    if (typeof data !== 'object' || data === null) throw new Error(`Native scope exercise failed: ${command}`);
    return data as Record<string, unknown>;
  };
  const chrome = process.env['E2E_CHROMIUM_EXECUTABLE'];
  if (!chrome) throw new Error('Scope exercise requires the explicitly installed Chromium executable');
  chromium = { sha256: sha256(readFileSync(resolve(chrome))), version: execFileSync(resolve(chrome), ['--version'], { encoding: 'utf8' }).trim() };
  stage = 'scope-open';
  const opened = await request('scope.open', { source: 'launch', executablePath: resolve(chrome), headless: true });
  if (typeof opened['identityScope'] !== 'string' || !opened['identityScope']) throw new Error('Scope open returned no identity');
  identityScope = opened['identityScope'];
  // The full page contract keeps a launched page logically unopened. Historical
  // foundation runtimes without browser.page/1 retain their original sequence.
  if (negotiation.capabilities.includes('browser.page/1')) {
    stage = 'page-activation';
    pageActivationStarted = true;
    const navigated = await completed('page.navigate', { identityScope, url: 'about:blank', waitUntil: 'load' });
    if (navigated !== null) throw new Error('Native scope exercise failed: page.navigate result');
    pageActivationConfirmed = true;
  }
  stage = 'page-roundtrip';
  const token = randomUUID();
  await request('page.evaluate', { identityScope: opened['identityScope'], source: '(token) => { document.title = "Native foundation"; document.body.dataset.probe = token; return true; }', argument: token });
  const readback = await request('page.evaluate', { identityScope: opened['identityScope'], source: '() => document.body.dataset.probe', argument: null });
  const title = await request('page.title', { identityScope: opened['identityScope'] });
  if (readback['value'] !== token || title['title'] !== 'Native foundation') throw new Error('Independent native page readback disagreed');
  scopeExercisePassed = true;
  stage = 'scope-and-process-cleanup';
  await client.close({ signal: AbortSignal.timeout(10_000), timeoutMs: 10_000 });
  if (unexpectedEvent) throw unexpectedEvent;
  if (existsSync(sockets) && readdirSync(sockets).some((name) => /\.(sock|pid|port)$/.test(name))) throw new Error('Owned daemon transport cleanup was not confirmed');
  cleanupConfirmed = true;
  if (sha256(readFileSync(binary)) !== binarySha256) throw new Error('Native executable changed during negotiation');
  status = 'passed';
  stage = 'complete';
} catch (error) {
  problem = unexpectedEvent?.message ?? (error instanceof Error ? error.message : String(error));
} finally {
  if (client && !cleanupConfirmed) {
    try { await client.close({ signal: AbortSignal.timeout(10_000), timeoutMs: 10_000 }); fallbackClose = 'fulfilled'; }
    catch { fallbackClose = 'rejected'; status = 'failed'; problem ??= 'Native scope cleanup was not confirmed'; }
  }
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, kind: 'native-runtime-negotiation', status, stage, binarySha256, negotiation, scopeExercisePassed, pageActivationConfirmed, navigationEventsObserved, chromium, cleanupConfirmed, failedOperation, fallbackClose, problem, releaseEligible: false, note: 'Owned scope open, explicit blank navigation when browser.page/1 is advertised, independent evaluate/readback, and acknowledged scope/proxy closure only; not browser behavior, installed consumer, or real-model proof.' }, null, 2));
}
if (status !== 'passed') console.error(`Native process proof ${status} at ${stage}; see the negotiation artifact for details`);
process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
