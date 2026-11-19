import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NodeRef, SemanticNode } from 'e2e/engine';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startNativeFixture, type NativeFixture } from '../helpers/native-fixture.ts';

const owners = {
  'visible-cross-site': '<iframe src="CHILD" style="width:320px;height:120px;border:0"></iframe>',
  'zero-same-origin': '<iframe src="/child" style="width:0;height:0;border:0"></iframe>',
  'zero-cross-site': '<iframe src="CHILD" style="width:0;height:0;border:0"></iframe>',
  'hidden-cross-site': '<div hidden><iframe src="CHILD"></iframe></div>',
  'covering-cross-site': '<iframe src="CHILD" style="position:absolute;top:0;left:0;width:320px;height:120px;border:0"></iframe>',
} as const;

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/child') {
      response.end('<!doctype html><button onclick="this.textContent=\'Child clicked\'">Child target</button>');
      return;
    }
    const kind = request.url?.slice(1) as keyof typeof owners;
    const owner = owners[kind]?.replace('CHILD', `http://localhost:${port}/child`);
    if (owner === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.end(`<!doctype html><button onclick="this.textContent='Main clicked'">Main target</button>${owner}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
}));

/** Resolve the exact semantic reference used by agent actions. */
function buttonRef(node: SemanticNode, name: string): NodeRef | undefined {
  if (node.role === 'button' && node.name === name) return node.ref;
  for (const child of node.children ?? []) {
    const ref = buttonRef(child, name);
    if (ref !== undefined) return ref;
  }
}

/** Open the test document and let its embedded renderer finish loading. */
async function load(fixture: NativeFixture, kind: keyof typeof owners): Promise<void> {
  await fixture.browser.goto(`http://127.0.0.1:${port}/${kind}`);
  await fixture.browser.evaluate(() => {
    if (document.readyState === 'complete') return true;
    return new Promise<boolean>(resolve => window.addEventListener('load', () => resolve(true), { once: true }));
  });
}

it.each(['zero-same-origin', 'zero-cross-site', 'hidden-cross-site'] as const)(
  'taps the main document when an iframe has no rendered area (%s)',
  async kind => {
    const fixture = await startNativeFixture(kind);
    try {
      await load(fixture, kind);
      const operation = { ...fixture.operation(), origin: 'agent' } as const;
      const snapshot = await fixture.engine.observe!(operation);
      const ref = buttonRef(snapshot.root, 'Main target');
      expect(ref).toBeDefined();
      await fixture.engine.perform!(ref!, { kind: 'tap' }, operation);
      await expect(fixture.browser.evaluate(() => document.querySelector('button')?.textContent ?? null)).resolves.toBe('Main clicked');
    } finally {
      await fixture.close();
    }
  },
);

it('preserves hit testing across a visible cross-site iframe', async () => {
  const fixture = await startNativeFixture('visible-frame');
  try {
    await load(fixture, 'visible-cross-site');
    const child = fixture.browser.frameLocator('iframe').getByRole('button', { name: 'Child target' });
    await child.click();
    await expect(fixture.browser.frameLocator('iframe').getByRole('button', { name: 'Child clicked' }).count()).resolves.toBe(1);
    await load(fixture, 'covering-cross-site');
    const operation = { ...fixture.operation(), origin: 'agent' } as const;
    const snapshot = await fixture.engine.observe!(operation);
    const ref = buttonRef(snapshot.root, 'Main target');
    expect(ref).toBeDefined();
    await expect(fixture.engine.perform!(ref!, { kind: 'tap' }, operation)).rejects.toThrow();
    await expect(fixture.browser.evaluate(() => document.querySelector('button')?.textContent ?? null)).resolves.toBe('Main target');
  } finally {
    await fixture.close();
  }
});
