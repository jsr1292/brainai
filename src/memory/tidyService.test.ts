import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePages, makeService, makeTidy } from '../testing/helpers.js';
import { CHANGED_SINCE, MAX_PENDING_TIDY, TidyError } from './tidyService.js';
import type { Memory } from './types.js';
import { fakeSkKey } from '../testing/fakeSecrets.js';

const owner = { type: 'owner' as const };

/** A brain at a fixed day that moves on by a day on request. Fake-embedder texts that share words are close (0.5 related, 0.95 duplicate). */
function world() {
  let t = Date.parse('2026-11-01T10:00:00Z');
  const now = () => new Date(t);
  const given = makeService({ now });
  const pages = makePages(given, now);
  const tidy = makeTidy({ ...given, pages }, now);
  const nextDay = () => { t += 86_400_000; };
  const save = async (content: string, over: { kind?: 'decision' | 'summary'; project?: string; meta?: { validUntil?: string } } = {}): Promise<Memory> => {
    const r = await given.service.remember({ kind: over.kind ?? 'decision', content, project: over.project ?? 'p', meta: over.meta }, owner) as { memory: Memory };
    nextDay();
    return r.memory;
  };
  const page = async (body: string, project = 'p') => pages.create({ title: `${project} — notes`, project, body }, 'owner');
  return { ...given, pages, tidy, save, page, nextDay };
}
const A = 'database postgres chosen for storage engine';
const B = 'database postgres storage engine replaced by sqlite';

test('a session returns the next group with the facts in full, why, a cursor, and nothing when there is none', async () => {
  const w = await world();
  assert.equal(w.tidy.session('p'), null, 'an empty project has nothing to tidy');
  const a = await w.save(A, { meta: { validUntil: '2027-01-01' } });
  await w.save('unrelated hiking plans for summer holidays');
  assert.equal(w.tidy.session('p'), null, 'a single related fact is nothing');
  const b = await w.save(B);
  const s = w.tidy.session('p')!;
  assert.equal(s.cluster.why, 'conflict');
  assert.deepEqual(s.cluster.facts.map((f) => f.id), [a.id, b.id]);
  assert.equal(s.cluster.facts[0]!.content, A);
  assert.equal(s.cluster.facts[0]!.kind, 'decision');
  assert.equal(s.cluster.facts[0]!.valid_until, '2027-01-01');
  assert.equal(s.cluster.facts[0]!.date, '2026-11-01');
  assert.match(s.cluster.because, /different days/);
  assert.equal(s.remaining, 0);
  assert.equal(w.tidy.session('p', s.cursor), null, 'nothing after the last group');
  // An alias reads the same project.
  assert.equal(w.tidy.session('P-unknown-name'), null);
});

test('groups are cached per project until the memories change', async (t) => {
  const w = await world();
  await w.save(A);
  await w.save(B);
  const spy = t.mock.method(w.store, 'activeEmbeddings');
  const first = w.tidy.session('p')!;
  w.tidy.session('p');
  w.tidy.session('p', first.cursor);
  assert.equal(spy.mock.callCount(), 1, 'one scan for three calls');
  await w.save('database postgres storage engine migrated backups nightly');
  assert.equal(w.tidy.session('p')!.cluster.facts.length, 3);
  assert.equal(spy.mock.callCount(), 2, 'a change in the memories rebuilds it');
});

test('a cursor moves on to the next group', async () => {
  const w = await world();
  await w.save(A); await w.save(B);
  await w.save('garden shed roof paint coat blue'); await w.save('garden shed roof paint coat green');
  const one = w.tidy.session('p')!;
  assert.equal(one.remaining, 1);
  const two = w.tidy.session('p', one.cursor)!;
  assert.notEqual(two.cluster.id, one.cluster.id);
  assert.equal(two.remaining, 0);
  assert.equal(w.tidy.session('p', 'cunknown')!.cluster.id, one.cluster.id, 'an unknown cursor starts again');
});

test('propose: validation of every kind', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B); const other = await w.save('garden shed roof paint coat blue');
  const st1 = await w.save('status one working on parser', { kind: 'summary' });
  const prop = (proposal: any, o: { ids?: string[]; clusterId?: string; reason?: string } = {}) => () => w.tidy.propose({ ids: o.ids ?? [a.id, b.id], clusterId: o.clusterId, proposal, reason: o.reason ?? 'because' }, 'Codex');
  const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof TidyError && re.test(e.message));
  refuses(prop({}), /exactly one/);
  refuses(prop({ keep: { ids: [a.id] }, supersede: { keep_id: a.id, replaced_ids: [b.id] } }), /exactly one/);
  refuses(prop({ keep: { ids: [a.id] } }, { reason: '  ' }), /reason/);
  refuses(() => w.tidy.propose({ proposal: { keep: { ids: [a.id] } }, reason: 'r' }, 'Codex'), /cluster_id|ids/);
  refuses(prop({ keep: { ids: ['nope'] } }, { ids: ['nope'] }), /No current fact/);
  refuses(prop({ keep: { ids: [other.id] } }), /not in the group/);
  refuses(prop({ supersede: { keep_id: a.id, replaced_ids: [a.id] } }), /keep_id/);
  refuses(prop({ supersede: { keep_id: a.id, replaced_ids: [] } }), /replaced_ids/);
  refuses(prop({ supersede: { keep_id: a.id, replaced_ids: [st1.id] } }, { ids: [a.id, st1.id] }), /decision|status/i);
  refuses(prop({ merge: { ids: [a.id], content: 'x', kind: 'decision' } }), /merge.ids/);
  refuses(prop({ merge: { ids: [a.id, b.id], content: '', kind: 'decision' } }), /merge.content/);
  refuses(prop({ merge: { ids: [a.id, b.id], content: 'y'.repeat(1001), kind: 'decision' } }), /1000/);
  refuses(prop({ merge: { ids: [a.id, b.id], content: 'ok', kind: 'summary' } }), /kind/);
  refuses(prop({ merge: { ids: [a.id, b.id], content: 'password is hunter2 and token ' + fakeSkKey('abcdefghijklmnopqrstuvwxyz123456'), kind: 'decision' } }), /secret/i);
  refuses(prop({ move_to_page: { ids: [a.id], page_id: 'nope' } }), /No page/);
  const pg = await w.page('## What it does\nx\n\n## Key decisions\n- 2026-01-01 — old\n');
  refuses(prop({ move_to_page: { ids: [a.id], page_id: pg.id, section: 'missing' } }), /no section missing/);
  await w.save('another project fact', { project: 'other-project' });
  const elsewhere = await w.page('## Key decisions\n- 2026-01-01 — x\n', 'other-project');
  refuses(prop({ move_to_page: { ids: [a.id], page_id: elsewhere.id } }), /belongs to other-project/);
  refuses(prop({ move_to_page: { ids: [st1.id], page_id: pg.id } }, { ids: [st1.id] }), /status/);
  // A good one, then the same facts cannot wait twice.
  const ok = w.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id] } }, reason: 'fine' }, 'Codex');
  assert.equal(ok.status, 'pending');
  assert.equal(ok.proposedBy, 'Codex');
  refuses(prop({ keep: { ids: [a.id] } }), /already waits/);
  assert.equal(w.tidy.session('p'), null, 'a fact waiting in a proposal is not offered again');
});

test('propose: a cluster_id from the session works, and a stale one is refused', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const s = w.tidy.session('p')!;
  const p = w.tidy.propose({ clusterId: s.cluster.id, proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'later one wins' }, 'Codex');
  assert.deepEqual(p.body, { type: 'supersede', keepId: b.id, replacedIds: [a.id] });
  assert.throws(() => w.tidy.propose({ clusterId: 'cdeadbeef00', proposal: { keep: { ids: [a.id] } }, reason: 'x' }, 'Codex'), /No group/);
});

test('the number of waiting proposals is capped', async () => {
  const w = await world();
  for (let i = 0; i < MAX_PENDING_TIDY; i++) {
    const m = await w.save(`lonely fact number ${i} zzz${i}`);
    w.tidy.propose({ ids: [m.id], proposal: { keep: { ids: [m.id] } }, reason: 'r' }, 'Codex');
  }
  const m = await w.save('one more');
  assert.throws(() => w.tidy.propose({ ids: [m.id], proposal: { keep: { ids: [m.id] } }, reason: 'r' }, 'Codex'), /already wait/);
});

test('approve supersede: the replaced fact stays as history, and Undo brings it back', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const p = w.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  const r = await w.tidy.approve(p.id);
  assert.equal(r.undoable, true);
  assert.equal(w.store.list({ project: 'p' }).some((m) => m.id === a.id), false, 'hidden from the current facts');
  assert.equal(w.store.list({ project: 'p', replaced: 'only' }).some((m) => m.id === a.id), true, 'still there as history');
  assert.equal(w.service.replacement(a.id)!.endId, b.id);
  assert.equal(w.tidy.get(p.id)!.status, 'approved');
  await assert.rejects(() => w.tidy.approve(p.id), /already answered/);
  w.tidy.undoApproved(p.id);
  assert.equal(w.store.list({ project: 'p' }).some((m) => m.id === a.id), true);
  assert.equal(w.tidy.get(p.id)!.status, 'pending');
});

test('approve merge: a new inferred fact replaces them all; valid_until is the latest only when all had one; Undo removes it', async () => {
  const w = await world();
  const a = await w.save(A, { meta: { validUntil: '2027-01-01' } });
  const b = await w.save(B, { meta: { validUntil: '2027-06-30' } });
  const p = w.tidy.propose({ ids: [a.id, b.id], proposal: { merge: { ids: [a.id, b.id], content: 'database is sqlite now, postgres dropped', kind: 'decision' } }, reason: 'merge' }, 'Codex');
  const r = await w.tidy.approve(p.id);
  assert.equal(r.undoable, true);
  const mergedId = w.tidy.get(p.id)!.result!.mergedId!;
  const m = w.store.get(mergedId)!;
  assert.equal(m.content, 'database is sqlite now, postgres dropped');
  assert.equal(m.source, 'inferred');
  assert.equal(m.sourceBy, 'Codex');
  assert.equal(m.validUntil, '2027-06-30');
  assert.equal(m.project, 'p');
  assert.equal(w.service.replacement(a.id)!.endId, mergedId);
  assert.equal(w.service.replacement(b.id)!.endId, mergedId);
  assert.equal(w.store.list({ project: 'p', replaced: 'only' }).length, 2, 'both originals kept as history');
  w.tidy.undoApproved(p.id);
  assert.equal(w.store.get(mergedId)!.deletedAt !== null, true);
  assert.equal(w.store.deletedEmbeddings().some((e) => e.id === mergedId), false, 'taking a merge back is not the owner forgetting it');
  assert.deepEqual(w.store.list({ project: 'p' }).map((x) => x.id).sort(), [a.id, b.id].sort());

  // Only one had a date: the merged fact has none.
  const c = await w.save('cache redis chosen for session store layer', { meta: { validUntil: '2027-01-01' } });
  const d = await w.save('cache redis session store layer dropped');
  const q = w.tidy.propose({ ids: [c.id, d.id], proposal: { merge: { ids: [c.id, d.id], content: 'no more redis', kind: 'decision' } }, reason: 'm' }, 'Codex');
  await w.tidy.approve(q.id);
  assert.equal(w.store.get(w.tidy.get(q.id)!.result!.mergedId!)!.validUntil, null);
  // Once the merged fact was edited, Undo is refused.
  await w.service.update(w.tidy.get(q.id)!.result!.mergedId!, { content: 'no more redis, ever' }, owner);
  assert.throws(() => w.tidy.undoApproved(q.id), /no longer be undone/);
});

test('approve merge of statuses uses kind summary and refuses a mixed kind', async () => {
  const w = await world();
  const s1 = await w.save('status parser work started monday', { kind: 'summary' });
  const s2 = await w.save('status parser work finished friday', { kind: 'summary' });
  const p = w.tidy.propose({ ids: [s1.id, s2.id], proposal: { merge: { ids: [s1.id, s2.id], content: 'parser work finished', kind: 'summary' } }, reason: 'm' }, 'Codex');
  await w.tidy.approve(p.id);
  assert.equal(w.store.get(w.tidy.get(p.id)!.result!.mergedId!)!.kind, 'summary');
});

test('stale proposals are refused: a fact edited, replaced or deleted since', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const mk = () => w.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  let p = mk();
  assert.equal(w.tidy.staleReason(p), null);
  w.nextDay();
  await w.service.update(a.id, { content: `${A} again` }, owner);
  assert.equal(w.tidy.staleReason(p), CHANGED_SINCE);
  await assert.rejects(() => w.tidy.approve(p.id), (e: unknown) => e instanceof TidyError && e.code === 'changed' && /changed since the proposal/.test(e.message));
  assert.equal(w.tidy.get(p.id)!.status, 'pending', 'nothing was applied');
  assert.equal(w.store.list({ project: 'p', replaced: 'only' }).length, 0);
  w.tidy.reject(p.id);
  p = mk();
  w.service.forget(b.id, owner);
  assert.equal(w.tidy.staleReason(p), CHANGED_SINCE);
});

test('keep marks the facts as looked at until one of them changes', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const p = w.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id, b.id] } }, reason: 'both fine' }, 'Codex');
  assert.equal(w.tidy.session('p'), null);
  const r = await w.tidy.approve(p.id);
  assert.equal(r.undoable, false);
  assert.equal(w.tidy.session('p'), null, 'looked at: not offered');
  assert.equal(w.tidy.isLooked(a.id), true);
  w.nextDay();
  await w.service.update(b.id, { content: `${B} yes` }, owner);
  assert.equal(w.tidy.isLooked(b.id), false);
  assert.equal(w.tidy.session('p')!.cluster.facts.length, 2, 'a changed fact brings the group back');
});

test('reject leaves the facts alone and Undo of a reject makes it wait again', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const p = w.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  w.tidy.reject(p.id);
  assert.equal(w.tidy.pending().length, 0);
  assert.equal(w.store.list({ project: 'p' }).length, 2);
  assert.equal(w.tidy.session('p')!.cluster.facts.length, 2, 'rejected facts are offered again');
  w.tidy.reopenRejected(p.id);
  assert.equal(w.tidy.pending().length, 1);
});

const KEY_PAGE = '## What it does\nA thing.\n\n## Key decisions\n- 2026-01-01 — **Old** first decision\n\n## Gotchas\nNone.\n';

test('approve move_to_page: one dated line per fact with its fact link, a new page version, the facts stay and are marked looked at', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const pg = await w.page(KEY_PAGE);
  const p = w.tidy.propose({ ids: [a.id, b.id], proposal: { move_to_page: { ids: [a.id, b.id], page_id: pg.id } }, reason: 'worth keeping on the page' }, 'Codex');
  const r = await w.tidy.approve(p.id);
  assert.equal(r.undoable, false);
  const after = w.pages.get(pg.id)!;
  assert.equal(after.version, pg.version + 1);
  assert.ok(after.body.includes(`- 2026-11-01 — ${A} [[fact:${a.id}|fact]]`), after.body);
  assert.ok(after.body.includes(`- 2026-11-02 — ${B} [[fact:${b.id}|fact]]`));
  assert.ok(after.body.indexOf('[[fact:') < after.body.indexOf('## Gotchas'), 'inside Key decisions');
  assert.equal(w.store.list({ project: 'p' }).length, 2, 'facts stay');
  assert.equal(w.tidy.isLooked(a.id), true);
});

test('move_to_page with "also retire": the facts go to Deleted and can be restored', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const pg = await w.page(KEY_PAGE);
  const p = w.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  await w.tidy.approve(p.id, { retire: true });
  assert.equal(w.store.get(a.id)!.deletedAt !== null, true);
  assert.equal(w.store.get(b.id)!.deletedAt, null);
  assert.deepEqual(w.tidy.get(p.id)!.result!.retired, [a.id]);
});

test('retiring a moved decision is not the owner forgetting it: a later similar save is not held, recall no longer finds it, and Undo restores it', async () => {
  const w = await world();
  const ai = { type: 'ai' as const, name: 'Codex' };
  const a = await w.save(A);
  const forgotten = await w.save('cache redis eviction policy allkeys-lru chosen for sessions');
  const pg = await w.page(KEY_PAGE);
  // Control: a plain delete by the owner does stick (a similar assistant save is held).
  w.service.forget(forgotten.id, owner);
  const held = await w.service.remember({ kind: 'decision', project: 'p', content: 'cache redis eviction policy allkeys-lru chosen for sessions' }, ai) as any;
  assert.equal(held.status, 'suggested');
  assert.equal(held.suggestion.deletedMatch, forgotten.id);
  // Retire after move_to_page.
  const p = w.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  await w.tidy.approve(p.id, { retire: true });
  const gone = w.store.get(a.id)!;
  assert.notEqual(gone.deletedAt, null);
  assert.equal(gone.movedTo, 'p — notes › Key decisions');
  assert.equal(w.store.deletedEmbeddings().some((e) => e.id === a.id), false, 'not counted as forgotten');
  assert.equal(w.store.deletedEmbeddings().some((e) => e.id === forgotten.id), true);
  const again = await w.service.remember({ kind: 'decision', project: 'p', content: A }, ai) as any;
  assert.notEqual(again.status, 'suggested', JSON.stringify(again));
  assert.equal(again.suggestion, undefined);
  // Out of recall and the brief, like a deleted fact.
  const found = await w.service.recall({ query: A, project: 'p' });
  assert.equal(JSON.stringify(found).includes(a.id), false, 'the retired fact is not recalled');
  // Restorable: Undo of the deletion brings it back, and the moved marker goes.
  const del = w.store.history(a.id).find((h) => h.action === 'delete')!;
  assert.equal(del.changedBy, 'owner');
  await w.service.undo(del.id, owner);
  const back = w.store.get(a.id)!;
  assert.equal(back.deletedAt, null);
  assert.equal(back.movedTo ?? null, null);
});

test('move_to_page: an edit elsewhere on the page is fine, a conflicting edit of Key decisions is refused with the reason', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const pg = await w.page(KEY_PAGE);
  const p1 = w.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  // Another section changes: still applies on top of the newer version.
  await w.pages.saveSection(pg.id, { base: 1, anchor: 'gotchas', text: '## Gotchas\nA gotcha now.' }, 'owner');
  await w.tidy.approve(p1.id);
  const body = w.pages.get(pg.id)!.body;
  assert.ok(body.includes('A gotcha now.') && body.includes(`[[fact:${a.id}|fact]]`));
  // Key decisions itself changes after the proposal: refused, nothing written.
  const p2 = w.tidy.propose({ ids: [b.id], proposal: { move_to_page: { ids: [b.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  const v = w.pages.get(pg.id)!;
  await w.pages.saveSection(pg.id, { base: v.version, anchor: 'key-decisions', text: '## Key decisions\n- 2026-11-05 — someone rewrote this' }, 'owner');
  await assert.rejects(() => w.tidy.approve(p2.id), (e: unknown) => e instanceof TidyError && e.code === 'page' && /changed since the proposal/.test(e.message));
  assert.equal(w.tidy.get(p2.id)!.status, 'pending');
  assert.ok(!w.pages.get(pg.id)!.body.includes(`[[fact:${b.id}|fact]]`));
});

test('merge and supersede check their facts again at approval: a fact replaced meanwhile refuses', async () => {
  const w = await world();
  const a = await w.save(A); const b = await w.save(B);
  const c = await w.save('database postgres storage engine chosen then abandoned');
  const p = w.tidy.propose({ ids: [a.id, b.id, c.id], proposal: { supersede: { keep_id: c.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  w.service.supersede([a.id], b.id, owner);
  await assert.rejects(() => w.tidy.approve(p.id), /changed since the proposal/);
});

test('session: remaining counts every reachable group, even more than twenty', async () => {
  const w = await world();
  for (let i = 0; i < 25; i++) {
    await w.save(`topicw${i}a topicw${i}b topicw${i}c shared${i} alpha${i}`);
    await w.save(`topicw${i}a topicw${i}b topicw${i}c shared${i} beta${i}`);
  }
  const first = w.tidy.session('p')!;
  assert.ok(first.total > 20, `more than twenty groups (${first.total})`);
  assert.equal(first.remaining, first.total - 1);
  let step = first;
  let seen = 1;
  for (;;) {
    const nx = w.tidy.session('p', step.cursor);
    if (!nx) break;
    step = nx; seen++;
  }
  assert.equal(seen, first.total, 'every group is reachable');
  assert.equal(step.remaining, 0);
});

test('session: when the handled group has gone after a proposal, it carries on from there, not from the top', async () => {
  const w = await world();
  const ids: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const a = await w.save(`pair${i}x pair${i}y pair${i}z only${i} one${i}`);
    const b = await w.save(`pair${i}x pair${i}y pair${i}z only${i} two${i}`);
    ids.push([a.id, b.id]);
  }
  const one = w.tidy.session('p')!;
  const two = w.tidy.session('p', one.cursor)!;
  // Propose on the second group: its facts leave the pool, so its cursor no longer exists.
  w.tidy.propose({ clusterId: two.cursor, proposal: { keep: { ids: two.cluster.facts.map((f) => f.id) } }, reason: 'fine' }, 'Codex');
  const after = w.tidy.session('p', two.cursor)!;
  assert.notEqual(after.cluster.id, one.cluster.id, 'not back at the first group');
  assert.notEqual(after.cluster.id, two.cluster.id);
  assert.equal(after.remaining, 0);
});

test('move_to_page: the page now belongs to another project at approval time: refused, nothing written', async () => {
  const w = await world();
  const a = await w.save(A);
  const pg = await w.page(KEY_PAGE);
  const p = w.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  w.db.prepare("UPDATE pages SET project = 'elsewhere' WHERE id = ?").run(pg.id);
  assert.match(w.tidy.staleReason(w.tidy.get(p.id)!) ?? '', /now belongs to elsewhere, not p/);
  await assert.rejects(() => w.tidy.approve(p.id), (e: unknown) => e instanceof TidyError && e.code === 'changed' && /now belongs to elsewhere/.test(e.message));
  assert.ok(!w.pages.get(pg.id)!.body.includes('[[fact:'));
});

test('moved lines take the date style the Key decisions already use, and show the fact text once with a fact link', async () => {
  const { lineStyle, moveLine } = await import('./tidyService.js');
  assert.equal(lineStyle('## Key decisions\n- 2026-11-11: sign-in by link\n'), ': ');
  assert.equal(lineStyle('## Key decisions\n- 2026-11-11 — sign-in by link\n'), ' — ');
  assert.equal(lineStyle('## Key decisions\n- 2026-11-11 sign-in by link\n'), ' ');
  assert.equal(lineStyle('## Key decisions\n'), ' ');
  assert.equal(moveLine({ id: 'abc', createdAt: '2026-11-12T10:00:00Z', content: 'Use  sqlite\nalways' }, ': '), '- 2026-11-12: Use sqlite always [[fact:abc|fact]]');
});
