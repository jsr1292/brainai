import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('Settings opens with Brain health: three parts, each with its number and reasons as links', async (t) => {
  const { f } = await start(t);
  const s = await (await f('/settings')).text();
  assert.match(s, /<a href="#health">Backups and copies<\/a>/);
  assert.match(s, /<h2>Backups and copies<\/h2>[\s\S]*<h3 id="brain-health">Brain health<\/h3>/);
  assert.match(s, /Up to date[\s\S]*?100[\s\S]*Ready[\s\S]*?0[\s\S]*Waiting on you[\s\S]*?100/);
  assert.match(s, /<a href="\/facts\?kind=profile">Nothing about you yet: add a fact to your profile<\/a>/);
  assert.match(s, /Nothing to do/);
});

test('For you shows one Brain health row only while a part is under 70, and never on a brain with no memories yet', async (t) => {
  const { app, f } = await start(t);
  assert.doesNotMatch(await (await f('/')).text(), /<b>Brain health<\/b>/);
  await app.deps.service.remember({ kind: 'decision', content: 'homelab runs on the mini PC', project: 'homelab', newProject: true }, owner);
  assert.match(await (await f('/')).text(), /<a class="row" href="\/settings#brain-health"><span class="dot muted" aria-hidden="true"><\/span><span class="txt"><b>Brain health<\/b>: homelab has no status yet<\/span>/);
  await app.deps.service.remember({ kind: 'profile', content: 'Prefers short answers' }, owner);
  await app.deps.service.remember({ kind: 'summary', content: 'homelab status: disks swapped', project: 'homelab' }, owner);
  await app.deps.service.remember({ kind: 'roadmap', content: 'Now: backups (1/3)\nNext: restore test', project: 'homelab' }, owner);
  assert.doesNotMatch(await (await f('/')).text(), /<b>Brain health<\/b>/);
});

test("a personal life area is not a project for brain health: no status is expected of it", async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('cooking', { state: 'open', area: 'personal' }, 'owner');
  await app.deps.service.remember({ kind: 'decision', content: 'cooking: the recipes live in a notebook', project: 'cooking' }, owner);
  const s = await (await f('/settings')).text();
  assert.doesNotMatch(s, /cooking has no/);
});

test('Brain health shows the profile size and near-identical profile entries, and nothing without a profile', async (t) => {
  const { app, f } = await start(t);
  assert.doesNotMatch(await (await f('/settings')).text(), /Your profile:/);
  const a = (await app.deps.service.remember({ kind: 'profile', content: 'Prefers dark mode everywhere' }, owner)) as { memory: { id: string } };
  const b = (await app.deps.service.remember({ kind: 'profile', content: 'Prefers dark mode everywhere', allowDuplicate: true }, owner)) as { memory: { id: string } };
  await app.deps.service.remember({ kind: 'profile', content: 'Lives in Valencia and works from home' }, owner);
  const s = await (await f('/settings')).text();
  assert.match(s, /Your profile: 3 entries, about 15 words\./);
  assert.match(s, /Entries that say nearly the same thing/);
  assert.ok(s.includes(`href="/memories/${a.memory.id}"`) && s.includes(`href="/memories/${b.memory.id}"`));
  assert.doesNotMatch(s, /consider merging/);
});
