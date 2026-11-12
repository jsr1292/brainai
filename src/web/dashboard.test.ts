import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBackupStatus } from '../backupStatus.js';
import { dashboardRoutes } from './dashboardRoutes.js';
import { suggestionCard } from './dashboardViews.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const ai = { type: 'ai', name: 'Grok' } as const;

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return app;
}

test('dashboard requires login', async (t) => {
  const app = await start(t);
  const res = await fetch(app.baseUrl + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2F');
});

test('approve with edit, reject, and escaping', async (t) => {
  const app = await start(t);
  const { deps } = app;
  const f = await loggedIn(app);
  const a = (await deps.service.remember({ kind: 'profile', content: 'Has a NAS <script>x</script>' }, ai) as any).suggestion;
  const b = (await deps.service.remember({ kind: 'profile', content: 'Lives on Mars' }, ai) as any).suggestion;
  const page = await (await f('/approvals')).text();
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<script>x/);
  const ok = await f(`/suggestions/${a.id}/approve`, { method: 'POST', body: new URLSearchParams({ content: 'Has a Synology NAS', back: '/approvals' }) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/approvals');
  assert.equal((await f(`/suggestions/${b.id}/reject`, { method: 'POST' })).status, 303);
  assert.deepEqual(deps.service.loadProfile().map((m) => m.content), ['Has a Synology NAS']);
  assert.match(await (await f('/approvals')).text(), /Nothing waits for you\. Suggestions from assistants, discussions that need your answer and possible tidy-ups land here\./);
});

test('an invalid edit re-renders Approvals with the message and status 400', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const s = (await app.deps.service.remember({ kind: 'profile', content: 'Likes tea' }, ai) as any).suggestion;
  const res = await f(`/suggestions/${s.id}/approve`, { method: 'POST', body: new URLSearchParams({ content: 'x'.repeat(1001) }) });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /<title>Inbox<\/title>/);
  assert.match(body, /class="error"/);
  assert.equal(app.deps.service.loadProfile().length, 0);
});

test('shows current and new text for update, and current text for delete', async (t) => {
  const app = await start(t);
  const { deps } = app;
  const f = await loggedIn(app);
  const m = deps.store.insert({ kind: 'profile', content: 'Old fact', project: null, tags: [], embedding: new Float32Array(4), by: 'owner' });
  const d = deps.store.insert({ kind: 'profile', content: 'Fact to drop', project: null, tags: [], embedding: new Float32Array(4), by: 'owner' });
  deps.store.addSuggestion({ action: 'update', memoryId: m.id, content: 'New fact', tags: [], suggestedBy: 'Grok' });
  deps.store.addSuggestion({ action: 'delete', memoryId: d.id, content: null, tags: [], suggestedBy: 'Grok' });
  const page = await (await f('/approvals')).text();
  assert.match(page, /Old fact/);
  assert.match(page, /New fact/);
  assert.match(page, /Fact to drop/);
});

test('installable: manifest, head tags and a non-caching service worker are served', async (t) => {
  const app = await start(t);
  const get = (p: string) => fetch(app.baseUrl + p, { redirect: 'manual' });

  const mres = await get('/static/manifest.webmanifest');
  assert.equal(mres.status, 200);
  const manifest = await mres.json() as any;
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.name, 'BrainAI');
  assert.ok(manifest.icons.some((i: any) => i.purpose === 'maskable'));

  const login = await (await get('/login')).text();
  assert.match(login, /rel="manifest"/);
  assert.match(login, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(login, /<script src="\/static\/app\.js\?v=[0-9a-f]{10}" defer><\/script>/);

  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type') ?? '', /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const swBody = await sw.text();
  assert.doesNotMatch(swBody, /caches/);
  assert.doesNotMatch(swBody, /addEventListener\('fetch'/);

  for (const icon of manifest.icons) {
    const r = await get(icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  assert.equal((await get('/static/apple-touch-icon.png')).status, 200);
});

test('logged-out POSTs are sent to login and foreign origins are refused', async (t) => {
  const app = await start(t);
  for (const action of ['approve', 'reject']) {
    const res = await fetch(`${app.baseUrl}/suggestions/x/${action}`, { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl } });
    assert.equal(res.status, 302, action);
    assert.match(res.headers.get('location') ?? '', /^\/login/);
    const foreign = await fetch(`${app.baseUrl}/suggestions/x/${action}`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403, action);
  }
});

test('every route the dashboard router registers is owner-guarded', async (t) => {
  const app = await start(t);
  const stack = (dashboardRoutes(app.deps) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  const routes = stack.filter((l) => l.route).map((l) => l.route!);
  assert.ok(routes.length >= 3);
  assert.equal(stack.length, routes.length, 'only plain routes are expected; extend this test if middleware is added');
  for (const r of routes) {
    for (const method of Object.keys(r.methods)) {
      const res = await fetch(app.baseUrl + r.path.replace(/:\w+/g, 'x'), { method: method.toUpperCase(), redirect: 'manual', headers: { Origin: app.baseUrl } });
      assert.equal(res.status, 302, `${method} ${r.path}`);
      assert.match(res.headers.get('location') ?? '', /^\/login/);
    }
  }
});

test('writerKey("Grok Build") is not the Grok colour; writerKey("Grok") still is', async () => {
  const { writerKey } = await import('./dashboardViews.js');
  assert.equal(writerKey('Grok'), 'grok');
  assert.notEqual(writerKey('Grok Build'), 'grok');
  assert.match(writerKey('Grok Build'), /^x[0-2]$/);
});

test('saving a roadmap from New memory for a project that has one opens that roadmap; the form allows roadmap length', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const r = (await app.deps.service.remember({ kind: 'roadmap', content: 'Now: x', project: 'dossiers' }, ai) as any).memory;
  const res = await f('/memories', { method: 'POST', body: new URLSearchParams({ kind: 'roadmap', content: 'Now: y\r\nNext: z', project: 'dossiers', tags: '' }) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/memories/${r.id}`);
  assert.match(await (await f('/memories/new')).text(), /maxlength="1500"/);
});

test('the home page shows when each backup copy last succeeded and warns about each problem', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ statusDir: dir });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  writeBackupStatus(dir, 'nightly', { at, ok: true, copies: [{ where: '/mnt/ssd/memory-backups', result: 'copied' }, { where: '/mnt/nas/Backups/memory-backups', result: 'skipped', detail: 'not mounted' }] });
  const home = await (await f('/settings')).text();
  assert.match(home, /<section id="health" class="panel backups attention"/);
  assert.match(home, /Nightly[\s\S]*ssd ✓[\s\S]*nas\/Backups ✗/);
  assert.match(home, /The nightly copy to \/mnt\/nas\/Backups\/memory-backups was skipped: not mounted\./);
  assert.doesNotMatch(home, /No off-site copy yet\./, 'an off-site copy that was never set up is not a problem');
  writeBackupStatus(dir, 'nightly', { at, ok: true, copies: [{ where: '/mnt/ssd/memory-backups', result: 'copied' }] });
  writeBackupStatus(dir, 'offsite', { at, ok: true, where: 'gdrive:memory-backups' });
  // The personal brain also checks the nightly git copy and Markdown export (plan 7).
  writeFileSync(join(dir, 'git-backup-status.json'), JSON.stringify({ at, ok: true }));
  writeFileSync(join(dir, 'export-status.json'), JSON.stringify({ at, ok: true }));
  const fine = await (await f('/settings')).text();
  assert.match(fine, /<section id="health" class="panel backups"/);
  assert.match(fine, /Off-site[\s\S]*Google Drive ✓/);
});

test('Facts lists facts with the project, kind and text filters, and each fact\'s page links back to it', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const m = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog uses SwiftUI', project: 'wildlog' }, ai) as any).memory;
  const page = await (await f('/facts')).text();
  assert.match(page, /<title>Facts<\/title>/);
  assert.match(page, /<h1>Facts <span class="n">1 current<\/span><\/h1>/);
  assert.match(page, /<form method="get" action="\/facts" class="frow-filters">/);
  assert.match(page, new RegExp(`href="/memories/${m.id}\\?from=%2Ffacts"`));
  assert.match(page, /<h2><a href="\/\?project=wildlog#panel">wildlog<\/a>/);
  assert.match(await (await f('/facts?project=wildlog&kind=decision')).text(), /wildlog uses SwiftUI/);
  assert.match(await (await f(`/memories/${m.id}`)).text(), /<a href="\/\?project=wildlog#panel">‹ wildlog<\/a>/);
});

test('a held roadmap suggestion can be edited up to the roadmap limit, and Reject skips the length check', () => {
  const base = { id: 's1', memoryId: 'm1', tags: [] as string[], project: 'trellis', reason: 'skips the owner\'s confirmation', suggestedAt: '2026-11-03T10:00:00Z', suggestedBy: 'Grok', status: 'pending', supersedes: [] as string[], deletedMatch: null, keys: null } as const;
  const roadmap = suggestionCard({ ...base, action: 'update', kind: 'roadmap', content: 'Now: ' + 'x'.repeat(1300) }, 'Now: old', { back: '/approvals' }).value;
  assert.match(roadmap, /<textarea name="content" rows="4" maxlength="1500">/);
  assert.match(roadmap, /<button type="submit" formaction="\/suggestions\/s1\/reject" formnovalidate class="ghost push-right">Reject<\/button>/);
  const decision = suggestionCard({ ...base, action: 'add', kind: 'decision', content: 'Use Postgres' }, undefined, { back: '/' }).value;
  assert.match(decision, /<textarea name="content" rows="4" maxlength="1000">/);
});

test('a held save shows the search words it carries, so a keys-only change is visible before approval', () => {
  const base = { id: 's1', memoryId: 'm1', tags: [] as string[], project: null, reason: null, suggestedAt: '2026-11-03T10:00:00Z', suggestedBy: 'Claude', status: 'pending', supersedes: [] as string[], deletedMatch: null } as const;
  const card = suggestionCard({ ...base, action: 'update', kind: 'profile', content: 'Drinks tea', keys: 'té mañana' }, 'Drinks tea', { back: '/approvals' }).value;
  assert.match(card, /<p class="sg-keys">Search words: té mañana<\/p>/);
  const keeps = suggestionCard({ ...base, action: 'update', kind: 'profile', content: 'Drinks coffee', keys: null }, 'Drinks tea', { back: '/approvals' }).value;
  assert.doesNotMatch(keeps, /sg-keys/);
});
