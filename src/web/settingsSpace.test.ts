/** Settings › This computer: the space BrainAI uses here (the app only). Temp folders only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { spaceBlock, spaceTotalText } from './spaceViews.js';
import type { SpaceBreakdown } from '../diskSpace.js';
import { decodeEntities } from '../testing/entities.js';

const sample: SpaceBreakdown = { total: 1_500_000_000, app: 300_000_000, models: { bytes: 900_000_000, parts: [{ label: 'Light search model', bytes: 500_000_000 }, { label: 'Standard reranker', bytes: 400_000_000 }] }, memories: 12_000, backups: 200_000_000, other: 100_000_000 };
const text = (h: { value: string }) => h.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the space block, ready', () => {
  const t = decodeEntities(text(spaceBlock(sample)));
  assert.match(t, /BrainAI uses 1\.5 GB here/);
  for (const part of ['The app itself 300 MB', 'Search models Light search model 500 MB · Standard reranker 400 MB 900 MB', 'Your memories The database and your pictures 12 KB', 'Backups on this computer 200 MB', 'Other Logs and status files 100 MB']) assert.ok(t.includes(part), part);
  assert.ok(t.includes("Copies in your second folder aren't counted."));
  assert.equal(spaceTotalText(sample), '1.5 GB');
});

test('the space block, working out and without the app line', () => {
  const w = spaceBlock(null);
  assert.match(w.value, /Working out the sizes…/);
  assert.match(w.value, /data-space="\/settings\/space"/);
  assert.doesNotMatch(w.value, /data-ready/);
  assert.equal(spaceTotalText(null), '');
  assert.doesNotMatch(text(spaceBlock({ ...sample, app: null })), /The app itself/);
});

function get(baseUrl: string, path: string, cookie = ''): Promise<{ status: number; body: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method: 'GET', setHost: false, headers: { Host: `localhost:${u.port}`, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startApp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'brainai-space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(join(data, 'logs', 'l.txt'), Buffer.alloc(2000));
  mkdirSync(join(root, 'My.app', 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(root, 'My.app', 'Contents', 'MacOS', 'node'), Buffer.alloc(5000));
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir: data, dataDir: data });
  t.after(() => app.close());
  app.deps.space = { modelDir: join(data, 'models'), execPath: join(root, 'My.app', 'Contents', 'MacOS', 'node'), platform: 'darwin' };
  return { app, cookie: await appSession(app) };
}

test('the app: the route answers the owner, the page shows the breakdown once it is in', async (t) => {
  const { app, cookie } = await startApp(t);
  let a: { ready: boolean; html?: string; total?: string } = { ready: false };
  for (let i = 0; i < 50 && !a.ready; i++) {
    const r = await get(app.baseUrl, '/settings/space', cookie);
    assert.equal(r.status, 200);
    a = JSON.parse(r.body);
    if (!a.ready) await new Promise((r2) => setTimeout(r2, 20));
  }
  assert.equal(a.ready, true);
  assert.match(a.html!, /The app itself/);
  assert.match(a.total!, /KB|MB/);
  const page = (await get(app.baseUrl, '/settings', cookie)).body;
  const section = page.slice(page.indexOf('<section id="this-device"'), page.indexOf('<section id="connections"'));
  assert.match(section, /Space on this computer/);
  assert.match(section, /The app itself/);
  assert.match(decodeEntities(section), /Copies in your second folder aren't counted/);
  assert.match(page, /<span data-space-status>BrainAI [\d.]+ · [\d.]+ [KMG]B<\/span>/);
});

test('the route is owner-only', async (t) => {
  const { app } = await startApp(t);
  const r = await get(app.baseUrl, '/settings/space');
  assert.ok(r.status === 401 || r.status === 302 || r.status === 303 || r.status === 403, String(r.status));
  assert.doesNotMatch(r.body, /"ready"/);
});

test('a server shows nothing new and has no route', async (t) => {
  const app = await startTestApp({});
  t.after(() => app.close());
  const f = await loggedIn(app);
  assert.equal((await f('/settings/space')).status, 404);
  const body = await (await f('/settings')).text();
  assert.doesNotMatch(body, /Space on this computer|data-space/);
});

test('Settings opened through the public door has no space block (its route is not there)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brainai-space-door-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  const app = await startTestApp({ localMode: true, statusDir: data, dataDir: data });
  t.after(() => app.close());
  const port = await app.deps.door!.open();
  const host = 'brainai-mac.tail1234.ts.net';
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const door = `http://127.0.0.1:${port}`;
  const form = (body: string, cookie = '') => ({ method: 'POST', headers: { Host: host, Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body, redirect: 'manual' as const });
  const login = await fetch(door + '/login', form(new URLSearchParams({ password: 'correct horse battery', code: app.nextTotp(), next: '/settings' }).toString()));
  assert.equal(login.status, 302);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const page = await fetch(door + '/settings', { headers: { Host: host, Cookie: cookie }, redirect: 'manual' });
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.doesNotMatch(body, /data-space="|Working out the sizes/);
  assert.equal((await fetch(door + '/settings/space', { headers: { Host: host, Cookie: cookie }, redirect: 'manual' })).status, 404);
});
