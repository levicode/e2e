import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  cargoEnvironment,
  fileSha256,
  nativeBinaryPath,
  nativeBuildStateFile,
  nativeCheckoutDirectory,
  nativeExecutableOverride,
  nativeVerificationEnv,
  needsNativeBuild,
  readNativeBuildState,
  readNativePin,
  writeNativeBuildState,
  type NativeBuildState,
} from '../src/native-build.ts';
import type { FixedCheckoutContext } from '../src/fixed-checkout.ts';

const context: FixedCheckoutContext = { env: {}, cwd: '/work/tree', home: '/home/tester' };

function buildState(overrides: Partial<NativeBuildState> = {}): NativeBuildState {
  return { schemaVersion: 1, checkout: '/native', commit: 'a'.repeat(40), binary: '/native/cli/target/ci/agent-browser', sha256: 'f'.repeat(64), ...overrides };
}

test('reads the native pin from the e2e checkout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-pin-'));
  try {
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.github', 'native-candidate.json'), `${JSON.stringify({ schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'a'.repeat(40) })}\n`);
    assert.deepEqual(readNativePin(root), { repository: 'levicode/agent-browser', commit: 'a'.repeat(40) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a missing, malformed, or non-commit native pin', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-pin-'));
  try {
    assert.throws(() => readNativePin(root), /UAT_NATIVE_PIN_MISSING/);
    mkdirSync(path.join(root, '.github'));
    const file = path.join(root, '.github', 'native-candidate.json');
    writeFileSync(file, '{}\n');
    assert.throws(() => readNativePin(root), /UAT_NATIVE_PIN_MISSING/);
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'abc' })}\n`);
    assert.throws(() => readNativePin(root), /commit/);
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, repository: 'other/agent-browser', commit: 'a'.repeat(40) })}\n`);
    assert.throws(() => readNativePin(root), /levicode\/agent-browser/);
    writeFileSync(file, `${JSON.stringify({ repository: 'levicode/agent-browser', commit: 'a'.repeat(40) })}\n`);
    assert.throws(() => readNativePin(root), /schemaVersion/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaults the native checkout to the runner-owned state directory and its build state outside the repository', () => {
  assert.equal(nativeCheckoutDirectory(context), path.resolve('/home/tester/.local/state/e2e-uat/agent-browser'));
  assert.equal(nativeBuildStateFile(context), path.join('/home/tester', '.local', 'state', 'e2e-uat', 'native-build.json'));
  assert.equal(nativeBuildStateFile({ ...context, env: { UAT_NATIVE_BUILD_STATE: 'state/native.json' } }), '/work/tree/state/native.json');
  assert.equal(nativeBinaryPath('/native'), path.join('/native', 'cli', 'target', 'ci', 'agent-browser'));
});

test('an explicit native clone wins, with the older variable kept as an alias', () => {
  assert.equal(nativeCheckoutDirectory({ ...context, env: { UAT_NATIVE_CLONE: 'native/agent-browser' } }), '/work/tree/native/agent-browser');
  assert.equal(nativeCheckoutDirectory({ ...context, env: { UAT_AGENT_BROWSER_CHECKOUT: 'legacy/agent-browser' } }), '/work/tree/legacy/agent-browser');
  assert.equal(
    nativeCheckoutDirectory({ ...context, env: { UAT_NATIVE_CLONE: '/absolute/agent-browser', UAT_AGENT_BROWSER_CHECKOUT: 'legacy/agent-browser' } }),
    '/absolute/agent-browser',
  );
  assert.equal(nativeCheckoutDirectory({ ...context, env: { UAT_NATIVE_CLONE: '  ', UAT_AGENT_BROWSER_CHECKOUT: 'legacy/agent-browser' } }), '/work/tree/legacy/agent-browser');
  assert.equal(nativeCheckoutDirectory({ ...context, env: { UAT_NATIVE_CLONE: '', UAT_AGENT_BROWSER_CHECKOUT: '' } }), path.resolve('/home/tester/.local/state/e2e-uat/agent-browser'));
});

test('an explicit native binary wins over provisioning, including the legacy name', () => {
  assert.equal(nativeExecutableOverride({}), undefined);
  assert.equal(nativeExecutableOverride({ AGENT_BROWSER_EXECUTABLE: '/alias/agent-browser' }), '/alias/agent-browser');
  assert.equal(nativeExecutableOverride({ E2E_AGENT_BROWSER_EXECUTABLE: '/engine/agent-browser', AGENT_BROWSER_EXECUTABLE: '/alias/agent-browser' }), '/engine/agent-browser');
  assert.equal(nativeExecutableOverride({ E2E_AGENT_BROWSER_EXECUTABLE: '' }), undefined);
});

test('names the built binary for the engine and for the legacy variable', () => {
  assert.deepEqual(nativeVerificationEnv({ PATH: '/bin' }, '/native/agent-browser'), {
    PATH: '/bin',
    E2E_AGENT_BROWSER_EXECUTABLE: '/native/agent-browser',
    AGENT_BROWSER_EXECUTABLE: '/native/agent-browser',
  });
});

test('rebuilds when the pin, checkout, or binary digest changes', () => {
  const recorded = buildState();
  assert.equal(needsNativeBuild(recorded, '/native', 'a'.repeat(40), 'f'.repeat(64)), false);
  assert.equal(needsNativeBuild(recorded, '/native', 'b'.repeat(40), 'f'.repeat(64)), true);
  assert.equal(needsNativeBuild(recorded, '/other', 'a'.repeat(40), 'f'.repeat(64)), true);
  assert.equal(needsNativeBuild(recorded, '/native', 'a'.repeat(40), 'e'.repeat(64)), true);
  assert.equal(needsNativeBuild(recorded, '/native', 'a'.repeat(40), undefined), true);
  assert.equal(needsNativeBuild(undefined, '/native', 'a'.repeat(40), 'f'.repeat(64)), true);
});

test('writes and reads the native build record 0600 and ignores malformed state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-native-state-'));
  try {
    const file = path.join(root, 'nested', 'native-build.json');
    const state = { ...buildState(), builtAt: '2026-11-06T00:00:00.000Z' };
    writeNativeBuildState(file, state);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readNativeBuildState(file), state);
    writeFileSync(file, '{"schemaVersion":2}\n');
    assert.equal(readNativeBuildState(file), undefined);
    writeFileSync(file, 'not json');
    assert.equal(readNativeBuildState(file), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cargo gets one target directory and no inherited compiler or target overrides', () => {
  assert.deepEqual(
    cargoEnvironment(
      {
        PATH: '/bin',
        RUSTFLAGS: 'bad',
        CARGO_ENCODED_RUSTFLAGS: 'bad',
        RUSTC_WRAPPER: 'bad',
        RUSTC_WORKSPACE_WRAPPER: 'bad',
        CARGO_TARGET_DIR: 'bad',
        CARGO_BUILD_TARGET: 'aarch64-apple-darwin',
      },
      '/native/cli/target',
    ),
    { PATH: '/bin', CARGO_TARGET_DIR: '/native/cli/target' },
  );
});

test('hashes an existing file and reports a missing one as undefined', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-native-sha-'));
  try {
    const file = path.join(root, 'binary');
    writeFileSync(file, 'agent-browser');
    assert.equal(fileSha256(file), 'b7c8dd117a7a3868568ba9dc2d9eb43779e67d7b2b4879b3cd905da3c0c9357d');
    assert.equal(fileSha256(path.join(root, 'absent')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
