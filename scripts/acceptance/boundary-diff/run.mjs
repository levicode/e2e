#!/usr/bin/env node
/**
 * Boundary-diff table runner (#23 / #159).
 *
 * Runs every case in cases.mjs through the old Playwright 1.64.1 driver and the
 * native agent-browser Web engine on the same Chromium, one child process per
 * case and engine, so a hanging boundary becomes a table cell instead of a
 * stuck run. Prints a markdown table, and can write the raw results as JSON.
 *
 * Usage:
 *   E2E_AGENT_BROWSER_EXECUTABLE=/abs/path/to/agent-browser \
 *   BOUNDARY_DIFF_CHROMIUM=/abs/path/to/chrome \
 *   node scripts/acceptance/boundary-diff/run.mjs --json /tmp/boundary-diff.json
 *
 * Options: --only <case|family>  --engine new|old  --timeout <ms>  --list
 *
 * Verdicts: `narrowed` (old succeeds, new fails), `widened` (old fails, new
 * succeeds), `same` (both succeed), `both-fail` (neither can do it), `new-hang`
 * (new did not answer inside the watchdog), `old-hang`, `old-cannot` (the old
 * API has no way to express the scenario, so the row cannot be a narrowing).
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MEASURE = resolve(HERE, 'measure.mjs');
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index === -1 ? undefined : args[index + 1]; };
const ONLY = option('only');
const ONLY_ENGINE = option('engine');
const TIMEOUT = Number(option('timeout') ?? 120_000);
const JSON_OUT = option('json');

if (args.includes('--list')) {
  for (const [id, definition] of Object.entries(CASES)) console.log(`${definition.family}\t${id}`);
  process.exit(0);
}

const ids = Object.keys(CASES).filter((id) => ONLY === undefined || id === ONLY || CASES[id].family === ONLY);
if (ids.length === 0) {
  console.error(`no case matches --only ${ONLY}`);
  process.exit(2);
}
const engines = ONLY_ENGINE === undefined ? ['old', 'new'] : [ONLY_ENGINE];

/** Run one case on one engine in a child process with a hard watchdog. */
function measure(id, engine) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [MEASURE, '--case', id, '--engine', engine], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // The native proxy starts each browser daemon detached; a timed-out case
      // must not leave it behind. `e2e-` is the only prefix this engine uses.
      spawnSync('pkill', ['-f', 'agent-browser --session e2e-'], { stdio: 'ignore' });
    }, TIMEOUT);
    once(child, 'close').then(() => {
      clearTimeout(timer);
      const line = output.split('\n').find((entry) => entry.startsWith('RESULT:'));
      if (line === undefined) { done({ status: 'hang', message: `no result in ${TIMEOUT}ms`, raw: output.trim().slice(-400) }); return; }
      try { done(JSON.parse(line.slice('RESULT:'.length))); }
      catch (error) { done({ status: 'hang', message: `unreadable result: ${error.message}` }); }
    });
  });
}

const describe = (measurement) => {
  if (measurement === undefined) return 'not run';
  const outcome = measurement.outcome;
  if (outcome === undefined) return `${measurement.status ?? 'hang'}${measurement.message === undefined ? '' : `: ${measurement.message}`}`;
  if (outcome.status === 'ok') return `ok (${outcome.value}${outcome.ms === undefined ? '' : `, ${outcome.ms}ms`})`;
  return `${outcome.code}: ${outcome.message}`;
};

const cleanupText = (measurement) => {
  if (measurement?.outcome === undefined) return '-';
  const usable = measurement.usable === true ? 'usable' : 'unusable';
  const cleanup = measurement.cleanup ?? {};
  return `${usable}; ${Object.entries(cleanup).map(([key, value]) => `${key}=${value}`).join('; ')}`;
};

const verdict = (definition, oldResult, newResult) => {
  if (newResult?.status === 'hang' && oldResult?.status === 'hang') return 'both-hang';
  if (newResult?.status === 'hang') return 'new-hang';
  if (oldResult?.status === 'hang') return 'old-hang';
  const oldOk = oldResult?.outcome?.status === 'ok';
  const newOk = newResult?.outcome?.status === 'ok';
  if (definition.oldCannot === true) return newOk ? 'old-cannot' : 'both-fail';
  if (oldOk && newOk) return 'same';
  if (oldOk && !newOk) return 'narrowed';
  if (!oldOk && newOk) return 'widened';
  return 'both-fail';
};

const severity = { narrowed: 0, 'both-hang': 1, 'new-hang': 2, 'old-hang': 3, 'old-cannot': 4, 'both-fail': 5, widened: 6, same: 7 };
const rows = [];
for (const id of ids) {
  const definition = CASES[id];
  const measurements = {};
  for (const engine of engines) {
    measurements[engine] = await measure(id, engine);
    const label = measurements[engine].outcome === undefined ? measurements[engine].status : measurements[engine].outcome.status;
    console.error(`${engine.padEnd(3)} ${id}: ${label}`);
  }
  rows.push({ id, family: definition.family, scenario: definition.scenario, old: measurements.old, new: measurements.new, verdict: verdict(definition, measurements.old, measurements.new) });
}

const families = [...new Set(rows.map((row) => row.family))];
const lines = ['| Family | Case | Scenario | Old (Playwright 1.64.1) | New (native) | Verdict | New cleanup |', '|---|---|---|---|---|---|---|'];
for (const family of families) {
  for (const row of rows.filter((entry) => entry.family === family)) {
    lines.push(`| ${row.family} | ${row.id} | ${row.scenario} | ${describe(row.old)} | ${describe(row.new)} | ${row.verdict} | ${cleanupText(row.new)} |`);
  }
}
lines.push('', '| Verdict | Cases |', '|---|---|');
for (const [key] of Object.entries(severity)) {
  const matching = rows.filter((row) => row.verdict === key).map((row) => row.id);
  if (matching.length > 0) lines.push(`| ${key} | ${matching.join(', ')} |`);
}
const table = lines.join('\n');
console.log(table);
if (JSON_OUT !== undefined) writeFileSync(JSON_OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
