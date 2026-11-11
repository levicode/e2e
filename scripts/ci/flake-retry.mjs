#!/usr/bin/env node
/**
 * One bounded retry for a slipped spec test slot.
 *
 * The spec matrix runs five Node slots. A slot can fail because the change is
 * broken (a deterministic failure, which must stay red) or because the matrix's
 * own load exposed a signature that `scripts/ci/known-flakes.json` lists. Only
 * the second kind is retried, only once per slot per run, and only when the
 * same slot did not already end red with a listed signature on the previous
 * completed run at the same head, which makes it deterministic.
 *
 * The retry reruns the failed test files of that slot, through the same
 * pinned-native fixture wrapper the first attempt used, so the environment is
 * identical. Every decision is written into the slot summary and printed by
 * the gate: which slot retried, on which signature, and what the retry did.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BLOCK_CHARS = 200_000;
const MAX_REASON = 300;

/** Strip terminal controls, also the literal `^[` sequences an exported log uses. */
function cleanLine(line) {
  return line.replace(new RegExp(`(?:${String.fromCharCode(27)}|\\^\\[)\\[[0-9;]*m`, 'g'), '');
}

/** Drop the job/step/timestamp prefix `gh run view --log` adds to exported logs. */
function stripRunnerPrefix(line) {
  return line.replace(/^(?:[^\t]*\t[^\t]*\t)?\d{4}-\d{2}-\d{2}T\S+Z /, '');
}

/**
 * The vitest failure text of each failed test file, keyed by the test string
 * the per-slot summary uses (`integration  tests/integration/x.test.ts > ...`).
 * Child e2e CLI `FAIL` lines carry no `.test.ts` and are not vitest failures.
 */
export function failureBlocks(text) {
  const blocks = new Map();
  if (typeof text !== 'string') return blocks;
  const lines = text.split(/\r?\n/).map(line => stripRunnerPrefix(cleanLine(line)));
  let current;
  let collected = [];
  const flush = () => {
    if (current !== undefined) blocks.set(current, collected.join('\n').slice(0, MAX_BLOCK_CHARS));
    current = undefined;
    collected = [];
  };
  for (const line of lines) {
    const match = /^\s*FAIL\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      if (!/\.test\.ts\b/.test(match[1])) continue;
      current = match[1].trim();
      collected = [line];
      continue;
    }
    if (current !== undefined) collected.push(line);
  }
  flush();
  return blocks;
}

/** Read and validate the whitelist; a bad pattern fails the run, never silently misses. */
export function loadWhitelist(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(value.entries)) throw new Error(`${file} has no entries array`);
  for (const entry of value.entries) {
    if (typeof entry.id !== 'string' || entry.id === '') throw new Error(`${file} has an entry without an id`);
    // Test signatures opt a failure into the retry; infrastructure entries
    // carry the patterns the gate uses to prove no test ran.
    if (entry.kind === 'test-signature' && (!Array.isArray(entry.patterns) || entry.patterns.length === 0)) {
      throw new Error(`${entry.id} has no patterns`);
    }
    // A step alone cannot prove the environment error; the log must match.
    if (entry.step !== undefined && (!Array.isArray(entry.patterns) || entry.patterns.length === 0)) {
      throw new Error(`${entry.id} names a step without patterns`);
    }
    if (Array.isArray(entry.patterns)) entry.compiled = entry.patterns.map(pattern => new RegExp(pattern));
  }
  return value;
}

/** Only a retryable test-signature entry can make a failure retryable. */
export function matchEntry(text, entries) {
  for (const entry of entries) {
    if (entry.kind !== 'test-signature' || entry.retryable !== true) continue;
    const expressions = entry.compiled ?? entry.patterns.map(pattern => new RegExp(pattern));
    if (expressions.every(expression => expression.test(text))) return entry;
  }
  return undefined;
}

/** The first line of a failure block that is not the FAIL header, for the audit. */
function failureLine(block) {
  for (const line of block.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.slice(0, MAX_REASON);
  }
  return 'no error text';
}

/** The leading failed count of a vitest summary, e.g. `1 failed | 180 passed (181)`. */
function failedCount(text) {
  const match = /^(\d+) failed\b/.exec(typeof text === 'string' ? text.trim() : '');
  return match === null ? undefined : Number(match[1]);
}

/**
 * The summary's own vitest totals must account for exactly the failed tests
 * and files it names. A file that failed to collect produces no `FAIL
 * ...test.ts` line, so without this check a retry of a listed file could green
 * the slot while that file never ran.
 */
export function failureAccounting(summary) {
  const failures = Array.isArray(summary?.failures) ? summary.failures : [];
  if (failures.length === 0) return undefined;
  const failedFiles = failedCount(summary?.testFilesFailed);
  const failedTests = failedCount(summary?.testsFailed);
  if (failedFiles === undefined || failedTests === undefined) return 'the log has no vitest failed-test totals to compare with the failures it names';
  const files = new Set();
  for (const failure of failures) {
    const parsed = /^(\S+)\s+(\S+\.test\.ts)\b/.exec(failure.test ?? '');
    if (parsed !== null) files.add(parsed[2]);
  }
  if (failedTests !== failures.length) return `the log reports ${failedTests} failed test(s) but only ${failures.length} failed test name(s) were parsed`;
  if (failedFiles !== files.size) return `the log reports ${failedFiles} failed test file(s) but only ${files.size} were parsed`;
  return undefined;
}

/** Classify every failure the slot summary reports against the whitelist. */
export function classifyFailures({ summary, blocks, entries, log }) {
  const failures = Array.isArray(summary?.failures) ? summary.failures : [];
  const matched = [];
  const unlisted = [];
  for (const failure of failures) {
    const block = blocks.get(failure.test);
    if (block === undefined) {
      unlisted.push({ test: failure.test, reason: 'the log has no vitest failure block for this test' });
      continue;
    }
    const entry = matchEntry(block, entries);
    if (entry === undefined) {
      unlisted.push({ test: failure.test, reason: failureLine(block) });
      continue;
    }
    if (!matched.some(item => item.id === entry.id)) matched.push({ id: entry.id, test: failure.test, signature: entry.signature });
  }
  const accounting = failureAccounting(summary);
  if (accounting !== undefined) unlisted.push({ test: 'slot summary', reason: accounting });
  if (typeof log === 'string' && /(?:^|\n)\s*Unhandled Errors\b/.test(log)) {
    unlisted.push({ test: 'slot summary', reason: 'the log has a vitest Unhandled Errors section' });
  }
  return { matched, unlisted };
}

/** One package and project per retry command, with its failed test files. */
function packageDirectories(root) {
  const packages = path.join(root, 'packages');
  if (!existsSync(packages)) return [];
  const directories = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packages, entry.name);
    const manifest = path.join(directory, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
      if (typeof name === 'string') directories.push({ directory, name });
    } catch { /* A package without a readable manifest cannot own a test file. */ }
  }
  return directories;
}

/**
 * Resolve the failed test files to the package that owns them. A path that
 * exists in no package, or in more than one, is not retried: guessing a
 * package could run the wrong suite and turn the verdict into noise.
 */
export function retryTargets(failures, root) {
  const directories = packageDirectories(root);
  const groups = new Map();
  const rejected = [];
  for (const failure of failures) {
    const parsed = /^(\S+)\s+(\S+\.test\.ts)\b/.exec(failure.test ?? '');
    if (parsed === null) {
      rejected.push({ test: failure.test, reason: 'the test name has no project and test file' });
      continue;
    }
    const [, project, file] = parsed;
    if (!['unit', 'integration'].includes(project) || !/^[\w./-]+\.test\.ts$/.test(file) || file.split('/').includes('..')) {
      rejected.push({ test: failure.test, reason: 'the test name is not a package-relative test file' });
      continue;
    }
    const owners = directories.filter(owner => existsSync(path.join(owner.directory, file)));
    if (owners.length !== 1) {
      rejected.push({ test: failure.test, reason: `${file} exists in ${owners.length} packages` });
      continue;
    }
    const owner = owners[0];
    const key = `${owner.name}\u0000${project}`;
    const group = groups.get(key) ?? { packageName: owner.name, project, files: new Set() };
    group.files.add(file);
    groups.set(key, group);
  }
  return { groups: [...groups.values()].map(group => ({ ...group, files: [...group.files].toSorted() })), rejected };
}

/** Quote one shell word for the `sh -c` the fixture wrapper starts. */
function shellQuote(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The retry commands, one vitest invocation per package and project. */
export function buildShellScript(groups) {
  return groups
    .map(group => `pnpm --filter ${shellQuote(group.packageName)} exec vitest run --project ${shellQuote(group.project)} ${group.files.map(shellQuote).join(' ')}`)
    .join(' && ');
}

/**
 * The root `test` script's commands after the web package. The first attempt
 * is an `&&` chain: a failure in e2e or web stops it there, so every later
 * package never ran. A retry that only reruns the failed files would green
 * the slot with those packages unrun; they run before the slot can pass.
 */
export function trailingCommands(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const script = typeof manifest?.scripts?.test === 'string' ? manifest.scripts.test : '';
  const commands = script.split('&&').map(part => part.trim()).filter(part => part !== '');
  const web = commands.findIndex(command => /--filter @e2e-dev\/web\b/.test(command));
  return web === -1 ? [] : commands.slice(web + 1);
}

/** The fixture wrapper invocation that reproduces the first attempt's environment. */
export function retryInvocation(groups, env = process.env, root = process.cwd()) {
  const script = [buildShellScript(groups), ...trailingCommands(root)].filter(part => part !== '').join(' && ');
  if (script === '') throw new Error('no retry command to run');
  const fields = [
    ['productionDirectory', 'PRODUCTION_RUNTIME_DIR'],
    ['productionDigest', 'PRODUCTION_MANIFEST_SHA256'],
    ['productionAttempt', 'PRODUCTION_RUN_ATTEMPT'],
    ['faultDirectory', 'FAULT_RUNTIME_DIR'],
    ['faultDigest', 'FAULT_MANIFEST_SHA256'],
    ['faultAttempt', 'FAULT_RUN_ATTEMPT'],
    ['evidenceDirectory', 'RETRY_EVIDENCE_DIR'],
  ];
  const values = {};
  for (const [field, name] of fields) {
    const value = env[name];
    if (typeof value !== 'string' || value === '') throw new Error(`the retry needs ${name}`);
    values[field] = value;
  }
  return {
    command: process.execPath,
    args: [
      'scripts/ci/spec-fixture-runtime.ts',
      values.productionDirectory, values.productionDigest, values.productionAttempt,
      values.faultDirectory, values.faultDigest, values.faultAttempt,
      values.evidenceDirectory, '--', 'sh', '-c', script,
    ],
  };
}

/**
 * The previous completed spec run at the same head decides whether this
 * failure is already deterministic. The slot retried in that run counts as
 * deterministic only when that run still ended red under a listed signature
 * after its own retry; a retry that passed is a flake that was handled, not a
 * second deterministic failure.
 */
export async function previousSlotVerdict({ repo, run, slot, entries, token, fetchImpl = fetch }) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token ?? ''}` };
  const request = async (url) => {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };
  const current = await request(`https://api.github.com/repos/${repo}/actions/runs/${run}`);
  // The run record's head, not `GITHUB_SHA`: on a pull_request event the
  // workflow runs on the merge commit while the run reports the PR head.
  const history = await request(`https://api.github.com/repos/${repo}/actions/workflows/${current.workflow_id}/runs?head_sha=${encodeURIComponent(current.head_sha)}&per_page=50`);
  // Order by creation time and then by run id, so two dispatches created in
  // the same second still have a predecessor rather than neither counting.
  const before = candidate => candidate.created_at < current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
  const previous = (history.workflow_runs ?? [])
    .filter(candidate => candidate.id !== current.id
      && candidate.head_sha === current.head_sha
      && ['success', 'failure'].includes(candidate.conclusion)
      && before(candidate))
    .toSorted((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id)[0];
  if (previous === undefined) return { status: 'none' };
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`https://api.github.com/repos/${repo}/actions/runs/${previous.id}/jobs?per_page=100&page=${page}`);
    jobs.push(...(batch.jobs ?? []));
    if ((batch.jobs ?? []).length < 100) break;
  }
  const job = jobs.find(candidate => candidate.name === `test (${slot})`);
  if (job === undefined) return { status: 'none', run: previous.id };
  if (job.conclusion !== 'failure') return { status: 'green', run: previous.id, conclusion: job.conclusion };
  const annotations = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(`https://api.github.com/repos/${repo}/check-runs/${job.id}/annotations?per_page=100&page=${page}`);
    annotations.push(...batch);
    if (batch.length < 100) break;
  }
  const failures = annotations.filter(annotation => annotation.annotation_level === 'failure'
    && annotation.path !== '.github' && typeof annotation.title === 'string' && annotation.title.trim() !== '');
  if (failures.length === 0) return { status: 'unknown', run: previous.id, job: job.id };
  const signatures = [];
  for (const failure of failures) {
    const entry = matchEntry(`${failure.title}\n${annotationMessage(failure.message)}`, entries);
    if (entry === undefined) return { status: 'unlisted', run: previous.id, job: job.id };
    if (!signatures.includes(entry.id)) signatures.push(entry.id);
  }
  return { status: 'deterministic', run: previous.id, job: job.id, signatures };
}

/** The text an annotation reports, whether it is a string or a structured value. */
function annotationMessage(message) {
  if (typeof message === 'string') return message;
  if (message === null || message === undefined) return '';
  return JSON.stringify(message);
}

/**
 * Apply one decision to the slot summary: a passed retry makes the slot
 * success and keeps the first attempt and the retry under `flakeRetry`, so the
 * gate can print both. Nothing is dropped: the original failure list moves
 * into the audit instead of staying at the top level.
 */
export function finalizeSummary(summary, decision) {
  const retry = {
    attempted: decision.attempted,
    reason: decision.reason,
    signatures: decision.signatures ?? [],
    ...(decision.unlisted === undefined ? {} : { unlisted: decision.unlisted }),
    ...(decision.history === undefined ? {} : { history: decision.history }),
    ...(decision.retriedSignatures === undefined ? {} : { retriedSignatures: decision.retriedSignatures }),
    ...(decision.exitCode === undefined ? {} : { exitCode: decision.exitCode }),
    ...(decision.durationMs === undefined ? {} : { durationMs: decision.durationMs }),
    ...(decision.retryLog === undefined ? {} : { log: decision.retryLog }),
    ...(decision.retryFailures === undefined ? {} : { retryFailures: decision.retryFailures }),
  };
  const passed = decision.attempted && decision.exitCode === 0;
  return {
    ...summary,
    status: passed ? 'success' : summary.status,
    ...(passed ? { retried: true } : {}),
    ...(decision.attempted ? { firstAttempt: { status: summary.status, failures: summary.failures ?? [], errors: summary.errors ?? [] } } : {}),
    flakeRetry: retry,
    ...(passed ? { failures: [], errors: [] } : {}),
  };
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    if (key === '--dry-run') { options.set('dry-run', '1'); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (value === undefined || value === '') throw new Error(`missing --${name}`);
  return value;
}

/** Run the one retry and return its exit code and combined log. */
function runRetry(groups, root, logFile) {
  const invocation = retryInvocation(groups, process.env, root);
  const startedAt = Date.now();
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, env: { ...process.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error === undefined ? '' : `\nretry could not start: ${result.error.message}\n`}`;
  writeFileSync(logFile, text);
  return { exitCode: result.status ?? 1, durationMs: Date.now() - startedAt };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'retry') {
    process.stderr.write('usage: flake-retry.mjs retry --slot <node> --summary <file> --log <file> --repo <owner/name> --run <id> --whitelist <file> --output <file> [--retry-log <file>] [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const options = parseArgs(rest);
  const root = process.cwd();
  const slot = required(options, 'slot');
  const summaryFile = required(options, 'summary');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const whitelist = loadWhitelist(required(options, 'whitelist'));
  const entries = whitelist.entries;
  const logFile = required(options, 'log');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const blocks = failureBlocks(log);
  const classified = classifyFailures({ summary, blocks, entries, log });
  const retryLog = options.get('retry-log') ?? path.join(path.dirname(summaryFile), `spec-retry-${slot}.log`);
  const decision = {
    attempted: false,
    reason: '',
    signatures: classified.matched.map(item => item.id),
    ...(classified.unlisted.length === 0 ? {} : { unlisted: classified.unlisted }),
  };
  if ((summary.failures ?? []).length === 0) {
    decision.reason = 'no failed test file to retry';
  } else if (classified.unlisted.length > 0) {
    decision.reason = 'a failure is not in the known-flake list';
  } else {
    const targets = retryTargets(summary.failures, root);
    if (targets.rejected.length > 0) {
      decision.reason = 'a failed test file does not resolve to one package';
      decision.unlisted = targets.rejected;
    } else {
      try {
        const history = options.has('dry-run')
          ? { status: 'skipped' }
          : await previousSlotVerdict({
            repo: required(options, 'repo'),
            run: required(options, 'run'),
            slot,
            entries,
            token: process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'],
          });
        decision.history = history;
        if (history.status === 'deterministic') {
          decision.reason = `the previous run at this head ended red in this slot with a listed signature (run ${history.run})`;
        } else {
          decision.attempted = true;
          decision.reason = 'all failures match the known-flake list';
          decision.retriedSignatures = classified.matched.map(item => item.id);
          if (options.has('dry-run')) {
            decision.reason = 'dry run: the retry command was resolved but not run';
          } else {
            const result = runRetry(targets.groups, root, retryLog);
            decision.exitCode = result.exitCode;
            decision.durationMs = result.durationMs;
            decision.retryLog = path.basename(retryLog);
            if (result.exitCode !== 0) {
              const retried = failureBlocks(readFileSync(retryLog, 'utf8'));
              decision.retryFailures = (JSON.parse(readFileSync(summaryFile, 'utf8')).failures ?? [])
                .map(failure => failure.test)
                .filter(test => retried.has(test));
            }
          }
        }
      } catch (cause) {
        // An unavailable history or retry is reported, not hidden: a stale
        // API call must not turn a red slot green, and a warning keeps the
        // missing evidence visible in the gate summary.
        decision.reason = `the retry could not be decided: ${cause instanceof Error ? cause.message : String(cause)}`;
        process.stderr.write(`::warning::flake retry slot ${slot}: ${decision.reason}\n`);
      }
    }
  }
  const updated = finalizeSummary(summary, decision);
  writeJson(summaryFile, updated);
  writeJson(required(options, 'output'), { schemaVersion: 1, slot, ...updated.flakeRetry });
  const outcome = options.has('dry-run')
    ? 'dry run'
    : decision.attempted ? (decision.exitCode === 0 ? 'passed' : 'failed') : `not retried (${decision.reason})`;
  process.stdout.write(`flake retry slot ${slot}: ${outcome}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(cause => {
    process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
