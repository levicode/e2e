import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CALLBACK_SCREENSHOT_ENV, candidateScreenshotEnvironment } from './candidate-web.ts';
test('one exact synthetic suite gets the fixed image path; all others scrub inherited paths', t => {
  const directory = mkdtempSync(join(tmpdir(), 'callback-image-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inherited = { [CALLBACK_SCREENSHOT_ENV]: '/untrusted', KEEP: 'yes' };
  assert.deepEqual(candidateScreenshotEnvironment('public-callbacks', true, inherited, directory), { KEEP: 'yes', [CALLBACK_SCREENSHOT_ENV]: join(directory, 'public-callbacks-C03-failure.png') });
  for (const [suite, enabled] of [['web-browser', true], ['semantic-faults', true], ['public-callbacks', false]] as const) assert.deepEqual(candidateScreenshotEnvironment(suite, enabled, inherited, directory), { KEEP: 'yes' });
  assert.equal(inherited[CALLBACK_SCREENSHOT_ENV], '/untrusted');
  const link = join(directory, 'link'); symlinkSync(directory, link); assert.throws(() => candidateScreenshotEnvironment('public-callbacks', true, inherited, link));
});
