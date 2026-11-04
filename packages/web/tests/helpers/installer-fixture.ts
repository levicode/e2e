/** P14 only: a real native installer, stalled after archive bytes are accepted for write. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const INSTALLER_EXECUTABLE_ENV = 'E2E_INSTALLER_FIXTURE_EXECUTABLE';
export const INSTALLER_BINDING_ENV = 'E2E_INSTALLER_FIXTURE_BINDING';
export const INSTALLER_MANIFEST_ENV = 'AGENT_BROWSER_ACCEPTANCE_INSTALL_MANIFEST';
export interface InstallerRuntimeBinding {
  caseId: 'P14'; purpose: 'installer-cancellation-loopback'; binarySha256: string; negotiationProofSha256: string;
}
export interface InstallerRuntimeReceipt extends InstallerRuntimeBinding { postRunIdentityVerified: boolean }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
/** A closed secondary identity, with no paths or ambient environment claims in the receipt. */
export function validInstallerRuntimeBinding(value: unknown): value is InstallerRuntimeBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).toSorted().join(',') === 'binarySha256,caseId,negotiationProofSha256,purpose'
    && object['caseId'] === 'P14' && object['purpose'] === 'installer-cancellation-loopback'
    && digest(object['binarySha256']) && digest(object['negotiationProofSha256']);
}
/** Fixture settings are never inherited by production suites or their children. */
export function cleanInstallerEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const name of [INSTALLER_EXECUTABLE_ENV, INSTALLER_BINDING_ENV, INSTALLER_MANIFEST_ENV]) delete env[name];
  return env;
}
/** Rehash the exact canonical executable immediately before P14 spawns the wrapper. */
export function installerRuntimeFromEnvironment(env: NodeJS.ProcessEnv): { binary: string; binding: InstallerRuntimeBinding } {
  const binary = env[INSTALLER_EXECUTABLE_ENV];
  const binding: unknown = JSON.parse(env[INSTALLER_BINDING_ENV] ?? 'null');
  if (!binary || !isAbsolute(binary) || realpathSync(binary) !== binary || !validInstallerRuntimeBinding(binding)
    || createHash('sha256').update(readFileSync(binary)).digest('hex') !== binding.binarySha256) throw new Error('Missing or changed verified P14 installer runtime');
  return { binary, binding };
}
/** Native Chrome-for-Testing platform names, not Playwright download configuration. */
export function installerManifest(port: number): unknown {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a nonzero loopback port');
  return { channels: { Stable: { version: '999.0.0.1', downloads: { chrome: ['linux64', 'mac-arm64', 'mac-x64', 'win64'].map(platform => ({ platform, url: `http://127.0.0.1:${port}/archive.zip` })) } } } };
}
/** A PGID is a one-lifetime receipt: never address it again after observed absence. */
export function ownedProcessGroupSignal(pid: number, kill: (pid: number, signal: NodeJS.Signals | 0) => boolean = process.kill): (signal: NodeJS.Signals | 0) => boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Expected an owned process group');
  let gone = false;
  return signal => {
    if (gone) return false;
    try { return kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      gone = true;
      return false;
    }
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
type Exit = { code: number | null; signal: NodeJS.Signals | null };
/** Construct synchronously so the test can register the bounded backstop before any await. */
export function createInstallerFixture(wrapper: string, inherited: NodeJS.ProcessEnv = process.env) {
  if (process.platform === 'win32') throw new Error('P14 requires owned POSIX process-group cleanup');
  const runtime = installerRuntimeFromEnvironment(inherited);
  const home = mkdtempSync(join(tmpdir(), 'e2e-web-cli-'));
  const sockets = new Set<Socket>();
  const stopped = deferred<never>(); const archiveReady = deferred<void>(); const archiveClosed = deferred<void>();
  let child: ChildProcess | undefined; let settlement: Promise<Exit> | undefined; let childSettled = false;
  let archive: Socket | undefined; let cancelling = false; let closed = false; let port = 0; let cleanup: Promise<void> | undefined;
  let listening: Promise<void> | undefined;
  let ownedGroup: ReturnType<typeof ownedProcessGroupSignal> | undefined;
  const guard = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped.promise]);
  const transportFailed = (error: Error) => {
    if (closed || (cancelling && ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException).code ?? ''))) return;
    stopped.reject(error);
  };
  const server = createServer((request, response) => {
    response.once('error', transportFailed);
    if (closed || request.method !== 'GET') { response.writeHead(405).end(); stopped.reject(new Error('Unexpected installer fixture request')); return; }
    if (request.url === '/manifest.json') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(installerManifest(port))); return;
    }
    if (request.url !== '/archive.zip' || archive) { response.writeHead(404).end(); stopped.reject(new Error('Unexpected installer fixture route')); return; }
    archive = request.socket;
    archive.once('close', () => archiveClosed.resolve());
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': '1048576' });
    // This is write acceptance, not a claim that the native reader consumed bytes.
    response.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]), error => {
      if (error) stopped.reject(error); else if (!closed) archiveReady.resolve();
    });
  });
  server.on('error', error => stopped.reject(error));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', transportFailed); });
  function signalGroup(signal: NodeJS.Signals): boolean { return ownedGroup?.(signal) ?? false; }
  function groupExists(): boolean { return ownedGroup?.(0) ?? false; }
  async function waitForGroup(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (groupExists() && Date.now() < deadline) await pause(20);
    return !groupExists();
  }
  return {
    binding: runtime.binding,
    async start() {
      if (closed || listening) throw new Error('Installer fixture already started or closed');
      listening = new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(0, '127.0.0.1');
      });
      await guard(listening);
      if (closed) throw new Error('Installer fixture closed');
      const address = server.address();
      if (!address || typeof address === 'string' || !address.port) throw new Error('Expected a nonzero TCP address');
      port = address.port;
      const selected = installerRuntimeFromEnvironment(inherited);
      if (selected.binary !== runtime.binary || JSON.stringify(selected.binding) !== JSON.stringify(runtime.binding)) throw new Error('P14 runtime changed before spawn');
      child = spawn(process.execPath, [wrapper, 'install', 'chromium'], { detached: true, stdio: 'ignore', env: {
        ...cleanInstallerEnvironment(inherited), E2E_AGENT_BROWSER_EXECUTABLE: runtime.binary,
        HOME: home, [INSTALLER_MANIFEST_ENV]: `http://127.0.0.1:${port}/manifest.json`,
      } });
      if (child.pid !== undefined) ownedGroup = ownedProcessGroupSignal(child.pid);
      settlement = new Promise<Exit>((resolve, reject) => {
        child!.once('exit', (code, signal) => { childSettled = true; resolve({ code, signal }); });
        child!.once('error', error => { childSettled = true; reject(error); });
      });
      void settlement.catch(() => {});
      await guard(Promise.race([archiveReady.promise, settlement.then(() => { throw new Error('Installer exited before archive bytes were written'); })]));
      if (closed || childSettled || !archive || archive.destroyed) throw new Error('Installer archive is not active before cancellation');
      return {
        cancel() {
          if (closed || childSettled || !archive || archive.destroyed) throw new Error('Installer archive is not active before cancellation');
          cancelling = true;
          return child!.kill('SIGTERM');
        },
        exited: () => guard(settlement!), downloadClosed: () => guard(archiveClosed.promise),
      };
    },
    /** Assertion SIGTERM targets only the wrapper. Group signals exist solely in this failure backstop. */
    close(): Promise<void> {
      if (cleanup) return cleanup;
      closed = true;
      const closing = new Error('Installer fixture is closing');
      stopped.reject(closing); archiveReady.reject(closing); archiveClosed.reject(closing);
      cleanup = (async () => {
        const failures: unknown[] = [];
        try {
          if (groupExists()) { signalGroup('SIGTERM'); if (!await waitForGroup(500)) { signalGroup('SIGKILL'); if (!await waitForGroup(1500)) throw new Error('Installer process group did not terminate'); } }
          if (settlement) await bounded(settlement.catch(() => {}), 500, 'Installer wrapper was not reaped');
          child?.removeAllListeners('exit'); child?.removeAllListeners('error');
        } catch (error) { failures.push(error); }
        for (const socket of sockets) socket.destroy();
        try {
          if (listening) await bounded(listening.catch(() => {}), 500, 'Installer listener did not settle');
          if (server.listening) await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 500, 'Installer server did not close');
        } catch (error) { failures.push(error); }
        // Keep HOME for diagnosis if process/socket ownership could not be discharged.
        if (!failures.length) rmSync(home, { recursive: true, force: true });
        if (failures.length) throw new AggregateError(failures, 'P14 installer cleanup failed');
      })();
      return cleanup;
    },
  };
}
