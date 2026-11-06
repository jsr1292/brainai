import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Caller, DiscussionService } from '../discussions/service.js';
import { startTestApp, loggedIn } from '../testing/helpers.js';

const code: Caller = { name: 'Claude Code', model: 'Opus 4', access: 'full' };
const gpt: Caller = { name: 'ChatGPT', model: 'GPT-5', access: 'full' };
const grok: Caller = { name: 'Grok', model: 'Grok 4', access: 'full' };

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  return { app, f, d: app.deps.discussions };
}
const post = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });
const open = (d: DiscussionService, over: object = {}) =>
  d.open(code, { title: 'Which database?', question: 'SQLite or Postgres?\nLine two', ask: ['ChatGPT', 'Grok'], ...over });

test('discussion and Growth dates use the one date language', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-11-03T12:00:00Z') });
  t.after(() => app.close());
  const f = await loggedIn(app);
  await app.deps.growth.note({ kind: 'strength', area: 'reviewing', what: 'Reviewed the change' }, 'Claude Code');
  app.advance(86_400_000);
  const d = open(app.deps.discussions);
  await app.deps.discussions.close('owner', d.id, { decision: 'Use SQLite.' });
  app.advance(600_000);
  const discussions = await (await f('/discussions')).text();
  const growth = await (await f('/growth')).text();
  assert.match(discussions, /decided <time[^>]*>10 min ago<\/time>/);
  assert.match(growth, /latest <time[^>]*>yesterday<\/time>/);
  assert.doesNotMatch(discussions + growth, /<time datetime="[^"]+">4 Nov<\/time>/);
});

test('the Discussions page lists open discussions first with who to ask next', async (t) => {
  const { f, d } = await start(t);
  const closed = open(d, { title: 'Old one' });
  await d.close('owner', closed.id, { decision: 'Done.' });
  const a = open(d, { project: 'wildlog' });
  d.reply(gpt, a.id, { text: 'My view' });
  const res = await f('/discussions');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Discussions<\/title>/);
  assert.ok(body.indexOf('Which database?') < body.indexOf('Old one'), 'open first');
  assert.match(body, new RegExp(`href="/discussions/${a.id}"`));
  assert.match(body, /wildlog/);
  assert.match(body, /round 1/);
  assert.match(body, /<li>waiting for Grok<\/li>/, 'waiting on an assistant is plain words, not amber');
  assert.match(body, /<li>decided <time datetime="\d{4}-\d\d-\d\dT[^"]+" title="[^"]+">[^<]+<\/time><\/li><li>saved to memory<\/li>/);
});

test('the discussion page shows every reply to the owner, even during the blind round', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  d.reply(gpt, a.id, { text: 'Use SQLite, it is simple.' });
  d.reply(grok, a.id, { text: 'Postgres scales.' });
  const body = await (await f(`/discussions/${a.id}`)).text();
  assert.match(body, /<title>Discussion<\/title>/);
  assert.match(body, /Use SQLite, it is simple\./);
  assert.match(body, /Postgres scales\./);
  assert.match(body, /ChatGPT · GPT-5/);
  assert.match(body, /w-gpt/);
  assert.match(body, /SQLite or Postgres\?\nLine two/);
  assert.match(body, /class="post">SQLite or Postgres\?\nLine two/);
});

test('post text is escaped: a reply containing <script> renders as text', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { title: '<b>bold</b> title', question: '<script>alert(2)</script>' });
  d.reply(gpt, a.id, { text: '<script>alert(1)</script>' });
  d.addNote(a.id, '<img src=x onerror=alert(3)>');
  const body = await (await f(`/discussions/${a.id}`)).text();
  assert.ok(!body.includes('<script>alert'));
  assert.ok(!body.includes('<img src=x'));
  assert.ok(!body.includes('<b>bold</b>'));
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const list = await (await f('/discussions')).text();
  assert.ok(!list.includes('<b>bold</b>'));
});

test('Ask in ChatGPT links to chatgpt.com with the request; Mac assistants get only Copy', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { ask: ['ChatGPT', 'Grok Build'] });
  const body = await (await f(`/discussions/${a.id}`)).text();
  const text = `Read the shared-memory discussion with id ${a.id} and give your view.`;
  assert.ok(!body.includes(encodeURIComponent('Which database?')), 'the title never goes into the request');
  assert.match(body, new RegExp(`href="https://chatgpt\\.com/\\?q=${encodeURIComponent(text).replace(/[.()]/g, '\\$&')}"`));
  assert.match(body, /Ask in ChatGPT/);
  assert.match(body, /target="_blank"/);
  assert.match(body, /rel="noopener"/);
  assert.ok(!body.includes('Ask in Grok Build'));
  assert.equal((body.match(/data-copy="/g) ?? []).length, 2);
  assert.ok(body.includes(`data-copy="${text.replace(/"/g, '&quot;')}"`));
  // Round 2 wording.
  d.nextRound(a.id);
  const later = await (await f(`/discussions/${a.id}`)).text();
  assert.ok(later.includes(`data-copy="Read the shared-memory discussion with id ${a.id} again and reply to the others."`));
});

test('the owner adds a note, starts round 2, edits the ask list and switches sharing', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  const page = `/discussions/${a.id}`;
  let r = await f(`${page}/note`, post({ text: 'Keep it cheap' }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), page);
  assert.equal(d.ownerView(a.id).notes[0]!.text, 'Keep it cheap');
  r = await f(`${page}/note`, post({ text: '  ' }));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /note must be 1 to/);

  assert.equal((await f(`${page}/round`, post({}))).status, 303);
  assert.equal(d.ownerView(a.id).round, 2);
  assert.match(await (await f(page)).text(), /Start next round/);

  assert.equal((await f(`${page}/ask`, post({ add: 'GLM' }))).status, 303);
  assert.deepEqual(d.ownerView(a.id).ask, ['ChatGPT', 'Grok', 'GLM']);
  assert.equal((await f(`${page}/ask`, post({ remove: 'Grok' }))).status, 303);
  assert.deepEqual(d.ownerView(a.id).ask, ['ChatGPT', 'GLM']);

  assert.equal((await f(`${page}/sharing`, post({ include: 'no' }))).status, 303);
  assert.equal(d.ownerView(a.id).includeLimited, false);
  assert.equal((await f(`${page}/sharing`, post({ include: 'yes' }))).status, 303);
  assert.equal(d.ownerView(a.id).includeLimited, true);
  assert.equal((await f(`${page}/sharing`, post({ include: 'maybe' }))).status, 400);
});

test('round 1 offers "Start round 2 now"', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  assert.match(await (await f(`/discussions/${a.id}`)).text(), /Start round 2 now/);
});

test('deciding saves the decision memory and shows it; deciding without a project on a project-less discussion is allowed', async (t) => {
  const { app, f, d } = await start(t);
  const a = open(d, { project: 'wildlog' });
  let r = await f(`/discussions/${a.id}/decide`, post({ decision: 'Use SQLite.', project: '' }));
  assert.equal(r.status, 303);
  const v = d.ownerView(a.id);
  assert.equal(v.stage, 'closed');
  assert.ok(v.decisionMemoryId);
  assert.equal(app.deps.store.get(v.decisionMemoryId!)!.project, 'wildlog');
  const body = await (await f(`/discussions/${a.id}`)).text();
  assert.match(body, /Use SQLite\./);
  assert.match(body, new RegExp(`href="/memories/${v.decisionMemoryId}\\?from=%2Fdiscussions%2F${a.id}"`));
  assert.ok(!body.includes('/decide"'));

  const b = open(d, { title: 'No project' });
  r = await f(`/discussions/${b.id}/decide`, post({ decision: 'Go.', project: '' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.store.get(d.ownerView(b.id).decisionMemoryId!)!.project, null);

  const c = open(d, { title: 'Pick project' });
  await app.deps.service.remember({ kind: 'decision', content: 'x', project: 'alpha' }, { type: 'owner' });
  assert.match(await (await f(`/discussions/${c.id}`)).text(), /<option value="alpha">alpha<\/option>/);
  r = await f(`/discussions/${c.id}/decide`, post({ decision: 'Go.', project: 'alpha' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.store.get(d.ownerView(c.id).decisionMemoryId!)!.project, 'alpha');

  const e = open(d, { title: 'Empty' });
  r = await f(`/discussions/${e.id}/decide`, post({ decision: ' ', project: '' }));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /decision must be 1 to/);
});

test('deleting needs the confirm box and then hides the discussion', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  const page = `/discussions/${a.id}`;
  assert.match(await (await f(page)).text(), /Yes, delete this discussion/);
  assert.equal((await f(`${page}/delete`, post({}))).status, 400);
  assert.equal((await f(`${page}/delete`, post({ confirm: 'no' }))).status, 400);
  assert.ok(d.ownerView(a.id));
  const r = await f(`${page}/delete`, post({ confirm: 'yes' }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/discussions');
  assert.equal((await f(page)).status, 404);
  assert.ok(!(await (await f('/discussions')).text()).includes('Which database?'));
});

test('files are served as plain text', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { files: [{ name: 'a b.html', content: '<script>alert(1)</script>' }] });
  const page = await (await f(`/discussions/${a.id}`)).text();
  assert.match(page, new RegExp(`href="/discussions/${a.id}/files/a%20b\\.html"`));
  const res = await f(`/discussions/${a.id}/files/${encodeURIComponent('a b.html')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await res.text(), '<script>alert(1)</script>');
  assert.equal((await f(`/discussions/${a.id}/files/missing.txt`)).status, 404);
});

test('a file attached by path is linked and served', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { files: [{ name: 'src/x.ts', content: 'export const x = 1;' }] });
  assert.ok((await (await f(`/discussions/${a.id}`)).text()).includes(`href="/discussions/${a.id}/files/src%2Fx.ts"`));
  const res = await f(`/discussions/${a.id}/files/src%2Fx.ts`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await res.text(), 'export const x = 1;');
});

test('unknown or removed discussions are 404', async (t) => {
  const { f, d } = await start(t);
  assert.equal((await f('/discussions/nope')).status, 404);
  assert.equal((await f('/discussions/nope/note', post({ text: 'x' }))).status, 404);
  assert.equal((await f('/discussions/nope/files/x')).status, 404);
  assert.equal((await f('/discussions/nope/decide', post({ decision: 'x' }))).status, 404);
  assert.equal((await f('/discussions/nope/delete', post({ confirm: 'yes' }))).status, 404);
  void d;
});

test('the home names a discussion only once it waits on the owner, and counts two or more', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { ask: ['Grok'] });
  assert.doesNotMatch(await (await f('/')).text(), /wait(s|ing) on you/, 'waiting for Grok is not waiting on you');
  d.reply(grok, a.id, { text: 'SQLite.' });
  assert.doesNotMatch(await (await f('/')).text(), /wait(s|ing) on you/, 'round 2 starts, waiting for Grok again');
  d.reply(grok, a.id, { text: 'Still SQLite.' });
  assert.match(await (await f('/')).text(), new RegExp(`<a class="row" href="/discussions/${a.id}"><span class="dot"[^>]*></span><span class="txt">Waiting on you: <b>Which database\\?</b></span>`));
  const b = open(d, { title: 'Second', ask: ['Grok'] });
  d.reply(grok, b.id, { text: 'Yes.' });
  d.reply(grok, b.id, { text: 'Still yes.' });
  assert.match(await (await f('/')).text(), /<a class="row" href="\/discussions"><span class="dot"[^>]*><\/span><span class="txt">2 discussions wait on you<\/span>/);
});

test('logged-out requests redirect to login', async (t) => {
  const { app, d } = await start(t);
  const a = open(d);
  for (const [path, method] of [['/discussions', 'GET'], [`/discussions/${a.id}`, 'GET'], [`/discussions/${a.id}/files/x`, 'GET'], [`/discussions/${a.id}/note`, 'POST']] as const) {
    const r = await fetch(app.baseUrl + path, { method, redirect: 'manual', headers: { Origin: app.baseUrl } });
    assert.equal(r.status, 302, path);
    assert.match(r.headers.get('location')!, /^\/login/);
  }
});

test('a decided discussion keeps its sharing switch and Delete, but not the open-only forms', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  await d.close('owner', a.id, { decision: 'Done.' });
  const page = `/discussions/${a.id}`;
  const body = await (await f(page)).text();
  assert.match(body, /Assistants with discussions-only access can see this discussion\./);
  assert.ok(body.includes(`action="${page}/sharing"`));
  assert.ok(body.includes(`action="${page}/delete"`));
  assert.match(body, /Yes, delete this discussion/);
  assert.match(body, /Decided <time datetime="\d{4}-\d\d-\d\dT[^"]+" title="[^"]+">[^<]+<\/time>/);
  for (const gone of ['/note"', '/round"', '/decide"', '/ask"']) assert.ok(!body.includes(gone), gone);
  assert.equal((await f(`${page}/sharing`, post({ include: 'no' }))).status, 303);
  assert.equal(d.ownerView(a.id).includeLimited, false);
  assert.match(await (await f(page)).text(), /Assistants with discussions-only access cannot see this discussion\./);
  assert.equal((await f(`${page}/delete`, post({}))).status, 400);
  assert.equal((await f(`${page}/delete`, post({ confirm: 'yes' }))).status, 303);
  assert.equal((await f(page)).status, 404);
});

test('open discussions first, closed ones folded', async (t) => {
  const { f, d } = await start(t);
  assert.match(await (await f('/discussions')).text(), /No discussions yet\. Ask an assistant to open one when you want several opinions\./);
  open(d, { title: 'First open' });
  open(d, { title: 'Second open', project: 'wildlog' });
  for (const title of ['Old one', 'Older one']) {
    const c = open(d, { title });
    await d.close('owner', c.id, { decision: 'Done.' });
  }
  const body = await (await f('/discussions')).text();
  assert.match(body, /<ul class="group">/);
  assert.match(body, /<summary class="row nolead">Closed <span class="n">2<\/span><span class="chev"><\/span><\/summary>/);
  const fold = body.indexOf('<details class="fold">');
  assert.ok(fold > -1, 'a Closed fold');
  assert.ok(body.indexOf('First open') < fold && body.indexOf('Second open') < fold, 'open rows before the fold');
  assert.equal((body.slice(0, fold).match(/<li><a class="row nolead" href="\/discussions\//g) ?? []).length, 2, 'two open rows');
  const after = body.slice(fold);
  assert.match(after, /Old one/);
  assert.match(after, /Older one/);
});

test('a discussion reads its answers before Decide', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  d.reply(gpt, a.id, { text: 'Use SQLite, it is simple.' });
  d.nextRound(a.id);
  d.reply(grok, a.id, { text: 'Round 2 view.' });
  const body = await (await f(`/discussions/${a.id}`)).text();
  const round2 = body.indexOf('Round 2 view.');
  const round1 = body.indexOf('Use SQLite, it is simple.');
  const pending = body.indexOf('No reply yet in round 2');
  const decide = body.indexOf('<h2>Decide</h2>');
  const ask = body.indexOf('Ask the next one');
  const more = body.indexOf('<details class="pfold more-fold">');
  assert.ok(round2 > -1 && round2 < round1 && round1 < decide, 'this round, then the earlier rounds folded, then Decide');
  assert.match(body, /<details class="earlier" data-desk-open><summary>Round 1 · 1 reply/);
  assert.ok(pending > -1 && pending < decide, 'the dashed pending card sits with this round');
  assert.ok(decide > -1 && decide < ask && ask < more, 'Decide, then Ask the next one, then More');
  assert.ok(body.indexOf('Start next round') > more, 'Start next round inside the fold');
  assert.ok(body.indexOf(`action="/discussions/${a.id}/sharing"`) > more, 'Sharing inside the fold');
  assert.ok(body.indexOf(`action="/discussions/${a.id}/delete"`) > more, 'Delete inside the fold');
});

test('a refused note comes back inside an open More fold with its text', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  const long = `Keep it cheap ${'x'.repeat(8000)}`;
  const r = await f(`/discussions/${a.id}/note`, post({ text: long }));
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.match(body, /<details class="pfold more-fold" open>/, 'the fold holding the note opens');
  assert.ok(body.indexOf(long) > body.indexOf('more-fold'), 'the half-typed note is in the form');
  assert.match(await (await f(`/discussions/${a.id}`)).text(), /<details class="pfold more-fold">/, 'closed on a plain visit');
});

test('a closed discussion shows its decision first', async (t) => {
  const { f, d } = await start(t);
  const a = open(d, { project: 'wildlog' });
  d.reply(gpt, a.id, { text: 'My view' });
  await d.close('owner', a.id, { decision: 'Use SQLite.' });
  const body = await (await f(`/discussions/${a.id}`)).text();
  assert.ok(body.indexOf('<h2>Decision</h2>') < body.indexOf('Use SQLite.'));
  assert.ok(body.indexOf('Use SQLite.') < body.indexOf('SQLite or Postgres?'), 'the decision comes before the question');
  assert.match(body, /My view/);
  const more = body.indexOf('<details class="pfold more-fold">');
  assert.ok(more > -1, 'a More fold');
  assert.ok(body.indexOf(`action="/discussions/${a.id}/sharing"`) > more, 'Sharing inside the fold');
  assert.ok(body.indexOf(`action="/discussions/${a.id}/delete"`) > more, 'Delete inside the fold');
  assert.ok(!body.includes('<h2>Decide</h2>'), 'no Decide');
  assert.ok(!body.includes('Ask the next one'), 'no round strip');
});

test('a discussion lights Projects and goes back to its project or Discussions', async (t) => {
  const { f, d } = await start(t);
  const withProject = open(d, { project: 'wildlog' });
  const noProject = open(d, { title: 'No project' });
  const one = await (await f(`/discussions/${withProject.id}`)).text();
  assert.match(one, /<p class="crumb back"><a href="\/\?project=wildlog#panel">‹ wildlog<\/a><\/p>/);
  const header = one.split('</header>')[0]!;
  assert.match(header, /<a[^>]*aria-current="page"[^>]*>Projects<\/a>/);
  const two = await (await f(`/discussions/${noProject.id}`)).text();
  assert.match(two, /<p class="crumb back"><a href="\/discussions">‹ Discussions<\/a><\/p>/);
});

test('the project panel lists its discussions as a plain list, title first, and one waiting on an assistant is not marked as needing you', async (t) => {
  const { app, f, d } = await start(t);
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const waits = open(d, { project: 'wildlog', title: 'Which database?' });
  d.reply(gpt, waits.id, { text: 'My view' });
  const body = await (await f('/?project=wildlog')).text();
  const part = body.slice(body.indexOf('<h3 id="p-discussions">Discussions</h3>'), body.indexOf('id="p-facts">Facts'));
  assert.match(part, /<ul class="pdiscs plain-list">/);
  assert.match(part, new RegExp(`<li><a href="/discussions/${waits.id}">Which database\\?</a><span class="pdisc-label">Round 1 · waiting for Grok</span></li>`), 'waiting on Grok is not orange');
  assert.doesNotMatch(part, /class="(open|closed)"/, 'the class marks only what needs you (ProjectsService.needsYou)');
});

test('every owner action on a discussion clears the sidebar cache, not only decide', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  d.reply(gpt, a.id, { text: 'SQLite.' });
  d.reply(grok, a.id, { text: 'Postgres.' });
  d.reply(gpt, a.id, { text: 'Still SQLite.' });
  d.reply(grok, a.id, { text: 'SQLite is fine.' });
  const sidebarOf = (body: string) => { const at = body.indexOf('<nav class="side"'); return body.slice(at, body.indexOf('</nav>', at)); };
  // Round 2 waits on the owner: the needs-you count is worked out once and cached.
  assert.match(sidebarOf(await (await f('/')).text()), /side-need/);
  const r = await f(`/discussions/${a.id}/delete`, { ...post({ confirm: 'yes' }), redirect: 'manual' });
  assert.equal(r.status, 303);
  // No clock advance: only the delete itself can have cleared the cache.
  assert.doesNotMatch(sidebarOf(await (await f('/review')).text()), /side-need/);
});

test('earlier rounds are marked to open on a wide screen, and are never rendered open', async (t) => {
  const { f, d } = await start(t);
  const a = open(d);
  d.reply(gpt, a.id, { text: 'SQLite.' });
  d.reply(grok, a.id, { text: 'Postgres.' });
  const body = await (await f(`/discussions/${a.id}`)).text();
  assert.match(body, /<details class="earlier" data-desk-open><summary>Round 1 · 2 replies/);
  assert.doesNotMatch(body, /<details class="earlier"[^>]* open/);
});
