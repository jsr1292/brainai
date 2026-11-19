import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession, startTestApp, TEST_PASSWORD } from '../testing/helpers.js';
import { versionPanel, type VersionPanelInput } from './versionViews.js';
import { checkLatestRelease } from '../desktop/releaseCheck.js';
import { BRAIN_VERSION } from '../version.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

const NOW = new Date('2026-11-10T12:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);
const base = { brain: '1.5.2', database: 12, now: NOW };
const text = (h: unknown) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([:.])/g, '$1');
const desktop = (d: Partial<NonNullable<VersionPanelInput['desktop']>> = {}): string => versionPanel({ ...base, desktop: { check: null, problem: null, update: null, ...d } }).value;
const update = { current: '1.5.2', version: '1.6.0', notes: '', state: 'available' as const };

// ---- the app's panel ----

test('app, no check yet: the version, no claim of being current, a button', () => {
  const h = desktop();
  assert.match(h, /<section id="version" class="panel">/);
  assert.match(text(h), /BrainAI 1\.5\.2 · database schema 12/);
  assert.match(text(h), /has not checked for updates yet/);
  assert.doesNotMatch(h, /latest version/);
  assert.match(h, /<a class="button secondary" href="\/app\/check-updates" data-check-link data-desk-native>Check for updates<\/a>/);
  assert.match(h, /data-since="0"/);
});

test('app, a good check a day ago: the time and "You have the latest version"', () => {
  const h = desktop({ check: { lastOkAt: nowS - 86_400 } });
  assert.match(text(h), /Last checked for updates: .*9 Nov/);
  assert.match(text(h), /You have the latest version\./);
  assert.match(h, new RegExp(`data-since="${nowS - 86_400}"`));
});

test('app, a good check from a week ago is not enough to say "latest"', () => {
  const h = desktop({ check: { lastOkAt: nowS - 7 * 86_400 } });
  assert.doesNotMatch(h, /latest version/);
  assert.match(text(h), /Last checked for updates/);
});

test('app, checks failing: the existing warning shows once, and "latest" is not claimed', () => {
  const h = desktop({ check: { lastOkAt: nowS - 86_400, failingSince: nowS - 4 * 86_400, lastFailAt: nowS - 100 }, problem: { since: '6 Nov', error: 'proxy refused the connection' } });
  assert.equal((h.match(/hasn&#39;t been able to check|hasn't been able to check/g) ?? []).length, 1);
  assert.match(h, /since 6 Nov\./);
  assert.match(h, /proxy refused the connection/);
  assert.match(h, /may be blocking github\.com/);
  assert.doesNotMatch(h, /latest version/);
});

test('app, an update is known: it is named with the Update and restart path', () => {
  const h = desktop({ check: { lastOkAt: nowS - 60 }, update });
  assert.match(text(h), /BrainAI 1\.6\.0 is available/);
  assert.match(h, /<a class="button" href="\/app\/update">Update and restart<\/a>/);
  assert.doesNotMatch(h, /latest version/);
  assert.match(desktop({ update: { ...update, state: 'failed', problem: 'No space left.' } }), /href="\/app\/update">Try again<\/a>/);
  assert.match(desktop({ update: { ...update, state: 'blocked', problem: 'Move BrainAI to Applications.' } }), /href="https:\/\/github\.com\/jsr1292\/brainai\/releases\/latest">Download BrainAI 1\.6\.0/);
  assert.match(text(desktop({ update: { ...update, state: 'downloading', percent: 40 } })), /Downloading BrainAI 1\.6\.0… 40%/);
});

test('app, checking: the Checking… line is there for the page to show, and the button rests right after a check', () => {
  const h = desktop({ check: { lastOkAt: nowS - 1000 } });
  assert.match(h, /<p class="meta" role="status" data-check-status hidden>Checking…<\/p>/);
  assert.match(h, /data-check-updates="\/settings\/version\/state"/);
  const rest = desktop({ check: { lastOkAt: nowS - 5 } });
  assert.doesNotMatch(rest, /data-check-link/);
  assert.match(text(rest), /Checked just now/);
});

// ---- a server's panel ----

const server = (s: VersionPanelInput['server'], tooSoon = false): string => versionPanel({ ...base, server: s, ...(tooSoon ? { tooSoon } : {}) }).value;

test('server, before pressing: the running version, nothing about newer, a POST button', () => {
  const h = server(null);
  assert.match(text(h), /BrainAI 1\.5\.2 · database schema 12/);
  assert.match(text(h), /only when you press the button/);
  assert.match(h, /<form method="post" action="\/settings\/version\/check"><button type="submit" class="secondary">Check for updates<\/button><\/form>/);
  assert.doesNotMatch(h, /latest version|is available/);
});

test('server, latest / newer / error', () => {
  const at = NOW.toISOString();
  assert.match(text(server({ at, result: { ok: true, version: '1.5.2', newer: false, url: 'https://x' } })), /You have the latest version\./);
  const n = server({ at, result: { ok: true, version: '1.6.0', newer: true, url: 'https://github.com/jsr1292/brainai/releases/tag/v1.6.0' } });
  assert.match(text(n), /BrainAI 1\.6\.0 is available: in ~\/memory run git pull && docker compose up -d --build/);
  assert.match(n, /<a href="https:\/\/github\.com\/jsr1292\/brainai\/releases\/tag\/v1\.6\.0"/);
  const e = server({ at, result: { ok: false, error: 'GitHub could not be reached.' } });
  assert.match(text(e), /Couldn't check for updates: GitHub could not be reached\./);
  assert.doesNotMatch(e, /latest version/);
  assert.match(text(server(null, true)), /wait a few seconds/);
});

// ---- the release request itself ----

test('checkLatestRelease asks with a generic User-Agent, reads tag_name, and never throws', async () => {
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const ok = (tag: string): typeof fetch => (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string> }; return Response.json({ tag_name: tag }); }) as never;
  const r = await checkLatestRelease('1.5.2', { url: 'http://example.test/latest', fetch: ok('v1.6.0') });
  assert.deepEqual(r, { ok: true, version: '1.6.0', newer: true, url: 'https://github.com/jsr1292/brainai/releases/tag/v1.6.0' });
  assert.equal(seen!.url, 'http://example.test/latest');
  assert.equal(seen!.headers['User-Agent'], 'BrainAI update check');
  assert.equal((await checkLatestRelease('1.5.2', { fetch: ok('1.5.2') }) as { newer: boolean }).newer, false);
  assert.equal((await checkLatestRelease('1.5.2', { fetch: ok('v1.4.0') }) as { newer: boolean }).newer, false);
  assert.equal((await checkLatestRelease('1.5.2', { fetch: ok('nightly') })).ok, false);
  assert.equal((await checkLatestRelease('1.5.2', { fetch: (async () => new Response('no', { status: 403 })) as never })).ok, false);
  const down = await checkLatestRelease('1.5.2', { fetch: (async () => { throw new Error('ENOTFOUND secret-host'); }) as never });
  assert.deepEqual(down, { ok: false, error: 'GitHub could not be reached.' });
});

test('checkLatestRelease gives up after its time limit', async () => {
  const slow = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))) as never;
  assert.deepEqual(await checkLatestRelease('1.5.2', { fetch: slow, timeoutMs: 20 }), { ok: false, error: 'GitHub did not answer in time.' });
});

// ---- routes ----

async function serverApp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ver-srv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ statusDir: dir });
  t.after(() => app.close());
  const calls: string[] = [];
  let tag = 'v99.0.0';
  app.deps.releaseApiUrl = 'http://release.invalid/latest';
  app.deps.releaseFetch = (async (url: string) => { calls.push(url); return Response.json({ tag_name: tag }); }) as never;
  const login = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const f = (path: string, init: RequestInit = {}) => fetch(app.baseUrl + path, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });
  return { app, f, calls, setTag: (x: string) => { tag = x; } };
}

test('server: nothing is checked until the button is pressed, then the answer shows on Settings', async (t) => {
  const { app, f, calls, setTag } = await serverApp(t);
  const before = await (await f('/settings')).text();
  assert.match(before, /<section id="version"/);
  assert.equal(calls.length, 0, 'opening Settings asks nobody');
  const r = await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings#version');
  assert.deepEqual(calls, ['http://release.invalid/latest']);
  assert.match(text(await (await f('/settings')).text()), /BrainAI 99\.0\.0 is available: in ~\/memory run git pull/);
  app.advance(31_000);
  setTag(`v${BRAIN_VERSION}`);
  await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.match(text(await (await f('/settings')).text()), /You have the latest version\./);
});

test('server: the check is owner-only, same-origin only, and once per 30 seconds', async (t) => {
  const { app, f, calls } = await serverApp(t);
  const anon = await fetch(app.baseUrl + '/settings/version/check', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
  assert.ok(anon.status >= 300 && anon.status !== 303 || anon.headers.get('location')?.includes('/login'), 'no session');
  assert.equal(calls.length, 0);
  const cross = await f('/settings/version/check', { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' } });
  assert.ok(cross.status >= 400);
  assert.equal(calls.length, 0);
  const noOrigin = await f('/settings/version/check', { method: 'POST', redirect: 'manual' });
  assert.ok(noOrigin.status >= 400, 'a POST with no Origin is refused');
  assert.equal(calls.length, 0);
  assert.equal((await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } })).status, 303);
  const soon = await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.equal(soon.status, 429);
  assert.match(await soon.text(), /wait a few seconds/);
  assert.equal(calls.length, 1);
  app.advance(31_000);
  assert.equal((await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } })).status, 303);
  assert.equal(calls.length, 2);
});

test('server: a failing release request is said plainly', async (t) => {
  const { app, f } = await serverApp(t);
  app.deps.releaseFetch = (async () => { throw new Error('boom'); }) as never;
  await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } });
  assert.match(text(await (await f('/settings')).text()), /Couldn't check for updates: GitHub could not be reached\./);
});

async function appPanel(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ver-app-'));
  const home = mkdtempSync(join(tmpdir(), 'ver-home-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const app = await startTestApp({ localMode: true, statusDir: dir, tools: { home, path: '/usr/bin' } });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const f = (path: string, init: RequestInit = {}) => fetch(app.baseUrl + path, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });
  return { app, dir, f };
}

test('app: Settings shows the panel from the files the app writes; the state route reports the newest check', async (t) => {
  const { app, dir, f } = await appPanel(t);
  const sec = (b: string) => b.slice(b.indexOf('<section id="version"'), b.indexOf('</section>', b.indexOf('<section id="version"')));
  const s0 = sec(await (await f('/settings')).text());
  assert.match(text(s0), /BrainAI \S+ · database schema \d+/);
  assert.match(text(s0), /has not checked for updates yet/);
  assert.deepEqual(await (await f('/settings/version/state')).json(), { at: 0 });
  const t0 = Math.floor(app.deps.now().getTime() / 1000);
  writeFileSync(join(dir, 'update-check.json'), JSON.stringify({ lastOkAt: t0 - 3600, failingSince: t0 - 600, lastFailAt: t0 - 100 }));
  assert.deepEqual(await (await f('/settings/version/state')).json(), { at: t0 - 100 });
  writeFileSync(join(dir, 'update.json'), JSON.stringify({ current: '0.0.1', version: '99.1.0', notes: '', state: 'available' }));
  const s1 = sec(await (await f('/settings')).text());
  assert.match(text(s1), /BrainAI 99\.1\.0 is available/);
  assert.match(s1, /href="\/app\/update">Update and restart/);
});

test('app: the state route is owner-only, and a server has none; the link has a fallback page', async (t) => {
  const { app, f } = await appPanel(t);
  const anon = await fetch(app.baseUrl + '/settings/version/state', { redirect: 'manual' });
  assert.ok(anon.status >= 300 && anon.status < 400 || anon.status === 404 || anon.status === 401 || anon.status === 403);
  assert.ok(!(await anon.text()).includes('"at"'));
  assert.match(await (await f('/app/check-updates')).text(), /BrainAI's own window/);
  assert.equal((await f('/settings/version/check', { method: 'POST', headers: { Origin: app.baseUrl } })).status, 404, 'the app has no GitHub check of its own');
  const { f: sf } = await serverApp(t);
  assert.equal((await sf('/settings/version/state')).status, 404);
});
