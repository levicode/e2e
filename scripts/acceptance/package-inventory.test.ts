import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { create } from 'tar';
import { packageInventory } from './package-inventory.ts';
import { sha256, type PackageInventory } from './bundle.ts';

const identity = (name: unknown, version: unknown): string => JSON.stringify({ name, version });

/** Pack synthetic bytes in this test's scratch directory; never extract an archive. */
async function writeArchive(
  root: string,
  members: Record<string, string | Uint8Array>,
  options: { symlinks?: Record<string, string>; entries?: string[]; prefix?: string; rootMembers?: Record<string, string> } = {},
): Promise<string> {
  const stage = join(root, 'stage');
  const directory = join(stage, 'package');
  mkdirSync(directory, { recursive: true });
  for (const [path, content] of Object.entries(options.rootMembers ?? {})) writeFileSync(join(stage, path), content);
  for (const [path, content] of Object.entries(members)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const [path, target] of Object.entries(options.symlinks ?? {})) symlinkSync(target, join(directory, path));
  const file = join(root, 'package.tgz');
  await create({ gzip: true, file, cwd: stage, ...(options.prefix ? { prefix: options.prefix } : {}) }, options.entries ?? ['package']);
  return file;
}

async function withInventory(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'package-inventory-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads a scoped package identity and hashes the actual packed bytes in path order', async () => {
  await withInventory(async (root) => {
    const members = {
      'package.json': identity('@e2e-dev/web', '1.0.0'),
      'a.js': 'export const a = 1;\n',
      'dist/b.js': 'export const b = 2;\n',
      'dist/a.js': 'export const a = 3;\n',
    };
    const inventory = await packageInventory(await writeArchive(root, members));
    const expected: PackageInventory = {
      name: '@e2e-dev/web',
      version: '1.0.0',
      files: Object.entries(members)
        .map(([path, content]) => ({ path, sha256: sha256(Buffer.from(content)) }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    };
    assert.deepEqual(inventory, expected);
  });
});

test('rejects a package identity that is not a non-empty string', async () => {
  const values: Array<[string, unknown]> = [
    ['number', 42],
    ['object', { value: 'e2e' }],
    ['array', ['e2e']],
    ['empty string', ''],
    ['whitespace', '   '],
  ];
  for (const [label, value] of values) {
    await withInventory(async (root) => {
      await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': identity(value, '1.0.0') })), /identity/, `name ${label}`);
      await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': identity('e2e', value) })), /identity/, `version ${label}`);
    });
  }
});

test('rejects unsafe or duplicate archive members', async () => {
  await withInventory(async (root) => {
    const valid = { 'package.json': identity('e2e', '1.0.0'), 'a.js': 'a' };
    await assert.rejects(packageInventory(await writeArchive(root, valid, { entries: ['package', 'package'] })), /unsafe member/);
  });
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'a.js': 'a' }, { prefix: 'package/..' })), /unsafe member/);
  });
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': identity('e2e', '1.0.0'), 'a\\b.js': 'a' })), /unsafe member/);
  });
});

test('rejects non-regular files and a bare member outside package/', async () => {
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': identity('e2e', '1.0.0'), 'a.js': 'a' }, { symlinks: { 'link.js': 'a.js' } })), /unsupported entry/);
  });
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, {}, { rootMembers: { 'outside.txt': 'x' }, entries: ['outside.txt'] })), /unsupported entry/);
  });
});

test('rejects a missing or malformed package.json', async () => {
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'a.js': 'a' })), /identity is missing/);
  });
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': '{ not json' })), SyntaxError);
  });
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(await writeArchive(root, { 'package.json': 'null' })), /identity is missing/);
  });
});

test('rejects a missing archive without leaving work pending', async () => {
  await withInventory(async (root) => {
    await assert.rejects(packageInventory(join(root, 'absent.tgz')));
  });
});
