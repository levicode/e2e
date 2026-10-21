/** Orchestration-only tests. These are never counted as native/browser evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const mode of ['success', 'wrong-readback', 'close-fails', 'missing-capabilities'] as const) {
  test(`native probe orchestration: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-test-'));
    try {
      const output = join(directory, 'result.json');
      const capabilities = join(directory, 'capabilities.json');
      const module = join(directory, 'process.mjs');
      writeFileSync(capabilities, JSON.stringify(mode === 'missing-capabilities' ? [] : ['browser.scope/1', 'browser.evaluate/1']));
      writeFileSync(module, `
        export async function connectNativeProcess(options) {
          if (options.env.AGENT_BROWSER_DAEMON !== '1' || options.env.AGENT_BROWSER_DASHBOARD !== '1') throw new Error('Hostile environment fixture absent');
          let token;
          return {
            negotiation() { return { protocol: 'fixture/1', capabilities: options.capabilities, limits: {} }; },
            async request(command, args) {
              let data;
              if (command === 'scope.open') data = { identityScope: 'fixture' };
              else if (command === 'page.title') data = { title: 'Native foundation' };
              else if (command === 'page.evaluate' && args.argument !== null) { token = args.argument; data = { value: true }; }
              else if (command === 'page.evaluate') data = { value: ${mode === 'wrong-readback' ? "'wrong'" : 'token'} };
              else throw new Error('Unexpected command');
              return { ok: true, effects: 'completed', scopeState: 'usable', data };
            },
            async close() { ${mode === 'close-fails' ? "throw new Error('No close acknowledgement');" : ''} }
          };
        }
      `);
      const child = spawnSync(process.execPath, ['scripts/acceptance/probe-native.ts', process.execPath, capabilities, output], {
        env: { ...process.env, NATIVE_PROCESS_MODULE: module, E2E_CHROMIUM_EXECUTABLE: process.execPath },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, mode === 'success' ? 0 : mode === 'missing-capabilities' ? 2 : 1, child.stderr);
      const result = JSON.parse(readFileSync(output, 'utf8')) as { status: string; cleanupConfirmed: boolean; releaseEligible: boolean };
      assert.equal(result.status, mode === 'success' ? 'passed' : mode === 'missing-capabilities' ? 'blocked' : 'failed');
      assert.equal(result.releaseEligible, false);
      if (mode === 'close-fails') assert.equal(result.cleanupConfirmed, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
