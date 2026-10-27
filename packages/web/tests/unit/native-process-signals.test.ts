/** Real child pipes and POSIX process-group signals; not native/browser acceptance. */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { AcceptanceRecord } from '../../src/native/acceptance-trace.ts';

interface Notice {
  kind: string;
  proxyPid?: number;
  count?: number;
  record?: AcceptanceRecord;
  records?: AcceptanceRecord[];
  failure?: { code: string; message: string };
}
const ownerScript = fileURLToPath(new URL('../helpers/native-process-owner.ts', import.meta.url));
const peerScript = fileURLToPath(new URL('../helpers/native-process-peer.cjs', import.meta.url));

/** Read only scalar process identity/state, never argv or environment. */
function processState(pid: number): { group: number; live: boolean } | undefined {
  try {
    const row = execFileSync('ps', ['-o', 'pgid=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (row === '') return undefined;
    const [group, state] = row.split(/\s+/);
    return { group: Number(group), live: state !== undefined && !state.startsWith('Z') };
  } catch { return undefined; }
}

async function withOwner(mode: string, body: (owner: {
  pid: number; proxyPid: number;
  wait(predicate: (notice: Notice) => boolean): Promise<Notice>;
  close(): Promise<Notice>;
  exited: Promise<void>;
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-process-signals-'));
  const executable = path.join(directory, 'peer.cjs');
  copyFileSync(peerScript, executable);
  chmodSync(executable, 0o700);
  const child = spawn(process.execPath, ['--experimental-transform-types', ownerScript, executable], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PROCESS_FIXTURE_EXIT: mode },
  });
  const notices: Notice[] = [];
  let diagnostics = '';
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  child.on('message', notice => notices.push(notice as Notice));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let proxyPid: number | undefined;
  const wait = async (predicate: (notice: Notice) => boolean): Promise<Notice> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = notices.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`Process fixture did not settle: ${diagnostics}`);
      await delay(10);
    }
  };
  try {
    const ready = await wait(notice => notice.kind === 'ready');
    proxyPid = ready.proxyPid;
    if (child.pid === undefined || proxyPid === undefined) throw new Error('Missing process identity');
    await body({ pid: child.pid, proxyPid, wait, exited,
      close: () => { child.send('close'); return wait(notice => notice.kind === 'settled'); } });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    // Only the exact fixture child, never a process group or a borrowed host.
    if (proxyPid !== undefined && processState(proxyPid)?.live) process.kill(proxyPid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('native proxy process-group ownership', () => {
  it('survives repeated foreground Ctrl-C and still requires closed plus clean process exit', () =>
    withOwner('clean', async owner => {
      const ownerGroup = processState(owner.pid)?.group;
      const proxyGroup = processState(owner.proxyPid)?.group;
      // Deliver first, so the old adapter records its real EOF/exit failure too.
      process.kill(-owner.pid, 'SIGINT');
      await owner.wait(notice => notice.kind === 'interrupt' && notice.count === 1);
      process.kill(-owner.pid, 'SIGINT');
      await owner.wait(notice => notice.kind === 'interrupt' && notice.count === 2);
      const settled = await owner.close();
      expect(settled.failure, JSON.stringify({ ownerGroup, proxyGroup, settled })).toBeUndefined();
      expect(proxyGroup).toBe(owner.proxyPid);
      expect(proxyGroup).not.toBe(ownerGroup);
      expect(settled.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: 'StdinEndEntered' }),
        expect.objectContaining({ phase: 'ProcessExit', exitCode: 0, signalled: false }),
        expect.objectContaining({ phase: 'ProcessClose', exitCode: 0, signalled: false }),
      ]));
      await owner.exited;
      expect(processState(owner.proxyPid)?.live ?? false).toBe(false);
    }));

  it.each(['nonzero', 'signalled', 'without-closed'])('still rejects real %s termination', mode =>
    withOwner(mode, async owner => {
      const settled = await owner.close();
      expect(settled.failure).toMatchObject({ code: 'ENGINE_FAILURE' });
      if (mode === 'without-closed') expect(settled.failure?.message).toContain('before scope settlement');
      else expect(settled.failure?.message).toContain('did not exit cleanly');
      await owner.exited;
      expect(processState(owner.proxyPid)?.live ?? false).toBe(false);
    }));

  it('keeps the detached proxy pipe-bound when its owner is killed', () =>
    withOwner('clean', async owner => {
      expect(processState(owner.proxyPid)?.live).toBe(true);
      process.kill(owner.pid, 'SIGKILL');
      await owner.exited;
      const deadline = Date.now() + 5_000;
      while (processState(owner.proxyPid)?.live && Date.now() < deadline) await delay(20);
      expect(processState(owner.proxyPid)?.live ?? false).toBe(false);
    }));
});
