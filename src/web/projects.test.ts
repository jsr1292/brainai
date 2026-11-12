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

async function panelFixture(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  await app.deps.service.remember({ kind: 'summary', project: 'wildlog', content: 'wildlog status: the release is close.' }, ai);
  await app.deps.service.remember({ kind: 'decision', project: 'wildlog', content: 'wildlog keeps the cellar in SQLite' }, ai);
  const page = await app.deps.pages.create({ title: 'wildlog — wine cellar', project: 'wildlog', body: 'The wine cellar app.\n\n## Stack\nSwiftUI.' }, 'owner');
  return { app, f: await loggedIn(app), page };
}

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

test('the Projects page has one section per area, live projects as tiles with dot, one-liner and next step', async (t) => {
  const { app, f } = await start(t);
  const r = app.deps.registry;
  r.create('larder', { state: 'open', area: 'apps', oneLiner: 'Grapevine, wine cellar app' }, 'owner');
  r.create('brainai', { state: 'open', area: 'tools', oneLiner: 'Shared memory' }, 'owner');
  r.create('home-infra', { state: 'open', area: 'home' }, 'owner');
  r.create('loose', { state: 'open', area: null, oneLiner: 'Not sorted yet' }, 'owner');
  await app.deps.service.remember({ kind: 'roadmap', project: 'larder', content: 'Now: label scanner\nNext: export' }, ai);
  const page = await (await f('/')).text();
  const order = ['pa-apps', 'pa-tools', 'pa-home', 'pa-unsorted'].map((id) => page.indexOf(`id="${id}"`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!)), String(order));
  assert.match(page, /<h2 id="pa-apps"><span class="ring a-apps" aria-hidden="true"><\/span>Apps <span class="n">1<\/span><\/h2>/);
  assert.match(page, /<a class="pcard ptile" href="\/\?project=larder#panel">[\s\S]*?<span class="pdot d-on" role="img" aria-label="being worked on"[\s\S]*?<span class="pcard-name">larder<\/span>[\s\S]*?<span class="pcard-one">Grapevine, wine cellar app<\/span>[\s\S]*?<span class="pcard-line">label scanner<\/span>/);
  assert.doesNotMatch(page, /id="ongo"|id="alsoopen"|On the go|Also open/);
  assert.doesNotMatch(page.slice(page.indexOf('<main')), / style="/);
});

test('quiet, ideas, parked and done fold into one line per area, opening in place to their rows', async (t) => {
  const { app, f } = await start(t);
  const r = app.deps.registry;
  r.create('live', { state: 'open', area: 'apps' }, 'owner');
  r.create('idea1', { state: 'idea', area: 'apps' }, 'owner');
  r.create('parked1', { state: 'parked', area: 'apps' }, 'owner');
  r.create('parked2', { state: 'parked', area: 'apps' }, 'owner');
  r.create('done1', { state: 'done', area: 'apps' }, 'owner');
  r.create('budget', { state: 'open', area: 'personal' }, 'owner');
  r.create('running', { state: 'open', area: 'personal' }, 'owner');
  const page = await (await f('/')).text();
  const apps = page.slice(page.indexOf('id="pa-apps"'), page.indexOf('</section>', page.indexOf('id="pa-apps"')));
  assert.match(apps, /<summary class="row nolead">1 idea · 2 parked · 1 done<span class="chev"><\/span><\/summary><ul class="fold-list">/);
  assert.equal((apps.match(/<li><a class="row prow/g) ?? []).length, 4);
  const personal = page.slice(page.indexOf('id="pa-personal"'));
  assert.match(personal, /<summary class="row nolead">Areas of life: (budget, running|running, budget)<span class="chev">/);
  assert.doesNotMatch(personal.slice(0, personal.indexOf('</section>')), /class="pcard ptile"/, 'areas of life are never tiles');
});

test('a pinned personal project is a tile; the pin button says Pin to the top', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('career-site', { state: 'open', area: 'personal' }, 'owner');
  app.deps.registry.pin('career-site', 'owner');
  const page = await (await f('/')).text();
  assert.match(page.slice(page.indexOf('id="pa-personal"')), /class="pcard ptile"[^>]*href="\/\?project=career-site#panel"|href="\/\?project=career-site#panel"[^>]*/);
  assert.match(await (await f('/?project=career-site')).text(), />Unpin</);
});

test('a tile shows the warning when work is not safe, and no not-pushed chip anywhere', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('side-project', { state: 'open', area: 'apps' }, 'owner');
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'side-project', git: false, branch: null, uncommitted: null, unpushed: null, lastCommit: null, remotes: [] }]);
  const page = await (await f('/')).text();
  assert.match(page, /<span class="pcard-name">side-project<\/span><span class="pwarn" role="img" aria-label="Work not safe: not in git"/);
  assert.doesNotMatch(page, /chip plain">not pushed/);
});

test('the list beside a project and the list pane use the same sections as compact rows', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('larder', { state: 'open', area: 'apps' }, 'owner');
  app.deps.registry.create('gpx', { state: 'open', area: 'apps' }, 'owner');
  for (const path of ['/?project=larder', '/?pane=projects']) {
    const page = await (await f(path)).text();
    assert.match(page, /<h2 id="pa-apps">/, path);
    assert.match(page, /<ul class="group prows"><li><a class="row prow/, path);
    assert.doesNotMatch(page, /class="pcard ptile"/, path);
  }
});

test('edge shapes: no projects, only quiet projects in an area, 40 projects in one area, a project with no area', async (t) => {
  const { app, f } = await start(t);
  assert.match(await (await f('/')).text(), /No projects yet/);
  const r = app.deps.registry;
  for (let i = 0; i < 40; i++) r.create(`app${String(i).padStart(2, '0')}`, { state: 'open', area: 'apps', oneLiner: 'A'.repeat(140) }, 'owner');
  r.create('loose', { state: 'open', area: null, oneLiner: 'Not sorted yet' }, 'owner');
  r.create('sleepy', { state: 'parked', area: 'work' }, 'owner');
  const page = await (await f('/')).text();
  assert.equal((page.match(/class="pcard ptile/g) ?? []).length, 41);
  assert.match(page, /<h2 id="pa-unsorted"><span class="ring a-unsorted" aria-hidden="true"><\/span>Unsorted <span class="n">1<\/span><\/h2>/);
  assert.match(page, /<h2 id="pa-work"><span class="ring a-work" aria-hidden="true"><\/span>Work<\/h2>[\s\S]*?1 parked/);
});

test('the panel shows the five areas with notes and the why, and the handbook topics applied on it', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('gpx', { state: 'open', area: 'apps', oneLiner: 'Kart telemetry' }, 'owner');
  app.deps.learning.set('gpx', 'auto', { status: 'done', note: 'tests run on every push (GitHub Actions)' }, 'Claude Code');
  app.deps.learning.recordLesson({ title: 'What CI is', level: 'helped', project: 'gpx' }, 'Claude Code');
  const page = await (await f('/?project=gpx')).text();
  const sec = page.slice(page.indexOf('<h3 id="p-areas">Five areas</h3>'));
  assert.ok(sec.length > 0 && page.includes('<h3 id="p-areas">Five areas</h3>'));
  for (const name of ['Work is safe', 'Clear finish line', 'Runs by itself', 'You&#39;d know if it broke', 'Kept up to date']) assert.ok(sec.includes(name), name);
  assert.match(sec, /Runs by itself[\s\S]*?CI\/CD, automation[\s\S]*?tests run on every push \(GitHub Actions\)/);
  assert.match(sec, /<summary>Why<span class="chev"><\/span><\/summary>[\s\S]*?Tests \(and for apps, the build or deploy\) run by themselves/);
  assert.match(sec, /<h3[^>]*>Handbook<\/h3>[\s\S]*?What CI is/);
});

test('the owner sets an area from the panel and it shows at once; not needed without a reason is refused', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('gpx', { state: 'open', area: 'apps' }, 'owner');
  const ok = await post(f, '/projects/gpx/areas/finish', { status: 'done', note: 'v1 is auto-record' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/?project=gpx#p-areas');
  const a = app.deps.learning.areas('gpx')!.find((x) => x.area === 'finish')!;
  assert.deepEqual([a.status, a.note, a.setBy], ['done', 'v1 is auto-record', 'owner']);
  assert.match(await (await f('/?project=gpx')).text(), /v1 is auto-record/);
  const bad = await post(f, '/projects/gpx/areas/alerts', { status: 'not_needed', note: '' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /reason/);
  assert.equal((await post(f, '/projects/gpx/areas/nonsense', { status: 'done' })).status, 400);
});

test('an idea\'s panel has no five areas section', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('someday', { state: 'idea', area: 'apps', oneLiner: 'Maybe later' }, 'owner');
  assert.doesNotMatch(await (await f('/?project=someday')).text(), /id="p-areas"/);
});

test('review I4: a row keeps the work-not-safe mark next to a waiting chip', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('pizza', { state: 'open', area: 'apps' }, 'owner');
  app.deps.registry.create('other', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.service.remember({ kind: 'roadmap', project: 'pizza', content: 'Now: menu\nWaiting on you: pick a logo' }, ai);
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'pizza', git: false, branch: null, uncommitted: null, unpushed: null, lastCommit: null, remotes: [] }]);
  const page = await (await f('/?project=other')).text();
  const row = page.slice(page.indexOf('<span class="prow-name">pizza</span>'), page.indexOf('</a>', page.indexOf('<span class="prow-name">pizza</span>')));
  assert.match(row, /1 for you<\/span>[\s\S]*<span class="pwarn"/);
});

test('review M1 and M3: a snooze shows its date; the owner form makes you choose a status', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('gpx', { state: 'open', area: 'apps' }, 'owner');
  app.deps.learning.notNow('gpx', 'finish', 'Claude Code');
  const page = await (await f('/?project=gpx')).text();
  assert.match(page, /not now until (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+/);
  assert.doesNotMatch(page, /not now until just now/);
  assert.match(page, /<select name="status" required><option value="" disabled selected>Choose…<\/option>/);
});
