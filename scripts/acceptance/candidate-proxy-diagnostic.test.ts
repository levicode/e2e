/** Selection/receipt and synthetic process cleanup tests. No Cargo, proxy fixture, browser, or socket. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { collectProxyDiagnostics, finalizeProxyReceipt, PROXY_SCENARIOS, PROXY_TEST, proxyCommands, proxyCompilerArtifact, proxyEnvironment, proxyProcessGroup, proxyReportSummary, runProxyCommand } from './candidate-proxy-diagnostic.ts';
import { CANDIDATE_GATES, requireCandidateGates } from './candidate-receipt.ts';

function compilerFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'proxy-compiler-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); const target = join(root, 'target');
  mkdirSync(join(source, 'cli/tests/fixtures'), { recursive: true }); mkdirSync(target);
  const src = join(source, 'cli/tests/fixtures/client_proxy_fixture.rs');
  writeFileSync(src, '// synthetic source, never compiled');
  writeFileSync(join(source, 'cli/Cargo.toml'), '');
  const executable = join(target, 'compiler-chose-this-unpredictable-name');
  writeFileSync(executable, 'not executable code'); chmodSync(executable, 0o700);
  const artifact = { reason: 'compiler-artifact', executable, manifest_path: join(source, 'cli/Cargo.toml'), profile: { test: false }, features: ['acceptance-faults'], target: { name: 'client-proxy-fixture', src_path: src, kind: ['test'] } };
  const stream = (value: unknown = artifact) => [value, { reason: 'build-finished', success: true }].map(item => JSON.stringify(item)).join('\n');
  return { root, source, target, executable, artifact, stream };
}
test('selects the explicit test=false proxy compiler artifact, never a guessed runtime path', t => {
  const f = compilerFixture(t);
  const picked = proxyCompilerArtifact(f.stream(), f.source, f.target);
  assert.equal(picked.executable, f.executable); assert.equal(picked.sha256.length, 64);
  assert.equal(proxyCompilerArtifact(f.stream({ ...f.artifact, profile: { test: true } }), f.source, f.target).executable, f.executable);
  const unrelated = { ...f.artifact, executable: '/ignored/dependency', target: { name: 'dependency', kind: ['lib'] } };
  assert.equal(proxyCompilerArtifact(`${JSON.stringify(unrelated)}\n${f.stream()}`, f.source, f.target).executable, f.executable);
});
test('rejects absent, ambiguous, unsuccessful, wrong-source, wrong-feature, and wrong-kind compilation', t => {
  const f = compilerFixture(t);
  assert.throws(() => proxyCompilerArtifact(JSON.stringify(f.artifact), f.source, f.target), /compilation/);
  assert.throws(() => proxyCompilerArtifact(`${JSON.stringify(f.artifact)}\n${f.stream()}`, f.source, f.target), /ambiguous/);
  assert.throws(() => proxyCompilerArtifact(`${f.stream()}\n{"reason":"build-finished","success":true}`, f.source, f.target), /ambiguous/);
  assert.throws(() => proxyCompilerArtifact(f.stream().replace('"success":true', '"success":false'), f.source, f.target), /Unsuccessful/);
  for (const artifact of [
    { ...f.artifact, features: [] }, { ...f.artifact, features: ['acceptance-faults', 'default'] },
    { ...f.artifact, manifest_path: join(f.root, 'Cargo.toml') },
    { ...f.artifact, target: { ...f.artifact.target, kind: ['bin'] } },
    { ...f.artifact, target: { ...f.artifact.target, src_path: join(f.source, 'cli/src/main.rs') } },
    { ...f.artifact, executable: join(f.root, 'outside') }, { ...f.artifact, executable: 'relative' },
  ]) assert.throws(() => proxyCompilerArtifact(f.stream(artifact), f.source, f.target), /source\/target/);
  assert.throws(() => proxyCompilerArtifact(' '.repeat(8 * 1024 * 1024 + 1), f.source, f.target), /bound/);
});
test('rejects executable symlink escape and a nonexecutable selected file', t => {
  const f = compilerFixture(t); const outside = join(f.root, 'outside');
  writeFileSync(outside, 'not executable code'); chmodSync(outside, 0o700);
  const escape = join(f.target, 'escape'); symlinkSync(outside, escape);
  assert.throws(() => proxyCompilerArtifact(f.stream({ ...f.artifact, executable: escape }), f.source, f.target), /escapes/);
  chmodSync(f.executable, 0o600);
  assert.throws(() => proxyCompilerArtifact(f.stream(), f.source, f.target), /EACCES/);
});

function failureTrace() {
  return { scenario: 'missing-ack', observed: 'cancel-before-result', targetCount: 1, statusCount: 1, cancelCount: 1, ackCount: 0, tsAckCount: 0, resultCount: 1, freshCount: 0, disposalCount: 1, trace: { dropped: 0, records: [
    { source: 'proxy', phase: 'stdin-read', ordinal: 1, bytes: 23, totalBytes: 23, error: null, captureLimit: false },
    { source: 'ts', phase: 'write-return', kind: 'cancel', bytes: 23, writableLength: 0, accepted: true },
  ] } };
}
test('retains existing bounded failure diagnostics and discards raw output', () => {
  const trace = failureTrace();
  const collected = collectProxyDiagnostics(`raw failure message with secret=not-retained\n${JSON.stringify(trace)}\n`);
  assert.deepEqual(collected, { traces: [trace], rejected: 0, emission: 'failure-only' });
  assert.doesNotMatch(JSON.stringify(collected), /secret|not-retained/);
  assert.deepEqual(collectProxyDiagnostics('all tests passed'), { traces: [], rejected: 0, emission: 'failure-only' });
});
test('diagnostic collector rejects payloads, paths, unknown enums, duplicates and oversized captures', () => {
  const trace = failureTrace();
  for (const invalid of [
    { ...trace, frame: { password: 'do not save' } },
    { ...trace, scenario: 'private-site' }, { ...trace, observed: '/private/path' },
    { ...trace, targetCount: -1 },
    { ...trace, trace: { ...trace.trace, records: [{ ...trace.trace.records[0], payload: 'do not save' }] } },
    { ...trace, trace: { ...trace.trace, records: [{ ...trace.trace.records[0], error: 'raw error text' }] } },
    { ...trace, trace: { ...trace.trace, records: [{ source: 'ts', phase: 'request-body' }] } },
    { ...trace, trace: { ...trace.trace, records: Array.from({ length: 257 }, () => trace.trace.records[0]) } },
  ]) assert.deepEqual(collectProxyDiagnostics(JSON.stringify(invalid)), { traces: [], rejected: 1, emission: 'failure-only' });
  const duplicate = collectProxyDiagnostics([trace, trace].map(item => JSON.stringify(item)).join('\n'));
  assert.equal(duplicate.traces.length, 1); assert.equal(duplicate.rejected, 1);
  assert.throws(() => collectProxyDiagnostics(' '.repeat(2 * 1024 * 1024 + 2)), /bound/);
});

test('requires exactly the seven executed passing scenarios, with no skipped control or duplicate', () => {
  const file = '/repo/packages/web/' + PROXY_TEST;
  const report = { success: true, testResults: [{ name: file, status: 'passed', assertionResults: PROXY_SCENARIOS.map(scenario => ({ fullName: `retains authoritative settlement through the production byte proxy: ${scenario}`, status: 'passed' })) }] };
  assert.equal(proxyReportSummary(report, file).length, 7);
  for (let index = 0; index < PROXY_SCENARIOS.length; index++) {
    const missing = structuredClone(report); missing.testResults[0]!.assertionResults.splice(index, 1);
    assert.throws(() => proxyReportSummary(missing, file), /scenarios/);
    const skipped = structuredClone(report); skipped.testResults[0]!.assertionResults[index]!.status = 'skipped';
    assert.throws(() => proxyReportSummary(skipped, file), /skipped/);
  }
  const duplicate = structuredClone(report); duplicate.testResults[0]!.assertionResults[1] = duplicate.testResults[0]!.assertionResults[0]!;
  assert.throws(() => proxyReportSummary(duplicate, file), /scenarios/);
  assert.throws(() => proxyReportSummary(report, '/different/test.ts'), /Unexpected test file/);
});
test('orchestration uses the explicit compile target/config and bounds process groups without changing operation budgets', () => {
  const commands = proxyCommands('/temporary/vitest.json');
  assert.deepEqual(commands.compile, ['test', '--locked', '--profile', 'ci', '--no-default-features', '--features', 'acceptance-faults', '--test', 'client-proxy-fixture', '--no-run', '--message-format=json']);
  assert.deepEqual(commands.test, ['--filter', '@e2e-dev/web', 'exec', 'vitest', 'run', '--config', 'tests/proxy/vitest.config.ts', '--reporter=json', '--outputFile=/temporary/vitest.json']);
  const inherited = { PATH: '/toolchain', E2E_AGENT_BROWSER_EXECUTABLE: '/production', E2E_AGENT_BROWSER_PROXY_FIXTURE: '/stale', AGENT_BROWSER_ACCEPTANCE_PHASE_FILE: '/broker-phase-file', RUSTFLAGS: 'unreviewed', RUSTC_WRAPPER: 'unreviewed' };
  const env = proxyEnvironment(inherited, '/compiler/artifact');
  assert.equal(env['E2E_AGENT_BROWSER_PROXY_FIXTURE'], '/compiler/artifact');
  assert.equal(env['PATH'], '/toolchain');
  for (const key of ['RUSTFLAGS', 'RUSTC_WRAPPER', 'E2E_AGENT_BROWSER_EXECUTABLE', 'AGENT_BROWSER_ACCEPTANCE_PHASE_FILE']) assert.equal(env[key], undefined);
  assert.equal(proxyEnvironment(inherited)['E2E_AGENT_BROWSER_PROXY_FIXTURE'], undefined);
  assert.equal(inherited.E2E_AGENT_BROWSER_EXECUTABLE, '/production');
  const runner = readFileSync(new URL('candidate-proxy-diagnostic.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /spawnSync|spawn\('timeout'/);
  assert.match(runner, /await runProxyCommand\('cargo'.*timeoutMs: 900_000/);
  assert.match(runner, /await runProxyCommand\('pnpm'.*timeoutMs: 240_000/);
});

function processFixture(t: TestContext, mode: 'stdout' | 'stderr' | 'hang') {
  const root = mkdtempSync(join(tmpdir(), 'proxy-process-cleanup-'));
  const leaderPid = join(root, 'leader.pid'); const descendantPid = join(root, 'descendant.pid'); const reaped = join(root, 'reaped');
  // The descendant responds to group TERM; its TERM-ignoring parent stays alive to reap it,
  // then requires group KILL. This avoids orphan zombies depending on a container's PID 1.
  const descendant = `const fs = require('node:fs'); process.on('SIGTERM', () => process.exit(0)); fs.writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const leader = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(leaderPid)}, String(process.pid));
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    child.on('exit', () => fs.writeFileSync(${JSON.stringify(reaped)}, 'yes'));
    child.on('error', () => process.exit(3));
    const ready = setInterval(() => { if (!fs.existsSync(${JSON.stringify(descendantPid)})) return; clearInterval(ready);
      ${mode === 'hang' ? '' : `process.${mode}.write('x'.repeat(4096));`}
    }, 5); setInterval(() => {}, 1000);`;
  let retired = false;
  t.after(() => {
    // Emergency cleanup only; assertions below require the owned runner to have done this first.
    // Never reacquire a numeric group that the runner already observed disappearing.
    if (!retired && existsSync(leaderPid)) proxyProcessGroup(Number(readFileSync(leaderPid, 'utf8'))).signal('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  return { root, leader, descendantPid, reaped, completed: (result: { groupRetired: boolean }) => { retired ||= result.groupRetired; } };
}
const processOptions = (cwd: string) => ({ cwd, env: process.env, timeoutMs: 5_000, maxBuffer: 128, termGraceMs: 500, killGraceMs: 1_500 });
function absent(pid: number | undefined): void {
  assert.ok(pid !== undefined);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
}
for (const stream of ['stdout', 'stderr'] as const) {
  test(`owned proxy group reaps descendants and escalates the leader on ${stream} overflow`, { skip: process.platform !== 'linux' }, async t => {
    const f = processFixture(t, stream);
    const result = await runProxyCommand(process.execPath, ['-e', f.leader], processOptions(f.root));
    f.completed(result);
    assert.equal(result.termination, 'output-limit'); assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.signal, 'SIGKILL'); assert.equal(Buffer.byteLength(result[stream]), 128);
    assert.equal(readFileSync(f.reaped, 'utf8'), 'yes');
    absent(result.pid); absent(Number(readFileSync(f.descendantPid, 'utf8')));
  });
}
test('owned proxy group kills and awaits the entire synthetic tree on timeout', { skip: process.platform !== 'linux' }, async t => {
  const f = processFixture(t, 'hang');
  const result = await runProxyCommand(process.execPath, ['-e', f.leader], { ...processOptions(f.root), timeoutMs: 2_000 });
  f.completed(result);
  assert.equal(result.termination, 'timeout'); assert.equal(result.cleanupConfirmed, true); assert.equal(result.signal, 'SIGKILL');
  assert.equal(readFileSync(f.reaped, 'utf8'), 'yes');
  absent(result.pid); absent(Number(readFileSync(f.descendantPid, 'utf8')));
});
test('owned proxy group kills and awaits the entire synthetic tree on owner interruption', { skip: process.platform !== 'linux' }, async t => {
  const f = processFixture(t, 'hang'); const controller = new AbortController();
  const pending = runProxyCommand(process.execPath, ['-e', f.leader], { ...processOptions(f.root), signal: controller.signal });
  try {
    const end = Date.now() + 3_000;
    while (!existsSync(f.descendantPid) && Date.now() < end) await delay(10);
  } finally { controller.abort(); }
  const result = await pending;
  f.completed(result);
  assert.ok(existsSync(f.descendantPid), 'synthetic descendant registered TERM handling');
  assert.equal(result.termination, 'interrupted'); assert.equal(result.cleanupConfirmed, true); assert.equal(result.signal, 'SIGKILL');
  assert.equal(readFileSync(f.reaped, 'utf8'), 'yes');
  absent(result.pid); absent(Number(readFileSync(f.descendantPid, 'utf8')));
});
test('owned proxy process confirms successful/nonzero exits and launch failure without false success', { skip: process.platform !== 'linux' }, async () => {
  for (const code of [0, 7]) {
    const result = await runProxyCommand(process.execPath, ['-e', `process.stdout.write('synthetic'); process.exitCode = ${code};`], processOptions(tmpdir()));
    assert.equal(result.termination, 'completed'); assert.equal(result.status, code); assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.stdout, 'synthetic'); absent(result.pid);
  }
  const result = await runProxyCommand('/nonexistent/proxy-cleanup-test-command', [], processOptions(tmpdir()));
  assert.equal(result.termination, 'spawn-error'); assert.equal(result.cleanupConfirmed, true); assert.notEqual(result.status, 0);
});
test('pre-interrupted proxy process never spawns and reports the interruption', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runProxyCommand(process.execPath, ['-e', 'throw new Error("must never execute")'], { ...processOptions(tmpdir()), signal: controller.signal });
  assert.equal(result.termination, 'interrupted'); assert.equal(result.cleanupConfirmed, true); assert.equal(result.pid, undefined); assert.equal(result.status, null);
});

test('proxy PGID ownership is permanently retired after an absent probe, even if its number is reused', () => {
  let live = true; const calls: (NodeJS.Signals | 0)[] = [];
  const group = proxyProcessGroup(12345, (_pid, signal) => { calls.push(signal); if (!live) throw Object.assign(new Error('absent'), { code: 'ESRCH' }); });
  assert.equal(group.exists(), true); live = false; assert.equal(group.exists(), false);
  const before = calls.length; live = true;
  group.signal('SIGTERM'); group.signal('SIGKILL'); assert.equal(group.exists(), false);
  assert.equal(group.retired, true); assert.equal(calls.length, before, 'retired groups are never probed or signalled again');
});
test('an ESRCH signal race also permanently retires ownership; unknown probe failures do not', () => {
  const calls: (NodeJS.Signals | 0)[] = [];
  const group = proxyProcessGroup(12345, (_pid, signal) => { calls.push(signal); if (signal !== 0) throw Object.assign(new Error('absent'), { code: 'ESRCH' }); });
  group.signal('SIGTERM'); assert.equal(group.retired, true);
  group.signal('SIGKILL'); assert.equal(group.exists(), false); assert.deepEqual(calls, [0, 'SIGTERM']);
  const uncertain = proxyProcessGroup(12345, () => { throw Object.assign(new Error('unconfirmed'), { code: 'EPERM' }); });
  assert.equal(uncertain.exists(), true); assert.equal(uncertain.retired, false);
});
function processModel() {
  type Model = NonNullable<Parameters<typeof runProxyCommand>[3]>;
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} }) as unknown as Model['child'];
  let live = true; let missingObserved = false; const calls: (NodeJS.Signals | 0)[] = [];
  let resolveMissing!: () => void; const missing = new Promise<void>(resolve => { resolveMissing = resolve; });
  const model: Model = { child, signal: (_pid, signal) => {
    calls.push(signal);
    if (!live) { missingObserved = true; resolveMissing(); throw Object.assign(new Error('absent'), { code: 'ESRCH' }); }
  } };
  return { model, calls, missing, setLive: (value: boolean) => { live = value; }, get missingObserved() { return missingObserved; } };
}
const modelOptions = () => ({ ...processOptions(tmpdir()), timeoutMs: 1_000, termGraceMs: 80, killGraceMs: 80 });
test('early leader exit retires its vanished group while an inherited pipe remains open and cleanup stays unconfirmed', { skip: process.platform !== 'linux' }, async () => {
  const f = processModel(); const pending = runProxyCommand('model-only', [], modelOptions(), f.model);
  (f.model.child.stdout as PassThrough).write('inherited open pipe');
  f.setLive(false); f.model.child.emit('exit', 0, null);
  assert.equal(f.missingObserved, true); const probes = f.calls.length;
  f.setLive(true); // Simulate reuse of the numeric PGID while the escaped pipe holder stays alive.
  const result = await pending;
  assert.equal(result.status, 0); assert.equal(result.groupRetired, true); assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.stdout, 'inherited open pipe'); assert.equal(f.calls.length, probes);
  assert.equal(f.model.child.stdout.destroyed, true); assert.equal(f.model.child.stderr.destroyed, true);
});
test('group disappearance is polled independently of inherited open pipes and permanently cancels later signals', { skip: process.platform !== 'linux' }, async () => {
  const f = processModel(); const pending = runProxyCommand('model-only', [], { ...modelOptions(), termGraceMs: 300, killGraceMs: 50 }, f.model);
  f.model.child.emit('exit', 0, null); // Surviving group and open pipes initiate cleanup.
  f.setLive(false);
  // The poll must retire it before the delayed KILL callback gets a chance to probe it.
  const observed = await Promise.race([f.missing.then(() => true), delay(120).then(() => false)]);
  const probes = f.calls.length; f.setLive(true);
  const result = await pending;
  assert.equal(observed, true, 'group polling must not wait for pipe closure');
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.groupRetired, true);
  assert.equal(f.calls.length, probes); assert.deepEqual(f.calls.filter(value => value !== 0), ['SIGTERM']);
});
test('late pipe closure confirms cleanup without signalling a retired reused group', { skip: process.platform !== 'linux' }, async () => {
  const f = processModel(); const pending = runProxyCommand('model-only', [], modelOptions(), f.model);
  f.setLive(false); f.model.child.emit('exit', 0, null); const probes = f.calls.length;
  f.setLive(true); f.model.child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.groupRetired, true); assert.equal(f.calls.length, probes);
});
test('closed pipes do not claim cleanup when the owned group never disappears', { skip: process.platform !== 'linux' }, async () => {
  const f = processModel(); const pending = runProxyCommand('model-only', [], modelOptions(), f.model);
  f.model.child.emit('exit', 0, null); f.model.child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.termination, 'leftover-processes'); assert.equal(result.cleanupConfirmed, false); assert.equal(result.groupRetired, false);
  assert.deepEqual(f.calls.filter(value => value !== 0), ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});
test('separate receipt cannot turn interrupted, skipped, absent, failed or incomplete execution into success', () => {
  const steps = Object.fromEntries(['toolchain', 'packages', 'native-build', 'fault-build', 'proxy-diagnostic'].map(id => [id, { outcome: 'success' }]));
  const execution = { schemaVersion: 1 as const, kind: 'production-byte-proxy-diagnostic' as const, status: 'passed' as const, stage: 'verified', releaseEligible: false as const, note: 'synthetic only', scenarios: PROXY_SCENARIOS.map(scenario => ({ scenario, status: 'passed' })) };
  assert.equal(finalizeProxyReceipt(steps, execution).status, 'passed');
  assert.equal(finalizeProxyReceipt(steps).status, 'failed');
  assert.equal(finalizeProxyReceipt(steps, { ...execution, stage: 'compile' }).status, 'failed');
  assert.equal(finalizeProxyReceipt(steps, { ...execution, status: 'failed' }).status, 'failed');
  assert.equal(finalizeProxyReceipt(steps, { ...execution, scenarios: [] }).status, 'failed');
  for (const outcome of ['skipped', 'cancelled', 'failure', 'missing']) {
    const result = finalizeProxyReceipt({ ...steps, 'proxy-diagnostic': { outcome } }, execution);
    assert.equal(result.status, outcome === 'skipped' || outcome === 'cancelled' ? 'skipped' : 'failed');
    assert.equal(result.releaseEligible, false);
    assert.match(result.note, /Not native broker execution/);
  }
  assert.equal(finalizeProxyReceipt({ ...steps, 'native-build': { outcome: 'failure' } }, execution).status, 'failed');
});
test('workflow wires an independent diagnostic without substituting or relaxing any mandatory candidate gate', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/native-candidate.yml', import.meta.url), 'utf8');
  assert.equal(workflow.split('id: proxy-diagnostic\n').length, 2);
  const stage = workflow.slice(workflow.indexOf('id: proxy-diagnostic\n'), workflow.indexOf('id: fault-proxy\n'));
  assert.match(stage, /timeout-minutes: 25/);
  assert.match(stage, /!cancelled\(\).*steps.toolchain.outcome == 'success'.*steps.packages.outcome == 'success'.*steps.native-build.outcome == 'success'.*steps.fault-build.outcome == 'success'/);
  assert.doesNotMatch(stage, /steps\.(browsers|native-proxy|semantic-faults)\.outcome/);
  assert.match(stage, /candidate-proxy-diagnostic.ts run .artifacts\/native-source "\$CARGO_TARGET_DIR" "\$RUNNER_TEMP\/native-candidate-bin\/production" "\$RUNNER_TEMP\/native-candidate-bin\/acceptance-faults"/);
  assert.ok(workflow.indexOf('id: native-browser\n') < workflow.indexOf('id: proxy-diagnostic\n'));
  assert.match(workflow, /id: proxy-diagnostic-receipt\n\s+if: \$\{\{ always\(\) }}/);
  assert.ok(workflow.indexOf('id: proxy-diagnostic-receipt\n') < workflow.indexOf('- uses: actions/upload-artifact'));
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.ok(!(CANDIDATE_GATES as readonly string[]).includes('proxy-diagnostic'));
  const complete = Object.fromEntries(CANDIDATE_GATES.map(id => [id, { outcome: 'success' }]));
  requireCandidateGates({ ...complete, 'proxy-diagnostic': { outcome: 'failure' } });
  for (const id of ['source-removal', 'web-browser', 'semantic-faults', 'producer', 'bundle', 'installed']) {
    assert.throws(() => requireCandidateGates({ ...complete, [id]: { outcome: 'failure' }, 'proxy-diagnostic': { outcome: 'success' } }), /missing, skipped or failed/);
  }
});
