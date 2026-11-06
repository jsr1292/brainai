import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';

test('a picture is kept privately in the browser for a year (it never changes)', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const img = a.deps.images.add(await fx.jpegWithGps(), { alt: 'x', by: 'owner' });
  const r = await f(`/images/${img.id}.jpg`);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
});

test('logging out clears the browser\'s caches and storage; a login page reached with a dead session clears its cache', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const out = await f('/logout', { method: 'POST' });
  assert.equal(out.headers.get('clear-site-data'), '"cache", "storage"');
  const dead = await fetch(`${a.baseUrl}/login`, { headers: { Cookie: 'mem_session=not-a-session' }, redirect: 'manual' });
  assert.equal(dead.headers.get('clear-site-data'), '"cache"');
  // A login that simply expired: the browser dropped the cookie with it, so a login page without a live session clears too.
  const fresh = await fetch(`${a.baseUrl}/login`, { redirect: 'manual' });
  assert.equal(fresh.headers.get('clear-site-data'), '"cache"');
  const live = await loggedIn(a);
  const again = await live('/login');
  assert.equal(again.headers.get('clear-site-data'), null);
});

test('logging this device out from Settings clears its caches and storage too; logging out another device does not', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  await loggedIn(a);
  a.advance(60_000);
  const f = await loggedIn(a);
  const [newest, older] = a.deps.sessions.list().sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  const elsewhere = await f(`/sessions/${older!.id}/revoke`, { method: 'POST' });
  assert.equal(elsewhere.headers.get('clear-site-data'), null);
  const self = await f(`/sessions/${newest!.id}/revoke`, { method: 'POST' });
  assert.equal(self.headers.get('location'), '/login');
  assert.equal(self.headers.get('clear-site-data'), '"cache", "storage"');
});
