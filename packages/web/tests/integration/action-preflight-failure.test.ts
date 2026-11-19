/**
 * A `browser.perform` refused before its action context exists still records
 * its closed cause. The page freezes its own renderer in an endless script, so
 * the frame-inventory preflight cannot answer before the operation deadline:
 * the native receipt is a clean not-dispatched refusal, and the cleanup
 * diagnostics file must carry one `ActionFailure` record with the same
 * operation sequence and a preflight stage and reason.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NodeRef } from 'e2e/engine';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

const PAGE = `<!doctype html><title>preflight</title>
<button id="next" type="button">Next</button>`;

interface LedgerEntry {
  readonly command: string;
  readonly operationSeq: number;
  readonly ok: boolean;
  readonly effects: string;
  readonly code?: string;
}

let fixture: NativeFixture | undefined;
let diagnosticsDir: string;
let diagnosticsFile: string;
let ledgerFile: string;

beforeEach(async () => {
  diagnosticsDir = mkdtempSync(path.join(tmpdir(), 'e2e-action-preflight-'));
  diagnosticsFile = path.join(diagnosticsDir, 'native-cleanup.jsonl');
  ledgerFile = path.join(diagnosticsDir, 'native-results.jsonl');
  writeFileSync(diagnosticsFile, '', { mode: 0o600 });
  writeFileSync(ledgerFile, '', { mode: 0o600 });
  process.env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE = diagnosticsFile;
  process.env.E2E_NATIVE_RESULT_LEDGER = ledgerFile;
  fixture = await startNativeFixture('action-preflight-failure');
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
  delete process.env.AGENT_BROWSER_CLEANUP_DIAGNOSTIC_FILE;
  delete process.env.E2E_NATIVE_RESULT_LEDGER;
  rmSync(diagnosticsDir, { recursive: true, force: true });
});

const operation = () => ({ ...fixture!.operation(), timeoutMs: 1_500 });

function entries(file: string): readonly Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
}

async function locatedRef(selector: string): Promise<NodeRef> {
  const matches = await fixture!.engine.locate!({ kind: 'selector', selector }, operation(), { purpose: 'fixture' });
  expect(matches).toHaveLength(1);
  return matches[0]!.ref;
}

async function perform(ref: NodeRef) {
  try {
    await fixture!.engine.perform!(ref, { kind: 'tap' }, operation());
    return undefined;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
}

describe('a perform refused before the action context exists', () => {
  it('records a same-operation preflight cause for a receipt that never dispatched', async () => {
    await nativeDocument(fixture!.browser, PAGE);
    // Resolve the reference before the renderer freezes; perform itself never
    // needs a fresh read.
    const ref = await locatedRef('#next');
    // Start an endless script after evaluate returns, so the renderer is stuck
    // in its own main thread for every later CDP command.
    await fixture!.browser.evaluate(() => {
      setTimeout(() => { while (true) {} }, 50);
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const failure = await perform(ref);
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ retryable: false });

    const receipts = entries(ledgerFile)
      .filter((entry) => entry['command'] === 'browser.perform' && entry['ok'] === false)
      .map((entry) => entry as unknown as LedgerEntry);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.effects).toBe('not-dispatched');

    const records = entries(diagnosticsFile).filter((record) => record['phase'] === 'ActionFailure');
    const matching = records.filter((record) => record['operationSeq'] === receipt.operationSeq);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      actionKind: 'tap',
      actionStage: 'frame-inventory',
      error: receipt.code,
      effects: 'not-dispatched',
    });
    expect(matching[0]!['actionPreflightReason']).toMatch(/^frame-/);
  }, 20_000);
});
