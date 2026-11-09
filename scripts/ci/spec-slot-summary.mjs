#!/usr/bin/env node
/**
 * Per-slot results for the spec test matrix. The matrix job writes one small
 * JSON summary per Node slot; the gate reads them so a red check names the
 * slot and the tests that failed instead of only the job.
 *
 * The parser reads vitest's human report. It never decides the job verdict:
 * the test step's own exit code is the verdict, and this summary only
 * describes it.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FAILURES = 50;
const MAX_REASON = 300;

/** Strip terminal controls; `gh run view --log` exports them as literal `^[` sequences. */
export function clean(line) {
  return line.replace(new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, 'g'), '');
}

/** Drop the job/step/timestamp prefix `gh run view --log` adds to exported logs. */
function stripRunnerPrefix(line) {
  return line.replace(/^(?:[^\t]*\t[^\t]*\t)?\d{4}-\d{2}-\d{2}T\S+Z /, '');
}

/** A text that can be embedded in a markdown table without breaking it. */
function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Read the failed tests and run errors from one vitest log. The e2e CLI runs
 * print their own `FAIL` lines for the child run; only a line naming a
 * `.test.ts` file belongs to the vitest process whose exit code decides the
 * slot. Collection/configuration errors have no FAIL line, so the `Run
 * Errors` section is captured too.
 */
export function parseLog(text) {
  const failures = [];
  const errors = [];
  const seen = new Set();
  const seenErrors = new Set();
  const lines = text.split(/\r?\n/).map(line => stripRunnerPrefix(clean(line)));
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*FAIL\s+(.+?)\s*$/.exec(lines[index]);
    if (match !== null && /\.test\.ts\b/.test(match[1])) {
      const test = match[1];
      if (seen.has(test)) continue;
      seen.add(test);
      if (failures.length >= MAX_FAILURES) continue;
      let reason;
      for (let next = index + 1; next < lines.length && next <= index + 3; next += 1) {
        const line = lines[next].trim();
        if (line === '') continue;
        if (/^[A-Z][A-Z0-9_]{2,}:\s/.test(line)) reason = line.slice(0, MAX_REASON);
        break;
      }
      failures.push(reason === undefined ? { test } : { test, reason });
      continue;
    }
    if (errors.length >= MAX_FAILURES) continue;
    const error = /^\s*ERROR\s+(.+?)\s*$/.exec(lines[index]);
    if (error === null) continue;
    const detail = lines.slice(index + 1, index + 4).map(line => line.trim()).find(line => line !== '' && !/^\s*ERROR\s/.test(line));
    const message = `${error[1]}${detail === undefined ? '' : `: ${detail}`}`.slice(0, MAX_REASON + 100);
    if (seenErrors.has(message)) continue;
    seenErrors.add(message);
    errors.push(message);
  }
  const testFilesFailed = firstMatch(lines, /Test Files\s+(.+?failed.*)$/);
  const testsFailed = firstMatch(lines, /Tests\s+(.+?failed.*)$/);
  return {
    failures,
    errors,
    ...(testFilesFailed === undefined ? {} : { testFilesFailed }),
    ...(testsFailed === undefined ? {} : { testsFailed }),
  };
}

function firstMatch(lines, pattern) {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) return match[1].trim();
  }
  return undefined;
}

/** One slot summary, with the job status as the fallback when no log exists. */
export function summarize({ slot, nodeVersion, jobStatus, exitCode, text }) {
  const parsed = text === undefined ? { failures: [], errors: [] } : parseLog(text);
  const status = exitCode === undefined ? (jobStatus === 'success' ? 'success' : jobStatus) : (exitCode === 0 ? 'success' : 'failure');
  // A passing slot can still print child-process failure text (the e2e CLI runs
  // inside a test). The slot's own verdict decides, so only a failed slot
  // reports the failure lines its log contains.
  const failed = status !== 'success';
  return {
    schemaVersion: 1,
    slot,
    node: nodeVersion,
    status,
    jobStatus,
    exitCode: exitCode ?? null,
    testReached: text !== undefined,
    failures: failed ? parsed.failures : [],
    errors: failed ? parsed.errors : [],
    ...(parsed.testFilesFailed === undefined ? {} : { testFilesFailed: parsed.testFilesFailed }),
    ...(parsed.testsFailed === undefined ? {} : { testsFailed: parsed.testsFailed }),
  };
}

function numericSlot(slot) {
  return slot.split('.').map(part => Number.parseInt(part, 10)).map(value => (Number.isNaN(value) ? 0 : value));
}

/** Natural matrix order, e.g. 22 < 22.22.3 < 24 < 24.8.0 < 26. */
export function compareSlots(a, b) {
  const left = numericSlot(a);
  const right = numericSlot(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.localeCompare(b);
}

/** Read every per-slot summary below dir (artifact downloads keep one directory per slot). */
export function readSummaries(dir) {
  const summaries = [];
  if (!existsSync(dir)) return summaries;
  const walk = directory => {
    for (const entry of readdirSync(directory).toSorted()) {
      const file = path.join(directory, entry);
      const info = statSync(file);
      if (info.isDirectory()) { walk(file); continue; }
      if (!entry.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value !== null && typeof value === 'object' && typeof value.slot === 'string') summaries.push(value);
      } catch { /* A malformed summary cannot hide the other slots; the gate verdict is separate. */ }
    }
  };
  walk(dir);
  return summaries.toSorted((a, b) => compareSlots(a.slot, b.slot));
}

/** Map a matrix job name back to its slot, e.g. `test (22.22.3)` to `22.22.3`. */
export function slotFromJobName(name) {
  const match = /^test \((.+)\)$/.exec(typeof name === 'string' ? name : '');
  return match === null ? undefined : match[1];
}

/** The failure annotations a job produced, naming the exact test that failed. */
export function failureAnnotations(annotations) {
  const seen = new Set();
  const failures = [];
  for (const item of Array.isArray(annotations) ? annotations : []) {
    if (item === null || typeof item !== 'object' || item.annotation_level !== 'failure') continue;
    if (typeof item.title !== 'string' || item.title.trim() === '' || item.path === '.github') continue;
    const test = item.title.trim();
    if (seen.has(test)) continue;
    seen.add(test);
    failures.push({
      test,
      path: item.path,
      line: item.start_line,
      ...(typeof item.message === 'string' ? { reason: item.message.split('\n')[0].slice(0, MAX_REASON) } : {}),
    });
  }
  return failures;
}

/**
 * Read the failure annotations of every failed `test (<slot>)` job through the
 * Actions API. Annotations are authored by the test process, so they name the
 * exact case; the human log stays a fallback for jobs that never reached it.
 */
export async function fetchAnnotations({ repo, run, token, fetchImpl = fetch }) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` };
  const request = async url => {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`https://api.github.com/repos/${repo}/actions/runs/${run}/jobs?per_page=100&page=${page}`);
    jobs.push(...(batch.jobs ?? []));
    if ((batch.jobs ?? []).length < 100) break;
  }
  const slots = {};
  for (const job of jobs) {
    const slot = slotFromJobName(job.name);
    if (slot === undefined || (job.conclusion !== 'failure' && job.conclusion !== 'timed_out')) continue;
    const annotations = [];
    for (let page = 1; ; page += 1) {
      const batch = await request(`https://api.github.com/repos/${repo}/check-runs/${job.id}/annotations?per_page=100&page=${page}`);
      annotations.push(...batch);
      if (batch.length < 100) break;
    }
    const failures = failureAnnotations(annotations);
    if (failures.length > 0) slots[slot] = failures;
  }
  return slots;
}

/** The markdown table the gate prints and writes to the job summary. */
export function render(summaries, needs, annotations = {}) {
  const rows = ['| slot | status | failed tests |', '| --- | --- | --- |'];
  for (const summary of summaries) {
    const named = annotations[summary.slot];
    const parts = Array.isArray(named) && named.length > 0
      ? named.map(({ test, reason }) => `\`${cell(test)}\`${reason === undefined ? '' : ` (${cell(reason)})`}`)
      : summary.failures.map(({ test, reason }) => `\`${cell(test)}\`${reason === undefined ? '' : ` (${cell(reason)})`}`);
    // A failure annotation already names the case; only a slot without one
    // falls back to the log text, which can also quote a child run.
    if (!Array.isArray(named) || named.length === 0) for (const error of summary.errors) parts.push(`error: ${cell(error)}`);
    const failed = parts.length === 0
      ? (summary.status === 'success' ? '—' : 'no failure line in the log')
      : parts.join('<br>');
    rows.push(`| ${summary.slot} | ${summary.status}${summary.testReached ? '' : ' (tests did not start)'} | ${failed} |`);
  }
  const test = needs?.test?.result;
  const missing = test !== undefined && test !== 'success' && test !== 'skipped' && summaries.every(summary => summary.status !== 'failure');
  if (summaries.length === 0) rows.push('| — | — | no per-slot summary was uploaded |');
  const lines = [...rows];
  if (missing) lines.push('', '::warning::The test job failed but no slot summary reports a failure; the job stopped before the tests wrote one.');
  return lines.join('\n');
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) options.set(rest[index].replace(/^--/, ''), rest[index + 1]);
  if (command === 'collect') {
    const log = options.get('log');
    const text = log !== undefined && existsSync(log) ? readFileSync(log, 'utf8') : undefined;
    const exitFile = options.get('exit-file');
    const exitCode = exitFile !== undefined && existsSync(exitFile) ? Number.parseInt(readFileSync(exitFile, 'utf8').trim(), 10) : undefined;
    const summary = summarize({
      slot: options.get('slot'),
      nodeVersion: options.get('node-version') ?? process.version,
      jobStatus: options.get('job-status') ?? 'unknown',
      exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
      text,
    });
    writeFileSync(options.get('output'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`spec slot ${summary.slot}: ${summary.status}, ${summary.failures.length} failed test(s)\n`);
    return;
  }
  if (command === 'annotations') {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined) { process.stderr.write('annotations needs GH_TOKEN\n'); process.exitCode = 2; return; }
    try {
      const slots = await fetchAnnotations({ repo: options.get('repo'), run: options.get('run'), token });
      writeFileSync(options.get('output'), `${JSON.stringify(slots, null, 2)}\n`);
      process.stdout.write(`spec annotations: ${Object.keys(slots).length} slot(s)\n`);
    } catch (cause) {
      // An annotations outage cannot change the verdict; the parsed logs remain.
      process.stderr.write(`::warning::could not read failure annotations: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
    return;
  }
  if (command === 'report') {
    const summaries = readSummaries(options.get('dir') ?? '.');
    let needs;
    try { needs = JSON.parse(options.get('needs') ?? '{}'); } catch { needs = {}; }
    let annotations = {};
    const annotationsFile = options.get('annotations');
    if (annotationsFile !== undefined && existsSync(annotationsFile)) {
      try { annotations = JSON.parse(readFileSync(annotationsFile, 'utf8')); } catch { annotations = {}; }
    }
    const markdown = render(summaries, needs, annotations);
    process.stdout.write(`${markdown}\n`);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## spec per-slot results\n\n${markdown}\n`);
    return;
  }
  process.stderr.write('usage: spec-slot-summary.mjs collect --slot <node> --output <file> | annotations --repo <owner/name> --run <id> --output <file> | report --dir <summaries> [--annotations <file>] --needs <json>\n');
  process.exitCode = 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(cause => { process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`); process.exitCode = 1; });
}
