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
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

if (ONLY_ENGINE !== undefined && ONLY_ENGINE !== 'old' && ONLY_ENGINE !== 'new') {
  console.error(`--engine must be old or new, got ${ONLY_ENGINE}`);
  process.exit(2);
}
if (!Number.isFinite(TIMEOUT) || TIMEOUT <= 0) {
  console.error(`--timeout must be a positive number of milliseconds, got ${option('timeout')}`);
  process.exit(2);
}

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

/**
 * A case may leave its detached native daemon behind when the engine could not
 * prove cleanup. Its socket dir is named after the case process, so kill the
 * daemon pid it recorded and the proxy that names the same session, then drop
 * the dir.
 */
function reap(child) {
  const socketDir = `/tmp/boundary-diff-${child.pid}`;
  const sessions = new Set();
  try {
    for (const file of readdirSync(socketDir)) {
      if (!file.endsWith('.pid')) continue;
      const session = file.slice(0, -'.pid'.length);
      sessions.add(session);
      try { process.kill(Number(readFileSync(join(socketDir, file), 'utf8').trim()), 'SIGKILL'); } catch {}
    }
  } catch {}
  for (const session of sessions) spawnSync('pkill', ['-f', `agent-browser --session ${session}`], { stdio: 'ignore' });
  try { rmSync(socketDir, { recursive: true, force: true }); } catch {}
}

/** Run one case on one engine in a child process with a hard watchdog. */
function measure(id, engine) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [MEASURE, '--case', id, '--engine', engine], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Ask the case process to close its browser first. Playwright installs a
      // SIGTERM handler that closes its contexts; the detached native daemon
      // is reaped after the case process exits.
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 5_000);
    }, TIMEOUT);
    once(child, 'close').then(() => {
      clearTimeout(timer);
      reap(child);
      // A signal at the watchdog can make a case write a failure result; that
      // failure is the kill, not a measurement.
      if (timedOut) { done({ status: 'hang', message: `no result before ${TIMEOUT}ms; the watchdog killed the case`, raw: output.trim().slice(-400) }); return; }
      const line = output.split('\n').find((entry) => entry.startsWith('RESULT:'));
      if (line === undefined) { done({ status: 'hang', message: `no result in ${TIMEOUT}ms`, raw: output.trim().slice(-400) }); return; }
      try { done(JSON.parse(line.slice('RESULT:'.length))); }
      catch (error) { done({ status: 'hang', message: `unreadable result: ${error.message}` }); }
    });
  });
}

const describe = (measurement) => {
  if (measurement === undefined) return 'not run';
  if (measurement.setup !== undefined) return `setup failed: ${measurement.setup.code}: ${measurement.setup.message}`;
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
  if (oldResult?.setup !== undefined || newResult?.setup !== undefined) return 'setup-failed';
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

const severity = { 'setup-failed': 0, narrowed: 1, 'both-hang': 2, 'new-hang': 3, 'old-hang': 4, 'old-cannot': 5, 'both-fail': 6, widened: 7, same: 8 };
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
const broken = rows.filter((row) => row.verdict === 'setup-failed' || row.verdict.includes('hang'));
process.exitCode = broken.length > 0 ? 3 : 0;
