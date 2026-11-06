import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { GrowthStore } from './store.js';

const setup = () => {
  const db = openDb(':memory:');
  let t = Date.parse('2026-11-03T10:00:00Z');
  const store = new GrowthStore(db, () => new Date(t));
  return { db, store, tick: (ms: number) => { t += ms; } };
};
const vec = (...v: number[]) => new Float32Array(v);
const base = { kind: 'improve' as const, area: 'testing' as const, project: 'leasesv2', summary: 'Shipped without running the suite', practise: 'Run npm test before every push', embedding: vec(1, 0, 0), by: 'Claude Code' };

test('insert writes the observation and its first evidence', () => {
  const { store } = setup();
  const o = store.insert(base);
  assert.equal(o.kind, 'improve');
  assert.equal(o.area, 'testing');
  assert.equal(o.project, 'leasesv2');
  assert.equal(o.summary, 'Shipped without running the suite');
  assert.equal(o.practise, 'Run npm test before every push');
  assert.equal(o.evidenceCount, 1);
  assert.equal(o.reaction, null);
  assert.equal(o.createdBy, 'Claude Code');
  assert.equal(o.createdAt, '2026-11-03T10:00:00.000Z');
  assert.equal(o.lastEvidenceAt, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(store.get(o.id), o);
  const ev = store.evidence(o.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].what, 'Shipped without running the suite');
  assert.equal(ev[0].project, 'leasesv2');
  assert.equal(ev[0].addedBy, 'Claude Code');
});

test('addEvidence counts and dates the new evidence', () => {
  const { store, tick } = setup();
  const o = store.insert(base);
  tick(3_600_000);
  const after = store.addEvidence(o.id, { what: 'Pushed again with a red test', project: 'leasesv2', by: 'Codex' });
  assert.equal(after.evidenceCount, 2);
  assert.equal(after.lastEvidenceAt, '2026-11-03T11:00:00.000Z');
  assert.equal(after.createdAt, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(store.evidence(o.id).map((e) => [e.what, e.addedBy]), [
    ['Shipped without running the suite', 'Claude Code'],
    ['Pushed again with a red test', 'Codex'],
  ]);
});

test('candidates match kind, area and project (null with null) within the window', () => {
  const { store, tick } = setup();
  const match = store.insert(base);
  store.insert({ ...base, area: 'git' });
  store.insert({ ...base, kind: 'strength', practise: null });
  store.insert({ ...base, project: 'wildlog' });
  const noProject = store.insert({ ...base, project: null });
  const ids = (xs: { observation: { id: string } }[]) => xs.map((x) => x.observation.id);
  const got = store.candidates('improve', 'testing', 'leasesv2', '2026-11-01T00:00:00.000Z');
  assert.deepEqual(ids(got), [match.id]);
  assert.deepEqual(Array.from(got[0].embedding), [1, 0, 0]);
  assert.deepEqual(ids(store.candidates('improve', 'testing', null, '2026-11-01T00:00:00.000Z')), [noProject.id]);
  tick(1000);
  assert.deepEqual(ids(store.candidates('improve', 'testing', 'leasesv2', '2026-11-03T10:00:00.500Z')), []);
});

test('react sets and clears the owner\'s reaction', () => {
  const { store, tick } = setup();
  const o = store.insert(base);
  tick(1000);
  const r = store.react(o.id, 'dismiss');
  assert.equal(r.reaction, 'dismiss');
  assert.equal(r.reactedAt, '2026-11-03T10:00:01.000Z');
  const c = store.react(o.id, null);
  assert.equal(c.reaction, null);
  assert.equal(c.reactedAt, null);
  assert.equal(store.get('nope'), undefined);
});

test('list puts the newest evidence first', () => {
  const { store, tick } = setup();
  const a = store.insert(base);
  tick(1000);
  const b = store.insert({ ...base, area: 'git' });
  tick(1000);
  store.addEvidence(a.id, { what: 'again', project: null, by: 'Claude' });
  assert.deepEqual(store.list().map((o) => o.id), [a.id, b.id]);
});

test('createdBySince counts only that assistant\'s new observations', () => {
  const { store, tick } = setup();
  const o = store.insert(base);
  store.insert({ ...base, area: 'git' });
  store.insert({ ...base, area: 'security', by: 'Codex' });
  tick(1000);
  store.addEvidence(o.id, { what: 'again', project: null, by: 'Claude Code' });
  assert.equal(store.createdBySince('Claude Code', '2026-11-03T00:00:00.000Z'), 2);
  assert.equal(store.createdBySince('Codex', '2026-11-03T00:00:00.000Z'), 1);
  assert.equal(store.createdBySince('Claude Code', '2026-11-03T10:00:00.500Z'), 0);
});

test('the CHECK constraints refuse an unknown kind or area', () => {
  const { store } = setup();
  assert.throws(() => store.insert({ ...base, kind: 'weakness' as never }), /CHECK constraint/);
  assert.throws(() => store.insert({ ...base, area: 'cooking' as never }), /CHECK constraint/);
  assert.equal(store.list().length, 0);
});
