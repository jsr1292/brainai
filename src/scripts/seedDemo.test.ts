import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../auth/owner.js';
import { totpAt } from '../auth/totp.js';
import { openDb } from '../db.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { MemoryStore } from '../memory/store.js';
import { DEMO_PASSWORD, DEMO_TOTP_SECRET, seedDemo, setDemoLogin } from './seedDemo.js';

test('the demo brain has every project, a week of facts, two pages, a discussion and a working demo login', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const today = Date.parse('2026-11-06T12:00:00Z');
  const r = await seedDemo(dir, createFakeEmbedder(), today);
  assert.ok(r.facts >= 25, `facts: ${r.facts}`);
  assert.equal(r.pages, 2);
  await setDemoLogin(dir);
  const db = openDb(join(dir, 'memory.db'));
  t.after(() => db.close());
  const store = new MemoryStore(db, () => new Date(today));
  assert.equal(store.list({ kind: 'profile' }).length, 4);
  assert.equal(store.list({ kind: 'roadmap' }).length, 5);
  const roadmap = store.list({ project: 'garden-club-site', kind: 'roadmap' })[0]!;
  assert.match(roadmap.content, /^Done: plot booking form \(2026-10-25\); sign-in links by email \(2026-10-31\); members page \(2026-11-04\)/);
  const projects = db.prepare('SELECT name, state FROM projects ORDER BY name').all() as { name: string; state: string }[];
  assert.equal(projects.length, 9);
  assert.deepEqual(projects.filter((p) => p.state !== 'open').map((p) => `${p.name}:${p.state}`), ['photo-archive:parked', 'recipe-box:idea']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM discussions').get() as { n: number }).n, 1);
  const auth = new OwnerAuth(db, () => new Date());
  assert.equal(await auth.verifyPassword(DEMO_PASSWORD), true);
  assert.equal(auth.verifyTotp(totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 30_000))), true);
});

test('the demo refuses a folder that already holds a database', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedDemo(dir, createFakeEmbedder());
  await assert.rejects(seedDemo(dir, createFakeEmbedder()), /refusing: .* is not empty/);
});

test('the demo only writes into a new or empty folder, never one that holds anything else', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  await assert.rejects(seedDemo(dir, createFakeEmbedder()), /refusing: .* is not empty/);
  await seedDemo(join(dir, 'new-demo'), createFakeEmbedder());
});
