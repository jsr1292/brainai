/** The welcome's recovery from a chosen folder (desktop): find, preview, confirm. Temp folders only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import Database from 'better-sqlite3';
import { fakeHome } from '../testing/fakeTools.js';
import { appSession, makePages, makeService, startTestApp } from '../testing/helpers.js';
import { openDb } from '../db.js';
import { packArchive } from '../saved/archive.js';
import { backupNow } from '../backup.js';
import { cleanImage } from '../images/clean.js';
import { pngWithText } from '../testing/imageFixtures.js';
import { renameSync, symlinkSync } from 'node:fs';

const KEY = 'a-made-up-app-key-for-find-0123456789';
const T = new Date('2026-11-06T10:00:00Z');

function dir(t: TestContext, prefix = 'brainai-find-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function start(t: TestContext) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = dir(t, 'brainai-status-');
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, appSecret: KEY, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, system: {} } });
  t.after(() => app.close());
  const cookie = await appSession({ baseUrl: app.baseUrl, deps: { appSecret: KEY } });
  return { app, cookie, dataDir: statusDir };
}

const page = (baseUrl: string, path: string, cookie: string, lang?: string) => fetch(baseUrl + path, { headers: { Cookie: cookie, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(lang ? { 'Accept-Language': lang } : {}) } }).then(async (r) => ({ status: r.status, body: await r.text() }));
const find = (baseUrl: string, path: unknown, key: string | null = KEY) =>
  fetch(baseUrl + '/welcome/restore/find', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === null ? {} : { 'X-App-Key': key }) }, body: JSON.stringify({ path }) });
/** The token the preview carries for the choice. */
async function tokenOf(baseUrl: string, cookie: string): Promise<string> {
  const body = (await page(baseUrl, '/welcome?restore=found', cookie)).body;
  return /name="token" value="([0-9a-f]+)"/.exec(body)?.[1] ?? 'none';
}
const confirm = async (baseUrl: string, cookie: string, o: { token?: string; json?: boolean } = {}) =>
  fetch(baseUrl + '/welcome/restore/confirm', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...(o.json ? { Accept: 'application/json' } : {}) }, body: new URLSearchParams({ token: o.token ?? await tokenOf(baseUrl, cookie) }) });

/** A backup folder: memory-<day>.db files (with `pictures` live picture rows) and images beside them, `have` of them present. */
async function backupFolder(t: TestContext, o: { days?: string[]; pictures?: number; have?: number } = {}): Promise<string> {
  const folder = dir(t, 'brainai-copy-');
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'garden-club-site', content: 'The site is plain HTML' }, { type: 'owner' });
  const p = await makePages(given, () => T).create({ title: 'Garden club setup', area: 'apps', body: 'Run it.' }, 'owner');
  const ids: string[] = [];
  // A real PNG: restore runs pictures through the cleaning uploads get, which drops anything else.
  const png = cleanImage(await pngWithText()).bytes;
  for (let i = 0; i < (o.pictures ?? 0); i++) {
    const id = `${i.toString(16)}`.repeat(24).slice(0, 24);
    ids.push(id);
    given.db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by, page_id) VALUES (?, 'png', 1, 1, 1, '2026-11-06', 'owner', ?)").run(id, (p as { id: string }).id);
  }
  const file = await backupNow(given.db, dir(t, 'brainai-bk-'), 1, T);
  for (const day of o.days ?? ['2026-11-06']) copyFileSync(file, join(folder, `memory-${day}.db`));
  ids.slice(0, o.have ?? ids.length).forEach((id) => {
    mkdirSync(join(folder, 'images', id.slice(0, 2)), { recursive: true });
    writeFileSync(join(folder, 'images', id.slice(0, 2), `${id}.png`), png);
  });
  return folder;
}

test('find: no candidate in the folder is a 422 with a plain message, and the page says it once', async (t) => {
  const { app, cookie } = await start(t);
  const empty = dir(t);
  writeFileSync(join(empty, 'notes.txt'), 'x');
  writeFileSync(join(empty, 'memory-2026-11-06.db'), 'not a database');
  const r = await find(app.baseUrl, empty);
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /No saved copy was found/);
  assert.match((await page(app.baseUrl, '/welcome?restore=1', cookie)).body, /No saved copy was found/);
  assert.doesNotMatch((await page(app.baseUrl, '/welcome?restore=1', cookie)).body, /No saved copy was found/, 'said once');
});

test('find: a database that is not a BrainAI copy is refused', async (t) => {
  const { app } = await start(t);
  const folder = dir(t);
  const db = new Database(join(folder, 'memory-2026-11-06.db'));
  db.exec('CREATE TABLE x(a)');
  db.close();
  const r = await find(app.baseUrl, folder);
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /cannot be brought back/);
});

test('find: picks the newest backup by the date in its name and counts the pictures found and missing', async (t) => {
  const { app, cookie } = await start(t);
  const folder = await backupFolder(t, { days: ['2026-11-01', '2026-11-05', '2026-11-03'], pictures: 3, have: 2 });
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.equal(shown.status, 200);
  assert.match(shown.body, /memory-2026-11-05\.db/);
  assert.match(shown.body, /Saved on 2026-11-05/);
  assert.match(shown.body, /1 fact/);
  assert.match(shown.body, /1 page/);
  assert.match(shown.body, /2 of 3 pictures found/);
  assert.match(shown.body, /1 picture is not in this folder; it will be left out\./);
  assert.match(shown.body, /action="\/welcome\/restore\/confirm"/);
  assert.match(shown.body, /Bring it back/);
  assert.match(shown.body, /Choose another folder/);
  const es = await page(app.baseUrl, '/welcome?restore=found', cookie, 'es');
  assert.match(es.body, /2 de 3 imágenes encontradas/);
  assert.match(es.body, /1 imagen no está en esta carpeta; se quedará fuera\./);
  assert.match(es.body, /Recuperarla/);
  assert.match(es.body, /Elegir otra carpeta/);
});

test('find: with every picture there nothing is said to be missing, and a copy with no pictures shows no pictures line', async (t) => {
  const { app, cookie } = await start(t);
  const folder = await backupFolder(t, { days: ['2026-11-01'], pictures: 2 });
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(shown.body, /2 of 2 pictures found/);
  assert.doesNotMatch(shown.body, /will be left out/);
  const none = await backupFolder(t, { pictures: 0 });
  assert.equal((await find(app.baseUrl, none)).status, 200);
  assert.doesNotMatch((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /pictures? found/);
  const one = await backupFolder(t, { pictures: 1 });
  assert.equal((await find(app.baseUrl, one)).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /1 of 1 picture found/);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie, 'es')).body, /1 de 1 imagen encontrada/);
});

test('find: the date in the name decides, not the mtime; an archive by BrainAI name competes, an unrelated .tar.gz never does', async (t) => {
  const { app, cookie } = await start(t);
  const folder = await backupFolder(t, { days: ['2026-11-01', '2026-11-08'] });
  const given = makeService({ now: () => T });
  await given.service.remember({ kind: 'decision', project: 'x', content: 'Archive fact' }, { type: 'owner' });
  const src = dir(t);
  const unrelated = join(folder, 'holiday-photos.tar.gz');
  await packArchive(given.db, src, unrelated, T);
  utimesSync(unrelated, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
  // An old-named archive with a brand-new mtime still loses to a newer backup.
  const old = join(folder, 'brainai-saved-2026-11-02.tar.gz');
  await packArchive(given.db, src, old, T);
  utimesSync(old, new Date('2031-01-01T00:00:00Z'), new Date('2031-01-01T00:00:00Z'));
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /memory-2026-11-08\.db/);
  const newer = join(folder, 'brainai-saved-2026-11-10 (1).tar.gz');
  await packArchive(given.db, src, newer, T);
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /brainai-saved-2026-11-10 \(1\)\.tar\.gz/);
});

test('find: falls back from a corrupt newest backup and says a newer file could not be used', async (t) => {
  const { app, cookie } = await start(t);
  const folder = await backupFolder(t, { days: ['2026-11-01'] });
  const broken = join(folder, 'memory-2026-11-09.db');
  const bad = new Database(broken);
  bad.exec('CREATE TABLE x(a)');
  bad.close();
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(shown.body, /memory-2026-11-01\.db/);
  assert.match(shown.body, /memory-2026-11-09\.db could not be used: /);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie, 'es')).body, /No se ha podido usar memory-2026-11-09\.db: /);
});

test('find: a folder that cannot be opened has its own message', async (t) => {
  const { app, cookie } = await start(t);
  const r = await find(app.baseUrl, join(dir(t), 'no-such-drive'));
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /could not open that folder/);
  assert.match((await page(app.baseUrl, '/welcome?restore=1', cookie, 'es')).body, /no ha podido abrir esa carpeta/);
});

test('find: a picture file that is a link is not counted, and not copied either', async (t) => {
  const { app, cookie, dataDir } = await start(t);
  const folder = await backupFolder(t, { pictures: 1, have: 0 });
  const real = join(dir(t), 'real.png');
  writeFileSync(real, 'png');
  mkdirSync(join(folder, 'images', '00'), { recursive: true });
  symlinkSync(real, join(folder, 'images', '00', `${'0'.repeat(24)}.png`));
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /0 of 1 picture found/);
  assert.equal((await confirm(app.baseUrl, cookie)).headers.get('location'), '/app/restart');
  assert.ok(!existsSync(join(dataDir, 'restore-pending', 'images')));
});

test('find: without the app key, or with a wrong one, is 403; a folder that is not absolute is refused', async (t) => {
  const { app } = await start(t);
  const folder = await backupFolder(t);
  assert.equal((await find(app.baseUrl, folder, null)).status, 403);
  assert.equal((await find(app.baseUrl, folder, 'wrong')).status, 403);
  assert.equal((await find(app.baseUrl, 'relative/path')).status, 400);
  assert.equal((await find(app.baseUrl, 42)).status, 400);
});

test('find: through the public door it does not exist', async (t) => {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = dir(t, 'brainai-door-');
  const app = await startTestApp({ localMode: true, statusDir, appSecret: KEY, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, system: {} } });
  t.after(() => app.close());
  const folder = await backupFolder(t);
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const status = await new Promise<number>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/welcome/restore/find', method: 'POST', setHost: false, headers: { Host: host, 'X-App-Key': KEY, 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end(JSON.stringify({ path: folder }));
  });
  assert.equal(status, 404);
  const local = await fetch(app.baseUrl.replace('127.0.0.1', 'localhost') + '/welcome/restore/find', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': KEY }, body: JSON.stringify({ path: folder }) });
  assert.equal(local.status, 200, 'same call works: ' + (await local.clone().text()).slice(0, 300));
});

test('find: a brain that already has memories refuses', async (t) => {
  const { app, dataDir } = await start(t);
  const folder = await backupFolder(t);
  const db = openDb(join(dataDir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1','decision','Larder uses shelves','larder','[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run();
  db.close();
  const r = await find(app.baseUrl, folder);
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { error: string }).error, /already has memories/);
});

test('find: a new find replaces the choice, and a choice expires after 15 minutes', async (t) => {
  const { app, cookie } = await start(t);
  const a = await backupFolder(t, { days: ['2026-11-01'] });
  const b = await backupFolder(t, { days: ['2026-11-09'] });
  assert.equal((await find(app.baseUrl, a)).status, 200);
  assert.equal((await find(app.baseUrl, b)).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /memory-2026-11-09\.db/);
  const real = app.deps.now;
  const later = new Date(real().getTime() + 16 * 60_000);
  app.deps.now = () => later;
  const gone = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(gone.body, /choice has expired/);
  assert.doesNotMatch(gone.body, /data-restore-found/);
  assert.equal((await confirm(app.baseUrl, cookie)).headers.get('location'), '/welcome?restore=1');
  app.deps.now = real;
});

test('confirm: stages from the real path, so the pictures beside it are copied, then answers {next} (JSON) or redirects', async (t) => {
  const { app, cookie, dataDir } = await start(t);
  const folder = await backupFolder(t, { pictures: 2, have: 1 });
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const r = await confirm(app.baseUrl, cookie, { json: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { next: '/app/restart' });
  assert.ok(existsSync(join(dataDir, 'restore-pending', 'memory.db')));
  assert.ok(existsSync(join(dataDir, 'restore-pending', 'images', '00', `${'0'.repeat(24)}.png`)), 'the picture beside the backup came along');
  assert.ok(!existsSync(join(dataDir, 'restore-pending', 'images', '11')), 'the missing one is not there');
  assert.equal(readFileSync(join(dataDir, 'restore-pending', 'from-database'), 'utf8'), '1', 'one picture is left out');
  const again = await confirm(app.baseUrl, cookie, { json: true, token: 'x' });
  assert.equal(again.status, 409, 'the choice was used');
  // Without JSON the answer is a redirect.
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const plain = await confirm(app.baseUrl, cookie);
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get('location'), '/app/restart');
});

test('confirm: needs the owner session, and a token that matches the choice and a file that has not changed', async (t) => {
  const { app, cookie, dataDir } = await start(t);
  const folder = await backupFolder(t);
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const anon = await fetch(app.baseUrl + '/welcome/restore/confirm', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: await tokenOf(app.baseUrl, cookie) }) });
  assert.notEqual(anon.headers.get('location'), '/app/restart');
  assert.ok(!existsSync(join(dataDir, 'restore-pending')), 'nothing staged for a request without a session');
  const wrong = await confirm(app.baseUrl, cookie, { json: true, token: 'deadbeef' });
  assert.equal(wrong.status, 409);
  assert.match(((await wrong.json()) as { error: string }).error, /copy changed/);
  assert.ok(!existsSync(join(dataDir, 'restore-pending')));
  // The file changes after it was found.
  assert.equal((await find(app.baseUrl, folder)).status, 200);
  const token = await tokenOf(app.baseUrl, cookie);
  writeFileSync(join(folder, 'memory-2026-11-06.db'), 'changed');
  assert.equal((await confirm(app.baseUrl, cookie, { json: true, token })).status, 409);
  assert.ok(!existsSync(join(dataDir, 'restore-pending')));
});

test('with no choice, confirm says so', async (t) => {
  const { app, cookie } = await start(t);
  const r = await confirm(app.baseUrl, cookie, { json: true, token: 'x' });
  assert.equal(r.status, 409);
  assert.match(((await r.json()) as { error: string }).error, /Choose the folder again/);
});

test('submitting the welcome name twice leaves one profile fact, and the brain still counts as empty', async (t) => {
  const { app, cookie, dataDir } = await start(t);
  const { isEmptyBrain } = await import('../saved/restore.js');
  for (const name of ['Alex', 'Alexandra']) {
    const r = await fetch(app.baseUrl + '/welcome/name', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name }) });
    assert.equal(r.status, 303);
  }
  const rows = app.deps.db!.prepare("SELECT content FROM memories WHERE kind = 'profile' AND deleted_at IS NULL").all() as { content: string }[];
  assert.deepEqual(rows, [{ content: 'The owner is called Alexandra.' }]);
  assert.equal(isEmptyBrain(join(dataDir, 'memory.db')), true);
});

test('the upload leaves no file behind, whatever its name', async (t) => {
  const { app, cookie, dataDir } = await start(t);
  const r = await fetch(app.baseUrl + '/welcome/restore', { method: 'POST', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/gzip' }, body: 'nope' });
  assert.equal(r.status, 415);
  assert.deepEqual(readdirSync(dataDir).filter((n) => n.startsWith('restore-upload')), []);
});

test('the restore choose page carries both ways: the folder picker (app) and the upload form (browser)', async (t) => {
  const { app, cookie } = await start(t);
  const body = (await page(app.baseUrl, '/welcome?restore=1', cookie)).body;
  assert.match(body, /Choose the folder with your copy…/);
  assert.match(body, /href="\/app\/restore\/pick"/);
  assert.match(body, /type="file"/);
  assert.match(body, /Upload a file instead/);
  assert.match((await page(app.baseUrl, '/welcome?restore=1', cookie, 'es')).body, /Elegir la carpeta con tu copia…/);
});

test('find: a newest copy from a newer BrainAI is not skipped for an older one', async (t) => {
  const { app } = await start(t);
  const folder = await backupFolder(t, { days: ['2026-11-01'] });
  const newer = join(folder, 'memory-2026-11-09.db');
  copyFileSync(join(folder, 'memory-2026-11-01.db'), newer);
  const db = new Database(newer);
  db.prepare('UPDATE schema_version SET version = 9999').run();
  db.close();
  const r = await find(app.baseUrl, folder);
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /newer BrainAI/);
});

test('submitting the welcome name leaves a longer hand-written profile fact untouched', async (t) => {
  const { app, cookie } = await start(t);
  await app.deps.service.remember({ kind: 'profile', content: 'The owner is called Sam. Sam prefers short answers and lives in Leeds.' }, { type: 'owner' });
  const r = await fetch(app.baseUrl + '/welcome/name', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Alex' }) });
  assert.equal(r.status, 303);
  const rows = app.deps.db!.prepare("SELECT content FROM memories WHERE kind = 'profile' AND deleted_at IS NULL ORDER BY content").all() as { content: string }[];
  assert.deepEqual(rows.map((x) => x.content), ['The owner is called Alex.', 'The owner is called Sam. Sam prefers short answers and lives in Leeds.']);
});

test('find: the folder that holds BrainAI saved folders is looked into one level down, and only those', async (t) => {
  const { app, cookie } = await start(t);
  const parent = dir(t, 'brainai-parent-');
  const saved = await backupFolder(t, { days: ['2026-11-04'], pictures: 1 });
  renameSync(saved, join(parent, 'BrainAI saved 2026-11-04'));
  const other = await backupFolder(t, { days: ['2026-11-09'] });
  renameSync(other, join(parent, 'Holiday stuff'));
  assert.equal((await find(app.baseUrl, parent)).status, 200);
  const shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(shown.body, /memory-2026-11-04\.db/, 'the saved folder, not the other newer one');
  assert.match(shown.body, /1 of 1 picture found/, 'the pictures beside the file are those of its own folder');
  // Two levels down is never searched.
  const deep = dir(t, 'brainai-deep-');
  mkdirSync(join(deep, 'a'));
  renameSync(await backupFolder(t), join(deep, 'a', 'BrainAI saved 2026-11-04'));
  assert.equal((await find(app.baseUrl, deep)).status, 422);
});

test('find: the second backup folder holds per-brain folders and old flat copies; the newest of them is brought back, pictures from beside it', async (t) => {
  const { app, cookie } = await start(t);
  const second = await backupFolder(t, { days: ['2026-11-01'], pictures: 1 });
  const brain = await backupFolder(t, { days: ['2026-11-05'], pictures: 1 });
  renameSync(brain, join(second, 'brainai-0123abcd'));
  assert.equal((await find(app.baseUrl, second)).status, 200);
  let shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(shown.body, /memory-2026-11-05\.db/);
  assert.match(shown.body, /1 of 1 picture found/);
  // With only the old flat copies (written before per-brain folders) restoring still works.
  const old = await backupFolder(t, { days: ['2026-11-02'] });
  assert.equal((await find(app.baseUrl, old)).status, 200);
  shown = await page(app.baseUrl, '/welcome?restore=found', cookie);
  assert.match(shown.body, /memory-2026-11-02\.db/);
});

test('find: a folder holding the folders of more than one brain is refused with a clear message; one brain folder chosen directly works', async (t) => {
  const { app, cookie } = await start(t);
  const second = dir(t, 'brainai-two-');
  renameSync(await backupFolder(t, { days: ['2026-11-05'] }), join(second, 'brainai-0123abcd'));
  renameSync(await backupFolder(t, { days: ['2026-11-03'] }), join(second, 'brainai-4567ef01'));
  const r = await find(app.baseUrl, second);
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { error: string }).error, /more than one brain\. Choose the brainai-… folder of the one you want: brainai-0123abcd \(2026-11-05\), brainai-4567ef01 \(2026-11-03\)/);
  const es = await page(app.baseUrl, '/welcome?restore=found', cookie, 'es');
  assert.match(es.body, /más de un cerebro.*brainai-0123abcd \(2026-11-05\)/s);
  assert.equal((await find(app.baseUrl, join(second, 'brainai-4567ef01'))).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /memory-2026-11-03\.db/);
});

test('find: pictures kept in the folder above a brainai-… folder (an earlier layout) are still found beside its copy', async (t) => {
  const { app, cookie } = await start(t);
  const second = await backupFolder(t, { days: ['2026-11-05'], pictures: 1 });
  mkdirSync(join(second, 'brainai-0123abcd'));
  renameSync(join(second, 'memory-2026-11-05.db'), join(second, 'brainai-0123abcd', 'memory-2026-11-05.db'));
  assert.equal((await find(app.baseUrl, join(second, 'brainai-0123abcd'))).status, 200);
  assert.match((await page(app.baseUrl, '/welcome?restore=found', cookie)).body, /1 of 1 picture found/);
});
