import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBackupStatus } from '../backupStatus.js';
import type { FolderSource } from '../projects/service.js';
import { ReviewService, type ReviewDeps } from '../review/service.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { clockTo, seedWildlogWeek } from '../testing/reviewFixtures.js';
import { localDay } from '../timezone.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;
const owner = { type: 'owner' } as const;
const DAY = 86_400_000;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const post = (f: Awaited<ReturnType<typeof loggedIn>>, path: string, body: Record<string, string> = {}) =>
  f(path, { method: 'POST', body: new URLSearchParams(body) });

test('every project route needs the owner, and refuses a form sent from another site', async (t) => {
  const { app } = await start(t);
  const foreign = await fetch(app.baseUrl + '/projects/ideas', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ text: 'x' }) });
  assert.equal(foreign.status, 403);
  const res = await fetch(app.baseUrl + '/projects/ideas', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ text: 'x' }) });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^\/login/);
  const home = await fetch(app.baseUrl + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  app.deps.registry.create('vpn', { state: 'open' }, 'owner');
  for (const path of ['/projects/vpn/state', '/projects/vpn/pin', '/projects/vpn/unpin', '/projects/vpn/snooze', '/projects/vpn/info', '/projects/vpn/waiting/0/done', '/projects/vpn/done/0/undo']) {
    const r = await fetch(app.baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ state: 'parked', text: 'x' }) });
    assert.equal(r.status, 302, path);
    assert.match(r.headers.get('location')!, /^\/login/, path);
  }
  assert.equal(app.deps.registry.get('vpn')!.state, 'open');
});

test('ticking an item through the web removes it and returns to the panel, and Undo brings it back', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh; connect ChatGPT' }, ai);
  const res = await post(f, '/projects/wildlog/waiting/1/done', { text: 'connect ChatGPT' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/?project=wildlog#panel');
  const panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, /aria-label="Mark done: run release.sh"/);
  assert.doesNotMatch(panel, /aria-label="Mark done: connect ChatGPT"/);
  assert.match(panel, /Done today[\s\S]*connect ChatGPT[\s\S]*Undo/);
  assert.equal((await post(f, '/projects/wildlog/done/0/undo', { text: 'connect ChatGPT' })).status, 303);
  assert.match(await (await f('/?project=wildlog')).text(), /aria-label="Mark done: connect ChatGPT"/);
});

test('a tick with stale text answers 400 and says "This list changed: reload"', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'roadmap', project: 'inflow', content: 'Now: checks\nWaiting on you: device checks' }, ai);
  const res = await post(f, '/projects/inflow/waiting/0/done', { text: 'something else' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /This list changed: reload/);
  assert.equal((await post(f, '/projects/inflow/waiting/x/done', { text: 'device checks' })).status, 400);
});

test('pinning a seventh project answers 400 with the pin-limit message', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 7; i++) app.deps.registry.create(`p${i}`, { state: 'open' }, 'owner');
  for (let i = 0; i < 6; i++) assert.equal((await post(f, `/projects/p${i}/pin`)).status, 303);
  const res = await post(f, '/projects/p6/pin');
  assert.equal(res.status, 400);
  assert.match(await res.text(), /On the go holds 6 projects: unpin one first/);
});

test('an unknown project answers 404, and a bad state answers 400', async (t) => {
  const { app, f } = await start(t);
  assert.equal((await post(f, '/projects/nope/pin')).status, 404);
  app.deps.registry.create('vpn', { state: 'open' }, 'owner');
  assert.equal((await post(f, '/projects/vpn/state', { state: 'gone' })).status, 400);
  assert.equal((await post(f, '/projects/vpn/state', { state: 'parked' })).status, 303);
  assert.equal(app.deps.registry.get('vpn')!.state, 'parked');
});

test('home shows on-the-go cards, one row per other open project, and the folds with counts', async (t) => {
  const { app, f } = await start(t);
  const r = app.deps.registry;
  for (const n of ['a1', 'a2', 'b1', 'b2', 'b3']) r.create(n, { state: 'open', oneLiner: `Project ${n}` }, 'owner');
  r.pin('a1', 'owner');
  r.pin('a2', 'owner');
  r.create('idea1', { state: 'idea', oneLiner: 'An idea' }, 'owner');
  r.create('parked1', { state: 'parked' }, 'owner');
  r.create('done1', { state: 'done' }, 'owner');
  r.create('career', { state: 'open', area: 'personal' }, 'owner');
  const page = await (await f('/')).text();
  assert.match(page, /<h2 id="ongo">On the go <span class="n">2<\/span><\/h2>[\s\S]*a1[\s\S]*a2/);
  assert.match(page, /<h2 id="alsoopen">Also open <span class="n">3<\/span><\/h2>/);
  for (const [title, n] of [['Ideas', 1], ['Parked', 1], ['Personal', 1], ['Done', 1]] as const) {
    assert.match(page, new RegExp(`<summary class="row nolead">${title}<span class="n">${n}</span><span class="chev"></span></summary>`));
  }
  assert.match(page, /aria-current="page">Projects</);
  assert.doesNotMatch(page.slice(page.indexOf('<main')), / style="/);
});

test('Also open shows six rows and folds the rest', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 14; i++) app.deps.registry.create(`open${String(i).padStart(2, '0')}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  const body = await (await f('/')).text();
  const section = body.slice(body.indexOf('id="alsoopen"'), body.indexOf('class="group pfolds"'));
  const direct = section.slice(0, section.indexOf('<details class="fold more"'));
  assert.equal((direct.match(/<li><a class="row prow/g) ?? []).length, 6);
  assert.equal((section.match(/<li><a class="row prow/g) ?? []).length, 14);
  assert.match(section, /<li><details class="fold more" data-desk-open><summary class="row nolead">8 more/);
  // Beside an open project too (the desktop's list pane shows every Also open row): the fold is marked, and open when it holds the project.
  assert.match(await (await f('/?project=open09')).text(), /<details class="fold more" data-desk-open open>/);
  const seven = await startTestApp();
  t.after(() => seven.close());
  for (let i = 0; i < 7; i++) seven.deps.registry.create(`p${i}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  const sevenBody = await (await (await loggedIn(seven))('/')).text();
  const sevenSection = sevenBody.slice(sevenBody.indexOf('id="alsoopen"'), sevenBody.indexOf('class="group pfolds"'));
  assert.equal((sevenSection.match(/<li><a class="row prow/g) ?? []).length, 7);
  assert.doesNotMatch(sevenSection, /class="fold more"/);
});

test('on the plain home each Also open row carries its one-liner, hidden, for the desktop; nowhere else does', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 9; i++) app.deps.registry.create(`open${i}`, { state: 'open', oneLiner: `Project number ${i}` }, 'owner');
  app.deps.registry.create('gone', { state: 'open', oneLiner: 'Finished thing' }, 'owner'); app.deps.registry.setState('gone', 'done', 'owner');
  await app.deps.service.remember({ kind: 'roadmap', project: 'open0', content: 'Now: x\nNext: ship the next bit' }, ai);
  const text = await (await f('/')).text();
  const section = text.slice(text.indexOf('id="alsoopen"'), text.indexOf('class="group pfolds"'));
  // The name, then the one-liner (not Next), in every row, also those in the "N more" fold.
  assert.match(section, /<span class="prow-name">open0<\/span><span class="prow-one" hidden>Project number 0<\/span><span class="prow-next">ship the next bit/);
  const rows = (section.match(/<li><a class="row prow/g) ?? []).length;
  assert.ok(rows >= 9, String(rows));
  assert.equal((section.match(/<span class="prow-one" hidden>/g) ?? []).length, rows);
  // The folds and the list beside an open project keep today's rows.
  assert.doesNotMatch(text.slice(text.indexOf('class="group pfolds"')), /prow-one/);
  assert.doesNotMatch(await (await f('/?project=open1')).text(), /prow-one/);
});

test('a late item shows "N days late" as a chip on its card, and no screen shows a bare ISO date', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh (by 2026-01-01)' }, ai);
  // The app counts days in the owner's time zone (Europe/Berlin), so the test must too.
  const today = localDay(app.deps.now());
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse('2026-01-01T00:00:00Z')) / DAY);
  assert.match(await (await f('/')).text(), new RegExp(`<span class="chip late"><time class="day" datetime="2026-01-01">${days} days late</time></span>`));
  const page = await app.deps.pages.create({ title: 'Wildlog', project: 'wildlog', body: 'Hello.' }, 'owner');
  for (const path of ['/', '/?project=wildlog', `/pages/${page.id}`, `/pages/${page.id}/history`, '/settings']) {
    const body = (await (await f(path)).text()).replace(/<(pre|code)[\s\S]*?<\/\1>/g, '');
    assert.doesNotMatch(body, />\d{4}-\d\d-\d\d( \d\d:\d\d UTC)?</, path);
  }
});

test('?project=coyote opens inflow\'s panel when coyote is an alias, and an unknown ?project shows the home without a panel', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'summary', content: 'inflow status: season row looks good', project: 'inflow' }, ai);
  app.deps.service.addAlias('coyote', 'inflow', owner);
  const panel = await (await f('/?project=coyote')).text();
  assert.match(panel, /<h2 id="panel-title">inflow<\/h2>/);
  assert.match(panel, /season row looks good/);
  const none = await f('/?project=nothing-here');
  assert.equal(none.status, 200);
  assert.doesNotMatch(await none.text(), /id="panel"/);
});

test('idea text and one-liners are escaped, and an idea opens its panel', async (t) => {
  const { f } = await start(t);
  const res = await post(f, '/projects/ideas', { text: 'x <script>alert(1)</script>' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/?project=x-script-alert-1-script#panel');
  const page = await (await f('/?project=x-script-alert-1-script')).text();
  assert.match(page, /x &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /<script>alert/);
  const bad = await post(f, '/projects/ideas', { text: '¿¡!?' });
  assert.equal(bad.status, 400);
});

test('the panel shows Continue in Claude Code with the folder when set, otherwise the name', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('gps-tracklog', { state: 'open' }, 'owner');
  assert.match(await (await f('/?project=gps-tracklog')).text(), /data-copy="cd ~\/Projects\/gps-tracklog &amp;&amp; claude"/);
  assert.equal((await post(f, '/projects/gps-tracklog/info', { oneLiner: 'Karst ride telemetry on iPhone', area: 'apps', folder: 'gps-tracklog-app', url: '' })).status, 303);
  const page = await (await f('/?project=gps-tracklog')).text();
  assert.match(page, /data-copy="cd ~\/Projects\/gps-tracklog-app &amp;&amp; claude"/);
  assert.match(page, /<li>Karst ride telemetry on iPhone<\/li><li><span class="ring a-apps" aria-hidden="true"><\/span> Apps<\/li>/);
});

test('the panel\'s Edit details sets Runs on, comma-separated', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('wildlog', { state: 'open' }, 'owner');
  const fields = { oneLiner: 'Wine cellar', area: 'apps', folder: '', url: '' };
  assert.equal((await post(f, '/projects/wildlog/info', { ...fields, runsOn: 'Mini PC, pi' })).status, 303);
  assert.deepEqual(app.deps.registry.get('wildlog')!.runsOn, ['mini-pc', 'pi']);
  assert.match(await (await f('/?project=wildlog')).text(), /<input name="runsOn" maxlength="120" placeholder="minipc, pi" value="mini-pc, pi">/);
  const bad = await post(f, '/projects/wildlog/info', { ...fields, runsOn: 'a, b, c, d, e' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /At most 4 places/);
  assert.deepEqual(app.deps.registry.get('wildlog')!.runsOn, ['mini-pc', 'pi']);
});

test('the approval row in For you opens the card in place when one suggestion is pending', async (t) => {
  const { app, f } = await start(t);
  assert.doesNotMatch(await (await f('/')).text(), /for your approval/);
  await app.deps.service.remember({ kind: 'profile', content: 'Has a Synology NAS' }, ai);
  assert.match(await (await f('/')).text(), /<details class="fy-approval"><summary class="row"><span class="dot"[^>]*><\/span><span class="txt"><b>Claude Code<\/b> suggests adding to your profile<\/span>/);
});

test('a long status is cut in the panel, with the whole text behind "Read all"', async (t) => {
  const { app, f } = await start(t);
  const long = `gps-tracklog status: ${'the DIY GPS case draft has many careful parts '.repeat(12)}END-MARKER`;
  await app.deps.service.remember({ kind: 'summary', content: long, project: 'gps-tracklog' }, ai);
  const page = await (await f('/?project=gps-tracklog')).text();
  assert.match(page, /<details class="leftoff-more"><summary><span class="leftoff">gps-tracklog status: [^<]*…<\/span><span class="read-all">Read all<\/span><\/summary>/);
  assert.match(page, /END-MARKER<\/p><\/details>/);
});

test('an action refused while a panel is open shows its message inside the panel too', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 7; i++) app.deps.registry.create(`p${i}`, { state: 'open', oneLiner: `P${i}` }, 'owner');
  for (let i = 0; i < 6; i++) await post(f, `/projects/p${i}/pin`);
  const page = await (await post(f, '/projects/p6/pin')).text();
  assert.match(page, /<section id="panel"[\s\S]*On the go holds 6 projects: unpin one first[\s\S]*<\/section>/);
});

test('open discussions waiting on the owner show on the projects home', async (t) => {
  const { app, f } = await start(t);
  assert.doesNotMatch(await (await f('/')).text(), /Waiting on you:/);
  const x = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which course?', question: 'Which course would help most?', ask: ['Grok'] });
  for (const text of ['This one.', 'Still this one.']) app.deps.discussions.reply({ name: 'Grok', model: 'g', access: 'full' }, x.id, { text });
  assert.match(await (await f('/')).text(), new RegExp(`<a class="row" href="/discussions/${x.id}"><span class="dot"[^>]*></span><span class="txt">Waiting on you: <b>Which course\\?</b></span>`));
});

test('owner actions work through an alias, and a state an action cannot set is refused', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'inflow plays from Jellyfin', project: 'inflow' }, ai);
  app.deps.service.addAlias('coyote', 'inflow', owner);
  const res = await post(f, '/projects/coyote/pin');
  assert.equal(res.headers.get('location'), '/?project=inflow#panel');
  assert.ok(app.deps.registry.get('inflow')!.pinnedAt);
  assert.equal((await post(f, '/projects/inflow/state', { state: 'idea' })).status, 400);
  assert.equal(app.deps.registry.get('inflow')!.state, 'open');
});

test('the panel shows the project\'s newest facts, linked, with a row to all of them; and its discussions; all escaped', async (t) => {
  const { app, f } = await start(t);
  const m = (await app.deps.service.remember({ kind: 'decision', content: 'Laps use <b>GPS</b> at 10 Hz', project: 'gps-tracklog' }, ai) as any).memory;
  const dsc = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which <i>GPS</i> module?', question: 'Which one?', project: 'gps-tracklog', ask: ['Grok'] });
  const page = await (await f('/?project=gps-tracklog')).text();
  assert.match(page, /<h3 id="p-facts">Facts <span class="n">1<\/span><\/h3>/);
  assert.match(page, new RegExp(`<a href="/memories/${m.id}\\?from=%2F%3Fproject%3Dgps-tracklog">Laps use &lt;b&gt;GPS&lt;/b&gt; at 10 Hz</a>`));
  assert.match(page, /<a class="row nolead" href="\/facts\?project=gps-tracklog"><span class="txt">All 1 gps-tracklog facts<\/span><span class="chev"><\/span><\/a>/);
  assert.match(page, /<h3 id="p-discussions">Discussions<\/h3>/);
  assert.match(page, new RegExp(`<a href="/discussions/${dsc.id}">Which &lt;i&gt;GPS&lt;/i&gt; module\\?</a>`));
});

test('the panel lists closed discussions too, and Settings links to none of them', async (t) => {
  const { app, f } = await start(t);
  const dsc = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which GPS module?', question: 'Which one?', project: 'gps-tracklog', ask: ['Grok'] });
  await app.deps.discussions.close('owner', dsc.id, { decision: 'The u-blox one' });
  await app.deps.service.remember({ kind: 'decision', content: 'Laps use GPS at 10 Hz', project: 'gps-tracklog' }, ai);
  assert.equal(app.deps.discussions.openCount(), 0);
  const page = await (await f('/?project=gps-tracklog')).text();
  assert.match(page, /<h3 id="p-discussions">Discussions<\/h3>[\s\S]*Which GPS module\?/);
  assert.doesNotMatch(page, /<p class="more-link">/, 'the panel\'s trailing links are rows now');
  assert.doesNotMatch(await (await f('/settings')).text(), /href="\/discussions"/);
});

test('a discussion filed under an alias shows in its project\'s panel', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'inflow plays from Jellyfin', project: 'inflow' }, ai);
  app.deps.service.addAlias('coyote', 'inflow', owner);
  app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which subtitle engine?', question: 'Which?', project: 'coyote', ask: ['Grok'] });
  assert.match(await (await f('/?project=inflow')).text(), /Which subtitle engine\?/);
});

test('a stale tick sent from a review returns to it with error=changed, a full roadmap with error=failed', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh; connect ChatGPT' }, ai);
  const stale = await post(f, '/projects/wildlog/waiting/0/done', { text: 'an old text', back: '/review' });
  assert.equal(stale.status, 303);
  assert.equal(stale.headers.get('location'), '/review?error=changed');
  const gone = await post(f, '/projects/nosuch/waiting/0/done', { text: 'x', back: '/review/now' });
  assert.equal(gone.headers.get('location'), '/review/now?error=changed');

  const items = Array.from({ length: 40 }, (_, i) => `waiting item number ${String(i).padStart(2, '0')} to do`);
  let content = `Now: going\nWaiting on you: ${items.join('; ')}`;
  while (content.length > 1500) { items.pop(); content = `Now: going\nWaiting on you: ${items.join('; ')}`; }
  content = content.replace('Now: going', `Now: going${' on'.repeat(Math.floor((1500 - content.length) / 3))}`);
  await app.deps.service.remember({ kind: 'roadmap', project: 'dossiers', content }, ai);
  const full = await post(f, '/projects/dossiers/waiting/0/done', { text: items[0]!, back: '/review' });
  assert.equal(full.headers.get('location'), '/review?error=failed');

  const evil = await post(f, '/projects/wildlog/waiting/0/done', { text: 'an old text', back: '//evil.example' });
  assert.equal(evil.status, 400);
  assert.match(await evil.text(), /This list changed: reload/);
});

test('Park it and Keep open from a review return to it', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('energy', { state: 'open' }, 'owner');
  const park = await post(f, '/projects/energy/state', { state: 'parked', back: '/review/now' });
  assert.equal(park.status, 303);
  assert.equal(park.headers.get('location'), '/review/now');
  assert.equal(app.deps.registry.get('energy')!.state, 'parked');
  const keep = await post(f, '/projects/energy/snooze', { back: '/review' });
  assert.equal(keep.headers.get('location'), '/review');
});

// ---- The Monday line (weekly review) ----

async function monday(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}, end?: string) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z'), ...opts });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance, end);
  return { app, f: await loggedIn(app) };
}
const LINE = '<b>Last week</b>, 26 Oct – 1 Nov: 3 steps done, all in wildlog. 1 thing is late, and energy went quiet.';

test('on Monday the Last week row sits in For you, after the idea field, and keeps its two POSTs', async (t) => {
  const { app, f } = await monday(t);
  const x = app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which course?', question: 'Which one?', ask: ['Grok'] });
  for (const text of ['This one.', 'Still this one.']) app.deps.discussions.reply({ name: 'Grok', model: 'g', access: 'full' }, x.id, { text });
  const body = await (await f('/')).text();
  const card = body.indexOf('<ul class="group foryou"');
  assert.ok(card > body.indexOf('class="idea"'), 'For you comes after the idea field');
  assert.ok(body.indexOf('Waiting on you:') > card && body.indexOf('Waiting on you:') < body.indexOf('fy-week'), 'discussions before Last week');
  assert.ok(body.includes(LINE), 'the sentence without its lead');
  assert.match(body, /<form method="post" action="\/review\/2026-10-26\/open" class="fy-read"><button type="submit" class="row"><span class="dot muted"/);
  assert.match(body, /<form method="post" action="\/review\/2026-10-26\/dismiss" class="fy-not"><button type="submit" class="ghost sm">Not now<\/button><\/form>/);
});

test('a backup warning is the one banner, above the idea field, with Look; the Last week row waits behind it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warned = await monday(t, { statusDir: dir });
  writeBackupStatus(dir, 'nightly', { at: warned.app.deps.now().toISOString(), ok: false, error: 'disk full' });
  const body = await (await warned.f('/')).text();
  const banner = body.indexOf('class="banner warn"');
  assert.ok(banner > 0 && banner < body.indexOf('class="idea"'));
  assert.match(body.slice(banner), /^class="banner warn"><span class="dot attention" aria-hidden="true"><\/span><span class="txt">[^<]+<\/span><a class="button sm" href="\/settings#health">Look<\/a>/);
  assert.doesNotMatch(body, /fy-week|Last week<\/b>/);
});

test('the line hides once read, once dismissed, for an empty week and behind a backup warning', async (t) => {
  const read = await monday(t);
  assert.match(await (await read.f('/')).text(), /fy-week/);
  assert.equal((await post(read.f, '/review/2026-10-26/open')).status, 303);
  assert.doesNotMatch(await (await read.f('/')).text(), /fy-week/);

  const dismissed = await monday(t);
  assert.match(await (await dismissed.f('/')).text(), /fy-week/);
  await post(dismissed.f, '/review/2026-10-26/dismiss');
  assert.doesNotMatch(await (await dismissed.f('/')).text(), /fy-week/);

  const quiet = await startTestApp({ startAt: new Date('2026-10-05T08:00:00Z') });
  t.after(() => quiet.close());
  await quiet.deps.service.remember({ kind: 'decision', content: 'a first fact', project: 'wildlog', newProject: true }, ai);
  clockTo(quiet.deps, quiet.advance, '2026-10-20T08:00:00Z');
  const qf = await loggedIn(quiet);
  const qbody = await (await qf('/')).text();
  assert.equal(quiet.deps.reviews.present(quiet.deps.reviews.ensure('2026-10-12', 'owner')!, 'last', { kind: 'owner' }).empty, true);
  assert.doesNotMatch(qbody, /fy-week/);

  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const warned = await monday(t, { statusDir: dir });
  writeBackupStatus(dir, 'nightly', { at: warned.app.deps.now().toISOString(), ok: false, error: 'disk full' });
  const wbody = await (await warned.f('/')).text();
  assert.match(wbody, /class="banner warn"/);
  assert.doesNotMatch(wbody, /fy-week/);
});

test('while the line shows, the park-it suggestion for a project that went quiet is held back, and comes back once the line is gone', async (t) => {
  const { f } = await monday(t, {}, '2026-11-08T12:00:00Z');
  const before = await (await f('/')).text();
  assert.match(before, /fy-week/);
  assert.doesNotMatch(before, /<b>energy<\/b> has been quiet for 3 weeks: park it\?/);
  await post(f, '/review/2026-10-26/dismiss');
  assert.match(await (await f('/')).text(), /<b>energy<\/b> has been quiet for 3 weeks: park it\?/);
});

test('the line never names a life area', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  clockTo(app.deps, app.advance, '2026-10-18T10:00:00Z');
  await app.deps.service.remember({ kind: 'decision', content: 'finances keeps a budget', project: 'finances', newProject: true }, ai);
  await app.deps.service.remember({ kind: 'roadmap', project: 'health', newProject: true, content: 'Done: a (2026-10-27); b (2026-10-28); c (2026-10-29); d (2026-10-30)\nNow: cleanups' }, ai);
  app.deps.registry.setInfo('finances', { area: 'personal' }, 'owner');
  app.deps.registry.setInfo('health', { area: 'personal' }, 'owner');
  clockTo(app.deps, app.advance, '2026-11-03T07:14:00Z');
  const f = await loggedIn(app);
  const body = await (await f('/')).text();
  const line = body.slice(body.indexOf('fy-week'), body.indexOf('</div>', body.indexOf('fy-week')));
  assert.match(line, /<b>Last week<\/b>, 26 Oct – 1 Nov: 4 steps done\.<\/span>/);
  assert.doesNotMatch(line, /finances|health/);
});

test('loading Projects builds last week if it isn\'t stored yet', async (t) => {
  const { app, f } = await monday(t);
  assert.deepEqual((app.deps.reviews as unknown as { deps: ReviewDeps }).deps.store.mondays(), []);
  await f('/');
  assert.deepEqual((app.deps.reviews as unknown as { deps: ReviewDeps }).deps.store.mondays(), ['2026-10-26']);
});

test('a review build that fails never takes Projects down', async (t) => {
  const { app, f } = await monday(t);
  const deps = (app.deps.reviews as unknown as { deps: ReviewDeps }).deps;
  const broken: FolderSource = { match: () => { throw new Error('report unreadable'); } };
  app.deps.reviews = new ReviewService({ ...deps, folders: broken }, app.deps.now, () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const res = await f('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.doesNotMatch(body, /fy-week/);
  assert.match(body, /wildlog/);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /^weekly review 2026-10-26 failed: /);
  assert.deepEqual(deps.store.mondays(), []);
});

test('the folds sit in one grouped card whose last row is All discussions', async (t) => {
  const { f } = await start(t);
  const body = await (await f('/')).text();
  const folds = body.slice(body.indexOf('<ul class="group pfolds">'), body.indexOf('</ul>', body.indexOf('<ul class="group pfolds"')) + 5);
  assert.ok(folds.endsWith('<li><a class="row nolead" href="/discussions"><span class="txt"><b>All discussions</b></span><span class="chev"></span></a><a class="shelf-more" href="/discussions" hidden>Open<span class="chev"></span></a></li></ul>'), folds.slice(-200));
  assert.doesNotMatch(folds, /All weekly reviews/, 'Week holds the reviews now');
});

test('On the go cards carry one chip and a ring · area · when footer; Also open is one grouped list', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('a1', { state: 'open', oneLiner: 'Project a1', area: 'apps' }, 'owner');
  app.deps.registry.pin('a1', 'owner');
  app.deps.registry.create('b1', { state: 'open', oneLiner: 'Project b1' }, 'owner');
  await app.deps.service.remember({ kind: 'roadmap', project: 'a1', content: 'Now: x\nNext: ship it\nWaiting on you: one (by 2020-01-01); two' }, ai);
  const body = await (await f('/')).text();
  const card = body.slice(body.indexOf('class="pcard'), body.indexOf('</a>', body.indexOf('class="pcard')));
  assert.equal((card.match(/class="chip/g) ?? []).length, 1);
  assert.match(card, /<div class="pcard-foot"><span class="ring a-apps" aria-hidden="true"><\/span><ul class="meta-line"><li>Apps<\/li><li>[^<]+<\/li><\/ul><\/div>/);
  assert.match(body, /<ul class="group prows">[\s\S]*prow-name">b1</);
});

async function panelFixture(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  await app.deps.service.remember({ kind: 'summary', project: 'wildlog', content: 'wildlog status: the release is close.' }, ai);
  await app.deps.service.remember({ kind: 'decision', project: 'wildlog', content: 'wildlog keeps the cellar in SQLite' }, ai);
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The wine cellar app.\n\n## Stack\nSwiftUI.' }, 'owner');
  return { app, f: await loggedIn(app), page };
}

test('a project reads first and ends with Manage', async (t) => {
  const { app, f } = await panelFixture(t);
  await app.deps.service.remember({ kind: 'decision', project: 'wildlog', content: 'wildlog: labels print at 300 dpi' }, { type: 'owner' });
  const body = await (await f('/?project=wildlog')).text();
  const at = (s: string) => body.indexOf(s);
  const order = ['id="panel-title"', '<ul class="meta-line', '<nav class="jump" aria-label="In this project">',
    'Where you left off', 'id="p-waiting">Waiting on you', '<h3>Then</h3>', 'id="p-pages">Pages',
    'id="p-facts">Facts', 'All 4 wildlog facts', 'See wildlog in the graph', '<details class="fold manage">'];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]!) >= 0 && at(order[i]!) > at(order[i - 1]!), `${order[i - 1]} comes before ${order[i]}`);
  const manage = body.slice(at('<details class="fold manage">'), body.indexOf('</section>', at('<details class="fold manage">')));
  for (const b of ['Park', 'Mark done', 'Where it lives', 'Edit details', 'New page', 'Add a fact', 'Continue in Claude Code']) assert.match(manage, new RegExp(b));
  assert.match(manage, /class="[^"]*\bdanger\b[^"]*">Archive</);
  assert.match(manage, /<a class="row nolead" href="\/pages\/new\?project=wildlog"><span class="txt">New page<\/span><span class="chev"><\/span><\/a>/);
  assert.match(manage, /<a class="row nolead" href="\/memories\/new\?project=wildlog"><span class="txt">Add a fact<\/span><span class="chev"><\/span><\/a>/);
  assert.match(manage, /<button type="button" class="continue secondary" data-copy="cd ~\/Projects\/wildlog &amp;&amp; claude">Continue in Claude Code<code>/);
  assert.doesNotMatch(body.slice(at('id="panel"'), body.indexOf('</section>', at('id="panel"'))), /→/);
  assert.doesNotMatch(body.slice(at('id="panel"')), /\bprimary\b/);
  // After the r2-superseded merge: each fact is a plain-list row, its text then a meta line with the time in words
  // (full date on hover); with nothing replaced, the facts row follows at once (the Replaced fold's slot).
  assert.match(body, /<ul class="pfacts plain-list"><li><a href="\/memories\/[^"]+">[^<]+<\/a><ul class="meta-line"><li><span class="writer w-[^"]+">[^<]+<\/span><\/li><li><time datetime="[^"]+" title="[^"]+">[^<]+<\/time><\/li><\/ul><\/li>[\s\S]*?<\/ul>\s*<a class="row nolead" href="\/facts\?project=wildlog">/);
  // The panel already names the project, so a leading "wildlog status:" is not said twice.
  assert.match(body, /<ul class="pfacts plain-list"><li><a href="\/memories\/[^"]+">labels print at 300 dpi<\/a>/);
});

test('the jump row counts what the project has, and leaves out zeros', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('wildlog', { state: 'open' }, 'owner');
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh (by 2020-01-01)' }, ai);
  for (const c of ['wildlog uses SwiftUI', 'wildlog keeps the cellar in SQLite', 'wildlog labels print at 300 dpi']) {
    await app.deps.service.remember({ kind: 'decision', project: 'wildlog', content: c }, ai);
  }
  app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Which icon?', question: 'Which?', project: 'wildlog', ask: ['Grok'] });
  const body = await (await f('/?project=wildlog')).text();
  const jump = body.slice(body.indexOf('<nav class="jump"'), body.indexOf('</nav>', body.indexOf('<nav class="jump"')));
  assert.match(jump, /<a href="#p-waiting">Waiting 1<\/a>/);
  assert.match(jump, /<a href="#p-discussions">Discussions 1<\/a>/);
  assert.match(jump, /<a href="#p-facts">Facts 3<\/a>/);
  assert.doesNotMatch(jump, /Pages/, 'a count of 0 drops its chip');
  assert.ok(jump.indexOf('#p-waiting') < jump.indexOf('#p-discussions') && jump.indexOf('#p-discussions') < jump.indexOf('#p-facts'));
  await app.deps.service.remember({ kind: 'decision', content: 'vpn uses WireGuard', project: 'vpn', newProject: true }, ai);
  app.deps.registry.create('nothing-here', { state: 'open' }, 'owner');
  assert.doesNotMatch(await (await f('/?project=nothing-here')).text(), /class="jump"/, 'no nav when all four are 0');
});

test('the Replaced fold adds nothing to the Facts count, and is absent when nothing was replaced', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const save = async (content: string) => { app.advance(60_000); return ((await s.remember({ kind: 'decision', content, project: 'wildlog', newProject: true }, owner)) as any).memory.id as string; };
  const olds = [await save('wildlog old way 0 for the cellar'), await save('wildlog old way 1 for the cellar')];
  const n0 = await save('wildlog new way 0 for the cellar');
  const n1 = await save('wildlog new way 1 for the cellar');
  s.supersede([olds[0]!], n0, owner);
  s.supersede([olds[1]!], n1, owner);
  const body = await (await f('/?project=wildlog')).text();
  assert.match(body, /<a href="#p-facts">Facts 2<\/a>/);
  assert.match(body, /<h3 id="p-facts">Facts <span class="n">2<\/span><\/h3>/);
  assert.match(body, /Replaced <span class="n">2<\/span>/);
  await app.deps.service.remember({ kind: 'decision', content: 'minipc runs restic', project: 'minipc', newProject: true }, owner);
  assert.doesNotMatch(await (await f('/?project=minipc')).text(), /Replaced <span class="n">/);
});

test('an empty Waiting section is left out of the panel', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'vpn uses WireGuard', project: 'vpn', newProject: true }, ai);
  const body = await (await f('/?project=vpn')).text();
  assert.doesNotMatch(body, /Nothing waiting on you\./);
  assert.doesNotMatch(body, /<h3>Waiting on you/);
});

test('every tick row holds one control, the check', async (t) => {
  const { f, page } = await panelFixture(t);
  for (const path of ['/?project=wildlog', `/pages/${page.id}`, '/review']) {
    const html = await (await f(path)).text();
    const rows = html.match(/<li>(?:(?!<\/li>)[\s\S])*class="check"[\s\S]*?<\/li>/g) ?? [];
    assert.ok(rows.length > 0, path);
    for (const li of rows) assert.equal((li.match(/<(a|button|input(?![^>]*type="hidden")|select|textarea)\b/g) ?? []).length, 1, `${path}: ${li}`);
  }
});

test('Done today holds no check button, so nothing covers its Undo', async (t) => {
  const { app, f } = await start(t);
  await app.deps.service.remember({ kind: 'roadmap', project: 'wildlog', content: 'Now: release\nWaiting on you: run release.sh; connect ChatGPT' }, ai);
  await post(f, '/projects/wildlog/waiting/1/done', { text: 'connect ChatGPT' });
  const body = await (await f('/?project=wildlog')).text();
  const done = body.slice(body.indexOf('<ul class="checks done">'), body.indexOf('</ul>', body.indexOf('<ul class="checks done">')));
  assert.match(done, /<span class="check is-done"/); assert.match(done, /Undo/);
  assert.doesNotMatch(done, /<button[^>]*class="check"/, 'Done today holds no check button, so nothing covers Undo');
});

test('the panel tags a fact that replaced others and folds the replaced ones', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const save = async (content: string) => { app.advance(60_000); return ((await s.remember({ kind: 'decision', content, project: 'wildlog', newProject: true }, owner)) as any).memory.id as string; };
  const olds: string[] = [];
  const news: string[] = [];
  for (let i = 0; i < 4; i++) { olds.push(await save(`wildlog old way ${i} for the cellar`)); }
  for (let i = 0; i < 4; i++) { const n = await save(`wildlog new way ${i} for the cellar`); news.push(n); s.supersede([olds[i]!], n, owner); }
  const end = await save('wildlog newest way for the cellar');
  s.supersede([news[0]!], end, owner);
  let panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, new RegExp(`<a href="/memories/${end}\\?from=%2F%3Fproject%3Dwildlog">wildlog newest way for the cellar<span class="tag-replaces">replaces 1</span></a>`));
  assert.match(panel, /<details class="pfold"><summary>Replaced <span class="n">5<\/span><span class="chev"><\/span><\/summary>/);
  const row = panel.slice(panel.indexOf(`<div class="old">wildlog old way 0`));
  assert.match(row, new RegExp(`^<div class="old">wildlog old way 0 for the cellar</div>\\s*<div class="now"><b>NOW</b><a href="/memories/${end}\\?from=%2F%3Fproject%3Dwildlog">wildlog newest way for the cellar</a></div>`));
  assert.match(row, new RegExp(`Replaced by <span class="writer w-you">You</span> · [^<]+ · <a href="/memories/${olds[0]}\\?from=%2F%3Fproject%3Dwildlog">2 steps to now, see the timeline</a>`));
  assert.match(row, /<form method="post" action="\/supersessions\/\d+\/undo"><input type="hidden" name="back" value="panel"><button type="submit" class="secondary">Undo<\/button><\/form>/);
  for (let i = 0; i < 7; i++) { const o = await save(`wildlog shelf rule ${i}`); const n = await save(`wildlog shelf rule ${i} revised`); s.supersede([o], n, owner); }
  panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, /<a href="\/facts\?project=wildlog&amp;show=replaced">All 12 replaced facts<\/a>/);
  assert.equal((panel.match(/<div class="old">/g) ?? []).length, 10);
  await s.remember({ kind: 'decision', content: 'minipc runs restic', project: 'minipc', newProject: true }, owner);
  assert.doesNotMatch(await (await f('/?project=minipc')).text(), /Replaced <span class="n">/);
  const home = await (await f('/')).text();
  assert.doesNotMatch(home, /replaced/i);
});

test('a fold row whose replacement was deleted says so in place of NOW, and keeps Undo', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const a = ((await s.remember({ kind: 'decision', content: 'homeassistant heating follows Hive', project: 'homeassistant', newProject: true }, owner)) as any).memory.id;
  const b = ((await s.remember({ kind: 'decision', content: 'homeassistant heating follows Ecobee', project: 'homeassistant', supersedes: [a] }, owner)) as any).memory.id;
  s.forget(b, owner);
  const panel = await (await f('/?project=homeassistant')).text();
  assert.match(panel, new RegExp(`<div class="now"><a href="/memories/${b}\\?from=%2F%3Fproject%3Dhomeassistant">Its replacement was deleted on [^<]+\\.</a></div>`));
  assert.match(panel, /value="panel"><button type="submit" class="secondary">Undo<\/button>/);
});

test('a project whose only live fact is replaced still shows on the home after its replacement is deleted', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const a = ((await s.remember({ kind: 'decision', content: 'zetaproj keeps the old way', project: 'zetaproj', newProject: true }, owner)) as any).memory.id;
  const b = ((await s.remember({ kind: 'decision', content: 'zetaproj keeps the new way', project: 'zetaproj', supersedes: [a] }, owner)) as any).memory.id;
  s.forget(b, owner);
  assert.match(await (await f('/')).text(), /href="\/\?project=zetaproj#panel"/);
});

test('a fold row\'s NOW line is a short excerpt cut at a word', async (t) => {
  const { app, f } = await start(t);
  const s = app.deps.service;
  const a = ((await s.remember({ kind: 'decision', content: 'Drinking windows come from Cellarium.', project: 'wildlog', newProject: true }, owner)) as any).memory.id;
  const long = 'Drinking windows are set by hand per bottle; the Cellarium import was dropped because its export has no API (2026-10-30).';
  const b = ((await s.remember({ kind: 'decision', content: long, project: 'wildlog', supersedes: [a] }, owner)) as any).memory.id;
  const panel = await (await f('/?project=wildlog')).text();
  assert.match(panel, new RegExp(`<div class="now"><b>NOW</b><a href="/memories/${b}\\?from=%2F%3Fproject%3Dwildlog">Drinking windows are set by hand per bottle…</a></div>`));
});

test('the home carries the desktop hooks, all hidden: the date, a For you heading, and Also open opening wide', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-11-04T09:00:00Z') });
  t.after(() => app.close());
  const f = await loggedIn(app);
  for (let i = 0; i < 9; i++) app.deps.registry.create(`open${String(i).padStart(2, '0')}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  const quiet = await (await f('/')).text();
  assert.match(quiet, /<h1>Projects<span class="phome-date" hidden>Wednesday 4 November<\/span><\/h1>/);
  assert.doesNotMatch(quiet, /class="fy-h"/, 'nothing for you: no heading');
  assert.match(quiet, /<details class="fold more" data-desk-open>/);
  await app.deps.service.remember({ kind: 'profile', content: 'Prefers short answers' }, { type: 'ai', name: 'Grok' });
  const waiting = await (await f('/')).text();
  assert.match(waiting, /<h2 class="fy-h" id="foryou" hidden>For you<\/h2>\s*<ul class="group foryou"/);
});

test('on the plain home each shelf carries, hidden, what the desktop shows at 1920: three names, then "N more" or "Open"', async (t) => {
  const { app, f } = await start(t);
  const reg = app.deps.registry;
  for (let i = 0; i < 3; i++) reg.create(`open${i}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  for (let i = 0; i < 5; i++) { reg.create(`gone${i}`, { state: 'open' }, 'owner'); reg.setState(`gone${i}`, 'done', 'owner'); }
  reg.create('old', { state: 'open' }, 'owner'); reg.setState('old', 'parked', 'owner');
  for (let i = 0; i < 5; i++) app.deps.discussions.open({ name: 'Claude Code', model: 'Opus', access: 'full' }, { title: `Question ${i}?`, question: 'Q?' });
  const { device } = app.deps.devices.create('Mac');
  const folder = (name: string) => ({ name, git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] });
  app.deps.devices.storeReport(device.id, ['loose-a', 'loose-b', 'loose-c', 'loose-d', 'skipped'].map(folder));
  app.deps.devices.ignore('skipped');
  const body = await (await f('/')).text();
  const folds = body.slice(body.indexOf('<ul class="group pfolds">'));
  // A fold: its rows as today, then a link to its first project with the fold open beside it.
  const done = folds.slice(folds.indexOf('>Done<'), folds.indexOf('</details>', folds.indexOf('>Done<')));
  assert.match(done, /<\/ul><a class="shelf-more" href="\/\?project=gone\d#panel" hidden>2 more<span class="chev"><\/span><\/a>$/);
  const parked = folds.slice(folds.indexOf('>Parked<'), folds.indexOf('</details>', folds.indexOf('>Parked<')));
  assert.match(parked, /<a class="shelf-more" href="\/\?project=old#panel" hidden>Open<span class="chev"><\/span><\/a>$/);
  // All discussions: its count, and the first three titles (the Discussions list's order), all hidden; then "2 more".
  assert.match(folds, /<a class="row nolead" href="\/discussions"><span class="txt"><b>All discussions<\/b><span class="n" hidden>5<\/span><\/span><span class="chev"><\/span><\/a><ul class="shelf-names" hidden><li><a href="\/discussions\/[\w-]+">Question \d\?<\/a><\/li><li><a href="\/discussions\/[\w-]+">Question \d\?<\/a><\/li><li><a href="\/discussions\/[\w-]+">Question \d\?<\/a><\/li><\/ul><a class="shelf-more" href="\/discussions" hidden>2 more<span class="chev"><\/span><\/a><\/li>/);
  // Not in the brain yet: the first three folders and "Ignored 1" inside its summary, so any click opens it.
  assert.match(folds, /<summary class="row nolead">Not in the brain yet<span class="n">4<\/span><span class="nib-peek" hidden><span>loose-a<\/span><span>loose-b<\/span><span>loose-c<\/span><span class="nib-peek-more">Ignored 1<span class="chev"><\/span><\/span><\/span><span class="chev"><\/span><\/summary>/);
  // Beside an open project the list has no shelf hooks; All discussions keeps only its hidden count (the list pane's).
  const open = await (await f('/?project=open1')).text();
  assert.doesNotMatch(open, /shelf-more|shelf-names|nib-peek/);
  assert.match(open, /<b>All discussions<\/b><span class="n" hidden>5<\/span><\/span><span class="chev"><\/span><\/a><\/li>/);
});

test('with a project open, the list beside the panel marks only Also open\'s "N more" fold, never a shelf', async (t) => {
  const { app, f } = await start(t);
  for (let i = 0; i < 9; i++) app.deps.registry.create(`open${String(i).padStart(2, '0')}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  const body = await (await f('/?project=open01')).text();
  assert.deepEqual(body.match(/<details[^>]*data-desk-open[^>]*>/g), ['<details class="fold more" data-desk-open>']);
});

test('the home folds open as shelves on a very wide screen; "Not in the brain yet" never does', async (t) => {
  const { app, f } = await start(t);
  const reg = app.deps.registry;
  for (let i = 0; i < 3; i++) reg.create(`open${i}`, { state: 'open', oneLiner: 'a project' }, 'owner');
  reg.create('someday', { state: 'idea' }, 'owner');
  reg.create('old', { state: 'open' }, 'owner'); reg.setState('old', 'parked', 'owner');
  reg.create('fin', { state: 'open', area: 'personal' }, 'owner');
  reg.create('gone', { state: 'open' }, 'owner'); reg.setState('gone', 'done', 'owner');
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'loose-sketches', git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] }]);
  const body = await (await f('/')).text();
  for (const title of ['Ideas', 'Parked', 'Personal', 'Done'])
    assert.match(body, new RegExp(`<details class="fold" data-desk-open="xl"><summary class="row nolead">${title}<`), title);
  assert.match(body, /<details class="fold notinbrain" id="notyet">/);
  assert.match(body, /<h2 class="pf-h" hidden>Everything else<\/h2>\s*<ul class="group pfolds">/);
  const open = await (await f('/?project=open1')).text();
  assert.doesNotMatch(open, /data-desk-open="xl"/);
  assert.match(open, /<details class="fold"><summary class="row nolead">Ideas</);
});

test("the panel's Edit details sets nicknames, comma-separated, and shows a clash", async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('vino-db', { state: 'open' }, 'owner');
  app.deps.registry.create('garden', { state: 'open' }, 'owner');
  const fields = { oneLiner: 'Wine stock', area: 'apps', folder: '', url: '', runsOn: '' };
  assert.equal((await post(f, '/projects/vino-db/info', { ...fields, nicknames: 'cellar app, the cellar' })).status, 303);
  assert.deepEqual(app.deps.registry.get('vino-db')!.nicknames, ['cellar app', 'the cellar']);
  assert.match(await (await f('/?project=vino-db')).text(), /<input name="nicknames" maxlength="340" placeholder="comma-separated" value="cellar app, the cellar">/);
  const bad = await post(f, '/projects/vino-db/info', { ...fields, nicknames: 'Garden' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /already garden&#39;s name or nickname|already garden's name or nickname/);
  assert.deepEqual(app.deps.registry.get('vino-db')!.nicknames, ['cellar app', 'the cellar']);
});
