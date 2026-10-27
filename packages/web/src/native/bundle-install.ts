/** Explicit local bundle installation. Does not download a runtime or install Chromium. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPackageRoots } from './installed-runtime.ts';
import { containedFile, verifyBundle, verifyInstalledBundle, type RuntimeDescriptor } from './bundle.ts';

export async function installBundle(root: string, expectedManifestHash: string, project: string): Promise<void> {
  const bundleRoot = realpathSync(root);
  const projectRoot = realpathSync(project);
  if (existsSync(join(projectRoot, '.e2e', 'native-runtime.json'))) throw new Error('A native runtime trust descriptor already exists');
  const manifest = verifyBundle(bundleRoot, expectedManifestHash);
  if (manifest.installation?.schemaVersion !== 1) throw new Error('Bundle has no installation inventory');
  // The digest must come from an independently trusted artifact/release source, never manifest.sha256.
  const archives = [manifest.packages.core, manifest.packages.web].map(file => `file:${containedFile(bundleRoot, file.path)}`);
  const result = spawnSync('pnpm', ['add', '--ignore-scripts', '--save-exact', ...archives], { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('Bundle package installation failed');
  const roots = await installedPackageRoots(projectRoot);
  verifyInstalledBundle(bundleRoot, expectedManifestHash, roots);
  // Artifact transports may drop the executable bit; only the verified binary is enabled.
  if (process.platform !== 'win32') chmodSync(containedFile(bundleRoot, manifest.native.path), 0o755);
  const descriptor: RuntimeDescriptor = { schemaVersion: 1, kind: 'e2e-native-runtime', bundleRoot, manifestSha256: expectedManifestHash, platform: manifest.platform, architecture: manifest.architecture, source: manifest.source, nativeSource: manifest.nativeSource };
  mkdirSync(join(projectRoot, '.e2e'), { recursive: true });
  // Refuse replacing a user's existing trust descriptor without an explicit separate action.
  writeFileSync(join(projectRoot, '.e2e', 'native-runtime.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
}

export async function installBundleFromArgs(args: readonly string[]): Promise<void> {
  const [root, digest, project, ...extra] = args;
  if (!root || !digest || !project || extra.length) throw new Error('usage: install.mjs bundle-root EXTERNALLY-TRUSTED-manifest-sha256 existing-project');
  await installBundle(root, digest, project);
}
