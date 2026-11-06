import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../projects/store.js';
import { makePages, makeService } from '../testing/helpers.js';
import { NoteError, NoteService } from './notes.js';

const owner = { type: 'owner' } as const;

async function setup() {
  let t = Date.parse('2026-11-03T10:00:00Z');
  const now = () => new Date(t);
  const given = makeService({ now });
  const pages = makePages(given, now);
  const registry = new ProjectStore(given.db, now);
  registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  await given.service.remember({ kind: 'decision', content: 'wildlog is a SwiftUI app', project: 'wildlog' }, owner);
  const notes = new NoteService(given.db, pages, now);
  const page = await pages.create({ title: 'wildlog — cellar', project: 'wildlog', body: 'Lead.\n\n## Stack\nSwiftUI.\n\n## Deploy\nTestFlight.' }, 'owner');
  return { ...given, pages, notes, page, registry, tick: (ms: number) => { t += ms; } };
}
const code = (c: NoteError['code'], re?: RegExp) => (e: unknown) => e instanceof NoteError && e.code === c && (!re || re.test(e.message));

test('add keeps a note on a page or one of its sections', async () => {
  const { notes, page } = await setup();
  const whole = notes.add(page.id, { text: '  The app moved to iOS 18.  ' });
  assert.deepEqual([whole.pageId, whole.anchor, whole.text, whole.status, whole.createdAt], [page.id, null, 'The app moved to iOS 18.', 'open', '2026-11-03T10:00:00.000Z']);
  const sec = notes.add(page.id, { text: 'Deploys go through Xcode Cloud now', anchor: 'deploy' });
  assert.equal(sec.anchor, 'deploy');
  assert.deepEqual(notes.get(sec.id), sec);
});

test('a note on an unknown section, an empty or 501-character note, or one with a secret is refused', async () => {
  const { notes, page, pages } = await setup();
  assert.throws(() => notes.add(page.id, { text: 'x', anchor: 'nope' }), code('invalid', /^No section nope on this page$/));
  assert.throws(() => notes.add(page.id, { text: '   ' }), code('invalid', /^A note is 1 to 500 characters$/));
  assert.throws(() => notes.add(page.id, { text: 'x'.repeat(501) }), code('invalid', /1 to 500/));
  assert.throws(() => notes.add(page.id, { text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' }), code('invalid', /^The note looks like it contains a secret \(GitHub token\)\. Secrets are never stored\.$/));
  assert.throws(() => notes.add('missing', { text: 'x' }), code('not_found'));
  pages.remove(page.id, 'owner');
  assert.throws(() => notes.add(page.id, { text: 'x' }), code('not_found'));
});

test('resolve needs an open note and a reply; resolving twice is refused', async () => {
  const { notes, page, tick } = await setup();
  const n = notes.add(page.id, { text: 'Port changed to 8443' });
  assert.throws(() => notes.resolve(n.id, '  ', 'Claude Code'), code('invalid', /^A reply is 1 to 500 characters$/));
  tick(60_000);
  const r = notes.resolve(n.id, 'Updated the Run section to port 8443.', 'Claude Code');
  assert.deepEqual([r.status, r.reply, r.resolvedBy, r.resolvedAt], ['resolved', 'Updated the Run section to port 8443.', 'Claude Code', '2026-11-03T10:01:00.000Z']);
  assert.throws(() => notes.resolve(n.id, 'again', 'Codex'), code('invalid', /^This note is already resolved$/));
  assert.throws(() => notes.resolve('missing', 'x', 'Codex'), code('not_found'));
});

test('withdraw hides an open note; a withdrawn note cannot be resolved', async () => {
  const { notes, page } = await setup();
  const n = notes.add(page.id, { text: 'Never mind' });
  assert.equal(notes.withdraw(n.id).status, 'withdrawn');
  assert.deepEqual(notes.forPage(page.id), []);
  assert.throws(() => notes.resolve(n.id, 'x', 'Codex'), code('invalid', /^This note was withdrawn$/));
  assert.throws(() => notes.withdraw(n.id), code('invalid'));
});

test('forPage lists open notes first, oldest first, then resolved ones, newest first', async () => {
  const { notes, page, tick } = await setup();
  const a = notes.add(page.id, { text: 'a' }); tick(1000);
  const b = notes.add(page.id, { text: 'b' }); tick(1000);
  const c = notes.add(page.id, { text: 'c' }); tick(1000);
  const d = notes.add(page.id, { text: 'd' }); tick(1000);
  notes.resolve(a.id, 'done a', 'Codex'); tick(1000);
  notes.resolve(c.id, 'done c', 'Codex');
  assert.deepEqual(notes.forPage(page.id).map((n) => n.text), ['b', 'd', 'c', 'a']);
  assert.equal(d.status, 'open');
});

test('openForProject lists the open notes of a project\'s live pages, aliases included, and skips deleted pages', async () => {
  const { notes, page, pages, service, registry } = await setup();
  registry.create('vista', { state: 'open' }, 'owner');
  await service.remember({ kind: 'decision', content: 'vista is the old name', project: 'vista' }, owner);
  const old = await pages.create({ title: 'vista — old page', project: 'vista', body: 'x' }, 'owner');
  service.addAlias('vista', 'wildlog', owner);
  const n1 = notes.add(page.id, { text: 'one', anchor: 'stack' });
  const n2 = notes.add(old.id, { text: 'two' });
  const n3 = notes.add(page.id, { text: 'three' });
  notes.resolve(n3.id, 'ok', 'Codex');
  assert.deepEqual(notes.openForProject('wildlog').map((x) => [x.note.id, x.page.id]).sort(), [[n1.id, page.id], [n2.id, old.id]].sort());
  pages.remove(old.id, 'owner');
  assert.deepEqual(notes.openForProject('wildlog').map((x) => x.note.id), [n1.id]);
});
