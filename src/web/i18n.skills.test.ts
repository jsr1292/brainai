import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { proposalCard } from './skillViews.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app), skills: app.deps.skills };
}
const deploy = { name: 'brain-deploy', description: 'Use when deploying brainai to the mini PC.', body: '# Deploy\n\n1. Back up.' };
const FIXTURE = ['brain-deploy', 'release-notes', 'brain-ship', 'Use when deploying brainai to the mini PC.', 'Use when writing release notes.', 'Deploy', 'Back up', 'Back up first', 'references/a.md', 'references/notes.md', 'references/gone.md', 'references/added.md', 'references/style.md', 'old line', 'new line', 'bye', 'hello', 'Group by Nuevo, Mejorado, Arreglado', 'Mac', 'codex-delegation', 'Use when delegating', 'Plan, then delegate'];
const post = (pairs: [string, string][]) => ({ method: 'POST', body: new URLSearchParams(pairs), redirect: 'manual' as const });

test('the skill pages have no English left under the pseudo-locale', async (t) => {
  const { app, f, skills } = await start(t);
  const s = skills.create({ ...deploy, files: [{ path: 'references/a.md', text: 'old line' }, { path: 'references/gone.md', text: 'bye' }] }, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  skills.recordLoad(s.id, 'Claude Code');
  skills.update(s.id, { base: 1, name: s.name, description: s.description, body: '# Deploy\n\n1. Back up first.', files: s.files }, 'owner');
  skills.addProposal(skills.propose({ ...deploy, name: 'release-notes', description: 'Use when writing release notes.' }, 'Claude').id, false);
  const { device, token } = app.deps.devices.create('Mac');
  const files = [{ path: 'SKILL.md', text: '---\nname: codex-delegation\ndescription: Use when delegating.\n---\n\nPlan, then delegate.\n' }];
  const { contentHash } = await import('../skills/sync.js');
  const r = await fetch(`${app.baseUrl}/api/skills/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ skills: [{ name: 'codex-delegation', description: 'Use when delegating.', hash: contentHash(files), files: 1, bytes: 80, shareable: null }] }) });
  assert.equal(r.status, 200);
  void device;
  enablePseudoLocale(true);
  try {
    app.deps.store.setSwitch('ui_language', 'xx');
    const allow = [...FIXTURE, 'Mac'];
    for (const path of ['/skills', '/skills/new', `/skills/${s.id}`, `/skills/${s.id}/edit`, `/skills/${s.id}/history`, `/skills/${s.id}/files?path=${encodeURIComponent('references/a.md')}`]) {
      const res = await f(path);
      assert.equal(res.status, 200, path);
      assertNoEnglishLeft(await res.text(), path, { allow });
    }
    // Refused forms: an invalid name, a missing skill, a stale edit.
    const bad = await f('/skills', post([['name', 'Bad Name'], ['description', 'x'], ['body', 'y']]));
    assert.ok(bad.status >= 400);
    assertNoEnglishLeft(await bad.text(), 'a refused new skill', { allow: [...allow, 'Bad Name', 'x', 'y'] });
    assertNoEnglishLeft(await (await f('/skills/nope')).text(), 'no such skill', {});
  } finally { enablePseudoLocale(false); }
});

test('proposal cards have no English left under the pseudo-locale', async (t) => {
  const { skills } = await start(t);
  const s = skills.create({ ...deploy, files: [{ path: 'references/a.md', text: 'old line' }, { path: 'references/gone.md', text: 'bye' }] }, 'owner');
  const fresh = skills.propose({ ...deploy, name: 'release-notes', description: 'Use when writing release notes.', files: [{ path: 'references/style.md', text: 'hello' }] }, 'Claude');
  const change = skills.propose({ ...deploy, name: 'brain-ship', description: 'Use when shipping.', body: '# Ship\n\nGo.', files: [{ path: 'references/a.md', text: 'new line' }, { path: 'references/added.md', text: 'hello' }] }, 'ChatGPT');
  enablePseudoLocale(true);
  try {
    runWithLocale('xx', () => {
      const allow = [...FIXTURE, 'Use when shipping.', 'Ship', 'Go'];
      assertNoEnglishLeft(proposalCard(skills.proposal(fresh.id)!, undefined).value, 'a new-skill card', { allow });
      assertNoEnglishLeft(proposalCard(skills.proposal(change.id)!, skills.get(s.id), {}).value, 'a change card', { allow });
      assertNoEnglishLeft(proposalCard(skills.proposal(change.id)!, skills.get(s.id), { changed: 'This changed.' }).value, 'a change card, stale', { allow: [...allow, 'This changed.'] });
    });
  } finally { enablePseudoLocale(false); }
});

test('the skill pages in Spanish, through the real app', async (t) => {
  const { app, f, skills } = await start(t);
  const s = skills.create(deploy, 'owner');
  skills.setEnabled(s.id, true, 'owner');
  const en = await (await f('/skills')).text();
  app.deps.store.setSwitch('ui_language', 'es');
  const es = await (await f('/skills')).text();
  assert.match(es, /<title>Habilidades<\/title>/);
  assert.match(es, /<h1>Habilidades<\/h1>/);
  assert.match(es, /<span class="chip">Activada<\/span>/);
  assert.match(es, /escrita aquí/);
  assert.match(es, /nunca cargada/);
  assert.match(es, /<h2>1 habilidad<\/h2><a class="button primary" href="\/skills\/new">Nueva habilidad<\/a>/);
  const lit = (h: string) => /<nav class="tabs"[^>]*>.*?<\/nav>/s.exec(h)![0].replace(/>[^<]+</g, '><').replace(/aria-label="[^"]*"/, '');
  assert.equal(lit(es), lit(en));
  const one = await (await f(`/skills/${s.id}`)).text();
  assert.match(one, /<title>brain-deploy<\/title>/);
  assert.match(one, /<p class="crumb back"><a href="\/skills">‹ Habilidades<\/a><\/p>/);
  assert.match(one, /Habilidad · Activada/);
  assert.match(one, /Los asistentes la ven en su lista y la cargan cuando una tarea encaja\./);
  assert.match(one, />Borrar habilidad<\/button>/);
  assert.match(await (await f(`/skills/${s.id}/history`)).text(), /<h1>Historial<\/h1>/);
  assert.match(await (await f(`/skills/${s.id}/edit`)).text(), /<title>Editar brain-deploy<\/title>/);
  // A refused save explains itself in the page's language (the reason itself comes from the skills service, in English).
  const bad = await f('/skills', post([['name', 'Bad Name'], ['description', 'x'], ['body', 'y']]));
  assert.ok(bad.status >= 400);
  assert.match(await bad.text(), /<title>Nueva habilidad<\/title>/);
  const missing = await f('/skills/nope');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No existe esa habilidad\./);
});
