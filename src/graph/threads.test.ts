import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEmbedder } from '../memory/fakeEmbedder.js';
import { graphWorld, type GraphWorld } from '../testing/graphWorld.js';
import { chooseLinks, groupThreads, MeaningIndex, topThreads, type ItemKey } from './threads.js';

const fact = (id: string): ItemKey => ({ kind: 'm', id, anchor: '' });

async function save(w: GraphWorld, project: string, content: string): Promise<string> {
  const r = await w.service.remember({ kind: 'decision', content, project }, w.owner) as { status: string; memory: { id: string } };
  assert.equal(r.status, 'saved');
  w.advance(1000);
  return r.memory.id;
}

/** alpha and beta are about restic backups to the nas; gamma is about karst telemetry. */
async function fixture(w: GraphWorld) {
  const a1 = await save(w, 'alpha', 'restic nightly backups to the nas');
  const a2 = await save(w, 'alpha', 'restic prune keeps nas backups small');
  const b1 = await save(w, 'beta', 'outline backups use restic to the nas');
  const b2 = await save(w, 'beta', 'nas restic backups are checked nightly');
  const g1 = await save(w, 'gamma', 'karst ride telemetry on iphone');
  return { a1, a2, b1, b2, g1, all: [a1, a2, b1, b2, g1] };
}

const clear = (w: GraphWorld) => w.db.exec('DELETE FROM meaning_indexed; DELETE FROM meaning_links;');
type Row = { a_kind: string; a_id: string; a_anchor: string; b_kind: string; b_id: string; b_anchor: string; similarity: number };
const rows = (w: GraphWorld): Row[] => w.db.prepare('SELECT * FROM meaning_links').all() as Row[];
const pairKey = (r: Row) => `${r.a_kind}:${r.a_id}:${r.a_anchor}|${r.b_kind}:${r.b_id}:${r.b_anchor}`;
const rowsOf = (w: GraphWorld, id: string) => rows(w).filter((r) => r.a_id === id || r.b_id === id);
const projectOf = (w: GraphWorld, id: string) => (w.db.prepare('SELECT project FROM memories WHERE id = ?').get(id) as { project: string }).project;
const storedFingerprint = (w: GraphWorld, id: string) =>
  (w.db.prepare("SELECT fingerprint FROM meaning_indexed WHERE kind = 'm' AND id = ?").get(id) as { fingerprint: string } | undefined)?.fingerprint;

test('an item links only to other projects, at or above the floor, and each pair is stored once smaller key first', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  clear(w);
  w.meaning.factsChanged(f.all);
  const all = rows(w);
  assert.ok(all.length > 0);
  for (const r of all) {
    assert.notEqual(projectOf(w, r.a_id), projectOf(w, r.b_id));
    assert.ok(r.similarity >= 0.5);
    assert.ok(`${r.a_kind}\u0000${r.a_id}\u0000${r.a_anchor}` < `${r.b_kind}\u0000${r.b_id}\u0000${r.b_anchor}`);
  }
  assert.equal(new Set(all.map(pairKey)).size, all.length);
  assert.equal(rowsOf(w, f.g1).length, 0, 'gamma is like nothing else');
});

test('an item keeps its 5 nearest; more come only from others choosing it', async () => {
  const w = graphWorld();
  const base = 'restic nas backups nightly prune offsite encrypted weekly';
  const ys: string[] = [];
  for (let i = 0; i < 7; i++) ys.push(await save(w, `y${i}`, `${base} unique${i}`));
  clear(w);
  w.meaning.factsChanged(ys);
  // x shares the unique words of y0..y4, so those five are its nearest.
  const x = await save(w, 'x', `${base} unique0 unique1 unique2 unique3 unique4`);
  w.meaning.factsChanged([x]);
  const linked = rowsOf(w, x).map((r) => (r.a_id === x ? r.b_id : r.a_id)).sort();
  assert.deepEqual(linked, ys.slice(0, 5).sort());
  // z's only neighbour is x, so z chooses x: x now has a sixth row, chosen by another item.
  const z = await save(w, 'z', `${base} unique0 unique1 unique2 unique3 unique4`);
  w.meaning.factsChanged([z]);
  assert.equal(rowsOf(w, x).length, 6);
  assert.ok(rowsOf(w, x).some((r) => r.a_id === z || r.b_id === z));
});

const POOL = ['restic', 'nas', 'backups', 'nightly', 'karst', 'telemetry', 'iphone', 'swift', 'docker', 'caddy', 'tunnel', 'grafana'];
function prng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; }; }

async function grid(w: GraphWorld, projects: number, perProject: number) {
  const rnd = prng(7);
  const ids: string[] = [];
  for (let p = 0; p < projects; p++) {
    for (let k = 0; k < perProject; k++) {
      const words = Array.from({ length: 5 }, () => POOL[Math.floor(rnd() * POOL.length)]!);
      ids.push(await save(w, `p${p}`, `${words.join(' ')} note${p}x${k}`));
    }
  }
  return ids;
}

const chosenKeys = (w: GraphWorld, meaning: MeaningIndex) => {
  const items = meaning.loadItems();
  const k = (i: number) => `${items[i]!.kind}:${items[i]!.id}:${items[i]!.anchor}`;
  return new Set(chooseLinks(items, 0.5).map(({ i, j }) => [k(i), k(j)].sort().join('|')));
};
const storedKeys = (w: GraphWorld) => new Set(rows(w).map(pairKey));

test('the stored links contain chooseLinks, and every extra pair is a kept link', async () => {
  const w = graphWorld();
  const ids = await grid(w, 6, 4);
  for (const order of [ids, [...ids].reverse()]) {
    clear(w);
    for (const id of order) w.meaning.factsChanged([id]);
    const chosen = chosenKeys(w, w.meaning);
    const stored = storedKeys(w);
    for (const c of chosen) assert.ok(stored.has(c), `missing ${c}`);
    for (const r of rows(w)) {
      if (chosen.has(pairKey(r))) continue;
      assert.notEqual(projectOf(w, r.a_id), projectOf(w, r.b_id));
      assert.ok(r.similarity >= 0.5);
    }
  }
});

test('with at most 5 candidates per item the stored links equal chooseLinks', async () => {
  const w = graphWorld();
  const ids = await grid(w, 3, 2);
  clear(w);
  for (const id of ids) w.meaning.factsChanged([id]);
  assert.deepEqual([...storedKeys(w)].sort(), [...chosenKeys(w, w.meaning)].sort());
});

async function fillers(w: GraphWorld, n: number) {
  for (let i = 0; i < n; i++) await save(w, 'gamma', `karst ride telemetry on iphone backups nas run${i}`);
}

test('links others chose do not pile up: a catch-up keeps little beyond each item\'s own nearest', async () => {
  const w = graphWorld({ floor: 0.3 });
  const words = ['restic', 'nas', 'backups', 'nightly', 'prune', 'offsite', 'encrypted', 'weekly', 'copies', 'checks'];
  // 20 one-fact projects, all alike enough to clear the floor with each other.
  for (let i = 0; i < 20; i++) await save(w, `q${i}`, `${words.filter((_, k) => (i >> (k % 5)) & 1 || k < 5).join(' ')} own${i}`);
  clear(w);
  await w.meaning.catchUp();
  const chosen = chosenKeys(w, w.meaning).size;
  const stored = rows(w).length;
  // Memory ids are random, so the catch-up's order and its few kept links vary: over 40 orders this rule stored 1.1–1.3×
  // chooseLinks, the old "beats Y's weakest" rule 2.9–3.2×.
  assert.ok(stored <= chosen * 1.6, `${stored} stored for ${chosen} chosen`);
});

test('words count an edited item\'s new words', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  await fillers(w, 10);
  await w.meaning.catchUp();
  w.meaning.threadPairs();
  assert.equal(w.meaning.wordCounts()!.df('zebra'), 0);
  await w.service.update(f.a1, { content: 'restic nightly backups to the nas zebra' }, w.owner);
  await w.service.update(f.b1, { content: 'outline backups use restic to the nas zebra' }, w.owner);
  w.advance(1000);
  w.meaning.factsChanged([f.a1, f.b1]);
  assert.equal(w.meaning.wordCounts()!.df('zebra'), 2);
  const first = w.meaning.threadPairs().map((p) => p.words);
  assert.deepEqual(w.meaning.threadPairs().map((p) => p.words), first);
});

test('re-indexing X keeps the link Y chose to X', async () => {
  const w = graphWorld({ floor: 0.3 });
  const base = 'restic nas backups nightly prune offsite';
  const x = await save(w, 'p', `${base} garage door`);
  for (let i = 0; i < 5; i++) await save(w, `r${i}`, `${base} near${i}`);
  // y shares only "garage door" with x, so x is its one neighbour, weaker than x's five.
  const y = await save(w, 'q', 'garage door karst ride');
  clear(w);
  await w.meaning.catchUp();
  const xy = () => rows(w).some((r) => (r.a_id === x && r.b_id === y) || (r.a_id === y && r.b_id === x));
  assert.ok(xy(), 'y chose x');
  assert.ok(rowsOf(w, y).length < 5);
  await w.service.update(x, { content: `${base} garage door copies` }, w.owner);
  w.advance(1000);
  assert.equal(w.meaning.refresh([fact(x)], { force: true }), 1);
  assert.equal(rowsOf(w, x).filter((r) => r.a_id !== y && r.b_id !== y).length, 5);
  assert.ok(xy(), 'the link y chose to x stays');
});

test('the fingerprint is the vector and the project, so a move changes it', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  const [before] = w.meaning.loadItems([fact(f.a1)]);
  assert.equal(w.meaning.fingerprint(before!), w.meaning.fingerprint(w.meaning.loadItems([fact(f.a1)])[0]!));
  assert.match(w.meaning.fingerprint(before!), /^[0-9a-f]{16}$/);
  await w.service.update(f.a1, { content: 'restic nightly backups to the nas', project: 'delta' }, w.owner);
  const [after] = w.meaning.loadItems([fact(f.a1)]);
  assert.equal(after!.project, 'delta');
  assert.notEqual(w.meaning.fingerprint(after!), w.meaning.fingerprint(before!));
});

test('two links make a thread; one stray pair does not', () => {
  const t = groupThreads([{ pa: 'a', pb: 'b', s: 0.9 }, { pa: 'b', pb: 'a', s: 0.88 }, { pa: 'a', pb: 'c', s: 0.95 }], 0.86);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.a, 'a');
  assert.equal(t[0]!.b, 'b');
  assert.equal(t[0]!.links, 2);
  assert.ok(Math.abs(t[0]!.raw - 0.06) < 1e-9);
});

test('strength is relative to the strongest and each project keeps its 4 strongest', () => {
  const pairs = [
    { a: 'hub', b: 'p1', raw: 6 }, { a: 'hub', b: 'p2', raw: 5 }, { a: 'hub', b: 'p3', raw: 4 },
    { a: 'hub', b: 'p4', raw: 3 }, { a: 'hub', b: 'p5', raw: 2 }, { a: 'hub', b: 'p6', raw: 1 },
    // p5 and p6 each have four stronger threads of their own, so neither keeps its thread to hub.
    ...['x1', 'x2', 'x3', 'x4'].map((x) => ({ a: 'p5', b: x, raw: 3 })),
    ...['y1', 'y2', 'y3', 'y4'].map((y) => ({ a: 'p6', b: y, raw: 3 })),
  ];
  const top = topThreads(pairs);
  const names = top.map((t) => `${t.a}-${t.b}`);
  for (const k of ['hub-p1', 'hub-p2', 'hub-p3', 'hub-p4']) assert.ok(names.includes(k), k);
  assert.ok(!names.includes('hub-p5'));
  assert.ok(!names.includes('hub-p6'));
  assert.equal(top[0]!.strength, 1);
  assert.equal(top.find((t) => t.b === 'p4')!.strength, 0.5);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1]!.raw >= top[i]!.raw);
});

const hasPair = (w: GraphWorld, a: string, b: string) => w.meaning.threadPairs().some((p) => p.a === a && p.b === b);

test('reading skips forgotten facts, deleted pages, removed sections and pairs that became one project', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  w.registry.create('delta', { state: 'open' }, 'owner');
  const page = await w.pages.create({ title: 'Delta backups', project: 'delta', body: '## One\nrestic backups to the nas\n\n## Two\nnas restic backups nightly' }, 'owner');
  w.advance(1000);
  clear(w);
  await w.meaning.catchUp();
  assert.ok(hasPair(w, 'alpha', 'beta'));
  assert.ok(hasPair(w, 'alpha', 'delta'));
  const indexed = w.db.prepare('SELECT COUNT(*) AS n, MAX(indexed_at) AS at FROM meaning_indexed').get();

  // Forgetting both alpha facts hides the pair; undo brings it back with no re-index.
  w.service.forget(f.a1, w.owner);
  w.service.forget(f.a2, w.owner);
  assert.ok(!hasPair(w, 'alpha', 'beta'));
  for (const id of [f.a1, f.a2]) await w.service.undo(w.store.history(id)[0]!.id, w.owner);
  assert.ok(hasPair(w, 'alpha', 'beta'));
  assert.deepEqual(w.db.prepare('SELECT COUNT(*) AS n, MAX(indexed_at) AS at FROM meaning_indexed').get(), indexed);

  // A removed section's links are skipped, and so are a deleted page's.
  const linksOfDelta = () => w.meaning.threadPairs().filter((p) => p.a === 'delta' || p.b === 'delta').reduce((n, p) => n + p.links, 0);
  const before = linksOfDelta();
  const saved = await w.pages.save(page.id, { base: page.version, body: '## One\nrestic backups to the nas' }, 'owner');
  assert.ok(linksOfDelta() < before);
  await w.pages.save(saved.id, { base: saved.version, body: '## One\nrestic backups to the nas\n\n## Two\nnas restic backups nightly' }, 'owner');
  w.pages.remove(page.id, 'owner');
  assert.equal(linksOfDelta(), 0);

  // Merging beta into alpha makes their links same-project.
  w.service.moveProject('beta', 'alpha', w.owner);
  assert.ok(!w.meaning.threadPairs().some((p) => p.a === 'alpha' && p.b === 'beta'));
  assert.ok(!w.meaning.threadPairs().some((p) => p.a === p.b));
});

test('thread words come from both sides and fall back to none', async () => {
  const w = graphWorld();
  await fixture(w);
  await fillers(w, 10);
  await save(w, 'delta', 'karst ride telemetry on iphone');
  await save(w, 'delta', 'karst ride telemetry iphone');
  clear(w);
  await w.meaning.catchUp();
  const pairs = w.meaning.threadPairs();
  const ab = pairs.find((p) => p.a === 'alpha' && p.b === 'beta')!;
  assert.ok(ab.words.includes('restic'), JSON.stringify(ab.words));
  assert.ok(!ab.words.includes('alpha') && !ab.words.includes('beta'));
  const dg = pairs.find((p) => p.a === 'delta' && p.b === 'gamma')!;
  assert.ok(dg, 'delta and gamma are related');
  assert.deepEqual(dg.words, []);
});

test('the startup catch-up re-indexes an item whose fingerprint no longer matches, and nothing else', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  clear(w);
  await w.meaning.catchUp();
  w.db.prepare("UPDATE meaning_indexed SET fingerprint = 'x' WHERE id = ?").run(f.b2);
  const r = await w.meaning.catchUp();
  assert.equal(r.checked, 5);
  assert.equal(r.indexed, 1);
  assert.equal(typeof r.ms, 'number');
  assert.equal(storedFingerprint(w, f.b2), w.meaning.fingerprint(w.meaning.loadItems([fact(f.b2)])[0]!));
  assert.equal((await w.meaning.catchUp()).indexed, 0);
});

test('the catch-up works in chunks', async () => {
  const w = graphWorld();
  await fixture(w);
  clear(w);
  let chunks = 0;
  const r = await w.meaning.catchUp({ chunk: 2, onChunk: () => { chunks++; } });
  assert.equal(chunks, 3);
  assert.equal(r.indexed, 5);
});

test('the catch-up drops the rows of sections no longer on their page', async () => {
  const w = graphWorld();
  await fixture(w);
  w.registry.create('delta', { state: 'open' }, 'owner');
  const page = await w.pages.create({ title: 'Delta backups', project: 'delta', body: '## One\nrestic backups to the nas\n\n## Two\nnas restic backups nightly' }, 'owner');
  clear(w);
  await w.meaning.catchUp();
  await w.pages.save(page.id, { base: page.version, body: '## One\nrestic backups to the nas' }, 'owner');
  await w.meaning.catchUp();
  const anchors = (w.db.prepare("SELECT anchor FROM meaning_indexed WHERE kind = 's'").all() as { anchor: string }[]).map((r) => r.anchor);
  assert.deepEqual(anchors, ['one']);
  assert.equal(rows(w).filter((r) => r.a_anchor === 'two' || r.b_anchor === 'two').length, 0);
});

test('a save during the catch-up is not overwritten by the catch-up\'s older copy', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  // Items are processed in key order and ids are random: edit the one processed last, so the first chunk never
  // reaches it and the guard is exercised on every run.
  const lastFactId = [...f.all].sort().at(-1)!;
  const vector = await createFakeEmbedder().embed('karst restic telemetry', 'passage');
  const editFactSync = (id: string, content: string) => {
    const m = w.store.get(id)!;
    w.store.update(id, { content, project: m.project, tags: m.tags, embedding: vector, by: 'owner' });
    w.advance(1000);
  };
  w.db.exec('DELETE FROM meaning_indexed; DELETE FROM meaning_links;');
  let edited = false;
  const run = w.meaning.catchUp({ chunk: 1, onChunk: () => { if (!edited) { edited = true; editFactSync(lastFactId, 'karst restic telemetry'); w.meaning.factsChanged([lastFactId]); } } });
  await run;
  const [item] = w.meaning.loadItems([fact(lastFactId)]);
  assert.equal(storedFingerprint(w, lastFactId), w.meaning.fingerprint(item!));
});

test('a link a save hook makes during the catch-up survives the catch-up re-indexing the other end later', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  clear(w);
  // X is processed last; Y is saved after the first chunk and its hook links it to X.
  const x = [...f.all].sort().at(-1)!;
  const xText = w.store.get(x)!.content;
  let y: Promise<string> | undefined;
  await w.meaning.catchUp({ chunk: 1, onChunk: () => { y ??= save(w, 'delta', `${xText} again`); } });
  const yId = await y!;
  assert.ok(rowsOf(w, yId).some((r) => r.a_id === x || r.b_id === x), 'the X–Y link is still there');
  // And nothing a fresh index would add is missing.
  const stored = new Set(rows(w).map(pairKey));
  clear(w);
  await w.meaning.catchUp();
  for (const k of rows(w).map(pairKey)) assert.ok(stored.has(k), k);
});

test('a decision tagged status is a status: it is never indexed, as the calibration left statuses out', async () => {
  const w = graphWorld();
  const f = await fixture(w);
  const r = await w.service.remember({ kind: 'decision', content: 'restic nightly backups to the nas done, prune still open', project: 'delta', tags: ['status'] }, w.owner) as { status: string; memory: { id: string } };
  assert.equal(r.status, 'saved');
  assert.deepEqual(w.store.get(r.memory.id)!.tags, ['status'], 'an owner save keeps the tag');
  clear(w);
  await w.meaning.catchUp();
  assert.equal(w.meaning.loadItems([fact(r.memory.id)]).length, 0);
  assert.equal(rowsOf(w, r.memory.id).length, 0);
  assert.ok(rowsOf(w, f.a1).length > 0, 'the plain decisions are still linked');
});
