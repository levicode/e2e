import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, access, mkdir, realpath, stat, readdir, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type OperationContext } from 'e2e/engine';
import { CliTransport, type CliTransportOptions } from '../src/transport.ts';

function context(timeoutMs = 2_000, signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' };
}

async function fake(t: TestContext, env: Record<string, string> = {}, options: Omit<CliTransportOptions, 'executable' | 'env'> = {}): Promise<{ transport: CliTransport; log: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ab-transport-test-'));
  const executable = join(directory, 'fake-cli.mjs');
  const log = join(directory, 'calls.jsonl');
  await writeFile(executable, `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const globals = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
appendFileSync(process.env.TEST_LOG, JSON.stringify({ args, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_BROWSER_'))), config: readFileSync(args[args.indexOf('--config') + 1], 'utf8') }) + '\\n');
const emit = (data) => process.stdout.write(JSON.stringify({success:true,data}));
if (globals.includes('--version')) {
  setTimeout(() => console.log(process.env.TEST_VERSION || 'agent-browser 0.39.1-e2e.3'), Number(process.env.TEST_VERSION_DELAY || 0));
} else if (args.at(-1) === '--all' && args.includes('--cdp-target')) {
  console.log(JSON.stringify({success:false,error:'Cannot use close --all with scoped flags'}));
  process.exitCode = 1;
} else if (args.at(-1) === '--all' && process.env.TEST_ALL_ACK) {
  emit({closed:1,sessions:[args[args.indexOf('--session') + 1]],failed:[]});
} else if (args.at(-1) === 'close') {
  const marker = process.env.TEST_CLOSE_MARKER;
  if (marker && !existsSync(marker)) { writeFileSync(marker, '1'); emit({closed:false}); }
  else setTimeout(() => emit({closed:true}), Number(process.env.TEST_CLOSE_DELAY || 0));
} else if (args.includes('hang')) {
  if (process.env.TEST_STARTED) writeFileSync(process.env.TEST_STARTED, 'started');
  setInterval(() => {}, 1000);
} else if (args.includes('broken')) {
  console.log('stdout secret ' + args.at(-1));
  console.error('stderr secret ' + args.at(-1));
  process.exitCode = 1;
} else if (args.includes('invalid')) {
  console.log('not-json ' + args.at(-1));
} else if (args.includes('stale')) {
  console.log(JSON.stringify({success:false,code:'node_stale',data:{dispatched:false},error:'private '+args.at(-1)}));
  process.exitCode = 1;
} else if (args.includes('preflight-refused')) {
  console.log(JSON.stringify({success:false,code:process.env.TEST_ERROR_CODE,data:{dispatched:process.env.TEST_DISPATCHED === 'true'},error:'private '+args.at(-1)}));
  process.exitCode = Number(process.env.TEST_ERROR_EXIT || 1);
} else if (args.includes('unsafe-stale')) {
  console.log(JSON.stringify({success:false,code:'node_stale',data:{dispatched:true},error:'private '+args.at(-1)}));
  process.exitCode = 1;
} else if (args.includes('refused')) {
  console.log(JSON.stringify({success:false,error:'private ' + args.at(-1)}));
} else if (args.includes('overflow')) {
  process.stdout.write('x'.repeat(17 * 1024 * 1024));
} else if (args.includes('batch') && process.env.TEST_PARTIAL_BATCH) {
  console.log(JSON.stringify([{success:true,result:{value:'text'}}]));
} else if (args.includes('batch')) {
  console.log(JSON.stringify([{command:['secret'],success:true,result:{value:'text'},error:null},{command:['secret'],success:true,result:{visible:true},error:null}]));
} else { emit({args}); }
`);
  const transport = new CliTransport({ ...options, executable, env: { TEST_LOG: log, ...env } });
  t.after(async () => {
    await transport.close(context()).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return { transport, log };
}

async function calls(log: string): Promise<Array<{ args: string[]; env: Record<string, string>; config: string }>> {
  return (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

function classified(code: string, secret?: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.equal(error.cause, undefined);
    if (secret !== undefined) assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(secret));
    return true;
  };
}

/** Built-in bindings are restored explicitly; no transport-only configuration seam. */
function useTemporaryRoot(t: TestContext, directory: string): void {
  const mocked = t.mock.method(os, 'tmpdir', () => directory);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

async function shortTestRoot(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp('/tmp/a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assertSocketPaths(directory: string, session: string): void {
  for (const suffix of ['.sock', '.stream', '.pid', '.version', '.config', '.port', '.trust.json', '.target', '.log', '.engine', '.provider', '.extensions']) {
    assert.ok(Buffer.byteLength(join(directory, `${session}${suffix}`), 'utf8') <= 103, `Path exceeds the public CLI's Unix limit for ${suffix}`);
  }
}

test('normal short temp roots retain a private, exclusively owned directory and config', async (t) => {
  const root = await shortTestRoot(t);
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), root);
  assertSocketPaths(directory, transport.session);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).uid, process.geteuid?.());
  assert.equal((await stat(join(directory, 'config.json'))).mode & 0o777, 0o600);
  await transport.close(context());
  await assert.rejects(access(directory));
  await access(root);
});

test('very long temp roots fall back to a verified short root without shortening the unique session', async (t) => {
  const root = join(await shortTestRoot(t), 'var', 'folders', 'long-temporary-component-'.repeat(5), 'T');
  await mkdir(root, { recursive: true, mode: 0o700 });
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t, {}, { session: 'readable-prefix-'.repeat(5) });
  assert.match(transport.session, /^readable-prefix-readable-[0-9a-f-]{36}$/);
  assert.equal(transport.session.length, 61);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), await realpath('/tmp'));
  assertSocketPaths(directory, transport.session);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.ok((await readdir(root)).every(name => !name.startsWith('e2e-ab-')));
});

test('UTF-8 bytes, not string length, decide whether a non-ASCII temp root fits', async (t) => {
  const root = join(await shortTestRoot(t), '界'.repeat(12));
  await mkdir(root, { mode: 0o700 });
  const predicted = join(root, 'e2e-ab-XXXXXX', `${'e'.repeat(40)}.extensions`);
  assert.ok(predicted.length <= 103);
  assert.ok(Buffer.byteLength(predicted, 'utf8') > 103);
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), await realpath('/tmp'));
  assertSocketPaths(directory, transport.session);
});

test('longer public sidecars are checked even when the main socket would fit', async (t) => {
  const base = await shortTestRoot(t);
  const root = join(base, 'x'.repeat(43 - Buffer.byteLength(base, 'utf8') - 1));
  await mkdir(root, { mode: 0o700 });
  assert.equal(Buffer.byteLength(join(root, 'e2e-ab-XXXXXX', `${'e'.repeat(40)}.sock`)), 103);
  assert.ok(Buffer.byteLength(join(root, 'e2e-ab-XXXXXX', `${'e'.repeat(40)}.stream`)) > 103);
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), await realpath('/tmp'));
  assertSocketPaths(directory, transport.session);
});

test('the longest sidecar may use exactly 103 UTF-8 bytes', async (t) => {
  const base = await shortTestRoot(t);
  const root = join(base, 'x'.repeat(37 - Buffer.byteLength(base, 'utf8') - 1));
  await mkdir(root, { mode: 0o700 });
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), root);
  assert.equal(Buffer.byteLength(join(directory, `${transport.session}.extensions`)), 103);
  assertSocketPaths(directory, transport.session);
});

test('a short directory alias cannot conceal a longer canonical socket path', async (t) => {
  const base = await shortTestRoot(t);
  const root = join(base, 'long-'.repeat(25));
  const alias = join(base, 'alias');
  await mkdir(root, { mode: 0o700 });
  await symlink(root, alias, 'dir');
  useTemporaryRoot(t, alias);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), await realpath('/tmp'));
  assertSocketPaths(directory, transport.session);
});

test('a foreign-owned temporary root is rejected even when its path and mode fit', async (t) => {
  const root = await shortTestRoot(t);
  useTemporaryRoot(t, root);
  const inspect = fs.lstatSync;
  const inspecting = t.mock.method(fs, 'lstatSync', ((path: fs.PathLike) => {
    const result = inspect(path);
    if (path === root) result.uid = (process.geteuid?.() ?? 0) + 100_000;
    return result;
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    const { transport, log } = await fake(t);
    await transport.version(context());
    const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
    assert.equal(dirname(directory), await realpath('/tmp'));
    assert.equal((await stat(directory)).uid, process.geteuid?.());
  } finally {
    inspecting.mock.restore(); syncBuiltinESMExports();
  }
});

test('a writable non-sticky temp root is rejected instead of weakening session isolation', async (t) => {
  const root = join(await shortTestRoot(t), 'unsafe');
  await mkdir(root, { mode: 0o700 });
  fs.chmodSync(root, 0o777);
  useTemporaryRoot(t, root);
  const { transport, log } = await fake(t);
  await transport.version(context());
  const directory = (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
  assert.equal(dirname(directory), await realpath('/tmp'));
  assert.equal((await stat(root)).mode & 0o777, 0o777, 'The caller-owned root is not modified');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('concurrent transports keep distinct short directories and clean up only their own files', async (t) => {
  const root = join(await shortTestRoot(t), 'long-'.repeat(25));
  await mkdir(root, { mode: 0o700 });
  useTemporaryRoot(t, root);
  const fixtures = await Promise.all(Array.from({ length: 5 }, () => fake(t, {}, { session: 'p'.repeat(80) })));
  await Promise.all(fixtures.map(({ transport }) => transport.version(context())));
  const directories = await Promise.all(fixtures.map(async ({ log }) => (await calls(log))[0]!.env.AGENT_BROWSER_SOCKET_DIR!));
  assert.equal(new Set(directories).size, fixtures.length);
  assert.equal(new Set(fixtures.map(({ transport }) => transport.session)).size, fixtures.length);
  for (const [index, directory] of directories.entries()) {
    assertSocketPaths(directory, fixtures[index]!.transport.session);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  await fixtures[0]!.transport.close(context());
  await assert.rejects(access(directories[0]!));
  for (const directory of directories.slice(1)) await access(join(directory, 'config.json'));
  await Promise.all(fixtures.slice(1).map(({ transport }) => transport.close(context())));
  for (const directory of directories) await assert.rejects(access(directory));
  await access(root);
});

test('no safe temporary root fails with a sanitized error before any CLI spawn', (t) => {
  useTemporaryRoot(t, '/private-secret/unusable-temp');
  const resolving = t.mock.method(fs, 'realpathSync', Object.assign(() => { throw new Error('private-secret root access'); }, { native: fs.realpathSync.native }));
  const spawning = t.mock.method(childProcess, 'spawn', () => { throw new Error('Unexpected spawn'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new CliTransport(), classified('ENGINE_FAILURE', 'private-secret'));
    assert.equal(spawning.mock.callCount(), 0);
    assert.equal(resolving.mock.callCount(), 2);
  } finally {
    resolving.mock.restore(); spawning.mock.restore(); syncBuiltinESMExports();
  }
});

test('a config-write failure removes every newly owned directory before reporting failure', async (t) => {
  const root = await shortTestRoot(t);
  useTemporaryRoot(t, root);
  const create = fs.mkdtempSync;
  const directories: string[] = [];
  const creating = t.mock.method(fs, 'mkdtempSync', ((prefix: string) => {
    const directory = create(prefix);
    directories.push(directory);
    return directory;
  }) as typeof fs.mkdtempSync);
  const writing = t.mock.method(fs, 'writeFileSync', () => { throw new Error('private-secret config failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => new CliTransport(), classified('ENGINE_FAILURE', 'private-secret'));
    assert.equal(directories.length, 2);
    for (const directory of directories) await assert.rejects(access(directory));
    await access(root);
  } finally {
    creating.mock.restore(); writing.mock.restore(); syncBuiltinESMExports();
  }
});

test('uses exact argv, JSON, a unique session, and an isolated config/environment', async (t) => {
  const { transport, log } = await fake(t, { AGENT_BROWSER_RESTORE: 'victim', AGENT_BROWSER_PROFILE: '/private/profile', AGENT_BROWSER_PLUGINS: 'danger' });
  const payload = `hello 'quoted' ; $(touch /tmp/should-not-exist) & | < > \\ "`;
  const result = await transport.run<{ args: string[] }>(['fill', '@e1', payload], context(), { mutating: true, sensitive: true });
  assert.deepEqual(result.args.slice(-3), ['fill', '@e1', payload]);
  const observed = await calls(log);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]?.args.at(-1), '--version');
  assert.ok(observed[1]?.args.includes('--json'));
  assert.equal(observed[1]?.config, '{}');
  assert.deepEqual(Object.keys(observed[1]?.env ?? {}), ['AGENT_BROWSER_SOCKET_DIR']);
  const other = await fake(t);
  assert.notEqual(transport.session, other.transport.session);
  await transport.run(['get', 'title'], context());
  assert.equal((await calls(log)).filter((call) => call.args.at(-1) === '--version').length, 1);
});

test('CDP scope stays immutable on every command, version check, and cleanup invocation', async (t) => {
  for (const cdpContext of [null, 'provider.context:one']) {
    const options = { cdp: 'ws://127.0.0.1:9222/devtools/browser/owned', cdpTarget: 'provider.target:one', cdpContext };
    const { transport, log } = await fake(t, {
      AGENT_BROWSER_CDP_TARGET: 'foreign-target', AGENT_BROWSER_CDP_CONTEXT: 'foreign-context',
      AGENT_BROWSER_SESSION: 'foreign-session',
    }, options);
    options.cdpTarget = 'foreign-target'; options.cdpContext = 'foreign-context';
    await transport.version(context());
    await transport.run(['get', 'title'], context());
    await transport.close(context());
    const observed = await calls(log);
    assert.equal(observed.length, 3);
    for (const call of observed) {
      assert.equal(call.args.filter(arg => arg === '--cdp-target').length, 1);
      assert.equal(call.args.filter(arg => arg === '--cdp-context').length, 1);
      assert.equal(call.args[call.args.indexOf('--cdp-target') + 1], 'provider.target:one');
      assert.equal(call.args[call.args.indexOf('--cdp-context') + 1], cdpContext ?? 'default');
      assert.equal(call.args[call.args.indexOf('--session') + 1], transport.session);
      assert.deepEqual(Object.keys(call.env), ['AGENT_BROWSER_SOCKET_DIR']);
      assert.ok(!call.args.includes('foreign-target') && !call.args.includes('foreign-context'));
    }
  }
});

test('incomplete and malformed CDP scope is rejected before configuration or process creation', () => {
  const valid = { cdp: '9222', cdpTarget: 'target', cdpContext: null };
  for (const options of [
    { cdpTarget: 'target', cdpContext: null }, { cdp: '9222', cdpTarget: 'target' }, { cdp: '9222', cdpContext: null },
    ...['', 'private token', 'private\ntoken', '--private-token', 'private\0token', 'private\u0085token'].flatMap(value => [
      { ...valid, cdpTarget: value }, { ...valid, cdpContext: value }, { ...valid, cdp: value },
    ]),
    { ...valid, cdpContext: 'default' },
  ]) assert.throws(() => new CliTransport(options), classified('INVALID_STATE', 'private'));
});

test('command arguments cannot override scope, including equals-form flags', async (t) => {
  const { transport, log } = await fake(t, {}, { cdp: '9222', cdpTarget: 'owned', cdpContext: null });
  for (const token of ['--cdp-target', '--cdp-context', '--cdp-target=foreign', '--cdp-context=default']) {
    await assert.rejects(transport.run(['fill', '@e1', token], context(), { mutating: true }), classified('UNSUPPORTED_CAPABILITY'));
  }
  await assert.rejects(access(log));
  const literal = await transport.run<{ args: string[] }>(['fill', '@e1', '--', '--cdp-context=foreign'], context(), { mutating: true });
  assert.deepEqual(literal.args.slice(-4), ['fill', '@e1', '--', '--cdp-context=foreign']);
  assert.equal(literal.args[literal.args.indexOf('--cdp-context') + 1], 'default');
});

test('rejects the wrong version before dispatch and never echoes it', async (t) => {
  const { transport, log } = await fake(t, { TEST_VERSION: 'agent-browser 0.39.2 private-token' });
  await assert.rejects(transport.run(['click', '@e1'], context(), { mutating: true }), classified('ENGINE_FAILURE', 'private-token'));
  assert.equal((await calls(log)).length, 1);
  assert.equal(transport.poisoned, false);
});

for (const prior of ['0.39.1-e2e.1', '0.39.1-e2e.2']) test(`rejects earlier exact-ref build ${prior} before any scoped CDP command or cleanup dispatch`, async (t) => {
  const { transport, log } = await fake(t, { TEST_VERSION: `agent-browser ${prior}` }, {
    cdp: 'ws://127.0.0.1:9222/devtools/browser/shared', cdpTarget: 'owned-target', cdpContext: 'owned-context',
  });
  await assert.rejects(transport.run(['click', '@e1'], context(), { mutating: true }), (error: unknown) => {
    assert.ok(classified('ENGINE_FAILURE')(error));
    assert.ok(error instanceof EngineError);
    assert.match(error.message, /0\.39\.1-e2e\.3 is required/);
    return true;
  });
  assert.equal(transport.poisoned, false);
  await transport.close(context());
  const observed = await calls(log);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.args.at(-1), '--version');
  assert.ok(!observed[0]?.args.includes('click'));
  assert.ok(!observed[0]?.args.includes('close'));
});

test('rejects global flag values and dangerous top-level commands without spawning', async (t) => {
  const { transport, log } = await fake(t);
  for (const args of [['fill', '@e1', '--session'], ['fill', '@e1', '--version'], ['fill', '@e1', '--restore=victim'], ['close', '--all'], ['batch', 'close']]) {
    await assert.rejects(transport.run(args, context(), { mutating: true }), classified('UNSUPPORTED_CAPABILITY'));
  }
  await assert.rejects(access(log));
});

test('pre-aborted and expired mutations are never dispatched or poisoned', async (t) => {
  const { transport, log } = await fake(t);
  const controller = new AbortController();
  controller.abort(new Error('private-reason'));
  await assert.rejects(transport.run(['click', '@e1'], context(100, controller.signal), { mutating: true }), classified('CANCELLED', 'private-reason'));
  await assert.rejects(transport.run(['click', '@e1'], context(0), { mutating: true }), classified('OPERATION_TIMEOUT'));
  assert.equal(transport.poisoned, false);
  await assert.rejects(access(log));
});

test('mutating deadline loss is nonretryable uncertainty and only close is allowed', async (t) => {
  const { transport, log } = await fake(t);
  await transport.version(context());
  await assert.rejects(transport.run(['fill', 'hang', 'private-password'], context(100), { mutating: true, sensitive: true }), classified('ACTION_MAY_HAVE_COMMITTED', 'private-password'));
  assert.equal(transport.poisoned, true);
  await assert.rejects(transport.run(['get', 'title'], context()), classified('INVALID_STATE'));
  await transport.close(context());
  const observed = await calls(log);
  assert.equal(observed.at(-1)?.args.at(-1), 'close');
  const directory = observed[0]?.env.AGENT_BROWSER_SOCKET_DIR;
  assert.ok(directory);
  await assert.rejects(access(directory));
});

test('abort after dispatch acknowledges uncertain effects, not daemon cancellation', async (t) => {
  const { transport } = await fake(t);
  await transport.version(context());
  const controller = new AbortController();
  const pending = transport.run(['click', 'hang'], context(5_000, controller.signal), { mutating: true });
  setTimeout(() => controller.abort('private-abort-reason'), 100);
  await assert.rejects(pending, classified('ACTION_MAY_HAVE_COMMITTED', 'private-abort-reason'));
  assert.equal(transport.poisoned, true);
  await transport.close(context());
});

test('read timeout also prevents unsafe daemon reuse but is not an action error', async (t) => {
  const { transport } = await fake(t);
  await transport.version(context());
  await assert.rejects(transport.run(['get', 'hang'], context(100)), classified('OPERATION_TIMEOUT'));
  assert.equal(transport.poisoned, true);
});

test('overlapping calls fail immediately rather than blocking actions behind waits', async (t) => {
  const { transport } = await fake(t);
  await transport.version(context());
  const controller = new AbortController();
  const pending = transport.run(['get', 'hang'], context(5_000, controller.signal));
  const rejection = assert.rejects(pending, classified('CANCELLED'));
  await assert.rejects(transport.run(['click', '@e1'], context(), { mutating: true }), classified('UNSUPPORTED_CAPABILITY'));
  controller.abort();
  await rejection;
});

test('close cancels an in-flight client then requires a public close acknowledgement', async (t) => {
  const { transport, log } = await fake(t);
  await transport.version(context());
  const pending = transport.run(['fill', 'hang', 'secret'], context(5_000), { mutating: true });
  const rejection = assert.rejects(pending, classified('ACTION_MAY_HAVE_COMMITTED'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await transport.close(context());
  await rejection;
  assert.equal((await calls(log)).at(-1)?.args.at(-1), 'close');
  await transport.close(context());
});

test('failed close keeps files and permits another cleanup attempt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-close-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { transport, log } = await fake(t, { TEST_CLOSE_MARKER: join(directory, 'marker') });
  await transport.run(['get', 'title'], context());
  await assert.rejects(transport.close(context()), classified('ENGINE_FAILURE'));
  const stateDirectory = (await calls(log))[0]?.env.AGENT_BROWSER_SOCKET_DIR;
  assert.ok(stateDirectory);
  await access(stateDirectory);
  await transport.close(context());
  await assert.rejects(access(stateDirectory));
});

test('scoped cleanup keeps the binding and uses the full caller budget without close-all', async (t) => {
  const { transport, log } = await fake(t, { TEST_CLOSE_DELAY: '1150' }, {
    cdp: '9222', cdpTarget: 'owned-target', cdpContext: 'owned-context',
  });
  await transport.run(['get', 'title'], context());
  await transport.close(context(3_000));
  const observed = await calls(log);
  assert.equal(observed.length, 3);
  assert.equal(observed.at(-1)?.args.at(-1), 'close');
  assert.ok(observed.at(-1)?.args.includes('--cdp-target'));
  assert.ok(!observed.some(call => call.args.includes('--all')));
  const stateDirectory = observed[0]?.env.AGENT_BROWSER_SOCKET_DIR;
  assert.ok(stateDirectory);
  await assert.rejects(access(stateDirectory));
});

test('unacknowledged scoped close retains files and never broadens scope to force cleanup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-scoped-close-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { transport, log } = await fake(t, { TEST_CLOSE_MARKER: join(directory, 'marker'), TEST_ALL_ACK: '1' }, {
    cdp: '9222', cdpTarget: 'owned-target', cdpContext: null,
  });
  await transport.run(['get', 'title'], context());
  await assert.rejects(transport.close(context()), classified('ENGINE_FAILURE'));
  assert.equal(transport.poisoned, true);
  const observed = await calls(log);
  assert.equal(observed.length, 3);
  assert.ok(!observed.some(call => call.args.includes('--all')));
  const stateDirectory = observed[0]?.env.AGENT_BROWSER_SOCKET_DIR;
  assert.ok(stateDirectory);
  await access(stateDirectory);
  await assert.rejects(transport.run(['click', '@e1'], context(), { mutating: true }), classified('INVALID_STATE'));
  await transport.close(context());
  const retried = (await calls(log)).at(-1)!;
  assert.equal(retried.args[retried.args.indexOf('--cdp-target') + 1], 'owned-target');
  assert.equal(retried.args[retried.args.indexOf('--cdp-context') + 1], 'default');
  assert.equal(retried.args[retried.args.indexOf('--session') + 1], transport.session);
  await assert.rejects(access(stateDirectory));
});

test('nonzero exits, failed envelopes, and malformed JSON never leak secrets or permit mutation retry', async (t) => {
  for (const mode of ['broken', 'refused', 'invalid']) {
    const { transport } = await fake(t);
    await assert.rejects(transport.run(['fill', mode, 'SECRET-unique'], context(), { mutating: true, sensitive: true }), classified('ACTION_MAY_HAVE_COMMITTED', 'SECRET-unique'));
    assert.equal(transport.poisoned, true);
  }
});

test('observation batch unwraps result arrays and drops echoed commands', async (t) => {
  const { transport } = await fake(t);
  assert.deepEqual(await transport.run(['batch', '--bail', 'get attr @e1 type', 'is visible @e1'], context()), [{ value: 'text' }, { visible: true }]);
});

test('a first version check and the command share one deadline', async (t) => {
  const { transport } = await fake(t, { TEST_VERSION_DELAY: '100' });
  const began = performance.now();
  await assert.rejects(transport.run(['fill', 'hang', 'value'], context(180), { mutating: true }), classified('ACTION_MAY_HAVE_COMMITTED'));
  assert.ok(performance.now() - began < 300);
});

test('spawn errors are sanitized and do not poison a session that never started', async () => {
  const transport = new CliTransport({ executable: '/does-not-exist/private-token' });
  await assert.rejects(transport.run(['get', 'title'], context()), classified('ENGINE_FAILURE', 'private-token'));
  assert.equal(transport.poisoned, false);
  await transport.close(context());
});


test('supplied environment is authoritative and never falls back to ambient variables', async (t) => {
  process.env.AGENT_BROWSER_PARENT_ONLY = 'parent-only';
  t.after(() => { delete process.env.AGENT_BROWSER_PARENT_ONLY; });
  const { transport, log } = await fake(t);
  await transport.version(context());
  assert.deepEqual(Object.keys((await calls(log))[0]?.env ?? {}), ['AGENT_BROWSER_SOCKET_DIR']);
});

test('close-all fallback is limited to the private socket directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-all-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { transport, log } = await fake(t, { TEST_ALL_ACK: '1', TEST_CLOSE_MARKER: join(directory, 'marker') });
  await transport.run(['get', 'title'], context());
  await transport.close(context());
  const observed = await calls(log);
  assert.deepEqual(observed.at(-1)?.args.slice(-2), ['close', '--all']);
  assert.equal(observed.at(-1)?.env.AGENT_BROWSER_SOCKET_DIR, observed[0]?.env.AGENT_BROWSER_SOCKET_DIR);
  const stateDirectory = observed[0]?.env.AGENT_BROWSER_SOCKET_DIR;
  assert.ok(stateDirectory);
  await assert.rejects(access(stateDirectory));
});

test('incomplete batch results fail closed', async (t) => {
  const { transport } = await fake(t, { TEST_PARTIAL_BATCH: '1' });
  await assert.rejects(transport.run(['batch', '--bail', 'get attr @e1 type', 'is visible @e1'], context()), classified('ENGINE_FAILURE'));
  assert.equal(transport.poisoned, true);
});

test('oversized mutation output fails closed with uncertainty', async (t) => {
  const { transport } = await fake(t);
  await assert.rejects(transport.run(['fill', 'overflow', 'secret'], context(), { mutating: true }), classified('ACTION_MAY_HAVE_COMMITTED'));
  assert.equal(transport.poisoned, true);
});

test('cached version checks still obey cancellation', async (t) => {
  const { transport } = await fake(t);
  await transport.version(context());
  await assert.rejects(transport.version(context(100, AbortSignal.abort('secret'))), classified('CANCELLED', 'secret'));
});


test('only explicit patched pre-dispatch stale proof permits a mutation retry', async (t) => {
  const { transport } = await fake(t);
  await assert.rejects(transport.run(['click', 'stale', 'secret'], context(), { mutating: true }), (error) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'NODE_STALE');
    assert.equal(error.retryable, true);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(transport.poisoned, false);
  await transport.run(['get', 'title'], context());
  await assert.rejects(transport.run(['click', 'unsafe-stale', 'secret'], context(), { mutating: true }), classified('ACTION_MAY_HAVE_COMMITTED', 'secret'));
  assert.equal(transport.poisoned, true);
});


test('closed native pre-input errors keep the session usable and remain nonretryable', async (t) => {
  for (const [wire, code] of [['not_actionable', 'NOT_ACTIONABLE'], ['unsupported_capability', 'UNSUPPORTED_CAPABILITY']]) {
    for (const exit of ['0', '1']) {
      const { transport } = await fake(t, { TEST_ERROR_CODE: wire!, TEST_ERROR_EXIT: exit });
      await assert.rejects(transport.run(['fill', 'preflight-refused', 'secret'], context(), { mutating: true }), classified(code!, 'secret'));
      assert.equal(transport.poisoned, false);
      await transport.run(['get', 'title'], context());
    }
  }
});

test('unknown, post-input, and complex-command proof codes never excuse mutation uncertainty', async (t) => {
  for (const [wire, dispatched, command] of [
    ['private_future_code', 'false', 'fill'], ['not_actionable', 'true', 'fill'], ['not_actionable', 'false', 'eval'],
  ]) {
    const { transport } = await fake(t, { TEST_ERROR_CODE: wire!, TEST_DISPATCHED: dispatched! });
    await assert.rejects(transport.run([command!, 'preflight-refused', 'secret'], context(), { mutating: true }), classified('ACTION_MAY_HAVE_COMMITTED', 'secret'));
    assert.equal(transport.poisoned, true);
  }
});

test('reviewed literal-data markers preserve global-looking fill/type/select/eval values as exact argv', async (t) => {
  const { transport, log } = await fake(t);
  for (const args of [
    ['fill', '@e1', '--', '--session'], ['fill', '@e1', '--', '--version'], ['fill', '@e1', '--', '--'],
    ['type', '@e1', '--clear', '--delay', '4', '--', '--restore=other-session'],
    ['select', '@e1', '--label', '--', '--value'], ['select', '@e1', '--value', '--', '--session', '--config'],
    ['select', '@e1', '--index', '--', '2'], ['eval', '--', '--help'],
    ['keyboard', 'type', '--', '--session'], ['keyboard', 'inserttext', '--', '--version'], ['keyboard', 'insertText', '--', '--restore=other-session'],
  ]) {
    const result = await transport.run<{ args: string[] }>(args, context(), { mutating: true });
    assert.deepEqual(result.args.slice(-args.length), args);
  }
  assert.equal((await calls(log)).filter((call) => call.args.at(-1) === '--version' && !call.args.includes('--')).length, 1);
});

test('literal markers cannot hide transport controls, unknown branches, or batch mutations', async (t) => {
  const { transport, log } = await fake(t);
  for (const args of [
    ['--', 'close'], ['close', '--', '--all'], ['batch', '--', 'close'], ['get', 'title', '--', '--session'],
    ['fill', '--', '@e1', '--session'], ['fill', '@e1', '--session', '--', 'value'],
    ['type', '@e1', '--delay', '--', 'value'], ['type', '@e1', '--clear', '--clear', '--', 'value'],
    ['select', '@e1', '--', 'value'], ['eval', 'script', '--', '--version'],
  ]) await assert.rejects(transport.run(args, context(), { mutating: true }), classified('UNSUPPORTED_CAPABILITY'));
  await assert.rejects(access(log));
});
