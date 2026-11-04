import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { create } from 'tar';
import { writeBundleInstaller } from './bundle-installer.ts';
import { installBundle } from './install-bundle.ts';
import { packageInventory } from './package-inventory.ts';
import { sha256, type BundleManifest } from './bundle.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('explicit synthetic fresh installation resolves the verified default without a runtime override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-fresh-bundle-'));
  try {
    const bundle = join(root, 'bundle'); const project = join(root, 'project');
    mkdirSync(bundle); mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'synthetic-consumer', private: true, type: 'module' }));
    const archives = {} as BundleManifest['packages'];
    for (const [key, name] of [['core', 'e2e'], ['web', '@e2e-dev/web']] as const) {
      const stage = join(root, key); const directory = join(stage, 'package'); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': './index.js', ...(key === 'core' ? { './engine': './index.js' } : {}) } }));
      if (key === 'web') {
        mkdirSync(join(directory, 'dist/native'), { recursive: true });
        for (const file of ['bundle.js', 'installed-runtime.js']) copyFileSync(join(repo, 'packages/web/dist/native', file), join(directory, 'dist/native', file));
        writeFileSync(join(directory, 'index.js'), "export { resolveInstalledRuntime } from './dist/native/installed-runtime.js';\n");
      } else writeFileSync(join(directory, 'index.js'), 'export const synthetic = true;\n');
      const path = `${key}.tgz`; await create({ gzip: true, file: join(bundle, path), cwd: stage }, ['package']);
      archives[key] = { path, sha256: sha256(readFileSync(join(bundle, path))) };
    }
    archives.mobile = archives.core;
    const member = (path: string, value: unknown) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); writeFileSync(join(bundle, path), bytes); return { path, sha256: sha256(bytes) }; };
    const native = member('native', '#!/bin/sh\nexit 0\n'); chmodSync(join(bundle, 'native'), 0o644);
    const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
    const manifest: BundleManifest = { schemaVersion: 1, source, nativeSource: source, platform: process.platform, architecture: process.arch, protocol: 'synthetic/1', packages: archives, native,
      producer: member('producer.json', { source, binary: { sha256: native.sha256 }, producer: { platform: process.platform, architecture: process.arch } }),
      negotiation: member('negotiation.json', { status: 'passed', scopeExercisePassed: true, cleanupConfirmed: true, binarySha256: native.sha256, negotiation: { protocol: 'synthetic/1', capabilities: ['synthetic-not-native-proof'] } }),
      installation: { schemaVersion: 1, installerFiles: writeBundleInstaller(bundle, join(repo, 'packages/web')), packages: { core: await packageInventory(join(bundle, archives.core.path)), web: await packageInventory(join(bundle, archives.web.path)) } } };
    const digest = member('manifest.json', manifest).sha256;
    await assert.rejects(installBundle(bundle, '0'.repeat(64), project), /digest mismatch/);
    // The independently trusted source bootstrap rejects bundled installer tampering before executing it.
    const installerPath = join(bundle, 'installer/bundle-install.js');
    const installerBytes = readFileSync(installerPath);
    writeFileSync(installerPath, 'throw new Error("untrusted installer executed");');
    await assert.rejects(installBundle(bundle, digest, project), /member digest mismatch/);
    assert.equal(existsSync(join(project, 'node_modules')), false);
    assert.equal(existsSync(join(project, '.e2e/native-runtime.json')), false);
    writeFileSync(installerPath, installerBytes);

    execFileSync(process.execPath, [join(bundle, 'install.mjs'), bundle, digest, project], { cwd: project, env: process.env, stdio: 'inherit' });
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', "const {resolveInstalledRuntime}=await import('@e2e-dev/web'); console.log(await resolveInstalledRuntime(process.cwd()));"], { cwd: project, env: { ...process.env, E2E_AGENT_BROWSER_EXECUTABLE: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(run().trim(), join(bundle, 'native'));
    await assert.rejects(installBundle(bundle, digest, project), /already exists/);
    // A nested peer graph must not substitute a different core behind the verified Web.
    const webEntry = execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@e2e-dev/web'));"], { cwd: project, encoding: 'utf8' }).trim();
    const nested = join(dirname(fileURLToPath(webEntry)), 'node_modules', 'e2e');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'e2e', version: '1.0.0', type: 'module', exports: { '.': './index.js', './engine': './index.js' } }));
    writeFileSync(join(nested, 'index.js'), 'export const substituted = true;');
    assert.throws(run, /different core package/);
    rmSync(nested, { recursive: true });
    // Changing executable package content with the same package version must be caught.
    const installed = execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('@e2e-dev/web'));"], { cwd: project, encoding: 'utf8' }).trim();
    writeFileSync(fileURLToPath(installed), "export { resolveInstalledRuntime } from './dist/native/installed-runtime.js';\n// changed\n");
    assert.throws(run, /content mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
