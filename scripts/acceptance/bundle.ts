import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
}
export interface BundleFile { path: string; sha256: string }
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Integrity only. Caller must establish origin, e.g. trusted artifact ID and server digest. */
export function verifyBundle(root: string, expectedManifestHash: string): BundleManifest {
  const manifestBytes = readFileSync(resolve(root, 'manifest.json'));
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash) || sha256(manifestBytes) !== expectedManifestHash) throw new Error('Bundle manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as BundleManifest;
  if (manifest.schemaVersion !== 1 || !manifest.protocol || manifest.platform !== process.platform || manifest.architecture !== process.arch) throw new Error('Unsupported bundle protocol or platform');
  for (const source of [manifest.source, manifest.nativeSource]) if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{40}$/.test(source.tree)) throw new Error('Bundle requires exact source identities');
  for (const file of [manifest.packages?.core, manifest.packages?.web, manifest.packages?.mobile, manifest.native, manifest.producer, manifest.negotiation]) {
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Missing bundle member hash');
    const path = containedFile(root, file.path);
    if (sha256(readFileSync(path)) !== file.sha256) throw new Error(`Bundle member digest mismatch: ${file.path}`);
  }
  const producer = JSON.parse(readFileSync(containedFile(root, manifest.producer.path), 'utf8')) as { source?: { commit?: string; tree?: string }; binary?: { sha256?: string }; producer?: { platform?: string; architecture?: string } };
  if (producer.source?.commit !== manifest.nativeSource.commit || producer.source?.tree !== manifest.nativeSource.tree || producer.binary?.sha256 !== manifest.native.sha256 || producer.producer?.platform !== manifest.platform || producer.producer?.architecture !== manifest.architecture) throw new Error('Native producer and bundle tuple disagree');
  const probe = JSON.parse(readFileSync(containedFile(root, manifest.negotiation.path), 'utf8')) as { status?: string; binarySha256?: string; cleanupConfirmed?: boolean; scopeExercisePassed?: boolean; negotiation?: { protocol?: string; capabilities?: unknown[] } };
  if (probe.status !== 'passed' || !probe.scopeExercisePassed || probe.binarySha256 !== manifest.native.sha256 || !probe.cleanupConfirmed || probe.negotiation?.protocol !== manifest.protocol || !probe.negotiation.capabilities?.length) throw new Error('Bundle handshake identity is missing or inconsistent');
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
