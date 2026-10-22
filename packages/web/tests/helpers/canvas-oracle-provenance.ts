/** Node-only source and runner-receipt provenance for the test-only P42O primitive oracle. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export const CANVAS_BASELINE_REVISION = 'd7c6b5e5a4c27fac7633e66866fd367b0351ead8';
const ROOT = resolve(import.meta.dirname, '../../../..');
const MANIFEST_PATH = 'packages/web/tests/helpers/canvas-oracle-manifest.json';
const RECEIPT_PATH = '.artifacts/native-candidate/web-unit.result.json';
const require = createRequire(import.meta.url);
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export interface CanvasOracleManifest {
  baselineRevision: string;
  claim: string;
  entry: string;
  sources: { path: string; currentSha256: string; baselineSha256: string | null; byteEqual: boolean; imports: string[]; external: string[]; differenceReview?: string }[];
  runtimeEntry: string;
  runtime: { path: string; sourcePath: string }[];
  movedSymbols: { name: string; baselinePath: string; currentPath: string; source: string; sha256: string }[];
}

/** Source files and build artifacts must be local regular files, not aliases outside the candidate. */
function boundedFile(root: string, relative: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.startsWith('/') || relative.split('/').includes('..')) throw new Error('Unavailable oracle source');
  const path = join(root, relative);
  if (realpathSync(path) !== path) throw new Error('Unavailable oracle alias');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Unavailable oracle file');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error('Changing oracle file');
  return bytes;
}

/** The complete build inventory, not just the twenty imported core modules, must agree with the receipt. */
export function canvasCoreInventory(root: string): { path: string; sha256: string }[] {
  const directory = join(root, 'packages/e2e/dist');
  if (realpathSync(directory) !== directory) throw new Error('Unavailable core build');
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  if (entries.length > 8192 || entries.some(entry => entry.isSymbolicLink())) throw new Error('Unavailable core inventory');
  let total = 0;
  const files = entries.filter(entry => entry.isFile()).map(entry => {
    const path = 'dist/' + join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/');
    const bytes = boundedFile(root, `packages/e2e/${path}`, 8 * 1024 * 1024);
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error('Oversize core inventory');
    return { path, sha256: sha256(bytes) };
  }).toSorted((a, b) => a.path.localeCompare(b.path));
  if (!files.some(file => file.path === 'dist/index.js')) throw new Error('Incomplete core build');
  return files;
}

/** Pure receipt comparison is separately exercised with synthetic Node-only fixtures, never represented as a real build. */
export function canvasReceiptMatches(
  receipt: unknown,
  binding: { sourceRevision: string; binarySha256: string },
  inventory: readonly { path: string; sha256: string }[],
): boolean {
  if (!object(receipt) || receipt['schemaVersion'] !== 1 || receipt['suite'] !== 'web-unit' || receipt['status'] !== 'passed'
    || receipt['sourceRevision'] !== binding.sourceRevision || receipt['binarySha256'] !== binding.binarySha256
    || !digest(binding.sourceRevision, 40) || !digest(binding.binarySha256)
    || !object(receipt['runtimeBuild']) || !Array.isArray(receipt['runtimeBuild']['core'])) return false;
  const core: unknown[] = receipt['runtimeBuild']['core'];
  return core.length === inventory.length && core.every((item, index) => object(item)
    && Object.keys(item).length === 2 && item['path'] === inventory[index]?.path && item['sha256'] === inventory[index]?.sha256);
}

/** Checks every source dependency plus actual loaded build before importing the legacy capture primitive. */
export function canvasOracleAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (env['E2E_SYNTHETIC_EVIDENCE_BATCH'] !== '1') return false;
    const binding: unknown = JSON.parse(env['E2E_SYNTHETIC_EVIDENCE_BINDING'] ?? 'null');
    if (!object(binding) || !digest(binding['sourceRevision'], 40) || !digest(binding['binarySha256'])) return false;
    const manifest = JSON.parse(boundedFile(ROOT, MANIFEST_PATH, 64 * 1024).toString('utf8')) as CanvasOracleManifest;
    if (manifest.baselineRevision !== CANVAS_BASELINE_REVISION || manifest.claim !== 'source-equivalent-primitive-oracle'
      || manifest.entry !== 'packages/web/src/observation.ts' || manifest.runtimeEntry !== 'packages/e2e/dist/engine/index.js'
      || manifest.sources.length !== 26 || manifest.runtime.length !== 20) return false;
    const paths = new Set(manifest.sources.map(source => source.path));
    if (paths.size !== manifest.sources.length) return false;
    for (const source of manifest.sources) {
      if (sha256(boundedFile(ROOT, source.path, 1024 * 1024)) !== source.currentSha256
        || !digest(source.currentSha256) || (source.baselineSha256 !== null && !digest(source.baselineSha256))
        || source.byteEqual !== (source.currentSha256 === source.baselineSha256)
        || (!source.byteEqual && !source.differenceReview)
        || source.imports.some(path => !paths.has(path)) || source.external.some(name => !name.startsWith('node:'))) return false;
    }
    for (const symbol of manifest.movedSymbols) {
      if (sha256(symbol.source) !== symbol.sha256 || !paths.has(symbol.currentPath)
        || !boundedFile(ROOT, symbol.currentPath, 1024 * 1024).toString('utf8').includes(symbol.source)) return false;
    }
    const expectedEntry = join(ROOT, manifest.runtimeEntry);
    if (realpathSync(require.resolve('e2e/engine')) !== expectedEntry || realpathSync(expectedEntry) !== expectedEntry) return false;
    const inventory = canvasCoreInventory(ROOT);
    const outputs = new Set(inventory.map(file => `packages/e2e/${file.path}`));
    if (new Set(manifest.runtime.map(file => file.path)).size !== manifest.runtime.length
      || manifest.runtime.some(file => !paths.has(file.sourcePath) || !outputs.has(file.path)
        || file.path !== file.sourcePath.replace('/src/', '/dist/').replace(/\.ts$/, '.js'))) return false;
    const receipt: unknown = JSON.parse(boundedFile(ROOT, RECEIPT_PATH, 2 * 1024 * 1024).toString('utf8'));
    return canvasReceiptMatches(receipt, { sourceRevision: binding['sourceRevision'], binarySha256: binding['binarySha256'] }, inventory);
  } catch { return false; }
}


/** A deadline bounds waiting, not the real lifetime of an in-flight browser promise.
 * Every promise retains this owner until actual settlement; late resources may only be disposed.
 */
export class CanvasOracleLifetime {
  readonly signal: AbortSignal;
  readonly workDeadline: number;
  readonly totalDeadline: number;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #resources = new Map<unknown, { dispose: () => Promise<unknown>; priority: number; state: 'owned' | 'disposing' | 'disposed' }>();
  readonly #timer: ReturnType<typeof setTimeout>;
  #stopped = false;
  #cleanupFailed = false;

  constructor(totalMs = 20_000, cleanupReserveMs = 5_000) {
    if (!Number.isSafeInteger(totalMs) || !Number.isSafeInteger(cleanupReserveMs) || cleanupReserveMs <= 0 || cleanupReserveMs >= totalMs) throw new Error('Invalid oracle lifetime');
    const now = Date.now();
    this.totalDeadline = now + totalMs;
    this.workDeadline = this.totalDeadline - cleanupReserveMs;
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(() => this.#stop(), totalMs - cleanupReserveMs);
  }
  get workRemaining(): number { return Math.max(0, this.workDeadline - Date.now()); }
  get settled(): boolean { return this.#pending.size === 0 && !this.#cleanupFailed && [...this.#resources.values()].every(resource => resource.state === 'disposed'); }
  #stop(): void { this.#stopped = true; this.#controller.abort(); }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise));
    return promise;
  }
  async #within<T>(promise: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Oracle deadline');
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.#stop(); reject(new Error('Oracle deadline')); }, left);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  #ready(): void { if (this.#stopped || this.workRemaining <= 0) throw new Error('Oracle work closed'); }
  publish<T>(value: T, dispose: (resource: T) => Promise<unknown>, priority = 0): void {
    if (this.#resources.has(value)) return;
    const resource = { dispose: () => dispose(value), priority, state: 'owned' as const };
    this.#resources.set(value, resource);
    if (this.#stopped || this.workRemaining <= 0) this.#dispose(resource);
  }
  #dispose(resource: { dispose: () => Promise<unknown>; state: 'owned' | 'disposing' | 'disposed' }): void {
    if (resource.state !== 'owned') return;
    resource.state = 'disposing';
    // Keep even post-deadline disposers tracked until they truly settle. Never interpret a timer as disposal.
    this.#track(Promise.resolve().then(resource.dispose).then(
      () => { resource.state = 'disposed'; },
      () => { resource.state = 'disposed'; this.#cleanupFailed = true; },
    ));
  }
  async acquire<T>(create: () => Promise<T>, dispose: (resource: T) => Promise<unknown>, priority: number): Promise<T> {
    this.#ready();
    const pending = this.#track(Promise.resolve().then(create).then(value => {
      this.publish(value, dispose, priority);
      return value;
    }));
    const value = await this.#within(pending, this.workDeadline);
    this.#ready();
    return value;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#ready();
    const value = await this.#within(this.#track(Promise.resolve().then(work)), this.workDeadline);
    this.#ready();
    return value;
  }
  async cleanup(): Promise<boolean> {
    this.#stop(); clearTimeout(this.#timer);
    for (const resource of [...this.#resources.values()].toSorted((a, b) => a.priority - b.priority)) this.#dispose(resource);
    try {
      // A late acquire may add another disposer while this batch settles, so drain until stable.
      while (this.#pending.size > 0) await this.#within(Promise.allSettled(this.#pending), this.totalDeadline);
      return this.settled;
    } catch { return false; }
  }
}

export interface CanvasNativeTarget {
  nativeIncluded: boolean;
  roleOrdinal: 0 | 1 | 2 | 3 | 4;
  namePresence: boolean;
  valuePresence: boolean;
}
export interface CanvasNativePair {
  htmlSha256: string;
  targets: readonly CanvasNativeTarget[];
}
export const CANVAS_TARGET_IDS = ['canvas', 'svg', 'frame', 'host'] as const;
const CANVAS_ROLES: readonly (string | undefined)[] = [undefined, 'image', 'iframe', 'textbox'];
export function canvasRoleOrdinal(role: string | undefined): CanvasNativeTarget['roleOrdinal'] {
  const ordinal = CANVAS_ROLES.indexOf(role);
  return ordinal < 0 ? 4 : ordinal as 0 | 1 | 2 | 3;
}
/** The cross-test pair contains four closed facts and a static fixture hash, never DTOs or refs. */
export function pairCanvasNative(
  nodes: ReadonlyMap<string, { role?: string; name?: string; value?: string }>, html: string,
): CanvasNativePair {
  return { htmlSha256: sha256(html), targets: CANVAS_TARGET_IDS.map(testId => {
    const native = nodes.get(testId);
    return { nativeIncluded: native !== undefined, roleOrdinal: canvasRoleOrdinal(native?.role),
      namePresence: native?.name !== undefined, valuePresence: native?.value !== undefined };
  }) };
}
export function canvasPairMatches(pair: CanvasNativePair | undefined, html: string): pair is CanvasNativePair {
  return pair !== undefined && pair.htmlSha256 === sha256(html) && pair.targets.length === 4
    // A native mismatch is the reason for the oracle, not a reason to refuse its acquisition.
    && pair.targets.every(target => Number.isInteger(target.roleOrdinal) && target.roleOrdinal >= 0 && target.roleOrdinal <= 4);
}

/** Baseline roles outside the known fixture domain are unavailable, never other-equals-other proof. */
export function canvasRolesMatch(nativeOrdinal: CanvasNativeTarget['roleOrdinal'], baselineOrdinal: CanvasNativeTarget['roleOrdinal']): boolean {
  return baselineOrdinal < 4 && nativeOrdinal === baselineOrdinal;
}
