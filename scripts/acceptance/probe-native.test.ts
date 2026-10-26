/** Orchestration-only tests. These are never counted as native/browser evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const mode of ['success', 'wrong-readback', 'close-fails', 'missing-capabilities', 'foundation-event', 'scope-refused', 'scope-refused-close-fails'] as const) {
  test(`native probe orchestration: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-test-'));
    try {
      const output = join(directory, 'result.json');
      const capabilities = join(directory, 'capabilities.json');
      const module = join(directory, 'process.mjs');
      writeFileSync(capabilities, JSON.stringify(mode === 'missing-capabilities' ? [] : ['browser.scope/1', 'browser.evaluate/1']));
      writeFileSync(module, `
        export async function connectNativeProcess(options, context, onEvent) {
          if (options.env.AGENT_BROWSER_DAEMON !== '1' || options.env.AGENT_BROWSER_DASHBOARD !== '1') throw new Error('Hostile environment fixture absent');
          let token;
          return {
            negotiation() { return { protocol: 'fixture/1', capabilities: options.capabilities, limits: {} }; },
            async request(command, args) {
              ${mode === 'foundation-event' ? "onEvent({ type: 'event', generation: 1, sequence: 1, event: 'app.navigation', payload: { identityScope: 'fixture', kind: 'main', url: 'about:blank', initiatedByOperation: true } });" : ''}
              ${mode.startsWith('scope-refused') ? "return { ok: false, effects: 'unknown', scopeState: 'quarantined', error: { code: 'deadline-exceeded' }, data: { privatePayload: 'must-not-serialize' } };" : ''}
              let data;
              if (command === 'scope.open') data = { identityScope: 'fixture' };
              else if (command === 'page.title') data = { title: 'Native foundation' };
              else if (command === 'page.evaluate' && args.argument !== null) { token = args.argument; data = { value: true }; }
              else if (command === 'page.evaluate') data = { value: ${mode === 'wrong-readback' ? "'wrong'" : 'token'} };
              else throw new Error('Unexpected command');
              return { ok: true, effects: 'completed', scopeState: 'usable', data };
            },
            async close() { ${(mode === 'close-fails' || mode === 'scope-refused-close-fails') ? "throw new Error('No close acknowledgement');" : ''} }
          };
        }
      `);
      const child = spawnSync(process.execPath, ['scripts/acceptance/probe-native.ts', process.execPath, capabilities, output], {
        env: { ...process.env, NATIVE_PROCESS_MODULE: module, E2E_CHROMIUM_EXECUTABLE: process.execPath },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, mode === 'success' ? 0 : mode === 'missing-capabilities' ? 2 : 1, child.stderr);
      const result = JSON.parse(readFileSync(output, 'utf8')) as { status: string; cleanupConfirmed: boolean; pageActivationConfirmed: boolean; navigationEventsObserved: number; releaseEligible: boolean; failedOperation?: unknown; fallbackClose: string };
      assert.equal(result.status, mode === 'success' ? 'passed' : mode === 'missing-capabilities' ? 'blocked' : 'failed');
      assert.equal(result.releaseEligible, false);
      assert.equal(result.pageActivationConfirmed, false);
      assert.equal(result.navigationEventsObserved, 0);
      if (mode === 'close-fails') assert.equal(result.cleanupConfirmed, false);
      if (mode.startsWith('scope-refused')) {
        assert.deepEqual(result.failedOperation, { command: 'scope.open', ok: false, effects: 'unknown', scopeState: 'quarantined', errorCode: 'deadline-exceeded' });
        assert.equal(result.cleanupConfirmed, false, 'fallback closure cannot promote failed exercise');
        assert.equal(result.fallbackClose, mode === 'scope-refused' ? 'fulfilled' : 'rejected');
        assert.ok(!readFileSync(output, 'utf8').includes('must-not-serialize'));
      } else assert.equal(result.failedOperation, undefined);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const mode of [
  'success', 'own-navigation', 'late-own-navigation', 'wrong-readback', 'close-fails',
  'navigate-refused', 'navigate-object', 'navigate-missing', 'null-scope', 'null-evaluate',
  'foreign-scope', 'foreign-url', 'unowned-navigation', 'frame-navigation', 'decision',
  'app-log', 'unknown-event', 'extra-payload-field', 'missing-payload-field',
  'malformed-payload', 'early-event', 'unexpected-close-event',
] as const) {
  test(`full native probe activation and event safety: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-page-test-'));
    try {
      const output = join(directory, 'result.json');
      const capabilities = join(directory, 'capabilities.json');
      const module = join(directory, 'process.mjs');
      const calls = join(directory, 'calls.jsonl');
      writeFileSync(capabilities, JSON.stringify(['browser.scope/1', 'browser.evaluate/1', 'browser.page/1']));
      writeFileSync(module, `
        import { appendFileSync } from 'node:fs';
        const mode = ${JSON.stringify(mode)};
        const record = command => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(command) + '\\n');
        export async function connectNativeProcess(options, context, onEvent) {
          let token; let activated = false;
          function event() {
            const value = { type: 'event', generation: 1, sequence: 1, event: 'app.navigation', payload: { identityScope: 'fixture', kind: 'main', url: 'about:blank', initiatedByOperation: true } };
            if (mode === 'foreign-scope') value.payload.identityScope = 'foreign';
            if (mode === 'foreign-url') value.payload.url = 'https://unexpected.invalid/';
            if (mode === 'unowned-navigation') value.payload.initiatedByOperation = false;
            if (mode === 'frame-navigation') value.payload.kind = 'frame';
            if (mode === 'decision') value.decision = { token: 'must-not-accept', timeoutMs: 1000 };
            if (mode === 'app-log' || mode === 'unexpected-close-event') value.event = 'app.log';
            if (mode === 'unknown-event') value.event = 'unknown';
            if (mode === 'extra-payload-field') value.payload.unreviewed = true;
            if (mode === 'missing-payload-field') delete value.payload.initiatedByOperation;
            if (mode === 'malformed-payload') value.payload = null;
            return value;
          }
          return {
            negotiation() { return { protocol: 'fixture/1', capabilities: options.capabilities, limits: {} }; },
            async request(command, args) {
              record(command);
              let data;
              if (command === 'scope.open') {
                if (mode === 'early-event') onEvent(event());
                data = mode === 'null-scope' ? null : { identityScope: 'fixture' };
              } else if (command === 'page.navigate') {
                if (args.identityScope !== 'fixture' || args.url !== 'about:blank' || args.waitUntil !== 'load') throw new Error('Activation args changed');
                if (mode === 'navigate-refused') return { ok: false, effects: 'not-dispatched', scopeState: 'usable' };
                if (['own-navigation', 'foreign-scope', 'foreign-url', 'unowned-navigation', 'frame-navigation', 'decision', 'app-log', 'unknown-event', 'extra-payload-field', 'missing-payload-field', 'malformed-payload'].includes(mode)) onEvent(event());
                activated = true;
                data = mode === 'navigate-object' ? {} : mode === 'navigate-missing' ? undefined : null;
              } else {
                if (!activated) throw new Error('Page is logically unopened');
                if (command === 'page.title') data = { title: 'Native foundation' };
                else if (command === 'page.evaluate' && args.argument !== null) {
                  if (mode === 'late-own-navigation') onEvent(event());
                  token = args.argument; data = mode === 'null-evaluate' ? null : { value: true };
                } else if (command === 'page.evaluate') data = { value: mode === 'wrong-readback' ? 'wrong' : token };
                else throw new Error('Unexpected command');
              }
              return { ok: true, effects: 'completed', scopeState: 'usable', data };
            },
            async close() {
              record('close');
              if (mode === 'close-fails') throw new Error('No close acknowledgement');
              if (mode === 'unexpected-close-event') onEvent(event());
            },
          };
        }
      `);
      const child = spawnSync(process.execPath, ['scripts/acceptance/probe-native.ts', process.execPath, capabilities, output], {
        env: { ...process.env, NATIVE_PROCESS_MODULE: module, E2E_CHROMIUM_EXECUTABLE: process.execPath },
        encoding: 'utf8', timeout: 10_000,
      });
      const passed = mode === 'success' || mode === 'own-navigation' || mode === 'late-own-navigation';
      assert.equal(child.error, undefined);
      assert.equal(child.status, passed ? 0 : 1, child.stderr);
      const result = JSON.parse(readFileSync(output, 'utf8')) as { status: string; stage: string; cleanupConfirmed: boolean; scopeExercisePassed: boolean; pageActivationConfirmed: boolean; navigationEventsObserved: number; releaseEligible: boolean };
      assert.equal(result.status, passed ? 'passed' : 'failed');
      assert.equal(result.releaseEligible, false);
      assert.equal(result.navigationEventsObserved, mode === 'own-navigation' || mode === 'late-own-navigation' ? 1 : 0);
      const commands = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string);
      assert.equal(commands.at(-1), 'close', 'even a failed activation/readback/event must attempt cleanup');
      if (passed) {
        assert.equal(result.pageActivationConfirmed, true);
        assert.equal(result.scopeExercisePassed, true);
        assert.equal(result.cleanupConfirmed, true);
        assert.deepEqual(commands, ['scope.open', 'page.navigate', 'page.evaluate', 'page.evaluate', 'page.title', 'close']);
      } else assert.equal(result.cleanupConfirmed, false);
      if (mode.startsWith('navigate-')) {
        assert.equal(result.stage, 'page-activation');
        assert.equal(result.pageActivationConfirmed, false);
        assert.ok(!commands.includes('page.evaluate'));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
