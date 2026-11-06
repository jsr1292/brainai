import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connectClient, loggedIn, startTestApp } from '../testing/helpers.js';

const owner = { type: 'owner' } as const;
const DAY = 86_400_000;
const XSS = '"><img src=x onerror=alert(1)>';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return app;
}

const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });
const remember = async (app: Awaited<ReturnType<typeof start>>, content: string, kind: 'decision' | 'profile' | 'summary' = 'decision', project?: string) => {
  const r = await app.deps.service.remember({ kind, content, project }, owner);
  assert.equal(r.status, 'saved');
  return (r as any).memory as { id: string };
};

test('create, edit and undo through the dashboard', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const created = await f('/memories', form({ kind: 'decision', content: 'Use Postgres', project: 'demo', tags: 'db, sql' }));
  assert.equal(created.status, 303);
  const path = created.headers.get('location')!;
  assert.match(path, /^\/memories\/[0-9a-f-]+$/);
  const id = path.split('/').pop()!;
  assert.deepEqual(app.deps.store.get(id)!.tags, ['db', 'sql']);

  assert.equal((await f(path, form({ content: 'Use SQLite', project: 'demo', tags: 'db' }))).status, 303);
  assert.equal((await f(path, form({ content: 'Use DuckDB', project: 'demo', tags: 'db' }))).status, 303);
  let body = await (await f(path)).text();
  assert.match(body, /Use DuckDB/);
  assert.match(body, /Use Postgres/);
  assert.match(body, /Use SQLite/);

  const history = app.deps.store.history(id);
  assert.equal(history.length, 2);
  const original = history.find((h) => h.content === 'Use Postgres')!;
  const undo = await f(`/history/${original.id}/undo`, { method: 'POST' });
  assert.equal(undo.status, 303);
  assert.equal(undo.headers.get('location'), path);
  body = await (await f(path)).text();
  assert.match(body, /<textarea[^>]*>Use Postgres<\/textarea>/);
  assert.match(body, /Undo to this/);
  assert.equal(app.deps.store.history(id).length, 3);
});

test('profile memories created by the owner take effect immediately', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  assert.equal((await f('/memories', form({ kind: 'profile', content: 'Lives in Berlin' }))).status, 303);
  assert.deepEqual(app.deps.service.loadProfile().map((m) => m.content), ['Lives in Berlin']);
});

test('delete from the memory page; the memory can be restored from history', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const m = await remember(app, 'Temporary fact');
  assert.equal((await f(`/memories/${m.id}/delete`, { method: 'POST' })).status, 303);
  assert.ok(app.deps.store.get(m.id)!.deletedAt);
  const body = await (await f(`/memories/${m.id}`)).text();
  assert.match(body, /Deleted/);
  const h = app.deps.store.history(m.id)[0]!;
  assert.equal((await f(`/history/${h.id}/undo`, { method: 'POST' })).status, 303);
  assert.equal(app.deps.store.get(m.id)!.deletedAt, null);
});

test('search finds a memory by keyword; browse filters by kind and project, and pages by 50', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'NAS Synology', 'decision', 'home');
  await remember(app, 'Something unrelated about cooking', 'summary', 'kitchen');
  const found = await (await f('/facts?q=nas')).text();
  assert.match(found, /NAS Synology/);
  const byKind = await (await f('/facts?kind=summary')).text();
  assert.match(byKind, /cooking/);
  assert.doesNotMatch(byKind, /NAS Synology/);
  const byProject = await (await f('/facts?project=home')).text();
  assert.match(byProject, /NAS Synology/);
  assert.doesNotMatch(byProject, /cooking/);
  for (let i = 0; i < 52; i++) await remember(app, `Filler number ${i}`, 'summary', 'bulk');
  const p1 = await (await f('/facts?project=bulk')).text();
  assert.equal(p1.match(/class="card"/g)!.length, 50);
  assert.match(p1, /page=2/);
  const p2 = await (await f('/facts?project=bulk&page=2')).text();
  assert.equal(p2.match(/class="card"/g)!.length, 2);
});

test('XSS: memory content is escaped on every page', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const a = await remember(app, XSS, 'summary', 'xss');
  await remember(app, XSS, 'summary', 'xss');
  await app.deps.service.update(a.id, { content: XSS + ' edited' }, owner);
  for (const path of ['/?project=xss', '/review/now', '/facts', `/memories/${a.id}`, '/facts?q=img', '/facts?project=xss']) {
    const body = await (await f(path)).text();
    assert.doesNotMatch(body, /<img src=x/, path);
    assert.match(body, /&lt;img src=x/, path);
  }
});

test('XSS: client names and user agents are escaped on /clients', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app, { userAgent: XSS });
  await connectClient(app.baseUrl, f, '<script>alert(1)</script>');
  const body = await (await f('/settings')).text();
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;img src=x/);
});

test('duplicates: keep both hides the pair; merge leaves one active', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const a = await remember(app, 'Prefers dark mode');
  const b = await remember(app, 'Prefers dark mode');
  let body = await (await f('/facts/tidy')).text();
  assert.match(body, /Possible duplicates/);
  assert.match(body, /Keep both/);
  assert.match(body, /Keep this one/);
  const kept = await f('/duplicates/keep-both', form({ a: b.id, b: a.id }));
  assert.equal(kept.status, 303);
  assert.equal(kept.headers.get('location'), '/facts/tidy');
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Keep both/);

  const c = await remember(app, 'Uses tabs');
  const d = await remember(app, 'Uses tabs');
  assert.match(await (await f('/facts/tidy')).text(), /Keep both/);
  const merged = await f('/duplicates/merge', form({ keep: c.id, drop: d.id }));
  assert.equal(merged.status, 303);
  assert.equal(merged.headers.get('location'), '/facts/tidy');
  assert.equal(app.deps.store.get(c.id)!.deletedAt, null);
  assert.ok(app.deps.store.get(d.id)!.deletedAt);
  assert.doesNotMatch(await (await f('/facts/tidy')).text(), /Keep both/);
});

test('merge can keep the older memory', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const older = await remember(app, 'Same thing');
  app.advance(60_000);
  const newer = await remember(app, 'Same thing');
  const body = await (await f('/facts/tidy')).text();
  assert.equal(body.match(/>Keep this one</g)!.length, 2);
  assert.match(body, new RegExp(`name="keep" value="${older.id}"><input type="hidden" name="drop" value="${newer.id}"`));
  assert.equal((await f('/duplicates/merge', form({ keep: older.id, drop: newer.id }))).status, 303);
  assert.equal(app.deps.store.get(older.id)!.deletedAt, null);
  assert.ok(app.deps.store.get(newer.id)!.deletedAt);
});

test('duplicate actions reject unknown or invalid ids instead of failing', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const a = await remember(app, 'Real one');
  assert.equal((await f('/duplicates/merge', form({ keep: a.id, drop: 'nope' }))).status, 404);
  assert.equal((await f('/duplicates/merge', form({ keep: 'nope', drop: a.id }))).status, 404);
  assert.equal((await f('/duplicates/merge', form({ keep: a.id, drop: a.id }))).status, 400);
  assert.equal((await f('/duplicates/merge', form({}))).status, 400);
  assert.equal((await f('/duplicates/keep-both', form({ a: a.id, b: 'nope' }))).status, 404);
  assert.equal((await f('/duplicates/keep-both', form({ a: a.id }))).status, 400);
  assert.equal(app.deps.store.get(a.id)!.deletedAt, null);
});

test('unknown memories and history entries are 404', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  assert.equal((await f('/memories/nope')).status, 404);
  assert.equal((await f('/memories/nope', form({ content: 'x' }))).status, 404);
  assert.equal((await f('/memories/nope/delete', { method: 'POST' })).status, 404);
  assert.equal((await f('/memories/nope/confirm', { method: 'POST' })).status, 404);
  assert.equal((await f('/history/999/undo', { method: 'POST' })).status, 404);
  assert.equal((await f('/history/abc/undo', { method: 'POST' })).status, 404);
});

test('stale memories offer Still true, which removes them without writing history', async (t) => {
  const app = await start(t);
  const m = await remember(app, 'Old but maybe fine');
  app.advance(181 * DAY);
  const f = await loggedIn(app);
  const before = await (await f('/facts/tidy')).text();
  assert.match(before, /Old but maybe fine/);
  assert.match(before, /Still true/);
  const confirmed = await f(`/memories/${m.id}/confirm`, { method: 'POST' });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get('location'), '/facts/tidy');
  const after = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(after, /Still true/);
  assert.equal(app.deps.store.history(m.id).length, 0);
  assert.equal(app.deps.store.get(m.id)!.updatedBy, 'owner');
});

test('stale memories can be deleted from the tidy page', async (t) => {
  const app = await start(t);
  const m = await remember(app, 'Outdated');
  app.advance(181 * DAY);
  const f = await loggedIn(app);
  assert.match(await (await f('/facts/tidy')).text(), /Delete/);
  const del = await f(`/memories/${m.id}/delete`, form({ back: 'tidy' }));
  assert.equal(del.status, 303);
  assert.equal(del.headers.get('location'), '/facts/tidy');
  assert.doesNotMatch(await (await f('/facts/tidy')).text(), /Still true/);
});

test('after an assistant recalls or loads a briefing, Settings and Tidy up reuse their cached pair checks', async (t) => {
  const app = await start(t);
  const old = await remember(app, 'Old but maybe fine', 'decision', 'demo');
  app.advance(181 * DAY);
  await remember(app, 'Use SQLite for storage', 'decision', 'demo');
  await remember(app, 'Deploy with Docker', 'decision', 'other');
  const f = await loggedIn(app);
  // The pair checks (duplicates, overlapping projects) read every embedding: count those reads.
  const store = app.deps.store;
  const read = store.activeEmbeddings.bind(store);
  let reads = 0;
  store.activeEmbeddings = (...args) => { reads++; return read(...args); };
  const readsFor = async (path: string) => { reads = 0; assert.equal((await f(path)).status, 200); return reads; };

  for (const path of ['/settings', '/facts/tidy']) await readsFor(path);
  const warm = { settings: await readsFor('/settings'), tidy: await readsFor('/facts/tidy') };
  assert.match(await (await f('/facts/tidy')).text(), /Old but maybe fine/);

  await app.deps.service.recall({ query: 'Old but maybe fine' });
  assert.ok(app.deps.store.get(old.id)!.lastRecalledAt, 'the recall marked the memory recalled');
  assert.deepEqual({ settings: await readsFor('/settings'), tidy: await readsFor('/facts/tidy') }, warm);
  await app.deps.service.brief('demo');
  assert.deepEqual({ settings: await readsFor('/settings'), tidy: await readsFor('/facts/tidy') }, warm);
  // The stale list still follows recalls: the memory just recalled is no longer offered as stale.
  assert.doesNotMatch(await (await f('/facts/tidy')).text(), /Old but maybe fine/);
});

test('Facts points to the tidy page only when there is something, and Settings never mentions it', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  let facts = await (await f('/facts')).text();
  assert.doesNotMatch(facts, /tidy-line/);
  await remember(app, 'Prefers dark mode');
  await remember(app, 'Prefers dark mode');
  facts = await (await f('/facts')).text();
  assert.match(facts, /<p class="tidy-line">Tidy up: 2 facts look like duplicates\. <a href="\/facts\/tidy">Have a look<\/a><\/p>/);
  assert.doesNotMatch(facts, /Keep both/);
  assert.doesNotMatch(await (await f('/settings')).text(), /Nothing to tidy|may need a look|tidy-line/);
});

test('the tidy page needs a login and has nothing to do on a clean memory', async (t) => {
  const app = await start(t);
  const anon = await fetch(app.baseUrl + '/tidy', { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/login?next=%2Ftidy');
  const f = await loggedIn(app);
  const res = await f('/facts/tidy');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Tidy up/);
  assert.match(body, /Nothing to tidy/);
});

test('several statuses for one project: delete one, or keep them all as current', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const old = await remember(app, 'wildlog status: v0.1 released', 'summary', 'wildlog');
  await remember(app, 'wildlog status: v0.2 released with sommelier memory', 'summary', 'wildlog');
  let body = await (await f('/facts/tidy')).text();
  assert.match(body, /Several statuses for one project/);
  assert.match(body, /v0\.1 released/);
  assert.match(body, new RegExp(`action="/memories/${old.id}/delete"><input type="hidden" name="back" value="tidy">`));
  const keep = await f('/tidy/statuses/keep', form({ project: 'wildlog' }));
  assert.equal(keep.status, 303);
  assert.equal(keep.headers.get('location'), '/facts/tidy');
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Several statuses for one project/);
  assert.equal((await f('/tidy/statuses/keep', form({}))).status, 400);
});

test('one project under two names: move it into the other, or say they are different', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Dossier app plays mkv video files in the player', 'decision', 'dossier-app');
  await remember(app, 'Dossier app signs PDFs with the signing certificate', 'decision', 'dossier-app');
  const stray = await remember(app, 'Dossier app plays mkv video files in the player now', 'summary', 'dossiers');
  await remember(app, 'CSV merge tool for seed catalogues', 'decision', 'seedsheet');
  await remember(app, 'CSV merge tool for seed catalogues v1', 'decision', 'csvmerge');
  let body = await (await f('/facts/tidy')).text();
  assert.match(body, /Same project under two names\?/);
  assert.match(body, /Move all to dossier-app/);
  assert.match(body, /Move all to dossiers/);

  const moved = await f('/tidy/projects/move', form({ from: 'dossiers', to: 'dossier-app' }));
  assert.equal(moved.status, 303);
  assert.equal(moved.headers.get('location'), '/facts/tidy');
  assert.equal(app.deps.store.get(stray.id)!.project, 'dossier-app');

  assert.equal((await f('/tidy/projects/different', form({ a: 'seedsheet', b: 'csvmerge' }))).status, 303);
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Same project under two names\?/);

  assert.equal((await f('/tidy/projects/move', form({ from: 'nothing-here', to: 'dossier-app' }))).status, 404);
  assert.equal((await f('/tidy/projects/move', form({ from: 'dossier-app', to: 'dossier-app' }))).status, 400);
  assert.equal((await f('/tidy/projects/different', form({ a: 'dossier-app' }))).status, 400);
});

test('the old weekly digest address sends you to the review', async (t) => {
  const app = await start(t);
  const anon = await fetch(app.baseUrl + '/week', { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location')!, /^\/login/);
  const f = await loggedIn(app);
  const to = async (path: string) => { const r = await f(path); return [r.status, r.headers.get('location')]; };
  assert.deepEqual(await to('/week'), [302, '/review/now']);
  assert.deepEqual(await to('/week?week=2026-10-28'), [302, '/review/2026-10-26']);
  assert.deepEqual(await to('/week?week=2025-12-31'), [302, '/review/2025-12-29']);
  assert.deepEqual(await to(`/week?week=${app.deps.now().toISOString().slice(0, 10)}`), [302, '/review/now']);
  assert.deepEqual(await to('/week?week=2099-01-01'), [302, '/review/now']);
  assert.deepEqual(await to('/week?week=garbage'), [302, '/review/now']);
});

test('So far › Latest changes keeps the digest\'s other notes', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const ai = (name: string) => ({ type: 'ai', name }) as const;
  const r = await app.deps.service.remember({ kind: 'decision', content: 'wildlog sommelier uses ChatGPT sign-in', project: 'wildlog' }, ai('Claude Code'));
  await app.deps.service.remember({ kind: 'summary', content: 'wildlog status: v0.2 released', project: 'wildlog' }, ai('Claude Code'));
  app.deps.service.forget((r as any).memory.id, ai('Grok'));
  for (let i = 0; i < 5; i++) app.deps.store.logToolCall('Claude', 'recall');

  const now = await (await f('/review/now')).text();
  const latest = now.slice(now.indexOf('<section id="latest"'), now.indexOf('</section>', now.indexOf('<section id="latest"')));
  assert.match(latest, /Claude<\/span> looked things up 5 times but saved nothing/);
  assert.doesNotMatch(latest, /deleted a memory/, 'deletions are a safety note in the review');
});

test('a connected AI is listed by name and Revoke cuts off its token', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const { accessToken } = await connectClient(app.baseUrl, f, 'Claude Code');
  const mcp = () => fetch(app.baseUrl + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal((await mcp()).status, 200);
  const body = await (await f('/settings')).text();
  assert.match(body, /Claude Code/);
  const grant = app.deps.provider.listGrants()[0]!;
  assert.match(body, new RegExp(`action="/clients/${grant.id}/revoke"`));
  assert.equal((await f(`/clients/${grant.id}/revoke`, { method: 'POST' })).status, 303);
  assert.equal((await mcp()).status, 401);
  assert.doesNotMatch(await (await f('/settings')).text(), new RegExp(`action="/clients/${grant.id}/revoke"`));
  assert.equal((await f('/clients/nope/revoke', { method: 'POST' })).status, 404);
});

test('owner validation: over-long content re-renders with 400 and the message', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const res = await f('/memories', form({ kind: 'decision', content: 'x'.repeat(1001) }));
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /class="error"/);
  assert.match(body, /content is 1001 characters; the limit is 1000/);
  assert.equal(app.deps.store.list({}).length, 0);

  const m = await remember(app, 'Fine');
  const edit = await f(`/memories/${m.id}`, form({ content: '', tags: '' }));
  assert.equal(edit.status, 400);
  assert.match(await edit.text(), /class="error"/);
  assert.equal(app.deps.store.get(m.id)!.content, 'Fine');
});

test('remote logout: another device can be signed out; revoking yourself clears the cookie', async (t) => {
  const app = await start(t);
  const phone = await loggedIn(app, { userAgent: 'iPhone' });
  const mac = await loggedIn(app, { userAgent: 'Mac' });
  const body = await (await mac('/settings')).text();
  assert.match(body, /iPhone/);
  assert.match(body, /Mac/);
  assert.equal(body.match(/<span class="badge">this device<\/span>/g)!.length, 1);
  const sessions = app.deps.sessions.list();
  const iphone = sessions.find((s) => s.userAgent === 'iPhone')!;
  const macSession = sessions.find((s) => s.userAgent === 'Mac')!;

  assert.equal((await phone('/')).status, 200);
  assert.equal((await mac(`/sessions/${iphone.id}/revoke`, { method: 'POST' })).status, 303);
  const gone = await phone('/');
  assert.equal(gone.status, 302);
  assert.match(gone.headers.get('location') ?? '', /^\/login/);
  assert.equal((await mac('/')).status, 200);

  const self = await mac(`/sessions/${macSession.id}/revoke`, { method: 'POST' });
  assert.equal(self.status, 302);
  assert.equal(self.headers.get('location'), '/login');
  const cleared = self.headers.getSetCookie().find((c) => c.startsWith('mem_session='))!;
  assert.match(cleared, /mem_session=;/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  assert.match(cleared, /HttpOnly/);
  assert.equal((await mac('/')).status, 302);
});

test('undoing a delete shows up in activity as restored by owner', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const m = await remember(app, 'Back from the dead');
  app.advance(1000);
  await f(`/memories/${m.id}/delete`, { method: 'POST' });
  app.advance(1000);
  const del = app.deps.store.history(m.id).find((h) => h.action === 'delete')!;
  assert.equal((await f(`/history/${del.id}/undo`, { method: 'POST' })).status, 303);
  const top = app.deps.store.recentActivity(100)[0]!;
  assert.equal(top.action, 'restored');
  assert.equal(top.by, 'owner');
  const latest = await (await f('/review/now')).text();
  assert.match(latest.slice(latest.indexOf('<section id="latest"')), /restored/);
  // Undo to the restore row is sensible: the memory is active, so it just re-applies that snapshot.
  const restore = app.deps.store.history(m.id).find((h) => h.action === 'restore')!;
  assert.equal((await f(`/history/${restore.id}/undo`, { method: 'POST' })).status, 303);
  assert.equal(app.deps.store.get(m.id)!.content, 'Back from the dead');
});

test('activity lists who did what, newest first', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const m = await remember(app, 'Alpha fact');
  await app.deps.service.update(m.id, { content: 'Beta fact' }, { type: 'ai', name: 'Grok' });
  const page = await (await f('/review/now')).text();
  const body = page.slice(page.indexOf('<section id="latest"'));
  assert.match(body, /Grok/);
  assert.match(body, /updated/);
  assert.match(body, /created/);
  assert.ok(body.indexOf('updated') < body.indexOf('created'));
});

async function startAuthorize(app: Awaited<ReturnType<typeof start>>, name = 'Grok') {
  const cb = 'http://localhost:9999/callback';
  const reg = await fetch(app.baseUrl + '/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [cb], client_name: name, token_endpoint_auth_method: 'none' }),
  });
  const { client_id } = await reg.json() as { client_id: string };
  const auth = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: cb, code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
    code_challenge_method: 'S256', state: 'x', resource: `${app.baseUrl}/mcp`,
  }), { redirect: 'manual' });
  return { client_id, consent: auth.headers.get('location')! };
}

test('the consent page offers a name and the two access levels', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const { consent } = await startAuthorize(app, 'Grok');
  const body = await (await f(consent)).text();
  assert.match(body, /<input[^>]*name="name"[^>]*value="Grok"/);
  assert.match(body, /<input[^>]*type="radio"[^>]*name="access"[^>]*value="full"[^>]* checked/);
  assert.match(body, /Full access: memory and discussions/);
  assert.match(body, /<input[^>]*type="radio"[^>]*name="access"[^>]*value="discussions"/);
  assert.match(body, /Discussions only: no access to your profile or memories/);
  const bad = await f(consent, form({ decision: 'approve', name: 'owner' }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /owner/);
  assert.equal((await f(consent, form({ decision: 'approve', access: 'admin' }))).status, 400);
  assert.equal(app.deps.provider.listGrants().length, 0);
});

test('approving with "Discussions only" and a name stores both', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const { consent } = await startAuthorize(app, 'Grok');
  const res = await f(consent, form({ decision: 'approve', name: 'Grok Build', access: 'discussions' }));
  assert.equal(res.status, 302);
  const [g] = app.deps.provider.listGrants();
  assert.equal(g!.access, 'discussions');
  assert.equal(g!.clientName, 'Grok Build');
});

test('the Clients page changes a connection\'s access and renames it', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await connectClient(app.baseUrl, f, 'Claude Code');
  const g = app.deps.provider.listGrants()[0]!;
  const body = await (await f('/settings')).text();
  assert.match(body, new RegExp(`action="/clients/${g.id}/access"`));
  assert.match(body, new RegExp(`action="/clients/${g.id}/name"`));
  const a = await f(`/clients/${g.id}/access`, form({ access: 'discussions' }));
  assert.equal(a.status, 303);
  assert.equal(a.headers.get('location'), '/settings#connections');
  assert.equal(app.deps.provider.grantAccess(g.id), 'discussions');
  assert.equal((await f(`/clients/${g.id}/access`, form({ access: 'root' }))).status, 400);
  assert.equal(app.deps.provider.grantAccess(g.id), 'discussions');
  assert.equal((await f(`/clients/nope/access`, form({ access: 'full' }))).status, 404);
  const n = await f(`/clients/${g.id}/name`, form({ name: 'Code Laptop' }));
  assert.equal(n.status, 303);
  assert.equal(app.deps.provider.listGrants()[0]!.clientName, 'Code Laptop');
  // Only this connection is renamed: the app's own name, which a new connection of it starts from, stays.
  assert.equal(app.deps.provider.clientsStore.clientName(g.clientId), 'Claude Code');
  const bad = await f(`/clients/${g.id}/name`, form({ name: ' OWNER ' }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /owner/i);
  assert.equal((await f(`/clients/nope/name`, form({ name: 'x' }))).status, 404);
});

test('consent preselects the access level last chosen for an app registered under the same name', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const checked = async (consent: string) =>
    /<input[^>]*value="discussions"[^>]* checked/.test(await (await f(consent)).text()) ? 'discussions' : 'full';
  const first = await startAuthorize(app, 'OpenCode');
  assert.equal(await checked(first.consent), 'full');
  assert.equal((await f(first.consent, form({ decision: 'approve', name: 'OpenCode Mac', access: 'discussions' }))).status, 302);
  // OpenCode registers afresh on every reconnect: the new client gets "Discussions only" preselected.
  const second = await startAuthorize(app, 'OpenCode');
  const body = await (await f(second.consent)).text();
  assert.match(body, /<input[^>]*type="radio"[^>]*value="discussions"[^>]* checked/);
  assert.doesNotMatch(body, /<input[^>]*type="radio"[^>]*value="full"[^>]* checked/);
  // The display name the owner chose does not count, and other apps keep the Full default.
  assert.equal(await checked((await startAuthorize(app, 'OpenCode Mac')).consent), 'full');
  assert.equal(await checked((await startAuthorize(app, 'Grok')).consent), 'full');
});

test('consent refuses repeated access or name fields instead of defaulting', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const { consent } = await startAuthorize(app, 'Grok');
  const repeated = (k: string, a: string, b: string) => ({
    method: 'POST', body: new URLSearchParams([['decision', 'approve'], [k, a], [k, b]]),
  });
  assert.equal((await f(consent, repeated('access', 'discussions', 'x'))).status, 400);
  assert.equal((await f(consent, repeated('name', 'A', 'B'))).status, 400);
  assert.equal(app.deps.provider.listGrants().length, 0);
});

test('consent can give read-only access to chosen projects', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  await remember(app, 'Office pool scores the group stage', 'decision', 'office-pool');
  await remember(app, 'Savings go to garden plots', 'decision', 'finances');
  const { consent } = await startAuthorize(app, 'ChatGPT');
  const body = await (await f(consent)).text();
  assert.match(body, /<input[^>]*type="radio"[^>]*name="access"[^>]*value="projects"/);
  assert.match(body, /Read only, chosen projects/);
  for (const p of ['trellis', 'office-pool', 'finances']) assert.match(body, new RegExp(`<input[^>]*type="checkbox"[^>]*name="projects"[^>]*value="${p}"`));
  // No project ticked, or one that does not exist: the page comes back with a message and nothing is granted.
  const none = await f(consent, form({ decision: 'approve', access: 'projects' }));
  assert.equal(none.status, 400);
  assert.match(await none.text(), /Tick at least one project/);
  assert.equal((await f(consent, form({ decision: 'approve', access: 'projects', projects: 'made-up' }))).status, 400);
  assert.equal(app.deps.provider.listGrants().length, 0);
  const ok = await f(consent, { method: 'POST', body: new URLSearchParams([['decision', 'approve'], ['name', 'ChatGPT work'], ['access', 'projects'], ['projects', 'trellis'], ['projects', 'office-pool']]) });
  assert.equal(ok.status, 302);
  const [g] = app.deps.provider.listGrants();
  assert.equal(g!.access, 'projects');
  assert.deepEqual(g!.projects, ['trellis', 'office-pool']);
});

test('the Clients page shows and changes a read-only connection\'s projects', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  await remember(app, 'Office pool scores the group stage', 'decision', 'office-pool');
  await connectClient(app.baseUrl, f, 'ChatGPT');
  const g = app.deps.provider.listGrants()[0]!;
  const changed = await f(`/clients/${g.id}/access`, { method: 'POST', body: new URLSearchParams([['access', 'projects'], ['projects', 'trellis']]) });
  assert.equal(changed.status, 303);
  assert.deepEqual(app.deps.provider.grantProjects(g.id), ['trellis']);
  const body = await (await f('/settings')).text();
  assert.match(body, /Read only: trellis/);
  assert.match(body, /<input[^>]*type="checkbox"[^>]*name="projects"[^>]*value="trellis"[^>]* checked/);
  assert.doesNotMatch(body, /<input[^>]*type="checkbox"[^>]*name="projects"[^>]*value="office-pool"[^>]* checked/);
  assert.equal((await f(`/clients/${g.id}/access`, form({ access: 'projects' }))).status, 400);
  assert.equal((await f(`/clients/${g.id}/access`, form({ access: 'projects', projects: 'made-up' }))).status, 400);
  assert.deepEqual(app.deps.provider.grantProjects(g.id), ['trellis']);
});

test('a read-only connection reads its projects over MCP and nothing else', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  await remember(app, 'Savings go to garden plots', 'decision', 'finances');
  const { accessToken } = await connectClient(app.baseUrl, f, 'ChatGPT');
  app.deps.provider.setGrantAccess(app.deps.provider.listGrants()[0]!.id, 'projects', ['trellis']);
  const rpc = async (method: string, params: unknown) => (await fetch(app.baseUrl + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).text();
  const tools = await rpc('tools/list', {});
  assert.doesNotMatch(tools, /"remember"|"load_profile"|"open_discussion"/);
  assert.match(tools, /"recall"/);
  const found = await rpc('tools/call', { name: 'recall', arguments: { query: 'harvest garden plots savings' } });
  assert.match(found, /harvest workbook/);
  assert.doesNotMatch(found, /garden plots/);
});

test('when an app is already connected, consent preselects no access level and needs a choice', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  const first = await startAuthorize(app, 'ChatGPT');
  assert.equal((await f(first.consent, form({ decision: 'approve' }))).status, 302);
  const second = await startAuthorize(app, 'ChatGPT');
  // Already connected with full access: a second account (the work one) must not get Full by a quick click.
  assert.doesNotMatch(await (await f(second.consent)).text(), /<input[^>]*type="radio"[^>]*name="access"[^>]* checked/);
  assert.equal((await f(second.consent, { method: 'POST', body: new URLSearchParams([['decision', 'approve'], ['access', 'projects'], ['projects', 'trellis']]) })).status, 302);
  const third = await startAuthorize(app, 'ChatGPT');
  const body = await (await f(third.consent)).text();
  assert.doesNotMatch(body, /<input[^>]*type="radio"[^>]*name="access"[^>]* checked/);
  assert.match(body, /<input[^>]*type="radio"[^>]*name="access"[^>]* required/);
  const none = await f(third.consent, form({ decision: 'approve' }));
  assert.equal(none.status, 400);
  assert.match(await none.text(), /Choose an access level/);
  assert.equal(app.deps.provider.listGrants().length, 2);
});

test('the Clients page shows when a read-only project no longer exists under that name', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  await remember(app, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  await connectClient(app.baseUrl, f, 'ChatGPT');
  const g = app.deps.provider.listGrants()[0]!;
  app.deps.provider.setGrantAccess(g.id, 'projects', ['trellis']);
  app.deps.service.moveProject('trellis', 'trellis-app', owner);
  assert.match(await (await f('/settings')).text(), /trellis \(no longer a project: tick its new name\)/);
});

test('work mode refuses read-only access on the Clients page', async (t) => {
  const app = await startTestApp({ mode: 'work' });
  t.after(() => app.close());
  const f = await loggedIn(app);
  await remember(app as any, 'Trellis app reads the harvest workbook', 'decision', 'trellis');
  await connectClient(app.baseUrl, f, 'Codex');
  const g = app.deps.provider.listGrants()[0]!;
  assert.equal((await f(`/clients/${g.id}/access`, { method: 'POST', body: new URLSearchParams([['access', 'projects'], ['projects', 'trellis']]) })).status, 400);
  assert.equal(app.deps.provider.grantAccess(g.id), 'full');
});

test('a memory form opened before an assistant saved a newer version does not overwrite it: the owner sees the current text and keeps the draft', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const m = await remember(app, 'wildlog status: CSV export half done', 'summary', 'wildlog');
  const opened = await (await f(`/memories/${m.id}`)).text();
  const base = /<input type="hidden" name="base" value="([^"]+)">/.exec(opened)?.[1];
  assert.ok(base, 'the form carries the version it shows');
  app.advance(60_000);
  await app.deps.service.update(m.id, { content: 'wildlog status: CSV export done, sync next' }, { type: 'ai', name: 'Claude Code' });
  const stale = await f(`/memories/${m.id}`, form({ content: 'wildlog status: CSV export nearly done', project: 'wildlog', tags: '', base }));
  assert.equal(stale.status, 409);
  const body = await stale.text();
  assert.match(body, /changed since you opened it/);
  assert.match(body, /CSV export done, sync next/);
  assert.match(body, /<textarea[^>]*>wildlog status: CSV export nearly done<\/textarea>/);
  assert.equal(app.deps.store.get(m.id)!.content, 'wildlog status: CSV export done, sync next');
  // Saving again from that page is a choice made with the current text in view.
  const newBase = /<input type="hidden" name="base" value="([^"]+)">/.exec(body)![1]!;
  assert.equal((await f(`/memories/${m.id}`, form({ content: 'wildlog status: CSV export done, sync started', project: 'wildlog', tags: '', base: newBase }))).status, 303);
  assert.equal(app.deps.store.get(m.id)!.content, 'wildlog status: CSV export done, sync started');
});

test('the edit form refuses to turn a linked decision into a status', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const a = await remember(app, 'wildlog uses Core Data', 'decision', 'wildlog');
  const b = await remember(app, 'wildlog uses SwiftData', 'decision', 'wildlog');
  app.deps.service.supersede([a.id], b.id, owner);
  const res = await f(`/memories/${b.id}`, form({ content: 'wildlog uses SwiftData', project: 'wildlog', tags: 'status' }));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /<p class="error" role="alert">A decision can only replace a decision, and a status a status\. Undo the replacement on this page first\.<\/p>/);
  assert.deepEqual(app.deps.store.get(b.id)!.tags, []);
});

// ---- Tidy up and replaced facts (section 16) ----

const saveAt = async (app: Awaited<ReturnType<typeof start>>, content: string, project: string, kind: 'decision' | 'summary' = 'decision', by: { type: 'owner' } | { type: 'ai'; name: string } = owner) => {
  app.advance(60_000);
  const r = await app.deps.service.remember({ kind, content, project, newProject: true, allowDuplicate: true, separateWork: true }, by as any) as any;
  assert.equal(r.status, 'saved', r.status);
  return r.memory.id as string;
};

test('Possible duplicates offers Newer replaces older only for the same kind in the same project', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const older = await saveAt(app, 'The heating is controlled by the Ecobee thermostat through Home Assistant', 'homeassistant');
  const newer = await saveAt(app, 'The heating is controlled by the Ecobee thermostat through Home Assistant', 'homeassistant');
  let body = await (await f('/facts/tidy')).text();
  assert.match(body, new RegExp(`<form method="post" action="/tidy/duplicates/supersede"><input type="hidden" name="older" value="${older}"><input type="hidden" name="newer" value="${newer}"><button type="submit" class="primary">Newer replaces older</button></form>`), 'the one black button on the screen');
  assert.match(body, /“Keep this one” deletes the other\. “Newer replaces older” keeps the older one readable, out of search\.|"Keep this one" deletes the other\. "Newer replaces older" keeps the older one readable, out of search\./);
  const replaced = await f('/tidy/duplicates/supersede', form({ older, newer }));
  assert.equal(replaced.status, 303);
  assert.equal(replaced.headers.get('location'), '/facts/tidy');
  assert.equal(app.deps.service.replacement(older)!.endId, newer);
  assert.equal(app.deps.store.isDismissed(older, newer), true);
  app.deps.service.undoSupersession(app.deps.store.supersessions.allFor(older)[0]!.id, owner);
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Newer replaces older/);
  const s1 = await saveAt(app, 'energy status: comparing the tariffs this month', 'energy', 'summary');
  const s2 = await saveAt(app, 'energy status: comparing the tariffs this month', 'energy', 'summary');
  const d1 = await saveAt(app, 'wildlog photos are kept on the phone only', 'wildlog');
  const st = await saveAt(app, 'wildlog photos are kept on the phone only', 'wildlog', 'decision');
  await app.deps.service.update(st, { content: 'wildlog photos are kept on the phone only', tags: ['status'] }, owner);
  body = await (await f('/facts/tidy')).text();
  assert.match(body, new RegExp(`name="older" value="${s1}"><input type="hidden" name="newer" value="${s2}">`));
  assert.doesNotMatch(body, new RegExp(`name="older" value="${d1}"`));
  assert.equal((await f('/tidy/duplicates/supersede', form({ older: s1, newer: s2 }))).status, 303);
  assert.equal(app.deps.service.replacement(s1)!.endId, s2);
  assert.equal(app.deps.store.isDismissed(s1, s2), false);
});

test('Several statuses gives each older status Replaced by the latest', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  // Saved by the owner: no status_exists and no separate-work pair, so the group shows.
  const old = await saveAt(app, 'energy status: comparing Agile and fixed tariffs', 'energy', 'summary');
  const latest = await saveAt(app, 'energy status: October bills compared, next the solar quote', 'energy', 'summary');
  const dismissed = () => app.deps.store.isDismissed(old, latest);
  let body = await (await f('/facts/tidy')).text();
  assert.equal((body.match(/Replaced by the latest/g) ?? []).length, 1);
  assert.match(body, new RegExp(`<form method="post" action="/tidy/statuses/supersede"><input type="hidden" name="id" value="${old}"><input type="hidden" name="latest" value="${latest}"><button type="submit" class="primary">Replaced by the latest</button></form>`), 'the only replacement offered, so the one black button');
  assert.equal(dismissed(), false);
  const superseded = await f('/tidy/statuses/supersede', form({ id: old, latest }));
  assert.equal(superseded.status, 303);
  assert.equal(superseded.headers.get('location'), '/facts/tidy');
  assert.equal(dismissed(), false);
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Several statuses for one project/);
  const third = await saveAt(app, 'energy status: solar quote received', 'energy', 'summary');
  const newest = await saveAt(app, 'energy status: solar quote accepted', 'energy', 'summary');
  app.deps.service.supersede([latest], newest, owner);
  const stale = await f('/tidy/statuses/supersede', form({ id: third, latest }));
  assert.equal(stale.status, 400);
  assert.match(await stale.text(), /<p class="error" role="alert">This fact was replaced by .*\. Use that one\.<\/p>/);
});

test('Replaced by a fact that\'s gone lists a replaced fact whose replacement was deleted, with three ways out', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const code = { type: 'ai', name: 'Claude Code' } as const;
  // Each round in its own project: round 2's owner deletion would otherwise hold round 3's save (forgetting that sticks).
  let round = 0;
  const mk = async () => {
    const project = `homeassistant${++round}`;
    const old = await saveAt(app, 'Home Assistant runs on a Raspberry Pi 4 in the server rack', project);
    const newer = await saveAt(app, 'Home Assistant runs on a Raspberry Pi 5 in the server rack', project, 'decision', code);
    const [row] = app.deps.service.supersede([old], newer, code);
    app.deps.service.forget(newer, code);
    return { old, newer, row: row! };
  };
  let body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Replaced by a fact that’s gone|Replaced by a fact that's gone/);
  const one = await mk();
  body = await (await f('/facts/tidy')).text();
  assert.match(body, /<h2>Replaced by a fact that(’|&#39;|')s gone <span class="n">1<\/span><\/h2>/, 'the count sits grey beside the heading, as in every Tidy up section');
  assert.match(body, /The newer fact was deleted, so nothing in search says this any more\. Nothing changes until you choose\./);
  assert.match(body, /its replacement was deleted [^<]* by <span class="writer w-code">Claude Code<\/span>/);
  assert.match(body, new RegExp(`<form method="post" action="/supersessions/${one.row.id}/undo"><input type="hidden" name="back" value="tidy"><button type="submit">Bring it back</button></form>`));
  assert.match(body, new RegExp(`<form method="post" action="/memories/${one.old}/delete"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Delete it too</button></form>`));
  const deletion = app.deps.store.history(one.newer).find((h) => h.action === 'delete')!;
  assert.match(body, new RegExp(`<form method="post" action="/history/${deletion.id}/undo"><input type="hidden" name="back" value="tidy"><button type="submit" class="secondary">Restore the newer one</button></form>`));
  assert.equal((await f(`/supersessions/${one.row.id}/undo`, form({ back: 'tidy' }))).headers.get('location'), '/facts/tidy');
  assert.equal(app.deps.service.replacement(one.old), null);
  const two = await mk();
  assert.equal((await f(`/memories/${two.old}/delete`, form({ back: 'tidy' }))).status, 303);
  assert.ok(app.deps.store.get(two.old)!.deletedAt);
  const three = await mk();
  const del3 = app.deps.store.history(three.newer).find((h) => h.action === 'delete')!;
  const restored = await f(`/history/${del3.id}/undo`, form({ back: 'tidy' }));
  assert.equal(restored.status, 303);
  assert.equal(restored.headers.get('location'), '/facts/tidy');
  body = await (await f('/facts/tidy')).text();
  assert.doesNotMatch(body, /Replaced by a fact that/);
  assert.equal(app.deps.service.replacement(three.old)!.end!.id, three.newer);
});

test('the Tidy up lede says anything changed there can be undone', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  assert.match(await (await f('/facts/tidy')).text(), /<p class="lede">What could be cleaner in memory, so assistants find the right thing\. Anything you change here can be undone\.<\/p>/);
});
