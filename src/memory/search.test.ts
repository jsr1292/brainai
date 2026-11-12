import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { EMBEDDING_DIM } from './embedder.js';
import { MemoryStore } from './store.js';
import { findSimilar, hybridSearch, toFtsQuery } from './search.js';

test('toFtsQuery neutralises FTS5 syntax', () => {
  assert.equal(toFtsQuery('mini "pc" NEAR( -docker*'), '"mini" OR "pc" OR "near" OR "docker"');
  assert.equal(toFtsQuery('  *** '), null);
});

test('toFtsQuery drops English and Spanish filler words', () => {
  assert.equal(toFtsQuery("What's the status of the energy optimiser?"), '"status" OR "energy" OR "optimiser"');
  assert.equal(toFtsQuery('¿Dónde está la copia de seguridad del NAS?'), '"copia" OR "seguridad" OR "nas"');
  assert.equal(toFtsQuery('what is the'), null);
  assert.equal(toFtsQuery('de la que'), null);
});

test('hybridSearch finds by keyword (accent-insensitive) and by vector, and never throws on odd input', async () => {
  const e = createFakeEmbedder(); const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = async (content: string, project: string | null = null) =>
    store.insert({ kind: 'decision', content, project, tags: [], embedding: await e.embed(content, 'passage'), by: 'x' });
  await add('La contraseña del router está en el gestor'); const ip = await add('Mini PC IP is 192.0.2.20');
  await add('casa uses SQLite', 'casa');
  const r1 = hybridSearch(store, { vector: await e.embed('contrasena', 'query'), text: 'contrasena', limit: 5, minSimilarity: 0.2, confidentSimilarity: 0.2 });
  assert.match(r1[0].memory.content, /contraseña/);
  const r2 = hybridSearch(store, { vector: await e.embed('192.0.2.20', 'query'), text: '192.0.2.20', limit: 5, minSimilarity: 0.2, confidentSimilarity: 0.2 });
  assert.equal(r2[0].memory.id, ip.id);
  const r3 = hybridSearch(store, { vector: await e.embed('sqlite', 'query'), text: 'sqlite', project: 'casa', limit: 5, minSimilarity: 0.2, confidentSimilarity: 0.2 });
  assert.equal(r3.length, 1);
  for (const odd of ['"', 'NEAR(', 'a AND', '-', '*', '']) {
    assert.doesNotThrow(() => hybridSearch(store, { vector: new Float32Array(384), text: odd, limit: 5, minSimilarity: 0.2, confidentSimilarity: 0.2 }));
  }
});

test('hybridSearch: the keyword weight comes from the caller; 0 orders by meaning alone', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const v = (...xs: number[]) => { const a = Float32Array.from(xs); const n = Math.hypot(...xs); return a.map((x) => x / n); };
  // "alpha" is the closest by meaning but shares no word with the query; "zebra" is second by meaning and a keyword hit.
  const alpha = store.insert({ kind: 'decision', content: 'alpha note', project: null, tags: [], embedding: v(1, 0, 0), by: 'x' });
  const zebra = store.insert({ kind: 'decision', content: 'zebra note', project: null, tags: [], embedding: v(0.9, 0.43, 0), by: 'x' });
  const q = { vector: v(1, 0, 0), text: 'zebra', limit: 5, minSimilarity: 0.5, confidentSimilarity: 0.5 };
  assert.deepEqual(hybridSearch(store, { ...q, keywordWeight: 0.5 }).map((h) => h.memory.id), [zebra.id, alpha.id]);
  assert.deepEqual(hybridSearch(store, q).map((h) => h.memory.id), [zebra.id, alpha.id], 'default stays 0.5');
  assert.deepEqual(hybridSearch(store, { ...q, keywordWeight: 0 }).map((h) => h.memory.id), [alpha.id, zebra.id]);
});

test('findSimilar returns only matches at or above threshold, same kind', async () => {
  const e = createFakeEmbedder(); const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const embedding = await e.embed('Has a NAS', 'passage');
  store.insert({ kind: 'profile', content: 'Has a NAS', project: null, tags: [], embedding, by: 'x' });
  store.insert({ kind: 'decision', content: 'Has a NAS', project: null, tags: [], embedding, by: 'x' });
  const r = findSimilar(store, await e.embed('has a nas', 'query'), { kind: 'profile' }, 0.9);
  assert.equal(r.length, 1);
  assert.equal(r[0].memory.kind, 'profile');
  assert.ok(Math.abs(r[0].similarity - 1) < 1e-4);
});

/** Unit vector with cosine `c` to axis 0. */
function at(c: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[0] = c; v[1] = Math.sqrt(1 - c * c);
  return v;
}

test('hybridSearch returns only keyword hits or vectors at or above the floor', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = (content: string, embedding: Float32Array) =>
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding, by: 'x' });
  const axis = at(1);
  const close = add('close match', at(0.9));
  add('filler entry', at(0.7));
  const keyword = add('zebra keyword only', at(0));
  const r = hybridSearch(store, { vector: axis, text: 'zebra', limit: 8, minSimilarity: 0.8, confidentSimilarity: 0.85 });
  assert.deepEqual(r.map((x) => x.memory.id).sort(), [close.id, keyword.id].sort());
  assert.deepEqual(hybridSearch(store, { vector: axis, text: 'nothing', limit: 8, minSimilarity: 0.95, confidentSimilarity: 0.95 }), []);
});

test('hybridSearch marks recalled only keyword hits and vectors at or above the confident level', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = (content: string, embedding: Float32Array) =>
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding, by: 'x' });
  const confident = add('confident match', at(0.9));
  const between = add('plausible match', at(0.82));
  const filler = add('filler entry', at(0.7));
  const keyword = add('zebra keyword only', at(0));
  const r = hybridSearch(store, { vector: at(1), text: 'zebra', limit: 8, minSimilarity: 0.8, confidentSimilarity: 0.86 });
  assert.deepEqual(r.map((x) => x.memory.id).sort(), [confident.id, between.id, keyword.id].sort());
  assert.ok(store.get(confident.id)!.lastRecalledAt, 'confident match marked');
  assert.ok(store.get(keyword.id)!.lastRecalledAt, 'keyword hit marked');
  assert.equal(store.get(between.id)!.lastRecalledAt, null, 'returned but below the confident level: not marked');
  assert.equal(store.get(filler.id)!.lastRecalledAt, null);
});

test('hybridSearch neither returns nor marks recalled a memory that shares only filler words with the query', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const old = store.insert({ kind: 'decision', content: 'The mini PC runs the arr stack', project: null, tags: [], embedding: at(0), by: 'x' });
  const r = hybridSearch(store, { vector: at(1), text: 'what is the weather', limit: 8, minSimilarity: 0.8, confidentSimilarity: 0.86 });
  assert.deepEqual(r, []);
  assert.equal(store.get(old.id)!.lastRecalledAt, null);
});

test('hybridSearch keeps vector matches within the window of the best one, never below the absolute floor', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = (content: string, embedding: Float32Array) =>
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding, by: 'x' });
  // Like a Spanish question against English memories: every similarity is low, the right one is still the best.
  const best = add('best match', at(0.79));
  const near = add('near the best', at(0.78));
  add('too far from the best', at(0.76));
  const q = { vector: at(1), text: 'nada', limit: 8, minSimilarity: 0.75, confidentSimilarity: 0.86 };
  assert.deepEqual(hybridSearch(store, { ...q, window: 0.015 }).map((x) => x.memory.id), [best.id, near.id]);
  assert.deepEqual(hybridSearch(store, { ...q, window: 0.015, minSimilarity: 0.8 }), []);
});

test('keyword search matches other forms of a word', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const m = store.insert({ kind: 'decision', content: 'Two more battery packs are due', project: null, tags: [], embedding: at(0), by: 'x' });
  for (const q of ['batteries', 'pack', 'battery']) {
    assert.deepEqual(hybridSearch(store, { vector: at(1), text: q, limit: 8, minSimilarity: 0.9, confidentSimilarity: 0.9 }).map((x) => x.memory.id), [m.id], q);
  }
});

test('a keyword-only match ranks below the best match by meaning', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = (content: string, embedding: Float32Array) =>
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding, by: 'x' });
  const keyword = add('zebra keyword only', at(0));
  const meaning = add('close in meaning', at(0.95));
  // Enough weaker memories that the keyword match is not among the vector candidates at all.
  for (let i = 0; i < 60; i++) add(`filler ${i}`, at(0.5));
  const r = hybridSearch(store, { vector: at(1), text: 'zebra', limit: 8, minSimilarity: 0.9, confidentSimilarity: 0.9 });
  assert.deepEqual(r.map((x) => x.memory.id), [meaning.id, keyword.id]);
});

test('findSimilar skips excluded ids', async () => {
  const e = createFakeEmbedder(); const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const text = 'wildlog listens on port 8080 behind the caddy proxy on the mini pc';
  const a = store.insert({ kind: 'decision', content: text, project: 'wildlog', tags: [], embedding: await e.embed(text, 'passage'), by: 'x' });
  const v = await e.embed(text, 'passage');
  assert.deepEqual(findSimilar(store, v, { kind: 'decision', project: 'wildlog' }, 0.9).map((s) => s.memory.id), [a.id]);
  assert.deepEqual(findSimilar(store, v, { kind: 'decision', project: 'wildlog', exclude: new Set([a.id]) }, 0.9), []);
});

// ---- Replaced facts (section 16) ----

/** A unit vector at cosine `c` to e0, on its own axis `axis` otherwise. */
const unitAt = (c: number, axis: number) => { const v = new Float32Array(EMBEDDING_DIM); v[0] = c; v[axis] = Math.sqrt(1 - c * c); return v; };
const Q = unitAt(1, 1);
function replacedWorld() {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date('2026-11-04T10:00:00Z'));
  let axis = 2;
  const add = (c: number, content = `fact ${axis}`) => store.insert({ kind: 'decision', content, project: 'wildlog', tags: [], embedding: unitAt(c, axis++), by: 'x' }).id;
  const newest = add(0.1, 'the newest fact replaces the others');
  const replaced = (c: number, content?: string) => { const id = add(c, content); store.supersessions.add(id, newest, 'owner'); return id; };
  return { db, store, add, replaced };
}
const search = (store: MemoryStore, extra: Record<string, unknown>) => hybridSearch(store, { vector: Q, text: 'zzzz', limit: 8, minSimilarity: 0.2, confidentSimilarity: 0.2, touch: false, ...extra } as any);
const strip = (rs: { memory: { id: string }; score: number; replaced?: true }[]) => rs.map((r) => ({ id: r.memory.id, score: r.score, replaced: r.replaced }));

test('with include, the current hits are exactly the hide result and replaced hits follow', () => {
  const { store, add, replaced } = replacedWorld();
  add(0.9); add(0.85); add(0.8);
  const r1 = replaced(0.95); const r2 = replaced(0.88);
  const hide = strip(search(store, {}));
  const include = strip(search(store, { replaced: 'include', replacedLimit: 5 }));
  assert.deepEqual(include.slice(0, hide.length), hide);
  assert.deepEqual(include.slice(hide.length).map((r) => [r.id, r.replaced]), [[r1, true], [r2, true]]);
});

test('a replaced fact can\'t set the floor', () => {
  const { store, add, replaced } = replacedWorld();
  add(0.5); add(0.5);
  const top = replaced(1);
  // The floor is 0.5 - 0.015 = 0.485 from the best current fact; from the replaced one at 1.0 it would be 0.985.
  const near = replaced(0.49);
  const hide = strip(search(store, { window: 0.015 }));
  assert.ok(hide.length >= 2);
  const include = strip(search(store, { window: 0.015, replaced: 'include' }));
  assert.deepEqual(include.slice(0, hide.length), hide);
  assert.deepEqual(include.slice(hide.length).map((r) => r.id), [top, near]);
});

test('recall\'s replaced hits follow even when they rank below the limit', () => {
  const { store, add, replaced } = replacedWorld();
  const c1 = add(0.9); const c2 = add(0.85); add(0.8);
  const r = replaced(0.75);
  assert.deepEqual(strip(search(store, { limit: 2, replaced: 'include' })).map((x) => x.id), [c1, c2, r]);
  const { store: s2, add: add2, replaced: rep2 } = replacedWorld();
  add2(0.9); add2(0.85);
  const seven = [0.7, 0.69, 0.68, 0.67, 0.66, 0.65, 0.64].map((c) => rep2(c));
  const out = strip(search(s2, { limit: 2, replaced: 'include' })).filter((x) => x.replaced);
  assert.deepEqual(out.map((x) => x.id), seven.slice(0, 5));
  const { store: s3, add: add3, replaced: rep3 } = replacedWorld();
  add3(0.9);
  const low = rep3(0.5);
  assert.ok(!search(s3, { window: 0.3, replaced: 'include' }).some((x) => x.memory.id === low));
  const kw = rep3(0.5, 'zzzz is in this replaced fact');
  assert.ok(search(s3, { window: 0.3, replaced: 'include' }).some((x) => x.memory.id === kw));
});

test('with joint-top, replaced facts outside the joint top limit are not counted', () => {
  const { store, add, replaced } = replacedWorld();
  add(0.9); add(0.85); add(0.8);
  const r = replaced(0.75);
  assert.equal(search(store, { limit: 2, replaced: 'include', replacedCut: 'joint-top', replacedLimit: 20 }).filter((x) => x.replaced).length, 0);
  assert.deepEqual(search(store, { limit: 4, replaced: 'include', replacedCut: 'joint-top', replacedLimit: 20 }).filter((x) => x.replaced).map((x) => x.memory.id), [r]);
});

test('replaced facts are never marked recalled', () => {
  const { store, add, replaced } = replacedWorld();
  const c = add(0.9);
  const r = replaced(0.95, 'zzzz keyword hit too');
  const out = search(store, { replaced: 'include', touch: true });
  assert.ok(out.some((x) => x.memory.id === r));
  assert.equal(store.get(r)!.lastRecalledAt, null);
  assert.notEqual(store.get(c)!.lastRecalledAt, null);
});

test('hybridSearch: pool returns more current results than limit, and sure says which would be marked recalled', () => {
  const db = openDb(':memory:'); const store = new MemoryStore(db, () => new Date());
  const add = (content: string, embedding: Float32Array) =>
    store.insert({ kind: 'decision', content, project: null, tags: [], embedding, by: 'x' });
  const confident = add('confident match', at(0.9));
  const between = add('plausible match', at(0.82));
  const keyword = add('zebra keyword only', at(0));
  const q = { vector: at(1), text: 'zebra', limit: 1, minSimilarity: 0.8, confidentSimilarity: 0.86, touch: false };
  assert.equal(hybridSearch(store, q).length, 1);
  const r = hybridSearch(store, { ...q, pool: 3 });
  assert.equal(r.length, 3);
  const sure = new Map(r.map((x) => [x.memory.id, x.sure]));
  assert.deepEqual([sure.get(confident.id), sure.get(keyword.id), sure.get(between.id)], [true, true, false]);
});
