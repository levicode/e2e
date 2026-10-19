import test from 'node:test';
import assert from 'node:assert/strict';
import { agentBrowser, ENGINE_NAME, ENGINE_VERSION } from '../src/engine.ts';

test('separate public SPI identity advertises actual implemented capabilities', () => {
  const engine = agentBrowser();
  assert.equal(engine.spiVersion, 1);
  assert.equal(engine.name, ENGINE_NAME);
  assert.equal(engine.version, ENGINE_VERSION);
  assert.notEqual(engine.name, 'web');
  for (const capability of ['observation', 'actions', 'location', 'keyboard', 'pointer', 'state', 'artifacts', 'browser']) assert.ok(engine.capabilities.has(capability));
  assert.equal(typeof engine.artifacts?.startVideo, 'function');
  assert.equal(engine.pointerActions?.includes('doubleTap'), true);
});

test('unknown options and isolation override fail before launch', () => {
  assert.throws(() => agentBrowser({ browser: 'firefox' } as never), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ args: ['--user-data-dir=/tmp/shared'] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => agentBrowser({ viewport: { width: 0, height: 100 } }), { code: 'INVALID_CONFIG' });
});
