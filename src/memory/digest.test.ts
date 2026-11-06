import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { shiftWeek, weekContaining, weeklyDigest, weekOf } from './digest.js';
import type { Kind } from './types.js';

// These tests are about the owner's calendar in Berlin; the app's own default zone is UTC.
process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';

test('a week runs from Monday to Monday at midnight in Berlin, summer and winter time included', () => {
  const sunday = weekOf(new Date('2026-10-18T21:30:00Z')); // Sunday 23:30 in Berlin
  assert.equal(sunday.monday, '2026-10-12');
  assert.equal(sunday.start.toISOString(), '2026-10-11T22:00:00.000Z');
  assert.equal(sunday.end.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(weekOf(new Date('2026-10-18T22:30:00Z')).monday, '2026-10-19'); // Monday 00:30 in Berlin

  const clocksChange = weekContaining('2026-10-21')!;
  assert.equal(clocksChange.monday, '2026-10-19');
  assert.equal(clocksChange.start.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(clocksChange.end.toISOString(), '2026-10-25T23:00:00.000Z');
});

test('weeks can be picked by any of their dates and stepped back and forth', () => {
  assert.equal(weekContaining('2026-10-18')!.monday, '2026-10-12');
  assert.equal(weekContaining('2026-02-30'), undefined);
  assert.equal(weekContaining('soon'), undefined);
  assert.equal(shiftWeek('2026-10-12', -1), '2026-10-05');
  assert.equal(shiftWeek('2026-12-28', 1), '2027-01-04');
});

function setup() {
  let t = Date.parse('2026-10-12T08:00:00Z'); // Monday morning in Berlin
  const { store, db } = makeService({ now: () => new Date(t) });
  const v = new Float32Array(384); v[0] = 1;
  const add = (kind: Kind, content: string, project: string | null, by: string) =>
    store.insert({ kind, content, project, tags: [], embedding: v, by });
  const edit = (id: string, content: string, by: string) => {
    const m = store.get(id)!;
    store.update(id, { content, project: m.project, tags: m.tags, embedding: v, by });
  };
  return { store, db, add, edit, at: (iso: string) => { t = Date.parse(iso); } };
}

test('the digest counts what each assistant saved, changed, deleted and looked up that week', () => {
  const { store, add, edit, at } = setup();
  at('2026-10-05T10:00:00Z');
  const before = add('decision', 'wildlog uses SwiftUI', 'wildlog', 'Claude Code');
  store.logToolCall('Grok', 'recall');
  at('2026-10-13T10:00:00Z');
  const a = add('decision', 'wildlog sommelier uses Sign in with ChatGPT', 'wildlog', 'Claude Code');
  add('summary', 'wildlog status: v0.2 released', 'wildlog', 'Claude Code');
  edit(before.id, 'wildlog uses SwiftUI on macOS 15', 'Claude Code');
  store.softDelete(a.id, 'Grok');
  add('decision', 'castle3d uses three.js', 'castle3d', 'Grok');
  edit(before.id, 'wildlog uses SwiftUI on macOS 26', 'owner');
  for (const tool of ['recall', 'recall', 'project_brief', 'load_profile', 'list_projects', 'remember']) store.logToolCall('Grok', tool);
  store.logToolCall('Claude', 'recall');
  at('2026-10-19T10:00:00Z');
  add('decision', 'next week', 'wildlog', 'Claude Code');

  const d = weeklyDigest(store, weekContaining('2026-10-12')!, { grants: [], waiting: 0 });
  assert.deepEqual(d.totals, { saved: 3, changed: 2, deleted: 1 });
  assert.deepEqual(d.writers, [
    { name: 'Grok', saved: 1, changed: 0, deleted: 1, lookups: 5 },
    { name: 'Claude Code', saved: 2, changed: 1, deleted: 0, lookups: 0 },
    { name: 'owner', saved: 0, changed: 1, deleted: 0, lookups: 0 },
    { name: 'Claude', saved: 0, changed: 0, deleted: 0, lookups: 1 },
  ]);
  assert.deepEqual(d.projects.map(({ project, saved, changed, deleted, isNew }) => ({ project, saved, changed, deleted, isNew })), [
    { project: 'wildlog', saved: 2, changed: 2, deleted: 1, isNew: false },
    { project: 'castle3d', saved: 1, changed: 0, deleted: 0, isNew: true },
  ]);
  assert.equal(d.projects[0]!.latestStatus!.content, 'wildlog status: v0.2 released');
  assert.equal(d.projects[1]!.latestStatus, null);
  assert.equal(d.lookupsSince, '2026-10-05T10:00:00.000Z');
});

test('worth a look: deletions and edits by assistants, new connections, waiting suggestions, memories without a project', () => {
  const { store, add, edit, at } = setup();
  at('2026-10-13T10:00:00Z');
  const mine = add('decision', 'trellis moves to Postgres', 'trellis', 'owner');
  const theirs = add('decision', 'Dossier plays mkv', 'dossier-app', 'Claude Code');
  const fact = add('profile', 'Lives in Berlin', null, 'owner');
  edit(mine.id, 'trellis stays on SQLite', 'Grok');
  edit(mine.id, 'trellis stays on SQLite for now', 'Grok');
  edit(theirs.id, 'Dossier plays mkv and avi', 'Claude Code');
  store.softDelete(theirs.id, 'Grok');
  edit(fact.id, 'Lives in Berlin, Germany', 'Claude');
  const loose = add('decision', 'Something without a project', null, 'Claude');

  const d = weeklyDigest(store, weekContaining('2026-10-12')!, {
    grants: [
      { clientName: 'ChatGPT', createdAt: '2026-10-14T09:00:00.000Z' },
      { clientName: 'ChatGPT', createdAt: '2026-10-15T09:00:00.000Z' },
      { clientName: 'Claude', createdAt: '2026-09-01T09:00:00.000Z' },
    ],
    waiting: 2,
  });
  assert.deepEqual(d.flags.map((f) => f.kind), ['waiting', 'connected', 'deleted-by-ai', 'changed-others', 'no-project']);
  const [waiting, connected, deleted, changed, noProject] = d.flags as any[];
  assert.equal(waiting.count, 2);
  assert.equal(connected.client, 'ChatGPT');
  assert.equal(connected.times, 2);
  assert.equal(connected.at, '2026-10-15T09:00:00.000Z');
  assert.equal(deleted.by, 'Grok');
  assert.equal(deleted.memory.id, theirs.id);
  assert.equal(changed.by, 'Grok');
  assert.equal(changed.author, 'owner');
  assert.equal(changed.memory.id, mine.id);
  assert.equal(noProject.memory.id, loose.id);
});

test('an empty week has nothing in it', () => {
  const { store } = setup();
  const d = weeklyDigest(store, weekContaining('2026-10-12')!, { grants: [], waiting: 0 });
  assert.deepEqual(d.totals, { saved: 0, changed: 0, deleted: 0 });
  assert.deepEqual([d.writers, d.projects, d.flags], [[], [], []]);
  assert.equal(d.lookupsSince, null);
});

test('worth a look: an assistant that keeps looking things up but never saves', () => {
  const { store, add, at } = setup();
  at('2026-10-13T10:00:00Z');
  for (let i = 0; i < 6; i++) store.logToolCall('Grok', i % 2 ? 'recall' : 'project_brief');
  for (let i = 0; i < 6; i++) store.logToolCall('Claude', 'recall');
  add('decision', 'castle3d uses three.js', 'castle3d', 'Claude');
  for (let i = 0; i < 2; i++) store.logToolCall('Claude Code', 'recall');
  for (let i = 0; i < 6; i++) store.logToolCall('owner', 'recall');

  const d = weeklyDigest(store, weekContaining('2026-10-12')!, { grants: [], waiting: 0 });
  const flags = d.flags.filter((f) => f.kind === 'no-saves') as any[];
  assert.deepEqual(flags.map((f) => [f.client, f.lookups]), [['Grok', 6]]);
});

test('another assistant updating a roadmap is normal upkeep, not a flag', () => {
  const { store, add, edit, at } = setup();
  const r = add('roadmap', 'Now: tools', 'dossiers', 'Claude Code');
  at('2026-10-13T08:00:00Z');
  edit(r.id, 'Now: design refresh', 'Grok');
  const d = weeklyDigest(store, weekOf(new Date('2026-10-14T08:00:00Z')), { grants: [], waiting: 0 });
  assert.deepEqual(d.flags.filter((f) => f.kind === 'changed-others'), []);
});

test('replacements and undos count as Changed for who did them, under the old fact\'s project', () => {
  const { store, add, at } = setup();
  at('2026-10-05T10:00:00Z');
  const old = add('decision', 'wildlog uses Core Data', 'wildlog', 'owner');
  const now = add('decision', 'wildlog uses SwiftData', 'wildlog', 'owner');
  at('2026-10-13T10:00:00Z');
  const row = store.supersessions.add(old.id, now.id, 'Claude Code');
  at('2026-10-14T10:00:00Z');
  store.supersessions.undo(row.id, 'owner');
  const d = weeklyDigest(store, weekContaining('2026-10-13')!, { grants: [], waiting: 0 });
  assert.equal(d.writers.find((w) => w.name === 'Claude Code')!.changed, 1);
  assert.equal(d.writers.find((w) => w.name === 'owner')!.changed, 1);
  assert.equal(d.projects.find((p) => p.project === 'wildlog')!.changed, 2);
  assert.equal(d.totals.changed, 2);
});

test('an AI replacing someone else\'s fact raises one flag per fact and replacer', () => {
  const { store, add, at } = setup();
  at('2026-10-05T10:00:00Z');
  const mine = add('decision', 'wildlog uses Core Data', 'wildlog', 'owner');
  const newer = add('decision', 'wildlog uses SwiftData', 'wildlog', 'Claude Code');
  const claudes = add('decision', 'labels use Futura', 'wildlog', 'Claude Code');
  const newer2 = add('decision', 'labels use Avenir', 'wildlog', 'Claude Code');
  const theirs = add('decision', 'photos stay on the phone', 'wildlog', 'Claude');
  const newer3 = add('decision', 'photos go to iCloud', 'wildlog', 'owner');
  at('2026-10-13T10:00:00Z');
  const r1 = store.supersessions.add(mine.id, newer.id, 'Claude Code');
  store.supersessions.undo(r1.id, 'owner');
  store.supersessions.add(mine.id, newer.id, 'Claude Code');
  store.supersessions.add(claudes.id, newer2.id, 'Claude Code');
  store.supersessions.add(theirs.id, newer3.id, 'owner');
  const flags = weeklyDigest(store, weekContaining('2026-10-13')!, { grants: [], waiting: 0 }).flags.filter((f) => f.kind === 'replaced-others');
  assert.equal(flags.length, 1);
  const f = flags[0] as Extract<typeof flags[number], { kind: 'replaced-others' }>;
  assert.deepEqual([f.by, f.author, f.memory.id], ['Claude Code', 'owner', mine.id]);
});

test('a replacement already undone in the week raises no flag', () => {
  const { store, add, at } = setup();
  at('2026-10-05T10:00:00Z');
  const mine = add('decision', 'the heating is controlled by Ecobee', 'homeassistant', 'owner');
  const newer = add('decision', 'the heating is controlled by Hive', 'homeassistant', 'Claude');
  at('2026-10-13T10:00:00Z');
  const row = store.supersessions.add(mine.id, newer.id, 'Claude');
  at('2026-10-13T15:00:00Z');
  store.supersessions.undo(row.id, 'owner');
  const flags = weeklyDigest(store, weekContaining('2026-10-13')!, { grants: [], waiting: 0 }).flags.filter((f) => f.kind === 'replaced-others');
  assert.deepEqual(flags, []);
});
