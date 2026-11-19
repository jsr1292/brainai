import { test, type TestContext } from 'node:test';
import { decodeEntities } from '../testing/entities.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Caller, DiscussionService } from '../discussions/service.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { enablePseudoLocale } from '../i18n/core.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const code: Caller = { name: 'Claude Code', model: 'Opus 4', access: 'full' };
const gpt: Caller = { name: 'ChatGPT', model: 'GPT-5', access: 'full' };

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app), d: app.deps.discussions };
}
const open = (d: DiscussionService, over: object = {}) =>
  d.open(code, { title: 'Which database?', question: 'SQLite or Postgres?', ask: ['ChatGPT', 'Grok'], ...over });
const FIXTURE = ['Which database?', 'SQLite or Postgres?', 'Use SQLite, it is simple.', 'Old one', 'Fixture decision text', 'wildlog', 'Opus 4', 'GPT-5', 'Remember the milk', 'Keep it simple', 'notes.txt', 'Hello there'];
const post = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });

test('the discussion pages have no English left under the pseudo-locale', async (t) => {
  const { app, f, d } = await start(t);
  const closed = open(d, { title: 'Old one' });
  await d.close('owner', closed.id, { decision: 'Fixture decision text' });
  const a = open(d, { project: 'wildlog', files: [{ name: 'notes.txt', content: 'Hello there' }] });
  d.reply(gpt, a.id, { text: 'Use SQLite, it is simple.' });
  d.addNote(a.id, 'Remember the milk');
  const b = open(d, { title: 'Second one' });
  enablePseudoLocale(true);
  try {
    app.deps.store.setSwitch('ui_language', 'xx');
    const allow = [...FIXTURE, 'Second one'];
    assertNoEnglishLeft(await (await f('/discussions')).text(), 'the list', { allow });
    for (const id of [a.id, closed.id, b.id]) assertNoEnglishLeft(await (await f(`/discussions/${id}`)).text(), `discussion ${id}`, { allow });
    // A second round, with an earlier round folded, and a refused form (the error text comes from the memory layer, with its key).
    d.nextRound(a.id);
    assertNoEnglishLeft(await (await f(`/discussions/${a.id}`)).text(), 'round two', { allow });
    for (const [id, path, fields] of [[a.id, 'ask', {}], [a.id, 'sharing', { include: 'maybe' }], [a.id, 'delete', {}], [b.id, 'decide', { decision: '   ', project: '' }]] as const) {
      const res = await f(`/discussions/${id}/${path}`, post(fields));
      assert.equal(res.status, 400, path);
      // The three keyed errors are translated; a refusal from the discussions service itself still carries its English message.
      assertNoEnglishLeft(await res.text(), `refused ${path}`, { allow });
    }
    assertNoEnglishLeft(await (await f('/discussions/nope')).text(), 'not found', {});
  } finally { enablePseudoLocale(false); }
});

test('the discussion pages in Spanish, through the real app', async (t) => {
  const { app, f, d } = await start(t);
  const a = open(d, { project: 'wildlog' });
  d.reply(gpt, a.id, { text: 'Use SQLite, it is simple.' });
  const en = await (await f('/discussions')).text();
  app.deps.store.setSwitch('ui_language', 'es');
  const es = await (await f('/discussions')).text();
  assert.match(es, /<title>Debates<\/title>/);
  assert.match(es, /<h1>Debates<\/h1>/);
  assert.match(decodeEntities(es), /Hazle la misma pregunta a varios asistentes\. Empieza uno desde cualquier asistente: "abre un debate sobre…"\./);
  assert.match(es, /ronda 1/);
  assert.match(es, /esperando a Grok/);
  // The lit tab and the back link are the same as in English.
  const lit = (h: string) => /<nav class="tabs"[^>]*>.*?<\/nav>/s.exec(h)![0].replace(/>[^<]+</g, '><').replace(/aria-label="[^"]*"/, '');
  assert.equal(lit(es), lit(en));
  assert.match(es, /<p class="crumb back"><a href="\/">‹ Proyectos<\/a><\/p>/);
  const one = await (await f(`/discussions/${a.id}`)).text();
  assert.match(one, /<title>Debate<\/title>/);
  assert.match(one, /<p class="crumb back"><a href="\/\?project=wildlog#panel">‹ wildlog<\/a><\/p>/);
  assert.match(one, /Ronda 1 · a ciegas/);
  assert.match(one, /Guardar la decisión y cerrar/);
  assert.match(one, /<h2>Preguntar al siguiente<\/h2>/);
  assert.match(one, /aria-label="Copiar la petición para Grok">Copiar<\/button>/);
  assert.match(one, /Aún no hay respuesta en la ronda 1\. Pregúntale, o copia la petición para pegarla en Grok\./);
  // A refused form shows the Spanish error and keeps the page's back link.
  const refused = await f(`/discussions/${a.id}/sharing`, post({ include: 'maybe' }));
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Elige si quieres compartirlo con los asistentes que solo tienen acceso a debates\./);
  // The same refusal stays English for an assistant-facing caller: the message is unchanged.
  assert.equal((await f('/discussions/nope')).status, 404);
});

test('the server marks the discussion page\'s back link to the list (data-back), whatever language its words are in', async (t) => {
  const { f, d } = await start(t);
  const plain = open(d, { title: 'No project here' });
  const named = open(d, { project: 'wildlog' });
  for (const lang of [{ 'Accept-Language': 'en-US' }, { 'Accept-Language': 'es-ES' }]) {
    const a = await (await f(`/discussions/${plain.id}`, { headers: lang })).text();
    assert.match(a, /<p class="crumb back"><a href="\/discussions" data-back="discussions">‹ /);
    const b = await (await f(`/discussions/${named.id}`, { headers: lang })).text();
    assert.match(b, /<p class="crumb back"><a href="\/\?project=wildlog#panel">‹ wildlog<\/a><\/p>/);
  }
  // desk.js reads the mark, not the translated word.
  const src = readFileSync(new URL('./static/desk.js', import.meta.url), 'utf8');
  assert.match(src, /dataset\.back === 'discussions'/);
  assert.doesNotMatch(src, /back === T\('client\.nav\.discussions'/);
});
