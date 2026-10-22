import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { nativeBrowser, nativeBrowserGraph, nativeDocument } from '../helpers/native-browser.ts';
import { semanticFaultControl } from '../helpers/native-semantic-fault.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Every semantic ref, including nested documents. */
function nodes(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe('masked fallback after a stalled semantic reader', () => {
  // These are public contracts, not equivalents of Playwright's individual handle stages.
  // The dedicated native fault binary stalls the actual protected reader; no Page is mocked.
  it.each(['deadline', 'cancellation'] as const)('does not synthesize fallback for a tree-only %s and permits a fresh read', async (failureKind) => {
    const faults = semanticFaultControl();
    const engine = web({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-tree-only-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 5_000, runId: 'tree-only', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'tree-only', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!('about:blank', operation);
      const browser = nativeBrowser(engine, () => operation);
      await nativeDocument(browser, '<button>Still available</button>');
      const before = await engine.observe!(operation);
      const fault = await faults.holdNext('semantic-acquire', before.identityScope);
      const controller = new AbortController();
      try {
        const pending = engine.observe!({ ...operation, signal: controller.signal, timeoutMs: failureKind === 'deadline' ? 2_000 : 5_000 });
        // Attach the assertion immediately so a native deadline cannot become an unhandled rejection.
        const rejected = expect(pending).rejects.toMatchObject({ code: failureKind === 'deadline' ? 'OPERATION_TIMEOUT' : 'CANCELLED' });
        void rejected.catch(() => undefined); // Keep a failed reached() check from leaving the assertion unhandled.
        expect((await fault.reached()).phase).toBe('semantic-acquire');
        if (failureKind === 'cancellation') controller.abort();
        await rejected;
      } finally {
        await fault.release();
      }
      // A failed read must neither publish a pixels-only success nor poison a subsequent read.
      const fresh = await engine.observe!(operation);
      expect(fresh.treeUnavailable).toBeUndefined();
      expect(fresh.pixels).toBeUndefined();
      expect(fresh.identityScope).toBe(before.identityScope);
      expect(nodes(fresh.root).some(node => node.role === 'button' && node.name === 'Still available')).toBe(true);
    } finally {
      try {
        try { await engine.endAttempt!(cleanup); }
        finally { await engine.dispose!(cleanup); }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
        faults.restore();
      }
    }
  });

  it('reserves capture time and takes fresh masked pixels', async () => {
    const faults = semanticFaultControl();
    const engine = web({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-fallback-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 2_000, runId: 'fallback', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'fallback', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!('about:blank', operation);
      const browser = nativeBrowser(engine, () => operation);
      await nativeDocument(browser, '<style>input{position:absolute;left:20px;top:20px;width:100px;height:30px;border:0;padding:0;background:red}</style><input data-testid="password" type="password" value="private-value">');
      const old = await engine.observe!(operation);
      const [password] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, operation);
      expect(password).toBeDefined();
      // A failed semantic transaction must restore before taking fresh protected pixels.
      await browser.evaluate(() => { setTimeout(() => { document.body.style.background = 'blue'; }, 1_000); return null; });
      const fault = await faults.holdNext('semantic-acquire', old.identityScope);
      try {
        const started = performance.now();
        const pending = engine.observe!(operation, { pixels: true, pixelFallback: true });
        void pending.catch(() => undefined); // Retain the original promise until the reached proof is read.
        const reached = await fault.reached();
        expect(reached.phase).toBe('semantic-acquire');
        const fallback = await pending;
        expect(performance.now() - started).toBeGreaterThan(1_250);
        expect(performance.now() - started).toBeLessThan(operation.timeoutMs);
        expect(fallback.treeUnavailable).toBe(true);
        // Fallback retires document/located authority, not the Page viewport.
        // The former same-root-ID assertion was a migration-only assumption.
        expect(fallback.root.ref.id).not.toBe(old.root.ref.id);
        expect(old.viewportRef).toBeDefined();
        expect(fallback.viewportRef).toEqual(old.viewportRef);
        expect(fallback.root.ref.revision).not.toBe(old.root.ref.revision);
        expect(fallback.root.children ?? []).toEqual([]);
        expect(fallback.maskedRegionCount).toBeGreaterThanOrEqual(1);
        const image = decodePng(fallback.pixels!.data);
        expect(image.pixelAt(40, 30)).toEqual([0, 0, 0, 255]);
        expect(image.pixelAt(200, 100)).toEqual([0, 0, 255, 255]);
        await expect(engine.perform!(old.root.ref, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
        await expect(engine.perform!(password!.ref, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
      } finally {
        await fault.release();
      }
    } finally {
      try {
        try { await engine.endAttempt!(cleanup); }
        finally { await engine.dispose!(cleanup); }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
        faults.restore();
      }
    }
  });

  it('keeps abandoned reader IDs distinct from new nodes, frames, and located refs', async () => {
    const faults = semanticFaultControl();
    const engine = web({});
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-semantic-ids-'));
    const signal = new AbortController().signal;
    const operation = { signal, timeoutMs: 5_000, runId: 'ids', attemptId: 'attempt', origin: 'agent' as const };
    const cleanup = { signal, timeoutMs: 30_000 };
    try {
      await engine.init!({ runId: 'ids', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!('about:blank', operation);
      const { browser, correlate } = nativeBrowserGraph(engine, () => operation);
      await nativeDocument(browser, '<button data-testid="a" onclick="document.body.dataset.clicked=\'A\'">Button A</button>');
      const old = await engine.observe!(operation);
      await browser.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Button B';
        button.addEventListener('click', () => { document.body.dataset.clicked = 'B'; });
        document.body.append(button);
        return null;
      });
      const fault = await faults.holdNext('semantic-publish', old.identityScope);
      let abandonedIds: readonly string[] = [];
      try {
        const pending = engine.observe!({ ...operation, timeoutMs: 2_000 }, { pixelFallback: true });
        void pending.catch(() => undefined); // Retain the original promise until the reached proof is read.
        const reached = await fault.reached();
        expect(reached.phase).toBe('semantic-publish');
        abandonedIds = reached.allocatedRefs;
        expect(abandonedIds.length).toBeGreaterThan(0);
        const fallback = await pending;
        expect(fallback.treeUnavailable).toBe(true);
      } finally {
        await fault.release();
      }
      const [located] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'a', exact: true } } }, operation);
      await browser.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Button C';
        button.addEventListener('click', () => { document.body.dataset.clicked = 'C'; });
        document.body.prepend(button);
        const frame = document.createElement('iframe');
        frame.srcdoc = '<button onclick="document.body.dataset.clicked=\'D\'">Button D</button>';
        document.body.append(frame);
        return null;
      });
      await browser.frameLocator('iframe').getByRole('button', { name: 'Button D' }).waitFor();
      const fresh = await engine.observe!(operation);
      const observed = nodes(fresh.root);
      const ids = observed.map((node) => node.ref.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(located).toBeDefined();
      // Distinct locate/observe IDs can retain the same immutable acquisition binding.
      const [correlated] = await correlate([located!.ref], observed, operation);
      const observedA = observed.find(node => node.testId === 'a');
      expect(observedA).toBeDefined();
      expect(correlated).toBe(observedA);
      // Staged IDs from the abandoned transaction are consumed, never retargeted.
      for (const id of abandonedIds) {
        expect(ids).not.toContain(id);
        await expect(engine.perform!({ id, revision: fresh.root.ref.revision }, { kind: 'tap' }, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
      }
      for (const name of ['Button B', 'Button C', 'Button D']) {
        const target = observed.find((node) => node.name === name);
        expect(target, name).toBeDefined();
        await engine.perform!(target!.ref, { kind: 'tap' }, operation);
        const clicked = name === 'Button D'
          ? await browser.frameLocator('iframe').locator('body').getAttribute('data-clicked')
          : await browser.locator('body').getAttribute('data-clicked');
        expect(clicked).toBe(name.slice(-1));
      }
    } finally {
      try {
        try { await engine.endAttempt!(cleanup); }
        finally { await engine.dispose!(cleanup); }
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
        faults.restore();
      }
    }
  });
});
