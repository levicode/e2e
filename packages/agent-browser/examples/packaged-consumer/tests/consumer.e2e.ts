import { expect } from 'e2e';
import { test } from '@e2e-dev/agent-browser';

test('installed package observes and clicks once', async ({ app, agent, screen, browser }) => {
  await app.open('/');
  await agent.act('Click the Commit once button');
  await expect(screen.getByTestId('result')).toHaveText('committed once');
  expect(await browser.evaluate('globalThis.commitCount')).toBe(1);
});
