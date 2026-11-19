import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { decodeEntities } from '../testing/entities.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

async function local(t: TestContext, opts: { nightly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shelves-'));
  const home = mkdtempSync(join(tmpdir(), 'shelves-home-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  if (opts.nightly) writeFileSync(join(dir, 'backup-status.json'), JSON.stringify({ at: '2026-11-04T13:30:00Z', ok: true, copies: [{ where: join(dir, 'backups'), result: 'copied' }], counts: { facts: 1, pages: 1 } }));
  const app = await startTestApp({ localMode: true, statusDir: dir, backupDir: join(dir, 'backups'), startAt: new Date('2026-11-04T14:00:00Z'), tools: { home, path: '/usr/bin' } });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const f = (path: string, init: RequestInit = {}) => fetch(app.baseUrl + path, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });
  return { app, dir, f, cookie };
}
const ids = (body: string) => [...body.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
const index = (body: string) => [...body.matchAll(/<a class="row" href="#([a-z-]+)"><span class="txt">([^<]+)<\/span><span class="st">([\s\S]*?)<\/span><span class="chev">/g)].map((m) => [m[1], m[2], m[3]!.replace(/<[^>]+>/g, '').trim()]);
const backups = (body: string) => body.slice(body.indexOf('<section id="health"'), body.indexOf('<section id="version"'));

test("the app's Settings: This computer, Assistants, Search, Backups and copies, Other computers, Your login, Remove", async (t) => {
  const { f } = await local(t, { nightly: true });
  const body = await (await f('/settings')).text();
  // Search needs the model manager, which this app does not have: the shelf is left out (settingsSearch.test covers it).
  assert.deepEqual(ids(body), ['this-device', 'connections', 'health', 'version', 'devices', 'login', 'language', 'remove']);
  const rows = index(body);
  assert.deepEqual(rows.map((r) => r[0]), ['this-device', 'connections', 'health', 'version', 'devices', 'login', 'language', 'remove']);
  assert.deepEqual(rows.slice(1, 6).map((r) => r[1]), ['Assistants', 'Backups and copies', 'Version', 'Other computers', 'Your login']);
  assert.equal(rows[6]![1], 'Language');
  assert.match(rows[7]![1]!, /^Remove BrainAI from this /);
  assert.equal(rows[2]![2], '● Backups: all fine · 14:30');
  assert.equal(rows[5]![2], '1 browser signed in');
  assert.match(body, /<section id="remove" class="panel danger-zone">[\s\S]*href="\/settings\/remove"/);
  // Anchors other pages link to still exist.
  for (const id of ['connections', 'setup', 'backup-copy', 'health', 'devices', 'login', 'this-device', 'brain-health', 'version']) assert.match(body, new RegExp(`id="${id}"`), id);
});

test('Assistants: the added-tools line, the two groups, Set up an app, then the connections', async (t) => {
  const { f } = await local(t);
  const body = await (await f('/settings')).text();
  const a = body.slice(body.indexOf('<section id="connections"'), body.indexOf('<section id="health"'));
  const at = (x: string | RegExp) => (typeof x === 'string' ? a.indexOf(x) : a.search(x));
  const order = ['data-added-tools="/settings/tools/added"', /On this (Mac|computer) · one click, no Reach needed/, 'Tools on ', 'On the web and phone · needs Reach', 'Claude · ChatGPT · Grok', 'Reach is off.', 'Turn on Reach', 'id="setup"', 'id="connections-list"'].map(at);
  assert.ok(order.every((n) => n >= 0), String(order));
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'in this order');
  assert.match(a, /<a class="button" href="\/settings\/reach">Turn on Reach<\/a>/);
});

test('Backups and copies in the app: daily backup, Back up now, second folder with the nudge, restore line, no server-only rows', async (t) => {
  const { f } = await local(t, { nightly: true });
  const b = backups(await (await f('/settings')).text());
  assert.match(b, /Daily backup:<\/span> <time[^>]*>[^<]*<\/time> <span class="place">✓/);
  assert.match(b, /<form method="post" action="\/settings\/backup-now"><button type="submit">Back up now<\/button>/);
  assert.match(b, /Right now every backup is on this (Mac|computer)\. If the disk fails, they go with it\. Pick a folder that syncs elsewhere \(OneDrive, Dropbox\) or an external drive\./);
  assert.match(b, /href="\/settings\/save"/);
  assert.match(b, /href="\/settings\/move"/);
  assert.match(b, /To get a backup back: install BrainAI, choose <em>I have a saved BrainAI folder<\/em> on the welcome, and pick the file\./);
  assert.match(b, /Off-site and git copies are for a server: <a [^>]*>see the runbook<\/a>/);
  assert.doesNotMatch(b, /Off-site<\/span>|Git copy|Markdown export|not yet/);
  assert.match(b, /<a class="button secondary" href="\/app\/choose-folder" data-choose-folder data-desk-native>Choose folder…<\/a>/);
  assert.match(b, /<a class="button secondary" href="\/app\/reveal-backups" data-reveal-backups data-desk-native>Show in (Finder|Explorer)<\/a>/);
});

test('Brain health is its own part of Backups and copies, each score explained, after the backup lines', async (t) => {
  const { f } = await local(t, { nightly: true });
  const body = await (await f('/settings')).text();
  const b = backups(body);
  assert.ok(b.indexOf('Daily backup:') < b.indexOf('id="brain-health"'));
  for (const label of ['Up to date', 'Ready', 'Waiting on you']) assert.match(b, new RegExp(`${label}</span><span class="hp-score">\\d+</span></div>\\s*<p class="hp-what">[^<]{20,}</p>`));
  assert.match(body, /<span class="st"><span class="st-dot ok" aria-hidden="true">●<\/span> Backups: all fine/);
});

test('Back up now: the owner only, same origin only, makes a backup and shows it', async (t) => {
  const { app, dir, f } = await local(t);
  // Same origin, but no session: refused, and nothing is written.
  const no = await fetch(app.baseUrl + '/settings/backup-now', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
  assert.notEqual(no.status, 303, 'no session');
  assert.ok(no.status >= 300, 'refused, not served');
  assert.equal(existsSync(join(dir, 'backup-status.json')), false);
  const cross = await f('/settings/backup-now', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.ok(cross.status >= 400, 'another origin is refused');
  assert.equal(existsSync(join(dir, 'backup-status.json')), false);
  const ok = await f('/settings/backup-now', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/settings#health');
  assert.equal(existsSync(join(dir, 'backup-status.json')), true);
  assert.match(await (await f('/settings')).text(), /Daily backup:<\/span> <time/);
});

test("the folder the window's picker chose fills the box, absolute paths only, and is saved only by Save", async (t) => {
  const { dir, f } = await local(t);
  const picked = await (await f('/settings?folder=' + encodeURIComponent('/Volumes/Backup Drive/"x"<b>'))).text();
  assert.match(picked, /id="backup-copy-folder" name="folder" value="\/Volumes\/Backup Drive\/&quot;x&quot;&lt;b&gt;"/);
  assert.doesNotMatch(await (await f('/settings?folder=relative/path')).text(), /value="relative/);
  assert.equal(existsSync(join(dir, 'backup-copy.json')), false);
  assert.match(decodeEntities((await (await f('/app/choose-folder')).text())), /BrainAI's own window/);
});

test('a server keeps its off-site, git and Markdown rows and offers no Back up now', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shelves-srv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ statusDir: dir });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const body = await (await f('/settings')).text();
  assert.match(body, /Off-site<\/span>/);
  assert.match(body, /Git copy/);
  // #backup-copy (the first steps' backup link) has a target inside Backups and copies on a server too.
  assert.match(body, /<section id="health"[^>]*>[\s\S]*?<h2>Backups and copies<\/h2>[\s\S]*?id="backup-copy"/);
  assert.doesNotMatch(body, /Back up now|Choose folder|To get a backup back/);
  assert.equal((await f('/settings/backup-now', { method: 'POST' })).status, 404);
});
