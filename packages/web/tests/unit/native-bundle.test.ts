import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, verifyBundle, verifyInstalledBundle, verifyRuntimeDescriptor, type BundleManifest, type PackageInventory, type RuntimeDescriptor } from '../../src/native/bundle.ts';
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'web-bundle-')); temporary.push(root);
  const member = (path: string, value: unknown) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); writeFileSync(join(root, path), bytes); return { path, sha256: sha256(bytes) }; };
  const binary = member('native', 'synthetic-not-executable');
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const inventory = (directory: string, name: string): PackageInventory => {
    mkdirSync(join(root, directory));
    const entries = { 'package.json': JSON.stringify({ name, version: '1.0.0' }), 'index.js': 'export const fixture = true;' };
    const files = Object.entries(entries).map(([path, bytes]) => { writeFileSync(join(root, directory, path), bytes); return { path, sha256: sha256(Buffer.from(bytes)) }; });
    return { name, version: '1.0.0', files };
  };
  const core = inventory('core', 'e2e'); const web = inventory('web', '@e2e-dev/web');
  const manifest: BundleManifest = { schemaVersion: 1, source, nativeSource: source, platform: process.platform, architecture: process.arch, protocol: 'fixture/1', packages: { core: binary, web: binary, mobile: binary }, native: binary,
    producer: member('producer.json', { source, binary: { sha256: binary.sha256 }, producer: { platform: process.platform, architecture: process.arch } }),
    negotiation: member('negotiation.json', { status: 'passed', scopeExercisePassed: true, cleanupConfirmed: true, binarySha256: binary.sha256, negotiation: { protocol: 'fixture/1', capabilities: ['fixture'] } }),
    installation: { schemaVersion: 1, packages: { core, web } } };
  const commit = () => member('manifest.json', manifest).sha256;
  const digest = commit();
  const packages = { core: join(root, 'core'), web: join(root, 'web') };
  const descriptor: RuntimeDescriptor = { schemaVersion: 1, kind: 'e2e-native-runtime', bundleRoot: root, manifestSha256: digest, platform: process.platform, architecture: process.arch, source, nativeSource: source };
  return { root, manifest, packages, descriptor, digest, commit };
}
test('default descriptor binds actual package bytes and native producer to an externally pinned manifest', () => {
  const f = fixture(); expect(verifyRuntimeDescriptor(f.descriptor, f.packages).executable).toBe(join(f.root, 'native'));
});
test.each(['index.js', 'package.json'])('rejects changed installed %s even when source metadata is unchanged', file => {
  const f = fixture(); writeFileSync(join(f.packages.web, file), 'modified'); expect(() => verifyRuntimeDescriptor(f.descriptor, f.packages)).toThrow(/content mismatch/);
});
test('rejects an additional executable file, missing member, and duplicate inventory entry', () => {
  const f = fixture(); writeFileSync(join(f.packages.core, 'injected.js'), 'unexpected'); expect(() => verifyRuntimeDescriptor(f.descriptor, f.packages)).toThrow(/file set/);
  rmSync(join(f.packages.core, 'injected.js')); rmSync(join(f.packages.core, 'index.js')); expect(() => verifyRuntimeDescriptor(f.descriptor, f.packages)).toThrow();
  f.manifest.installation!.packages.web.files.push(f.manifest.installation!.packages.web.files[0]!); expect(() => verifyInstalledBundle(f.root, f.commit(), f.packages)).toThrow();
});
test('a self-updated manifest digest file cannot replace the external pin', () => {
  const f = fixture(); f.manifest.source.commit = 'c'.repeat(40); writeFileSync(join(f.root, 'manifest.sha256'), f.commit()); expect(() => verifyRuntimeDescriptor(f.descriptor, f.packages)).toThrow(/manifest digest/);
});
test('legacy v1 evidence stays readable but is not installable', () => {
  const f = fixture(); delete f.manifest.installation; const digest = f.commit(); expect(verifyBundle(f.root, digest).schemaVersion).toBe(1); expect(() => verifyInstalledBundle(f.root, digest, f.packages)).toThrow(/installable/);
});
test('rejects platform and source descriptor mismatch', () => {
  const f = fixture(); expect(() => verifyRuntimeDescriptor({ ...f.descriptor, platform: 'different' }, f.packages)).toThrow(/descriptor/);
  expect(() => verifyRuntimeDescriptor({ ...f.descriptor, nativeSource: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) } }, f.packages)).toThrow(/tuple/);
});
test('rejects package symlinks and extra files but allows package-manager dependency directory', () => {
  const f = fixture(); mkdirSync(join(f.packages.web, 'node_modules')); writeFileSync(join(f.packages.web, 'node_modules', 'dependency'), 'manager-owned');
  expect(verifyRuntimeDescriptor(f.descriptor, f.packages).manifest.schemaVersion).toBe(1);
  symlinkSync(join(f.packages.web, 'index.js'), join(f.packages.web, 'alias.js')); expect(() => verifyRuntimeDescriptor(f.descriptor, f.packages)).toThrow(/symbolic link/);
});

test('rejects acceptance-instrumented negotiation even with valid hashes and source tuples', () => {
  const f = fixture();
  const bytes = JSON.stringify({ status: 'passed', scopeExercisePassed: true, cleanupConfirmed: true, binarySha256: f.manifest.native.sha256,
    negotiation: { protocol: f.manifest.protocol, capabilities: ['browser.observe/1', 'acceptance.faults/1'] } });
  writeFileSync(join(f.root, f.manifest.negotiation.path), bytes);
  f.manifest.negotiation.sha256 = sha256(Buffer.from(bytes));
  expect(() => verifyBundle(f.root, f.commit())).toThrow(/instrumentation is forbidden/);
});
