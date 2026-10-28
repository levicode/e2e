import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, type BundleManifest, type PackageInventory, type RuntimeDescriptor } from '../../src/native/bundle.ts';
import { installBundle, installBundleFromArgs } from '../../src/native/bundle-install.ts';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), roots: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('../../src/native/installed-runtime.ts', () => ({ installedPackageRoots: mocks.roots }));
beforeEach(() => { mocks.spawn.mockReset().mockReturnValue({ status: 0 }); mocks.roots.mockReset(); });
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
  const manifest: BundleManifest = { schemaVersion: 1, source, nativeSource: source, platform: process.platform, architecture: process.arch, protocol: 'fixture/1', packages: { core: member('core.tgz', 'synthetic-core-archive'), web: member('web.tgz', 'synthetic-web-archive'), mobile: binary }, native: binary,
    producer: member('producer.json', { source, binary: { sha256: binary.sha256 }, producer: { platform: process.platform, architecture: process.arch } }),
    negotiation: member('negotiation.json', { status: 'passed', scopeExercisePassed: true, cleanupConfirmed: true, binarySha256: binary.sha256, negotiation: { protocol: 'fixture/1', capabilities: ['fixture'] } }),
    installation: { schemaVersion: 1, packages: { core, web } } };
  const commit = () => member('manifest.json', manifest).sha256;
  const digest = commit();
  const packages = { core: join(root, 'core'), web: join(root, 'web') };
  const descriptor: RuntimeDescriptor = { schemaVersion: 1, kind: 'e2e-native-runtime', bundleRoot: root, manifestSha256: digest, platform: process.platform, architecture: process.arch, source, nativeSource: source };
  return { root, manifest, packages, descriptor, digest, commit };
}

function prepared() {
  const f = fixture(); const project = join(f.root, 'project with spaces'); mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  mocks.roots.mockResolvedValue(f.packages);
  return { ...f, project, descriptorPath: join(project, '.e2e', 'native-runtime.json') };
}
test.each(['npm', 'pnpm'] as const)('uses exact %s argv and verifies bytes before writing the descriptor', async manager => {
  const f = prepared();
  mocks.spawn.mockImplementation(() => { expect(existsSync(f.descriptorPath)).toBe(false); return { status: 0 }; });
  mocks.roots.mockImplementation(async () => { expect(existsSync(f.descriptorPath)).toBe(false); return f.packages; });
  await installBundle(f.root, f.digest, f.project, manager);
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(manager, [manager === 'npm' ? 'install' : 'add', '--ignore-scripts', '--save-exact', `file:${join(f.root, 'core.tgz')}`, `file:${join(f.root, 'web.tgz')}`], { cwd: f.project, stdio: 'inherit', shell: false });
  expect(JSON.parse(readFileSync(f.descriptorPath, 'utf8'))).toMatchObject({ bundleRoot: f.root, manifestSha256: f.digest });
});
test('legacy explicit bundle installer retains pnpm default', async () => {
  const f = prepared(); await installBundleFromArgs([f.root, f.digest, f.project]); expect(mocks.spawn.mock.calls[0]![0]).toBe('pnpm');
});
test.each(['digest', 'platform', 'inventory', 'descriptor'] as const)('rejects %s before package side effects', async mode => {
  const f = prepared(); let digest = f.digest;
  if (mode === 'digest') digest = '0'.repeat(64);
  if (mode === 'platform') { f.manifest.platform = 'unsupported'; digest = f.commit(); }
  if (mode === 'inventory') { delete f.manifest.installation; digest = f.commit(); }
  if (mode === 'descriptor') { mkdirSync(join(f.project, '.e2e')); writeFileSync(f.descriptorPath, 'existing user trust'); }
  await expect(installBundle(f.root, digest, f.project, 'npm')).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled(); expect(mocks.roots).not.toHaveBeenCalled();
  if (mode === 'descriptor') expect(readFileSync(f.descriptorPath, 'utf8')).toBe('existing user trust');
  else expect(existsSync(f.descriptorPath)).toBe(false);
});
test.each(['exit', 'spawn', 'foreign-core', 'changed-inventory', 'race'] as const)('does not write trust after %s failure', async mode => {
  const f = prepared();
  if (mode === 'exit') mocks.spawn.mockReturnValue({ status: 1 });
  if (mode === 'spawn') mocks.spawn.mockReturnValue({ error: new Error('ENOENT'), status: null });
  if (mode === 'foreign-core') mocks.roots.mockRejectedValue(new Error('Web imports a different core package installation'));
  if (mode === 'changed-inventory') writeFileSync(join(f.packages.web, 'index.js'), 'modified');
  if (mode === 'race') mocks.roots.mockImplementation(async () => { mkdirSync(join(f.project, '.e2e')); writeFileSync(f.descriptorPath, 'concurrent user trust'); return f.packages; });
  await expect(installBundle(f.root, f.digest, f.project, 'npm')).rejects.toThrow();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  if (mode === 'race') expect(readFileSync(f.descriptorPath, 'utf8')).toBe('concurrent user trust');
  else expect(existsSync(f.descriptorPath)).toBe(false);
});

test.each(['invalid', 'non-object', 'dangling-descriptor'] as const)('rejects %s project state before spawn', async mode => {
  const f = prepared();
  if (mode === 'invalid') writeFileSync(join(f.project, 'package.json'), '{');
  if (mode === 'non-object') writeFileSync(join(f.project, 'package.json'), 'null');
  if (mode === 'dangling-descriptor') { mkdirSync(join(f.project, '.e2e')); symlinkSync(join(f.root, 'absent'), f.descriptorPath); }
  await expect(installBundle(f.root, f.digest, f.project, 'npm')).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test('legacy install.mjs retains empty existing directory bootstrap', async () => {
  const f = prepared(); rmSync(join(f.project, 'package.json'));
  await installBundleFromArgs([f.root, f.digest, f.project]);
  expect(mocks.spawn.mock.calls[0]![0]).toBe('pnpm');
  expect(existsSync(f.descriptorPath)).toBe(true);
});

test.each(['symlink', 'file'] as const)('rejects existing %s trust parent before package spawn', async mode => {
  const f = prepared(); const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'marker'), 'unchanged');
  if (mode === 'symlink') symlinkSync(outside, join(f.project, '.e2e'), 'dir');
  else writeFileSync(join(f.project, '.e2e'), 'not a directory');
  await expect(installBundle(f.root, f.digest, f.project, 'npm')).rejects.toThrow(/trust directory/);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(existsSync(join(outside, 'native-runtime.json'))).toBe(false);
  expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('unchanged');
});
test.each(['symlink', 'file'] as const)('rejects %s trust parent substituted by package installation', async mode => {
  const f = prepared(); const outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'marker'), 'unchanged');
  mkdirSync(join(f.project, '.e2e'));
  mocks.spawn.mockImplementation(() => {
    rmSync(join(f.project, '.e2e'), { recursive: true });
    if (mode === 'symlink') symlinkSync(outside, join(f.project, '.e2e'), 'dir');
    else writeFileSync(join(f.project, '.e2e'), 'not a directory');
    return { status: 0 };
  });
  await expect(installBundle(f.root, f.digest, f.project, 'npm')).rejects.toThrow(/trust directory/);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(existsSync(join(outside, 'native-runtime.json'))).toBe(false);
  expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('unchanged');
});
