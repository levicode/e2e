import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  FixedCheckoutUsageError,
  acquireCheckoutLock,
  buildKey,
  checkoutLockFile,
  fixedCheckoutDirectory,
  fixedCheckoutStateFile,
  installKey,
  isInsideDirectory,
  nativeRuntimeReadiness,
  needsBuild,
  newestReportDirectory,
  reportDirectories,
  refCandidates,
  needsInstall,
  nodeSupported,
  packageManagerMajor,
  parseFixedCheckoutArgs,
  parseBrowserPaths,
  parseVerifyPaths,
  readCheckoutState,
  stateAfterBuild,
  stateAfterInstall,
  stateBeforeBuild,
  stateBeforeInstall,
  verificationArguments,
  verificationRuns,
  writeCheckoutState,
  type CheckoutState,
  type FixedCheckoutContext,
} from '../src/fixed-checkout.ts';

const context: FixedCheckoutContext = { env: {}, cwd: '/work/tree', home: '/home/tester' };

function state(overrides: Partial<CheckoutState> = {}): CheckoutState {
  return { schemaVersion: 1, checkout: '/home/tester/src/e2e-uat', commit: 'a'.repeat(40), installKey: 'install-a', buildKey: 'build-a', ...overrides };
}

test('defaults to the fixed checkout, origin/main, both paths, the engine launch, and a visible window', () => {
  const options = parseFixedCheckoutArgs([], context);
  assert.equal(options.checkout, path.resolve('/home/tester/src/e2e-uat'));
  assert.equal(options.ref, 'origin/main');
  assert.equal(options.commit, undefined);
  assert.deepEqual(options.paths, ['scripted', 'model']);
  assert.deepEqual(options.browsers, ['engine']);
  assert.equal(options.headless, false);
  assert.equal(options.forceInstall, false);
  assert.equal(options.forceBuild, false);
  assert.equal(options.help, false);
});

test('parses an explicit checkout, target, paths, window mode, and force flags', () => {
  const options = parseFixedCheckoutArgs(
    ['--checkout', '/tmp/fixed', '--ref', 'origin/main', '--commit', 'abc123', '--paths', 'model,scripted,model', '--browsers', 'cdp,engine,cdp', '--headless', '--remote', 'https://example.test/e2e.git', '--force-install', '--force-build'],
    context,
  );
  assert.equal(options.checkout, '/tmp/fixed');
  assert.equal(options.ref, 'origin/main');
  assert.equal(options.commit, 'abc123');
  assert.deepEqual(options.paths, ['model', 'scripted']);
  assert.deepEqual(options.browsers, ['cdp', 'engine']);
  assert.equal(options.headless, true);
  assert.equal(options.remote, 'https://example.test/e2e.git');
  assert.equal(options.forceInstall, true);
  assert.equal(options.forceBuild, true);
});

test('reads UAT_CHECKOUT_DIR and UAT_CHECKOUT_REMOTE from the environment', () => {
  const configured: FixedCheckoutContext = { ...context, env: { UAT_CHECKOUT_DIR: 'fixed/uat', UAT_CHECKOUT_REMOTE: 'https://example.test/fork.git' } };
  const options = parseFixedCheckoutArgs([], configured);
  assert.equal(options.checkout, '/work/tree/fixed/uat');
  assert.equal(options.remote, 'https://example.test/fork.git');
  assert.equal(fixedCheckoutDirectory(configured), '/work/tree/fixed/uat');
});

test('rejects unknown options, missing values, and unknown or empty path lists', () => {
  assert.throws(() => parseFixedCheckoutArgs(['--nope'], context), FixedCheckoutUsageError);
  assert.throws(() => parseFixedCheckoutArgs(['--checkout'], context), FixedCheckoutUsageError);
  assert.throws(() => parseFixedCheckoutArgs(['--checkout', '--force-build'], context), FixedCheckoutUsageError);
  assert.throws(() => parseVerifyPaths(''), /at least one/);
  assert.throws(() => parseVerifyPaths('scripted,smoke'), /unknown verification path "smoke"/);
  assert.throws(() => parseBrowserPaths(''), /at least one/);
  assert.throws(() => parseBrowserPaths('engine,playwright'), /unknown browser path "playwright"/);
});

test('expands every path on every launch, one path at a time', () => {
  assert.deepEqual(verificationRuns(['scripted', 'model'], ['engine', 'cdp']), [
    { verifyPath: 'scripted', browserPath: 'engine' },
    { verifyPath: 'scripted', browserPath: 'cdp' },
    { verifyPath: 'model', browserPath: 'engine' },
    { verifyPath: 'model', browserPath: 'cdp' },
  ]);
  assert.deepEqual(verificationRuns(['scripted'], ['cdp']), [{ verifyPath: 'scripted', browserPath: 'cdp' }]);
  assert.deepEqual(verificationArguments('/app/scripts/verify.ts', { verifyPath: 'model', browserPath: 'engine' }, false), [
    '/app/scripts/verify.ts', 'model', '--browser', 'engine',
  ]);
  assert.deepEqual(verificationArguments('/app/scripts/verify.ts', { verifyPath: 'scripted', browserPath: 'cdp' }, true), [
    '/app/scripts/verify.ts', 'scripted', '--browser', 'cdp', '--headless',
  ]);
});

test('parses help without requiring a target', () => {
  assert.equal(parseFixedCheckoutArgs(['--help'], context).help, true);
  assert.equal(parseFixedCheckoutArgs(['-h'], context).help, true);
});

test('accepts the Node versions packages/e2e supports', () => {
  for (const version of ['v22.22.3', 'v22.23.0', 'v24.8.0', 'v24.22.1', 'v25.0.0', 'v26.1.2']) {
    assert.equal(nodeSupported(version), true, version);
  }
  for (const version of ['v22.22.2', 'v22.21.0', 'v23.0.0', 'v24.7.9', 'v20.19.0', 'not-a-version']) {
    assert.equal(nodeSupported(version), false, version);
  }
});

test('reads the pnpm major from packageManager', () => {
  assert.equal(packageManagerMajor('pnpm@12.3.4'), 12);
  assert.equal(packageManagerMajor('pnpm@11.0.0'), 11);
  assert.equal(packageManagerMajor('npm@11.0.0'), undefined);
  assert.equal(packageManagerMajor('pnpm'), undefined);
});

test('a fingerprint changes when the lockfile, toolchain, or commit changes', () => {
  const base = { checkout: '/fixed', lockfileSha256: 'lock-a', packageManager: 'pnpm@12.3.4', node: 'v24.22.1', platform: 'darwin', arch: 'arm64' };
  const first = installKey(base);
  assert.equal(first, installKey({ ...base }));
  assert.notEqual(first, installKey({ ...base, lockfileSha256: 'lock-b' }));
  assert.notEqual(first, installKey({ ...base, node: 'v24.23.0' }));
  const build = buildKey('commit-a', first);
  assert.equal(build, buildKey('commit-a', first));
  assert.notEqual(build, buildKey('commit-b', first));
  assert.notEqual(build, buildKey('commit-a', installKey({ ...base, lockfileSha256: 'lock-b' })));
});

test('reuses an install and build only when the recorded fingerprints still match', () => {
  const recorded = state();
  assert.equal(needsInstall(recorded, 'install-a', true), false);
  assert.equal(needsInstall(recorded, 'install-b', true), true);
  assert.equal(needsInstall(recorded, 'install-a', false), true);
  assert.equal(needsInstall(undefined, 'install-a', true), true);
  assert.equal(needsBuild(recorded, 'build-a', true), false);
  assert.equal(needsBuild(recorded, 'build-b', true), true);
  assert.equal(needsBuild(recorded, 'build-a', false), true);
  assert.equal(needsBuild(undefined, 'build-a', true), true);
});

test('a pending install or build leaves no reusable fingerprint until it completes', () => {
  const pendingInstall = stateBeforeInstall('/fixed', 'commit-a');
  assert.equal(pendingInstall.installKey, '');
  assert.equal(pendingInstall.buildKey, '');
  assert.equal(needsInstall(pendingInstall, 'install-a', true), true);
  assert.equal(needsBuild(pendingInstall, 'build-a', true), true);

  const installed = stateAfterInstall('/fixed', 'commit-a', 'install-a');
  assert.equal(installed.installKey, 'install-a');
  assert.equal(installed.buildKey, '');
  assert.equal(needsInstall(installed, 'install-a', true), false);
  assert.equal(needsBuild(installed, 'build-a', true), true);

  const pendingBuild = stateBeforeBuild(installed, '/fixed', 'commit-a');
  assert.equal(pendingBuild.installKey, 'install-a');
  assert.equal(pendingBuild.buildKey, '');
  assert.equal(needsBuild(pendingBuild, 'build-a', true), true);

  const built = stateAfterBuild(pendingBuild, '/fixed', 'commit-a', 'install-a', 'build-a');
  assert.equal(built.installKey, 'install-a');
  assert.equal(built.buildKey, 'build-a');
  assert.equal(needsBuild(built, 'build-a', true), false);
});

test('one lock serializes fixed-checkout runs and a dead owner is replaced', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-lock-'));
  try {
    const file = checkoutLockFile(path.join(root, 'checkout-state.json'));
    assert.equal(path.dirname(file), root);
    assert.match(path.basename(file), /^fixed-checkout\.lock$/);

    const first = acquireCheckoutLock(file, '/fixed');
    assert.throws(() => acquireCheckoutLock(file, '/fixed'), /UAT_CHECKOUT_BUSY/);
    first.release();

    const second = acquireCheckoutLock(file, '/fixed');
    second.release();

    writeFileSync(file, `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, checkout: '/fixed' })}\n`);
    const stale = acquireCheckoutLock(file, '/fixed');
    stale.release();

    writeFileSync(file, '{}\n');
    const recovered = acquireCheckoutLock(file, '/fixed');
    recovered.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes a strict descendant but not an equal or unrelated directory', () => {
  assert.equal(isInsideDirectory('/fixed/uat/ticket', '/fixed/uat'), true);
  assert.equal(isInsideDirectory('/fixed/uat', '/fixed/uat'), false);
  assert.equal(isInsideDirectory('/fixed/other', '/fixed/uat'), false);
  assert.equal(isInsideDirectory('/fixed', '/fixed/uat'), false);
});

test('writes the checkout state 0600, reads it back, and ignores malformed state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-checkout-state-'));
  try {
    const file = path.join(root, 'nested', 'checkout-state.json');
    const written = { ...state(), installedAt: '2026-11-06T00:00:00.000Z', builtAt: '2026-11-06T00:01:00.000Z' };
    writeCheckoutState(file, written);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readCheckoutState(file), written);
    writeFileSync(file, '{"schemaVersion":2}\n');
    assert.equal(readCheckoutState(file), undefined);
    writeFileSync(file, 'not json');
    assert.equal(readCheckoutState(file), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('moves the state file with UAT_CHECKOUT_STATE and otherwise keeps it under the user state directory', () => {
  assert.equal(fixedCheckoutStateFile(context), path.join('/home/tester', '.local', 'state', 'e2e-uat', 'checkout-state.json'));
  assert.equal(fixedCheckoutStateFile({ ...context, env: { UAT_CHECKOUT_STATE: 'state/uat.json' } }), '/work/tree/state/uat.json');
});

test('requires an absolute existing executable for an explicit native binary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-native-check-'));
  try {
    const missing = nativeRuntimeReadiness({});
    assert.equal(missing.ready, false);
    assert.match(missing.detail, /UAT_NATIVE_MISSING/);
    assert.equal(nativeRuntimeReadiness({ E2E_AGENT_BROWSER_EXECUTABLE: '' }).ready, false);

    const executable = path.join(root, 'agent-browser');
    writeFileSync(executable, '');
    chmodSync(executable, 0o755);
    assert.equal(nativeRuntimeReadiness({ E2E_AGENT_BROWSER_EXECUTABLE: executable }).ready, true);
    assert.equal(nativeRuntimeReadiness({ AGENT_BROWSER_EXECUTABLE: executable }).ready, true);
    assert.equal(nativeRuntimeReadiness({ E2E_AGENT_BROWSER_EXECUTABLE: 'relative/agent-browser' }).ready, false);
    assert.equal(nativeRuntimeReadiness({ E2E_AGENT_BROWSER_EXECUTABLE: path.join(root, 'absent') }).ready, false);
    assert.equal(nativeRuntimeReadiness({ E2E_AGENT_BROWSER_EXECUTABLE: root }).ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prefers the fetched remote ref over a stale local branch', () => {
  assert.deepEqual(refCandidates('origin/main'), ['origin/main']);
  assert.deepEqual(refCandidates('refs/tags/v1'), ['refs/tags/v1']);
  assert.deepEqual(refCandidates('main'), ['origin/main', 'main']);
  assert.deepEqual(refCandidates('agent/feature'), ['origin/agent/feature', 'agent/feature']);
});

test('finds only the report directory a run added', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-reports-'));
  try {
    assert.equal(reportDirectories(root).size, 0);
    mkdirSync(path.join(root, '2026-11-06T08-00-00-000Z'));
    mkdirSync(path.join(root, '2026-11-06T08-00-01-000Z'));
    const before = new Set(['2026-11-06T08-00-00-000Z']);
    assert.equal(newestReportDirectory(before, root), '2026-11-06T08-00-01-000Z');
    mkdirSync(path.join(root, '2026-11-06T08-00-02-000Z'));
    assert.equal(newestReportDirectory(before, root), '2026-11-06T08-00-02-000Z');
    assert.equal(newestReportDirectory(reportDirectories(root), root), undefined);
    assert.equal(newestReportDirectory(new Set(), path.join(root, 'absent')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the state file never carries a secret value', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-checkout-state-'));
  try {
    const file = path.join(root, 'checkout-state.json');
    writeCheckoutState(file, state());
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('session'), false);
    assert.equal(text.includes('apiKey'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
