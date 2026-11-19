/** Settings: no English left of ours under the pseudo-locale, and the real app in Spanish. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';
import { assertNoEnglishLeft, untranslatedText } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { formatBytes, type SpaceBreakdown } from '../diskSpace.js';
import { deviceLabel } from './deviceLabel.js';
import { pictureDeleteView, pictureReviewView } from './pictureReviewViews.js';
import { spaceBlock, spaceTotalText } from './spaceViews.js';
import { versionPanel, type VersionPanelInput } from './versionViews.js';
import { settingsView, thisDevice } from './settingsViews.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const EN = { 'Accept-Language': 'en-US,en;q=0.9' };
const NOW = new Date('2026-11-10T12:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);
/** The addresses of the links marked as the current place. */
const lit = (h: string): (string | undefined)[] => [...h.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => /href="([^"]*)"/.exec(m[0])?.[1]);
const xx = <T>(fn: () => T): T => { enablePseudoLocale(true); try { return runWithLocale('xx', fn); } finally { enablePseudoLocale(false); } };

/** Not ours: the `save` and `off` a button sends as its value, and the device agent and hostname shown as they are. */
const notOurs = (x: string) => ['Logged in', 'node', 'save', 'off'].includes(x);
const mine = (html: string) => untranslatedText(html).filter((x) => !notOurs(x));

const sample: SpaceBreakdown = { total: 1_500_000_000, app: 300_000_000, models: { bytes: 900_000_000, parts: [{ label: 'Lightmodel', bytes: 500_000_000 }] }, memories: 12_000, backups: 200_000_000, other: 100_000_000 };
const base = { brain: '1.5.2', database: 12, now: NOW };
const update = { current: '1.5.2', version: '1.6.0', notes: '', state: 'available' as const };
const desktop = (d: Partial<NonNullable<VersionPanelInput['desktop']>> = {}) => versionPanel({ ...base, desktop: { check: null, problem: null, update: null, ...d } }).value;

test('the space block and the version panel have no English left', () => {
  xx(() => {
    assertNoEnglishLeft(spaceBlock(sample).value, 'space block', { allow: ['Lightmodel'] });
    assertNoEnglishLeft(spaceBlock(null).value, 'space block, working');
    assertNoEnglishLeft(spaceBlock({ ...sample, app: null }).value, 'space block, no app', { allow: ['Lightmodel'] });
    assert.equal(spaceTotalText(sample), '⟦1.5 GB⟧');
    assert.equal(formatBytes(500), '⟦less than 1 KB⟧');
    assertNoEnglishLeft(desktop(), 'version, app, no check');
    assertNoEnglishLeft(desktop({ check: { lastOkAt: nowS - 86_400 } }), 'version, app, ok');
    assertNoEnglishLeft(desktop({ check: { lastOkAt: nowS - 60 }, update }), 'version, app, update');
    assertNoEnglishLeft(desktop({ update: { ...update, state: 'failed', problem: 'No space left.' } }), 'version, app, failed', { allow: ['The update did not finish: No space left. BrainAI 1.5.2 is still running.'] });
    assertNoEnglishLeft(desktop({ update: { ...update, state: 'blocked', problem: 'Move it.' } }), 'version, app, blocked', { allow: ['Move it.'] });
    assertNoEnglishLeft(desktop({ check: { lastOkAt: nowS - 86_400, failingSince: nowS - 4 * 86_400, lastFailAt: nowS - 100 }, problem: { since: '6 Nov', error: 'proxy refused' } }), 'version, app, problem', { allow: ['proxy refused', '6 Nov'] });
    assertNoEnglishLeft(desktop({ check: { lastOkAt: nowS - 5, lastFailAt: nowS - 5 } }), 'version, app, just checked');
    const server = (s: VersionPanelInput['server'], tooSoon = false) => versionPanel({ ...base, server: s, tooSoon }).value;
    const at = NOW.toISOString();
    assertNoEnglishLeft(server(null), 'version, server');
    assertNoEnglishLeft(server(null, true), 'version, server, too soon');
    assertNoEnglishLeft(server({ at, result: { ok: true, newer: false } } as never), 'version, server, latest');
    assertNoEnglishLeft(server({ at, result: { ok: true, newer: true, version: '1.6.0', url: 'https://example.com/r' } } as never), 'version, server, newer');
    assertNoEnglishLeft(server({ at, result: { ok: false, error: 'offline' } } as never), 'version, server, failed', { allow: ['offline'] });
  });
});

test('device names and the sizes keep English as it was and follow the language', () => {
  assert.equal(deviceLabel(null), 'Unknown device');
  assert.equal(thisDevice('iPhone · Safari'), 'This iPhone');
  assert.equal(thisDevice('Windows · Edge'), 'This computer');
  assert.equal(formatBytes(1_500_000_000), '1.5 GB');
  assert.equal(formatBytes(500), 'less than 1 KB');
  assert.equal(runWithLocale('es', () => formatBytes(1_500_000_000)), '1,5 GB');
  assert.equal(runWithLocale('es', () => formatBytes(500)), 'menos de 1 KB');
  assert.equal(runWithLocale('es', () => formatBytes(340_000_000)), '340 MB');
  assert.equal(runWithLocale('es', () => thisDevice('Mac · Chrome')), 'Este Mac');
  assert.equal(runWithLocale('es', () => deviceLabel('')), 'Dispositivo desconocido');
});

async function world(t: TestContext) {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const img = a.deps.images.add(await fx.jpegWithGps(), { alt: 'Zorbcellar', by: 'Zorbbot' });
  const line = `![Zorbcellar](/images/${img.id}.jpg)`;
  const p = await a.deps.pages.create({ title: 'zorbpage', area: 'apps', body: `Lead.\n\n${line}` }, 'owner');
  await a.deps.pages.save(p.id, { base: 1, body: `Lead again.\n\n${line}` }, 'owner');
  await a.deps.pages.save(p.id, { base: 2, body: 'No picture now.' }, 'owner');
  return { a, f, img, p };
}

test('the pictures pages have no English left, in the real app and in the views', async (t) => {
  const { a, f, img, p } = await world(t);
  const allow = ['Zorbcellar', 'Zorbbot', 'zorbpage'];
  enablePseudoLocale(true);
  t.after(() => enablePseudoLocale(false));
  a.deps.store.setSwitch('ui_language', 'xx');
  assertNoEnglishLeft(await (await f('/settings/pictures')).text(), 'pictures list', { allow });
  assertNoEnglishLeft(await (await f(`/settings/pictures/${img.id}/delete`)).text(), 'pictures delete', { allow });
  assertNoEnglishLeft(await (await f('/settings/pictures/nope/delete')).text(), 'pictures, not found');
  const card = { img, page: a.deps.pages.get(p.id), versions: [1, 2] };
  assertNoEnglishLeft(runWithLocale('xx', () => pictureReviewView([card, { ...card, versions: [1], page: undefined }, { img: { ...img, alt: '' }, page: undefined, versions: [] }], true).value), 'pictures view', { allow });
  assertNoEnglishLeft(runWithLocale('xx', () => pictureDeleteView({ ...card, versions: [3] }, NOW).value), 'delete view, one version', { allow });
  assertNoEnglishLeft(runWithLocale('xx', () => pictureDeleteView({ ...card, versions: [] }, NOW).value), 'delete view, no version', { allow });
  // Delete a picture a page shows again: "Still on a page".
  const line = `![Zorbcellar](/images/${img.id}.jpg)`;
  await a.deps.pages.create({ title: 'Zorbback', area: 'apps', body: line }, 'owner');
  const still = await f(`/settings/pictures/${img.id}/delete`, { method: 'POST', body: new URLSearchParams({}) });
  assert.equal(still.status, 409);
  assertNoEnglishLeft(await still.text(), 'pictures, still on a page', { allow });
});

test('Settings, on a server and in the app, holds no English of ours under the pseudo-locale', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari/604.1' });
  enablePseudoLocale(true);
  t.after(() => enablePseudoLocale(false));
  a.deps.store.setSwitch('ui_language', 'xx');
  const server = await (await f('/settings')).text();
  assert.deepEqual(mine(server), []);
  assert.match(server, /<nav class="settings-nav" aria-label="⟦Settings⟧">/);
  assert.match(server, /⟦Backups and copies⟧/);

  const dir = mkdtempSync(join(tmpdir(), 'i18n-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: dir, backupDir: join(dir, 'backups') });
  t.after(() => app.close());
  const g = await loggedIn(app);
  app.deps.store.setSwitch('ui_language', 'xx');
  const local = await (await g('/settings')).text();
  assert.deepEqual(mine(local), []);
  assert.match(local, /⟦Remove BrainAI from this Mac⟧/);
});

test('es: Settings through the real app, with the same lit tab as English', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const en = await (await f('/settings', { headers: EN })).text();
  const es = await (await f('/settings', { headers: ES })).text();
  assert.match(es, /<html lang="es">/);
  assert.match(es, /<nav class="settings-nav" aria-label="Ajustes">/);
  assert.match(es, /<h1>Ajustes<\/h1>/);
  assert.match(es, /<p class="lede">Todo lo que mantiene tu memoria en marcha\./);
  for (const word of ['Asistentes', 'Copias de seguridad', 'Otros ordenadores', 'Tu acceso', 'Este navegador']) assert.ok(es.includes(`>${word}<`), word);
  assert.match(es, /<span class="st">Ninguno<\/span>/);
  assert.match(es, /<span class="st">1 navegador con sesión iniciada<\/span>/);
  assert.match(es, /<span class="st">Ninguno todavía<\/span>/);
  assert.match(es, /<p class="meta">0 datos · 0 proyectos · 0 páginas<\/p>/);
  assert.match(es, /<button type="submit" class="secondary">Pausar el guardado de todos los asistentes<\/button>/);
  assert.match(es, /<label>Nombre <input name="name"/);
  assert.match(es, /<button type="submit">Añadir un ordenador<\/button>/);
  assert.deepEqual(lit(es), lit(en), 'the lit tab is the same place');
});

test('es: the pictures pages, their back link and the confirmation', async (t) => {
  const { f, img } = await world(t);
  const enList = await (await f('/settings/pictures', { headers: EN })).text();
  const esList = await (await f('/settings/pictures', { headers: ES })).text();
  assert.match(esList, /<h1>Imágenes que ninguna página actual muestra<\/h1>/);
  assert.match(esList, /Zorbbot/);
  assert.match(esList, /<span>En <a href="\/pages\/[^"]+">zorbpage<\/a> · quitada en la versión 3 · las versiones 1 a 2 aún la usan<\/span>/);
  assert.match(esList, /Añadida por Zorbbot · \d+ KB/);
  assert.match(esList, /Borrar definitivamente…<\/a>/);
  assert.match(esList, /Ajustes/);
  assert.equal(esList.includes('href="/settings#health"'), enList.includes('href="/settings#health"'), 'the same back link');
  assert.deepEqual(lit(esList), lit(enList));
  assert.match(esList, /<p class="crumb back"><a href="\/settings#health">‹ Ajustes<\/a><\/p>/);
  const confirm = await (await f(`/settings/pictures/${img.id}/delete`, { headers: ES })).text();
  assert.match(confirm, /<h1>¿Borrar esta imagen definitivamente\?<\/h1>/);
  assert.match(confirm, /Las versiones 1 a 2 de la página mostrarán «Esta imagen se borró el \d+ nov 2026» en su lugar/);
  assert.match(confirm, /<a class="button secondary" href="\/settings\/pictures">Conservarla<\/a>/);
  assert.match(confirm, /class="danger">Borrar definitivamente<\/button>/);
  assert.match(confirm, /<p class="crumb back"><a href="\/settings\/pictures">‹ Imágenes<\/a><\/p>/);
  const gone = await (await f('/settings/pictures/nope/delete', { headers: ES })).text();
  assert.match(gone, /<h1>No encontrado<\/h1><p>No existe esa imagen o ya se borró definitivamente\.<\/p>/);
});

const nightly = { at: NOW.toISOString(), ok: true, counts: { facts: 3, pages: 1, images: 2 }, pictures: { missing: 1, stray: 0 } };
const view = (over: Partial<Parameters<typeof settingsView>[0]> = {}) => settingsView({
  grants: [], sessions: [], currentSessionId: undefined, projects: [], counts: { facts: 1, projects: 2, pages: 3 }, devices: [], device: 'Mac · Chrome', now: NOW,
  backups: { status: { nightly }, health: { ok: false, problems: [] }, offsite: false }, pictures: { count: 2, bytes: 5000, unused: 1 }, ...over,
});

test('the whole Settings view, with every notice and form, has none of our English left', () => {
  const devices = [
    { id: 'd1', name: 'Zorbbook', createdAt: '2026-11-01T10:00:00Z', lastReportAt: '2026-11-05T10:00:00Z', revokedAt: null },
    { id: 'd2', name: 'Zorbtwo', createdAt: '2026-11-01T10:00:00Z', lastReportAt: null, revokedAt: null },
  ];
  const copy = { keep: 14, folder: null, last: null };
  xx(() => {
    const allow = ['Zorbbook', 'Zorbtwo', 'brain_dev_TOKEN', 'Zorbpick', 'Zorbfolder', 'Zorbwhy', 'Zorbcloud', 'Lightmodel'];
    const check = (name: string, h: { value: string }) => assert.deepEqual(untranslatedText(h.value, { allow }).filter((x) => !notOurs(x)), [], name);
    const app = { localMode: true, version: { brain: '1.5.2', database: 12 }, space: sample, backupNow: true, reach: { on: true }, copy };
    check('server, plain', view());
    check('server, paused, device created', view({ savesPausedSince: '2026-11-09T10:00:00Z', devices, created: { name: 'Zorbbook', token: 'brain_dev_TOKEN' }, error: undefined }));
    check('app', view({ ...app, said: { backupNow: null, copy: null } }));
    check('app, reach off, working out space', view({ ...app, reach: { on: false }, space: null }));
    check('app, backup copy chosen and failed', view({ ...app, copy: { keep: 14, folder: 'Zorbfolder', last: { ok: false, at: NOW.toISOString(), folder: 'Zorbfolder', reason: 'Zorbwhy' } as never, picked: 'Zorbpick' } }));
    check('app, backup copy ok', view({ ...app, copy: { keep: 14, folder: 'Zorbfolder', last: { ok: true, at: NOW.toISOString(), folder: 'Zorbfolder' } as never } }));
    check('app, a synced folder waits for a yes', view({ ...app, copy: { keep: 14, folder: null, last: null, ask: { folder: 'Zorbfolder', cloud: 'Zorbcloud' } } }));
    check('windows', view({ ...app, device: 'Windows · Edge' }));
  });
});
