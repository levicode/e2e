import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const collectedFiles = new Set([
  'isolated-page-reopen.test.ts',
  'isolated-page-reopen-native-receipts.test.ts',
  'persistent-raw-reconnect.test.ts',
  'persistent-raw-reconnect-native-receipts.test.ts',
]);

/** Separate collected files; an importing wrapper and its public fixture share one directory. */
export function interopEvidenceDirectory(root: string | undefined, testPath: string | undefined, mode?: string): string {
  if (root === undefined || !path.isAbsolute(root)) throw new Error('Absolute interop evidence root required');
  // Bounded/formal recipes retain their original flat receipt layout.
  if (mode === undefined) return root;
  if (mode !== '1') throw new Error('Unknown interop evidence isolation mode');
  if (testPath === undefined || !path.isAbsolute(testPath)) throw new Error('Collected test file identity required');
  const file = path.basename(testPath);
  if (!collectedFiles.has(file)) throw new Error('Unexpected interop receipt test file');
  const directory = path.join(root, file);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'file-identity.json'), JSON.stringify({ collectedTestPath: testPath }, null, 2));
  return directory;
}
