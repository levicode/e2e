/** Node-only archive controls. Synthetic bytes never constitute browser acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { INTEROP_FILES, readStableInteropFile, prepareInteropCapture, interopEnvironment, archiveInteropCapture, verifyInteropArchive } from './candidate-interop-evidence.ts';
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'interop-archive-pure-')));
  const tests = join(root, 'tests'); const output = join(root, 'output'); mkdirSync(tests); mkdirSync(output);
  const capture = prepareInteropCapture(tests);
  t.after(() => { rmSync(capture.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  for (const [name, files] of Object.entries(INTEROP_FILES)) {
    mkdirSync(join(capture.root, name));
    for (const file of files) writeFileSync(join(capture.root, name, file), file === 'file-identity.json' ? JSON.stringify({ collectedTestPath: join(tests, name) }) : file.endsWith('.json') ? '{"syntheticArchiveControl":true}' : Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  return { root, tests, output, capture, first: join(capture.root, 'isolated-page-reopen.test.ts', 'isolated-page-reopen-owned.json') };
}
test('isolated absolute output and clean scoped environment; original inherited env is untouched', t => {
  const f = fixture(t); const inherited = { E2E_INTEROP_EVIDENCE_DIR: '/stale', E2E_INTEROP_FILE_SCOPED_EVIDENCE: 'bad', OTHER: 'keep' };
  assert.deepEqual(interopEnvironment(inherited), { OTHER: 'keep' });
  assert.deepEqual(interopEnvironment(inherited, f.capture), { OTHER: 'keep', E2E_INTEROP_EVIDENCE_DIR: f.capture.root, E2E_INTEROP_FILE_SCOPED_EVIDENCE: '1' });
  assert.equal(inherited.E2E_INTEROP_EVIDENCE_DIR, '/stale'); assert.throws(() => prepareInteropCapture('relative'));
  const second = prepareInteropCapture(f.tests); t.after(() => rmSync(second.root, { recursive: true, force: true })); assert.notEqual(f.capture.root, second.root);
});
test('all four independent fixture directories and exactly 21 original files survive archive and final verification', t => {
  const f = fixture(t); const receipt = archiveInteropCapture(f.capture, f.output, true);
  assert.equal(receipt.status, 'captured'); assert.equal(receipt.files.length, 21); assert.equal(new Set(receipt.files.map(file => file.path)).size, 21);
  verifyInteropArchive(f.output, receipt, f.tests);
  assert.deepEqual(readFileSync(join(f.output, 'interop', receipt.files[1]!.path)), readFileSync(f.first));
  assert.throws(() => archiveInteropCapture(f.capture, f.output, true), /EEXIST/);
});
for (const condition of ['missing', 'malformed', 'foreign-identity', 'unknown-file', 'symlink', 'changed-identity'] as const) test(`failure preserves available original evidence and rejects ${condition}`, t => {
  const f = fixture(t);
  if (condition === 'missing') rmSync(f.first);
  if (condition === 'malformed') writeFileSync(f.first, 'not-json-original-failure');
  if (condition === 'foreign-identity') writeFileSync(join(f.capture.root, 'isolated-page-reopen.test.ts', 'file-identity.json'), JSON.stringify({ collectedTestPath: join(f.tests, 'foreign.test.ts') }));
  if (condition === 'unknown-file') writeFileSync(join(f.capture.root, 'extra'), 'not archived');
  if (condition === 'symlink') { rmSync(f.first); symlinkSync(join(f.capture.root, 'persistent-raw-reconnect.test.ts', 'persistent-raw-reconnect.json'), f.first); }
  const receipt = archiveInteropCapture(f.capture, f.output, condition !== 'changed-identity');
  assert.equal(receipt.status, 'incomplete'); assert.ok(receipt.files.length >= 20); assert.throws(() => verifyInteropArchive(f.output, receipt, f.tests));
  if (condition === 'malformed') assert.equal(readFileSync(join(f.output, 'interop/isolated-page-reopen.test.ts/isolated-page-reopen-owned.json'), 'utf8'), 'not-json-original-failure');
});
test('final receipt rejects changed bytes, paths, identities and detached summary', t => {
  const f = fixture(t); const receipt = archiveInteropCapture(f.capture, f.output, true);
  assert.throws(() => verifyInteropArchive(f.output, { ...receipt, status: 'incomplete' }, f.tests));
  assert.throws(() => verifyInteropArchive(f.output, receipt, join(f.root, 'foreign')));
  writeFileSync(join(f.output, 'interop', receipt.files[1]!.path), '{"changed":true}');
  assert.throws(() => verifyInteropArchive(f.output, receipt, f.tests), /bytes/);
});
test('orchestration always archives and checks HEAD/dist/native/binary even after a failed test', () => {
  const source = readFileSync(new URL('candidate-web.ts', import.meta.url), 'utf8');
  const cleanup = source.slice(source.indexOf('  finally {'), source.indexOf('    if (installerRuntime) {', source.indexOf('  finally {')));
  for (const obligation of ['sourceState()', 'fingerprint(files)', "['rev-parse', 'HEAD']", "['rev-parse', 'HEAD^{tree}']", 'candidateDistInventory(REPO_ROOT)', 'sha256(readFileSync(binary))', 'nativeSourceRevision', 'nativeSourceTree', 'archiveInteropCapture(interopCapture, output, identityUnchanged)', "status = 'failed'"]) assert.ok(cleanup.includes(obligation), obligation);
  assert.match(source, /if \(sourceState\(\) \|\| execFileSync\('git', \['rev-parse', 'HEAD'\]/);
  assert.doesNotMatch(source, /execFileSync\('git', \['clean'/);
});

test('bounded reader rejects oversized originals and growth during actual fd reads', t => {
  const f = fixture(t); writeFileSync(f.first, 'a'.repeat(32));
  assert.equal(readStableInteropFile(f.first, 32).length, 32);
  assert.throws(() => readStableInteropFile(f.first, 31), /oversized/);
  const original = fs.readSync; let returned = 0; let calls = 0;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    if (calls++ === 0) fs.appendFileSync(f.first, 'b'.repeat(64));
    const count = Reflect.apply(original, fs, args) as number; returned += count; return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { assert.throws(() => readStableInteropFile(f.first, 32), /Changed|oversized/); assert.ok(returned <= 33); }
  finally { fs.readSync = original; syncBuiltinESMExports(); }
});
test('bounded reader rejects in-place same-size mutation and pre-open symlink replacement', t => {
  const f = fixture(t); writeFileSync(f.first, 'a'.repeat(32));
  const originalRead = fs.readSync; let changed = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (!changed) { changed = true; writeFileSync(f.first, 'b'.repeat(32)); fs.utimesSync(f.first, new Date(0), new Date(0)); }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { assert.throws(() => readStableInteropFile(f.first, 32), /Changed/); }
  finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
  const originalOpen = fs.openSync;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    rmSync(f.first); symlinkSync(join(f.capture.root, 'persistent-raw-reconnect.test.ts', 'persistent-raw-reconnect.json'), f.first);
    return Reflect.apply(originalOpen, fs, args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { assert.throws(() => readStableInteropFile(f.first, 32)); }
  finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
});
