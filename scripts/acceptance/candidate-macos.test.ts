/** Source/orchestration regression only; synthetic fixtures are never macOS execution evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { candidateRevision } from './candidate-revision.ts';
import { candidateWorkflowRecipe } from './candidate-producer.ts';

const lock = { schemaVersion: 1, repository: 'levicode/agent-browser', commit: 'a'.repeat(40), benchmarkSweep: false };
const workflow = readFileSync(new URL('../../.github/workflows/native-macos-candidate.yml', import.meta.url), 'utf8');

test('only exact Linux and macOS opt-in push branches select the committed native lock', () => {
  for (const branch of ['native-full-ci', 'native-macos-ci']) {
    const ref = `refs/heads/implement/${branch}`;
    assert.deepEqual(candidateRevision(lock, 'push', ref, '', ''), { sha: lock.commit, benchmarkSweep: false });
    assert.throws(() => candidateRevision(lock, 'push', ref, 'b'.repeat(40)), /overrides/);
    assert.throws(() => candidateRevision(lock, 'push', ref, '', 'true'), /overrides/);
    assert.throws(() => candidateRevision({ ...lock, commit: 'main' }, 'push', ref), /immutable/);
    assert.throws(() => candidateRevision({ ...lock, repository: 'other/repository' }, 'push', ref), /source lock/);
  }
  for (const ref of ['refs/heads/main', 'refs/heads/implement/native-macos-ci-more', 'refs/tags/implement/native-macos-ci', 'implement/native-macos-ci', 'refs/heads/implement/native-macos-ci/']) {
    assert.throws(() => candidateRevision(lock, 'push', ref), /opt-in branch/);
  }
});

test('real revision CLI writes the exact SHA to GITHUB_OUTPUT and rejects unrelated pushes without output', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-revision-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/native-candidate.json'), JSON.stringify(lock));
  const output = join(root, 'github-output');
  const run = (event: string, ref: string, input = '') => spawnSync(process.execPath, [fileURLToPath(new URL('candidate-revision.ts', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, INPUT_NATIVE_SHA: input, INPUT_BENCHMARK_SWEEP: '', GITHUB_OUTPUT: output },
  });
  writeFileSync(output, 'existing=preserved\n');
  assert.equal(run('push', 'refs/heads/implement/native-macos-ci').status, 0);
  assert.equal(readFileSync(output, 'utf8'), `existing=preserved\nsha=${lock.commit}\nbenchmark_sweep=false\n`);
  writeFileSync(output, '');
  const manual = 'b'.repeat(40);
  assert.equal(run('workflow_dispatch', 'refs/heads/implement/native-macos-ci', manual).status, 0);
  assert.equal(readFileSync(output, 'utf8'), `sha=${manual}\nbenchmark_sweep=false\n`);
  for (const [ref, input] of [['refs/heads/main', ''], ['refs/heads/implement/native-macos-ci-more', ''], ['refs/heads/implement/native-macos-ci', manual]]) {
    writeFileSync(output, '');
    const result = run('push', ref!, input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /opt-in branch/);
    assert.equal(readFileSync(output, 'utf8'), '');
  }
});

test('producer hashes the actual allowlisted workflow, never caller-relative paths or traversal', () => {
  for (const file of ['.github/workflows/native-candidate.yml', '.github/workflows/native-macos-candidate.yml']) {
    const expected = createHash('sha256').update(readFileSync(new URL(`../../${file}`, import.meta.url))).digest('hex');
    assert.deepEqual(candidateWorkflowRecipe(file), { workflowFile: file, workflowSha256: expected });
  }
  assert.deepEqual(candidateWorkflowRecipe(), candidateWorkflowRecipe('.github/workflows/native-candidate.yml'));
  assert.notEqual(candidateWorkflowRecipe().workflowSha256, candidateWorkflowRecipe('.github/workflows/native-macos-candidate.yml').workflowSha256);
  for (const file of ['', '../native-candidate.yml', '.github/workflows/../workflows/native-macos-candidate.yml', './.github/workflows/native-macos-candidate.yml', '/tmp/native-macos-candidate.yml', '.github/workflows/native-macos-candidate.yml/../../secret', '.github\\workflows\\native-macos-candidate.yml', '.github/workflows/other.yml']) {
    assert.throws(() => candidateWorkflowRecipe(file), /Unapproved/);
  }
});

test('macOS candidate requires real native hosts, read-only permissions and platform-specific artifact identity', () => {
  assert.match(workflow, /branches: \[implement\/native-macos-ci\]/);
  assert.match(workflow, /runner: macos-15\n\s+arch: arm64\n\s+rust_host: aarch64-apple-darwin/);
  assert.match(workflow, /runner: macos-15-intel\n\s+arch: x64\n\s+rust_host: x86_64-apple-darwin/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /macos-(?:latest|\d+-(?:large|xlarge))|self-hosted|download-artifact|contents: write|npm publish|gh release|candidate-receipt\.ts/);
  for (const expected of ['process.platform', 'process.arch', 'sysctl.proc_translated', 'uname -m', 'rustc -Vv', 'lipo -archs']) assert.ok(workflow.includes(expected));
  assert.match(workflow, /CANDIDATE_WORKFLOW_FILE: .github\/workflows\/native-macos-candidate.yml/);
  assert.match(workflow, /name: macos-installed-candidate-darwin-\$\{\{ matrix.arch \}\}-\$\{\{ github.sha \}\}-\$\{\{ steps.source.outputs.sha \}\}/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) && steps.installed.outcome == 'success' \}\}/);
});

test('macOS isolation preserves existing tools, all four independent boundaries and the unmodified installed six-check gate', () => {
  assert.match(workflow, /rustup_home="\$\{RUSTUP_HOME:-\$HOME\/.rustup\}"/);
  assert.match(workflow, /dirname "\$executable" >> "\$GITHUB_PATH"/);
  assert.match(workflow, /echo "RUSTUP_HOME=\$rustup_home" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /echo "CARGO_HOME=\$RUNNER_TEMP\/native-candidate-cargo" >> "\$GITHUB_ENV"/);
  assert.match(workflow, /echo "HOME=\$RUNNER_TEMP\/native-candidate-home" >> "\$GITHUB_ENV"/);
  for (const recipe of [
    'native-format-check cargo fmt -- --check',
    'native-default-clippy cargo clippy --locked --profile ci --no-default-features --all-targets -- -D warnings',
    'native-feature-check cargo check --locked --profile ci --no-default-features --features acceptance-faults --tests',
    'native-proxy-check cargo check --locked --profile ci --no-default-features --features acceptance-faults --test client-proxy-fixture',
  ]) assert.ok(workflow.includes(`check_boundary ${recipe}`));
  assert.match(workflow, /else status=\$\?; failed=1; fi/);
  assert.match(workflow, /candidate-native.ts baseline .* \|\| failed=1/);
  assert.match(workflow, /candidate-native.ts browser .* \|\| failed=1/);
  assert.match(workflow, /candidate-producer.ts .artifacts\/native-source "\$RUNNER_TEMP\/native-candidate-bin\/production"/);
  assert.match(workflow, /package-bundle.ts "\$RUNNER_TEMP\/native-candidate-bin\/production"/);
  assert.match(workflow, /candidate-installed.ts "\$RUNNER_TEMP\/native-candidate-bundle" "\$\{\{ steps.bundle.outputs.manifest_sha256 \}\}" "\$RUNNER_TEMP\/native-candidate-consumer"/);
  const installed = readFileSync(new URL('candidate-installed.ts', import.meta.url), 'utf8');
  assert.match(installed, /proof.checks !== 6/);
  assert.match(installed, /delete env\['E2E_AGENT_BROWSER_EXECUTABLE'\]/);
});


test('all four compilation boundaries execute and retain separate failure statuses', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-boundaries-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.artifacts/native-candidate'), { recursive: true });
  const step = workflow.slice(workflow.indexOf('      - name: Check all compilation boundaries independently'), workflow.indexOf('      - name: Build clean production runtime'));
  const script = step.split('        run: |\n')[1]!.split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const mocks = `
    git() { if test "$1" = rev-parse; then printf '%s\\n' "$EXPECTED_NATIVE_SHA"; fi; }
    cargo() {
      printf 'synthetic cargo %s\\n' "$*"
      case "$1:$*" in fmt:*) return 2;; clippy:*) return 3;; *--tests*) return 4;; *) return 0;; esac
    }
  `;
  const result = spawnSync('bash', ['-c', mocks + script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root, EXPECTED_NATIVE_SHA: lock.commit } });
  assert.notEqual(result.status, 0);
  for (const [name, exit] of [['native-format-check', 2], ['native-default-clippy', 3], ['native-feature-check', 4], ['native-proxy-check', 0]] as const) {
    assert.equal(readFileSync(join(root, '.artifacts/native-candidate', `${name}.exit`), 'utf8'), `${exit}\n`);
    assert.match(readFileSync(join(root, '.artifacts/native-candidate', `${name}.log`), 'utf8'), /synthetic cargo/);
  }
  assert.match(workflow, /node --test test\/launcher.test.mjs test\/postinstall.test.mjs/);
});

test('production workflow selects exact compiler bytes and rejects unrelated or fault artifacts', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-macos-compiler-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source/cli'); const target = join(root, 'target');
  for (const directory of [source, join(target, 'ci'), join(root, '.artifacts/native-candidate'), join(root, 'native-candidate-bin')]) mkdirSync(directory, { recursive: true });
  const executable = join(target, 'ci/agent-browser');
  writeFileSync(executable, 'synthetic compiler bytes, never executed', { mode: 0o700 });
  const artifact = { reason: 'compiler-artifact', profile: { test: false }, features: [], target: { name: 'agent-browser', kind: ['bin'], src_path: join(source, 'src/main.rs') }, manifest_path: join(source, 'Cargo.toml'), executable };
  const finished = { reason: 'build-finished', success: true };
  const script = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]+?)\n          NODE/)![1]!.split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const run = (rows: unknown[]) => {
    writeFileSync(join(root, '.artifacts/native-candidate/production-compiler.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: source, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root, CARGO_TARGET_DIR: target, RUNNER_TEMP: root } });
  };
  assert.equal(run([artifact, finished]).status, 0);
  assert.deepEqual(readFileSync(join(root, 'native-candidate-bin/production')), readFileSync(executable));
  for (const rows of [[artifact], [artifact, { ...finished, success: false }], [artifact, artifact, finished], [{ ...artifact, features: ['acceptance-faults'] }, finished], [{ ...artifact, executable: process.execPath }, finished], [{ ...artifact, manifest_path: join(root, 'foreign/Cargo.toml') }, finished]]) {
    assert.notEqual(run(rows).status, 0);
  }
});

test('producer CLI enforces its recipe selector before reading evidence or invoking tools', () => {
  const script = fileURLToPath(new URL('candidate-producer.ts', import.meta.url));
  for (const recipe of ['.github/workflows/../workflows/native-macos-candidate.yml', '/tmp/foreign.yml']) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CANDIDATE_WORKFLOW_FILE: recipe } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unapproved candidate workflow recipe/);
  }
});
