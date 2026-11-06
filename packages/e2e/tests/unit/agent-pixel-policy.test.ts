/**
 * The agent's pixel policy: `always` keeps a step in pixel mode after its
 * first screenshot, `on-request` carries pixels only on the results that ask
 * for them, and `off` never sends any.
 */

import { describe, expect, it } from 'vitest';
import type { ExecutorObservation, StepExecutorContext } from '../../src/agent/executor.ts';
import { createGrammarTools } from '../../src/agent/primitives.ts';
import { ScreenPresenter } from '../../src/agent/screen-update.ts';
import type { PixelPolicy } from '../../src/types.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';

const LINES = ['#n1 document "Home"', ' #n2 button "Increment"', ' #n3 status "Counter" text="0"'];

function shot(byte: number) {
  return {
    data: new Uint8Array([byte]),
    mediaType: 'image/png' as const,
    width: 768,
    height: 480,
    scale: 1,
    maskedRegionCount: 0,
  };
}

function screen(revision: string, pixels?: ReturnType<typeof shot>): ExecutorObservation {
  return {
    revision,
    text: LINES.join('\n'),
    truncated: false,
    viewport: { width: 1280, height: 720 },
    ...(pixels === undefined ? {} : { pixels }),
  };
}

/** True for a rendered screen that carries its screenshot. */
function hasImage(output: unknown): boolean {
  return typeof output === 'object' && output !== null && 'pixels' in output;
}

const toolOptions = { toolCallId: 'call', messages: [], context: undefined } as never;

/** A step whose observations record whether pixels were asked for, and answer with one only when asked. */
function toolContext(policy: PixelPolicy) {
  const presenter = new ScreenPresenter({ policy });
  const requests: boolean[] = [];
  let revision = 0;
  const base = fakeExecutorContext().context;
  const context: StepExecutorContext = {
    ...base,
    observe: async (options) => {
      const wantsPixels = options?.pixels === true;
      requests.push(wantsPixels);
      revision += 1;
      return screen(`r${String(revision)}`, wantsPixels ? shot(revision) : undefined);
    },
    actions: {
      ...base.actions,
      tap: async () => undefined,
      tapAt: async () => ({ point: { x: 10, y: 20 }, summary: 'Tapped the point (10, 20).' }),
    },
  };
  return { context, presenter, requests, tools: createGrammarTools(context, { screen: presenter }) };
}

async function call(tools: ReturnType<typeof toolContext>['tools'], name: string, input: Record<string, unknown> = {}) {
  return tools[name]!.execute!(input, toolOptions);
}

describe('the always policy (the default)', () => {
  it('attaches a screenshot to every result once the model has seen one', async () => {
    const { tools, requests } = toolContext('always');
    expect(hasImage(await call(tools, 'screenshot'))).toBe(true);
    expect(hasImage(await call(tools, 'tap', { target: 'n1' }))).toBe(true);
    expect(hasImage(await call(tools, 'observe'))).toBe(true);
    expect(requests).toEqual([true, true, true]);
    expect(tools['screenshot']!.description).toContain('From then on every action result carries a fresh screenshot too');
  });
});

describe('the on-request policy', () => {
  it('carries pixels only on the screenshot and point results, not on ordinary actions after them', async () => {
    const { tools, requests } = toolContext('on-request');
    expect(hasImage(await call(tools, 'screenshot'))).toBe(true);
    expect(hasImage(await call(tools, 'tap', { target: 'n1' }))).toBe(false);
    // A point is read off an image, so it is an explicit pixel request and
    // its own result refreshes the image the next point is read from.
    expect(hasImage(await call(tools, 'tap_at', { x: 10, y: 20 }))).toBe(true);
    expect(hasImage(await call(tools, 'tap', { target: 'n1' }))).toBe(false);
    expect(requests).toEqual([true, false, true, false]);
  });

  it('says that results carry no screenshot, while the always policy does not', () => {
    const lean = toolContext('on-request');
    expect(lean.tools['screenshot']!.description).toContain('ask again when you need current pixels');
    expect(lean.tools['screenshot']!.description).not.toContain('every action result carries');
    expect(lean.tools['tap_at']!.description).toContain("This agent's action results carry no screenshot");
    expect(lean.tools['type_at']!.description).toContain("This agent's action results carry no screenshot");
  });

  it('keeps an ordinary result text-only even after an explicit screenshot, until a point action asks', async () => {
    const { presenter } = toolContext('on-request');
    expect(hasImage(presenter.open(screen('o1', shot(1))))).toBe(true);
    expect(presenter.showingPixels).toBe(false);
    expect(hasImage(presenter.present(screen('o2')))).toBe(false);
  });
});

describe('the off policy', () => {
  it('offers no pixel tool, and never renders pixels even when an observation carries them', () => {
    const { tools, presenter, requests } = toolContext('off');
    for (const name of ['screenshot', 'tap_at', 'hover_at', 'type_at', 'press_at', 'select_at']) {
      expect(tools[name], name).toBeUndefined();
    }
    expect(tools['tap']).toBeDefined();
    expect(hasImage(presenter.open(screen('x1', shot(1))))).toBe(false);
    expect(hasImage(presenter.present(screen('x2', shot(2))))).toBe(false);
    // A result that changed no listed node must not send the model looking
    // for a screenshot tool this policy does not offer.
    const unchanged = presenter.present(screen('x3', shot(3)), { lead: 'Tapped #n1.', expectChange: true });
    const text = typeof unchanged === 'string' ? unchanged : unchanged.text;
    expect(text).toContain('No screenshot can be taken in this step');
    expect(text).not.toContain('needs a screenshot to see');
    expect(presenter.showingPixels).toBe(false);
    expect(requests).toEqual([]);
  });
});
