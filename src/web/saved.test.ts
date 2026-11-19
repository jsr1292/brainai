/** Save a copy of everything: Settings in the app, and the dashboard on a server. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savedHooks } from './savedRoutes.js';
import { savedDone } from './savedViews.js';
import { removeDone } from './removeViews.js';
import { loggedIn, startTestApp, TEST_PASSWORD } from '../testing/helpers.js';
import { decodeEntities } from '../testing/entities.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const PUBLIC = 'https://brainai-mac.tail1234.ts.net';

async function desktop(t: TestContext, platform: NodeJS.Platform = 'darwin') {
  const home = mkdtempSync(join(tmpdir(), 'brainai-saved-home-'));
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-saved-data-'));
  const app = await startTestApp({ localMode: true, statusDir, tools: { home, path: process.env.PATH ?? '', platform } });
  t.after(() => app.close());
  const shown: string[] = [];
  app.deps.reveal = (p) => { shown.push(p); };
  return { app, home, shown, f: await loggedIn(app) };
}

test('app: Documents not synced shows one button and saves there, then shows the folder', async (t) => {
  const { home, shown, f } = await desktop(t);
  const page = await (await f('/settings/save')).text();
  assert.match(page, /Save to Documents/);
  assert.doesNotMatch(page, /Save to your home folder/);
  assert.match(await (await f('/settings')).text(), /href="\/settings\/save"/);
  const r = await f('/settings/save', { method: 'POST', headers: FORM, body: 'where=documents' });
  const body = await r.text();
  const made = readdirSync(join(home, 'Documents')).filter((n) => n.startsWith('BrainAI saved '));
  assert.equal(made.length, 1);
  assert.ok(existsSync(join(home, 'Documents', made[0]!, 'README.txt')));
  assert.match(body, /Show in Finder/);
  await f('/settings/save/show', { method: 'POST', headers: FORM, body: '' });
  assert.deepEqual(shown, [join(home, 'Documents', made[0]!)]);
});

test('app: a synced Documents folder warns and offers the home folder first', async (t) => {
  const { home, f } = await desktop(t);
  mkdirSync(join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Documents'), { recursive: true });
  const page = await (await f('/settings/save')).text();
  assert.match(page, /Your Documents folder syncs to iCloud, so this copy would be uploaded there\./);
  assert.match(page, /Save to your home folder/);
  assert.match(page, /Save to Documents anyway/);
  await f('/settings/save', { method: 'POST', headers: FORM, body: 'where=home' });
  assert.equal(readdirSync(home).filter((n) => n.startsWith('BrainAI saved ')).length, 1);
});

test('app: Windows asks for the My Documents path through a function tests can bypass', async (t) => {
  const { f } = await desktop(t, 'win32');
  assert.match(await (await f('/settings/save')).text(), /Save to Documents/);
});

test('app: the page does not exist through the public door', async (t) => {
  const { app, home } = await desktop(t);
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(PUBLIC), port);
  const code = (method: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/settings/save', method, setHost: false, headers: { Host: new URL(PUBLIC).host, Origin: PUBLIC, ...FORM } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(method === 'POST' ? 'where=home' : undefined);
  });
  assert.equal(await code('GET'), 404);
  assert.equal(await code('POST'), 404);
  assert.equal(existsSync(join(home, 'Documents')), false);
});

async function server(t: TestContext) {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-saved-srv-'));
  const app = await startTestApp({ statusDir });
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}

test('server: asks for the authenticator code, refuses a wrong one, and streams a tar.gz with the right code', async (t) => {
  const { app, f } = await server(t);
  assert.match(await (await f('/settings/save')).text(), /authenticator/i);
  const bad = await f('/settings/save', { method: 'POST', headers: FORM, body: 'code=000000' });
  assert.equal(bad.status, 200);
  assert.match(decodeEntities(await bad.text()), /That code didn't work\./);
  const none = await f('/settings/save', { method: 'POST', headers: FORM, body: '' });
  assert.doesNotMatch(none.headers.get('content-type') ?? '', /gzip/);
  const ok = await f('/settings/save', { method: 'POST', headers: FORM, body: `code=${app.nextTotp()}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/gzip');
  assert.match(ok.headers.get('content-disposition') ?? '', /^attachment; filename="BrainAI saved \d{4}-\d{2}-\d{2}\.tar\.gz"/);
  const dir = mkdtempSync(join(tmpdir(), 'brainai-saved-dl-'));
  const file = join(dir, 'x.tar.gz');
  writeFileSync(file, Buffer.from(await ok.arrayBuffer()));
  const list = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n');
  assert.ok(list.some((l) => /^BrainAI saved \d{4}-\d{2}-\d{2}\/README\.txt$/.test(l)));
  assert.ok(list.some((l) => /^BrainAI saved \d{4}-\d{2}-\d{2}\/Markdown\/$/.test(l)));
  const archive = list.find((l) => /brainai-saved-.*\.tar\.gz$/.test(l))!;
  assert.ok(archive);
  const out = mkdtempSync(join(tmpdir(), 'brainai-saved-x-'));
  execFileSync('tar', ['-xzf', file, '-C', out]);
  const inner = mkdtempSync(join(tmpdir(), 'brainai-saved-y-'));
  execFileSync('tar', ['-xzf', join(out, archive), '-C', inner]);
  const dbFile = readdirSync(inner).find((n) => n.endsWith('.db') || n.endsWith('.sqlite'));
  assert.ok(dbFile, `a database in ${readdirSync(inner)}`);
  const sql = execFileSync('sqlite3', [join(inner, dbFile!), "select count(*) from sqlite_master where name='sessions'"], { encoding: 'utf8' }).trim();
  const rows = sql === '0' ? '0' : execFileSync('sqlite3', [join(inner, dbFile!), 'select count(*) from sessions'], { encoding: 'utf8' }).trim();
  assert.equal(rows, '0');
  // The temp folder is gone afterwards.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith('brainai-saved-tmp-')), []);
});

test("server: the download's checklist names the server's public address, as cli save-copy does", async (t) => {
  for (const [url, line] of [
    ['https://larder.example.org', 'Cloudflare: delete the tunnel and the public address larder.example.org (Zero Trust › Networks › Tunnels)'],
    ['http://localhost:3000', 'Cloudflare: delete the tunnel and the public address (Zero Trust › Networks › Tunnels)'],
  ] as const) {
    const app = await startTestApp({ statusDir: mkdtempSync(join(tmpdir(), 'brainai-saved-srv-')), publicUrl: url });
    t.after(() => app.close());
    // Forms are taken only from the public address's own pages, so this browser says it comes from there.
    const origin = new URL(url).origin;
    const login = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: origin }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    assert.equal(login.status, 302);
    const ok = await fetch(app.baseUrl + '/settings/save', { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: origin, Cookie: cookie }, body: `code=${app.nextTotp()}` });
    assert.equal(ok.status, 200);
    const dir = mkdtempSync(join(tmpdir(), 'brainai-saved-dl-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'x.tar.gz'), Buffer.from(await ok.arrayBuffer()));
    execFileSync('tar', ['-xzf', join(dir, 'x.tar.gz'), '-C', dir]);
    const folder = readdirSync(dir).find((n) => n.startsWith('BrainAI saved '))!;
    const readme = readFileSync(join(dir, folder, 'README.txt'), 'utf8');
    assert.ok(readme.split('\n').includes(`* ${line}`), readme);
  }
});

test('server: the dashboard has a row for it', async (t) => {
  const { f } = await server(t);
  assert.match(await (await f('/settings')).text(), /href="\/settings\/save"/);
});

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('brainai-saved-tmp-'));

test('server: parallel wrong codes are serialised, so the ones past the limit get 429', async (t) => {
  const { f } = await server(t);
  const rs = await Promise.all(Array.from({ length: 12 }, () => f('/settings/save', { method: 'POST', headers: FORM, body: 'code=000000' })));
  const statuses = rs.map((r) => r.status);
  assert.ok(statuses.includes(429), `statuses ${statuses}`);
  assert.ok(statuses.every((s) => s === 200 || s === 429));
  assert.ok(rs.every((r) => !/gzip/.test(r.headers.get('content-type') ?? '')));
});

test('server: a client that aborts during the copy leaves no temp folder and no tar', async (t) => {
  const { app, f } = await server(t);
  const before = leftovers();
  let release!: () => void;
  savedHooks.beforeCopy = () => new Promise<void>((r) => { release = r; });
  t.after(() => { delete savedHooks.beforeCopy; });
  const ctl = new AbortController();
  const pending = f('/settings/save', { method: 'POST', headers: FORM, body: `code=${app.nextTotp()}`, signal: ctl.signal }).catch(() => null);
  while (!release) await new Promise((r) => setTimeout(r, 10));
  assert.equal(leftovers().length, before.length + 1);
  ctl.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 100));
  release();
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(leftovers(), before);
});

test('server: a failing tar ends as a failed download, not a clean 200, and cleans up', async (t) => {
  const { app, f } = await server(t);
  const bin = mkdtempSync(join(tmpdir(), 'brainai-saved-bin-'));
  const oldPath = process.env.PATH;
  writeFileSync(join(bin, 'tar'), `#!/bin/sh\nif [ "$2" = - ]; then printf partial; exit 1; fi\nPATH=${oldPath} exec tar "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const before = leftovers();
  const r = await f('/settings/save', { method: 'POST', headers: FORM, body: `code=${app.nextTotp()}` }).then((x) => x.arrayBuffer().then(() => 'clean', () => 'failed'), () => 'failed');
  assert.equal(r, 'failed');
  await new Promise((r2) => setTimeout(r2, 300));
  assert.deepEqual(leftovers(), before);
});

test('the done pages count in words: 1 fact and 1 page', () => {
  assert.match(savedDone({ folder: '/x', facts: 1, pages: 1, revealIn: 'Finder' }).value, /Saved ✓<\/span> 1 fact and 1 page are in/);
  assert.match(removeDone({ folder: '/x', facts: 1, pages: 2, tools: [], checklist: [], kept: [], revealIn: 'Finder' }).value, /Saved ✓<\/span> 1 fact and 2 pages are in/);
});
