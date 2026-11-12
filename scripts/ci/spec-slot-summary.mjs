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
import { loadWhitelist } from './flake-retry.mjs';

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
        // The retry audit file beside a summary also carries a slot; only the
        // summary itself has a status, so the gate reads one row per slot.
        if (value !== null && typeof value === 'object' && typeof value.slot === 'string' && typeof value.status === 'string') summaries.push(value);
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

/**
 * The steps that run each job's tests. A job without one (install, the native
 * runtime producer) has no test execution to lose, so it is not classified.
 */
const TEST_STEPS = [
  [/^test \((.+)\)$/, ['Unit and integration tests']],
  [/^check$/, ['UAT verification app tests', 'Agent skill and CI script tests', 'Testbed']],
  [/^consumers$/, ['Run the reference consumer matrix with exact counts']],
];

/** The test steps of a matrix job, or undefined when the job runs no test. */
export function testSteps(jobName) {
  if (typeof jobName !== 'string') return undefined;
  for (const [pattern, steps] of TEST_STEPS) if (pattern.test(jobName)) return steps;
  return undefined;
}

/** The cause of a failed job by step number: post-job steps carry the highest numbers. */
function firstFailedStep(steps) {
  return steps
    .filter(step => step !== null && typeof step === 'object' && step.conclusion === 'failure')
    .toSorted((left, right) => (left.number ?? 0) - (right.number ?? 0))[0];
}

/**
 * Classify one failed job from its steps and, when no test ran, its log.
 * Infrastructure is a closed list: the first failed step must match an
 * entry's `step` and the log one of its patterns. Everything else that
 * stopped before the test step is unclassified and stays red.
 */
export function classifyJobFailure({ job, log, entries }) {
  const names = testSteps(job?.name);
  if (names === undefined) return undefined;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const test = steps
    .filter(step => step !== null && typeof step === 'object' && names.includes(step.name))
    .toSorted((left, right) => (left.number ?? 0) - (right.number ?? 0));
  const failedTest = test.find(step => step.conclusion === 'failure');
  if (failedTest !== undefined) return { kind: 'test', testsExecuted: true, step: failedTest.name, reason: 'the test step failed' };
  const cancelledTest = test.find(step => step.conclusion === 'cancelled');
  if (cancelledTest !== undefined) {
    // The step started and was interrupted (the 45-minute timeout, a cancelled
    // run). Tests ran, but their outcome is unknown, so it is neither kind.
    return { kind: 'unclassified', testsExecuted: true, outcome: 'unknown', step: cancelledTest.name, reason: 'the test step was cancelled before it finished' };
  }
  const firstFailure = firstFailedStep(steps);
  // A registered environment step decides first: `check` runs preflight tests
  // before its native setup, so a passed preflight step must not hide the
  // setup failure that stopped the suite.
  if (firstFailure !== undefined && typeof log === 'string' && log !== '') {
    const matched = (Array.isArray(entries) ? entries : []).find(entry => entry.step === firstFailure.name
      && Array.isArray(entry.compiled)
      && entry.compiled.length > 0
      && entry.compiled.every(expression => expression.test(log)));
    if (matched !== undefined) {
      return {
        kind: 'infrastructure',
        testsExecuted: false,
        step: firstFailure.name,
        entry: matched.id,
        reason: `${firstFailure.name} failed with the registered environment error of ${matched.id}`,
      };
    }
  }
  const passedTest = test.find(step => step.conclusion === 'success');
  if (passedTest !== undefined) {
    // Tests ran and passed; the job fell over in a later step. That is not a
    // test failure and not this class, so it is reported as unclassified.
    const cause = firstFailure === undefined
      ? (job.conclusion === 'cancelled' ? 'the job was cancelled afterward' : 'the job failed afterward')
      : `${firstFailure.name} failed`;
    return {
      kind: 'unclassified',
      testsExecuted: true,
      ...(firstFailure === undefined ? {} : { step: firstFailure.name }),
      reason: `the test step passed, but ${cause}`,
    };
  }
  const base = {
    kind: 'unclassified',
    testsExecuted: false,
    ...(firstFailure === undefined ? {} : { step: firstFailure.name }),
  };
  if (firstFailure === undefined) return { ...base, reason: 'the job ended without a failed step, so no environment error is recorded' };
  if (typeof log !== 'string' || log === '') return { ...base, reason: `the log of ${firstFailure.name} is unavailable` };
  return { ...base, reason: `${firstFailure.name} carries no registered environment error` };
}

/**
 * Classify every failed test-bearing job of one run. The jobs API supplies the
 * steps; a failed job that never reached its test step reads its log through
 * `readLog`, the only evidence that separates an environment error from a
 * broken setup step.
 */
export async function fetchJobFailureKinds({ repo, run, token, entries, summaries = [], fetchImpl = fetch, readLog }) {
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
  const bySlot = new Map((Array.isArray(summaries) ? summaries : []).map(summary => [summary.slot, summary]));
  const kinds = {};
  for (const job of jobs) {
    if (!['failure', 'timed_out', 'cancelled'].includes(job.conclusion)) continue;
    if (testSteps(job.name) === undefined) continue;
    const slot = slotFromJobName(job.name);
    // The slot summary is the test verdict: its step uses continue-on-error,
    // so the jobs API reports the test step's conclusion as success even when
    // the tests failed. The summary's exit code does not.
    const summary = slot === undefined ? undefined : bySlot.get(slot);
    if (summary?.status === 'failure') {
      kinds[job.name] = { kind: 'test', testsExecuted: true, step: testSteps(job.name)[0], reason: 'the slot summary reports failed tests' };
      continue;
    }
    let verdict = classifyJobFailure({ job, entries });
    // Only a registered environment step can gain from the log; a Lint failure
    // is unclassified without reading it.
    const registered = verdict.kind === 'unclassified' && verdict.step !== undefined
      && entries.some(entry => entry.step === verdict.step && Array.isArray(entry.compiled) && entry.compiled.length > 0);
    if (registered && typeof readLog === 'function') {
      const log = await readLog(job);
      if (typeof log === 'string') verdict = classifyJobFailure({ job, log, entries });
    }
    kinds[job.name] = verdict;
  }
  return kinds;
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

/** The kind column's fixed label: infrastructure, test, or why it is neither. */
function kindLabel(verdict) {
  if (verdict.kind === 'infrastructure') return 'infrastructure (tests did not execute)';
  if (verdict.kind === 'test') return 'test';
  if (verdict.testsExecuted !== true) return 'unclassified (tests did not execute)';
  return verdict.outcome === 'unknown'
    ? 'unclassified (tests executed; outcome unknown)'
    : 'unclassified (tests executed; no test failed)';
}

/** The failure kind cell: what the gate can prove about this slot's failure. */
function failureKindCell(summary, verdict) {
  if (summary.status === 'success') return '—';
  if (verdict !== undefined && verdict !== null) return kindLabel(verdict);
  // A missing classification must not claim tests ran, and must not call an
  // unexplained setup failure infrastructure.
  return summary.testReached ? 'test' : 'unclassified (tests did not execute)';
}

/**
 * Every failed test-bearing job of the run with the proof behind its kind.
 * Only infrastructure is registered; an unclassified job is a defect to
 * investigate, so it is listed without a claim.
 */
function failedJobsSection(kinds) {
  const names = Object.keys(kinds ?? {}).toSorted();
  if (names.length === 0) return [];
  const lines = [
    '### Failed jobs',
    '',
    '| job | kind | failed step | evidence |',
    '| --- | --- | --- | --- |',
  ];
  for (const name of names) {
    const verdict = kinds[name];
    const kind = kindLabel(verdict);
    const step = verdict.step === undefined ? '—' : `\`${cell(verdict.step)}\``;
    const evidence = verdict.entry === undefined ? cell(verdict.reason ?? '') : `\`${cell(verdict.entry)}\``;
    lines.push(`| ${cell(name)} | ${kind} | ${step} | ${evidence} |`);
  }
  const infrastructure = names.filter(name => kinds[name].kind === 'infrastructure');
  if (infrastructure.length > 0) {
    lines.push('', 'An infrastructure failure did not execute any test: it is not a test failure, the known-flake retry does not apply, and the attempt is not one of #25\'s three independent runs. Re-run the failed jobs once.');
    for (const name of infrastructure) {
      lines.push(`::warning::${name}: infrastructure failure (tests did not execute); ${cell(kinds[name].reason ?? '')}`);
    }
  }
  return lines;
}

/** The markdown table the gate prints and writes to the job summary. */
export function render(summaries, needs, annotations = {}, kinds = {}) {
  const rows = ['| slot | status | failure kind | failed tests |', '| --- | --- | --- | --- |'];
  for (const summary of summaries) {
    const named = annotations[summary.slot];
    // A green slot has no failed tests to show, even when its first attempt
    // failed and the known-flake retry below turned it green.
    const parts = summary.status === 'success' ? [] : Array.isArray(named) && named.length > 0
      ? named.map(({ test, reason }) => `\`${cell(test)}\`${reason === undefined ? '' : ` (${cell(reason)})`}`)
      : summary.failures.map(({ test, reason }) => `\`${cell(test)}\`${reason === undefined ? '' : ` (${cell(reason)})`}`);
    // A failure annotation already names the case; only a slot without one
    // falls back to the log text, which can also quote a child run.
    if (summary.status !== 'success' && (!Array.isArray(named) || named.length === 0)) for (const error of summary.errors) parts.push(`error: ${cell(error)}`);
    const failed = parts.length === 0
      ? (summary.status === 'success' ? '—' : 'no failure line in the log')
      : parts.join('<br>');
    const retried = summary.retried === true ? ' (retried)' : '';
    const kind = failureKindCell(summary, kinds[`test (${summary.slot})`]);
    rows.push(`| ${summary.slot} | ${summary.status}${retried} | ${kind} | ${failed} |`);
  }
  const test = needs?.test?.result;
  const classifiedSlot = Object.keys(kinds ?? {}).some(name => name.startsWith('test ('));
  const classifiedInfrastructure = Object.values(kinds ?? {}).some(kind => kind?.kind === 'infrastructure');
  const missing = !classifiedSlot && !classifiedInfrastructure && test !== undefined && test !== 'success' && test !== 'skipped' && summaries.every(summary => summary.status !== 'failure');
  if (summaries.length === 0) rows.push('| — | — | — | no per-slot summary was uploaded |');
  const lines = [...rows];
  const audit = flakeRetryAudit(summaries);
  if (audit.length > 0) lines.push('', '### Known-flake retry audit', '', ...audit);
  const failedJobs = failedJobsSection(kinds);
  if (failedJobs.length > 0) lines.push('', ...failedJobs);
  if (missing) lines.push('', '::warning::The test job failed but no slot summary reports a failure; the job stopped before the tests wrote one.');
  return lines.join('\n');
}

/** One row per slot the bounded flake retry considered: who retried, on what, and the result. */
function flakeRetryAudit(summaries) {
  const rows = [];
  for (const summary of summaries) {
    const retry = summary.flakeRetry;
    if (retry === undefined || retry === null) continue;
    const signatures = Array.isArray(retry.retriedSignatures) && retry.retriedSignatures.length > 0
      ? retry.retriedSignatures
      : Array.isArray(retry.signatures) ? retry.signatures : [];
    const signatureParts = signatures.map(id => `\`${cell(id)}\``);
    for (const unlisted of Array.isArray(retry.unlisted) ? retry.unlisted : []) {
      signatureParts.push(`\`${cell(unlisted.test)}\` (${cell(unlisted.reason ?? 'unlisted')})`);
    }
    const signaturesCell = signatureParts.length === 0 ? '—' : signatureParts.join('<br>');
    const historyNote = retry.history?.status === 'deterministic' ? `, previous run ${retry.history.run}` : '';
    const result = retry.attempted
      ? (retry.exitCode === 0 ? 'passed' : `failed (exit ${retry.exitCode ?? 'unknown'})`)
      : `not retried: ${cell(retry.reason ?? 'unlisted')}${historyNote}`;
    rows.push(`| ${summary.slot} | ${retry.attempted ? 'yes' : 'no'} | ${signaturesCell} | ${result} |`);
  }
  if (rows.length === 0) return [];
  return ['| slot | retried | signature | result |', '| --- | --- | --- | --- |', ...rows];
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
  if (command === 'inspect') {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token === undefined) { process.stderr.write('inspect needs GH_TOKEN\n'); process.exitCode = 2; return; }
    const repo = options.get('repo');
    // One loader for the list, so a bad pattern fails the gate instead of
    // silently missing every signature.
    const entries = loadWhitelist(options.get('whitelist')).entries.filter(entry => entry.kind === 'infrastructure');
    const summaries = options.get('summaries') === undefined ? [] : readSummaries(options.get('summaries'));
    try {
      const kinds = await fetchJobFailureKinds({
        repo,
        run: options.get('run'),
        token,
        entries,
        summaries,
        readLog: job => fetchJobLog({ repo, job, token }),
      });
      writeFileSync(options.get('output'), `${JSON.stringify({ schemaVersion: 1, run: Number(options.get('run')), jobs: kinds }, null, 2)}\n`);
      process.stdout.write(`spec job kinds: ${Object.keys(kinds).length} failed job(s) classified\n`);
    } catch (cause) {
      // The gate's verdict is the job results; a classification outage must not
      // hide them, so it warns and leaves the table to the log fallback.
      process.stderr.write(`::warning::could not classify failed jobs: ${cause instanceof Error ? cause.message : String(cause)}\n`);
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
    let kinds = {};
    const kindsFile = options.get('kinds');
    if (kindsFile !== undefined && existsSync(kindsFile)) {
      try { kinds = JSON.parse(readFileSync(kindsFile, 'utf8')).jobs ?? {}; } catch { kinds = {}; }
    }
    const markdown = render(summaries, needs, annotations, kinds);
    process.stdout.write(`${markdown}\n`);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## spec per-slot results\n\n${markdown}\n`);
    return;
  }
  process.stderr.write('usage: spec-slot-summary.mjs collect --slot <node> --output <file> | annotations --repo <owner/name> --run <id> --output <file> | inspect --repo <owner/name> --run <id> --whitelist <file> [--summaries <dir>] --output <file> | report --dir <summaries> [--annotations <file>] [--kinds <file>] --needs <json>\n');
  process.exitCode = 2;
}

/**
 * Read one completed job's log over REST. `gh run view --log` refuses while the
 * run is in progress, and the gate is the last job of the run it inspects, so
 * the jobs endpoint is the only source: it answers once the job is complete,
 * whatever the run status.
 */
export async function fetchJobLog({ repo, job, token, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return await response.text();
  } catch (cause) {
    process.stderr.write(`::warning::could not read the log of ${job.name}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return undefined;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(cause => { process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`); process.exitCode = 1; });
}
