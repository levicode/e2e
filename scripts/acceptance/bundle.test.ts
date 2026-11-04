import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { containedFile, sha256, verifyBundle } from './bundle.ts';

test('bundle binds all three original packages and native producer to one manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-bundle-'));
  try {
    writeFileSync(join(root, 'member'), 'fixture');
    const member = { path: 'member', sha256: sha256(Buffer.from('fixture')) };
    const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
    const producerBytes = Buffer.from(JSON.stringify({ source, binary: { sha256: member.sha256 }, producer: { platform: process.platform, architecture: process.arch } }));
    writeFileSync(join(root, 'producer.json'), producerBytes);
    const producer = { path: 'producer.json', sha256: sha256(producerBytes) };
    const probeBytes = Buffer.from(JSON.stringify({ status: 'passed', scopeExercisePassed: true, binarySha256: member.sha256, cleanupConfirmed: true, negotiation: { protocol: 'fixture-only/1', capabilities: ['fixture'] } }));
    writeFileSync(join(root, 'negotiation.json'), probeBytes);
    const negotiation = { path: 'negotiation.json', sha256: sha256(probeBytes) };
    const manifest = { schemaVersion: 1, source, nativeSource: source, platform: process.platform, architecture: process.arch, protocol: 'fixture-only/1', packages: { core: member, web: member, mobile: member }, native: member, producer, negotiation };
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(root, 'manifest.json'), bytes);
    assert.equal(verifyBundle(root, sha256(bytes)).protocol, 'fixture-only/1');
    assert.throws(() => verifyBundle(root, '0'.repeat(64)), /manifest digest/);
    writeFileSync(join(root, 'member'), 'changed');
    assert.throws(() => verifyBundle(root, sha256(bytes)), /member digest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('bundle refuses traversal and a symlink escaping its root', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-bundle-paths-'));
  try {
    for (const path of ['../x', '/x', 'a/../../x', 'a\\x', './x']) assert.throws(() => containedFile(root, path), /Unsafe/);
    symlinkSync(tmpdir(), join(root, 'outside'));
    assert.throws(() => containedFile(root, 'outside'), /escapes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
