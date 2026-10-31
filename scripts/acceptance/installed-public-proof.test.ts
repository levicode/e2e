/** Synthetic validator controls only: never an installed browser acceptance receipt. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateInstalledPublicProof } from './installed-public-proof.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'installed-proof-pure-')); const project = join(root, 'consumer'); const evidence = join(root, 'evidence');
  mkdirSync(project); mkdirSync(evidence);
  const put = (name: string, data: string | Buffer) => { const p = join(project, name); writeFileSync(p, data); return p; };
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const pixels = { width: 640, height: 480, protected: [0, 0, 0], public: [255, 0, 0], fresh: [0, 255, 0] };
  const report = (replay: boolean) => ({ run: { status: 'passed', results: [{ attempts: [{ steps: [{ api: 'agent.act', status: 'passed', cache: { mode: replay ? 'self-finalized' : 'missed', reason: replay ? undefined : 'no-entry', replayedActions: replay ? 2 : 0, totalActions: 2 }, metrics: { modelCalls: replay ? 0 : 2 }, explanation: 'zero-turn' }] }] }] } });
  const video = Buffer.from('1a45dfa3', 'hex'); const download = Buffer.from('installed\nsynthetic download\u0000\u00ff\n');
  const proof = { status: 'passed', checks: 11, runtimeOverrideAbsent: true, publicBrowserActionPassed: true, callbackPassed: true, cleanupConfirmed: true, surfaceOfPassed: true, locateTapPassed: true, report: { run: { status: 'passed' } }, screenshotPath: put('screenshot.png', png), coverage: {
    mask: { observation: pixels, artifact: structuredClone(pixels), path: put('mask.png', png) },
    media: { path: put('video.webm', video), bytes: video.length, frame: { width: 640, height: 480, padded: 0, inked: 0.5 } },
    download: { suggestedFilename: 'installed.bin', absolutePath: put('download.bin', download), bytes: download.length },
    state: { path: put('state.json', '{}'), bootstrapRequests: 0, restored: { phase: 'restored', first: { cookie: 'native-fixture=synthetic', local: 'stored' }, created: false, version: 3, indexes: ['byLabel'], record: { cycle: true, typedKind: 'Uint16Array', typed: [1, 65535], blob: 'fixture-payload', blobType: 'text/plain' } } },
    cache: { cachePath: put('cache.json', JSON.stringify({ schemaVersion: 'trace-1' })), recordedModelCalls: 2, replayedModelCalls: 0, replayedActions: 2, entryUnchanged: true, recordReport: put('record.json', JSON.stringify(report(false))), replayReport: put('replay.json', JSON.stringify(report(true))) },
  } };
  return { root, project, evidence, proof, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('synthetic complete envelope retains eight evidence files with digests', () => {
  const f = fixture(); try { validateInstalledPublicProof(f.proof, f.project, f.evidence); const files = JSON.parse(readFileSync(join(f.evidence, 'installed-coverage-files.json'), 'utf8')); assert.equal(Object.keys(files).length, 8); for (const file of Object.values(files) as { sha256: string }[]) assert.match(file.sha256, /^[a-f0-9]{64}$/); } finally { f.close(); }
});

const negatives: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  'old six-check result': f => { f.proof.checks = 6; },
  'non-boolean original flag': f => { Object.assign(f.proof, { surfaceOfPassed: 'true' }); },
  'masked public pixels': f => { f.proof.coverage.mask.artifact.public = [0, 0, 0]; },
  'unmasked secret pixels': f => { f.proof.coverage.mask.observation.protected = [255, 0, 0]; },
  'stale background': f => { f.proof.coverage.mask.artifact.fresh = [0, 0, 255]; },
  'video wrong viewport': f => { f.proof.coverage.media.frame.width = 320; },
  'video blank': f => { f.proof.coverage.media.frame.inked = 0; },
  'video padding': f => { f.proof.coverage.media.frame.padded = 0.5; },
  'video NaN': f => { f.proof.coverage.media.frame.inked = NaN; },
  'video corrupt': f => { writeFileSync(f.proof.coverage.media.path, 'nope'); },
  'download incorrect bytes': f => { writeFileSync(f.proof.coverage.download.absolutePath, 'wrong'); },
  'state first-script missing cookie': f => { f.proof.coverage.state.restored.first.cookie = ''; },
  'state lost typed value': f => { f.proof.coverage.state.restored.record.typed[1] = 1; },
  'state bootstrap request': f => { f.proof.coverage.state.bootstrapRequests = 1; },
  'cache called model': f => { f.proof.coverage.cache.replayedModelCalls = 1; },
  'cache no recorded model': f => { f.proof.coverage.cache.recordedModelCalls = 0; },
  'cache mutated': f => { f.proof.coverage.cache.entryUnchanged = false; },
  'cache wrong action count': f => { f.proof.coverage.cache.replayedActions = 1; },
  'cache false replay report': f => { const p = f.proof.coverage.cache.replayReport; const report = JSON.parse(readFileSync(p, 'utf8')); report.run.results[0].attempts[0].steps[0].metrics.modelCalls = 1; writeFileSync(p, JSON.stringify(report)); },
  'outside-project evidence': f => { const p = join(f.root, 'outside.png'); writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex')); f.proof.screenshotPath = p; },
};
for (const [name, mutate] of Object.entries(negatives)) test(`rejects ${name}`, () => { const f = fixture(); try { mutate(f); assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence)); } finally { f.close(); } });
for (const missing of ['mask', 'media', 'download', 'state', 'cache']) test(`rejects missing ${missing}`, () => { const f = fixture(); try { delete (f.proof.coverage as Record<string, unknown>)[missing]; assert.throws(() => validateInstalledPublicProof(f.proof, f.project, f.evidence)); } finally { f.close(); } });

test('generated installed-only files parse without executing fixture, browser, or runner', () => {
  const source = readFileSync(new URL('fixtures/installed-candidate.mjs', import.meta.url), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'installed-generated-syntax-'));
  try {
    const templates = [...source.matchAll(/writeFileSync\('(installed-cache[^']+)'\s*,\s*(String\.raw)?`([\s\S]*?)`\);/g)];
    assert.equal(templates.length, 3);
    for (const [, name, raw, body] of templates) {
      const text = new Function('url', `return ${raw ? 'String.raw' : ''}\`${body}\`;`)('http://127.0.0.1:1234');
      const p = join(root, name!.replaceAll('/', '-')); writeFileSync(p, text);
      const checked = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr);
    }
    assert.match(source, /from 'e2e\/runner'/); assert.match(source, /from '@e2e-dev\/web'/);
    assert.doesNotMatch(source, /from ['"][^'"]*(?:packages\/|\/src\/|helpers\/)/);
    assert.match(source, /const screenshotPath = resolve\(session\.artifactsDir, await app\.screenshot\('installed-candidate'\)\);\s*const capture = readFileSync\(screenshotPath\);/);
    assert.ok(source.indexOf('closed = true; checks++;') < source.indexOf('coverage.state = await installedState(url)'), 'State reset must not pre-close the original cleanup oracle page');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('isolation accepts real npm and pnpm entries only within external project node_modules', async () => {
  const { assertInstalledConsumerIsolation } = await import('./installed-public-proof.ts');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'installed-isolation-'));
  try {
    const checkout = join(root, 'repo'); const project = join(root, 'repo-consumer'); mkdirSync(checkout); mkdirSync(project);
    const modules = join(project, 'node_modules'); const npm = join(modules, 'e2e'); const pnpm = join(modules, '.pnpm', 'web@1', 'node_modules', '@e2e-dev', 'web');
    mkdirSync(npm, { recursive: true }); mkdirSync(pnpm, { recursive: true });
    writeFileSync(join(npm, 'runner.js'), ''); writeFileSync(join(pnpm, 'index.js'), '');
    mkdirSync(join(modules, '@e2e-dev')); symlinkSync(pnpm, join(modules, '@e2e-dev/web'), 'dir');
    assert.doesNotThrow(() => assertInstalledConsumerIsolation(project, checkout, [join(npm, 'runner.js'), join(modules, '@e2e-dev/web/index.js')]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ['same checkout', 'nested checkout', 'project symlink to checkout', 'package symlink to checkout', 'package symlink external', 'node_modules symlink external', 'prefix disguise']) test(`isolation rejects ${scenario}`, async () => {
  const { assertInstalledConsumerIsolation } = await import('./installed-public-proof.ts');
  const { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'installed-isolation-negative-'));
  try {
    const checkout = join(root, 'repo'); let project = join(root, 'consumer'); mkdirSync(checkout); mkdirSync(project);
    const outside = join(root, 'external'); mkdirSync(outside); writeFileSync(join(outside, 'entry.js'), ''); writeFileSync(join(checkout, 'entry.js'), '');
    const modules = join(project, 'node_modules'); let entry = join(modules, 'entry.js');
    if (scenario === 'same checkout') project = checkout;
    else if (scenario === 'nested checkout') { project = join(checkout, 'consumer'); mkdirSync(project); }
    else if (scenario === 'project symlink to checkout') { rmSync(project, { recursive: true }); symlinkSync(checkout, project, 'dir'); }
    else if (scenario === 'node_modules symlink external') symlinkSync(outside, modules, 'dir');
    else {
      mkdirSync(modules);
      if (scenario === 'package symlink to checkout') symlinkSync(join(checkout, 'entry.js'), entry);
      if (scenario === 'package symlink external') symlinkSync(join(outside, 'entry.js'), entry);
      if (scenario === 'prefix disguise') { const fake = modules + '-elsewhere'; mkdirSync(fake); entry = join(fake, 'entry.js'); writeFileSync(entry, ''); }
    }
    assert.throws(() => assertInstalledConsumerIsolation(project, checkout, scenario.includes('checkout') && !scenario.includes('package') ? [] : [entry]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
