/** Diagnostic-only custody for two exact synthetic F2 fixtures; no product semantics. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES = {
  'web-platform': '7b569b834946506e5589190337659a0f84a738c5273f48bcdaa9c9bf8bbd84a5',
  'transformed-secrets': 'e7a1c840d4661b0060452b9c0343579c129c67466ce1b69c7a3ed88f5680da3c',
} as const;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const projects = new Map<string, string>();
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Only known synthetic values, never env/config secrets or user page data. */
export function hasSyntheticSecret(value: string): boolean {
  const token = 'Tok-9f3aC0DeB1e7';
  const note = 'first line 4417\nsecond line Qx';
  const forms = [token, token.toUpperCase(), token.toLowerCase(), note, note.replaceAll('\n', ' '), JSON.stringify(note).slice(1, -1)];
  // Also refuse a known form serialized as a string (including a literal backslash-n).
  return forms.some((form) => value.includes(form) || value.includes(JSON.stringify(form).slice(1, -1)));
}

export function registerShortReadFixture(dir: string, files: Readonly<Record<string, string>>): void {
  if (process.env['E2E_SHORT_READ_CUSTODY_DIR'] === undefined) return;
  try {
    const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    projects.set(dir, hash(JSON.stringify(entries)));
  } catch { /* Missing fixture registration is refused at custody; never alter createProject. */ }
}

/** Validate every directory component; destination must be precreated, not a symlink. */
function directoryIsSafe(dir: string): boolean {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) return false;
  let cursor = path.parse(dir).root;
  for (const part of dir.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

function writeExclusive(file: string, bytes: string | Buffer): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not-regular');
    writeFileSync(fd, bytes);
  } finally { closeSync(fd); }
}

type Status = 'captured' | 'fixture-refused' | 'destination-refused' | 'oversize' | 'redaction-refused' | 'write-refused';

/** Called only after run settles; never changes outcome, errors, or fixture cleanup. */
export function retainShortReadReport(dir: string, report: unknown): void {
  const destination = process.env['E2E_SHORT_READ_CUSTODY_DIR'];
  if (destination === undefined) return;
  let status: Status = 'destination-refused';
  try {
    const suite = process.env['E2E_SHORT_READ_SUITE'];
    if ((suite !== 'web-platform' && suite !== 'transformed-secrets') || projects.get(dir) !== FIXTURES[suite]) {
      status = 'fixture-refused';
      return;
    }
    if (!directoryIsSafe(destination)) return;
    // One fresh directory per completed fixture; no overwrite or recursive discovery.
    const archive = mkdtempSync(path.join(destination, 'fixture-'));
    mkdirSync(path.join(archive, 'reports'), { mode: 0o700 });
    const serialized = JSON.stringify(report);
    const bytes = Buffer.from(serialized, 'utf8');
    status = bytes.byteLength > MAX_REPORT_BYTES ? 'oversize'
      : hasSyntheticSecret(serialized) ? 'redaction-refused' : 'captured';
    if (status === 'captured') writeExclusive(path.join(archive, 'reports', 'report.json'), bytes);
    writeExclusive(path.join(archive, 'custody.json'), JSON.stringify({
      schema: 1, suite, status, fixtureHash: FIXTURES[suite],
      // Serialized unchanged outcome.report; NOT the original reporter-file bytes.
      representation: 'unmodified-outcome-report-json',
      ...(status === 'captured' ? { bytes: bytes.byteLength, sha256: hash(bytes) } : {}),
    }) + '\n');
  } catch { status = 'write-refused'; }
  finally {
    // A closed receipt remains available even when destination/file writing failed.
    // The workflow treats absent/refused custody as incomplete, independently of test exit.
    try { process.stderr.write(`SHORT_READ_CUSTODY ${JSON.stringify({ schema: 1, status })}\n`); } catch { /* no product result mutation */ }
    projects.delete(dir);
  }
}
