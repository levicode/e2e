import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, type BundleFile } from './bundle.ts';

/** Copy the compiled, shared verifier/installer; no source checkout is needed by consumers. */
export function writeBundleInstaller(output: string, webRoot: string): BundleFile[] {
  mkdirSync(join(output, 'installer'));
  const paths: string[] = [];
  for (const name of ['bundle', 'installed-runtime', 'bundle-install']) {
    const path = `installer/${name}.js`;
    copyFileSync(join(webRoot, 'dist/native', `${name}.js`), join(output, path)); paths.push(path);
  }
  writeFileSync(join(output, 'installer/package.json'), '{"type":"module"}\n');
  writeFileSync(join(output, 'install.mjs'), "import { installBundleFromArgs } from './installer/bundle-install.js';\nawait installBundleFromArgs(process.argv.slice(2));\n");
  paths.push('installer/package.json', 'install.mjs');
  return paths.map(path => ({ path, sha256: sha256(readFileSync(join(output, path))) }));
}
