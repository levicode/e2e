import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, type OperationContext } from 'e2e/engine';
import * as filesystem from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { readUploadFile, selectUploadFiles } from '../../src/native/upload-files.ts';
const roots: string[] = [];
const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), 'native-upload-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('directory upload selection', () => {
  it('preserves nested relative names without sending runner paths as metadata', async () => {
    const root = await fixture(); await mkdir(path.join(root, 'nested')); await writeFile(path.join(root, 'nested', 'synthetic.txt'), 'synthetic');
    expect(await selectUploadFiles([root], operation())).toEqual({ directoryName: path.basename(root), files: [{ path: path.join(root, 'nested', 'synthetic.txt'), name: 'synthetic.txt', relativePath: 'nested/synthetic.txt' }] });
  });
  it('keeps an empty directory distinct from clearing file inputs', async () => {
    const root = await fixture(); expect(await selectUploadFiles([root], operation())).toEqual({ directoryName: path.basename(root), files: [] });
    expect(await selectUploadFiles([], operation())).toEqual({ files: [] });
  });
  it('allows explicit files outside a project without inventing a project restriction', async () => {
    const root = await fixture(); const file = path.join(root, 'synthetic.txt'); await writeFile(file, 'synthetic');
    expect(await selectUploadFiles([file], operation())).toEqual({ files: [{ path: file, name: 'synthetic.txt' }] });
  });
  it('rejects links escaping the selected directory and ancestor cycles', async () => {
    const root = await fixture(); const outside = await fixture(); await writeFile(path.join(outside, 'private.txt'), 'synthetic');
    await symlink(path.join(outside, 'private.txt'), path.join(root, 'escape'));
    await expect(selectUploadFiles([root], operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await rm(path.join(root, 'escape')); await symlink(root, path.join(root, 'cycle'));
    await expect(selectUploadFiles([root], operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('rejects a parent-directory symlink swap before reading outside bytes', async () => {
    const root = await fixture(); const outside = await fixture(); const nested = path.join(root, 'nested');
    await mkdir(nested); await writeFile(path.join(nested, 'same.txt'), 'selected');
    await writeFile(path.join(outside, 'same.txt'), 'synthetic-outside');
    const selection = await selectUploadFiles([root], operation());
    await rename(nested, path.join(root, 'retired')); await symlink(outside, nested);
    await expect(readUploadFile(selection.files[0]!, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('reads the selected regular file through its validated open handle', async () => {
    const root = await fixture(); const file = path.join(root, 'same.txt'); await writeFile(file, 'selected');
    const selection = await selectUploadFiles([file], operation());
    expect((await readUploadFile(selection.files[0]!, operation())).toString()).toBe('selected');
    await rename(file, `${file}.retired`); await writeFile(file, 'replacement');
    await expect(readUploadFile(selection.files[0]!, operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('retains cancellation classification if closing the selected handle also fails', async () => {
    const root = await fixture(); const file = path.join(root, 'same.txt'); await writeFile(file, 'selected');
    const selection = await selectUploadFiles([file], operation());
    const handle = await filesystem.open(file, 'r'); const realClose = handle.close.bind(handle);
    const primary = new EngineError('CANCELLED', 'synthetic cancellation', { retryable: false });
    vi.spyOn(handle, 'readFile').mockRejectedValueOnce(primary);
    vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await realClose(); throw new Error('synthetic-private-path'); });
    vi.mocked(filesystem.open).mockResolvedValueOnce(handle);
    try {
      await expect(readUploadFile(selection.files[0]!, operation())).rejects.toBe(primary);
      expect(primary.cause).toMatchObject({ code: 'ENGINE_FAILURE', message: 'Upload file handle cleanup failed' });
    } finally { vi.mocked(filesystem.open).mockClear(); }
  });
  it('rejects mixed directory and file selection and cancelled traversal', async () => {
    const root = await fixture(); await expect(selectUploadFiles([root, root], operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(selectUploadFiles([root], { ...operation(), signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
