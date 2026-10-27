import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installedChromium } from './installed-chromium.ts';

for (const suffix of ['chrome', 'chrome-linux64/chrome']) test(`official installer layout ${suffix}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chromium-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'chrome-156.0.0.1', suffix);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, 'synthetic executable', { mode: 0o700 });
  const result = await installedChromium(root, 'linux');
  assert.equal(result.executablePath, await realpath(binary));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
test('missing, ambiguous, nonexecutable and escaped binaries fail closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chromium-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(installedChromium(root, 'linux'));
  const folder = join(root, 'chrome-156.0.0.1');
  await mkdir(join(folder, 'chrome-linux64'), { recursive: true });
  await writeFile(join(folder, 'chrome'), 'a', { mode: 0o700 });
  await writeFile(join(folder, 'chrome-linux64/chrome'), 'b', { mode: 0o700 });
  await assert.rejects(installedChromium(root, 'linux'));
  await rm(join(folder, 'chrome-linux64/chrome'));
  await rm(join(folder, 'chrome'));
  await writeFile(join(folder, 'chrome'), 'a', { mode: 0o600 });
  await assert.rejects(installedChromium(root, 'linux'));
  await rm(join(folder, 'chrome'));
  await symlink(process.execPath, join(folder, 'chrome'));
  await assert.rejects(installedChromium(root, 'linux'), /escapes/);
});

const macApp = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
/** Synthetic Mach-O header only. These fixtures are never executed or treated as browser proof. */
function machO(architecture: 'arm64' | 'x64'): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}
for (const architecture of ['arm64', 'x64'] as const) {
  for (const suffix of [macApp, `chrome-mac-${architecture}/${macApp}`]) test(`official macOS ${architecture} layout ${suffix}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'chromium-macos-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, 'chrome-156.0.0.1', suffix);
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, machO(architecture), { mode: 0o700 });
    const result = await installedChromium(root, 'darwin', architecture);
    assert.equal(result.executablePath, await realpath(binary));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(installedChromium(root, 'darwin', architecture === 'arm64' ? 'x64' : 'arm64'), /Mach-O/);
    await assert.rejects(installedChromium(root, 'linux'), /exactly one/);
  });
}

test('macOS discovery rejects wrong archive, forged header, nonexecutable and Linux layouts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chromium-macos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'chrome-156.0.0.1');
  const wrongArchive = join(folder, 'chrome-mac-x64', macApp);
  await mkdir(dirname(wrongArchive), { recursive: true });
  await writeFile(wrongArchive, machO('arm64'), { mode: 0o700 });
  await assert.rejects(installedChromium(root, 'darwin', 'arm64'), /archive architecture/);
  await rm(join(folder, 'chrome-mac-x64'), { recursive: true });
  const binary = join(folder, macApp);
  await mkdir(dirname(binary), { recursive: true });
  for (const bytes of [Buffer.from('synthetic executable'), Buffer.alloc(32), (() => { const header = Buffer.alloc(32); header.writeUInt32BE(0xcafebabe, 0); return header; })(), (() => { const header = machO('arm64'); header.writeUInt32LE(6, 12); return header; })()]) {
    await writeFile(binary, bytes, { mode: 0o700 });
    await assert.rejects(installedChromium(root, 'darwin', 'arm64'), /Mach-O/);
  }
  await rm(binary);
  await writeFile(binary, machO('arm64'), { mode: 0o600 });
  await assert.rejects(installedChromium(root, 'darwin', 'arm64'), /EACCES/);
  await rm(binary);
  await writeFile(join(folder, 'chrome'), machO('arm64'), { mode: 0o700 });
  await assert.rejects(installedChromium(root, 'darwin', 'arm64'), /exactly one/);
  await assert.rejects(installedChromium(root, 'darwin', 'ia32'), /Unsupported/);
  await assert.rejects(installedChromium(root, 'win32', 'x64'), /Unsupported/);
});

test('macOS discovery rejects multiple versions, alias duplicates and escaped app paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chromium-macos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'cache');
  const binary = join(cache, 'chrome-156.0.0.1', macApp);
  const second = join(cache, 'chrome-157.0.0.1', macApp);
  for (const file of [binary, second]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, machO('arm64'), { mode: 0o700 });
  }
  await assert.rejects(installedChromium(cache, 'darwin', 'arm64'), /exactly one/);
  await rm(join(cache, 'chrome-157.0.0.1'), { recursive: true });
  const alias = join(cache, 'chrome-156.0.0.1/chrome-mac-arm64', macApp);
  await mkdir(dirname(alias), { recursive: true });
  await symlink(binary, alias);
  await assert.rejects(installedChromium(cache, 'darwin', 'arm64'), /Duplicate/);
  await rm(join(cache, 'chrome-156.0.0.1/chrome-mac-arm64'), { recursive: true });
  await rm(binary);
  const outside = join(root, 'outside');
  await writeFile(outside, machO('arm64'), { mode: 0o700 });
  await symlink(outside, binary);
  await assert.rejects(installedChromium(cache, 'darwin', 'arm64'), /escapes/);
  await rm(join(cache, 'chrome-156.0.0.1/Google Chrome for Testing.app'), { recursive: true });
  const outsideApp = join(root, 'outside-app');
  await mkdir(join(outsideApp, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(outsideApp, 'Contents/MacOS/Google Chrome for Testing'), machO('arm64'), { mode: 0o700 });
  await symlink(outsideApp, join(cache, 'chrome-156.0.0.1/Google Chrome for Testing.app'));
  await assert.rejects(installedChromium(cache, 'darwin', 'arm64'), /escapes/);
});
