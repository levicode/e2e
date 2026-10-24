// Data-only preparation. Imports Vitest's pure task-name utilities, never test files.
import assert from 'node:assert/strict';
import { firstCauseManifest } from './first-cause.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [source, output, mode] = process.argv.slice(2);
assert.ok(process.argv.slice(2).length<=3);
const priorEvidence=mode==='--first-cause-two'?undefined:mode;
assert.ok(source && output, 'Usage: node selection.mjs SOURCE OUTPUT [PRIOR_EVIDENCE]');
const originalManifest = JSON.parse(readFileSync(path.join(here, 'runtime-manifest.json')));
const manifest=mode==='--first-cause-two'?firstCauseManifest(originalManifest):originalManifest;
const require = createRequire(path.join(path.resolve(source), 'packages/web/package.json'));
const packageFile = require.resolve('vitest/package.json');
assert.equal(JSON.parse(readFileSync(packageFile)).version, '5.0.1');
const utilsFile = path.join(path.dirname(packageFile), 'dist/task-utils.js');
const { createTaskName, interpretTaskModes } = await import(pathToFileURL(utilsFile));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const key = row => JSON.stringify([row.file, row.fullName]);
const rows = [...manifest.cases, ...manifest.additionalRequiredCases];
assert.equal(manifest.cases.length, 329);
assert.equal(manifest.additionalRequiredCases.length, 4);
assert.equal(new Set(rows.map(key)).size, 333);
for (const [file, digest] of Object.entries(manifest.testSourceSha256)) {
  assert.equal(hash(path.join(source, file)), digest, `Source changed: ${file}`);
}
for (const row of rows) {
  // This is the JSON reporter's exact documented-in-source construction.
  assert.equal([...row.ancestorTitles, row.title].join(' '), row.fullName);
}
const taskName = row => createTaskName([...row.ancestorTitles, row.title]);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeSelection = (candidates, pattern) => {
  const file = { type: 'suite', name: 'synthetic-selection-only', mode: 'run', tasks:
    candidates.map(row => ({ type: 'test', mode: 'run', id: key(row), fullTestName: taskName(row) })) };
  interpretTaskModes(file, pattern, undefined, undefined, undefined, false, false, false);
  return file.tasks.filter(task => task.mode === 'run').map(task => task.id).sort();
};
mkdirSync(output, { recursive: true });
const phases = [];
for (const phase of manifest.phases) {
  const selected = rows.filter(row => row.phase === phase.id);
  assert.equal(selected.length, phase.expectedCount);
  const files = [...new Set(selected.map(row => row.file))].sort();
  const pattern = '^(?:' + selected.map(taskName).map(escape).join('|') + ')$';
  const candidates = rows.filter(row => files.includes(row.file));
  assert.deepEqual(normalizeSelection(candidates, new RegExp(pattern)), selected.map(key).sort());
  const prefix = `packages/${phase.package}/`;
  assert.ok(files.every(file => file.startsWith(prefix)));
  writeFileSync(path.join(output, phase.id + '.regex.txt'), pattern + '\n');
  writeFileSync(path.join(output, phase.id + '.files.txt'), files.map(file => file.slice(prefix.length)).join('\n') + '\n');
  phases.push({ id: phase.id, expected: selected.length, syntheticMatcherSelected: selected.length });
}
let historicalSelected = null;
if (priorEvidence) {
  historicalSelected = {};
  for (const [phase, expected] of Object.entries({ 'original-noncli-304': 283, 'new-4': 4, 'callbacks-14': 14, 'cli-installed-1': 1 })) {
    const report = JSON.parse(readFileSync(path.join(priorEvidence, phase + '.vitest.json')));
    const old = report.testResults.flatMap(suite => suite.assertionResults.map(row => ({
      ...row, file: suite.name.slice(suite.name.indexOf('/packages/') + 1),
    })));
    const pattern = new RegExp(readFileSync(path.join(priorEvidence, phase + '.regex.txt'), 'utf8').trim());
    const selected = normalizeSelection(old, pattern);
    const executed = old.filter(row => !['pending', 'skipped', 'todo', 'disabled'].includes(row.status)).map(key).sort();
    assert.equal(selected.length, expected);
    assert.deepEqual(selected, executed);
    historicalSelected[phase] = selected.length;
  }
}
const audit = { kind: 'synthetic-selector-equivalence-only', runtimeExecuted: false,
  sourceTestsImported: false, expectedOriginal: 329, additionalRequired: 4,
  matcher: { version: '5.0.1', taskUtilsSha256: hash(utilsFile),
    filter: 'createTaskName([ ...ancestorTitles, title ]) uses > separators',
    jsonIdentity: '[ ...ancestorTitles, title ].join(" ") uses spaces' },
  phases, historicalSelected, importedHistoricalOutcomes: 0,
  note: 'Synthetic task objects test selector equivalence only. No test collection, fixture, browser, proof generation, installer or native execution occurred.' };
writeFileSync(path.join(output, 'selector-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit));
