/** One loud thing a screen: at most one black (primary) button, and exactly one where the screen has a forward action. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { seedWildlogWeek } from '../testing/reviewFixtures.js';
import { seedFlaggedWildlog } from '../testing/staleFixtures.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;

test('every screen has at most one primary button, and the forward action is the one', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  const { service, pages, discussions } = app.deps;
  const page = await pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The wine cellar app.\n\n## Stack\nSwiftUI.' }, 'owner');
  await service.remember({ kind: 'profile', content: 'Has a Synology NAS' }, ai);
  const fact = (await service.remember({ kind: 'decision', content: 'wildlog keeps the cellar in SQLite on the phone', project: 'wildlog' }, { type: 'owner' }) as { memory: { id: string } }).memory;
  await service.remember({ kind: 'decision', content: 'wildlog keeps the cellar in SQLite on the iPhone', project: 'wildlog' }, { type: 'owner' });
  const d = discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which icon?', question: 'Pick one', project: 'wildlog', ask: ['Grok'] });
  const f = await loggedIn(app);
  const count = (body: string) => (body.match(/class="[^"]*\bprimary\b/g) ?? []).length;
  const want: Record<string, number | '<=1'> = {
    '/': 2, '/?project=wildlog': 2, '/pages': 1, [`/pages/${page.id}`]: 1, [`/pages/${page.id}/edit`]: 1, '/review': 0, '/settings': 0,
    '/facts': 0, '/facts/tidy': 1, [`/memories/${fact.id}`]: 1, '/memories/new': 1, '/search?q=a': '<=1', [`/discussions/${d.id}`]: '<=1',
  };
  for (const [path, n] of Object.entries(want)) {
    const res = await f(path);
    assert.equal(res.status, 200, path);
    const c = count(await res.text());
    if (n === '<=1') assert.ok(c <= 1, `${path}: ${c} primaries`); else assert.equal(c, n, path);
  }
  const login = await (await fetch(app.baseUrl + '/login')).text();
  assert.equal(count(login), 1, '/login');
});

test('a page that may be out of date still has exactly one primary, Edit', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-12T09:00:00Z') });
  t.after(() => app.close());
  const { page } = await seedFlaggedWildlog(app.deps, app.advance);
  const f = await loggedIn(app);
  const body = await (await f(`/pages/${page.id}`)).text();
  assert.match(body, /<details class="stale">/);
  assert.deepEqual(body.match(/<[^>]*class="[^"]*\bprimary\b[^>]*>[^<]*/g)?.map((m) => m.replace(/<[^>]*>/, '')), ['Edit']);
});

test('one waiting approval: Approve is the one primary inside the card, and the home keeps its own one outside', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await app.deps.service.remember({ kind: 'profile', content: 'Has a Synology NAS' }, ai);
  await app.deps.service.remember({ kind: 'profile', content: 'Lives in Berlin' }, ai);
  const f = await loggedIn(app);
  // On the home, two wait: the row links to /approvals and no card is drawn.
  const home = await (await f('/')).text();
  assert.equal((home.match(/class="[^"]*\bprimary\b/g) ?? []).length, 1, 'the home keeps exactly its own primary');
  assert.doesNotMatch(home, /approval-card/);
  // With one waiting, the card is the For-you row: one primary outside it, one inside.
  await app.deps.service.rejectSuggestion(app.deps.service.pendingSuggestions()[1]!.id);
  const withCard = await (await f('/')).text();
  const cut = withCard.indexOf('approval-card');
  assert.ok(cut > 0);
  assert.equal((withCard.slice(0, cut).match(/class="[^"]*\bprimary\b/g) ?? []).length, 1, 'outside the card');
  assert.equal((withCard.slice(cut).match(/class="[^"]*\bprimary\b/g) ?? []).length, 1, 'inside the card');
});
