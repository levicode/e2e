import { constants } from 'node:fs';
import { access, readdir, realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Mirrors official install.rs layouts; requires native thin Mach-O on macOS, never PATH or Rosetta. */
export async function installedChromium(cache: string, platform: NodeJS.Platform = process.platform, architecture: string = process.arch): Promise<{ executablePath: string; sha256: string }> {
  const app = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  if (platform !== 'linux' && platform !== 'darwin') throw new Error('Unsupported installed Chromium platform');
  if (platform === 'darwin' && !['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported installed Chromium architecture');
  const suffixes = platform === 'darwin' ? [app, `chrome-mac-arm64/${app}`, `chrome-mac-x64/${app}`] : ['chrome', 'chrome-linux64/chrome'];
  const root = await realpath(cache);
  const found = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^chrome-[0-9]+(?:\.[0-9]+){3}$/.test(entry.name)) continue;
    for (const suffix of suffixes) {
      const candidate = join(root, entry.name, suffix);
      let file;
      try { file = await stat(candidate); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!file.isFile()) continue;
      const resolved = await realpath(candidate);
      const path = relative(root, resolved);
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Installed Chromium escapes its owned cache');
      await access(resolved, constants.X_OK);
      if (platform === 'darwin') {
        const bytes = await readFile(resolved);
        const cpu = architecture === 'arm64' ? 0x0100000c : 0x01000007;
        // This candidate gate intentionally accepts only thin 64-bit executables, not universal binaries.
        if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu || bytes.readUInt32LE(12) !== 2) throw new Error('Installed Chromium is not a matching native Mach-O executable');
        if (suffix.startsWith('chrome-mac-') && !suffix.startsWith(`chrome-mac-${architecture}/`)) throw new Error('Installed Chromium archive architecture does not match the host');
      }
      if (found.has(resolved)) throw new Error('Duplicate official installed Chromium executable');
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
