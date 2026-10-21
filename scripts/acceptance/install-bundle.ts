import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBundleFromArgs } from '../../packages/web/src/native/bundle-install.ts';
export { installBundle } from '../../packages/web/src/native/bundle-install.ts';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await installBundleFromArgs(process.argv.slice(2));
