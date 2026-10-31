/** Opt-in fixture custody only; never resolves, installs, or executes another runtime. */
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Identity = { consumerRun: string; consumerAttempt: string; selector: string; nodeVersion: string; sourceCommit: string; sourceTree: string };
function regular(file: string, max: number, mode?: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (mode !== undefined && (before.mode & 0o777) !== mode) || before.size > max) throw new Error('unavailable');
    const bytes = Buffer.alloc(Math.min(max + 1, before.size + 1));
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (count === 0) break; length += count; }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.uid !== after.uid || before.mode !== after.mode || before.nlink !== after.nlink || after.nlink !== 1 || (mode !== undefined && (after.mode & 0o777) !== mode)) throw new Error('unavailable');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function parsed(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8'); let compact = ''; let quoted = false; let escaped = false;
  for (const char of text) {
    if (quoted) { compact += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') { quoted = true; compact += char; } else if (!/\s/.test(char)) compact += char;
  }
  const value = JSON.parse(text) as Record<string, unknown>;
  if (JSON.stringify(value) !== compact || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('unavailable');
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).toSorted().join('|') !== [...keys].toSorted().join('|')) throw new Error('unavailable');
}
function directory(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file || stat.uid !== process.getuid?.()) throw new Error('unavailable');
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function matchesNodeSelector(selector: string | undefined, nodeVersion: string): boolean {
  if (selector === undefined) return false;
  const requested = /^(22|24|26)(?:\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2}))?$/.exec(selector);
  const actual = /^v(22|24|26)\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(nodeVersion);
  return requested !== null && requested[0] === selector && actual !== null && actual[0] === nodeVersion
    && (requested[2] === undefined ? requested[1] === actual[1] : nodeVersion === `v${selector}`);
}

export function prepareEngineSecretsNativeCustody(nonce: string, identity: Identity, projectDir: string | undefined): { env: NodeJS.ProcessEnv; archive: (rows: readonly Record<string, unknown>[]) => boolean } | undefined {
  try {
    if (!/^[a-f0-9]{64}$/.test(nonce) || !matchesNodeSelector(identity.selector, identity.nodeVersion)) return undefined;
    const workspace = process.env['GITHUB_WORKSPACE'];
    if (workspace === undefined || !path.isAbsolute(workspace)) return undefined;
    directory(workspace);
    const evidence = path.join(workspace, 'evidence'); directory(evidence);
    const binding = parsed(regular(path.join(evidence, 'fixtures', identity.selector, 'core', 'binding.json'), 65536));
    if (binding['run'] !== identity.consumerRun || binding['attempt'] !== identity.consumerAttempt || binding['selector'] !== identity.selector
      || binding['nodeVersion'] !== identity.nodeVersion || binding['sourceCommit'] !== identity.sourceCommit || binding['sourceTree'] !== identity.sourceTree || binding['lane'] !== 'core') return undefined;
    const hashes = binding['nativeSha256'];
    if (typeof hashes !== 'object' || hashes === null || !('ordinary' in hashes) || typeof hashes.ordinary !== 'string' || !/^[a-f0-9]{64}$/.test(hashes.ordinary)) return undefined;
    const native = process.env['E2E_AGENT_BROWSER_EXECUTABLE'];
    const wrapper = path.join(evidence, 'tools', 'popup-trace.sh');
    if (native === undefined || !path.isAbsolute(native) || native === wrapper || realpathSync(native) !== native) return undefined;
    if (digest(regular(native, 128 * 1024 * 1024)) !== hashes.ordinary) return undefined;
    accessSync(native, constants.X_OK); accessSync(wrapper, constants.X_OK);
    const wrapperHash = digest(regular(wrapper, 65536));
    if (wrapperHash !== digest(regular(path.join(workspace, 'scripts', 'ci', 'native-trace-wrapper.sh'), 65536))) return undefined;
    const invocations = path.join(evidence, 'fixture-invocations'); directory(invocations);
    if ((lstatSync(invocations).mode & 0o777) !== 0o700 || process.env['E2E_DIAGNOSTIC_INVOCATIONS'] !== invocations) return undefined;
    const root = path.join(evidence, 'engine-secrets-native');
    try { mkdirSync(root, { mode: 0o700 }); } catch { directory(root); }
    directory(root); if ((lstatSync(root).mode & 0o777) !== 0o700) return undefined;
    if (projectDir === undefined || !path.isAbsolute(projectDir) || !/^p-[a-f0-9]{12}$/.test(path.basename(projectDir))) return undefined;
    directory(projectDir);
    const e2e = path.join(projectDir, '.e2e');
    try { mkdirSync(e2e, { mode: 0o700 }); } catch { directory(e2e); }
    directory(e2e);
    const trace = path.join(e2e, 'native-trace'); mkdirSync(trace, { mode: 0o700 }); directory(trace);
    const output = path.join(root, nonce); mkdirSync(output, { mode: 0o700 }); directory(output);
    const schema = parsed(regular(path.join(workspace, 'scripts', 'ci', 'native-closed-trace-schema.json'), 128 * 1024));
    return { env: { ...process.env, E2E_AGENT_BROWSER_EXECUTABLE: wrapper, E2E_DIAGNOSTIC_NATIVE_EXECUTABLE: native, E2E_DIAGNOSTIC_DIR: trace },
      archive: rows => archiveNativeSnapshot({ trace, output, invocations, nonce, identity, native, nativeHash: hashes.ordinary as string, wrapperHash, schema }, rows) };

  } catch { return undefined; }
}

type Rule = 'bool' | { nullable?: Rule; int?: number; enum?: readonly unknown[]; array?: Rule; length?: number; tuple?: readonly Rule[]; object?: Record<string, Rule>; required?: readonly string[]; oneOf?: readonly Rule[] };
function valid(value: unknown, rule: Rule): boolean {
  if (rule === 'bool') return typeof value === 'boolean';
  if (rule.nullable !== undefined) return value === null || valid(value, rule.nullable);
  if (rule.int !== undefined) return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= rule.int;
  if (rule.enum !== undefined) return rule.enum.includes(value);
  if (rule.array !== undefined) return Array.isArray(value) && value.length === rule.length && value.every(item => valid(item, rule.array!));
  if (rule.tuple !== undefined) return Array.isArray(value) && value.length === rule.tuple.length && value.every((item, i) => valid(item, rule.tuple![i]!));
  if (rule.oneOf !== undefined) return rule.oneOf.some(option => valid(value, option));
  if (rule.object !== undefined) return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => rule.object![key] !== undefined && valid(item, rule.object![key]!))
    && (rule.required ?? []).every(key => Object.hasOwn(value, key));
  return false;
}
function newFailureFields(row: Record<string, unknown>): boolean {
  if (Object.hasOwn(row, 'inventoryFirstLoss') && !(row['phase'] === 'InventorySnapshot' && row['inventorySealed'] === true && row['inventoryIntegrityLost'] === true)) return false;
  if (Object.hasOwn(row, 'terminalProofRefusal') && !(row['phase'] === 'TerminalCleanupCheckpoint' && row['terminalCleanupStage'] === 'task-proof' && row['terminalCleanupOk'] === false)) return false;
  return true;
}
type Archive = { trace: string; output: string; invocations: string; nonce: string; identity: Identity; native: string; nativeHash: string; wrapperHash: string; schema: Record<string, unknown> };
function archiveNativeSnapshot(config: Archive, rows: readonly Record<string, unknown>[]): boolean {
  try {
    directory(config.trace); directory(config.output); directory(config.invocations);
    const bindings = rows.filter(row => row['kind'] === 'process-binding');
    if (bindings.length === 0 || bindings.length > 32) return false;
    const pids = new Set<number>(); const clients = new Set<string>();
    for (const row of bindings) {
      const pid = row['proxyPid']; const client = row['client']; const worker = row['workerOrdinal'];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff || pids.has(pid)
        || typeof client !== 'number' || !Number.isInteger(client) || client < 1 || client > 16 || typeof worker !== 'number' || !Number.isInteger(worker) || worker < 1 || worker > 8) return false;
      const key = `${worker}:${client}`; if (clients.has(key)) return false; clients.add(key); pids.add(pid);
    }
    const names = readdirSync(config.trace);
    if (names.length !== pids.size * 2 || names.length > 64 || names.some(name => !/^(native|query)-[1-9][0-9]*[.]jsonl$/.test(name))) return false;
    const pending: { name: string; bytes: Buffer }[] = []; const daemons = new Set<number>(); const nonces = new Set<string>(); let total = 0;
    for (const pid of pids) {
      const invocationBytes = regular(path.join(config.invocations, `invocation-${pid}.json`), 4096, 0o600); const invocation = parsed(invocationBytes);
      exact(invocation, ['schemaVersion', 'pid', 'nonce', 'traceDirectory', 'nativeExecutable', 'nativeSHA256', 'wrapperSHA256', 'run', 'attempt', 'sourceCommit', 'sourceTree']);
      if (invocation['schemaVersion'] !== 2 || invocation['pid'] !== pid || invocation['traceDirectory'] !== config.trace || invocation['nativeExecutable'] !== config.native
        || invocation['nativeSHA256'] !== config.nativeHash || invocation['wrapperSHA256'] !== config.wrapperHash || invocation['run'] !== config.identity.consumerRun
        || invocation['attempt'] !== config.identity.consumerAttempt || invocation['sourceCommit'] !== config.identity.sourceCommit || invocation['sourceTree'] !== config.identity.sourceTree
        || typeof invocation['nonce'] !== 'string' || !/^[a-f0-9]{64}$/.test(invocation['nonce']) || nonces.has(invocation['nonce'])) return false;
      nonces.add(invocation['nonce']);
      const mappingBytes = regular(path.join(config.invocations, `daemon-${pid}.json`), 1024, 0o600); const mapping = parsed(mappingBytes);
      exact(mapping, ['schemaVersion', 'kind', 'proxyPID', 'daemonPID', 'nonce', 'invocationSHA256']);
      const daemon = mapping['daemonPID'];
      if (mapping['schemaVersion'] !== 1 || mapping['kind'] !== 'spawn-owned-daemon' || mapping['proxyPID'] !== pid || mapping['nonce'] !== invocation['nonce'] || mapping['invocationSHA256'] !== digest(invocationBytes)
        || typeof daemon !== 'number' || !Number.isInteger(daemon) || daemon <= 0 || daemon > 0xffffffff || daemon === pid || daemons.has(daemon)) return false;
      daemons.add(daemon);
      pending.push({ name: `invocation-${pid}.json`, bytes: invocationBytes }, { name: `daemon-${pid}.json`, bytes: mappingBytes });
      for (const kind of ['native', 'query']) {
        const name = `${kind}-${pid}.jsonl`; if (!names.includes(name)) return false;
        const bytes = regular(path.join(config.trace, name), kind === 'native' ? 256 * 1024 : 64 * 1024, 0o600);
        const text = bytes.toString('utf8'); if (!text.endsWith('\n')) return false; const lines = text.slice(0, -1).split('\n');
        if (lines.length === 0 || lines.length > (kind === 'native' ? 2048 : 128)) return false;
        for (const [i, line] of lines.entries()) {
          if (Buffer.byteLength(line + '\n') > 512) return false;
          const row = parsed(Buffer.from(line));
          if (!valid(row, { object: config.schema['fields'] as Record<string, Rule>, required: config.schema['required'] as string[] })
            || !newFailureFields(row) || row['schemaVersion'] !== 2 || row['pid'] !== daemon || row['source'] !== 'native' || (i === 0 && (row['phase'] !== 'CaptureStarted' || row['record'] !== 0))) return false;
        }
        total += bytes.length; if (total > 10 * 1024 * 1024) return false; pending.push({ name, bytes });
      }
    }
    // All records are closed-schema validated before any diagnostic content is copied.
    for (const file of pending) writeFileSync(path.join(config.output, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(config.output, 'custody.json'), JSON.stringify({ schemaVersion: 1, suite: 'engine-secrets', captureNonce: config.nonce, traceDirectory: config.trace,
      consumerRun: config.identity.consumerRun, consumerAttempt: config.identity.consumerAttempt, selector: config.identity.selector, nodeVersion: config.identity.nodeVersion, sourceCommit: config.identity.sourceCommit, sourceTree: config.identity.sourceTree, nativeSHA256: config.nativeHash, wrapperSHA256: config.wrapperHash, proxyPids: [...pids].toSorted((a, b) => a - b), coverage: 'observed-only', exhaustive: false }) + '\n', { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; }
}
