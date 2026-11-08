import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import type { Memory } from '../memory/types.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;
const grok = { type: 'ai', name: 'Grok' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const save = async (content: string, actor: typeof ai | typeof grok = ai) =>
    ((await app.deps.service.remember({ kind: 'decision', content, project: 'homelab', allowDuplicate: true, newProject: true }, actor)) as { memory: Memory }).memory;
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100', grok);
  const d = app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai).disagreement;
  return { app, f, a, b, d };
}
const post = (f: Awaited<ReturnType<typeof loggedIn>>, path: string, body: Record<string, string> = {}) =>
  f(path, { method: 'POST', body: new URLSearchParams(body) });

test('the project page shows the two facts side by side, who saved each, the reason, and three ways to settle', async (t) => {
  const { f, d } = await start(t);
  const panel = await (await f('/?project=homelab')).text();
  assert.match(panel, /<h3 id="p-disagree">These facts disagree/);
  assert.match(panel, /Two different ports/);
  assert.match(panel, /port 3000[\s\S]*Claude Code[\s\S]*port 3100[\s\S]*Grok/);
  for (const how of ['a', 'b', 'both']) assert.ok(panel.includes(`name="how" value="${how}"`), how);
  assert.ok(panel.includes(`action="/disagreements/${d.id}/settle"`));
  assert.ok(panel.includes('name="back" value="/?project=homelab#panel"'));
  assert.match(panel, />This one is right</);
  assert.match(panel, />Both are right</);
  assert.match(panel, /href="#p-disagree">Disagree 1</);
});

test('settling from the page replaces the wrong fact and the group goes away', async (t) => {
  const { app, f, a, b, d } = await start(t);
  const r = await post(f, `/disagreements/${d.id}/settle`, { how: 'b', back: '/?project=homelab#panel' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/?project=homelab#panel');
  assert.equal(app.deps.service.replacement(a.id)?.endId, b.id);
  assert.doesNotMatch(await (await f('/?project=homelab')).text(), /These facts disagree/);
  const again = await post(f, `/disagreements/${d.id}/settle`, { how: 'a' });
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already settled/);
});

test('a bad choice answers 400; settling needs the owner; back goes only to the list or a project', async (t) => {
  const { app, f, d } = await start(t);
  const elsewhere = await post(f, `/disagreements/${d.id}/settle`, { how: 'both', back: 'https://evil.example/' });
  assert.equal(elsewhere.headers.get('location'), '/disagreements');
  const w = await start(t);
  assert.equal((await post(w.f, `/disagreements/${w.d.id}/settle`, { how: 'neither' })).status, 400);
  const anon = await fetch(`${w.app.baseUrl}/disagreements/${w.d.id}/settle`, { method: 'POST', redirect: 'manual', headers: { Origin: w.app.baseUrl }, body: new URLSearchParams({ how: 'a' }) });
  assert.equal(anon.status, 302);
  assert.equal(w.app.deps.service.openDisagreements().length, 1);
  assert.equal(app.deps.service.openDisagreements().length, 0);
});

test('For you says how many facts disagree and links to the list of every open pair', async (t) => {
  const { app, f } = await start(t);
  const home = await (await f('/')).text();
  assert.match(home, /<a class="row" href="\/disagreements"><span class="dot" aria-hidden="true"><\/span><span class="txt">2 facts disagree<\/span>/);
  for (const d of app.deps.service.openDisagreements()) app.deps.service.settleDisagreement(d.id, 'both', { type: 'owner' });
  assert.doesNotMatch(await (await f('/')).text(), /facts disagree/);
});

test('the list of every open pair groups them by project, profile facts under "About you", and settling there comes back to it', async (t) => {
  const { app, f } = await start(t);
  const save = async (content: string) => ((await app.deps.service.remember({ kind: 'profile', content }, { type: 'owner' })) as { memory: Memory }).memory;
  const p1 = await save('Prefers short answers');
  const p2 = await save('Prefers long detailed answers');
  const pd = app.deps.service.flagDisagreement(p1.id, p2.id, 'Short or long', ai).disagreement;
  const list = await (await f('/disagreements')).text();
  assert.match(list, /<h2>homelab<\/h2>[\s\S]*Two different ports/);
  assert.match(list, /<h2>About you<\/h2>[\s\S]*Short or long/);
  const r = await post(f, `/disagreements/${pd.id}/settle`, { how: 'a' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/disagreements');
  assert.ok(app.deps.service.get(p2.id)?.deletedAt);
  assert.match(await (await f('/disagreements')).text(), /Two different ports/);
});

test('with nothing to settle the list says so', async (t) => {
  const { app, f } = await start(t);
  for (const d of app.deps.service.openDisagreements()) app.deps.service.settleDisagreement(d.id, 'both', { type: 'owner' });
  assert.match(await (await f('/disagreements')).text(), /Nothing to settle/);
});
