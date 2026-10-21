import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { REQUIRED_CAPABILITIES } from '../../packages/web/src/native/capabilities.ts';
import { verifyHeldoutCandidate } from './heldout-candidate.ts';
import { sha256, type BundleManifest, type PackageInventory } from './bundle.ts';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('held-out bridge binds real production modules but rejects a synthetic foundation-only peer before models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heldout-candidate-'));
  try {
    const bundle = join(root, 'bundle'); mkdirSync(bundle);
    const inventory = (directory: string, name: string): PackageInventory => {
      const packageRoot = join(root, directory); mkdirSync(packageRoot);
      cpSync(join(repo, 'packages', directory, 'dist'), join(packageRoot, 'dist'), { recursive: true });
      cpSync(join(repo, 'packages', directory, 'package.json'), join(packageRoot, 'package.json'));
      const files: PackageInventory['files'] = [];
      const visit = (prefix: string) => { for (const entry of readdirSync(join(packageRoot, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path); else files.push({ path, sha256: sha256(readFileSync(join(packageRoot, path))) });
      } };
      visit('');
      const metadata: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (!metadata || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') throw new Error('Fixture metadata missing');
      return { name, version: metadata.version, files };
    };
    const core = inventory('e2e', 'e2e'); const web = inventory('web', '@e2e-dev/web');
    mkdirSync(join(root, 'web/node_modules')); symlinkSync(join(root, 'e2e'), join(root, 'web/node_modules/e2e'));
    symlinkSync(join(repo, 'packages/e2e/node_modules'), join(root, 'e2e/node_modules'));
    const member = (path: string, value: unknown) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); writeFileSync(join(bundle, path), bytes); return { path, sha256: sha256(bytes) }; };
    const launched = join(root, 'launched'); const instrumented = join(root, 'instrumented');
    const native = member('foundation-peer', `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(launched)},'synthetic');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.type==='hello') console.log(JSON.stringify({type:'ready',id:f.id,protocol:'agent-browser-session/1',sessionId:'synthetic',generation:1,capabilities:fs.existsSync(${JSON.stringify(instrumented)})?${JSON.stringify([...REQUIRED_CAPABILITIES, 'acceptance.faults/1'])}:['browser.scope/1','browser.evaluate/1'],limits:{maxFrameBytes:1048576,maxPendingOperations:64,maxPendingDecisions:256,maxTimeoutMs:3600000},scopeState:'usable'}));if(f.type==='close'){console.log(JSON.stringify({type:'closed',id:f.id,generation:1,scopeState:'closed'}));process.stdin.unref();}});\n`);
    chmodSync(join(bundle, native.path), 0o755);
    const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
    const manifest: BundleManifest = { schemaVersion: 1, source, nativeSource: source, platform: process.platform, architecture: process.arch, protocol: 'agent-browser-session/1', packages: { core: native, web: native, mobile: native }, native,
      producer: member('producer.json', { source, binary: { sha256: native.sha256 }, producer: { platform: process.platform, architecture: process.arch } }),
      negotiation: member('negotiation.json', { status: 'passed', scopeExercisePassed: true, cleanupConfirmed: true, binarySha256: native.sha256, negotiation: { protocol: 'agent-browser-session/1', capabilities: ['browser.scope/1', 'browser.evaluate/1'] } }),
      installation: { schemaVersion: 1, packages: { core, web } } };
    const options = { bundle, expectedManifestHash: member('manifest.json', manifest).sha256, installedCoreEntry: pathToFileURL(join(root, 'e2e/dist/runner.js')).href, installedWebEntry: pathToFileURL(join(root, 'web/dist/index.js')).href, nativeExecutable: join(bundle, native.path) };
    await assert.rejects(verifyHeldoutCandidate({ ...options, expectedManifestHash: '0'.repeat(64) }), /digest mismatch/);
    assert.equal(existsSync(launched), false);
    await assert.rejects(verifyHeldoutCandidate(options), error => error instanceof Error && 'code' in error && error.code === 'ENGINE_FAILURE');
    assert.equal(readFileSync(launched, 'utf8'), 'synthetic');
    writeFileSync(instrumented, 'test-only');
    await assert.rejects(verifyHeldoutCandidate(options), /instrumentation is forbidden/);
    // This test intentionally never produces a verified full-runtime proof.
  } finally { rmSync(root, { recursive: true, force: true }); }
});
