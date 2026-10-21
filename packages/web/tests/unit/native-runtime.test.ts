import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNativeExecutable } from '../../src/native/runtime.ts';

describe('explicit native runtime resolution', () => {
  it('never searches PATH or silently installs a missing runtime', async () => {
    await expect(resolveNativeExecutable({ PATH: '/usr/bin' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(resolveNativeExecutable({ E2E_AGENT_BROWSER_EXECUTABLE: 'agent-browser' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('accepts only an executable file and resolves its exact filesystem target', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'native-runtime-'));
    try {
      const file = path.join(directory, 'trusted-build');
      await writeFile(file, 'synthetic test fixture, never executed');
      await chmod(file, 0o600);
      await expect(resolveNativeExecutable({ E2E_AGENT_BROWSER_EXECUTABLE: file })).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await chmod(file, 0o700);
      const link = path.join(directory, 'current');
      await symlink(file, link);
      await expect(resolveNativeExecutable({ E2E_AGENT_BROWSER_EXECUTABLE: link })).resolves.toBe(file);
      const folder = path.join(directory, 'folder');
      await mkdir(folder);
      await expect(resolveNativeExecutable({ E2E_AGENT_BROWSER_EXECUTABLE: folder })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not leak a private executable path on failure', async () => {
    await expect(resolveNativeExecutable({ E2E_AGENT_BROWSER_EXECUTABLE: '/synthetic-private-project/not-present' })).rejects.toMatchObject({ message: 'E2E_AGENT_BROWSER_EXECUTABLE must name an absolute executable file' });
  });
});
