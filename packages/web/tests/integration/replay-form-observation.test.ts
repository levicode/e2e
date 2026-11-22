import { afterEach, expect, it } from 'vitest';
import { nativeDocument } from '../helpers/native-browser.ts';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

let fixture: NativeFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

it.each(['light', 'open', 'closed'] as const)('samples a form on a document with %s DOM', async mode => {
  fixture = await startNativeFixture('form-sample-' + mode);
  await nativeDocument(fixture.browser, `<form>
    <label><input type="radio" name="size">Small</label>
    <input type="text" aria-label="Notes" value="draft">
    <button type="button">Submit</button>
  </form><div id="host"></div>`);
  if (mode !== 'light') {
    await fixture.browser.evaluate(shadowMode => {
      document.querySelector('#host')!.attachShadow({ mode: shadowMode });
      return null;
    }, mode);
  }
  await fixture.session.observe(fixture.operation());
  const sample = await fixture.session.observe(fixture.operation(), { sampleReplayForm: true });
  const controls = Object.values(sample.replayControls ?? {});
  expect(controls.map(control => control.kind).toSorted()).toEqual(['button', 'field', 'radio']);
  expect(controls.map(control => control.stable)).toEqual(Array(3).fill(mode === 'light'));
});
