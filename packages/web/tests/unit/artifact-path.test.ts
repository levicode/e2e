/**
 * Artifact paths built from names the engine does not choose: a caller's
 * screenshot label, or the filename a server suggests for a download. Every
 * name lands as one plain file inside the attempt's folder for that kind.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../../src/runtime-support.ts';
import { HOSTILE_NAMES } from '../helpers/artifact-names.ts';



describe('sanitizeFilename', () => {
  it('keeps no separator, drive colon, or control character, bounds the length, and names an empty label', () => {
    for (const name of HOSTILE_NAMES) {
      const safe = sanitizeFilename(name);
      expect(safe, name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    }
    expect(sanitizeFilename('')).toBe('artifact');
  });
});

