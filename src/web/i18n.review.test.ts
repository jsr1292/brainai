import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { clockTo, seedWildlogWeek } from '../testing/reviewFixtures.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import type { Health } from '../health/health.js';
import { healthBlock, profileBlock, quietAppsBlock } from './healthViews.js';
import { weekRange, weekRangeLong, weekSentenceT } from './reviewViews.js';
import { weekRange as weekRangeEn, weekRangeLong as weekRangeLongEn } from '../review/sentence.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const ai = { type: 'ai', name: 'Claude Code' } as const;

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-10-18T08:00:00Z') });
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
/** Words the fixtures put on the page (project names, fact and step texts): shown as they are, not a missed translation. */
const FIXTURE = [
  'wildlog', 'energy', 'brainai', 'setup', 'Claude Code', 'Codex', 'TestFlight build 0.2.2', 'Label scan on the phone', 'Cellar map sorting', 'Release 0.2.2',
  'Run ./scripts/release.sh 0.2.2', 'Label photos stay on the phone, with no cloud text reading.', 'Caught that the label scan counted drafts twice',
  'energy compares the winter tariffs', 'Pushed the demo without running the suite', 'Run npm test before every push', 'Caught the missing alias case in review',
  'The new deploy way', 'The old deploy way', 'Deploy way',
];
/** The page as the check reads it: only the fixture lookups paragraph is cut (its words are the owner's data). */
const mine = (page: string): string => page
  .replace(/<p[^>]*>Lookups[\s\S]*?<\/p>/g, '');
const inXx = async (app: Awaited<ReturnType<typeof start>>['app'], fn: () => Promise<void>) => {
  enablePseudoLocale(true);
  try { app.deps.store.setSwitch('ui_language', 'xx'); await fn(); } finally { enablePseudoLocale(false); }
};

test('the week pages (last week, so far, all weeks) have no English left under the pseudo-locale', async (t) => {
  const { app, f } = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  await app.deps.growth.note({ kind: 'improve', area: 'testing', what: 'Pushed the demo without running the suite', practise: 'Run npm test before every push', project: 'wildlog' }, 'Codex');
  await inXx(app, async () => {
    for (const path of ['/review', '/review/now', '/review/all', '/review/2026-10-19']) {
      const res = await f(path);
      assert.equal(res.status, 200, path);
      assertNoEnglishLeft(mine(await res.text()), `the week page ${path}`, { allow: FIXTURE });
    }
  });
});

test('the growth and activity pages have no English left under the pseudo-locale', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('brainai', { state: 'open', area: 'apps' }, 'owner');
  const { observation } = await app.deps.growth.note({ kind: 'improve', area: 'testing', what: 'Pushed the demo without running the suite', practise: 'Run npm test before every push', project: 'brainai' }, 'Codex');
  await app.deps.growth.note({ kind: 'strength', area: 'reviewing', what: 'Caught the missing alias case in review', project: 'brainai' }, 'Claude Code');
  app.deps.growth.react(observation.id, 'dismiss');
  const old = await app.deps.service.remember({ kind: 'decision', project: 'brainai', content: 'The old deploy way' }, ai);
  app.advance(1000);
  await app.deps.service.remember({ kind: 'decision', project: 'brainai', content: 'The new deploy way', supersedes: [(old as { memory: { id: string } }).memory.id] } as never, ai);
  await inXx(app, async () => {
    const growth = await (await f('/growth')).text();
    assertNoEnglishLeft(mine(growth), 'the growth page', { allow: FIXTURE });
    const activity = await (await f('/activity')).text();
    assertNoEnglishLeft(mine(activity), 'the activity page', { allow: FIXTURE });
    assertNoEnglishLeft(mine(await (await f('/activity?by=Codex')).text()), 'the activity page, one assistant', { allow: FIXTURE });
    // A page past the last row of a known assistant: the "nothing here" sentence names it.
    assertNoEnglishLeft(mine(await (await f('/activity?by=Codex&page=3')).text()), 'the activity page, past the end', { allow: ['Codex'] });
    // A refused Undo, and the note after an Undo.
    assertNoEnglishLeft(mine(await (await f('/activity?refused=changed&fact=abc')).text()), 'the activity page, refused', { allow: FIXTURE });
    assertNoEnglishLeft(mine(await (await f('/activity?undone=saved')).text()), 'the activity page, undone', { allow: FIXTURE });
  });
});

test('an empty activity page has no English left, and says so in Spanish', async (t) => {
  const { app, f } = await start(t);
  await inXx(app, async () => assertNoEnglishLeft(mine(await (await f('/activity')).text()), 'the empty activity page', {}));
  app.deps.store.setSwitch('ui_language', 'es');
  assert.match(await (await f('/activity')).text(), /Todavía nada\. Lo que tus asistentes guarden o cambien aparecerá aquí/);
});

test('brain health blocks have no English left under the pseudo-locale', () => {
  const health = { upToDate: { score: 80, reasons: [] }, ready: { score: 50, reasons: [] }, waiting: { score: 100, reasons: [] } } as unknown as Health;
  enablePseudoLocale(true);
  try {
    runWithLocale('xx', () => {
      assertNoEnglishLeft(healthBlock(health).value, 'brain health', {});
      assertNoEnglishLeft(profileBlock({ entries: 2, words: 2400, pairs: [{ a: { id: 'a', content: 'First entry' }, b: { id: 'b', content: 'Second entry' } }] })!.value, 'the profile block', { allow: ['First entry', 'Second entry'] });
      for (const local of [true, false]) assertNoEnglishLeft(quietAppsBlock([{ app: 'Codex', reads: 40 }, { app: 'Grok', reads: 12 }], local)!.value, `quiet apps (local ${local})`, {});
    });
  } finally { enablePseudoLocale(false); }
});

test('the week page in Spanish, through the real app: words, dates, the lit tab and the back link', async (t) => {
  const { app, f } = await start(t);
  await seedWildlogWeek(app.deps, app.advance);
  const en = await (await f('/review')).text();
  await f('/settings/language', { method: 'POST', body: new URLSearchParams({ language: 'es' }) });
  const es = await (await f('/review', { headers: ES })).text();
  assert.match(es, /<html lang="es">/);
  assert.match(es, /<h1>Semana pasada<\/h1>/);
  assert.match(es, /<title>Revisión semanal<\/title>/);
  assert.match(es, /Pendiente de ti/);
  assert.match(es, /Qué se movió/);
  assert.match(es, /lunes 26 de octubre – domingo 1 de noviembre de 2026/);
  assert.match(es, /Decidido/);
  assert.match(es, /Preparado el martes 3 de noviembre a las 08:14/);
  // The lit tab is the same as in English.
  const lit = (h: string) => /<nav class="tabs"[^>]*>.*?<\/nav>/s.exec(h)![0].replace(/>[^<]+</g, '><').replace(/aria-label="[^"]*"/, '');
  assert.equal(lit(es), lit(en));
  // A week that is not the last one links back to All weeks, and says so in Spanish.
  const older = await (await f('/review/2026-10-19', { headers: ES })).text();
  assert.match(older, /<p class="crumb back"><a href="\/review\/all">‹ Todas las semanas<\/a><\/p>/);
  assert.match(await (await f('/review/all', { headers: ES })).text(), /Una línea por semana/);
  assert.match(await (await f('/review/now', { headers: ES })).text(), /Esta semana hasta ahora/);
});

test('the growth and activity pages in Spanish, through the real app', async (t) => {
  const { app, f } = await start(t);
  app.deps.registry.create('brainai', { state: 'open', area: 'apps' }, 'owner');
  await app.deps.growth.note({ kind: 'strength', area: 'reviewing', what: 'Caught the missing alias case in review', project: 'brainai' }, 'Claude Code');
  await app.deps.service.remember({ kind: 'decision', project: 'brainai', content: 'Codex saved this decision about caching' }, { type: 'ai', name: 'Codex' });
  await f('/settings/language', { method: 'POST', body: new URLSearchParams({ language: 'es' }) });
  const growth = await (await f('/growth', { headers: ES })).text();
  assert.match(growth, /<title>Crecimiento<\/title>/);
  assert.match(growth, /Puntos fuertes/);
  assert.match(growth, /Revisar el trabajo de las IA/);
  assert.match(growth, />De acuerdo<\/button>/);
  assert.match(growth, /anotado una vez/);
  const activity = await (await f('/activity', { headers: ES })).text();
  assert.match(activity, /<title>Actividad<\/title>/);
  assert.match(activity, /<h2>Hoy<\/h2>/);
  assert.match(activity, /Codex<\/span> <span class="verb">guardó<\/span>/);
  assert.match(activity, /Deshacer<span class="visually-hidden"> este guardado de Codex<\/span>/);
  assert.match(await (await f('/activity?by=Codex&page=3', { headers: ES })).text(), /Codex no ha guardado ni cambiado nada en esta página\./);
  // A refused Undo says so in Spanish too.
  const refused = await (await f('/activity?refused=changed&fact=abc', { headers: ES })).text();
  assert.match(refused, /No se ha deshecho: ese dato cambió después/);
});

test('English week ranges and sentences are what the review module always printed, and Spanish reads naturally', () => {
  for (const monday of ['2026-10-26', '2026-10-19', '2025-12-29', '2026-03-30']) {
    assert.equal(weekRange(monday), weekRangeEn(monday), monday);
    assert.equal(weekRangeLong(monday), weekRangeLongEn(monday), monday);
  }
  assert.equal(weekRangeLong('2026-11-02', '2026-11-03'), weekRangeLongEn('2026-11-02', '2026-11-03'));
  const facts = { steps: [{ project: 'wildlog', n: 4, nameable: true }, { project: 'energy', n: 1, nameable: true }], late: 2, dated: 3, quiet: ['a', 'b', 'c'], somethingElse: true };
  assert.equal(weekSentenceT(facts, { lead: true, soFar: false }), 'A good week for wildlog: 5 steps done across 2 projects. 2 things are late, and 3 projects went quiet.');
  assert.equal(weekSentenceT({ ...facts, steps: [{ project: 'wildlog', n: 1, nameable: true }], late: 1, quiet: ['x'] }, { lead: true, soFar: true }), 'So far: 1 step done, in wildlog. 1 thing is late, and x went quiet.');
  assert.equal(weekSentenceT({ ...facts, steps: [], late: 0, dated: 0, quiet: [], somethingElse: false }, { lead: true, soFar: false }), 'A quiet week. Nothing moved.');
  runWithLocale('es', () => {
    assert.equal(weekRange('2026-10-26'), '26 oct – 1 nov');
    assert.equal(weekRange('2026-10-19'), '19 – 25 oct');
    assert.equal(weekRange('2025-12-29'), '29 dic 2025 – 4 ene 2026');
    assert.equal(weekRangeLong('2026-10-26'), 'lunes 26 de octubre – domingo 1 de noviembre de 2026');
    assert.equal(weekSentenceT(facts, { lead: true, soFar: false }), 'Una buena semana para wildlog: 5 pasos hechos en 2 proyectos. 2 cosas van con retraso y 3 proyectos se quedaron en silencio.');
    assert.equal(weekSentenceT({ ...facts, steps: [{ project: 'wildlog', n: 1, nameable: true }], late: 1, quiet: ['x'] }, { lead: true, soFar: true }), 'Hasta ahora: 1 paso hecho, en wildlog. 1 cosa va con retraso y x se quedó en silencio.');
  });
});

test('the safety notes and the Tidy line have no English left, and read in Spanish', async (t) => {
  const { app, f } = await start(t);
  const d = app.deps;
  const save = (content: string, embedding: number[]) => d.store.insert({ kind: 'decision', content, project: 'wildlog', tags: [], embedding: new Float32Array(embedding), by: 'owner' });
  save('old fact to delete', [0, 1, 0, 0]);
  clockTo(d, app.advance, '2026-10-28T10:00:00Z');
  d.store.softDelete(d.store.list({})[0]!.id, 'Claude Code');
  save('keep photos on the phone', [1, 0, 0, 0]);
  save('keep photos locally on the phone', [1, 0, 0, 0]);
  clockTo(d, app.advance, '2026-11-03T07:14:00Z');
  const fixtures = [...FIXTURE, 'old fact to delete', 'keep photos on the phone', 'keep photos locally on the phone', 'You' /* writerName() in dashboardViews (inbox) still says You */];
  await inXx(app, async () => assertNoEnglishLeft(mine(await (await f('/review')).text()), 'a week with safety notes and a Tidy line', { allow: fixtures }));
  d.store.setSwitch('ui_language', 'es');
  const es = await (await f('/review')).text();
  assert.match(es, /Claude Code borró un dato el miércoles 28 oct: “<a href="[^"]+">old fact to delete<\/a>”\. Restáuralo desde su historial\./);
  assert.match(es, /<p class="tidy-line">2 datos parecen duplicados\. <a href="\/facts\/tidy">Ordenar<\/a><\/p>/);
});
