/** The approved extension boundary is typed fixtures and executor context, not a fake Page. */
import { describe, expect, it } from 'vitest';
import * as publicWeb from '../../src/index.ts';
import { NativeSurface } from '../../src/native-surface.ts';

describe('native public extension boundary', () => {
  it('does not export a counterfeit Playwright surface or a parallel engine factory', () => {
    expect(publicWeb).not.toHaveProperty('surfaceOf');
    expect(publicWeb).not.toHaveProperty('agentBrowser');
    expect(publicWeb.web()).toMatchObject({ name: 'web' });
  });
  it('refuses a typed fixture view before an attempt is running', () => {
    const surface = new NativeSurface({});
    expect(() => surface.fixtureSurface()).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(surface).not.toHaveProperty('requirePage');
    expect(surface).not.toHaveProperty('requireContext');
  });
});
