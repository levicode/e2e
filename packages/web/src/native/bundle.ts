import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Acceptance-instrumented binaries must never become distributable runtime evidence. */
export function assertProductionCapabilities(capabilities: readonly string[]): void {
  if (capabilities.includes('acceptance.faults/1')) throw new Error('Acceptance fault instrumentation is forbidden in production runtime bundles');
}

export interface BundleManifest {
  schemaVersion: 1;
  source: { commit: string; tree: string };
  nativeSource: { commit: string; tree: string };
  platform: string;
  architecture: string;
  /** Obtained from an actual native ready frame; not inferred from binary version. */
  protocol: string;
  packages: { core: BundleFile; web: BundleFile; mobile: BundleFile };
  native: BundleFile;
  producer: BundleFile;
  negotiation: BundleFile;
  installation?: { schemaVersion: 1; installerFiles?: BundleFile[]; packages: { core: PackageInventory; web: PackageInventory } };
}
export interface PackageInventory { name: string; version: string; files: BundleFile[] }
export interface RuntimeDescriptor {
  schemaVersion: 1; kind: 'e2e-native-runtime'; bundleRoot: string; manifestSha256: string;
  platform: string; architecture: string; source: BundleManifest['source']; nativeSource: BundleManifest['nativeSource'];
}
export interface InstalledPackageRoots { core: string; web: string }
export interface BundleFile { path: string; sha256: string }
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Integrity only. Caller must establish origin, e.g. trusted artifact ID and server digest. */
export function verifyBundle(root: string, expectedManifestHash: string): BundleManifest {
  const manifestBytes = readFileSync(resolve(root, 'manifest.json'));
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash) || sha256(manifestBytes) !== expectedManifestHash) throw new Error('Bundle manifest digest mismatch');
  const manifest = decodeManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  if (manifest.schemaVersion !== 1 || !manifest.protocol || manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error('Unsupported bundle protocol or platform');
  for (const source of [manifest.source, manifest.nativeSource]) if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{40}$/.test(source.tree)) throw new Error('Bundle requires exact source identities');
  for (const file of [manifest.packages?.core, manifest.packages?.web, manifest.packages?.mobile, manifest.native, manifest.producer, manifest.negotiation, ...(manifest.installation?.installerFiles ?? [])]) {
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Missing bundle member hash');
    const path = containedFile(root, file.path);
    if (sha256(readFileSync(path)) !== file.sha256) throw new Error(`Bundle member digest mismatch: ${file.path}`);
  }
  const producer = object(JSON.parse(readFileSync(containedFile(root, manifest.producer.path), 'utf8')) as unknown);
  const producerSource = decodeSource(producer['source']);
  const producerBinary = object(producer['binary']); const producerPlatform = object(producer['producer']);
  if (producerSource.commit !== manifest.nativeSource.commit || producerSource.tree !== manifest.nativeSource.tree || producerBinary['sha256'] !== manifest.native.sha256 || producerPlatform['platform'] !== manifest.platform || producerPlatform['architecture'] !== manifest.architecture) throw new Error('Native producer and bundle tuple disagree');
  const probe = object(JSON.parse(readFileSync(containedFile(root, manifest.negotiation.path), 'utf8')) as unknown);
  const negotiation = object(probe['negotiation']);
  if (probe['status'] !== 'passed' || probe['scopeExercisePassed'] !== true || probe['binarySha256'] !== manifest.native.sha256 || probe['cleanupConfirmed'] !== true || negotiation['protocol'] !== manifest.protocol || !Array.isArray(negotiation['capabilities']) || !negotiation['capabilities'].length || negotiation['capabilities'].some(value => typeof value !== 'string' || !value)) throw new Error('Bundle handshake identity is missing or inconsistent');
  assertProductionCapabilities(negotiation['capabilities']);
  return manifest;
}

export function containedFile(root: string, path: string): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) throw new Error('Unsafe bundle member path');
  const base = realpathSync(root);
  const absolute = realpathSync(resolve(base, path));
  const rel = relative(base, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Bundle member escapes bundle root');
  return absolute;
}

/** Reject additions as well as mutations: a package stamp alone does not bind executable code. */
export function verifyPackageInventory(root: string, inventory: PackageInventory): void {
  if (!inventory || typeof inventory.name !== 'string' || typeof inventory.version !== 'string' || !Array.isArray(inventory.files) || inventory.files.length === 0) throw new Error('Missing installed package inventory');
  const expected = new Map<string, string>();
  for (const file of inventory.files) {
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || expected.has(file.path)) throw new Error('Invalid installed package inventory');
    const resolved = containedFile(root, file.path);
    if (!lstatSync(resolved).isFile() || sha256(readFileSync(resolved)) !== file.sha256) throw new Error('Installed package content mismatch');
    expected.set(file.path, file.sha256);
  }
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      // Dependency links are package-manager-owned, not published package contents.
      if (!prefix && name === 'node_modules') continue;
      const member = prefix ? `${prefix}/${name}` : name;
      const absolute = resolve(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Published package contains a symbolic link');
      if (stat.isDirectory()) visit(absolute, member);
      else if (stat.isFile()) found.push(member);
      else throw new Error('Published package contains a nonregular file');
    }
  };
  visit(realpathSync(root), '');
  if (found.length !== expected.size || found.some(file => !expected.has(file))) throw new Error('Installed package file set mismatch');
  const metadata = object(JSON.parse(readFileSync(containedFile(root, 'package.json'), 'utf8')) as unknown);
  if (metadata['name'] !== inventory.name || metadata['version'] !== inventory.version) throw new Error('Installed package identity mismatch');
}

export function verifyInstalledBundle(root: string, expectedManifestHash: string, packages: InstalledPackageRoots): BundleManifest {
  const manifest = verifyBundle(root, expectedManifestHash);
  const installation = manifest.installation;
  if (installation?.schemaVersion !== 1 || installation.packages?.core?.name !== 'e2e' || installation.packages?.web?.name !== '@e2e-dev/web') throw new Error('Bundle has no installable package inventory');
  verifyPackageInventory(packages.core, installation.packages.core);
  verifyPackageInventory(packages.web, installation.packages.web);
  return manifest;
}

export function verifyRuntimeDescriptor(value: unknown, packages: InstalledPackageRoots): { manifest: BundleManifest; executable: string } {
  const descriptor = decodeDescriptor(value);
  if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.kind !== 'e2e-native-runtime' || typeof descriptor.bundleRoot !== 'string' || !isAbsolute(descriptor.bundleRoot) || descriptor.platform !== process.platform || descriptor.architecture !== process.arch) throw new Error('Invalid native runtime descriptor');
  const manifest = verifyInstalledBundle(descriptor.bundleRoot, descriptor.manifestSha256, packages);
  for (const key of ['source', 'nativeSource'] as const) {
    if (descriptor[key]?.commit !== manifest[key].commit || descriptor[key]?.tree !== manifest[key].tree) throw new Error('Native runtime source tuple mismatch');
  }
  return { manifest, executable: containedFile(descriptor.bundleRoot, manifest.native.path) };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid bundle object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Invalid bundle string'); return value; }
function decodeSource(value: unknown): BundleManifest['source'] { const v = object(value); return { commit: string(v['commit']), tree: string(v['tree']) }; }
function decodeFile(value: unknown): BundleFile { const v = object(value); return { path: string(v['path']), sha256: string(v['sha256']) }; }
function decodeInventory(value: unknown): PackageInventory {
  const v = object(value); if (!Array.isArray(v['files'])) throw new Error('Invalid package inventory');
  return { name: string(v['name']), version: string(v['version']), files: v['files'].map(decodeFile) };
}
function decodeManifest(value: unknown): BundleManifest {
  const v = object(value); if (v['schemaVersion'] !== 1) throw new Error('Unsupported bundle schema');
  const packages = object(v['packages']);
  const manifest: BundleManifest = { schemaVersion: 1, source: decodeSource(v['source']), nativeSource: decodeSource(v['nativeSource']), platform: string(v['platform']), architecture: string(v['architecture']), protocol: string(v['protocol']), packages: { core: decodeFile(packages['core']), web: decodeFile(packages['web']), mobile: decodeFile(packages['mobile']) }, native: decodeFile(v['native']), producer: decodeFile(v['producer']), negotiation: decodeFile(v['negotiation']) };
  if (v['installation'] !== undefined) {
    const installation = object(v['installation']); const p = object(installation['packages']);
    if (installation['schemaVersion'] !== 1) throw new Error('Unsupported installation schema');
    manifest.installation = { schemaVersion: 1, packages: { core: decodeInventory(p['core']), web: decodeInventory(p['web']) } };
    if (installation['installerFiles'] !== undefined) {
      if (!Array.isArray(installation['installerFiles'])) throw new Error('Invalid installer inventory');
      manifest.installation.installerFiles = installation['installerFiles'].map(decodeFile);
    }
  }
  return manifest;
}
function decodeDescriptor(value: unknown): RuntimeDescriptor {
  const v = object(value);
  if (v['schemaVersion'] !== 1 || v['kind'] !== 'e2e-native-runtime') throw new Error('Invalid native runtime descriptor');
  return { schemaVersion: 1, kind: 'e2e-native-runtime', bundleRoot: string(v['bundleRoot']), manifestSha256: string(v['manifestSha256']), platform: string(v['platform']), architecture: string(v['architecture']), source: decodeSource(v['source']), nativeSource: decodeSource(v['nativeSource']) };
}
