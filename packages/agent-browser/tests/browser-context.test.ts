import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultContextIdentity } from '../src/browser-context.ts';
const page = (browserContextId?: string) => ({ targetId: 'page', type: 'page', title: '', url: 'about:blank', ...(browserContextId === undefined ? {} : { browserContextId }) });
test('concrete default identity comes from explicit protocol metadata or complete context exclusion', () => {
  assert.equal(defaultContextIdentity({ browserContextIds: ['private'], defaultBrowserContextId: 'default-id' }, [page('private')]), 'default-id');
  assert.equal(defaultContextIdentity({ browserContextIds: ['private'] }, [page('private'), page('default-id')]), 'default-id');
  assert.equal(defaultContextIdentity({ browserContextIds: [] }, [page('default-id'), page('default-id')]), 'default-id');
  assert.equal(defaultContextIdentity({ browserContextIds: [] }, [page()]), undefined);
});
test('ambiguous and contradictory default identities fail closed', () => {
  for (const targets of [[page('a'), page('b')], [page(), page('a')], [page('')]]) {
    assert.throws(() => defaultContextIdentity({ browserContextIds: [] }, targets), { code: 'ENGINE_FAILURE' });
  }
  assert.throws(() => defaultContextIdentity({ browserContextIds: ['private'], defaultBrowserContextId: 'private' }, []), { code: 'ENGINE_FAILURE' });
});
