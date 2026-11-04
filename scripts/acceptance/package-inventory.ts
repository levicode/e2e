import { list } from 'tar';
import { sha256, type BundleFile, type PackageInventory } from './bundle.ts';

/** A packed identity is a real JSON string, so a truthy value is not enough. */
const identityPart = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Watch a member read from the moment it starts. A read can reject while the archive is
 * still being listed, long before this function decides to rethrow; without a handler
 * attached here that rejection surfaces as an unhandled process-level rejection.
 * `Promise.allSettled` still reports the original rejection for the final throw.
 */
const trackMember = (member: Promise<void>): Promise<void> => {
  member.catch(() => {});
  return member;
};

/** Read the actual packed bytes, not a guessed list of source/dist files. Never extract archives. */
export async function packageInventory(archive: string): Promise<PackageInventory> {
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  let metadata: { name: string; version: string } | undefined;
  let unsafe: Error | undefined;
  await list({ file: archive, onReadEntry(entry) {
    if (unsafe) { entry.resume(); return; }
    if (entry.type === 'Directory') return;
    if (entry.type !== 'File' || !entry.path.startsWith('package/')) { unsafe = new Error('Package archive contains an unsupported entry'); entry.resume(); return; }
    const path = entry.path.slice('package/'.length);
    if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) { unsafe = new Error('Package archive contains an unsafe member'); entry.resume(); return; }
    seen.add(path);
    pending.push(trackMember(new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
      entry.on('error', reject);
      entry.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks);
          files.push({ path, sha256: sha256(bytes) });
          if (path === 'package.json') {
            const value = JSON.parse(bytes.toString('utf8')) as unknown;
            if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Package archive identity is missing');
            const record = value as Record<string, unknown>;
            if (!identityPart(record['name']) || !identityPart(record['version'])) throw new Error('Package archive identity is missing');
            metadata = { name: record['name'], version: record['version'] };
          }
          resolve();
        } catch (error) { reject(error); }
      });
    })));
  } });
  // Settle every member so a rejected read never surfaces as an unhandled rejection.
  const settled = await Promise.allSettled(pending);
  if (unsafe) throw unsafe;
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  if (!metadata) throw new Error('Package archive identity is missing');
  return { name: metadata.name, version: metadata.version, files: files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}
