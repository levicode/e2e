import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, realpathSync, mkdirSync, fstatSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

type CaseId = 'p01' | 'video-refusal' | 'routes-suite' | 'hung-recovery';
type State = 'disabled' | 'ready' | 'unavailable' | 'environment-conflict';
/** Test-process-local capture only: no retries, browser controls, or success authority. */
export function beginCaseCleanupCapture(caseId: CaseId, meta: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): { finish(): void; readonly env?: NodeJS.ProcessEnv } {
  if (caseId === 'hung-recovery' && env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'] === '1') {
    const capture = prepareWebCaseNativeCapture(caseId, env);
    try { meta['webCaseNativeCapture'] = { caseId, state: capture === undefined ? 'unavailable' : 'ready' }; } catch { /* No diagnostic authority. */ }
    return capture ?? { finish() {} };
  }
  const directory = env['E2E_CASE_CLEANUP_DIAGNOSTIC_DIR'];
  const previous = env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'];
  const file = `${caseId}.cleanup.jsonl`;
  let state: State = directory === undefined ? 'disabled' : 'unavailable';
  let ownedPath: string | undefined;
  let restored = false;
  let finished = false;
  const publish = () => { try { meta['caseCleanupCapture'] = { schemaVersion: 1, caseId, file, state, restored }; } catch { /* No diagnostic authority. */ } };
  if (directory !== undefined) {
    try {
      if (!isAbsolute(directory) || realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory()) throw new Error('Invalid capture directory');
      const target = join(directory, file);
      const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] = target;
      ownedPath = target;
      state = 'ready';
    } catch { /* Leave inherited configuration untouched; readiness remains unavailable. */ }
  }
  publish();
  return { finish() {
    if (finished) return;
    finished = true;
    if (ownedPath !== undefined) {
      if (env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] === ownedPath) {
        if (previous === undefined) delete env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'];
        else env['AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE'] = previous;
        restored = true;
      } else state = 'environment-conflict';
    }
    publish();
  } };
}

type WebNativeCaptureCase = 'hung-recovery' | 'lifecycle-open-cancel' | 'popup-replacement';
interface WebCaseNativeCapture { readonly env: NodeJS.ProcessEnv; finish(): void }
/** Exact ordinary cases only. No global environment mutation or runtime fallback. */
export function prepareWebCaseNativeCapture(caseId: WebNativeCaptureCase, env: NodeJS.ProcessEnv = process.env): WebCaseNativeCapture | undefined {
  if (env['E2E_WEB_THREE_CASE_NATIVE_CAPTURE'] !== '1') return undefined;
  try {
    if (!['hung-recovery', 'lifecycle-open-cancel', 'popup-replacement'].includes(caseId)) return undefined;
    const workspace = env['GITHUB_WORKSPACE']; const selector = env['NODE_SELECTOR'];
    if (workspace === undefined || !isAbsolute(workspace) || realpathSync(workspace) !== workspace || selector === undefined || !/^(22|24|26)(?:\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2}))?$/.test(selector) || selector.includes('\n')) return undefined;
    const exactDirectory = (directory: string): void => {
      const value = lstatSync(directory);
      if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(directory) !== directory || value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o700) throw new Error('Unavailable capture');
    };
    const bytes = (file: string, maximum: number): Buffer => {
      if (realpathSync(file) !== file) throw new Error('Unavailable capture');
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const value = fstatSync(fd);
        if (!value.isFile() || value.uid !== process.getuid?.() || value.nlink !== 1 || value.size > maximum) throw new Error('Unavailable capture');
        const output = Buffer.alloc(value.size + 1); let length = 0;
        while (length < output.length) { const count = readSync(fd, output, length, output.length - length, null); if (count === 0) break; length += count; }
        const after = fstatSync(fd);
        if (length !== value.size || ['size', 'dev', 'ino', 'uid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].some(key => Reflect.get(value, key) !== Reflect.get(after, key))) throw new Error('Unavailable capture');
        return output.subarray(0, length);
      } finally { closeSync(fd); }
    };
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const evidence = join(workspace, 'evidence');
    const binding = JSON.parse(bytes(join(evidence, 'fixtures', selector, 'web', 'binding.json'), 65536).toString('utf8')) as Record<string, unknown>;
    const sourceCommit = bytes(join(evidence, 'source.commit'), 128).toString().trim();
    const sourceTree = bytes(join(evidence, 'source.tree'), 128).toString().trim();
    const nodeVersion = bytes(join(evidence, 'node.version'), 128).toString().trim();
    const run = env['GITHUB_RUN_ID']; const attempt = env['GITHUB_RUN_ATTEMPT'];
    if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{40}$/.test(sourceTree) || sourceCommit !== env['GITHUB_SHA'] || run === undefined || attempt === undefined || !/^[1-9][0-9]*$/.test(run) || !/^[1-9][0-9]*$/.test(attempt)) return undefined;
    if (nodeVersion !== process.version || (selector.includes('.') ? selector !== process.versions.node : selector !== process.versions.node.split('.')[0])) return undefined;
    if (binding['selector'] !== selector || binding['lane'] !== 'web' || binding['run'] !== run || binding['attempt'] !== attempt || binding['sourceCommit'] !== sourceCommit || binding['sourceTree'] !== sourceTree || binding['nodeVersion'] !== nodeVersion) return undefined;
    const native = env['E2E_AGENT_BROWSER_EXECUTABLE'];
    if (native === undefined || !isAbsolute(native)) return undefined;
    const nativeHash = hash(bytes(native, 128 * 1024 * 1024));
    const nativeHashes = binding['nativeSha256'];
    if (nativeHashes === null || typeof nativeHashes !== 'object' || !('ordinary' in nativeHashes) || nativeHashes.ordinary !== nativeHash) return undefined;
    const wrapper = join(evidence, 'tools', 'web-native-trace.sh');
    const wrapperHash = hash(bytes(wrapper, 65536));
    if (native === wrapper || wrapperHash !== hash(bytes(join(workspace, 'scripts', 'ci', 'native-trace-wrapper.sh'), 65536))) return undefined;
    const invocations = join(evidence, 'fixture-invocations'); const root = join(evidence, 'web-case-native');
    exactDirectory(invocations); exactDirectory(root);
    const directory = join(root, caseId); mkdirSync(directory, { mode: 0o700 }); exactDirectory(directory);
    const nonce = randomBytes(32).toString('hex');
    // The native custody carrier accepts this private layout; this is not the business projectRoot.
    const project = join(directory, `p-${nonce.slice(0, 12)}`); mkdirSync(project, { mode: 0o700 }); exactDirectory(project);
    const privateRoot = join(project, '.e2e'); mkdirSync(privateRoot, { mode: 0o700 }); exactDirectory(privateRoot);
    const trace = join(privateRoot, 'native-trace'); mkdirSync(trace, { mode: 0o700 }); exactDirectory(trace);
    const header = { schemaVersion: 1, caseId, nonce, traceDirectory: trace, run, attempt, selector, nodeVersion, sourceCommit, sourceTree, nativeExecutable: native, nativeSHA256: nativeHash, wrapperSHA256: wrapperHash };
    writeFileSync(join(directory, 'case.json'), JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 });
    let finished = false;
    return { env: Object.freeze({ ...env, E2E_AGENT_BROWSER_EXECUTABLE: wrapper, E2E_DIAGNOSTIC_NATIVE_EXECUTABLE: native, E2E_DIAGNOSTIC_DIR: trace, E2E_DIAGNOSTIC_INVOCATIONS: invocations, E2E_CAPTURE_SOURCE_TREE: sourceTree }),
      finish() {
        if (finished) return; finished = true;
        try { writeFileSync(join(directory, 'finished.json'), JSON.stringify({ schemaVersion: 1, caseId, nonce, state: 'scope-finished' }) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch { /* Missing finish is incomplete capture, never a replacement business exception. */ }
      } };
  } catch { return undefined; }
}
