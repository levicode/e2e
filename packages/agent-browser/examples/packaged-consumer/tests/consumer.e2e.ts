import { expect } from 'e2e';
import { test } from '@e2e-dev/agent-browser';

test('installed package observes and clicks once', async ({ app, agent, screen, browser }) => {
  await app.open('/');
  for (const id of ['text', 'area', 'editable']) {
    await screen.getByTestId(id).fill('browser value Ω');
    expect(await browser.evaluate(field => {
      const node = document.querySelector(`[data-testid="${field}"]`)!;
      return 'value' in node ? String(node.value) : node.textContent;
    }, id)).toBe('browser value Ω');
    expect(await browser.evaluate(field =>
      (globalThis as unknown as { fillEvents: { id: string; trusted: boolean; value: string }[] }).fillEvents
        .some(event => event.id === field && event.trusted && event.value === 'browser value Ω'), id)).toBe(true);
    await screen.getByTestId(id).fill('');
    expect(await browser.evaluate(field => {
      const node = document.querySelector(`[data-testid="${field}"]`)!;
      return 'value' in node ? String(node.value) : node.textContent;
    }, id)).toBe('');
  }
  await agent.act('Click the Commit once button');
  await expect(screen.getByTestId('result')).toHaveText('committed once');
  expect(await browser.evaluate('globalThis.commitCount')).toBe(1);
});
