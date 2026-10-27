import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { create, Header } from 'tar';
import { packageInventory } from './package-inventory.ts';
import { sha256, type PackageInventory } from './bundle.ts';

const identity = (name: unknown, version: unknown): string => JSON.stringify({ name, version });

/** Pack synthetic bytes in this test's scratch directory; never extract an archive. */
async function writeArchive(
  root: string,
  members: Record<string, string>,
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

/**
 * Build an archive whose second member is larger than one tar read, so the identity member
 * rejects while the archive is still being listed. Extracting it would cost 17MiB per case,
 * so the member is a sparse hole rather than written bytes.
 */
function writeSparseArchive(root: string, metadata: string, size = 17 * 1024 * 1024): string {
  const file = join(root, 'sparse.tgz');
  const fd = openSync(file, 'w');
  const addHeader = (path: string, entrySize: number, offset: number): void => {
    const header = new Header({ path, mode: 0o644, size: entrySize, type: 'File', mtime: new Date(0) });
    header.encode();
    const block = header.block;
    assert.ok(block, 'tar header block');
    writeSync(fd, block, 0, 512, offset);
  };
  const bytes = Buffer.from(metadata);
  addHeader('package/package.json', bytes.length, 0);
  writeSync(fd, bytes, 0, bytes.length, 512);
  addHeader('package/large.bin', size, 1024);
  ftruncateSync(fd, 1536 + size + 1024);
  closeSync(fd);
  return file;
}

/** Count rejections that escape to the process while `run` settles, so a late handler can't hide. */
async function expectNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
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

test('rejects an invalid identity read before the archive finishes listing, without an unhandled rejection', async () => {
  await withInventory(async (root) => {
    const archive = writeSparseArchive(root, identity(42, '1.0.0'));
    await expectNoUnhandledRejection(async () => {
      await assert.rejects(packageInventory(archive), /identity is missing/);
    });
  });
  await withInventory(async (root) => {
    const archive = writeSparseArchive(root, identity('e2e', 42));
    await expectNoUnhandledRejection(async () => {
      await assert.rejects(packageInventory(archive), /identity is missing/);
    });
  });
  await withInventory(async (root) => {
    const archive = writeSparseArchive(root, '{ not json');
    await expectNoUnhandledRejection(async () => {
      await assert.rejects(packageInventory(archive), SyntaxError);
    });
  });
});

test('accepts a valid identity from a large archive and stays clean across repeated reads', async () => {
  await withInventory(async (root) => {
    const archive = writeSparseArchive(root, identity('e2e', '1.0.0'));
    await expectNoUnhandledRejection(async () => {
      const inventory = await packageInventory(archive);
      assert.equal(inventory.name, 'e2e');
      assert.equal(inventory.version, '1.0.0');
      assert.deepEqual(inventory.files.map(file => file.path), ['large.bin', 'package.json']);
    });
  });
  await withInventory(async (root) => {
    const invalid = writeSparseArchive(root, identity(42, '1.0.0'));
    const valid = await writeArchive(root, { 'package.json': identity('e2e', '1.0.0'), 'a.js': 'a' });
    await expectNoUnhandledRejection(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(packageInventory(invalid), /identity is missing/);
        assert.equal((await packageInventory(valid)).name, 'e2e');
      }
    });
  });
});

test('propagates a listing failure to a caller try/catch without an unhandled rejection', async () => {
  await withInventory(async (root) => {
    const complete = readFileSync(await writeArchive(root, { 'package.json': identity('e2e', '1.0.0'), 'a.bin': 'x'.repeat(200_000) }));
    const truncated = join(root, 'truncated.tgz');
    writeFileSync(truncated, complete.subarray(0, complete.length - 100));
    await expectNoUnhandledRejection(async () => {
      let rejection: unknown;
      try {
        await packageInventory(truncated);
      } catch (error) {
        rejection = error;
      }
      assert.ok(rejection instanceof Error, 'the caller catches a normal rejection');
    });
  });
  await withInventory(async (root) => {
    const archive = writeSparseArchive(root, identity(42, '1.0.0'));
    await expectNoUnhandledRejection(async () => {
      let rejection: unknown;
      try {
        await packageInventory(archive);
      } catch (error) {
        rejection = error;
      }
      assert.ok(rejection instanceof Error, 'the caller catches a normal rejection');
      assert.match(rejection.message, /identity is missing/);
    });
  });
});
