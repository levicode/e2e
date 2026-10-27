/** Public closed-root contracts, not the retired author WeakMap/selector registry. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { nativeBrowser, nativeDocument } from '../helpers/native-browser.ts';
import { observedNodes } from '../helpers/native-correlation.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

async function fixture(name: string) {
  const artifactsDir = mkdtempSync(path.join(tmpdir(), `e2e-${name}-`));
  const engine = web({ viewport: { width: 480, height: 320 } });
  const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 10_000,
    runId: name, attemptId: `${name}-1`, origin: 'test' });
  const close = async () => {
    try { await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 30_000 }); }
    finally { rmSync(artifactsDir, { recursive: true, force: true }); }
  };
  try {
    await engine.init!({ runId: name, targetName: 'web', projectRoot: process.cwd(), app: {}, env: process.env,
      headed: false, workerSlot: 0, signal: operation().signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: `${name}-1`, artifactsDir, signal: operation().signal,
      resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation());
    return { engine, operation, artifactsDir, browser: nativeBrowser(engine, operation), close };
  } catch (cause) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([cause, cleanup], 'Closed-root fixture startup cleanup failed', { cause: cleanup }); }
    throw cause;
  }
}

it('discovers late author closed roots exactly once and acts on their observed refs without replacing the app attachShadow hook', async () => {
  const f = await fixture('closed-root-public');
  try {
    await nativeDocument(f.browser, '<button data-testid="light">Apply</button><output id="status">Idle</output>');
    await f.browser.evaluate(() => {
      const original = Element.prototype.attachShadow;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')!;
      const calls: string[] = [];
      const hook = function (this: Element, init: ShadowRootInit) {
        calls.push(init.mode);
        return Reflect.apply(original, this, [init]) as ShadowRoot;
      };
      Object.defineProperty(Element.prototype, 'attachShadow', { ...descriptor, value: hook });
      Reflect.set(globalThis, '__closedContract', { original, descriptor, hook, calls });
      return null;
    });
    const query = { kind: 'query' as const, query: { kind: 'role' as const,
      value: { kind: 'string' as const, value: 'button', exact: true },
      name: { kind: 'string' as const, value: 'Apply', exact: true } } };
    expect((await f.engine.locate!(query, f.operation())).map(node => node.testId)).toEqual(['light']);
    expect(observedNodes((await f.engine.observe!(f.operation())).root).filter(node => node.role === 'button').map(node => node.testId)).toEqual(['light']);

    await f.browser.evaluate(() => {
      for (const mode of ['open', 'closed'] as const) {
        const host = document.createElement('section'); host.id = `${mode}-host`; document.body.append(host);
        const root = host.attachShadow({ mode });
        root.innerHTML = `<button data-testid="${mode}">Apply</button>`;
        root.querySelector('button')!.addEventListener('click', () => {
          const status = document.querySelector<HTMLOutputElement>('#status')!;
          status.textContent = `${mode} applied`; status.dataset['clicks'] = String(Number(status.dataset['clicks'] ?? '0') + 1);
        });
      }
      return null;
    });
    for (let capture = 0; capture < 2; capture += 1) {
      const located = await f.engine.locate!(query, f.operation());
      expect(located.map(node => node.testId).toSorted()).toEqual(['closed', 'light', 'open']);
      expect(new Set(located.map(node => node.ref.id)).size).toBe(3);
      const snapshot = await f.engine.observe!({ ...f.operation(), origin: 'agent' });
      const buttons = observedNodes(snapshot.root).filter(node => node.role === 'button');
      expect(buttons.map(node => node.testId).toSorted()).toEqual(['closed', 'light', 'open']);
      expect(new Set(buttons.map(node => node.ref.id)).size).toBe(3);
      // The native observation's actual closed-root ref remains actionable.
      await f.engine.perform!(buttons.find(node => node.testId === 'closed')!.ref, { kind: 'tap' }, f.operation());
      expect(await f.browser.evaluate(() => {
        const status = document.querySelector<HTMLOutputElement>('#status')!;
        return { text: status.textContent, clicks: status.getAttribute('data-clicks') };
      })).toEqual({ text: 'closed applied', clicks: String(capture + 1) });
    }
    expect(await f.browser.evaluate(() => {
      const state = Reflect.get(globalThis, '__closedContract') as {
        hook: typeof Element.prototype.attachShadow; descriptor: PropertyDescriptor; calls: string[];
      };
      const current = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow')!;
      return { sameHook: current.value === state.hook, writable: current.writable === state.descriptor.writable,
        enumerable: current.enumerable === state.descriptor.enumerable, configurable: current.configurable === state.descriptor.configurable,
        calls: state.calls, open: document.querySelector('#open-host')!.shadowRoot !== null,
        closed: document.querySelector('#closed-host')!.shadowRoot === null };
    })).toEqual({ sameHook: true, writable: true, enumerable: true, configurable: true, calls: ['open', 'closed'], open: true, closed: true });
  } finally { await f.close(); }
});

it('refuses unprovable closed-root masks without publishing pixels, restores author state, and succeeds after the author constraint is removed', async () => {
  const f = await fixture('closed-root-mask-refusal');
  try {
    await nativeDocument(f.browser, '<body style="margin:0;background:blue"><div id="host"></div><div style="position:absolute;left:180px;top:20px;width:100px;height:40px;background:rgb(0,128,0)"></div><button data-testid="optional-tree-witness" style="position:absolute;left:300px;top:260px">Optional tree witness</button></body>');
    await f.browser.evaluate(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' });
      const input = document.createElement('input'); input.type = 'password'; input.value = 'synthetic-closed-mask-secret';
      // Author inline !important wins over an injected author stylesheet. The
      // producer must prove source suppression, not optimistically emit pixels.
      input.style.cssText = 'position:absolute;left:20px;top:20px;width:120px;height:40px;border:0;padding:0;background:red;color:red;opacity:1!important';
      root.append(input);
      Reflect.set(globalThis, '__closedMaskContract', { root, input, style: input.getAttribute('style') });
      return null;
    });
    for (const capture of ['optional-observation', 'mandatory-screenshot'] as const) {
      if (capture === 'optional-observation') {
        const tree = await f.engine.observe!(f.operation(), { pixels: true });
        expect(tree.treeUnavailable).toBeUndefined();
        expect(tree.root).toBeDefined();
        expect(observedNodes(tree.root).filter(node => node.testId === 'optional-tree-witness'))
          .toMatchObject([{ role: 'button', name: 'Optional tree witness' }]);
        expect(tree.truncated).not.toBe(true);
        expect(tree.pixels).toBeUndefined();
        expect(tree.maskedRegionCount).toBeUndefined();
        expect(JSON.stringify(tree.root)).not.toContain('synthetic-closed-mask-secret');
      } else {
        await expect(f.engine.artifacts!.screenshot('must-not-publish', f.operation()))
          .rejects.toMatchObject({ code: 'POLICY_DENIED', retryable: false });
      }
      expect(readdirSync(f.artifactsDir, { recursive: true }).filter(entry => entry.toString().endsWith('.png'))).toEqual([]);
      expect(await f.browser.evaluate(() => {
        const state = Reflect.get(globalThis, '__closedMaskContract') as { root: ShadowRoot; input: HTMLInputElement; style: string };
        return { unchangedValue: state.input.value === 'synthetic-closed-mask-secret', unchangedStyle: state.input.getAttribute('style') === state.style,
          children: state.root.children.length, documentStyles: document.querySelectorAll('style').length, opacity: getComputedStyle(state.input).opacity };
      })).toEqual({ unchangedValue: true, unchangedStyle: true, children: 1, documentStyles: 0, opacity: '1' });
    }
    await f.browser.evaluate(() => {
      const state = Reflect.get(globalThis, '__closedMaskContract') as { input: HTMLInputElement; style: string | null };
      state.input.style.removeProperty('opacity'); state.style = state.input.getAttribute('style'); return null;
    });
    const snapshot = await f.engine.observe!(f.operation(), { pixels: true });
    expect(snapshot.maskedRegionCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.pixels).toBeDefined();
    expect(JSON.stringify(snapshot.root)).not.toContain('synthetic-closed-mask-secret');
    const relative = await f.engine.artifacts!.screenshot('safe-after-refusal', f.operation());
    for (const bytes of [snapshot.pixels!.data, new Uint8Array(readFileSync(path.join(f.artifactsDir, relative)))]) {
      const pixels = decodePng(bytes);
      expect({ width: pixels.width, height: pixels.height }).toEqual({ width: 480, height: 320 });
      expect(pixels.pixelAt(60, 40)).toEqual([0, 0, 0, 255]);
      expect(pixels.pixelAt(210, 40)).toEqual([0, 128, 0, 255]);
      expect(pixels.pixelAt(400, 200)).toEqual([0, 0, 255, 255]);
    }
    expect(await f.browser.evaluate(() => {
      const state = Reflect.get(globalThis, '__closedMaskContract') as { root: ShadowRoot; input: HTMLInputElement; style: string };
      return state.root.children.length === 1 && document.querySelectorAll('style').length === 0 && state.input.value === 'synthetic-closed-mask-secret'
        && state.input.getAttribute('style') === state.style && getComputedStyle(state.input).opacity === '1';
    })).toBe(true);
  } finally { await f.close(); }
});
