/**
 * Action dispatch and classification: every LocatorAction kind the agent and
 * the screen tier send lands on the right Playwright call, and every
 * Playwright failure lands on the right contract code (the table in
 * support.ts).
 */

import type { Locator as PwLocator, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { EngineError, type LocatorAction } from 'e2e/engine';
import { classifyActionError, dispatchLocatorAction, dispatchPointerAction } from '../../src/actions.ts';
import { EngineChannel } from '../../src/native/engine-channel.ts';
import { NativeProtocolPeer } from '../helpers/native-protocol-peer.ts';

type ActionTarget = Parameters<typeof dispatchLocatorAction>[0];

// The native producer owns string-to-label selection. Run 39940386738 executes
// select_modes_are_unambiguous_and_string_means_label and the hosted exact-action
// contract. This peer proves the original action and 7ms budget cross the adapter once.
// C03's exact dev tests at native 31df55cf prove the 900ms CDP hold, empty
// PREPARE_FILL/Delete fallback and positive index 2. The latter scripts execute
// in a Node scripted DOM. These peers preserve actions/budgets, not renderer proof.
describe('native locator action forwarding', () => {
  it.each([
    [{ kind: 'selectOption', value: 'Blue' }, 'selectOption', [{ label: 'Blue' }, { timeout: 7 }]],
    [{ kind: 'longPress', durationMs: 900 }, 'click', [{ timeout: 7, delay: 900 }]],
    [{ kind: 'clear' }, 'fill', ['', { timeout: 7 }]],
    [{ kind: 'selectOption', value: { index: 2 } }, 'selectOption', [{ index: 2 }, { timeout: 7 }]],
  ] as const satisfies readonly (readonly [LocatorAction, string, readonly unknown[]])[])(
    'dispatches %j to locator.%s',
    async (action) => {
      vi.useFakeTimers();
      const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
      const peer = new NativeProtocolPeer([], () => ({ data: null }));
      const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
      try {
        const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
        const original = structuredClone(args);
        await new EngineChannel(client).command('browser.perform', args, operation);
        expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
        expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
      } finally {
        try { await client.close({ ...operation, timeoutMs: 1000 }); }
        finally { vi.useRealTimers(); }
      }
    },
  );

  // Immutable native drag tests resolve the source and exact destination through
  // browser.perform. This peer checks only the original target ref and budget.
  it('uses Playwright drag when both sides are locators', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const action: LocatorAction = { kind: 'dragTo', target: { id: 'n2', revision: 'r' } };
    const peer = new NativeProtocolPeer([], () => ({ data: null }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action };
      const original = structuredClone(args);
      await new EngineChannel(client).command('browser.perform', args, operation);
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });
});

// Run 39940386738 executes the no-box native refusal and its public lifecycle
// counterpart. This peer checks only error mapping, one dispatch and the 7ms wire budget.
describe('native locator action refusals', () => {
  // Formal 0e3f's stale_does_not_erase_unknown_effects_after_dispatch checks the
  // shared failure rule. live_drag_destination_revalidates_after_press_without_replay
  // additionally witnesses real press -> stale/Unknown; it is not a tap replay test.
  it.each([
    ['strict mode violation: 2 elements\nCall log:\n  - move and down action done', 'ACTION_MAY_HAVE_COMMITTED', false],
  ] as const)('maps "%s" to %s', async (_text, code, retryable) => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'stale-reference', effects: 'unknown', scopeState: 'quarantined' }));
    const dispose = vi.spyOn(peer, 'dispose');
    const client = await peer.connect(operation, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code, retryable });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(dispose).toHaveBeenCalledOnce();
      const retired = peer.frames.length;
      await expect(client.request('page.title', {}, operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
      expect(peer.frames).toHaveLength(retired);
    } finally {
      await expect(client.close(operation)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    }
  });

  // The labels preserve the old classification rows. Run 39940386738's native
  // live-query tap test executes ambiguous and missing targets, and witnesses
  // stale-reference/not-dispatched with no input or scroll. No legacy text is
  // parsed by this peer; it proves the closed error's adapter mapping.
  it.each([
    ['strict mode violation: 2 elements', 'NODE_STALE', true],
    ['element is detached from the DOM', 'NODE_STALE', true],
  ] as const)('maps "%s" to %s', async (_text, code, retryable) => {
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'stale-reference' }));
    const client = await peer.connect(operation, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'tap' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code, retryable });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(1000);
    } finally { await client.close(operation); }
  });

  it('reports a node without a box as NOT_ACTIONABLE on swipe', async () => {
    vi.useFakeTimers();
    const operation = { signal: new AbortController().signal, timeoutMs: 7, runId: 'run', attemptId: 'attempt', origin: 'test' as const };
    const peer = new NativeProtocolPeer([], () => ({ error: 'not-actionable' }));
    const client = await peer.connect({ ...operation, timeoutMs: 1000 }, () => undefined);
    try {
      const args = { identityScope: 'scope', ref: { id: '@e1', revision: '1' }, action: { kind: 'swipe', direction: 'up' } as const };
      const original = structuredClone(args);
      await expect(new EngineChannel(client).command('browser.perform', args, operation)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
      expect(peer.requests.map(request => [request.command, request.args])).toEqual([['browser.perform', original]]);
      expect(peer.frames.find(frame => frame['type'] === 'request')?.['timeoutMs']).toBe(7);
    } finally {
      try { await client.close({ ...operation, timeoutMs: 1000 }); }
      finally { vi.useRealTimers(); }
    }
  });
});

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error('aborted'));
        return;
      }
      const timer = globalThis.setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener(
        'abort',
        () => {
          globalThis.clearTimeout(timer);
          reject(options?.signal?.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    }),
}));

function pwTimeout(callLog: readonly string[]): Error {
  const error = new Error(`locator.click: Timeout 5000ms exceeded.\nCall log:\n${callLog.map((line) => `  - ${line}`).join('\n')}\n`);
  error.name = 'TimeoutError';
  return error;
}

const PRE_DISPATCH_LOG = [
  "waiting for getByRole('button')",
  'locator resolved to <button>Go</button>',
  'attempting click action',
  'waiting for element to be visible, enabled and stable',
  'element is not stable',
  'retrying click action',
];

const POST_DISPATCH_LOG = [
  ...PRE_DISPATCH_LOG.slice(0, 4),
  'element is visible, enabled and stable',
  'scrolling into view if needed',
  'done scrolling',
  'performing click action',
  'click action done',
  'waiting for scheduled navigations to finish',
];

const TAP: LocatorAction = { kind: 'tap' };

describe('classifyActionError', () => {
  it.each([
    ["strict mode violation: getByText('performing click action') resolved to 2 elements:\n    1) <p>click action done</p>\nCall log:\n  - waiting for getByText('performing click action')", 'NODE_STALE', true],
    ['Element is not an <input>, <textarea> or [contenteditable] element', 'NOT_ACTIONABLE', false],
    ['Target page, context or browser has been closed', 'ENGINE_FAILURE', false],
  ] as const)('maps "%s" to %s', (text, code, retryable) => {
    expect(classifyActionError(new Error(text), TAP)).toMatchObject({ code, retryable });
  });

  it('maps a timeout whose log ends before the dispatch to NOT_ACTIONABLE', () => {
    const error = classifyActionError(pwTimeout(PRE_DISPATCH_LOG), TAP);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(error.message).toContain('tap did not become actionable');
  });

  it('cuts a not-actionable timeout to its headline and the last blocker the log names', () => {
    const covered = [
      ...PRE_DISPATCH_LOG.slice(0, 4),
      'element is visible, enabled and stable',
      '<div class="toast">…</div> intercepts pointer events',
      'retrying click action',
      'waiting 100ms',
      '<div data-popover="true">…</div> intercepts pointer events',
      'retrying click action',
    ];
    expect(classifyActionError(pwTimeout(covered), TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. <div data-popover="true">…</div> intercepts pointer events',
    );
    expect(classifyActionError(pwTimeout(PRE_DISPATCH_LOG), TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. element is not stable',
    );
    const compressed = new Error(
      'locator.click: Timeout 5000ms exceeded.\nCall log:\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not enabled\n    - retrying click action\n',
    );
    expect(classifyActionError(compressed, TAP).message).toBe(
      'tap did not become actionable in time: locator.click: Timeout 5000ms exceeded. element is not enabled',
    );
  });

  it('keeps a not-actionable timeout whole when its log names no blocker', () => {
    for (const log of [["waiting for getByRole('button')"], ["waiting for getByText('element is not visible')"]]) {
      const waiting = pwTimeout(log);
      expect(classifyActionError(waiting, TAP).message).toBe(`tap did not become actionable in time: ${waiting.message}`);
    }
  });

  it('maps a timeout whose log reached the dispatch to ACTION_MAY_HAVE_COMMITTED', () => {
    const error = classifyActionError(pwTimeout(POST_DISPATCH_LOG), TAP);
    expect(error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(error.message).toContain('after its input was dispatched');
  });

  it('treats a log that stopped at "performing" as uncertain: the input may be in flight', () => {
    const inFlight = POST_DISPATCH_LOG.slice(0, POST_DISPATCH_LOG.indexOf('performing click action') + 1);
    expect(classifyActionError(pwTimeout(inFlight), TAP)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('treats an action the operation deadline cut off as uncertain: Playwright never said whether the input landed', () => {
    const cut = new EngineError('OPERATION_TIMEOUT', 'tap timed out', { retryable: false });
    expect(classifyActionError(cut, TAP)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, cause: cut });
  });

  it('keeps a bare timeout without a call log a plain actionability miss', () => {
    const error = new Error('Timeout 5000ms exceeded');
    error.name = 'TimeoutError';
    expect(classifyActionError(error, { kind: 'press', key: 'Enter' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('never echoes a sensitive fill value, in the message or through the cause', () => {
    const secret = 'hunter2-plaintext';
    const raw = new Error(`locator.fill("${secret}"): Element is not an <input>, <textarea> or [contenteditable] element`);
    const error = classifyActionError(raw, { kind: 'fill', value: secret, sensitive: true });
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain('[redacted]');
    expect(error.cause).toBeUndefined();
  });

  it('keeps the raw cause for an ordinary fill', () => {
    const raw = new Error('Element is not an <input>');
    const error = classifyActionError(raw, { kind: 'fill', value: 'gamma', sensitive: false });
    expect(error.cause).toBe(raw);
  });
});

/** A locator stub recording every action call; the swipe path also needs a box, a page, and whether the node is under the pointer's aim. */
function stubLocator(box = { x: 10, y: 20, width: 200, height: 100 }, aim: 'pointer' | 'centre' | 'blocked' = 'blocked') {
  const wheel = vi.fn(async (_x: number, _y: number) => undefined);
  const frame = vi.fn(async () => undefined);
  const move = vi.fn(async (_x: number, _y: number) => undefined);
  const locator = {
    click: vi.fn(async () => undefined),
    dblclick: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
    boundingBox: vi.fn(async () => box),
    evaluate: vi.fn(async () => (aim === 'blocked' ? { aim } : { aim, box })),
    page: () => ({ viewportSize: () => ({ width: 1280, height: 720 }), mouse: { wheel, move }, evaluate: frame }),
  };
  const target: ActionTarget = { kind: 'locator', locator: locator as unknown as PwLocator };
  return { locator, target, wheel, move, frame };
}

describe('dispatchLocatorAction', () => {
  const lookup = () => {
    throw new Error('no second target in these cases');
  };
  const OPERATION = { timeoutMs: 7, signal: new AbortController().signal };

  it('scrolls a node with a wheel gesture sized by its own box: the agent node scroll', async () => {
    const { locator, target, wheel, frame } = stubLocator({ x: 0, y: 0, width: 400, height: 300 });
    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'down' }, OPERATION, lookup);
    expect(locator.hover).toHaveBeenCalledWith({ timeout: 7 });
    expect(wheel).toHaveBeenCalledWith(0, 150);
    expect(frame.mock.invocationCallOrder[0]).toBeGreaterThan(wheel.mock.invocationCallOrder[0]!);

    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'left', momentum: 'fast' }, OPERATION, lookup);
    expect(wheel).toHaveBeenLastCalledWith(-600, 0);
  });

  it('wheels a node hit at its centre there, at the box the hit test read, without hovering it first', async () => {
    const { locator, target, wheel, move } = stubLocator({ x: 0, y: 0, width: 400, height: 300 }, 'centre');
    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'down' }, OPERATION, lookup);
    expect(locator.hover).not.toHaveBeenCalled();
    expect(locator.boundingBox).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith(200, 150);
    expect(move.mock.invocationCallOrder[0]).toBeLessThan(wheel.mock.invocationCallOrder[0]!);
    expect(wheel).toHaveBeenCalledWith(0, 150);
  });

  it('wheels a node the pointer already hovers without moving the pointer', async () => {
    const { locator, target, wheel, move } = stubLocator({ x: 0, y: 0, width: 400, height: 300 }, 'pointer');
    await dispatchLocatorAction(target, { kind: 'swipe', direction: 'down' }, OPERATION, lookup);
    expect(locator.hover).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(wheel).toHaveBeenCalledWith(0, 150);
  });

});

describe('dispatchPointerAction', () => {
  /** A page stub whose mouse records every call in order. */
  function stubPage() {
    const calls: string[] = [];
    const mouse = {
      move: async (x: number, y: number) => {
        calls.push(`move ${x},${y}`);
      },
      down: async () => { calls.push('down'); },
      up: async () => { calls.push('up'); },
      click: async (x: number, y: number, options?: { button?: string; delay?: number }) => {
        calls.push(`click ${x},${y}${options?.button === undefined ? '' : ` ${options.button}`}${options?.delay === undefined ? '' : ` ${options.delay}ms`}`);
      },
      dblclick: async (x: number, y: number) => { calls.push(`dblclick ${x},${y}`); },
      wheel: async (dx: number, dy: number) => { calls.push(`wheel ${dx},${dy}`); },
    };
    const page = { mouse, evaluate: async () => { calls.push('frame'); }, viewportSize: () => ({ width: 800, height: 600 }) } as unknown as Page;
    return { page, calls };
  }

  it('swipes along a path with duration as a multi-step drag paced over time', async () => {
    vi.useFakeTimers();
    try {
      const { page, calls } = stubPage();
      const promise = dispatchPointerAction(page, { x: 10, y: 20 }, { kind: 'swipeTo', target: { x: 70, y: 20 }, durationMs: 48 });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['move 10,20', 'down']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20', 'move 50,20']);
      await vi.advanceTimersByTimeAsync(16);
      expect(calls).toEqual(['move 10,20', 'down', 'move 30,20', 'move 50,20', 'move 70,20', 'up']);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

});
