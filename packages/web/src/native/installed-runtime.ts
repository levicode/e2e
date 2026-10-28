import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { verifyRuntimeDescriptor, type InstalledPackageRoots } from './bundle.ts';

export async function installedPackageRoots(projectRoot: string): Promise<InstalledPackageRoots> {
  const require = createRequire(path.join(path.resolve(projectRoot), 'package.json'));
  const root = async (name: string, resolveFrom = require, entry = name): Promise<string> => {
    let directory = path.dirname(await realpath(resolveFrom.resolve(entry)));
    for (;;) {
      try {
        const metadata: unknown = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata !== null && typeof metadata === 'object' && 'name' in metadata && metadata.name === name) return directory;
      } catch { /* Keep walking to the actual published package root. */ }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('Installed package root not found');
      directory = parent;
    }
  };
  const core = await root('e2e'); const web = await root('@e2e-dev/web');
  const importedCore = await root('e2e', createRequire(path.join(web, 'package.json')), 'e2e/engine');
  if (core !== importedCore) throw new Error('Web imports a different core package installation');
  return { core, web };
}

export async function resolveInstalledRuntime(projectRoot: string): Promise<string> {
  const descriptor: unknown = JSON.parse(await readFile(path.join(projectRoot, '.e2e', 'native-runtime.json'), 'utf8'));
  const roots = await installedPackageRoots(projectRoot);
  // Never verify a different Web installation from the one executing this resolver.
  const executingRoot = await realpath(path.resolve(import.meta.dirname, '../..'));
  if (roots.web !== executingRoot) throw new Error('Executing Web package is not the verified installation');
  const { executable } = verifyRuntimeDescriptor(descriptor, roots);
  await access(executable, constants.X_OK);
  return executable;
}
