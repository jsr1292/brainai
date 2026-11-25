/** UX fixes: skills Undo, folded Revoke and Log out, the skills empty state, backup marks in words, and the week card's Undo. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_PASSWORD, connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { seedWildlogWeek } from '../testing/reviewFixtures.js';
import { backupsPanel } from './dashboardViews.js';

const ES = { 'Accept-Language': 'es-ES,es;q=0.9' };
const post = (pairs: [string, string][] = [], headers: Record<string, string> = {}) => ({ method: 'POST', body: new URLSearchParams(pairs), headers });
const deploy = { name: 'brain-deploy', description: 'Use when deploying brainai to the mini PC.', body: '# Deploy\n\n1. Back up.' };

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app), skills: app.deps.skills };
}

test('deleting a skill says "Deleted" with Undo on /skills, lists it in a fold, and Undo brings it back Off', async (t) => {
  const { f, skills } = await start(t);
  const s = skills.create(deploy, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  const del = await f(`/skills/${s.id}/delete`, post());
  assert.deepEqual([del.status, del.headers.get('location')], [303, `/skills?deleted=${s.id}`]);
  let body = await (await f(`/skills?deleted=${s.id}`)).text();
  assert.match(body, /<div class="notice notice-undo" role="status"><span>Deleted “brain-deploy”\.<\/span><form method="post" action="\/skills\/[^"]+\/undelete"><button type="submit" class="secondary">Undo<\/button>/);
  assert.match(body, /<summary class="row nolead">Deleted<span class="n">1<\/span>/);
  assert.doesNotMatch(body, /history stays in the backups/);
  assert.equal(skills.get(s.id), undefined);
  // a made-up id shows no notice
  assert.doesNotMatch(await (await f('/skills?deleted=nope')).text(), /Deleted “/);

  const undo = await f(`/skills/${s.id}/undelete`, post());
  assert.deepEqual([undo.status, undo.headers.get('location')], [303, `/skills?restored=${s.id}`]);
  const back = skills.get(s.id)!;
  assert.equal(back.enabled, false, 'it returns Off: nothing reaches assistants until the owner turns it On');
  assert.deepEqual([back.name, back.body, back.version], ['brain-deploy', deploy.body, 1]);
  body = await (await f(`/skills?restored=${s.id}`)).text();
  assert.match(body, /“brain-deploy” is back, switched Off\./);
  skills.setEnabled(s.id, true, 'owner');
  assert.doesNotMatch(await (await f(`/skills?restored=${s.id}`)).text(), /is back, switched Off/, 'a skill that is On is not "back, switched Off"');
  skills.setEnabled(s.id, false, 'owner');
  assert.doesNotMatch(body, /<summary class="row nolead">Deleted/);
  assert.equal((await f(`/skills/${s.id}/undelete`, post())).status, 404, 'a live skill is not "undeleted"');
});

test('Spanish: the delete confirmation, the fold and the note on the skill page', async (t) => {
  const { f, skills } = await start(t);
  const s = skills.create(deploy, 'owner');
  assert.match(await (await f(`/skills/${s.id}`, { headers: ES })).text(), /vuelve desactivada/);
  skills.remove(s.id, 'owner');
  const body = await (await f(`/skills?deleted=${s.id}`, { headers: ES })).text();
  assert.match(body, /Has borrado «brain-deploy»\./);
  assert.match(body, /Deshacer/);
  assert.match(body, /Borradas<span class="n">1<\/span>/);
});

test('Undo of a deleted skill is refused when the name was taken meanwhile, and without login or from another site', async (t) => {
  const { app, f, skills } = await start(t);
  const s = skills.create(deploy, 'owner');
  skills.remove(s.id, 'owner');
  const noLogin = await fetch(`${app.baseUrl}/skills/${s.id}/undelete`, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
  assert.ok([302, 401, 403].includes(noLogin.status), `no session: ${noLogin.status}`);
  assert.notEqual(noLogin.status, 303);
  const login = await fetch(`${app.baseUrl}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  for (const headers of [{ Cookie: cookie, Origin: 'https://evil.example' }, { Cookie: cookie }] as Record<string, string>[]) {
    assert.equal((await fetch(`${app.baseUrl}/skills/${s.id}/undelete`, { method: 'POST', redirect: 'manual', headers })).status, 403);
  }
  assert.ok(skills.deletedOne(s.id), 'still deleted after both');
  skills.create(deploy, 'owner');
  const clash = await f(`/skills/${s.id}/undelete`, post());
  assert.equal(clash.status, 400);
  assert.match(await clash.text(), /A skill named brain-deploy already exists\./);
  assert.ok(skills.deletedOne(s.id));
});

test('with no skills and proposals waiting, the empty state links to Approvals', async (t) => {
  const { f, skills } = await start(t);
  assert.match(await (await f('/skills')).text(), /No skills yet\./);
  for (const name of ['release-notes', 'code-review']) skills.propose({ ...deploy, name }, 'Claude');
  const body = await (await f('/skills')).text();
  assert.match(body, /<a href="\/approvals">2 skills wait for your approval ›<\/a>/);
  assert.doesNotMatch(body, /No skills yet\./);
});

test('the empty-state link counts waiting proposals, singular and Spanish', async (t) => {
  const { f, skills } = await start(t);
  skills.propose({ ...deploy, name: 'one-waiting' }, 'Claude');
  assert.match(await (await f('/skills')).text(), /<a href="\/approvals">1 skill waits for your approval ›<\/a>/);
  assert.match(await (await f('/skills', { headers: ES })).text(), /<a href="\/approvals">1 habilidad espera tu aprobación ›<\/a>/);
});

test('Revoke and Log out sit in a fold and still work through it', async (t) => {
  const { app, f } = await start(t);
  await connectClient(app.baseUrl, f, 'Claude Code');
  const body = await (await f('/settings')).text();
  const grant = app.deps.provider.listGrants()[0]!;
  assert.match(body, new RegExp(`<details class="pg-danger"><summary>Revoke Claude Code…<span class="chev"></span></summary><p class="meta">[^<]+</p><form method="post" action="/clients/${grant.id}/revoke"><button type="submit" class="secondary"`));
  assert.match(body, /<details class="pg-danger"><summary>Log out…<span class="visually-hidden"> [^<]+<\/span><span class="chev"><\/span><\/summary><p class="meta">[^<]+<\/p><form method="post" action="\/sessions\/[^"]+\/revoke"(?: data-logout)?><button type="submit" class="secondary">Log out<\/button>/);
  assert.match(await (await f('/settings', { headers: ES })).text(), /<summary>Revocar Claude Code…/);
  assert.equal((await f(`/clients/${grant.id}/revoke`, post())).status, 303);
  assert.ok(app.deps.provider.listGrants().find((g) => g.id === grant.id)!.revokedAt);
});

test('backup ✓ and ✗ come with words for a screen reader', () => {
  const ok = backupsPanel({ status: { nightly: { at: '2026-10-18T03:00:00Z', ok: true, copies: [{ where: '/mnt/nas/memory-backups', result: 'copied' }, { where: '/mnt/x/memory-backups', result: 'failed' }, { where: '/mnt/y/memory-backups', result: 'skipped' }] } } as any, health: { ok: true, problems: [] }, offsite: false }).value;
  assert.match(ok, /<span aria-hidden="true">✓<\/span><span class="visually-hidden">copied<\/span>/);
  assert.match(ok, /<span aria-hidden="true">✗<\/span><span class="visually-hidden">failed<\/span>/);
  assert.match(ok, /x\/ <span aria-hidden="true">✗<\/span>|<span class="visually-hidden">skipped<\/span>/, 'a skipped copy reads skipped');
});

test('the backups panel shows the last restore drill with its copy name, and nothing when none was recorded', () => {
  const base = { nightly: { at: '2026-10-18T03:00:00Z', ok: true }, offsite: { at: '2026-10-18T03:00:00Z', ok: true, where: 'gdrive:memory-backups' } };
  const none = backupsPanel({ status: base as any, health: { ok: true, problems: [] }, offsite: true }).value;
  assert.doesNotMatch(none, /Restore drill/);
  const shown = backupsPanel({ status: { ...base, drill: { date: '2026-10-19T10:00:00Z', copy: 'memory-2026-10-18.tar.gz.age', result: 'pass' } } as any, health: { ok: true, problems: [] }, offsite: true }).value;
  assert.match(shown, /Restore drill[\s\S]*memory-2026-10-18\.tar\.gz\.age[\s\S]*visually-hidden">The restore drill passed/);
  const failed = backupsPanel({ status: { ...base, drill: { date: '2026-10-19T10:00:00Z', copy: 'c.age', result: 'fail' } } as any, health: { ok: true, problems: [] }, offsite: true }).value;
  assert.match(failed, /place bad">c\.age[\s\S]*visually-hidden">The restore drill failed/);
});

const MONDAY = '2026-10-26';
test('Not now on the week card comes back home with a line and Undo; Undo shows the card again', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  assert.match(await (await f('/')).text(), /monday-card/);
  const dismiss = await f(`/review/${MONDAY}/dismiss`, post());
  assert.equal(dismiss.headers.get('location'), `/?weekHidden=${MONDAY}`);
  let body = await (await f(`/?weekHidden=${MONDAY}`)).text();
  assert.doesNotMatch(body, /monday-card/);
  assert.match(body, new RegExp(`<div class="notice notice-undo" role="status"><span>Last week&#39;s review is set aside[^<]*</span><form method="post" action="/review/${MONDAY}/undismiss"><button type="submit" class="secondary">Undo</button>`));
  assert.match(await (await f(`/?weekHidden=${MONDAY}`, { headers: ES })).text(), /Has dejado para luego el resumen/);
  // without the param, or for a week that was not set aside, nothing shows
  assert.doesNotMatch(await (await f('/')).text(), /review is set aside/);
  assert.doesNotMatch(await (await f('/?weekHidden=2026-10-19')).text(), /review is set aside/);
  const undo = await f(`/review/${MONDAY}/undismiss`, post());
  assert.deepEqual([undo.status, undo.headers.get('location')], [303, '/']);
  body = await (await f('/')).text();
  assert.match(body, /monday-card/);
  assert.equal((await f('/review/2026-09-28/undismiss', post())).status, 404);
  assert.equal((await f('/review/garbage/undismiss', post())).status, 404);
});

test('the week-hidden line is only for last week, and Undo only works on last week', async (t) => {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  await seedWildlogWeek(app.deps, app.advance);
  const f = await loggedIn(app);
  app.deps.reviews.ensure('2026-10-19', 'owner');
  app.deps.reviews.dismiss('2026-10-19');
  assert.doesNotMatch(await (await f('/?weekHidden=2026-10-19')).text(), /review is set aside/);
  assert.equal((await f('/review/2026-10-19/undismiss', post())).status, 404);
});

test('the Revoke fold comes after the Change fold and Log out names its device and this device', async (t) => {
  const { app, f } = await start(t);
  await connectClient(app.baseUrl, f, 'Claude Code');
  const body = await (await f('/settings')).text();
  assert.ok(body.indexOf('class="conn-change"') < body.indexOf('Revoke Claude Code…'));
  assert.match(body, /Log out…<span class="visually-hidden"> [^<]+<\/span>/);
  assert.match(body, /You&#39;ll have to log in again on this device\.|You'll have to log in again on this device\./);
});
