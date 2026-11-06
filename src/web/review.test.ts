import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { clockTo, seedWildlogWeek } from '../testing/reviewFixtures.js';
import { seedFlaggedWildlog } from '../testing/staleFixtures.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z'), ...opts });
  t.after(() => app.close());
  return app;
}
const post = (f: Awaited<ReturnType<typeof loggedIn>>, path: string, body: Record<string, string> = {}) =>
  f(path, { method: 'POST', body: new URLSearchParams(body) });
const part = (body: string, title: string) => {
  const at = body.indexOf(`<h2>${title}</h2>`);
  return at < 0 ? '' : body.slice(at, body.indexOf('</section>', at));
};

async function seedTidyWeek(app: Awaited<ReturnType<typeof start>>) {
  const d = app.deps;
  const save = (content: string, embedding: number[]) => d.store.insert({
    kind: 'decision', content, project: 'wildlog', tags: [], embedding: new Float32Array(embedding), by: 'owner',
  });
  save('old fact to delete', [0, 1, 0, 0]);
  clockTo(d, app.advance, '2026-10-28T10:00:00Z');
  const first = d.store.list({})[0]!;
  d.store.softDelete(first.id, 'Claude Code');
  save('keep photos on the phone', [1, 0, 0, 0]);
  save('keep photos locally on the phone', [1, 0, 0, 0]);
  clockTo(d, app.advance, '2026-11-03T07:14:00Z');
}

test('the review ends with a Tidy line only when there is one', async (t) => {
  const app = await start(t);
  await seedTidyWeek(app);
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, /<p class="tidy-line">2 facts look like duplicates\. <a href="\/facts\/tidy">Tidy up<\/a><\/p>/);
  assert.ok(body.indexOf('class="tidy-line"') > body.indexOf('Restore it from its history.'));
  for (const path of ['/review/now', '/review/2026-10-19']) assert.doesNotMatch(await (await f(path)).text(), /tidy-line/);

  const legacy = await start(t);
  await seedTidyWeek(legacy);
  const row = legacy.deps.reviews.ensure('2026-10-26', 'owner')!;
  delete row.body.tidy;
  t.mock.method(legacy.deps.reviews, 'ensure', () => row);
  const lf = await loggedIn(legacy);
  assert.doesNotMatch(await (await lf('/review')).text(), /tidy-line/);
});

test('the Projects home builds last week without the Tidy checks, and the review fills them in', async (t) => {
  const app = await start(t);
  await seedTidyWeek(app);
  const duplicates = t.mock.method(app.deps.service, 'duplicates');
  const f = await loggedIn(app);
  assert.equal((await f('/')).status, 200);
  assert.equal(duplicates.mock.callCount(), 0);
  assert.equal(app.deps.reviews.ensure('2026-10-26', 'owner')!.body.tidy, null);
  assert.match(await (await f('/review')).text(), /class="tidy-line"/);
  const calls = duplicates.mock.callCount();
  assert.ok(calls > 0);
  assert.match(await (await f('/review')).text(), /class="tidy-line"/);
  assert.equal(duplicates.mock.callCount(), calls);
});

test('every review route needs the owner', async (t) => {
  const app = await start(t);
  for (const path of ['/review', '/review/now', '/review/2026-10-26']) {
    const res = await fetch(app.baseUrl + path, { redirect: 'manual' });
    assert.equal(res.status, 302, path);
    assert.match(res.headers.get('location')!, /^\/login/, path);
  }
  const open = await fetch(app.baseUrl + '/review/2026-10-26/open', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
  assert.equal(open.status, 302);
  assert.match(open.headers.get('location')!, /^\/login/);
});

test('last week shows the sentence, the parts in order and the footer, with no inline style', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance, '2026-11-02T07:14:00Z');
  const f = await loggedIn(app);
  const res = await f('/review');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>Last week<\/h1>/);
  assert.match(body, /Monday 26 October – Sunday 1 November 2026/);
  assert.match(body, /<p class="lede">3 steps done, all in wildlog\. 1 thing is late, and energy went quiet\.<\/p>/);
  assert.match(part(body, 'Went quiet'), /<b>energy<\/b> <span class="sub">last touched 18 Oct<\/span>/);
  // Its own row class, so the phone can put Park it and Keep open under the words instead of squeezing them.
  assert.match(part(body, 'Went quiet'), /<li><div class="row rv-quiet">/);
  const order = ['What moved', 'Waiting on you', 'Went quiet', 'Decided', 'This week in your growth', 'Behind the scenes'].map((x) => body.indexOf(x));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!)), JSON.stringify(order));
  assert.match(body, /Made on Monday 2 November at \d\d:\d\d from what was stored at the end of Sunday 1 November\. Nothing here was written by an AI\./);
  assert.doesNotMatch(body, /\sstyle=/);
  assert.match(body, /<progress value="7" max="8">7 of 8<\/progress>Release 0\.2\.2: 4 → 7 of 8/);
  // One date language: a chip flush right after the text, counted from the Monday the week was judged on.
  assert.match(part(body, 'Waiting on you'), /<span class="check-text"><span class="pj">wildlog<\/span>Run .\/scripts\/release.sh 0.2.2<\/span><span class="chip late"><time class="day" datetime="2026-10-25">8 days late<\/time><\/span><\/li>/);
  assert.doesNotMatch(body, /late-text|soon-text|late, due/);
});

test('opening a review marks nothing', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  for (const path of ['/review', '/review/now', '/review/2026-10-26', '/review/2026-10-19']) assert.equal((await f(path)).status, 200, path);
  const r = app.deps.reviews.ensure('2026-10-26', 'owner')!;
  assert.deepEqual([r.openedAt, r.dismissedAt], [null, null]);
});

test('Week has Last week, So far and Growth as quiet segments', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  for (const [path, text] of [['/review', 'Last week'], ['/review/now', 'So far'], ['/growth', 'Growth']] as const) {
    const body = await (await f(path)).text();
    assert.match(body, /<nav class="subnav" aria-label="Week">/);
    assert.match(body, new RegExp(`aria-current="page">${text}<\\/a>`));
  }
  const older = await (await f('/review/2026-10-19')).text();
  assert.match(older, /<span class="subnav-extra">[\s\S]*‹ 12 – 18 Oct[\s\S]*All weeks/);
  const work = await start(t, { mode: 'work' });
  await seedWildlogWeek(work.deps, work.advance);
  const wf = await loggedIn(work);
  assert.doesNotMatch(await (await wf('/review')).text(), /href="\/growth"/);
  assert.equal((await wf('/growth')).status, 404);
});

test('So far ends with Latest changes', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const empty = await (await f('/review/now')).text();
  assert.match(empty, /<section id="latest"[\s\S]*No changes yet this week\./);
  for (let n = 0; n < 10; n++) await app.deps.service.remember({ kind: 'decision', content: `change ${n}`, allowDuplicate: true, ...(n === 9 ? {} : { project: 'wildlog', newProject: n === 0 }) }, { type: 'owner' });
  const body = await (await f('/review/now')).text();
  const latest = body.slice(body.indexOf('<section id="latest"'));
  assert.match(latest, /<h2>Latest changes<\/h2>/);
  const direct = latest.slice(latest.indexOf('<ul class="rows">'), latest.indexOf('<details class="fold more">'));
  assert.equal((direct.match(/<li class="entry/g) ?? []).length, 8);
  assert.match(latest, /<details class="fold more"><summary class="row nolead">2 more/);
  assert.equal((latest.slice(latest.indexOf('<details class="fold more">')).match(/<li class="entry/g) ?? []).length, 2);
  assert.match(latest, /saved a memory without a project/);
});

test('a Latest changes entry is not a grid row, so its writer and time are not squeezed into the 8px lead column', async (t) => {
  const app = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'demo keeps its notes in SQLite', project: 'demo', newProject: true }, { type: 'owner' });
  const f = await loggedIn(app);
  const body = await (await f('/review/now')).text();
  const latest = body.slice(body.indexOf('<section id="latest"'));
  assert.doesNotMatch(latest, /class="row[ "]/, '.row is the grouped-list grid: a dot, the text, a trailing column');
  assert.match(latest, /<li class="entry w-you">\s*<ul class="meta-line"><li><span class="writer[^"]*">You<\/span> <span class="verb">/);
});

test('Done reading shows only while the Monday line would', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const before = await (await f('/review')).text();
  assert.match(before, /<form method="post" action="\/review\/2026-10-26\/open">[\s\S]*Done reading<\/button>/);
  assert.equal(app.deps.reviews.ensure('2026-10-26', 'owner')!.openedAt, null);
  const done = await post(f, '/review/2026-10-26/open');
  assert.deepEqual([done.status, done.headers.get('location')], [303, '/review']);
  assert.doesNotMatch(await (await f('/review')).text(), /Done reading<\/button>/);
});

test('the review points at the new homes', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, /href="\/review\/now#latest"/);
  assert.match(body, /href="\/growth">All of Growth/);
  assert.match(body, /action="\/growth\/[^"/]+\/react"/);
  assert.doesNotMatch(body, /href="\/settings#activity"|href="\/settings\/growth"/);
});

test('last week\'s ticks return to /review even when opened by its date; so far\'s return to /review/now; older weeks have no forms', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const byDate = await (await f('/review/2026-10-26')).text();
  assert.match(part(byDate, 'Waiting on you'), /<form method="post" action="\/projects\/wildlog\/waiting\/0\/done"><input type="hidden" name="text" value="Run .\/scripts\/release.sh 0.2.2"><input type="hidden" name="back" value="\/review">/);
  assert.match(part(byDate, 'Went quiet'), /name="back" value="\/review"[\s\S]*Park it/);
  assert.doesNotMatch(byDate, /value="\/review\/2026-10-26"/);
  const now = await (await f('/review/now')).text();
  assert.match(now, /<h1>This week so far<\/h1>/);
  assert.match(part(now, 'Waiting on you'), /name="back" value="\/review\/now"/);
  assert.match(now, /So far: made just now from what is stored\. It changes as the week goes on and isn't kept\./);
  const older = await (await f('/review/2026-10-19')).text();
  assert.match(older, /<h1>Week of 19 – 25 Oct<\/h1>/);
  assert.doesNotMatch(part(older, 'Waiting on you'), /<form/);
  assert.doesNotMatch(older, /Park it/);
  assert.match(part(older, 'Waiting on you'), /Ticks are only on last week and this week\./);
});

test('an older week draws no empty tick box for an item still waiting, only a note saying so', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const waiting = part(await (await f('/review/2026-10-19')).text(), 'Waiting on you');
  assert.match(waiting, /Run .\/scripts\/release.sh 0.2.2/);
  assert.doesNotMatch(waiting, /<span class="check"/, 'no box that looks like the clickable one');
  assert.match(waiting, /<span class="check-space" aria-hidden="true"><\/span><span class="check-text"><span class="pj">wildlog<\/span>Run .\/scripts\/release.sh 0.2.2 <span class="small-note">still waiting<\/span><\/span><span class="chip late"><time class="day" datetime="2026-10-25">1 day late<\/time><\/span><\/li>/);
  const css = await (await fetch(app.baseUrl + '/static/style.css')).text();
  assert.match(css, /\.check-space \{ display: block; width: 22px;[^}]*\}/, 'the space is as wide as a tick circle, so the text keeps in line with the rows that have one');
});

test('dates that aren\'t a Monday, this week, the future and bad dates', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const loc = async (path: string) => { const r = await f(path); return [r.status, r.headers.get('location')]; };
  assert.deepEqual(await loc('/review/2026-10-28'), [302, '/review/2026-10-26']);
  assert.deepEqual(await loc('/review/2026-11-03'), [302, '/review/now']);
  for (const bad of ['/review/2026-11-09', '/review/2026-01-05', '/review/2026-02-30', '/review/soon']) assert.equal((await f(bad)).status, 404, bad);
});

test('a week with nothing in it shows only the sentence and the footer', async (t) => {
  const app = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'a first fact', project: 'wildlog', newProject: true }, ai);
  clockTo(app.deps, app.advance, '2026-11-24T08:00:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review/2026-11-09')).text();
  assert.match(body, /<p class="lede">A quiet week\. Nothing moved\.<\/p>/);
  assert.doesNotMatch(body, /<section class="panel/);
  assert.doesNotMatch(body, /Behind the scenes/);
  assert.match(body, /class="rv-foot"/);
});

test('the error line shows only fixed text', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const changed = await (await f('/review?error=changed')).text();
  assert.equal(changed.split('role="alert"').length - 1, 1);
  assert.match(changed, /<p class="error" role="alert">That changed since this page was made\. This is how it stands now\.<\/p>/);
  assert.doesNotMatch(await (await f('/review?error=%3Cscript%3E')).text(), /role="alert"/);
});

test('step and item text written by an assistant is escaped', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance, '2026-10-31T12:00:00Z');
  await app.deps.service.remember({ kind: 'roadmap', project: 'evil', newProject: true, content: 'Done: <img src=x onerror=alert(1)> (2026-10-29)\nNow: x\nWaiting on you: <b>bold</b> (by 2026-10-30)' }, ai);
  clockTo(app.deps, app.advance, '2026-11-03T07:14:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(body, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(body, /<img src=x/);
});

test('a long list folds the rest under N more', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance, '2026-10-31T12:00:00Z');
  const items = Array.from({ length: 6 }, (_, i) => `late item ${i + 1} (by 2026-10-2${i + 1})`).join('; ');
  await app.deps.service.remember({ kind: 'roadmap', project: 'chores', newProject: true, content: `Now: chores\nWaiting on you: ${items}` }, ai);
  clockTo(app.deps, app.advance, '2026-11-03T07:14:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  const waiting = part(body, 'Waiting on you');
  const shown = waiting.slice(0, waiting.indexOf('<details class="fold more">'));
  assert.equal(shown.split('class="check"').length - 1, 5);
  assert.match(waiting, /<details class="fold more"><summary class="row nolead">2 more<span class="chev"><\/span><\/summary>/);
  assert.equal(waiting.split('class="check"').length - 1, 7);
  assert.match(body, /7 things are late/);
});

test('Read it opens the review and Not now goes home, both safe to send twice', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  await f('/review');
  for (let i = 0; i < 2; i++) {
    const open = await post(f, '/review/2026-10-26/open');
    assert.deepEqual([open.status, open.headers.get('location')], [303, '/review']);
  }
  const first = app.deps.reviews.ensure('2026-10-26', 'owner')!.openedAt;
  assert.ok(first);
  const dismiss = await post(f, '/review/2026-10-26/dismiss');
  assert.deepEqual([dismiss.status, dismiss.headers.get('location')], [303, '/']);
  assert.equal((await post(f, '/review/2026-10-26/dismiss')).status, 303);
  assert.equal(app.deps.reviews.ensure('2026-10-26', 'owner')!.openedAt, first);
  assert.equal((await post(f, '/review/2026-09-28/open')).status, 404);
  assert.equal((await post(f, '/review/2026-09-28/dismiss')).status, 404);
  assert.equal((await post(f, '/review/garbage/open')).status, 404);
  await f('/review/2026-10-19');
  assert.deepEqual([(await post(f, '/review/2026-10-19/open')).headers.get('location')], ['/review/2026-10-19']);
});

test('in work mode there is no growth part and the header says Work brain', async (t) => {
  const app = await start(t, { mode: 'work' });
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, /Work brain/);
  assert.doesNotMatch(body, /This week in your growth/);
  assert.match(body, /3 steps done, all in wildlog/);
});

test('the review is under the Week tab', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  assert.match(await (await f('/review')).text(), /aria-current="page">Week/);
});

test('before the first finished week the review says so and points to this week so far', async (t) => {
  const app = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'a first fact', project: 'wildlog', newProject: true }, ai);
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, /There is no finished week yet\./);
  assert.match(body, /href="\/review\/now"/);
});

test('All weeks lists every week newest first with its sentence and no unread mark', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-05T08:00:00Z') });
  t.after(() => app.close());
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog keeps the cellar on the phone', project: 'wildlog', newProject: true }, ai);
  clockTo(app.deps, app.advance, '2026-10-21T10:00:00Z');
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog labels are scanned on the phone', project: 'wildlog' }, ai);
  clockTo(app.deps, app.advance, '2026-10-27T08:00:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review/all')).text();
  assert.match(body, /<h1>All weeks<\/h1>/);
  assert.match(body, /One line per week\. A week opens as it stood at its end\./);
  const weeks = [...body.matchAll(/<a class="wk" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(weeks, [['/review', '19 – 25 Oct'], ['/review/2026-10-12', '12 – 18 Oct'], ['/review/2026-10-05', '5 – 11 Oct']]);
  assert.match(body, /<a class="wk" href="\/review\/2026-10-12">12 – 18 Oct<\/a><span class="ld q">A quiet week\. Nothing moved\.<\/span>/);
  assert.doesNotMatch(body, /unread|not opened|\bnew\b/i);
  assert.deepEqual(app.deps.reviews.ensure('2026-10-19', 'owner')!.openedAt, null);
});

test('All weeks builds at most 12 missing weeks per visit', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-07-14T08:00:00Z') });
  t.after(() => app.close());
  await app.deps.service.remember({ kind: 'decision', content: 'a first fact', project: 'wildlog', newProject: true }, ai);
  clockTo(app.deps, app.advance, '2026-11-03T07:14:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review/all')).text();
  assert.equal(body.split('class="wk"').length - 1, 16);
  assert.equal(body.split('Made when you open it.').length - 1, 4);
  assert.match(await (await f('/review/all')).text(), /^(?![\s\S]*Made when you open it)/);
});

test('a count that did not change in the week shows where it stands, without an arrow', async (t) => {
  const app = await start(t);
  const r = await app.deps.service.remember({ kind: 'roadmap', project: 'steady', newProject: true, content: 'Now: Brain round 1 (4/8)' }, ai) as { memory: { id: string } };
  clockTo(app.deps, app.advance, '2026-10-31T10:00:00Z');
  await app.deps.service.update(r.memory.id, { content: 'Done: a step (2026-10-31)\nNow: Brain round 1 (4/8)' }, ai);
  clockTo(app.deps, app.advance, '2026-11-03T07:14:00Z');
  const f = await loggedIn(app);
  const last = await (await f('/review')).text();
  assert.match(last, /<progress value="4" max="8">4 of 8<\/progress>Brain round 1: 4 of 8<\/span>/);
});

test('a finished step that was a waiting item shows without its "(by …)" date, and Behind the scenes leaves out zero totals', async (t) => {
  const app = await start(t);
  const to = (iso: string) => clockTo(app.deps, app.advance, iso);
  to('2026-10-27T09:00:00Z');
  const r = await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: Sign the TestFlight form (by 2026-10-29)', newProject: true }, ai) as { memory: { id: string } };
  to('2026-10-28T09:00:00Z');
  await app.deps.service.update(r.memory.id, { content: 'Done: Sign the TestFlight form (by 2026-10-29) (2026-10-28)\nNow: release' }, ai);
  to('2026-11-02T08:00:00Z');
  const body = await (await (await loggedIn(app))('/review')).text();
  const moved = part(body, 'What moved');
  assert.match(moved, /<li>Sign the TestFlight form<span class="d">/);
  assert.doesNotMatch(moved, /\(by 2026-10-29\)/);
  const behind = body.slice(body.indexOf('<summary>Behind the scenes'), body.indexOf('</summary>', body.indexOf('<summary>Behind the scenes')));
  assert.doesNotMatch(behind, /\b0 (saved|changed|deleted)\b/, behind);
});

test('Decided shows a grey replaced-on link and Safety notes say who replaced whose memory', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance, '2026-10-31T12:00:00Z');
  const s = app.deps.service;
  const owners = (await s.remember({ kind: 'decision', content: 'wildlog backups go to the NAS', project: 'wildlog' }, { type: 'owner' }) as any).memory;
  const claudes = (await s.remember({ kind: 'decision', content: 'wildlog photos are kept at full size', project: 'wildlog' }, { type: 'ai', name: 'Claude' }) as any).memory;
  clockTo(app.deps, app.advance, '2026-10-31T13:00:00Z');
  await s.remember({ kind: 'decision', content: 'wildlog backups go to the NAS and to B2', project: 'wildlog', supersedes: [owners.id] }, ai);
  await s.remember({ kind: 'decision', content: 'wildlog photos are shrunk to 2048 pixels', project: 'wildlog', supersedes: [claudes.id] }, ai);
  clockTo(app.deps, app.advance, '2026-11-05T09:00:00Z');
  const label = app.deps.store.list({ project: 'wildlog', kind: 'decision' }).find((m) => m.content.startsWith('Label photos'))!;
  const newer = (await s.remember({ kind: 'decision', content: 'Label photos go to iCloud, still with no cloud text reading.', project: 'wildlog', supersedes: [label.id] }, { type: 'owner' }) as any).memory;
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, new RegExp(`<a class="replaced-on" href="/memories/${newer.id}\\?from=%2Freview">replaced on 5 Nov</a>`));
  assert.match(body, new RegExp(`Claude Code replaced a memory you wrote: “<a href="/memories/${owners.id}\\?from=%2Freview">wildlog backups go to the NAS</a>”\\. Undo it on its page\\.`));
  assert.match(body, new RegExp(`Claude Code replaced a memory Claude wrote: “<a href="/memories/${claudes.id}\\?from=%2Freview">wildlog photos are kept at full size</a>”\\. Undo it on its page\\.`));
  assert.doesNotMatch(body, /\sstyle=/);
});

test('a Safety note quoting a fact that ends in a full stop adds no second one', async (t) => {
  const app = await start(t);
  await seedWildlogWeek(app.deps, app.advance, '2026-10-31T12:00:00Z');
  const s = app.deps.service;
  const prices = (await s.remember({ kind: 'decision', content: 'Prices are typed in from the paper receipt.', project: 'wildlog' }, { type: 'owner' }) as any).memory;
  const gone = (await s.remember({ kind: 'decision', content: 'Stock is counted every Sunday.', project: 'wildlog' }, { type: 'owner' }) as any).memory;
  clockTo(app.deps, app.advance, '2026-10-31T13:00:00Z');
  await s.remember({ kind: 'decision', content: 'Prices come from the scanned receipt.', project: 'wildlog', supersedes: [prices.id] }, ai);
  s.forget(gone.id, ai);
  clockTo(app.deps, app.advance, '2026-11-05T09:00:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/review')).text();
  assert.match(body, new RegExp(`Claude Code replaced a memory you wrote: “<a href="/memories/${prices.id}\\?from=%2Freview">Prices are typed in from the paper receipt\\.</a>” Undo it on its page\\.`));
  assert.match(body, new RegExp(`Claude Code deleted a memory on [^:]+: “<a href="/memories/${gone.id}\\?from=%2Freview">Stock is counted every Sunday\\.</a>” Restore it from its history\\.`));
  assert.doesNotMatch(body, /\.”\./);
});

test('the Projects home, the header and the weekly review never mention out-of-date pages', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-12T09:00:00Z') });
  t.after(() => app.close());
  const { page } = await seedFlaggedWildlog(app.deps, app.advance);
  assert.notEqual(app.deps.pages.freshness.forPage(page), null);
  const f = await loggedIn(app);
  // The panel's chip is tested with the other lists; only the screens without a panel are checked here.
  for (const path of ['/', '/review/now', '/review']) {
    const res = await f(path);
    assert.ok(res.status === 200 || res.status === 303, `${path}: ${res.status}`);
    const body = res.status === 303 ? await (await f(res.headers.get('location')!)).text() : await res.text();
    assert.doesNotMatch(body, /out of date/i, path);
  }
});
