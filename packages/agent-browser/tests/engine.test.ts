import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError } from 'e2e/engine';
import { agentBrowser, ENGINE_NAME, ENGINE_VERSION } from '../src/engine.ts';
import type { BrowserConnect } from '../src/connection-source.ts';
import type { BrowserProvider } from '../src/provider.ts';

test('separate public SPI identity advertises actual implemented capabilities', () => {
  const engine = agentBrowser();
  assert.equal(engine.spiVersion, 1);
  assert.equal(engine.name, ENGINE_NAME);
  assert.equal(engine.version, ENGINE_VERSION);
  assert.notEqual(engine.name, 'web');
  assert.notEqual(engine.name, 'agent-browser-exact-4', 'The prior optimistic pixel-proof epoch must not share replay caches');
  for (const capability of ['observation', 'actions', 'location', 'keyboard', 'pointer', 'state', 'artifacts', 'browser']) assert.ok(engine.capabilities.has(capability));
  assert.equal(typeof engine.artifacts?.startVideo, 'function');
  assert.equal(engine.pointerActions?.includes('doubleTap'), true);
});

test('unknown options and isolation override fail before launch', () => {
  assert.throws(() => agentBrowser({ browser: 'firefox' } as never), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ args: ['--user-data-dir=/tmp/shared'] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ viewport: { width: 0, height: 100 } }), { code: 'INVALID_CONFIG' });
});

test('shared provider scopes fail synchronously before any provider callback', () => {
  const called: string[] = [];
  const provider: BrowserProvider = {
    name: 'shared-provider',
    acquire: async () => { called.push('acquire'); return { id: 'lease', cdpEndpoint: 'ws://browser.example/shared' }; },
    release: async () => { called.push('release'); },
    record: async () => { called.push('record'); throw new Error('Must not record'); },
    sweep: async () => { called.push('sweep'); return []; },
    downloads: { dir: '/downloads', read: async () => { called.push('read'); return new Uint8Array(); } },
  };
  for (const candidate of [provider, { ...provider, scope: 'worker' as const }]) {
    assert.throws(() => agentBrowser({ browser: candidate }), (error: unknown) => error instanceof ConfigurationError
      && error.code === 'INVALID_CONFIG' && /dedicated browser endpoint per attempt/.test(error.message)
      && /worker-scoped browser providers are unsupported/.test(error.message));
  }
  assert.deepEqual(called, []);
});

test('shared callback scopes fail synchronously before endpoint resolution or reconnect', () => {
  let resolved = 0;
  let reconnected = 0;
  const cdpEndpoint = async () => { resolved++; return 'ws://browser.example/shared'; };
  const reconnectEndpoint = async () => { reconnected++; return 'ws://browser.example/recovered'; };
  const cases: BrowserConnect[] = [
    { cdpEndpoint },
    { cdpEndpoint, scope: 'worker' },
    { cdpEndpoint, reconnectEndpoint, scope: 'worker' },
  ];
  for (const connect of cases) {
    assert.throws(() => agentBrowser({ connect }), (error: unknown) => error instanceof ConfigurationError
      && error.code === 'INVALID_CONFIG' && /dedicated browser endpoint per attempt/.test(error.message)
      && /worker-scoped connect endpoints are unsupported/.test(error.message));
  }
  assert.equal(resolved, 0);
  assert.equal(reconnected, 0);
});

test('dedicated providers and callback endpoints are accepted without provisioning at config time', () => {
  let called = 0;
  const cdpEndpoint = async () => { called++; return 'ws://browser.example/dedicated'; };
  const reconnectEndpoint = async () => { called++; return 'ws://browser.example/recovered'; };
  const provider: BrowserProvider = {
    name: 'dedicated-provider', scope: 'attempt',
    acquire: async () => { called++; return { id: 'lease', cdpEndpoint: 'ws://browser.example/dedicated' }; },
    release: async () => { called++; },
  };
  assert.equal(agentBrowser({ browser: provider }).name, ENGINE_NAME);
  for (const connect of [
    { cdpEndpoint, scope: 'attempt' as const },
    { cdpEndpoint, reconnectEndpoint },
    { cdpEndpoint, reconnectEndpoint, scope: 'attempt' as const },
  ]) assert.equal(agentBrowser({ connect }).name, ENGINE_NAME);
  assert.equal(called, 0);
});

test('dedicated callback configuration still rejects conflicting launch options', () => {
  let called = 0;
  const connect = { scope: 'attempt' as const, cdpEndpoint: async () => { called++; return 'ws://browser.example/dedicated'; } };
  for (const options of [{ browser: 'chromium' as const }, { executablePath: '/chromium' }, { args: ['--headless'] }]) {
    assert.throws(() => agentBrowser({ connect, ...options }), { code: 'INVALID_CONFIG' });
  }
  assert.equal(called, 0);
});
