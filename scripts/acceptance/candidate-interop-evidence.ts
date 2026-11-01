/** Archive the existing four interop fixtures; never run or weaken their assertions. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, lstatSync, mkdirSync, mkdtempSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const isolated = ['isolated-page-reopen-owned.json', 'isolated-page-reopen-borrowed.json',
  'isolated-reopen-owned-1.png', 'isolated-reopen-owned-2.png', 'isolated-reopen-borrowed-1.png', 'isolated-reopen-borrowed-2.png'];
export const INTEROP_FILES = {
  'isolated-page-reopen.test.ts': ['file-identity.json', ...isolated],
  'isolated-page-reopen-native-receipts.test.ts': ['file-identity.json', ...isolated, 'isolated-page-reopen-native-owned.json', 'isolated-page-reopen-native-borrowed.json'],
  'persistent-raw-reconnect.test.ts': ['file-identity.json', 'persistent-raw-reconnect.json'],
  'persistent-raw-reconnect-native-receipts.test.ts': ['file-identity.json', 'persistent-raw-reconnect.json', 'persistent-raw-reconnect-native-receipts.json'],
} as const;
/** Existing root writers, separate from the four required interop suites. Never acceptance evidence. */
export const SUPPLEMENTAL_INTEROP_WRITERS: Readonly<Record<string, string>> = {
  "fresh-surface.json": "packages/web/tests/integration/surface-of-native-fresh.test.ts",
  "persistent-reopen-borrowed.json": "packages/web/tests/integration/surface-of-native-persistent-reopen.test.ts",
  "persistent-reopen-borrowed-fenced-race.json": "packages/web/tests/integration/surface-of-native-persistent-reopen.test.ts",
  "replacement-retirement-reset-before-old-close.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-retirement-reset-after-old-close.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-retirement-reset-after-new-create.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-retirement-restore-before-old-close.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-retirement-restore-after-old-close.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-retirement-restore-after-new-create.json": "packages/web/tests/integration/surface-of-native-replacement-retirement.test.ts",
  "replacement-surface-owned.json": "packages/web/tests/integration/surface-of-native-replacement.test.ts",
  "replacement-surface-borrowed.json": "packages/web/tests/integration/surface-of-native-replacement.test.ts",
  "restart-retirement-owned-endAttempt.json": "packages/web/tests/integration/surface-of-native-restart-retirement.test.ts",
  "restart-retirement-owned-dispose.json": "packages/web/tests/integration/surface-of-native-restart-retirement.test.ts",
  "restart-retirement-borrowed-endAttempt.json": "packages/web/tests/integration/surface-of-native-restart-retirement.test.ts",
  "restart-retirement-borrowed-dispose.json": "packages/web/tests/integration/surface-of-native-restart-retirement.test.ts",
  "restart-surface-owned.json": "packages/web/tests/integration/surface-of-native-restart.test.ts",
  "restart-surface-borrowed.json": "packages/web/tests/integration/surface-of-native-restart.test.ts",
  "peer-terminal-before-dispose.json": "packages/web/tests/integration/surface-of-native-retirement-close.test.ts",
  "peer-terminal-after-dispose.json": "packages/web/tests/integration/surface-of-native-retirement-close.test.ts",
  "reuse-surface-owned.json": "packages/web/tests/integration/surface-of-native-reuse.test.ts",
  "reuse-surface-borrowed.json": "packages/web/tests/integration/surface-of-native-reuse.test.ts",
  "dialog-guard-before-app.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts",
  "dialog-guard-held-decision.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts",
  "dialog-guard-raw-observers.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts",
  "dialog-guard-no-handler.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts",
  "dialog-guard-popup-replacement.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts",
  "dialog-guard-borrowed-exact-page.json": "packages/web/tests/integration/native-playwright-dialog-ownership.test.ts"
};
const ROOT_DIAGNOSTIC_LIMIT = 128;
const SUPPLEMENTAL_BYTE_BUDGET = 32 * 1024 * 1024;
function archiveRootDiagnostics(root: string, destination: string, names: string[]) {
  const supplemental: { name: string; sourceTestPath: string; status: string; bytes?: number; sha256?: string }[] = [];
  const unknown = names.filter(name => !Object.hasOwn(SUPPLEMENTAL_INTEROP_WRITERS, name)).sort();
  const entries = unknown.slice(0, ROOT_DIAGNOSTIC_LIMIT).map(name => {
    let kind = 'unavailable';
    try { const stat = lstatSync(join(root, name)); kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'nonregular'; } catch { /* Metadata only; never follow or read unknown entries. */ }
    return { nameSha256: hash(Buffer.from(name)), kind, unsafe: kind !== 'file' };
  });
  let remaining = SUPPLEMENTAL_BYTE_BUDGET;
  mkdirSync(join(destination, 'supplemental'));
  for (const name of names.filter(name => Object.hasOwn(SUPPLEMENTAL_INTEROP_WRITERS, name)).sort()) {
    const sourceTestPath = SUPPLEMENTAL_INTEROP_WRITERS[name]!;
    try {
      const input = join(root, name); const stat = lstatSync(input);
      if (!stat.isFile() || stat.isSymbolicLink() || remaining === 0) throw new Error('Unsafe or over-budget supplemental file');
      const bytes = readStableInteropFile(input, Math.min(16 * 1024 * 1024, remaining));
      writeFileSync(join(destination, 'supplemental', name), bytes, { flag: 'wx' }); remaining -= bytes.length;
      supplemental.push({ name, sourceTestPath, status: 'archived', bytes: bytes.length, sha256: hash(bytes) });
    } catch { supplemental.push({ name, sourceTestPath, status: 'unavailable-unsafe-or-over-budget' }); }
  }
  return { acceptanceEvidence: false, supplemental, supplementalByteBudget: SUPPLEMENTAL_BYTE_BUDGET,
    supplementalHelperPath: 'packages/web/tests/helpers/native-dialog-fixture.ts',
    unknownRoots: { total: unknown.length, retained: entries.length, truncated: entries.length < unknown.length,
      unsafeObserved: entries.filter(entry => entry.unsafe).length, uninspected: unknown.length - entries.length, entries },
    note: 'Supplemental and unknown root entries are not four-suite proof. Unknown contents are never read or archived.' };
}
export interface InteropCapture { root: string; testDirectory: string }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Bounded, nonblocking regular-file read; never follows an alias or trusts a pre-read size alone. */
export function readStableInteropFile(path: string, cap = 16 * 1024 * 1024): Buffer {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 16 * 1024 * 1024 || !isAbsolute(path) || realpathSync(path) !== path) throw new Error('Unsafe interop file path or bound');
  const before = lstatSync(path, { bigint: true });
  const stable = (value: typeof before) => value.isFile() && value.dev === before.dev && value.ino === before.ino
    && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
  if (!before.isFile() || before.size > BigInt(cap)) throw new Error('Unsafe or oversized interop file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!stable(fstatSync(fd, { bigint: true }))) throw new Error('Changed interop file before read');
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, Math.min(65536, bytes.length - length), null);
      if (count === 0) break;
      length += count;
    }
    if (length > cap || BigInt(length) !== before.size || !stable(fstatSync(fd, { bigint: true }))
      || !stable(lstatSync(path, { bigint: true })) || realpathSync(path) !== path) throw new Error('Changed or oversized interop file during read');
    return Buffer.from(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
export function prepareInteropCapture(testDirectory: string): InteropCapture {
  if (!isAbsolute(testDirectory) || realpathSync(testDirectory) !== testDirectory) throw new Error('Canonical interop test directory required');
  return { root: mkdtempSync(join(realpathSync(tmpdir()), 'e2e-formal-interop-')), testDirectory };
}
export function interopEnvironment(inherited: NodeJS.ProcessEnv, capture?: InteropCapture): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env['E2E_INTEROP_EVIDENCE_DIR']; delete env['E2E_INTEROP_FILE_SCOPED_EVIDENCE'];
  if (capture) { env['E2E_INTEROP_EVIDENCE_DIR'] = capture.root; env['E2E_INTEROP_FILE_SCOPED_EVIDENCE'] = '1'; }
  return env;
}
/** Preserve every available known file even on a failing run. Missing or unsafe files never pass. */
export function archiveInteropCapture(capture: InteropCapture, output: string, identityUnchanged: boolean) {
  const destination = join(resolve(output), 'interop');
  if (realpathSync(resolve(output)) !== resolve(output)) throw new Error('Canonical interop archive parent required');
  mkdirSync(destination); // Refuse a stale/reused archive instead of overwriting it.
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const missing: string[] = []; const invalid: string[] = [];
  if (!isAbsolute(capture.root) || realpathSync(capture.root) !== capture.root || !lstatSync(capture.root).isDirectory()) throw new Error('Changed interop temporary root');
  const expectedDirectories = Object.keys(INTEROP_FILES);
  const rootDiagnostics = archiveRootDiagnostics(capture.root, destination, readdirSync(capture.root).filter(name => !expectedDirectories.includes(name))); 
  for (const [testFile, expected] of Object.entries(INTEROP_FILES)) {
    const source = join(capture.root, testFile); const target = join(destination, testFile);
    mkdirSync(target);
    try {
      if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory() || realpathSync(source) !== source) throw new Error();
      for (const name of readdirSync(source)) if (!(expected as readonly string[]).includes(name)) invalid.push(`${testFile}/unexpected-entry`);
    } catch { missing.push(...expected.map(name => `${testFile}/${name}`)); continue; }
    for (const name of expected) {
      const path = `${testFile}/${name}`; const input = join(source, name);
      let bytes: Buffer;
      try {
        bytes = readStableInteropFile(input);
      } catch { missing.push(path); continue; }
      // Keep raw original evidence, including a malformed/failing receipt, before validating it.
      writeFileSync(join(target, name), bytes, { flag: 'wx' });
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
      try {
        if (name.endsWith('.json')) {
          const value = JSON.parse(bytes.toString('utf8'));
          if (name === 'file-identity.json' && (Object.keys(value).join(',') !== 'collectedTestPath' || value.collectedTestPath !== join(capture.testDirectory, testFile))) throw new Error();
        } else if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error();
      } catch { invalid.push(path); }
    }
  }
  const receipt = { schemaVersion: 1, status: identityUnchanged && missing.length === 0 && invalid.length === 0 ? 'captured' : 'incomplete',
    identityUnchanged, files, missing, invalid, rootDiagnostics, note: 'Archive integrity only; original Vitest assertions and run-level source/native/binary binding remain authoritative.' };
  writeFileSync(join(destination, 'archive.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

/** Final receipt re-reads the archived originals; a status string alone is not evidence. */
export function verifyInteropArchive(output: string, value: unknown, testDirectory: string): void {
  const directory = join(resolve(output), 'interop');
  if (realpathSync(directory) !== directory) throw new Error('Noncanonical interop archive');
  const receipt = JSON.parse(readStableInteropFile(join(directory, 'archive.json'), 65536).toString('utf8')) as ReturnType<typeof archiveInteropCapture>;
  if (JSON.stringify(value) !== JSON.stringify(receipt) || receipt.schemaVersion !== 1 || receipt.status !== 'captured' || receipt.identityUnchanged !== true
    || !Array.isArray(receipt.missing) || receipt.missing.length || !Array.isArray(receipt.invalid) || receipt.invalid.length || !Array.isArray(receipt.files)) throw new Error('Incomplete interop archive');
  const expected = Object.entries(INTEROP_FILES).flatMap(([test, names]) => names.map(name => `${test}/${name}`));
  if (JSON.stringify(receipt.files.map(file => file.path)) !== JSON.stringify(expected)) throw new Error('Changed interop archive inventory');
  for (const file of receipt.files) {
    const path = join(directory, file.path);
    const bytes = readStableInteropFile(path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Changed interop archive bytes');
    if (file.path.endsWith('/file-identity.json')) {
      const identity = JSON.parse(bytes.toString('utf8')) as { collectedTestPath: string };
      if (Object.keys(identity).join(',') !== 'collectedTestPath' || identity.collectedTestPath !== join(testDirectory, file.path.split('/')[0]!)) throw new Error('Changed interop collected file identity');
    }
  }
}
