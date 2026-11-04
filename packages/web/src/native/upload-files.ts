/** Runner-side filesystem policy only; native owns browser file-input semantics. */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants, type BigIntStats } from 'node:fs';
import { EngineError, type OperationContext } from 'e2e/engine';

export interface UploadFile { readonly path: string; readonly name: string; readonly relativePath?: string }
export interface UploadSelection { readonly directoryName?: string; readonly files: readonly UploadFile[] }
const MAX_DIRECTORY_ENTRIES = 10000;
const selectedIdentity = new WeakMap<UploadFile, { dev: bigint; ino: bigint }>();
function selected(file: UploadFile, metadata: BigIntStats): UploadFile {
  selectedIdentity.set(file, { dev: metadata.dev, ino: metadata.ino }); return file;
}

/** Open first, then validate the selected inode before reading any bytes, closing path-swap races. */
export async function readUploadFile(file: UploadFile, operation: OperationContext): Promise<Buffer> {
  if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Upload read was cancelled', { retryable: false });
  const endsAt = performance.now() + operation.timeoutMs;
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(operation.timeoutMs)));
  const signal = AbortSignal.any([operation.signal, deadline]);
  const check = () => {
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Upload read was cancelled', { retryable: false });
    if (deadline.aborted || performance.now() >= endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Upload read exhausted its deadline', { retryable: false });
  };
  const expected = selectedIdentity.get(file);
  if (expected === undefined) throw invalid('Upload file was not selected by the current traversal');
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: unknown;
  let failed = false;
  let bytes = Buffer.alloc(0);
  try {
    check();
    const actual = await handle.stat({ bigint: true });
    check();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw invalid('Upload file changed after selection');
    bytes = await handle.readFile({ signal });
    check();
  } catch (cause) { failed = true; primary = cause; }
  try { await handle.close(); }
  catch {
    const cleanup = new EngineError('ENGINE_FAILURE', 'Upload file handle cleanup failed', { retryable: false });
    if (!failed) throw cleanup;
    // Preserve the original classification; retain a static cleanup diagnostic without raw paths.
    if (primary instanceof Error && Object.isExtensible(primary) && primary.cause === undefined) primary.cause = cleanup;
  }
  if (failed) {
    // File ownership is retained through close even when read cancellation is advisory.
    if (primary instanceof Error && primary.name === 'AbortError') check();
    throw primary;
  }
  return bytes;
}

export async function selectUploadFiles(paths: readonly string[], operation: OperationContext): Promise<UploadSelection> {
  const endsAt = performance.now() + operation.timeoutMs;
  const check = () => {
    if (operation.signal.aborted) throw new EngineError('CANCELLED', 'Upload traversal was cancelled', { retryable: false });
    if (performance.now() >= endsAt) throw new EngineError('OPERATION_TIMEOUT', 'Upload traversal exceeded its deadline', { retryable: false });
  };
  const files: UploadFile[] = [];
  let entries = 0;
  for (const file of paths) {
    check();
    const metadata = await stat(file, { bigint: true });
    if (!metadata.isDirectory()) {
      if (!metadata.isFile()) throw invalid('Upload paths must name regular files or one directory');
      files.push(selected({ path: await realpath(file), name: path.basename(file) }, metadata)); continue;
    }
    if (paths.length !== 1) throw invalid('A directory upload must select exactly one directory');
    const root = await realpath(file);
    const ancestors = new Set<string>();
    const visit = async (directory: string, relative: string): Promise<void> => {
      check();
      const actual = await realpath(directory);
      const fromRoot = path.relative(root, actual);
      if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) throw invalid('Directory upload contains a link outside the selected directory');
      if (ancestors.has(actual)) throw invalid('Directory upload contains a symbolic-link cycle');
      ancestors.add(actual);
      try {
        for (const entry of (await readdir(directory)).toSorted()) {
          check();
          if (++entries > MAX_DIRECTORY_ENTRIES) throw invalid('Directory upload exceeds the bounded traversal limit of 10000 entries');
          const local = path.join(directory, entry);
          const name = relative === '' ? entry : `${relative}/${entry}`;
          const resolved = await realpath(local);
          const within = path.relative(root, resolved);
          if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw invalid('Directory upload contains a link outside the selected directory');
          const item = await stat(resolved, { bigint: true });
          if (item.isDirectory()) await visit(resolved, name);
          else if (item.isFile()) files.push(selected({ path: resolved, name: entry, relativePath: name }, item));
          else throw invalid('Directory upload contains a non-regular file');
        }
      } finally { ancestors.delete(actual); }
    };
    await visit(root, ''); check();
    return { directoryName: path.basename(path.resolve(file)), files };
  }
  check(); return { files };
}
function invalid(message: string): EngineError { return new EngineError('INVALID_STATE', message, { retryable: false }); }
