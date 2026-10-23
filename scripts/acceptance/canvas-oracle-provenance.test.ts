/** Source and synthetic-receipt checks only; no browser or native binary is launched. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve as resolvePath } from 'node:path';
import test from 'node:test';
import { CANVAS_BASELINE_REVISION, canvasCoreInventory, canvasOracleAvailable, canvasReceiptMatches, type CanvasOracleManifest } from '../../packages/web/tests/helpers/canvas-oracle-provenance.ts';

const root = resolvePath(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(join(root, 'packages/web/tests/helpers/canvas-oracle-manifest.json'), 'utf8')) as CanvasOracleManifest;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type ReadGit = (cwd: string, args: readonly string[]) => Buffer;
const readGit: ReadGit = (cwd, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

/** An explicit hosted reference is a separately pinned official source checkout, never executable code. */
function baselineReader(candidateRoot: string, referenceRoot?: string, git: ReadGit = readGit): (path: string) => Buffer {
  if (referenceRoot === undefined) return path => git(candidateRoot, ['show', `${CANVAS_BASELINE_REVISION}:${path}`]);
  const reference = realpathSync(resolvePath(referenceRoot));
  const metadata = (args: readonly string[]): string => git(reference, args).toString('utf8').trim();
  assert.equal(metadata(['rev-parse', '--show-toplevel']), reference, 'Baseline must be its own checkout root');
  assert.match(metadata(['remote', 'get-url', 'origin']), /^https:\/\/github\.com\/tester-army\/e2e(?:\.git)?$/, 'Baseline must use the official repository');
  assert.equal(metadata(['rev-parse', 'HEAD']), CANVAS_BASELINE_REVISION, 'Baseline must be the fixed official revision');
  assert.equal(metadata(['status', '--porcelain', '--untracked-files=no']), '', 'Baseline tracked sources must be clean');
  return path => {
    assert.match(path, /^packages\/(?:web|e2e)\/[A-Za-z0-9_./-]+$/);
    assert.ok(!path.split('/').includes('..'));
    const absolute = join(reference, path);
    assert.equal(realpathSync(absolute), absolute, 'Baseline source aliases are not accepted');
    return readFileSync(absolute);
  };
}
const original = baselineReader(root, process.env['E2E_CANVAS_ORACLE_BASELINE_ROOT']);

function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  return [...code.matchAll(/^\s*(?:import|export)\s+([^;]+?)\s+from\s+(['"])(.*?)\2\s*;/gm)]
    .filter(match => !match[1]!.trim().startsWith('type '))
    .filter(match => !match[1]!.trim().startsWith('{') || match[1]!.replace(/[{}]/g, '').split(',').some(part => part.trim() !== '' && !part.trim().startsWith('type ')))
    .map(match => match[3]!);
}

test('manifest covers the exact runtime source import closure, with all original/current hashes checked', () => {
  assert.equal(manifest.baselineRevision, CANVAS_BASELINE_REVISION);
  assert.equal(manifest.claim, 'source-equivalent-primitive-oracle');
  const sources = new Map(manifest.sources.map(source => [source.path, source]));
  assert.equal(sources.size, 26);
  let unequal = 0;
  const visited = new Set<string>();
  const queue = [manifest.entry];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = sources.get(path); assert.ok(source);
    const bytes = readFileSync(join(root, path));
    assert.equal(sha256(bytes), source.currentSha256);
    if (source.baselineSha256 !== null) assert.equal(sha256(original(path)), source.baselineSha256);
    else assert.throws(() => original(path));
    assert.equal(source.byteEqual, source.currentSha256 === source.baselineSha256);
    if (!source.byteEqual) { unequal++; assert.ok(source.differenceReview); }
    const text = bytes.toString('utf8');
    assert.doesNotMatch(text, /\b(?:require\s*\(|import\s*\(|import\s*['"])/);
    const imports = runtimeImports(text);
    const internal = [...new Set(imports.filter(name => !name.startsWith('node:')).map(name =>
      name === 'e2e/engine' ? 'packages/e2e/src/engine/index.ts' : posix.normalize(posix.join(posix.dirname(path), name))))].toSorted();
    assert.deepEqual(internal, source.imports);
    assert.deepEqual([...new Set(imports.filter(name => name.startsWith('node:')))].toSorted(), source.external);
    queue.push(...internal);
  }
  assert.deepEqual([...visited].toSorted(), [...sources.keys()].toSorted());
  assert.equal(unequal, 6);
  assert.equal(manifest.runtime.length, 20);
  assert.deepEqual(manifest.runtime.map(item => item.sourcePath).toSorted(), [...sources.keys()].filter(path => path.startsWith('packages/e2e/')).toSorted());
});

test('the only called primitive moved between changed modules is byte-identical to the fixed original', () => {
  assert.equal(manifest.movedSymbols.length, 1);
  for (const symbol of manifest.movedSymbols) {
    assert.equal(symbol.name, 'cancelled');
    assert.ok(original(symbol.baselinePath).toString('utf8').includes(symbol.source));
    assert.ok(readFileSync(join(root, symbol.currentPath), 'utf8').includes(symbol.source));
    assert.equal(sha256(symbol.source), symbol.sha256);
  }
  const contractPath = 'packages/e2e/src/engine/contract.ts';
  const before = original(contractPath).toString('utf8');
  const current = readFileSync(join(root, contractPath), 'utf8');
  for (const pattern of [
    /export class EngineError extends Error \{[\s\S]*?^\}/m,
    /export const RETRYABLE_ENGINE_ERROR_CODES:[\s\S]*?^\]\);/m,
    /export const OBSERVED_NAME_LIMIT = \d+;/,
    /export const OBSERVED_TEXT_LIMIT = \d+;/,
  ]) {
    const originalSymbol = before.match(pattern)?.[0];
    const currentSymbol = current.match(pattern)?.[0];
    assert.ok(originalSymbol); assert.ok(currentSymbol);
    assert.equal(currentSymbol, originalSymbol);
  }
});

test('synthetic build receipt requires exact revision/binary/full inventory and passed web-unit', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'canvas-oracle-receipt-')); t.after(() => rmSync(scratch, { recursive: true, force: true }));
  for (const file of ['dist/index.js', 'dist/engine/index.js']) {
    const path = join(scratch, 'packages/e2e', file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '// synthetic only\n');
  }
  const inventory = canvasCoreInventory(scratch);
  const binding = { sourceRevision: 'a'.repeat(40), binarySha256: 'b'.repeat(64) };
  const receipt = { schemaVersion: 1, suite: 'web-unit', status: 'passed', ...binding, runtimeBuild: { core: inventory } };
  assert.equal(canvasReceiptMatches(receipt, binding, inventory), true);
  for (const altered of [
    { ...receipt, status: 'failed' }, { ...receipt, suite: 'web-browser' },
    { ...receipt, sourceRevision: 'c'.repeat(40) }, { ...receipt, binarySha256: 'd'.repeat(64) },
    { ...receipt, runtimeBuild: { core: inventory.slice(1) } },
    { ...receipt, runtimeBuild: { core: [...inventory, inventory[0]] } },
    { ...receipt, runtimeBuild: { core: inventory.toReversed() } },
  ]) assert.equal(canvasReceiptMatches(altered, binding, inventory), false);
  writeFileSync(join(scratch, 'packages/e2e/dist/index.js'), '// changed\n');
  assert.equal(canvasReceiptMatches(receipt, binding, canvasCoreInventory(scratch)), false);
  assert.equal(canvasOracleAvailable({}), false);
  assert.equal(canvasOracleAvailable({ E2E_SYNTHETIC_EVIDENCE_BATCH: '1', E2E_SYNTHETIC_EVIDENCE_BINDING: '{}' }), false);
});

test('owned lifetime disposes each acquired resource and reports real cleanup failure', async () => {
  const { CanvasOracleLifetime } = await import('../../packages/web/tests/helpers/canvas-oracle-provenance.ts');
  const owner = new CanvasOracleLifetime(100, 30);
  const disposed: number[] = [];
  const context = await owner.acquire(async () => ({ ordinal: 1 }), async value => { disposed.push(value.ordinal); }, 2);
  owner.publish(context, async () => { throw new Error('duplicate disposal'); });
  owner.publish({ ordinal: 0 }, async value => { disposed.push(value.ordinal); });
  assert.equal(await owner.cleanup(), true);
  assert.deepEqual(disposed, [0, 1]);
  assert.equal(owner.settled, true);
  const broken = new CanvasOracleLifetime(100, 30);
  broken.publish({}, async () => { throw new Error('synthetic cleanup failure'); });
  assert.equal(await broken.cleanup(), false);
  assert.equal(broken.settled, false);
});

test('deadline leaves late acquisition owned and cleanup-only until actual disposal settles', async () => {
  const { CanvasOracleLifetime } = await import('../../packages/web/tests/helpers/canvas-oracle-provenance.ts');
  const owner = new CanvasOracleLifetime(25, 10);
  let acquire: ((value: object) => void) | undefined;
  let dispose: (() => void) | undefined;
  let disposals = 0;
  const acquiring = owner.acquire(() => new Promise<object>(resolve => { acquire = resolve; }), async () => {
    disposals++;
    await new Promise<void>(resolve => { dispose = resolve; });
  }, 2);
  await assert.rejects(acquiring);
  assert.equal(await owner.cleanup(), false);
  assert.equal(owner.settled, false);
  acquire!({});
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disposals, 1);
  assert.equal(owner.settled, false);
  await assert.rejects(owner.run(async () => { throw new Error('must not start'); }));
  dispose!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(owner.settled, true);
});

test('paired native data is four closed facts; absent or mismatched fixture pair cannot authorize capture', async () => {
  const { pairCanvasNative, canvasPairMatches } = await import('../../packages/web/tests/helpers/canvas-oracle-provenance.ts');
  const pair = pairCanvasNative(new Map([
    ['svg', { role: 'image', name: 'do not retain this string' }],
    ['frame', { role: 'iframe' }], ['host', { role: 'textbox', value: 'do not retain this value' }],
  ]), 'static synthetic html');
  assert.equal(pair.targets.length, 4);
  assert.deepEqual(pair.targets.map(target => target.roleOrdinal), [0, 1, 2, 3]);
  assert.equal(canvasPairMatches(pair, 'static synthetic html'), true);
  assert.equal(canvasPairMatches(undefined, 'static synthetic html'), false);
  assert.equal(canvasPairMatches(pair, 'different fixture'), false);
  assert.equal(canvasPairMatches(pairCanvasNative(new Map([['canvas', { role: 'unexpected' }]]), 'x'), 'x'), true);
  assert.doesNotMatch(JSON.stringify(pair), /do not retain|testId|ref|unexpected/);
});

test('original fixture and reviewed canvas assertion are preserved; companion never reacquires native state', () => {
  const path = 'packages/web/tests/integration/read-node-roles.test.ts';
  const source = readFileSync(join(root, path), 'utf8');
  const baseline = original(path).toString('utf8');
  // Reviewed pre-diagnostic native test obligations, not a claim of whole-test d7 equality.
  const originalDirectItCount = 12;
  const originalAssertionSha256 = 'eee7c20fd38a018bbda8f8474ec6576e312a8a9ece8b259944e2fe4fbcdd5a34';
  // f33ec749f corrects only canvas inclusion and strict own-key equality. The d7
  // reader retains testId nodes; CI18 P42O confirmed baseline/native inclusion
  // (artifact 12441352372, SHA256 664a97aef391248d7d05423b79a28e203b1ff635e5eb96562b8cab456afe8591).
  const reviewedAssertionSha256 = '89f383dde0c278dc4a6077320886dafe43f537fcdbd99445f54299552cc140d4';
  assert.match(original('packages/web/src/in-page/read-semantics.ts').toString('utf8'),
    /const isInteresting = \(el: Element\): boolean => \{\s*if \(el\.hasAttribute\(options\.testIdAttribute\)\) return true;/);
  const name = "it('never makes a drawn or embedded surface a textbox, whatever its contenteditable says'";
  const oldFixture = baseline.slice(baseline.indexOf(name)).match(/await page\.setContent\(`([\s\S]*?)`\);/)?.[1];
  const fixture = source.match(/const embeddedSurfaceHtml = `([\s\S]*?)`;/)?.[1];
  assert.ok(oldFixture); assert.equal(fixture, oldFixture);
  const currentCase = source.slice(source.indexOf(name), source.indexOf("it('P42O:"));
  const assertion = (text: string) => text.match(/expect\(roles,[\s\S]*?\.toStrictEqual\(\{ canvas: undefined, svg: 'image', frame: 'iframe', host: 'textbox' \}\);/)?.[0].replace(/^\s+/gm, '');
  const currentAssertion = assertion(currentCase); assert.ok(currentAssertion);
  assert.equal(sha256(currentAssertion), reviewedAssertionSha256);
  // Reversing precisely the reviewed correction must recover the frozen assertion.
  const originalAssertion = currentAssertion
    .replace("{ testId: 'canvas', included: true, role: undefined }", "{ testId: 'canvas', included: false }")
    .replace(".toStrictEqual({ canvas: undefined, svg: 'image', frame: 'iframe', host: 'textbox' })", ".toEqual({ svg: 'image', frame: 'iframe', host: 'textbox' })");
  assert.equal(sha256(originalAssertion), originalAssertionSha256);
  assert.doesNotMatch(currentCase, /await recordCanvasOracle/);
  const companion = source.slice(source.indexOf("it('P42O:"), source.indexOf("it('drops a name taken", source.indexOf("it('P42O:")));
  assert.doesNotMatch(companion, /nativeDocument|\.engine\.|await capture\(/);
  assert.equal((source.match(/\bit\(/g) ?? []).length, originalDirectItCount + 1);
});

test('explicit reference reads need no candidate git objects and reject wrong origin, revision or dirty sources', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'canvas-official-reference-')); t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = 'packages/web/src/observation.ts';
  mkdirSync(dirname(join(scratch, path)), { recursive: true });
  writeFileSync(join(scratch, path), original(path));
  const calls: string[][] = [];
  // Synthetic read-only git metadata adapter: this checks the reader contract, not a reproduced official checkout.
  const metadata: Record<string, string> = {
    'rev-parse --show-toplevel': scratch,
    'remote get-url origin': 'https://github.com/tester-army/e2e.git',
    'rev-parse HEAD': CANVAS_BASELINE_REVISION,
    'status --porcelain --untracked-files=no': '',
  };
  const adapter = (values: Record<string, string>): ReadGit => (cwd, args) => {
    assert.equal(cwd, scratch); assert.ok(!args.includes('show'));
    calls.push([...args]); assert.ok(Object.hasOwn(values, args.join(' ')));
    return Buffer.from(values[args.join(' ')]!);
  };
  const reader = baselineReader(join(scratch, 'absent-candidate-with-no-git-objects'), scratch, adapter(metadata));
  assert.equal(sha256(reader(path)), manifest.sources.find(source => source.path === path)!.baselineSha256);
  assert.equal(calls.length, 4);
  for (const [key, value] of [
    ['remote get-url origin', 'https://github.com/some-fork/e2e.git'],
    ['rev-parse HEAD', 'f'.repeat(40)],
    ['status --porcelain --untracked-files=no', ' M packages/web/src/observation.ts'],
    ['rev-parse --show-toplevel', dirname(scratch)],
  ]) assert.throws(() => baselineReader('/absent-candidate', scratch, adapter({ ...metadata, [key!]: value! })));
  assert.throws(() => reader('packages/web/../../outside.ts'));
  assert.throws(() => reader('packages/web/src/not-present.ts'));
});


test('the failing native Canvas and wrong SVG remain eligible for baseline capture without other-equals-other proof', async () => {
  const { pairCanvasNative, canvasPairMatches, canvasRolesMatch } = await import('../../packages/web/tests/helpers/canvas-oracle-provenance.ts');
  const pair = pairCanvasNative(new Map([
    ['canvas', { role: 'Canvas' }], ['svg', { role: 'graphics-document' }],
    ['frame', { role: 'iframe' }], ['host', { role: 'textbox' }],
  ]), 'same fixed fixture');
  assert.equal(canvasPairMatches(pair, 'same fixed fixture'), true);
  assert.deepEqual(pair.targets.map(target => target.roleOrdinal), [4, 4, 2, 3]);
  assert.equal(canvasRolesMatch(pair.targets[0]!.roleOrdinal, 0), false);
  assert.equal(canvasRolesMatch(pair.targets[1]!.roleOrdinal, 1), false);
  assert.equal(canvasRolesMatch(4, 4), false);
  assert.equal(canvasRolesMatch(2, 2), true);
  assert.doesNotMatch(JSON.stringify(pair), /Canvas|graphics-document/);
});
