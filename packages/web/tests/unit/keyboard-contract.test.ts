import { describe, expect, it } from 'vitest';
import { controllerKey } from '../../src/native/keyboard-contract.ts';

describe('public controller keyboard aliases', () => {
  it('normalizes an exact alias using the runner platform, preserving literal plus and chord order', () => {
    expect(controllerKey('ControlOrMeta+A', 'darwin')).toBe('Meta+A');
    expect(controllerKey('Shift+ControlOrMeta++', 'linux')).toBe('Shift+Control++');
    expect(controllerKey('ControlOrMeta', 'win32')).toBe('Control');
    expect(controllerKey('ControlOrMetaText', 'darwin')).toBe('ControlOrMetaText');
  });
});
