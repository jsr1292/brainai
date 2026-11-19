/** The projects area (projects, pages, facts' meta lines, search, graph, five areas) in the pseudo-locale and in Spanish. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { seedFlaggedWildlog, WILDLOG_MAIN, wildlogBody } from '../testing/staleFixtures.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { factStory } from '../memory/factStory.js';
import { sourceLabel, sourceText } from '../memory/factMeta.js';
import { changedSections } from '../pages/diff.js';
import { changeLine } from './pageEditSummary.js';
import { shownSourceLabel, shownSourceText, validLine, versionMeta, heldMetaLines } from './factMetaViews.js';
import { replacedNote, replacesBox, chainList, factEvents, replacedFold, replacedCard, pickerFold } from './factViews.js';
import { firstSteps, firstStepsView } from './firstSteps.js';
import { forYouCard, forYouRows } from './forYou.js';
import { reasonSentence, stillTrueLine } from './freshnessViews.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const owner = { type: 'owner' } as const;
const ai = { type: 'ai', name: 'Claude Code' } as const;

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-10-01T09:00:00Z') });
  t.after(() => { enablePseudoLocale(false); return app.close(); });
  const seed = await seedFlaggedWildlog(app.deps, app.advance);
  const { registry, service, store } = app.deps;
  registry.setInfo('wildlog', { oneLiner: 'Fixture cellar one liner' }, 'owner');
  await service.remember({ kind: 'roadmap', content: 'Now: Fixture label scanner (2/5)\nNext: Fixture export; Fixture sync\nWaiting on you: Fixture send photos; Fixture pick icon', project: 'wildlog' }, owner);
  const sourced = (await service.remember({ kind: 'decision', content: 'Fixture permit lasts to December', project: 'wildlog', meta: { validUntil: '2026-12-31', source: 'owner_said', sourceNote: 'Fixture phone call' } } as never, owner) as { memory: { id: string } }).memory;
  // What the project panel and the pages draw when they are full: a replaced fact, five-area notes, a lesson, a discussion, a folder
  // report with a folder no project matches, a note for the AIs.
  service.supersede([seed.decisions[0]!.id], seed.decisions[1]!.id, ai);
  app.deps.learning.set('wildlog', 'auto', { status: 'done', note: 'Fixture CI note' }, 'Claude Code');
  app.deps.learning.set('wildlog', 'upkeep', { status: 'not_needed', note: 'Fixture no libraries' }, 'owner');
  app.deps.learning.recordLesson({ title: 'Fixture lesson', level: 'helped', project: 'wildlog' }, 'Claude Code');
  app.deps.discussions.open({ name: 'Claude Code', model: 'opus', access: 'full' }, { title: 'Fixture which course', question: 'Which?', project: 'wildlog', ask: ['Grok'] });
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'wildlog', git: true, branch: 'main', uncommitted: 3, unpushed: 2, lastCommit: null, remotes: [] }, { name: 'fixture-folder', git: false, branch: null, uncommitted: null, unpushed: null, lastCommit: null, remotes: [] }] as never);
  app.deps.notes.add(seed.page.id, { text: 'Fixture note port changed' });
  const f = await loggedIn(app);
  const language = (l: string) => store.setSwitch('ui_language', l);
  return { app, f, seed, sourced, language };
}

const ALLOW = ['wildlog', WILDLOG_MAIN, 'Fixture cellar one liner', 'Fixture label scanner', 'Fixture export', 'Fixture sync', 'Fixture send photos', 'Fixture pick icon', 'Fixture permit lasts to December', 'Fixture phone call', 'Fixture CI note', 'Fixture no libraries', 'Fixture lesson', 'Fixture which course', 'fixture-folder', 'Fixture note port changed', 'Mac', 'main', 'Sync: CloudKit replaced by a local SQLite file',
  'The “ready now” list sorts by drink-by year, earliest first.', 'Sync: CloudKit replaced by a local SQLite file with an iCloud Drive copy each night.', 'Barcode scanning uses VisionKit\'s DataScanner; reading the label text was dropped.',
  'wildlog syncs with CloudKit, so there is no server to run.', 'Bottles are grouped by cellar rack, not by region. The rack map is the home screen.', 'wildlog groups bottles by region, then by producer.',
  // The note a flagged page offers to leave for the next assistant is English on purpose (an assistant reads it).
  // A roadmap fact's one line keeps the roadmap's own stored labels (Now:, Next:), which are part of the stored fact.
  'Now: Fixture label scanner (2/5) · Next: Fixture export',
  // Fixture page text: a line whose `code` the checker skips, and a fact cut short by the card's ellipsis.
  'Open  , scheme  .', 'Open wildlog.xcodeproj, scheme wildlog.', 'Bottles are grouped by cellar rack, not by region. The rack…',
  'Please bring this page up to date with the decisions saved since'];

test('the screens of the projects area have no English left under the pseudo-locale', async (t) => {
  const { f, seed, language, sourced } = await start(t);
  enablePseudoLocale(true);
  language('xx');
  // The editor's buttons post a code in `value` (save, write, preview: never shown) and show the keys ⌘S / Ctrl S.
  const codes = ['S', 'zzzqqq'];
  const allow = [...ALLOW, ...codes, ...wildlogBody(seed.cloudkit.id, seed.region.id).split('\n'), ...wildlogBody(seed.cloudkit.id, seed.region.id).split('\n').map((l) => l.replace(/^(#+|-)\s+/, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').replace(/\s*\[\[fact:[^\]]*\]\]/, '')).filter((l) => l !== '')];
  const paths = ['/', '/?project=wildlog', '/?pane=projects', '/pages', `/pages/${seed.page.id}`, `/pages/${seed.page.id}/edit`, `/pages/${seed.page.id}/edit?section=what-it-does`, `/pages/${seed.page.id}/history`, '/pages/new', '/pages/new?project=wildlog', '/search?q=wildlog', '/search', '/search?q=zzzqqq', '/graph', '/map'];
  for (const p of paths) {
    const res = await f(p, { headers: { 'Accept-Language': 'en' } });
    assert.equal(res.status, 200, p);
    const wanted: Record<string, RegExp[]> = {
      '/?project=wildlog': [/class="pfold"/, /class="area-row"/, /class="plain-list handbook"/, /class="gitline"/, /class="fold notinbrain"/, /class="pdiscs/, /class="ppages/, /class="checks"/],
      [`/pages/${seed.page.id}`]: [/class="pnotes"/, /class="stale"/, /class="live live-full"/, /class="timeline"/, /class="asknote/],
    };
    // The panel and the page above must really be full, or "no English left" would prove little.
    const body = await res.text();
    for (const re of wanted[p] ?? []) assert.match(body, re, `${p} draws ${re}`);
    // The Pages/Skills/Facts strip (pagesSubnav, skillViews.ts) is the skills area's: left out of the check.
    assertNoEnglishLeft(body.replace(/<nav class="subnav"[\s\S]*?<\/nav>/g, ''), p, { allow });
  }
  // The list view of the Graph is remembered in a cookie.
  const list = await f('/graph', { headers: { 'Accept-Language': 'en', Cookie: 'graph-view=list' } });
  assert.equal(list.status, 200);
  assertNoEnglishLeft(await list.text(), 'graph list', { allow });
  // The facts the screens above only link to: the fact page is the inbox area's, so only the lines this area draws are checked here.
  void sourced;
});

test('the lines the fact pages are made of have no English left under the pseudo-locale', async (t) => {
  const { app, seed, sourced } = await start(t);
  enablePseudoLocale(true);
  const now = new Date('2026-11-18T09:00:00Z');
  const m = app.deps.store.get(sourced.id)!;
  const old = seed.decisions[0]!, newer = seed.decisions[1]!;
  const story = factStory(app.deps.store, old.id)!;
  const allow = [...ALLOW, old.content, newer.content];
  const check = (name: string, out: { value: string } | string) => assertNoEnglishLeft(typeof out === 'string' ? out : out.value, name, { allow });
  runWithLocale('xx', () => {
    check('validLine', validLine({ validUntil: '2026-12-31' }, now));
    check('validLine past', validLine({ validUntil: '2026-01-31' }, now));
    check('source labels', ['owner_said', 'inferred', 'imported', 'from_file'].flatMap((s) => [shownSourceLabel(s as never, 'owner'), shownSourceLabel(s as never, 'Cursor'), shownSourceLabel(s as never, null), shownSourceText(s as never, 'Cursor', 'a quote')]).map((x) => `<p>${x}</p>`).join(''));
    check('versionMeta', versionMeta({ validUntil: '2026-12-31', source: 'inferred', sourceBy: 'Cursor' }));
    check('heldMetaLines', heldMetaLines({ action: 'update', validUntil: '2026-12-31', source: 'inferred', suggestedBy: 'Cursor', sourceBy: 'Cursor' }, { validUntil: '2026-06-30', source: 'owner_said', sourceBy: 'owner', sourceNote: null }, true, { validUntil: '2026-12-31', source: 'inferred', sourceBy: 'Cursor', sourceNote: null }));
    check('replacedNote', replacedNote(story, now));
    check('replacesBox', replacesBox(factStory(app.deps.store, newer.id)!, now));
    check('chainList', chainList(story, 'decision', now));
    check('factEvents', factEvents([], now));
    const detail = app.deps.projects.detail('wildlog', now)!;
    check('replacedFold', replacedFold('wildlog', detail.replaced, now));
    const [item] = app.deps.store.supersessions.replacedList({ limit: 5, offset: 0 });
    assert.ok(item);
    check('replacedCard', replacedCard({ row: item.row, old: item.old, next: item.next, nextReplaced: false }, now));
    check('pickerFold', pickerFold(app.deps.store.get(newer.id)!, app.deps.service.pickerChoices(newer.id, false)!, false, now, true));
    check('pickerFold all', pickerFold(app.deps.store.get(newer.id)!, app.deps.service.pickerChoices(newer.id, true)!, true, now, true));
    check('factEvents with history', factEvents(app.deps.store.history(m.id).map((entry) => ({ type: 'edit' as const, at: entry.changedAt, entry })), now));
  });
});

test('first steps, For you and the freshness lines have no English left under the pseudo-locale', async (t) => {
  const { app, seed } = await start(t);
  enablePseudoLocale(true);
  const grants = app.deps.provider.listGrants();
  const allow = ['wildlog', 'Fixture'];
  runWithLocale('xx', () => {
    for (const localMode of [true, false]) {
      const steps = firstSteps({ localMode, grants, hasMemory: false, backupElsewhere: false, canHide: true });
      assertNoEnglishLeft(firstStepsView(steps, true, localMode).value, `first steps ${localMode}`, { allow });
    }
    const week = { monday: '2026-11-09', dates: 'Fixture dates', text: 'Fixture sentence' };
    const sugs = [
      { project: 'wildlog', kind: 'pin-late' as const, text: 'wildlog has something late: put it on the go?', state: 'open' as const, weeks: null },
      { project: 'wildlog', kind: 'park-quiet' as const, text: 'wildlog has been quiet for 6 weeks: park it?', state: 'open' as const, weeks: 6 },
      { project: 'wildlog', kind: 'reopen-active' as const, text: 'wildlog is parked but has new activity: back to open?', state: 'parked' as const, weeks: null },
    ];
    const rows = forYouRows({ approvals: { count: 2, first: null }, discussions: [{ id: 'd1', title: 'Fixture talk' }], weekLine: week, suggestions: sugs });
    assertNoEnglishLeft(forYouCard(rows).value, 'for you', { allow: [...allow, 'Fixture talk', 'Fixture dates', 'Fixture sentence'] });
    const one = forYouRows({ approvals: { count: 0, first: null }, discussions: [{ id: 'd1', title: 'Fixture talk' }, { id: 'd2', title: 'Fixture two' }], weekLine: null, suggestions: [] });
    assertNoEnglishLeft(forYouCard(one).value, 'for you, two discussions', { allow });
    const flag = app.deps.pages.freshness.forPage(seed.page, { hints: true })!;
    assert.ok(flag);
    assertNoEnglishLeft(`<p>${reasonSentence(flag).value}</p>`, 'reason', { allow });
    assertNoEnglishLeft(stillTrueLine({ ...seed.page, caughtUp: { how: 'still_true', at: new Date().toISOString() } } as never, new Date().toISOString().slice(0, 10)).value, 'still true', { allow });
  });
});

test('Spanish: Projects, a project panel and a fact page are in Spanish, with the same tab and back link as in English', async (t) => {
  const { f, language, sourced, seed } = await start(t);
  const tabAndBack = (html: string) => ({
    tabs: [...html.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((x) => x[1]),
    back: /<a class="top-back" href="([^"]*)">/.exec(html)?.[1] ?? null,
  });
  const get = async (path: string, lang: string) => { language(lang); return (await f(path)).text(); };
  for (const [path, es] of [
    ['/', [/<h1>Proyectos/, /Cinco áreas/, /Añadir idea/, /placeholder="Una idea…"/]],
    ['/?project=wildlog', [/Dónde lo dejaste/, /Esperando algo de ti/, /Cinco áreas/, /Fixture cellar one liner/, /Gestionar/, /‹ Todos los proyectos/, /Tu trabajo está a salvo/]],
    [`/memories/${sourced.id}`, [/Válido hasta/, /Fuente: Lo dijiste tú · «Fixture phone call»|Fuente: Lo dijiste tú · “Fixture phone call”/]],
    [`/pages/${seed.page.id}`, [/Puede estar desactualizada/, /Notas? para las IA|Pedir a una IA que la actualice/, /En esta página/, /Escrita por/]],
    ['/pages', [/<h1>Páginas<\/h1>/, /Actualizadas hace poco/]],
    ['/search?q=wildlog', [/Resultados para/, /<h2>Proyectos<\/h2>/]],
    ['/map', [/<h1>Cinco áreas<\/h1>/, /Hecho, semana a semana|Nada pendiente de aprender|Tu manual/]],
  ] as [string, RegExp[]][]) {
    const en = await get(path, 'en'), sp = await get(path, 'es');
    assert.match(sp, /<html lang="es">/, path);
    for (const re of es) assert.match(sp, re, `${path} ${re}`);
    assert.deepEqual(tabAndBack(sp), tabAndBack(en), `${path}: same lit tab and back link`);
  }
});

test('in English the screen wording equals the stored wording it mirrors (sources, change lines)', () => {
  for (const source of ['owner_said', 'inferred', 'imported', 'from_file'] as const) {
    for (const by of ['owner', 'Claude Code', null, undefined]) {
      assert.equal(shownSourceLabel(source, by), sourceLabel(source, by), `${source} by ${by}`);
      assert.equal(shownSourceText(source, by, 'a quote'), sourceText(source, by, 'a quote'), `${source} by ${by} with a note`);
    }
  }
  const many = (x: string) => ['Lead.', ...['A', 'B', 'C', 'D', 'E'].map((h) => `## ${h}\n${x}`)].join('\n');
  for (const [before, after] of [['', 'Lead.\n## A\nx'], ['Lead.', 'New lead.'], ['Lead.\n## A\nx', 'Lead.\n## A\nx'], [many('1'), many('2')], ['Lead.\n## Old\nz\n## Stack\nx', 'Lead.\n## Stack\ny\n## Run\nr']] as [string, string][]) {
    assert.equal(changeLine(before, after), changedSections(before, after));
  }
});

test('in Spanish the change line and the source labels read in Spanish', () => {
  runWithLocale('es', () => {
    assert.equal(changeLine('', 'x'), 'creada');
    assert.equal(changeLine('Lead.', 'New lead.'), 'Introducción: cambiada');
    assert.equal(shownSourceLabel('owner_said', 'owner'), 'Lo dijiste tú');
    assert.equal(shownSourceLabel('inferred', 'Cursor'), 'Deducido por Cursor');
    assert.equal(shownSourceLabel('inferred', null), 'Deducido por un asistente');
    assert.equal(shownSourceText('owner_said', 'Cursor', 'vale'), 'Cursor dice que dijiste: “vale”');
  });
});
