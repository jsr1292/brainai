import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { PageStore, type StoredLink, type StoredSection } from './store.js';
import { PageError } from './types.js';

const setup = () => {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-03T10:00:00Z');
  const store = new PageStore(db, () => new Date(t));
  return { db, store, tick: (ms: number) => { t += ms; } };
};
const sec = (anchor: string, text: string, position = 0): StoredSection =>
  ({ anchor, position, heading: anchor === 'top' ? '' : anchor, level: anchor === 'top' ? 1 : 2, text, embedding: new Float32Array([1, 0]), instructionLike: false });
const page = { title: 'wildlog — wine cellar', project: 'wildlog', area: null, body: 'Lead.\n## Stack\nSwiftUI.', by: 'owner' };
const count = (db: ReturnType<typeof openDb>, table: string) => (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
const code = (c: PageError['code']) => (e: unknown) => e instanceof PageError && e.code === c;
const C = { at: '2026-11-03T10:00:00.000Z', how: 'created', by: 'owner' } as const;

test('insert writes version 1 with its version row, sections, keyword index and links', () => {
  const { db, store } = setup();
  const links: StoredLink[] = [{ kind: 'project', target: 'wildlog' }];
  const p = store.insert(page, [sec('top', 'Lead.'), sec('stack', 'SwiftUI.', 1)], links, C);
  assert.equal(p.version, 1);
  assert.equal(p.createdBy, 'owner');
  assert.equal(p.createdAt, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(store.versions(p.id).map((v) => [v.version, v.body, v.savedBy]), [[1, page.body, 'owner']]);
  assert.deepEqual(store.sections(p.id).map((s) => s.anchor), ['top', 'stack']);
  assert.deepEqual(store.ftsSections('"swiftui"', 10), [{ pageId: p.id, anchor: 'stack' }]);
  assert.deepEqual(store.linkedFrom('project', 'wildlog').map((x) => x.id), [p.id]);
  assert.equal(count(db, 'page_links'), 1);
});

test('update with the current base adds a version and replaces sections and links', () => {
  const { store, tick } = setup();
  const p = store.insert(page, [sec('top', 'Lead.'), sec('stack', 'SwiftUI.', 1)], [{ kind: 'project', target: 'wildlog' }], C);
  tick(60_000);
  const u = store.update(p.id, 1, { ...page, body: 'New lead.', by: 'Claude Code' }, [sec('top', 'New lead.')], []);
  assert.equal(u.version, 2);
  assert.equal(u.updatedBy, 'Claude Code');
  assert.equal(u.updatedAt, '2026-11-03T10:01:00.000Z');
  assert.equal(u.createdBy, 'owner');
  assert.deepEqual(store.versions(p.id).map((v) => v.version), [2, 1]);
  assert.equal(store.version(p.id, 1)!.body, page.body);
  assert.deepEqual(store.sections(p.id).map((s) => s.anchor), ['top']);
  assert.deepEqual(store.ftsSections('"swiftui"', 10), []);
  assert.deepEqual(store.linkedFrom('project', 'wildlog'), []);
});

test('update with an old base throws conflict and changes nothing', () => {
  const { db, store } = setup();
  const p = store.insert(page, [sec('top', 'Lead.')], [], C);
  store.update(p.id, 1, { ...page, body: 'Two.' }, [sec('top', 'Two.')], []);
  assert.throws(() => store.update(p.id, 1, { ...page, body: 'Stale.' }, [sec('top', 'Stale.')], []), code('conflict'));
  assert.equal(store.get(p.id)!.body, 'Two.');
  assert.equal(count(db, 'page_versions'), 2);
  assert.deepEqual(store.sections(p.id).map((s) => s.text), ['Two.']);
});

test('two live pages cannot share a title in any case, but a deleted page frees its title', () => {
  const { store } = setup();
  const p = store.insert(page, [], [], C);
  assert.throws(() => store.insert({ ...page, title: '  WILDLOG — Wine Cellar ' }, [], [], C), code('invalid'));
  assert.equal(store.byTitle('WildLog — wine cellar')!.id, p.id);
  store.setDeleted(p.id, true, 'owner');
  assert.equal(store.byTitle(page.title), undefined);
  const again = store.insert(page, [], [], C);
  assert.notEqual(again.id, p.id);
  assert.equal(store.get(p.id)!.deletedAt, '2026-11-03T10:00:00.000Z');
});

test('undeleting a page whose title was taken since is refused', () => {
  const { store } = setup();
  const p = store.insert(page, [], [], C);
  store.setDeleted(p.id, true, 'owner');
  store.insert(page, [], [], C);
  assert.throws(() => store.setDeleted(p.id, false, 'owner'), code('invalid'));
  assert.notEqual(store.get(p.id)!.deletedAt, null);
});

test('list, forProject, linkedFrom and the search helpers skip deleted pages', () => {
  const { store, tick } = setup();
  const a = store.insert(page, [sec('top', 'SwiftUI cellar.')], [{ kind: 'project', target: 'wildlog' }], C);
  tick(1000);
  const b = store.insert({ ...page, title: 'wildlog — notes' }, [sec('top', 'Notes.')], [], C);
  assert.deepEqual(store.list().map((p) => p.id), [b.id, a.id]);
  assert.deepEqual(store.forProject('wildlog').map((p) => p.title), ['wildlog — notes', 'wildlog — wine cellar']);
  store.setDeleted(a.id, true, 'owner');
  assert.deepEqual(store.list().map((p) => p.id), [b.id]);
  assert.deepEqual(store.forProject('wildlog').map((p) => p.id), [b.id]);
  assert.deepEqual(store.linkedFrom('project', 'wildlog'), []);
  assert.deepEqual(store.ftsSections('"swiftui"', 10), []);
  assert.deepEqual(store.sectionEmbeddings().map((e) => e.pageId), [b.id]);
});

test('migration 15 runs on a database at version 14', (t) => {
  const path = join(tmpdir(), `pagestest-m15-${process.pid}.db`);
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true }); });
  const old = openDb(path, { upTo: 14 });
  old.prepare(`INSERT INTO memories(id, kind, content, project, tags, embedding, created_at, created_by, updated_at, updated_by)
    VALUES ('m1', 'decision', 'Use SQLite', 'wildlog', '[]', x'00', '2026-10-01', 'Claude', '2026-10-02', 'Claude')`).run();
  old.close();
  const db = openDb(path);
  assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 29);
  assert.equal(count(db, 'memories'), 1);
  assert.equal(count(db, 'pages'), 0);
});

test('insert and update write the caught-up values with the version, and an update without them keeps them', () => {
  const { store, tick } = setup();
  const p = store.insert(page, [], [], { at: '2026-11-01T09:00:00.000Z', how: 'created', by: 'Claude Code' });
  assert.deepEqual(p.caughtUp, { at: '2026-11-01T09:00:00.000Z', how: 'created', by: 'Claude Code' });
  assert.equal(store.version(p.id, 1)!.caughtUpAt, '2026-11-01T09:00:00.000Z');
  tick(1000);
  const u = store.update(p.id, 1, { ...page, body: 'Two.' }, [], [], { caught: { at: '2026-11-03T10:00:01.000Z', how: 'saved', by: 'owner' } });
  assert.deepEqual(u.caughtUp, { at: '2026-11-03T10:00:01.000Z', how: 'saved', by: 'owner' });
  assert.equal(store.version(p.id, 2)!.caughtUpAt, '2026-11-03T10:00:01.000Z');
  tick(1000);
  const k = store.update(p.id, 2, { ...page, body: 'Three.' }, [], [], {});
  assert.deepEqual(k.caughtUp, { at: '2026-11-03T10:00:01.000Z', how: 'saved', by: 'owner' });
  assert.equal(store.version(p.id, 3)!.caughtUpAt, '2026-11-03T10:00:01.000Z');
  assert.deepEqual(store.headers().find((h) => h.id === p.id)!.caughtUp, k.caughtUp);
});

test('a conflicting update writes no version and leaves the caught-up values alone', () => {
  const { store } = setup();
  const p = store.insert(page, [], [], C);
  store.update(p.id, 1, { ...page, body: 'Two.' }, [], [], {});
  assert.throws(() => store.update(p.id, 1, { ...page, body: 'Stale.' }, [], [], { caught: { at: '2026-11-04T00:00:00.000Z', how: 'saved', by: 'x' } }), code('conflict'));
  assert.deepEqual(store.get(p.id)!.caughtUp, C);
  assert.equal(store.versions(p.id).length, 2);
});

test('Still true records the previous values once, even when tapped twice in the same millisecond', () => {
  const { db, store, tick } = setup();
  const p = store.insert(page, [], [], C);
  tick(5000);
  const a = store.markStillTrue(p.id);
  const b = store.markStillTrue(p.id);
  assert.deepEqual(a, { at: '2026-11-03T10:00:05.000Z', how: 'still_true', by: 'owner' });
  assert.deepEqual(b, a);
  assert.equal(count(db, 'page_checks'), 1);
  assert.deepEqual(store.get(p.id)!.caughtUp, a);
  assert.deepEqual(db.prepare('SELECT prev_at, prev_how, prev_by, undone_at FROM page_checks').get(), { prev_at: C.at, prev_how: 'created', prev_by: 'owner', undone_at: null });
  assert.equal(store.versions(p.id).length, 1);
});

test('Undo of Still true goes back one level only, never through older checks', () => {
  const { db, store, tick } = setup();
  const p = store.insert(page, [], [], C);
  tick(1000);
  store.markStillTrue(p.id);
  assert.equal(store.undoStillTrue(p.id), true);
  assert.deepEqual(store.get(p.id)!.caughtUp, C);
  assert.equal(store.undoStillTrue(p.id), false);
  assert.deepEqual(store.get(p.id)!.caughtUp, C);

  tick(1000);
  const t1 = store.markStillTrue(p.id).at;
  tick(1000);
  store.markStillTrue(p.id);
  assert.equal(count(db, 'page_checks'), 3);
  assert.equal(store.undoStillTrue(p.id), true);
  assert.deepEqual(store.get(p.id)!.caughtUp, { at: t1, how: 'still_true', by: 'owner' });
  assert.equal(store.undoStillTrue(p.id), false);
  assert.deepEqual(store.get(p.id)!.caughtUp, { at: t1, how: 'still_true', by: 'owner' });
  assert.equal((db.prepare('SELECT undone_at FROM page_checks WHERE checked_at = ?').get(t1) as { undone_at: string | null }).undone_at, null);

  tick(1000);
  store.markStillTrue(p.id);
  tick(1000);
  const saved = { at: '2026-11-03T10:00:06.000Z', how: 'key_decisions', by: 'Claude Code' } as const;
  store.update(p.id, 1, { ...page, body: 'Two.' }, [], [], { caught: saved });
  assert.equal(store.undoStillTrue(p.id), false);
  assert.deepEqual(store.get(p.id)!.caughtUp, saved);
});

test('a page\'s linked facts come from its body, so a deleted fact stays linked after the page is saved again', () => {
  const { store } = setup();
  const body = 'Lead [[fact:X]] and [[fact:Y]], again [[fact:X]] and [[wildlog]].';
  const p = store.insert({ ...page, body }, [], [{ kind: 'fact', target: 'X' }, { kind: 'fact', target: 'Y' }], C);
  store.update(p.id, 1, { ...page, body }, [], [{ kind: 'fact', target: 'Y' }], {});
  const q = store.insert({ ...page, title: 'none', body: 'No links.' }, [], [], C);
  const links = store.factLinks([p.id, q.id]);
  assert.deepEqual(links.get(p.id), ['X', 'Y']);
  assert.deepEqual(links.get(q.id), []);
});

test('headings lists each page\'s sections without reading their vectors', () => {
  const { store } = setup();
  const p = store.insert(page, [sec('top', 'Lead.'), { ...sec('key-decisions', 'x', 1), heading: 'Key decisions' }], [], C);
  assert.deepEqual(store.headings([p.id]).get(p.id), [{ anchor: 'top', heading: '' }, { anchor: 'key-decisions', heading: 'Key decisions' }]);
});
