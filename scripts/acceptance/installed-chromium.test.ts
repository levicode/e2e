import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
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
  const result = await installedChromium(root);
  assert.equal(result.executablePath, binary);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
test('missing, ambiguous, nonexecutable and escaped binaries fail closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chromium-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(installedChromium(root));
  const folder = join(root, 'chrome-156.0.0.1');
  await mkdir(join(folder, 'chrome-linux64'), { recursive: true });
  await writeFile(join(folder, 'chrome'), 'a', { mode: 0o700 });
  await writeFile(join(folder, 'chrome-linux64/chrome'), 'b', { mode: 0o700 });
  await assert.rejects(installedChromium(root));
  await rm(join(folder, 'chrome-linux64/chrome'));
  await rm(join(folder, 'chrome'));
  await writeFile(join(folder, 'chrome'), 'a', { mode: 0o600 });
  await assert.rejects(installedChromium(root));
  await rm(join(folder, 'chrome'));
  await symlink(process.execPath, join(folder, 'chrome'));
  await assert.rejects(installedChromium(root), /escapes/);
});
