/** The Mac skills sync (round 2 §17c): the two device endpoints. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { contentHash } from '../skills/sync.js';

async function world(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const { device, token } = app.deps.devices.create('Mac');
  const send = (path: string, body: unknown, auth = `Bearer ${token}`, extra: Record<string, string> = {}) =>
    fetch(app.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { app, device, token, send };
}
const files = [{ path: 'SKILL.md', text: '---\nname: codex-delegation\ndescription: Use when delegating.\n---\n\nPlan, then delegate.\n' }];
const item = { name: 'codex-delegation', description: 'Use when delegating.', hash: contentHash(files), files: 1, bytes: 80, shareable: null };

test('a report with a device token answers want and actions', async (t) => {
  const { app, send } = await world(t);
  const s = app.deps.skills.create({ name: 'brain-deploy', description: 'Use when deploying.', body: 'Back up.' }, 'owner');
  app.deps.skills.setEnabled(s.id, true, 'owner');
  const r = await send('/api/skills/report', { skills: [item] });
  assert.equal(r.status, 200);
  const j = await r.json() as any;
  assert.deepEqual(j.want, ['codex-delegation']);
  assert.deepEqual(j.actions.map((a: any) => [a.kind, a.name, a.expect]), [['write', 'brain-deploy', null]]);
});

test('no token or a revoked token is 401 and stores nothing', async (t) => {
  const { app, device, send } = await world(t);
  assert.equal((await send('/api/skills/report', { skills: [item] }, '')).status, 401);
  app.deps.devices.revoke(device.id);
  assert.equal((await send('/api/skills/report', { skills: [item] })).status, 401);
  assert.deepEqual(app.deps.skillSync.fromDevice(device.id), []);
});

test('an owner session cookie is not a device token', async (t) => {
  const { app } = await world(t);
  const f = await loggedIn(app);
  const r = await f('/api/skills/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skills: [item] }) });
  assert.equal(r.status, 401);
});

test('upload fills content and never changes a brain skill', async (t) => {
  const { app, device, send } = await world(t);
  await send('/api/skills/report', { skills: [item] });
  assert.equal((await send('/api/skills/upload', { skills: [{ name: item.name, hash: item.hash, files }] })).status, 204);
  assert.equal(app.deps.skillSync.fromDevice(device.id)[0]!.hasContent, true);
  assert.deepEqual(app.deps.skills.list(), []);
  assert.equal((await send('/api/skills/upload', { skills: [{ name: item.name, hash: item.hash, files: [{ path: 'SKILL.md', text: 'tampered' }] }] })).status, 400);
});

test('oversized bodies are 413', async (t) => {
  const { send } = await world(t);
  assert.equal((await send('/api/skills/report', JSON.stringify({ skills: [], pad: 'x'.repeat(300 * 1024) }))).status, 413);
  assert.equal((await send('/api/skills/upload', JSON.stringify({ skills: [], pad: 'x'.repeat(5 * 1024 * 1024) }))).status, 413);
});

test('the 21st report in an hour is 429', async (t) => {
  const { send } = await world(t);
  for (let i = 0; i < 20; i++) assert.equal((await send('/api/skills/report', { skills: [] })).status, 200, `report ${i + 1}`);
  assert.equal((await send('/api/skills/report', { skills: [] })).status, 429);
});
