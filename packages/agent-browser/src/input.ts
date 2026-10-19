/** Stateful low-level input over the public Chromium CDP Input domain. */
import { EngineError, KEY_MODIFIERS, parseKey, TestError, type OperationContext } from 'e2e/engine';
import type { CdpConnection } from './cdp.ts';
import { beforeDispatch } from './budget.ts';
import { assertTextFocus } from './input-focus.ts';

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';
export interface InputControllerOptions {
  readonly cdp: () => CdpConnection;
  readonly session: () => string;
  readonly assertUsable: () => void;
  readonly guardOperation?: (context: OperationContext) => void;
  readonly markUncertain: () => never;
  readonly frameSession?: (frameId: string, context: OperationContext) => Promise<string>;
}

interface KeyDescription {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text: string;
  readonly location: number;
  readonly modifier: number;
}

const BUTTONS: Readonly<Record<MouseButton, number>> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
const MODIFIERS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const NAMED: Readonly<Record<string, readonly [string, number, string?]>> = {
  Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  Delete: ['Delete', 46], Insert: ['Insert', 45], Space: ['Space', 32, ' '],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91],
};
const PUNCTUATION: readonly (readonly [string, string, string, number])[] = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
];

function normalizeKey(key: string): string {
  const parsed = typeof key === 'string' ? parseKey(key) : undefined;
  if (!KEY_MODIFIERS.some((modifier) => modifier === key) && (parsed === undefined || parsed.modifiers.length !== 0)) {
    throw new TestError('INVALID_ARGUMENT', 'Keyboard down and up require one printable key, named key, or modifier');
  }
  return key === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : key;
}

/** The key names are public harness grammar; printable punctuation uses a US physical-key mapping. */
function describeKey(key: string, shift: boolean): KeyDescription {
  const named = NAMED[key];
  const modifier = MODIFIERS[key] ?? 0;
  if (named) return { key: key === 'Space' ? ' ' : key, code: named[0], keyCode: named[1], text: named[2] ?? '', location: modifier ? 1 : 0, modifier };
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return { key, code: key, keyCode: 111 + Number(key.slice(1)), text: '', location: 0, modifier: 0 };
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    const value = shift ? upper : key;
    return { key: value, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: value, location: 0, modifier: 0 };
  }
  const digits = '0123456789';
  const shiftedDigits = ')!@#$%^&*(';
  const digit = digits.includes(key) ? digits.indexOf(key) : shiftedDigits.indexOf(key);
  if (digit >= 0) {
    const value = shift && digits.includes(key) ? shiftedDigits[digit]! : key;
    return { key: value, code: `Digit${digit}`, keyCode: 48 + digit, text: value, location: 0, modifier: 0 };
  }
  const punctuation = PUNCTUATION.find(([plain, shifted]) => key === plain || key === shifted);
  if (punctuation) {
    const value = shift ? punctuation[1] : key;
    return { key: value, code: punctuation[2], keyCode: punctuation[3], text: value, location: 0, modifier: 0 };
  }
  if (key === ' ') return { key, code: 'Space', keyCode: 32, text: key, location: 0, modifier: 0 };
  // Non-US printable keys have a value but no invented physical key code.
  return { key, code: '', keyCode: 0, text: key, location: 0, modifier: 0 };
}

function finite(...values: number[]): void {
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TestError('INVALID_ARGUMENT', 'Pointer coordinates and wheel deltas must be finite numbers');
  }
}

function buttonMask(button: MouseButton): number {
  if (!Object.hasOwn(BUTTONS, button)) throw new TestError('INVALID_ARGUMENT', 'Unknown mouse button');
  return BUTTONS[button];
}

function checkClickCount(clickCount: number): void {
  if (!Number.isSafeInteger(clickCount) || clickCount < 1) throw new TestError('INVALID_ARGUMENT', 'Click count must be a positive integer');
}

/** One controller belongs to the owned browser, shared by fixture and pointer actions. */
export class InputController {
  private readonly options: InputControllerOptions;
  private x = 0;
  private y = 0;
  private modifierMask = 0;
  private readonly heldButtons = new Set<MouseButton>();
  private readonly pressedKeys = new Set<string>();
  private busy = false;

  constructor(options: InputControllerOptions) { this.options = options; }

  get modifiers(): number { return this.modifierMask; }
  get isBusy(): boolean { return this.busy; }
  get buttons(): number { return [...this.heldButtons].reduce((mask, button) => mask | BUTTONS[button], 0); }
  get position(): { readonly x: number; readonly y: number } { return { x: this.x, y: this.y }; }
  isKeyDown(key: string): boolean { return this.pressedKeys.has(this.keyIdentity(normalizeKey(key))); }

  /** Adopt the patched public CLI's acknowledged pointer state after a native pointer command. */
  adoptPointer(value: unknown): void {
    this.options.assertUsable();
    if (this.busy || this.buttons !== 0) throw new EngineError('INVALID_STATE', 'Cannot merge native pointer state with pending or held companion input', { retryable: false });
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 3 || !('x' in value) || !('y' in value) || !('buttons' in value)
      || typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)
      || typeof value.buttons !== 'number' || !Number.isSafeInteger(value.buttons) || value.buttons < 0 || value.buttons > 31
      || (value.buttons !== 0 && (value.buttons & (value.buttons - 1)) !== 0)) {
      throw new EngineError('ENGINE_FAILURE', 'Native pointer state is malformed or ambiguous', { retryable: false });
    }
    this.x = value.x; this.y = value.y;
    this.heldButtons.clear();
    for (const button of Object.keys(BUTTONS) as MouseButton[]) if ((value.buttons & BUTTONS[button]) !== 0) this.heldButtons.add(button);
  }

  /** Read-only focus preflight before agent-browser performs the actual text input. */
  async assertTextFocus(context: OperationContext): Promise<void> {
    this.options.assertUsable();
    this.options.guardOperation?.(context);
    if (this.busy) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Cannot inspect focus while low-level input is pending', { retryable: false });
    await assertTextFocus(this.options, context);
  }

  /** Only reset after destroying the old browser; this does not release input in a live target. */
  reset(): void {
    if (this.busy) throw new EngineError('INVALID_STATE', 'Cannot reset input while a command is pending', { retryable: false });
    this.x = 0; this.y = 0; this.modifierMask = 0;
    this.heldButtons.clear(); this.pressedKeys.clear();
  }

  async mouseMove(x: number, y: number, context: OperationContext): Promise<void> {
    finite(x, y);
    await this.dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: [...this.heldButtons].at(-1) ?? 'none', buttons: this.buttons, modifiers: this.modifiers }, context, () => { this.x = x; this.y = y; });
  }

  async mouseDown(button: MouseButton, context: OperationContext, clickCount = 1): Promise<void> {
    const mask = buttonMask(button); checkClickCount(clickCount);
    if (this.heldButtons.has(button)) throw new EngineError('INVALID_STATE', 'The mouse button is already held', { retryable: false });
    await this.dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.x, y: this.y, button, buttons: this.buttons | mask, modifiers: this.modifiers, clickCount }, context, () => { this.heldButtons.add(button); });
  }

  async mouseUp(button: MouseButton, context: OperationContext, clickCount = 1): Promise<void> {
    const mask = buttonMask(button); checkClickCount(clickCount);
    await this.dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.x, y: this.y, button, buttons: this.buttons & ~mask, modifiers: this.modifiers, clickCount }, context, () => { this.heldButtons.delete(button); });
  }

  async mouseWheel(deltaX: number, deltaY: number, context: OperationContext): Promise<void> {
    finite(deltaX, deltaY);
    await this.dispatch('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.x, y: this.y, deltaX, deltaY, buttons: this.buttons, modifiers: this.modifiers }, context);
  }

  async keyDown(key: string, context: OperationContext): Promise<void> {
    const normalized = normalizeKey(key);
    const description = describeKey(normalized, (this.modifiers & 8) !== 0);
    const modifiers = this.modifiers | description.modifier;
    const text = (modifiers & ~8) === 0 ? description.text : '';
    const identity = this.keyIdentity(normalized);
    await this.dispatch('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown', key: description.key, code: description.code,
      windowsVirtualKeyCode: description.keyCode, location: description.location,
      text, unmodifiedText: description.text, modifiers, autoRepeat: this.pressedKeys.has(identity),
    }, context, () => { this.modifierMask = modifiers; this.pressedKeys.add(identity); });
  }

  async keyUp(key: string, context: OperationContext): Promise<void> {
    const normalized = normalizeKey(key);
    const description = describeKey(normalized, (this.modifiers & 8) !== 0);
    const modifiers = this.modifiers & ~description.modifier;
    await this.dispatch('Input.dispatchKeyEvent', {
      type: 'keyUp', key: description.key, code: description.code,
      windowsVirtualKeyCode: description.keyCode, location: description.location, modifiers,
    }, context, () => { this.modifierMask = modifiers; this.pressedKeys.delete(this.keyIdentity(normalized)); });
  }

  private keyIdentity(key: string): string { const description = describeKey(key, false); return description.code || description.key; }

  private async dispatch(method: string, params: Record<string, unknown>, context: OperationContext, commit?: () => void): Promise<void> {
    this.options.assertUsable();
    this.options.guardOperation?.(context);
    beforeDispatch(context);
    if (this.busy) throw new EngineError('UNSUPPORTED_CAPABILITY', 'Concurrent low-level input commands are not supported', { retryable: false });
    const connection = this.options.cdp();
    const session = this.options.session();
    this.busy = true;
    try { await connection.send(method, params, context, session); this.options.guardOperation?.(context); commit?.(); }
    catch { this.options.guardOperation?.(context); this.options.markUncertain(); }
    finally { this.busy = false; }
  }
}
