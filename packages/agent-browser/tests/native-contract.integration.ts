/** Real binary handshake: unreachable browser settings must never be used. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { AGENT_BROWSER_CONTRACT, supportsNativeContract } from '../src/native-contract.ts';

const execute = promisify(execFile);

test('actual native capabilities validate the contract without starting a browser or daemon', { timeout: 15_000 }, async () => {
  const executable = process.env.E2E_AGENT_BROWSER_EXECUTABLE;
  assert.ok(executable, 'The real maintained native binary is required; do not skip the handshake gate');
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-native-capabilities-'));
  const config = path.join(directory, 'config.json');
  await writeFile(config, '{}', { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('AGENT_BROWSER_')));
  env.AGENT_BROWSER_SOCKET_DIR = directory;
  env.NO_COLOR = '1';
  try {
    const result = await execute(executable, [
      '--config', config, '--session', 'browser-free-handshake', '--json',
      '--expect-contract', AGENT_BROWSER_CONTRACT,
      '--cdp', 'http://127.0.0.1:1', '--cdp-target', 'unreachable-target', '--cdp-context', 'default', '--cdp-dedicated',
      '--executable-path', path.join(directory, 'this-browser-must-not-be-launched'),
      'capabilities',
    ], { encoding: 'utf8', env, timeout: 5_000, maxBuffer: 1024 * 1024 });
    const envelope = JSON.parse(result.stdout) as { success?: unknown; data?: unknown };
    assert.equal(envelope.success, true);
    assert.ok(supportsNativeContract(envelope.data), 'The actual binary must provide the complete protocol and ownership bundle');
    assert.deepEqual(await readdir(directory), ['config.json'], 'A browser-free handshake must not create daemon socket, PID or state files');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
