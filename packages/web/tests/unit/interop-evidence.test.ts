import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { interopEvidenceDirectory } from '../helpers/interop-evidence.ts';

const files = [
  'isolated-page-reopen.test.ts',
  'isolated-page-reopen-native-receipts.test.ts',
  'persistent-raw-reconnect.test.ts',
  'persistent-raw-reconnect-native-receipts.test.ts',
];
const collected = (file: string) => path.resolve('tests/integration', file);
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'interop-evidence-unit-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('collected-file interop receipt ownership', () => {
  it('preserves the original flat receipt layout by default without collected-file identity', () => {
    expect(interopEvidenceDirectory(root, undefined)).toBe(root);
    const file = collected('isolated-page-reopen-native-receipts.test.ts');
    expect(interopEvidenceDirectory(root, file)).toBe(root);
    writeFileSync(path.join(root, 'isolated-page-reopen-owned.json'), JSON.stringify({ owner: 'original-flat' }));
    expect(JSON.parse(readFileSync(path.join(interopEvidenceDirectory(root, file), 'isolated-page-reopen-owned.json'), 'utf8'))).toEqual({ owner: 'original-flat' });
    expect(existsSync(path.join(root, 'file-identity.json'))).toBe(false);
    expect(existsSync(path.join(root, path.basename(file)))).toBe(false);
  });
  it.each(['', '0', 'true', '2'])('refuses unknown isolation mode %s instead of choosing a layout', mode => {
    expect(() => interopEvidenceDirectory(root, collected(files[0]!), mode)).toThrow('Unknown interop evidence isolation mode');
  });

  it('keeps a wrapper and its imported public fixture in the same directory', () => {
    const file = collected('isolated-page-reopen-native-receipts.test.ts');
    const publicDirectory = interopEvidenceDirectory(root, file, '1');
    const nativeDirectory = interopEvidenceDirectory(root, file, '1');
    expect(nativeDirectory).toBe(publicDirectory);
    writeFileSync(path.join(publicDirectory, 'receipt.json'), JSON.stringify({ owner: file }));
    expect(JSON.parse(readFileSync(path.join(nativeDirectory, 'receipt.json'), 'utf8'))).toEqual({ owner: file });
  });

  it('keeps all four collected files disjoint without overwriting same-named receipts', () => {
    const directories = files.map(file => interopEvidenceDirectory(root, collected(file), '1'));
    expect(new Set(directories).size).toBe(files.length);
    for (const [index, directory] of directories.entries()) {
      writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ owner: files[index] }));
    }
    for (const [index, directory] of directories.entries()) {
      expect(JSON.parse(readFileSync(path.join(directory, 'receipt.json'), 'utf8'))).toEqual({ owner: files[index] });
    }
  });

  it('records only file identity and never mutates the process environment', () => {
    const environment = { ...process.env };
    const file = collected(files[0]!);
    const directory = interopEvidenceDirectory(root, file, '1');
    expect(JSON.parse(readFileSync(path.join(directory, 'file-identity.json'), 'utf8'))).toEqual({ collectedTestPath: file });
    expect(process.env).toEqual(environment);
  });

  it.each([undefined, 'relative-root'])('rejects missing or nonabsolute root %s', invalidRoot => {
    expect(() => interopEvidenceDirectory(invalidRoot, collected(files[0]!), '1')).toThrow('Absolute interop evidence root required');
  });
  it.each([undefined, 'relative.test.ts'])('rejects missing or nonabsolute collected identity %s', invalidFile => {
    expect(() => interopEvidenceDirectory(root, invalidFile, '1')).toThrow('Collected test file identity required');
  });
  it('rejects unknown collected files instead of falling back to a shared directory', () => {
    expect(() => interopEvidenceDirectory(root, collected('unknown.test.ts'), '1')).toThrow('Unexpected interop receipt test file');
  });
});
