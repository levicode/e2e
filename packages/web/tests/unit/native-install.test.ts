import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runNativeInstall } from '../../src/native/install.ts';
import { resolveNativeExecutable } from '../../src/native/runtime.ts';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../src/native/runtime.ts', () => ({ resolveNativeExecutable: vi.fn(async () => '/trusted/matched-agent-browser') }));
const context = { cwd: '/synthetic/project', env: { HOME: '/synthetic/home', E2E_AGENT_BROWSER_EXECUTABLE: '/trusted/matched-agent-browser' } };
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => { child = Object.assign(new EventEmitter(), { kill: vi.fn() }); vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>); });
describe('explicit native installer', () => {
  it.each([['install'], ['install', '--with-deps']])('runs exact trusted argv %j with explicit environment and no shell', async (...args) => {
    const pending = runNativeInstall(args, context); await Promise.resolve();
    expect(resolveNativeExecutable).toHaveBeenCalledWith(context.env, context.cwd);
    expect(spawn).toHaveBeenCalledWith('/trusted/matched-agent-browser', args, { cwd: context.cwd, env: context.env, shell: false, stdio: 'inherit', windowsHide: true });
    child.emit('exit', 23, null); await expect(pending).resolves.toBe(23);
  });
  it('rejects unrecognized installer arguments before spawning', async () => {
    await expect(runNativeInstall(['install', '--arbitrary-shell-option'], context)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not leak raw process errors and removes signal listeners', async () => {
    const interrupts = process.listenerCount('SIGINT'); const terminations = process.listenerCount('SIGTERM');
    const pending = runNativeInstall(['install'], context); await Promise.resolve();
    child.emit('error', new Error('synthetic-private-path'));
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The trusted native Chromium installer could not run' });
    expect(process.listenerCount('SIGINT')).toBe(interrupts); expect(process.listenerCount('SIGTERM')).toBe(terminations);
  });
  it('redacts synchronous spawn failures without adding signal listeners', async () => {
    const interrupts = process.listenerCount('SIGINT'); const terminations = process.listenerCount('SIGTERM');
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('synthetic-private-environment'); });
    await expect(runNativeInstall(['install'], context)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'The trusted native Chromium installer could not run' });
    expect(process.listenerCount('SIGINT')).toBe(interrupts); expect(process.listenerCount('SIGTERM')).toBe(terminations);
  });
  it('reports signal termination as a conventional nonzero exit code', async () => {
    const pending = runNativeInstall(['install'], context); await Promise.resolve();
    child.emit('exit', null, 'SIGTERM'); await expect(pending).resolves.toBe(143);
  });
});
