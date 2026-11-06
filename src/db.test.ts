import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, purgeExpired } from './db.js';

test('openDb creates every table and seeds the redirect allowlist', () => {
  const db = openDb(':memory:');
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table')`).all().map((r: any) => r.name);
  for (const t of ['memories', 'memories_fts', 'memory_history', 'profile_suggestions', 'owner', 'sessions',
    'redirect_allowlist', 'oauth_clients', 'oauth_pending', 'oauth_grants', 'oauth_codes', 'oauth_tokens']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  const entries = db.prepare('SELECT entry FROM redirect_allowlist ORDER BY entry').all().map((r: any) => r.entry);
  assert.deepEqual(entries, ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'loopback']);
});

test('openDb is idempotent on an existing file', (t) => {
  const path = join(tmpdir(), `memtest-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  openDb(path).close();
  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  assert.equal((db.prepare('SELECT count(*) c FROM redirect_allowlist').get() as any).c, 3);
});

test('purgeExpired removes expired sessions, pending, codes and long-expired tokens only', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-06-01T00:00:00Z');
  const past = '2026-05-31T23:00:00.000Z';
  const future = '2026-06-01T01:00:00.000Z';
  const longAgo = '2026-04-01T00:00:00.000Z';
  db.prepare("INSERT INTO sessions VALUES ('h1','s1',NULL,?,?,?), ('h2','s2',NULL,?,?,?)").run(past, past, past, past, past, future);
  db.prepare("INSERT INTO oauth_pending VALUES ('p1','c','{}',?), ('p2','c','{}',?)").run(past, future);
  db.prepare("INSERT INTO oauth_grants(id, client_id, created_at) VALUES ('g','c',?)").run(past);
  db.prepare(`INSERT INTO oauth_codes(code_hash, grant_id, client_id, code_challenge, redirect_uri, expires_at, used_at) VALUES
    ('expired','g','c','x','r',?,NULL), ('usedExpired','g','c','x','r',?,?), ('live','g','c','x','r',?,NULL)`).run(past, past, past, future);
  db.prepare(`INSERT INTO oauth_tokens(token_hash, grant_id, type, expires_at) VALUES
    ('old','g','refresh',?), ('recent','g','access',?), ('live','g','access',?)`).run(longAgo, past, future);

  purgeExpired(db, now);

  const col = (sql: string) => db.prepare(sql).all().map((r: any) => Object.values(r)[0]);
  assert.deepEqual(col('SELECT id FROM sessions'), ['s2']);
  assert.deepEqual(col('SELECT id FROM oauth_pending'), ['p2']);
  assert.deepEqual(col('SELECT code_hash FROM oauth_codes'), ['live']);
  assert.deepEqual(col('SELECT token_hash FROM oauth_tokens ORDER BY token_hash'), ['live', 'recent']);
  assert.deepEqual(col('SELECT id FROM oauth_grants'), ['g']);
});

test('purgeExpired deletes week-old registered clients that never got a grant', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-06-01T00:00:00Z');
  const old = '2026-05-20T00:00:00.000Z';
  const recent = '2026-05-30T00:00:00.000Z';
  const add = db.prepare("INSERT INTO oauth_clients(client_id, metadata, is_cimd, created_at) VALUES (?, '{}', ?, ?)");
  add.run('oldUnused', 0, old);
  add.run('oldGranted', 0, old);
  add.run('recentUnused', 0, recent);
  add.run('https://claude.ai/c.json', 1, old);
  db.prepare("INSERT INTO oauth_grants(id, client_id, created_at) VALUES ('g','oldGranted',?)").run(old);
  purgeExpired(db, now);
  const ids = db.prepare('SELECT client_id FROM oauth_clients ORDER BY client_id').all().map((r: any) => r.client_id);
  assert.deepEqual(ids, ['https://claude.ai/c.json', 'oldGranted', 'recentUnused']);
});

test('migration 7 gives existing grants full access', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO oauth_grants(id, client_id, created_at) VALUES ('g','c','2026-10-19T00:00:00Z')").run();
  assert.equal((db.prepare("SELECT access FROM oauth_grants WHERE id = 'g'").get() as any).access, 'full');
});

test('migration 8 records which reply a discussion file came with; earlier files count as opening files', () => {
  const db = openDb(':memory:');
  const cols = (db.prepare('PRAGMA table_info(discussion_files)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('post_id'));
});

test('migration 9 treats existing suggestions as profile changes', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO profile_suggestions(id, action, tags, suggested_at, suggested_by) VALUES ('s', 'add', '[]', '2026-10-19T00:00:00Z', 'Grok')").run();
  assert.deepEqual({ ...(db.prepare("SELECT kind, project, reason FROM profile_suggestions WHERE id = 's'").get() as object) }, { kind: 'profile', project: null, reason: null });
});

test('migration 11 lets memories be roadmaps and keeps every memory, its history and its suggestions', (t) => {
  const path = join(tmpdir(), `memtest-m11-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 10 });
  assert.throws(() => old.prepare(`INSERT INTO memories(id, kind, content, tags, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('r0', 'roadmap', 'Now: x', '[]', x'00', 'a', 'b', 'c', 'd')`).run(), /CHECK/);
  old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, last_recalled_at)
    VALUES ('m1', 'decision', 'Use SQLite', 'wildlog', '["db"]', x'0102', '2026-10-01', 'Claude', '2026-10-02', 'Grok', '2026-10-03')`).run();
  old.prepare("INSERT INTO memory_history(memory_id, action, content, project, tags, changed_at, changed_by) VALUES ('m1', 'update', 'Use files', 'wildlog', '[]', 'x', 'y')").run();
  old.prepare("INSERT INTO profile_suggestions(id, action, memory_id, content, tags, suggested_at, suggested_by) VALUES ('s1', 'update', 'm1', 'c', '[]', 'x', 'y')").run();
  old.close();

  const db = openDb(path, { upTo: 11 });
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 11);
  assert.deepEqual({ ...(db.prepare("SELECT id, kind, content, project, tags, hex(embedding) AS e, created_at, updated_by, last_recalled_at FROM memories WHERE id = 'm1'").get() as any) },
    { id: 'm1', kind: 'decision', content: 'Use SQLite', project: 'wildlog', tags: '["db"]', e: '0102', created_at: '2026-10-01', updated_by: 'Grok', last_recalled_at: '2026-10-03' });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.prepare(`INSERT INTO memories(id, kind, content, tags, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('r1', 'roadmap', 'Now: x', '[]', x'00', 'a', 'b', 'c', 'd')`).run();
  assert.throws(() => db.prepare("INSERT INTO memory_history(memory_id, action, content, project, tags, changed_at, changed_by) VALUES ('nope', 'update', 'c', null, '[]', 'x', 'y')").run(), /FOREIGN KEY/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'memories_kind'").get());
  db.close();
});

test('migration 11 checks only the tables that point at memories, and allows one active roadmap per project', (t) => {
  const path = join(tmpdir(), `memtest-m11b-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 10 });
  old.pragma('foreign_keys = OFF');
  old.prepare("INSERT INTO oauth_codes(code_hash, grant_id, client_id, code_challenge, redirect_uri, expires_at) VALUES ('h', 'missing', 'c', 'x', 'r', 'z')").run();
  old.close();
  const db = openDb(path, { upTo: 11 });
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 11);
  const ins = (id: string, deleted: string | null) => db.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, deleted_at)
    VALUES (?, 'roadmap', 'Now: x', 'p', '[]', x'00', 'a', 'b', 'c', 'd', ?)`).run(id, deleted);
  ins('r1', null);
  ins('r0', 'gone');
  assert.throws(() => ins('r2', null), /UNIQUE/);
  db.close();
});

test('migration 12 gives existing grants no project list, keeping their access level', (t) => {
  const path = join(tmpdir(), `memtest-m12-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 11 });
  old.prepare("INSERT INTO oauth_grants(id, client_id, created_at, access) VALUES ('g1', 'c1', 'x', 'discussions')").run();
  old.close();
  const db = openDb(path);
  assert.deepEqual({ ...(db.prepare("SELECT access, projects FROM oauth_grants WHERE id = 'g1'").get() as any) }, { access: 'discussions', projects: null });
  db.close();
});

test('migration 13 backfills projects from memories and moves parked/done out of roadmap tags', (t) => {
  const path = join(tmpdir(), `memtest-m13-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 12 });
  const ins = old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by, deleted_at)
    VALUES (?, ?, ?, ?, ?, x'00', '2026-10-01', 'Claude', '2026-10-02', 'Claude', ?)`);
  ins.run('m1', 'decision', 'Use SQLite', 'wildlog', '[]', null);
  ins.run('m2', 'roadmap', 'Now: x', 'pine-lodge', '["parked","x"]', null);
  ins.run('m3', 'roadmap', 'Now: y', 'castle3d', '["done"]', null);
  ins.run('m4', 'summary', 'Job hunt', 'career', '[]', null);
  ins.run('m5', 'profile', 'Lives in Berlin', null, '[]', null);
  ins.run('m6', 'decision', 'Old', 'gone', '[]', '2026-10-05');
  ins.run('m7', 'decision', 'Finished the logo', 'wildlog', '["done","x"]', null);
  ins.run('m8', 'roadmap', 'Now: old', 'trellis', '["done"]', '2026-10-06');
  ins.run('m9', 'decision', 'trellis moves to Postgres', 'trellis', '[]', null);
  ins.run('m10', 'roadmap', 'Now: z', 'vpn', '["parked","done"]', null);
  ins.run('m11', 'profile', 'Likes karting', 'someproj', '[]', null);
  ins.run('m12', 'decision', 'Coyote plays from Jellyfin', 'coyote', '[]', null);
  old.prepare("INSERT INTO project_aliases(alias, project, added_at, added_by) VALUES ('coyote', 'inflow', 'x', 'owner')").run();
  old.prepare("INSERT INTO memories_fts(memory_id, content, project, tags) VALUES ('m2', 'Now: x', 'pine-lodge', 'parked x')").run();
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  const rows = db.prepare('SELECT name, state, area, created_by FROM projects ORDER BY name').all().map((r: any) => ({ ...r }));
  assert.deepEqual(rows, [
    { name: 'career', state: 'open', area: 'personal', created_by: 'migration' },
    { name: 'castle3d', state: 'done', area: null, created_by: 'migration' },
    { name: 'inflow', state: 'open', area: null, created_by: 'migration' },
    { name: 'pine-lodge', state: 'parked', area: null, created_by: 'migration' },
    { name: 'trellis', state: 'open', area: null, created_by: 'migration' },
    { name: 'vpn', state: 'done', area: null, created_by: 'migration' },
    { name: 'wildlog', state: 'open', area: null, created_by: 'migration' },
  ]);
  const tags = (id: string) => JSON.parse((db.prepare('SELECT tags FROM memories WHERE id = ?').get(id) as any).tags);
  assert.deepEqual(tags('m2'), ['x']);
  assert.deepEqual(tags('m3'), []);
  assert.deepEqual(tags('m7'), ['done', 'x'], 'only roadmaps lose the tags');
  assert.equal((db.prepare("SELECT tags FROM memories_fts WHERE memory_id = 'm2'").get() as any).tags, 'x', 'search no longer finds the old tag');
  db.close();
});

test('migration 20 adds weekly_reviews and the shared indexes and keeps existing rows', (t) => {
  const path = join(tmpdir(), `memtest-m20-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 19 });
  old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1', 'decision', 'Use SQLite', 'wildlog', '[]', x'00', '2026-10-01T10:00:00.000Z', 'Claude', '2026-10-02T10:00:00.000Z', 'Claude')`).run();
  old.prepare(`INSERT INTO memory_history(memory_id, action, content, project, tags, changed_at, changed_by)
    VALUES ('m1', 'update', 'Use files', 'wildlog', '[]', '2026-10-02T10:00:00.000Z', 'Claude')`).run();
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`).all().map((r: any) => r.name);
  assert.ok(names.includes('weekly_reviews'));
  for (const i of ['memory_history_memory', 'memory_history_changed', 'memory_history_project', 'memories_created',
    'memories_project_kind', 'page_versions_saved', 'observation_evidence_added']) assert.ok(names.includes(i), `missing ${i}`);
  assert.equal((db.prepare("SELECT content FROM memories WHERE id = 'm1'").get() as any).content, 'Use SQLite');
  assert.equal((db.prepare('SELECT count(*) AS n FROM memory_history').get() as any).n, 1);
  db.close();
});

test('migration 21 adds runs_on and the meaning tables and keeps existing projects', (t) => {
  const path = join(tmpdir(), `memtest-m21-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 20 });
  old.prepare(`INSERT INTO projects(name, state, state_changed_at, created_at, created_by, updated_at, updated_by)
    VALUES ('wildlog', 'open', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 'owner', '2026-10-01T10:00:00.000Z', 'owner')`).run();
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  assert.equal((db.prepare("SELECT runs_on FROM projects WHERE name = 'wildlog'").get() as any).runs_on, '[]');
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`).all().map((r: any) => r.name);
  for (const n of ['meaning_links', 'meaning_indexed', 'meaning_links_b']) assert.ok(names.includes(n), `missing ${n}`);
  db.close();
});

test('migration 22 adds supersessions and keeps waiting suggestions', (t) => {
  const path = join(tmpdir(), `memtest-m22-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 21 });
  for (const id of ['a', 'b', 'c']) {
    old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
      VALUES (?, 'decision', 'x', 'wildlog', '[]', x'00', '2026-10-01', 'owner', '2026-10-01', 'owner')`).run(id);
  }
  old.prepare("INSERT INTO profile_suggestions(id, action, content, tags, suggested_at, suggested_by) VALUES ('s', 'add', 'c', '[]', '2026-10-19T00:00:00Z', 'Grok')").run();
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  assert.equal((db.prepare("SELECT supersedes FROM profile_suggestions WHERE id = 's'").get() as any).supersedes, '[]');
  const names = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`).all().map((r: any) => r.name);
  for (const n of ['supersessions', 'supersessions_live', 'supersessions_by_new']) assert.ok(names.includes(n), `missing ${n}`);
  const add = db.prepare("INSERT INTO supersessions(old_id, new_id, created_at, created_by) VALUES (?, ?, '2026-10-20', 'owner')");
  add.run('a', 'b');
  assert.throws(() => add.run('a', 'c'), /UNIQUE/);
  assert.throws(() => add.run('b', 'b'), /CHECK/);
  db.prepare("UPDATE supersessions SET undone_at = '2026-10-21', undone_by = 'owner' WHERE old_id = 'a'").run();
  add.run('a', 'c');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supersessions WHERE old_id = 'a'").get() as any).n, 2);
  db.close();
});

test('migration 23 starts unsaved Outline imports from Outline\'s date, in milliseconds, and every other page from its last save', (t) => {
  const path = join(tmpdir(), `memtest-m23-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 22 });
  const page = old.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, NULL, 'start', 'Body.', ?, '2026-11-01T08:00:00.000Z', ?, ?, ?)`);
  const version = old.prepare(`INSERT INTO page_versions(page_id, version, title, project, area, body, saved_at, saved_by)
    VALUES (?, ?, ?, NULL, 'start', 'Body.', ?, ?)`);
  const imp = old.prepare(`INSERT INTO page_imports(outline_id, page_id, collection, title, original, outline_updated_at, imported_at)
    VALUES (?, ?, 'Apps', ?, 'Body.', '2026-10-21T09:00:00Z', '2026-11-01T08:00:00.000Z')`);
  page.run('A', 'A', 'a', 1, 'Outline import', '2026-11-01T08:00:00.000Z', 'Outline import');
  version.run('A', 1, 'A', '2026-11-01T08:00:00.000Z', 'Outline import');
  imp.run('oa', 'A', 'A');
  page.run('B', 'B', 'b', 2, 'Outline import', '2026-11-02T08:00:00.000Z', 'owner');
  version.run('B', 1, 'B', '2026-11-01T08:00:00.000Z', 'Outline import');
  version.run('B', 2, 'B', '2026-11-02T08:00:00.000Z', 'owner');
  imp.run('ob', 'B', 'B');
  page.run('C', 'C', 'c', 1, 'Claude Code', '2026-11-03T08:00:00.000Z', 'Claude Code');
  version.run('C', 1, 'C', '2026-11-03T08:00:00.000Z', 'Claude Code');
  old.close();

  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  const row = (id: string) => ({ ...(db.prepare('SELECT caught_up_at, caught_up_how, caught_up_by FROM pages WHERE id = ?').get(id) as any) });
  assert.deepEqual(row('A'), { caught_up_at: '2026-10-21T09:00:00.000Z', caught_up_how: 'imported', caught_up_by: 'Outline import' });
  assert.deepEqual(row('B'), { caught_up_at: '2026-11-02T08:00:00.000Z', caught_up_how: 'migrated', caught_up_by: 'owner' });
  assert.deepEqual(row('C'), { caught_up_at: '2026-11-03T08:00:00.000Z', caught_up_how: 'migrated', caught_up_by: 'Claude Code' });
  assert.equal((db.prepare("SELECT caught_up_at FROM page_versions WHERE page_id = 'A' AND version = 1").get() as any).caught_up_at, null);
  assert.deepEqual(db.prepare('SELECT * FROM page_checks').all(), []);
  db.close();
});

test('caught_up_how accepts only the seven ways a page is brought up to date', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by, caught_up_at, caught_up_how, caught_up_by)
    VALUES ('p', 'P', 'p', NULL, 'start', 'B', 1, 'x', 'owner', 'x', 'owner', 'x', 'created', 'owner')`).run();
  for (const how of ['created', 'saved', 'key_decisions', 'still_true', 'restored', 'imported', 'migrated']) {
    db.prepare('UPDATE pages SET caught_up_how = ?').run(how);
  }
  assert.throws(() => db.prepare("UPDATE pages SET caught_up_how = 'guessed'").run(), /CHECK constraint failed/);
});

test('migration 24 gives every connection the name its app shows today, so a later rename of the app changes none of them', (t) => {
  const path = join(tmpdir(), `memtest-m24-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 23 });
  const client = old.prepare('INSERT INTO oauth_clients(client_id, client_name, metadata, is_cimd, created_at, display_name) VALUES (?, ?, ?, 0, ?, ?)');
  client.run('codex', 'Codex', '{}', '2026-10-22T13:54:00.000Z', 'WorkCodex');
  client.run('grok', 'Grok', '{}', '2026-10-19T14:32:00.000Z', null);
  client.run('anon', null, '{}', '2026-10-19T14:32:00.000Z', null);
  const grant = old.prepare("INSERT INTO oauth_grants(id, client_id, created_at, access, projects) VALUES (?, ?, '2026-10-22T13:54:00.000Z', 'full', NULL)");
  for (const [id, c] of [['g1', 'codex'], ['g2', 'codex'], ['g3', 'grok'], ['g4', 'anon']]) grant.run(id, c);
  old.close();
  const db = openDb(path);
  const names = db.prepare('SELECT id, name FROM oauth_grants ORDER BY id').all() as { id: string; name: string | null }[];
  assert.deepEqual(names.map((r) => [r.id, r.name]), [['g1', 'WorkCodex'], ['g2', 'WorkCodex'], ['g3', 'Grok'], ['g4', null]]);
  db.close();
});

test('migration 25 adds the picture and diagram tables and keeps existing pages', (t) => {
  const path = join(tmpdir(), `memtest-m25-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 24 });
  old.prepare(`INSERT INTO pages(id, title, title_key, project, area, body, version, created_at, created_by, updated_at, updated_by, caught_up_at, caught_up_how, caught_up_by)
    VALUES ('P', 'P', 'p', NULL, 'start', 'Body.', 1, '2026-11-01T08:00:00.000Z', 'owner', '2026-11-01T08:00:00.000Z', 'owner', '2026-11-01T08:00:00.000Z', 'created', 'owner')`).run();
  old.close();
  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as any).version, 29);
  assert.equal((db.prepare("SELECT title FROM pages WHERE id = 'P'").get() as any).title, 'P');
  assert.deepEqual((db.prepare('PRAGMA table_info(images)').all() as { name: string }[]).map((c) => c.name),
    ['id', 'type', 'bytes', 'width', 'height', 'frames', 'alt', 'created_at', 'created_by', 'page_id', 'removed_at', 'removed_by']);
  assert.throws(() => db.prepare("INSERT INTO images(id, type, bytes, width, height, created_at, created_by) VALUES ('x', 'svg', 1, 1, 1, 'now', 'owner')").run(), /CHECK constraint failed/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'page_images_image'").get());
  for (const table of ['page_images', 'image_upload_links', 'diagram_checks']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table), table);
  db.close();
});

test('migration 26 adds deleted_match to suggestions', (t) => {
  const path = join(tmpdir(), `memtest-m26-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  openDb(path, { upTo: 25 }).close();
  const db = openDb(path);
  const cols = (db.prepare('PRAGMA table_info(profile_suggestions)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('deleted_match'), cols.join(','));
  db.close();
});

test('migration 27 adds the setup and tool columns to grants', (t) => {
  const path = join(tmpdir(), `memtest-m27-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  openDb(path, { upTo: 26 }).close();
  const db = openDb(path);
  const cols = (db.prepare('PRAGMA table_info(oauth_grants)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['setup_version', 'setup_seen_at', 'tool_names', 'tools_seen_at']) assert.ok(cols.includes(c), c);
  db.close();
});

test('migration 28 adds the skill tables', (t) => {
  const path = join(tmpdir(), `memtest-m28-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  openDb(path, { upTo: 27 }).close();
  const db = openDb(path);
  for (const table of ['skills', 'skill_versions', 'skill_files', 'skill_proposals']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  db.close();
});

test('migration 29 adds device_skills and skill_links', (t) => {
  const path = join(tmpdir(), `memtest-m29-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  openDb(path, { upTo: 28 }).close();
  const db = openDb(path);
  for (const table of ['device_skills', 'skill_links']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  db.close();
});

test('before migrating a file database, the brain copies it to pre-migrate/, keeping the newest 3; a failed copy stops the migration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memtest-premigrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  openDb(path, { upTo: 25 }).close();
  const db = openDb(path, { upTo: 26 });
  db.close();
  const copies = () => readdirSync(join(dir, 'pre-migrate')).sort();
  assert.equal(copies().length, 1);
  assert.match(copies()[0]!, /^pre-migrate-25-to-26-\d{8}-\d{6}\.db$/);
  const copy = openDb(join(dir, 'pre-migrate', copies()[0]!), { upTo: 25 });
  assert.equal((copy.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 25);
  copy.close();
  for (const to of [27, 28, 29]) openDb(path, { upTo: to }).close();
  assert.equal(copies().length, 3, 'only the newest 3 are kept');
  openDb(path).close();
  assert.equal(copies().length, 3, 'nothing pending: no copy');
  const fresh = join(dir, 'fresh.db');
  openDb(fresh).close();
  assert.equal(copies().length, 3, 'a new, empty database has nothing to copy');
});

test('a pre-migration copy that cannot be written stops the migration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memtest-premigrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  openDb(path, { upTo: 28 }).close();
  writeFileSync(join(dir, 'pre-migrate'), 'a file where the folder should be');
  assert.throws(() => openDb(path), /Could not back up the database before migrating it \(version 28 to 29\).*Nothing was changed\./);
  rmSync(join(dir, 'pre-migrate'));
  mkdirSync(join(dir, 'pre-migrate'));
  // A copy that fails its check is removed, never kept as if it were good.
  chmodSync(join(dir, 'pre-migrate'), 0o500);
  t.after(() => { if (existsSync(join(dir, 'pre-migrate'))) chmodSync(join(dir, 'pre-migrate'), 0o700); });
  assert.throws(() => openDb(path), /Could not back up/);
  chmodSync(join(dir, 'pre-migrate'), 0o700);
  assert.deepEqual(readdirSync(join(dir, 'pre-migrate')), []);
  const db = openDb(path, { upTo: 28 });
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 28);
  db.close();
});
