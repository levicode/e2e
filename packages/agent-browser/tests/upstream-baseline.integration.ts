/** Official-source comparison only: the shipped engine still has one maintained runtime. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { OperationContext } from 'e2e/engine';
import { CdpConnection } from '../src/cdp.ts';
import { launchChromium, type OwnedBrowser } from '../src/launch.ts';
import { cdpAuditProxy } from './cdp-audit-proxy.ts';
import { AGENT_BROWSER_CONTRACT, AGENT_BROWSER_VERSION } from '../src/native-contract.ts';

const execute = promisify(execFile);
const lockPath = fileURLToPath(new URL('../native-source.lock.json', import.meta.url));

type Snapshot = { snapshot: string; refs: Record<string, { role: string; name: string }>; removedRefs: string[] };
type UiEvent = {
  type: string; target: string; trusted: boolean; inputType: string | null; data: string | null;
  key: string | null; code: string | null; value: string; checked: boolean | null;
};
type Observation = {
  values: Record<string, string>; checked: boolean; clicks: { original: number; replacement: number };
  events: UiEvent[]; pathname: string;
};
type BrowserRun = {
  command(...args: string[]): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  observe(): Promise<Observation>;
};

const fixture = `<!doctype html><meta charset="utf-8"><title>Ordinary upstream behavior</title>
<style>body{font:16px sans-serif;margin:24px}label,textarea,[contenteditable],button,a{display:block;margin:12px 0}
input,textarea,[contenteditable]{min-width:260px;min-height:24px}</style>
<h1>Ordinary upstream behavior</h1>
<label>Text field <input id="text" value="old text"></label>
<label>Notes <textarea id="textarea">old notes</textarea></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Rich text"></div>
<label>Keyboard <textarea id="keyboard"></textarea></label>
<label><input id="checkbox" type="checkbox"> Accept terms</label>
<button id="semantic" data-generation="original">Semantic action</button>
<a id="navigate" href="/destination">Destination</a>
<script>
window.observedEvents=[];
window.observedClicks={original:0,replacement:0};
const valueOf=element=>element.isContentEditable?element.textContent:
  typeof element.value==='string'?element.value:'';
for(const type of ['beforeinput','input','change','keydown','keyup','click']){
  document.addEventListener(type,event=>{
    const element=event.target;
    if(!element.id)return;
    window.observedEvents.push({
      type:event.type,target:element.id,trusted:event.isTrusted,
      inputType:event.inputType??null,data:event.data??null,
      key:event.key??null,code:event.code??null,value:valueOf(element),
      checked:element.type==='checkbox'?element.checked:null
    });
    if(event.type==='click'&&element.id==='semantic'){
      window.observedClicks[element.dataset.generation]++;
    }
  });
}
window.observe=()=>({
  values:Object.fromEntries(['text','textarea','editable','keyboard'].map(id=>[id,valueOf(document.getElementById(id))])),
  checked:document.getElementById('checkbox').checked,
  clicks:{...window.observedClicks},events:[...window.observedEvents],pathname:location.pathname
});
</script>`;

/** Keep every observer command bounded independently of the CLI under comparison. */
function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'upstream-baseline', attemptId: 'ordinary', origin: 'test' };
}

/** Strip inherited agent configuration so each executable owns only its disposable session. */
function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_BROWSER_')));
  return { ...env, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, AGENT_BROWSER_SOCKET_DIR: directory, AGENT_BROWSER_DEBUG: '1' };
}

/** Reject relabeled, edited, or stale upstream binaries before launching any browser. */
async function verifyExecutables(): Promise<{ upstream: string; maintained: string }> {
  assert.ok(process.env.E2E_AGENT_BROWSER_UPSTREAM_EXECUTABLE, 'Build the official upstream baseline; this comparison must not skip missing prerequisites');
  assert.ok(process.env.E2E_AGENT_BROWSER_EXECUTABLE, 'Build the maintained executable; this comparison must not skip missing prerequisites');
  const upstream = await realpath(process.env.E2E_AGENT_BROWSER_UPSTREAM_EXECUTABLE);
  const maintained = await realpath(process.env.E2E_AGENT_BROWSER_EXECUTABLE);
  assert.notEqual(upstream, maintained, 'Official and maintained tests must execute separate binaries');
  const source = path.resolve(path.dirname(upstream), '../../..');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    upstreamRepository: string; upstreamBase: string; nativeVersion: string; contractVersion: string;
  };
  assert.equal(lock.upstreamRepository, 'https://github.com/vercel-labs/agent-browser.git');
  assert.match(lock.upstreamBase, /^[a-f0-9]{40}$/);
  const stamp = JSON.parse(await readFile(path.join(path.dirname(upstream), 'e2e-upstream-build.json'), 'utf8')) as {
    schemaVersion: number; repository: string; commit: string; tree: string; nativeVersion: string; binarySha256: string;
  };
  assert.equal(stamp.schemaVersion, 1);
  assert.equal(stamp.repository, lock.upstreamRepository);
  assert.equal(stamp.commit, lock.upstreamBase);
  assert.equal(stamp.binarySha256, createHash('sha256').update(await readFile(upstream)).digest('hex'));
  const git = async (...args: string[]) => (await execute('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 30_000 })).stdout.trim();
  assert.equal(await realpath(await git('rev-parse', '--show-toplevel')), await realpath(source));
  assert.equal(await git('config', '--get', 'remote.origin.url'), lock.upstreamRepository);
  assert.equal(await git('rev-parse', 'HEAD'), lock.upstreamBase);
  assert.equal(await git('rev-parse', 'HEAD^{tree}'), stamp.tree);
  assert.equal(await git('status', '--porcelain=v1', '--untracked-files=all'), '', 'Official baseline checkout must remain unmodified');
  assert.ok(!/^[a-zS] /m.test(await git('ls-files', '-v')), 'Official source must not hide tracked modifications');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_BROWSER_')));
  assert.equal((await execute(upstream, ['--version'], { env, timeout: 30_000 })).stdout.trim(), `agent-browser ${stamp.nativeVersion}`);
  assert.equal(lock.nativeVersion, AGENT_BROWSER_VERSION);
  assert.equal(lock.contractVersion, AGENT_BROWSER_CONTRACT);
  assert.equal((await execute(maintained, ['--version'], { env, timeout: 30_000 })).stdout.trim(), `agent-browser ${AGENT_BROWSER_VERSION}`);
  const capabilities = JSON.parse((await execute(maintained, ['--expect-contract', AGENT_BROWSER_CONTRACT, 'capabilities', '--json'], {
    env, timeout: 30_000,
  })).stdout) as { success: boolean; data: { nativeVersion: string; contractVersion: string; refModes: string[] } };
  assert.equal(capabilities.success, true);
  assert.equal(capabilities.data.nativeVersion, AGENT_BROWSER_VERSION);
  assert.equal(capabilities.data.contractVersion, AGENT_BROWSER_CONTRACT);
  assert.deepEqual(capabilities.data.refModes, ['semantic', 'exact']);
  return { upstream, maintained };
}

/** Serve the same fixture to independently launched browsers without external dependencies. */
async function startFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(request.url === '/destination' ? '<!doctype html><title>Destination</title><h1 id="arrived">Arrived</h1>' : fixture);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Preserve original failures as well as explicit teardown failures for each owned process. */
async function withBrowser<T>(executable: string, maintained: boolean, body: (run: BrowserRun) => Promise<T>): Promise<T> {
  // A short /tmp path also fits macOS's 103-byte Unix socket path limit.
  const directory = await mkdtemp('/tmp/ab-baseline-');
  const env = isolatedEnvironment(directory);
  const config = path.join(directory, 'config.json');
  const errors: unknown[] = [];
  let owned: OwnedBrowser | undefined;
  let observer: CdpConnection | undefined;
  let audit: Awaited<ReturnType<typeof cdpAuditProxy>> | undefined;
  let observerSession: string | undefined;
  let cliStarted = false;
  let lastCommand = 'not-started';
  let result: T | undefined;
  let command: BrowserRun['command'] | undefined;
  try {
    await writeFile(config, '{}\n');
    owned = await launchChromium({
      executable: process.env.E2E_CHROMIUM_EXECUTABLE ?? 'chromium', env,
      args: process.env.E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    }, operation());
    observer = await CdpConnection.connect(owned.endpoint, operation());
    await observer.verifyChromium(operation());
    const targets = (await observer.listTargets(operation())).filter((entry) => entry.type === 'page');
    assert.equal(targets.length, 1, 'Each CLI must own one fresh exclusive browser endpoint');
    const sessionId = await observer.attachTarget(targets[0]!.targetId, operation());
    observerSession = sessionId;
    const connection = observer;
    audit = await cdpAuditProxy(owned.endpoint);
    const endpoint = audit.endpoint;
    command = async (...args) => {
      cliStarted = true;
      lastCommand = args[0] === 'get' ? `get ${args[1] ?? ''}` : args[0] ?? 'missing-command';
      const { stdout } = await execute(executable, [
        '--config', config, '--session', 'ordinary', '--engine', 'chrome', '--cdp', endpoint, '--json',
        ...(maintained ? ['--expect-contract', AGENT_BROWSER_CONTRACT] : []), ...args,
      ], { cwd: directory, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      const envelope = JSON.parse(stdout) as { success: boolean; data: unknown };
      assert.equal(envelope.success, true, `Ordinary ${args[0]} must succeed`);
      return envelope.data;
    };
    const evaluate = async <Value>(expression: string): Promise<Value> => {
      const value = await connection.send<{ result: { value: Value }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }, operation(), sessionId);
      assert.equal(value.exceptionDetails, undefined, 'The independent fixture observer must not throw');
      return value.result.value;
    };
    // Isolate bounded CDP attachment from the subsequent navigation command.
    await command('get', 'url');
    result = await body({ command, evaluate, observe: () => evaluate<Observation>('window.observe()') });
  } catch (error) {
    // Capture before close/removal, for both executables with identical policy.
    const readDiagnostic = async (name: string) => {
      try { return (await readFile(path.join(directory, name), 'utf8')).slice(-16_384); }
      catch (cause) { return `unavailable: ${(cause as NodeJS.ErrnoException).code ?? 'unknown'}`; }
    };
    const pid = await readDiagnostic('ordinary.pid');
    let daemonAlive = false;
    if (/^\d+\s*$/.test(pid)) {
      try { process.kill(Number(pid.trim()), 0); daemonAlive = true; } catch { /* Exited or inaccessible. */ }
    }
    let socketPresent = false;
    try { await access(path.join(directory, 'ordinary.sock')); socketPresent = true; } catch { /* Diagnostic only. */ }
    let pageState: unknown = 'observer unavailable';
    if (observer && observerSession) {
      try {
        pageState = await observer.send('Runtime.evaluate', {
          expression: '({url:location.href,readyState:document.readyState})', returnByValue: true,
        }, { ...operation(), timeoutMs: 2_000 }, observerSession);
      } catch { pageState = 'observer probe failed within 2 seconds'; }
    }
    const diagnostics = { executable: maintained ? 'maintained' : 'unmodified official', command: lastCommand, timeoutMs: 30_000, socketPresent,
      daemonPid: pid.trim(), daemonAlive, daemonStderr: await readDiagnostic('ordinary.log'), pageState,
      // Deliberately omit params, response bodies and evaluated expressions.
      cdpCommands: audit?.commands.slice(-50).map(({ connection, id, method, sessionId }) => ({ connection, id, method, sessionId })),
      cdpReplies: audit?.replies.slice(-50), forwardingErrors: audit?.errors };
    errors.push(new Error(`Baseline failure diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error }));
  }
  if (cliStarted && command) {
    try {
      await command('close');
      const deadline = Date.now() + 5_000;
      while (true) {
        const liveFiles = await Promise.all(['ordinary.pid', 'ordinary.sock'].map(async (name) => {
          try { await access(path.join(directory, name)); return name; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        }));
        if (liveFiles.every((name) => name === undefined)) break;
        assert.ok(Date.now() < deadline, 'The exact CLI session must remove its daemon files during cleanup');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) { errors.push(error); }
  }
  try { await audit?.close(); } catch (error) { errors.push(error); }
  observer?.close();
  try { await owned?.close(); } catch (error) { errors.push(error); }
  try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Baseline comparison and owned-resource cleanup failed');
  return result as T;
}

/** Resolve one ordinary semantic ref without relying on executable-specific ref numbering. */
function ref(snapshot: Snapshot, role: string, name: string): string {
  const entries = Object.entries(snapshot.refs).filter(([, entry]) => entry.role === role && entry.name === name);
  assert.equal(entries.length, 1, `Expected one ${role} named ${name}`);
  return `@${entries[0]![0]}`;
}

/** Observe browser effects and trusted input events, not only CLI success envelopes. */
async function exerciseOrdinaryBehavior(run: BrowserRun, origin: string): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};
  await run.command('open', `${origin}/`);
  assert.equal(await run.evaluate('location.pathname'), '/');
  const snapshot = await run.command('snapshot') as Snapshot;
  const repeated = await run.command('snapshot') as Snapshot;
  assert.equal(typeof snapshot.snapshot, 'string');
  assert.deepEqual(repeated, snapshot, 'An unchanged ordinary snapshot must retain semantic refs');
  for (const [role, name] of [
    ['textbox', 'Text field'], ['textbox', 'Notes'], ['textbox', 'Rich text'],
    ['checkbox', 'Accept terms'], ['button', 'Semantic action'], ['link', 'Destination'],
  ]) ref(snapshot, role!, name!);
  observed.snapshot = {
    tree: snapshot.snapshot.replace(/\[ref=e\d+\]/g, '[ref]'),
    nodes: Object.values(snapshot.refs).map(({ role, name }) => ({ role, name }))
      .toSorted((left, right) => `${left.role}:${left.name}`.localeCompare(`${right.role}:${right.name}`)),
  };
  for (const [id, name, text] of [
    ['text', 'Text field', 'Filled 汉字🙂'], ['textarea', 'Notes', 'Textarea é🙂'],
    ['editable', 'Rich text', 'Editable 世界🙂'],
  ]) {
    await run.evaluate('window.observedEvents=[]');
    await run.command('fill', ref(snapshot, 'textbox', name!), text!);
    const state = await run.observe();
    assert.equal(state.values[id!], text, `${id} fill must change the actual UI value`);
    const events = state.events.filter((event) => event.target === id);
    const trustedInput = events.filter((event) => event.trusted && event.type === 'input');
    const trustedBeforeInput = events.filter((event) => event.trusted && event.type === 'beforeinput');
    assert.equal(trustedInput.length, 1, `${id} fill must use one trusted native insertion, not a synthetic DOM assignment`);
    assert.equal(trustedBeforeInput.length, 1, `${id} fill must reach the browser's beforeinput path`);
    assert.equal(trustedInput[0]!.inputType, 'insertText');
    assert.equal(trustedInput[0]!.data, text);
    assert.equal(trustedInput[0]!.value, text);
    assert.equal(trustedBeforeInput[0]!.inputType, 'insertText');
    assert.equal(trustedBeforeInput[0]!.data, text);
    // Upstream emits a synthetic contenteditable "clear" without clearing its
    // content. Compare real native insertion instead of preserving that no-op.
    observed[`fill:${id}`] = { value: state.values[id!], events: id === 'editable' ? events.filter((event) => event.trusted) : events };
  }
  await run.evaluate('window.observedEvents=[]');
  await run.command('type', '#keyboard', 'Ab🙂', '--clear');
  await run.command('press', 'End');
  await run.command('keyboard', 'type', '\nZ');
  await run.command('press', 'Backspace');
  const typed = await run.observe();
  assert.equal(typed.values.keyboard, 'Ab🙂\n');
  const keyboardEvents = typed.events.filter((event) => event.target === 'keyboard');
  for (const key of ['End', 'Enter', 'Backspace']) {
    assert.equal(keyboardEvents.filter((event) => event.type === 'keydown' && event.key === key && event.trusted).length, 1);
    assert.equal(keyboardEvents.filter((event) => event.type === 'keyup' && event.key === key && event.trusted).length, 1);
  }
  assert.deepEqual(keyboardEvents.filter((event) => event.type === 'keydown' || event.type === 'keyup').map((event) => event.key), [
    'End', 'End', 'Enter', 'Enter', 'Backspace', 'Backspace',
  ], 'Ordinary printable typing must retain upstream insertion without synthesizing printable key events');
  assert.ok(keyboardEvents.some((event) => event.type === 'input' && event.trusted && event.data === '🙂'));
  observed.keyboard = { value: typed.values.keyboard, events: keyboardEvents };

  await run.evaluate('window.observedEvents=[]');
  const checkbox = ref(snapshot, 'checkbox', 'Accept terms');
  await run.command('check', checkbox);
  assert.equal((await run.observe()).checked, true);
  await run.command('check', checkbox);
  let checkboxState = await run.observe();
  assert.equal(checkboxState.events.filter((event) => event.target === 'checkbox' && event.type === 'click').length, 1, 'Repeated check must be idempotent');
  await run.command('uncheck', checkbox);
  await run.command('uncheck', checkbox);
  checkboxState = await run.observe();
  assert.equal(checkboxState.checked, false);
  const checkboxEvents = checkboxState.events.filter((event) => event.target === 'checkbox');
  for (const type of ['click', 'input', 'change']) {
    assert.deepEqual(checkboxEvents.filter((event) => event.type === type).map((event) => ({ trusted: event.trusted, checked: event.checked })), [
      { trusted: true, checked: true }, { trusted: true, checked: false },
    ]);
  }
  observed.checkbox = { checked: checkboxState.checked, events: checkboxEvents };

  await run.evaluate('window.observedEvents=[]');
  const semantic = ref(snapshot, 'button', 'Semantic action');
  await run.command('click', semantic);
  assert.deepEqual((await run.observe()).clicks, { original: 1, replacement: 0 });
  await run.evaluate(`(() => {
    const old = document.getElementById('semantic');
    const replacement = old.cloneNode(true);
    replacement.dataset.generation = 'replacement';
    old.replaceWith(replacement);
    return true;
  })()`);
  await run.command('click', semantic);
  const clicked = await run.observe();
  assert.deepEqual(clicked.clicks, { original: 1, replacement: 1 }, 'Ordinary refs must retain upstream semantic fallback after replacement');
  const clicks = clicked.events.filter((event) => event.type === 'click' && event.target === 'semantic');
  assert.equal(clicks.length, 2);
  assert.ok(clicks.every((event) => event.trusted));
  observed.semanticClick = { clicks: clicked.clicks, events: clicks };

  await run.command('click', ref(snapshot, 'link', 'Destination'));
  const deadline = Date.now() + 10_000;
  while (true) {
    let arrived = false;
    try {
      arrived = await run.evaluate<boolean>("location.pathname === '/destination' && document.getElementById('arrived')?.textContent === 'Arrived'");
    } catch { /* Navigation can retire the observer's execution context; only observation is retried. */ }
    if (arrived) break;
    assert.ok(Date.now() < deadline, 'The ordinary link click must actually navigate');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  observed.navigation = { pathname: await run.evaluate('location.pathname'), title: await run.evaluate('document.title') };
  return observed;
}

/** The maintained browser-editing extension must replace and clear existing rich content. */
async function exerciseRichEditing(run: BrowserRun, origin: string): Promise<void> {
  await run.command('open', `${origin}/`);
  await run.evaluate("document.getElementById('editable').innerHTML='<b>Old rich</b> <i>content</i>';window.observedEvents=[]");
  await run.command('fill', '#editable', 'Replacement 世界🙂');
  let state = await run.observe();
  assert.equal(state.values.editable, 'Replacement 世界🙂', 'Rich fill must replace selected content, not append to it');
  assert.ok(state.events.some((event) => event.target === 'editable' && event.type === 'input' && event.trusted));
  await run.evaluate('window.observedEvents=[]');
  await run.command('fill', '#editable', '');
  state = await run.observe();
  assert.equal(state.values.editable, '', 'Filling empty text must actually clear selected rich content');
  assert.ok(state.events.some((event) => event.target === 'editable' && event.type === 'input' && event.trusted), 'Rich clear must use browser editing rather than a DOM textContent setter');
}

/** Physical key delivery is an explicit command option, never a sticky session profile. */
async function exercisePhysicalTyping(run: BrowserRun): Promise<void> {
  await run.command('fill', '#keyboard', '');
  await run.evaluate('window.observedEvents=[]');
  await run.command('keyboard', 'type', '--physical', '--', 'Ab!🙂');
  let state = await run.observe();
  assert.equal(state.values.keyboard, 'Ab!🙂');
  const events = state.events.filter((event) => event.target === 'keyboard');
  assert.deepEqual(events.filter((event) => event.type === 'keydown' || event.type === 'keyup')
    .map(({ type, key, code, trusted }) => ({ type, key, code, trusted })), [
    { type: 'keydown', key: 'A', code: 'KeyA', trusted: true },
    { type: 'keyup', key: 'A', code: 'KeyA', trusted: true },
    { type: 'keydown', key: 'b', code: 'KeyB', trusted: true },
    { type: 'keyup', key: 'b', code: 'KeyB', trusted: true },
    { type: 'keydown', key: '!', code: 'Digit1', trusted: true },
    { type: 'keyup', key: '!', code: 'Digit1', trusted: true },
  ]);
  assert.ok(events.some((event) => event.type === 'input' && event.trusted && event.data === '🙂'), 'Unmapped Unicode still uses trusted native insertion');
  await run.evaluate('window.observedEvents=[]');
  await run.command('keyboard', 'type', 'Q');
  state = await run.observe();
  assert.equal(state.values.keyboard, 'Ab!🙂Q');
  assert.equal(state.events.filter((event) => event.type === 'keydown' || event.type === 'keyup').length, 0, 'The next ordinary type must not inherit physical key delivery');
  assert.ok(state.events.some((event) => event.target === 'keyboard' && event.type === 'input' && event.trusted && event.data === 'Q'));
}

test('ordinary maintained CLI matches separately built unmodified official upstream browser effects', { timeout: 240_000 }, async () => {
  const { upstream, maintained } = await verifyExecutables();
  const { server, origin } = await startFixture();
  try {
    const failures: unknown[] = [];
    let official: Record<string, unknown> | undefined;
    let downstream: Record<string, unknown> | undefined;
    try { official = await withBrowser(upstream, false, (run) => exerciseOrdinaryBehavior(run, origin)); }
    catch (error) { failures.push(error); }
    // A failed oracle must not hide whether the single maintained runtime also fails.
    try {
      downstream = await withBrowser(maintained, true, async (run) => {
        const observation = await exerciseOrdinaryBehavior(run, origin);
        await exerciseRichEditing(run, origin);
        await exercisePhysicalTyping(run);
        return observation;
      });
    } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, 'Official and maintained baseline outcomes');
    assert.deepEqual(downstream, official, 'One maintained runtime must preserve ordinary upstream UI semantics and event delivery');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
