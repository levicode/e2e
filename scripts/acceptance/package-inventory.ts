import { list } from 'tar';
import { sha256, type BundleFile, type PackageInventory } from './bundle.ts';

/** Read the actual packed bytes, not a guessed list of source/dist files. Never extract archives. */
export async function packageInventory(archive: string): Promise<PackageInventory> {
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  const pending: Promise<void>[] = [];
  let metadata: { name?: string; version?: string } | undefined;
  await list({ file: archive, onReadEntry(entry) {
    if (entry.type === 'Directory') return;
    if (entry.type !== 'File' || !entry.path.startsWith('package/')) throw new Error('Package archive contains an unsupported entry');
    const path = entry.path.slice('package/'.length);
    if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) throw new Error('Package archive contains an unsafe member');
    seen.add(path);
    pending.push(new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
      entry.on('error', reject);
      entry.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks);
          files.push({ path, sha256: sha256(bytes) });
          if (path === 'package.json') metadata = JSON.parse(bytes.toString('utf8')) as typeof metadata;
          resolve();
        } catch (error) { reject(error); }
      });
    }));
  } });
  await Promise.all(pending);
  if (!metadata?.name || !metadata.version) throw new Error('Package archive identity is missing');
  return { name: metadata.name, version: metadata.version, files: files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}
