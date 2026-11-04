import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapArguments, consumerEnvironment } from './candidate-runtime-install.ts';
test('manager argv preserves local paths and disables hooks without shell interpolation', () => {
  for (const manager of ['npm', 'pnpm']) assert.deepEqual(bootstrapArguments(manager, ['file:/path with spaces/core.tgz', 'file:/other/web.tgz']), [manager === 'npm' ? 'install' : 'add', '--ignore-scripts', '--save-exact', 'file:/path with spaces/core.tgz', 'file:/other/web.tgz']);
  assert.throws(() => bootstrapArguments('yarn', []));
});
test('clean consumer env strips source/native/browser overrides and isolates HOME/cache', () => {
  const source = { GH_TOKEN: 'synthetic-gh', GITHUB_TOKEN: 'synthetic-github', ACTIONS_RUNTIME_TOKEN: 'synthetic-actions', PATH: '/safe/bin', E2E_AGENT_BROWSER_EXECUTABLE: '/native', E2E_CHROMIUM_EXECUTABLE: '/chrome', NODE_PATH: '/source', NODE_OPTIONS: '--import=alias', PLAYWRIGHT_BROWSERS_PATH: '/cache', AGENT_BROWSER_EXECUTABLE_PATH: '/another', CHROME_PATH: '/other' };
  const env = consumerEnvironment(source, '/owned/home');
  for (const key of Object.keys(source).filter(name => name !== 'PATH')) assert.equal(env[key], undefined);
  assert.equal(env.HOME, '/owned/home'); assert.equal(env.XDG_CACHE_HOME, '/owned/home/.cache'); assert.equal(env.PATH, '/safe/bin');
  assert.equal(source.NODE_PATH, '/source');
});
