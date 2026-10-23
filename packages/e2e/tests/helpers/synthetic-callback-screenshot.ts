/** Retain only the original failure PNG from the fixed, throwaway C03 fixture. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { SYNTHETIC_BATCH_ENV, SYNTHETIC_BINDING_ENV, validSyntheticBinding } from '../../../web/tests/helpers/synthetic-evidence.ts';

export const SYNTHETIC_CALLBACK_SCREENSHOT_ENV = 'E2E_SYNTHETIC_CALLBACK_SCREENSHOT_FILE';
export const SYNTHETIC_CALLBACK_SCREENSHOT_FILE = 'public-callbacks-C03-failure.png';
const MAX_BYTES = 2 * 1024 * 1024;
const TITLE = 'route callback reads the live page while evaluate awaits fetch';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A narrow view keeps this test helper independent of the runner and browser. */
interface CallbackRun {
  readonly reportPath: string | undefined;
  readonly config: { readonly projectRoot: string; readonly output: string } | undefined;
  readonly report: { readonly run: { readonly results: readonly {
    readonly kind: string;
    readonly file: string;
    readonly titlePath: readonly string[];
    readonly selected: boolean;
    readonly repeat: number;
    readonly status: string;
    readonly attempts: readonly {
      readonly index: number;
      readonly status: string;
      readonly failure?: { readonly screenshot?: string } | undefined;
      readonly artifacts: readonly {
        readonly id: string;
        readonly kind: string;
        readonly mediaType: string;
        readonly redaction: string;
        readonly path?: string | undefined;
        readonly url?: string | undefined;
        readonly ref?: string | undefined;
        readonly size?: number | undefined;
        readonly sha256?: string | undefined;
      }[];
    }[];
  }[] } };
}

/** Reject traversal and symlinked ancestors at inspection; destination writes also require a directory FD. */
function requireDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('Unavailable directory');
}

/** Accept Chromium's non-interlaced, 8-bit RGB/RGBA PNGs, with bounded decoded pixels. */
function requirePng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG');
  let offset = 8; let rowBytes = 0; let height = 0; let ended = false;
  const seenMetadata = new Set<string>();
  const imageData: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG');
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Invalid PNG checksum');
    if (offset === 8) {
      if (kind !== 'IHDR' || length !== 13) throw new Error('Missing PNG header');
      const width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4 * 1024 * 1024
        || data[8] !== 8 || (data[9] !== 2 && data[9] !== 6) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('Unsupported PNG dimensions or encoding');
      rowBytes = 1 + width * (data[9] === 2 ? 3 : 4);
    } else if (kind === 'IDAT') {
      imageData.push(data);
    } else if (kind === 'IEND') {
      if (length !== 0 || end !== bytes.length || !imageData.length) throw new Error('Invalid PNG end');
      ended = true;
    } else {
      const metadataLength: Record<string, number> = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
      if (metadataLength[kind] !== length || imageData.length || seenMetadata.has(kind)) throw new Error('Unexpected PNG chunk');
      seenMetadata.add(kind);
    }
    offset = end;
  }
  if (!ended || offset !== bytes.length) throw new Error('Incomplete PNG');
  const pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: rowBytes * height });
  if (pixels.length !== rowBytes * height) throw new Error('Invalid PNG pixels');
  for (let row = 0; row < height; row++) if (pixels[row * rowBytes]! > 4) throw new Error('Invalid PNG filter');
}

/** Size and identity are checked before allocation and again after a bounded no-follow read. */
function readOriginal(file: string, size: number): Buffer {
  requireDirectory(dirname(file));
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== size) throw new Error('Unavailable original PNG');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== size) throw new Error('Changing original PNG');
    const bytes = Buffer.alloc(size + 1); let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, null);
      if (!count) break;
      read += count;
    }
    const after = fstatSync(fd); const named = lstatSync(file);
    requireDirectory(dirname(file));
    if (read !== size || after.size !== size || after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || !named.isFile() || named.isSymbolicLink()) throw new Error('Changing original PNG');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

/** Optional Linux CI evidence only: never change a test result, throw past cleanup, fetch URLs, or retain other files. */
export function retainSyntheticCallbackScreenshot(projectDir: string | undefined, outcome: CallbackRun | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  let destination: string | undefined; let fd: number | undefined; let parentFd: number | undefined; let created: { dev: number; ino: number } | undefined;
  try {
    const target = env[SYNTHETIC_CALLBACK_SCREENSHOT_ENV]; const encoded = env[SYNTHETIC_BINDING_ENV];
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || env[SYNTHETIC_BATCH_ENV] !== '1' || !target || !encoded || encoded.length > 2048 || !projectDir || !outcome) return false;
    const binding: unknown = JSON.parse(encoded);
    if (!validSyntheticBinding(binding) || binding.suite !== 'public-callbacks') return false;
    requireDirectory(projectDir);
    const output = join(projectDir, '.e2e');
    if (outcome.config?.projectRoot !== projectDir || outcome.config.output !== output || outcome.reportPath !== join(output, 'report.json')) return false;
    if (!isAbsolute(target) || resolve(target) !== target || basename(target) !== SYNTHETIC_CALLBACK_SCREENSHOT_FILE || target.startsWith(`${projectDir}/`)) return false;
    requireDirectory(dirname(target));
    const results = outcome.report.run.results.filter(result => result.kind === 'test' && result.file === 'tests/callbacks.e2e.ts'
      && result.titlePath.length === 1 && result.titlePath[0] === TITLE);
    const result = results[0];
    if (results.length !== 1 || !result?.selected || result.repeat !== 0 || !['failed', 'timed-out'].includes(result.status) || result.attempts.length !== 1) return false;
    const attempt = result.attempts[0]!;
    if (attempt.index !== 0 || !['failed', 'timed-out'].includes(attempt.status) || !attempt.failure?.screenshot) return false;
    const artifacts = attempt.artifacts.filter(artifact => artifact.id === attempt.failure!.screenshot);
    const artifact = artifacts[0];
    if (artifacts.length !== 1 || !artifact || artifact.kind !== 'screenshot' || artifact.mediaType !== 'image/png' || artifact.redaction !== 'complete'
      || artifact.url !== undefined || artifact.ref !== undefined || !artifact.path || !/^[a-z0-9][a-z0-9-]{0,255}\/attempt-1\/screenshots\/[0-9]{3,6}-failure\.png$/.test(artifact.path)
      || !Number.isSafeInteger(artifact.size) || artifact.size! < 1 || artifact.size! > MAX_BYTES || !artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return false;
    const bytes = readOriginal(join(output, 'results', artifact.path), artifact.size!);
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) return false;
    requirePng(bytes);
    const parent = dirname(target);
    requireDirectory(parent);
    const before = lstatSync(parent);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(parentFd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Changing output directory');
    // Linux procfs anchors the write to this open directory, never a replacement pathname.
    const anchoredParent = `/proc/self/fd/${parentFd}`;
    const anchor = statSync(anchoredParent);
    if (!anchor.isDirectory() || anchor.dev !== opened.dev || anchor.ino !== opened.ino) throw new Error('Unavailable output directory descriptor');
    requireDirectory(parent);
    const namedBefore = lstatSync(parent);
    if (namedBefore.dev !== opened.dev || namedBefore.ino !== opened.ino) throw new Error('Changing output directory');
    const anchoredTarget = `${anchoredParent}/${SYNTHETIC_CALLBACK_SCREENSHOT_FILE}`;
    fd = openSync(anchoredTarget, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    destination = anchoredTarget; created = fstatSync(fd);
    writeFileSync(fd, bytes);
    requireDirectory(parent);
    const namedAfter = lstatSync(parent);
    if (namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino) throw new Error('Changing output directory');
    closeSync(fd); fd = undefined;
    return true;
  } catch {
    if (destination && created) {
      try {
        const current = lstatSync(destination);
        if (current.isFile() && current.dev === created.dev && current.ino === created.ino) unlinkSync(destination);
      } catch { /* Do not touch an output that is no longer this helper's file. */ }
    }
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Diagnostic retention cannot block cleanup. */ } }
    if (parentFd !== undefined) { try { closeSync(parentFd); } catch { /* Keep the optional evidence path non-throwing. */ } }
  }
}
