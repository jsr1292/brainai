/* The Inbox as one grouped list: approvals, facts that disagree, tidy-ups and discussions, counts, one source for the badge, the item beside it. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import type { Memory } from '../memory/types.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;
const grok = { type: 'ai', name: 'Grok' } as const;
const owner = { type: 'owner' } as const;
const form = (body: Record<string, string> = {}): RequestInit => ({ method: 'POST', body: new URLSearchParams(body) });

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  return { app, f };
}
type Ctx = Awaited<ReturnType<typeof start>>;

/** One of everything: two approvals (a profile suggestion and a skill proposal), a disagreement, a duplicate pair, a waiting discussion. */
async function everything({ app }: Ctx) {
  const s = (await app.deps.service.remember({ kind: 'profile', content: 'Commit messages are imperative' }, grok) as any).suggestion as { id: string };
  app.deps.skills.propose({ name: 'release-notes', description: 'Use when writing release notes.', body: 'Group them.', files: [] }, 'Claude');
  const save = async (content: string, actor: typeof ai | typeof grok = ai, project = 'homelab') =>
    ((await app.deps.service.remember({ kind: 'decision', content, project, allowDuplicate: true, newProject: true }, actor)) as { memory: Memory }).memory;
  const a = await save('The server listens on port 3000');
  const b = await save('The server listens on port 3100', grok);
  const dis = app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai).disagreement;
  await save('Prefers dark mode', owner as never, 'garden');
  await save('Prefers dark mode', owner as never, 'garden');
  const disc = app.deps.discussions;
  const dd = disc.open({ name: 'Claude Code', model: 'Opus 4', access: 'full' }, { title: 'Which database?', question: 'SQLite or Postgres?', ask: ['Grok'] });
  disc.reply({ name: 'Grok', model: 'Grok 4', access: 'full' }, dd.id, { text: 'Postgres.' });
  disc.reply({ name: 'Grok', model: 'Grok 4', access: 'full' }, dd.id, { text: 'Postgres, still.' });
  return { s, dis, dd };
}

test('the list groups everything that waits, each group with its count', async (t) => {
  const c = await start(t);
  const x = await everything(c);
  const body = await (await c.f('/approvals')).text();
  assert.match(body, /Approvals · 2/);
  assert.match(body, /Facts that disagree · 1/);
  assert.match(body, /Tidy-ups · 1 · when you have time/);
  assert.match(body, /Discussions waiting · 1/);
  // The header counts what needs the owner; the tidy-up is named apart, as a quiet extra.
  assert.match(body, /4 things wait for you · 1 tidy-up when you have time/);
  assert.match(body, new RegExp(`href="/approvals\\?id=${x.s.id}"`));
  assert.match(body, new RegExp(`href="/disagreements\\?id=${x.dis.id}"`));
  assert.match(body, new RegExp(`href="/discussions/${x.dd.id}"`));
  assert.match(body, /New skill: release-notes/);
  assert.match(body, /2 facts look like duplicates/);
});

test('the sidebar badge equals the number of rows in the list', async (t) => {
  const c = await start(t);
  await everything(c);
  c.app.advance(30_001);
  const list = await (await c.f('/approvals')).text();
  const rows = (list.match(/class="ir[ "]/g) ?? []).length;
  assert.equal(rows, 5);
  // The badge counts what needs the owner: the tidy-up row is listed, but not counted.
  const needs = rows - 1;
  for (const path of ['/approvals', '/disagreements', '/facts/tidy', '/review']) {
    assert.match(await (await c.f(path)).text(), new RegExp(`<span class="side-count" aria-label="${needs} waiting">${needs}</span>`), path);
  }
});

test('an item opens beside the list with k of N, and a bare /approvals opens the first', async (t) => {
  const c = await start(t);
  const x = await everything(c);
  const first = await (await c.f('/approvals')).text();
  assert.match(first, /<span class="inbox-pos">1 of 4<\/span>/);
  assert.doesNotMatch(first, /class="inbox has-item"/, 'the list alone on a phone');
  const open = await (await c.f(`/approvals?proposal=${c.app.deps.skills.pendingProposals()[0]!.id}`)).text();
  assert.match(open, /class="inbox has-item"/);
  assert.match(open, /Add it and turn on/);
  const dis = await (await c.f(`/disagreements?id=${x.dis.id}`)).text();
  assert.match(dis, /<span class="inbox-pos">3 of 4<\/span>/);
  assert.match(dis, /This one is right/);
  assert.match(dis, /Both are right/);
  assert.match(dis, /name="back" value="\/approvals"/);
  const tidy = await (await c.f('/facts/tidy?item=' + encodeURIComponent(`pair:${c.app.deps.service.duplicates()[0]!.a.id}:${c.app.deps.service.duplicates()[0]!.b.id}`))).text();
  assert.match(tidy, /<span class="inbox-pos">Tidy-up 1 of 1<\/span>/);
  assert.match(tidy, /Keep both/);
  assert.match(tidy, /Keep this one, delete the other/);
});

test('the old URLs keep working inside the Inbox, and light the Inbox in the sidebar', async (t) => {
  const c = await start(t);
  await everything(c);
  for (const [path, crumb] of [['/disagreements', 'Facts that disagree'], ['/facts/tidy', 'Tidy-ups']] as const) {
    const r = await c.f(path);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<title>Inbox<\/title>/);
    assert.match(body, /class="inbox has-item"/);
    assert.match(body, new RegExp(`Inbox › <b>${crumb}</b>`));
    assert.match(body, /<a class="side-place" href="\/approvals" aria-current="page">Inbox/);
  }
  assert.match(await (await c.f('/disagreements')).text(), /Two different ports/);
  assert.match(await (await c.f('/facts/tidy')).text(), /Possible duplicates/);
});

test('settling a disagreement from the pane returns to the Inbox with one fewer', async (t) => {
  const c = await start(t);
  const x = await everything(c);
  const r = await c.f(`/disagreements/${x.dis.id}/settle`, form({ how: 'both', back: '/approvals' }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/approvals');
  const body = await (await c.f('/approvals')).text();
  assert.doesNotMatch(body, /Facts that disagree · /);
  assert.match(body, /3 things wait for you/);
  assert.match(body, /aria-label="3 waiting">3</);
});

test('Undo still shows after an approve and after a reject, beside the next item', async (t) => {
  const c = await start(t);
  const x = await everything(c);
  const r = await c.f(`/suggestions/${x.s.id}/approve`, form({ back: '/approvals' }));
  assert.equal(r.headers.get('location'), '/approvals');
  const body = await (await c.f('/approvals')).text();
  assert.match(body, /class="notice undo-line"[^>]*><span>Added to your profile\.<\/span>/);
  assert.match(body, /action="\/inbox\/undo"/);
  assert.match(body, /<span class="inbox-pos">1 of 3<\/span>/);
  const rej = c.app.deps.skills.pendingProposals()[0]!;
  await c.f(`/skill-proposals/${rej.id}/reject`, form());
  assert.match(await (await c.f('/approvals')).text(), /action="\/inbox\/undo"/);
});

test('empty: Nothing waits for you, with a line on what lands here; the old URLs say the same', async (t) => {
  const c = await start(t);
  for (const path of ['/approvals', '/disagreements', '/facts/tidy']) {
    const body = await (await c.f(path)).text();
    assert.match(body, /Nothing waits for you\./, path);
    assert.match(body, /land here/, path);
    assert.doesNotMatch(body, /class="inbox/, path);
    assert.doesNotMatch(body, /side-count/, path);
  }
});
