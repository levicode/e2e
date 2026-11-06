import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readNativeIdentity } from '../src/identity.ts';

function projectWithDescriptor(commit: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'uat-identity-'));
  mkdirSync(path.join(root, '.e2e'));
  writeFileSync(
    path.join(root, '.e2e', 'native-runtime.json'),
    `${JSON.stringify({ schemaVersion: 1, kind: 'e2e-native-runtime', source: { commit: 'a'.repeat(40) }, nativeSource: { commit } })}\n`,
  );
  return root;
}

test('an explicit executable wins over a leftover runtime descriptor', () => {
  const root = projectWithDescriptor('d'.repeat(40));
  try {
    const identity = readNativeIdentity(root, { E2E_AGENT_BROWSER_EXECUTABLE: process.execPath });
    assert.equal(identity.source, 'executable-environment');
    assert.equal(identity.version, process.version);
    assert.equal(typeof identity.sha256, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a runtime descriptor is the fallback when no executable is named', () => {
  const root = projectWithDescriptor('d'.repeat(40));
  try {
    assert.deepEqual(readNativeIdentity(root, {}), { source: 'runtime-descriptor', commit: 'd'.repeat(40), coreCommit: 'a'.repeat(40) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid explicit executable is not replaced by a descriptor', () => {
  const root = projectWithDescriptor('d'.repeat(40));
  try {
    assert.deepEqual(readNativeIdentity(root, { E2E_AGENT_BROWSER_EXECUTABLE: 'relative/agent-browser' }), { source: 'unknown' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
