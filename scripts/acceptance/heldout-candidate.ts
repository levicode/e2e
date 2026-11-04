/** No model calls: bind installed bytes and negotiate the actual verified native process. */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NativeClient } from '../../packages/web/src/native/client.ts';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { assertProductionCapabilities, containedFile, sha256, verifyInstalledBundle, type PackageInventory } from './bundle.ts';
import type { connectNativeProcess } from '../../packages/web/src/native/process.ts';

export interface HeldoutCandidateOptions {
  bundle: string; expectedManifestHash: string; installedCoreEntry: string; installedWebEntry: string; nativeExecutable: string;
}
export async function verifyHeldoutCandidate(options: HeldoutCandidateOptions) {
  const coreEntry = localEntry(options.installedCoreEntry); const webEntry = localEntry(options.installedWebEntry);
  const core = packageRoot(coreEntry, 'e2e'); const web = packageRoot(webEntry, '@e2e-dev/web');
  const coreRequire = createRequire(join(core, 'package.json')); const webRequire = createRequire(join(web, 'package.json'));
  if (realpathSync(coreRequire.resolve('e2e/runner')) !== coreEntry || realpathSync(webRequire.resolve('@e2e-dev/web')) !== webEntry || packageRoot(realpathSync(webRequire.resolve('e2e/engine')), 'e2e') !== core) throw new Error('Installed candidate entry graph mismatch');
  const manifest = verifyInstalledBundle(options.bundle, options.expectedManifestHash, { core, web });
  const executable = realpathSync(options.nativeExecutable);
  if (executable !== containedFile(options.bundle, manifest.native.path) || sha256(readFileSync(executable)) !== manifest.native.sha256) throw new Error('Selected native executable differs from the verified candidate');
  const contract: unknown = await import(pathToFileURL(containedFile(web, 'dist/native/capabilities.js')).href);
  if (!contract || typeof contract !== 'object' || !('REQUIRED_CAPABILITIES' in contract) || !Array.isArray(contract.REQUIRED_CAPABILITIES)) throw new Error('Installed Web mandatory capability contract is missing');
  const required = contract.REQUIRED_CAPABILITIES;
  if (required.length !== REQUIRED_CAPABILITIES.length || !REQUIRED_CAPABILITIES.every(capability => required.includes(capability))) throw new Error('Installed Web mandatory capability contract differs from the reviewed candidate');
  // Import the already-verified production transport, not a separate probe or acceptance-only client.
  const module: unknown = await import(pathToFileURL(containedFile(web, 'dist/native/process.js')).href);
  if (!module || typeof module !== 'object' || !('connectNativeProcess' in module) || typeof module.connectNativeProcess !== 'function') throw new Error('Candidate production native transport is missing');
  const connect = module.connectNativeProcess as typeof connectNativeProcess;
  const operation = { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000, runId: 'heldout-preflight', attemptId: 'heldout-preflight', origin: 'test' as const };
  let client: NativeClient | undefined;
  let proof: ReturnType<NativeClient['negotiation']> | undefined;
  try {
    client = await connect({ executable, cwd: web, env: { ...process.env }, capabilities: REQUIRED_CAPABILITIES }, operation, () => {});
    proof = client.negotiation();
    assertProductionCapabilities(proof.capabilities);
    if (proof.protocol !== manifest.protocol || !REQUIRED_CAPABILITIES.every(capability => proof!.capabilities.includes(capability))) throw new Error('Candidate does not implement the full Web capability contract');
  } finally {
    // A returned client must close normally before readiness. Failed-start transport disposal
    // is owned by connectNativeProcess and never produces a verified proof here.
    if (client) await client.close({ ...operation, signal: AbortSignal.timeout(5_000), timeoutMs: 5_000 });
  }
  if (!proof) throw new Error('Candidate negotiation did not complete');
  // Recheck after executing the probe before publishing an acceptance binding.
  verifyInstalledBundle(options.bundle, options.expectedManifestHash, { core, web });
  return { status: 'verified' as const, manifestHash: options.expectedManifestHash, nativeSha256: manifest.native.sha256, source: manifest.source, protocol: proof.protocol, capabilities: [...proof.capabilities], installed: {
    core: { entry: options.installedCoreEntry, inventorySha256: inventoryHash(manifest.installation!.packages.core) },
    web: { entry: options.installedWebEntry, inventorySha256: inventoryHash(manifest.installation!.packages.web) },
  } };
}
function localEntry(entry: string): string { const url = new URL(entry); if (url.protocol !== 'file:' || url.search || url.hash) throw new Error('Candidate entry must be a local file URL'); return realpathSync(fileURLToPath(url)); }
function packageRoot(entry: string, name: string): string {
  let directory = dirname(entry);
  for (;;) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (value && typeof value === 'object' && 'name' in value && value.name === name) return realpathSync(directory);
    } catch { /* Resolve the package boundary, then verify its entire inventory. */ }
    const parent = dirname(directory); if (parent === directory) throw new Error('Candidate package root missing'); directory = parent;
  }
}
function inventoryHash(inventory: PackageInventory): string { return sha256(Buffer.from(JSON.stringify({ name: inventory.name, version: inventory.version, files: inventory.files.toSorted((a, b) => a.path.localeCompare(b.path)) }))); }
