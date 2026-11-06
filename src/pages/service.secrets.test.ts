import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { ProjectStore } from '../projects/store.js';
import { makeService } from '../testing/helpers.js';
import { PageService } from './service.js';
import { PageStore } from './store.js';
import { PageError } from './types.js';

function setup() {
  const now = () => new Date('2026-11-03T10:00:00Z');
  const { db, store, service } = makeService({ now });
  return new PageService(new PageStore(db, now), createFakeEmbedder(), service, new ProjectStore(db, now), store, now);
}

test('a refused page says on which line the secret looks to be, without repeating it', async () => {
  const pages = setup();
  const body = 'How the brain signs in.\n\n## Stack\nThe device token: Bearer <token>\nThe TOTP secret: base32, stored in the owner table.\n';
  await assert.rejects(pages.create({ title: 'Auth', area: 'tools', body }, 'owner'), (e: unknown) => {
    assert.ok(e instanceof PageError && e.code === 'secret');
    assert.equal(e.message, 'The page looks like it contains a secret (credential assignment) on line 5, at “secret: ba…”. Secrets are never stored.');
    return true;
  });
});
