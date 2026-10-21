import { constants } from 'node:fs';
import { access, readdir, realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Mirrors Linux official install.rs chrome_binary_in_dir; never searches PATH. */
export async function installedChromium(cache: string): Promise<{ executablePath: string; sha256: string }> {
  const root = await realpath(cache);
  const found = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^chrome-[0-9]+(?:\.[0-9]+){3}$/.test(entry.name)) continue;
    for (const suffix of ['chrome', 'chrome-linux64/chrome']) {
      const candidate = join(root, entry.name, suffix);
      let file;
      try { file = await stat(candidate); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!file.isFile()) continue;
      const resolved = await realpath(candidate);
      const path = relative(root, resolved);
      if (path.startsWith('..') || isAbsolute(path)) throw new Error('Installed Chromium escapes its owned cache');
      await access(resolved, constants.X_OK);
      found.add(resolved);
    }
  }
  if (found.size !== 1) throw new Error('Expected exactly one official installed Chromium executable');
  const executablePath = [...found][0]!;
  return { executablePath, sha256: createHash('sha256').update(await readFile(executablePath)).digest('hex') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cache, report] = process.argv.slice(2);
  if (!cache || !report) throw new Error('Usage: installed-chromium.ts <owned-cache> <report>');
  const result = await installedChromium(cache);
  await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(result.executablePath);
}
