/** B2: Tidy proposals in the Inbox: the group, the card (before and after), approval effects, undo, stale proposals, permissions. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { inboxModel, needsYouCounts } from './inboxModel.js';
import type { Memory } from '../memory/types.js';

const owner = { type: 'owner' } as const;
const A = 'database postgres chosen for storage engine';
const B = 'database postgres storage engine replaced by sqlite';
const KEY_PAGE = '## What it does\nA thing.\n\n## Key decisions\n- 2026-01-01 — **Old** first decision\n\n## Gotchas\nNone.\n';
const form = (body: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
const line = (html: string) => html.match(/<div class="notice undo-line" role="status">[\s\S]*?<\/div>/)?.[0];

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const d = app.deps;
  const save = async (c: string, kind: 'decision' | 'summary' = 'decision') => ((await d.service.remember({ kind, content: c, project: 'p', newProject: true }, owner)) as { memory: Memory }).memory;
  return { app, f, d, save };
}

test('a proposal is a Tidy proposals row under Approvals and counts in the needs-you number and the approvals count', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  assert.equal(inboxModel(d).total, 0);
  d.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'the later one wins' }, 'Codex');
  const m = inboxModel(d);
  assert.deepEqual(m.groups.map((g) => g.kind), ['tidyProposals']);
  assert.equal(m.groups[0]!.items.length, 1);
  assert.equal(m.total, 1, 'counts in the badge');
  assert.equal(needsYouCounts(d).total, 1);
  assert.equal(needsYouCounts(d).approvals, 1);
  const page = await (await f('/approvals')).text();
  assert.match(page, /Tidy proposals · 1/);
  assert.match(page, /1 thing waits for you/);
  assert.match(page, /Codex/);
});

test('the card shows before (the facts) and after (what would happen), why, and Approve and Reject', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'the later one wins' }, 'Codex');
  const html = await (await f(`/approvals?tidyproposal=${p.id}`)).text();
  assert.match(html, /Before:/);
  assert.match(html, /Keep\.<\/b>[\s\S]*replaced by sqlite/);
  assert.match(html, /Replaced\.<\/b>[\s\S]*chosen for storage engine/);
  assert.match(html, /After approval:/);
  assert.match(html, /the later one wins/);
  assert.match(html, new RegExp(`action="/tidy-proposals/${p.id}/approve"`));
  assert.match(html, new RegExp(`action="/tidy-proposals/${p.id}/reject"`));
  assert.match(html, /Nothing changes until you approve/);
});

test('approving a supersede replaces the fact, keeps it as history, says so with an Undo, and Undo brings it back', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  const r = await f(`/tidy-proposals/${p.id}/approve`, form({}));
  assert.equal(r.status, 303);
  assert.equal(d.store.list({ project: 'p', replaced: 'only' }).length, 1);
  assert.equal(d.store.list({ project: 'p' }).length, 1);
  const page = await (await f('/approvals')).text();
  assert.match(line(page)!, /replaced by the one you kept\. They stay as history\./);
  assert.match(line(page)!, />Undo</);
  assert.equal(inboxModel(d).total, 0);
  assert.equal((await f('/inbox/undo', form({ id: p.id }))).status, 303);
  assert.equal(d.store.list({ project: 'p' }).length, 2);
  assert.equal(d.tidy.pending().length, 1, 'it waits again');
});

test('approving a merge makes one new fact, keeps the originals as history; Undo removes the merged fact', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { merge: { ids: [a.id, b.id], content: 'sqlite now', kind: 'decision' } }, reason: 'r' }, 'Codex');
  const card = await (await f(`/approvals?tidyproposal=${p.id}`)).text();
  assert.match(card, /After approval, a new fact:[\s\S]*sqlite now/);
  await f(`/tidy-proposals/${p.id}/approve`, form({}));
  assert.deepEqual(d.store.list({ project: 'p' }).map((m) => m.content), ['sqlite now']);
  assert.equal(d.store.list({ project: 'p', replaced: 'only' }).length, 2);
  assert.match(line(await (await f('/approvals')).text())!, />Undo</);
  await f('/inbox/undo', form({ id: p.id }));
  assert.equal(d.store.list({ project: 'p' }).length, 2);
});

test('rejecting leaves the facts alone; Undo of the rejection puts it back', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id, b.id] } }, reason: 'r' }, 'Codex');
  assert.equal((await f(`/tidy-proposals/${p.id}/reject`, form({}))).status, 303);
  assert.equal(d.store.list({ project: 'p' }).length, 2);
  assert.match(line(await (await f('/approvals')).text())!, /Rejected\.[\s\S]*Undo/);
  await f('/inbox/undo', form({ id: p.id }));
  assert.equal(d.tidy.pending().length, 1);
});

test('keep: approval confirms without Undo and the facts are not offered again', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id, b.id] } }, reason: 'both fine' }, 'Codex');
  await f(`/tidy-proposals/${p.id}/approve`, form({}));
  const l = line(await (await f('/approvals')).text())!;
  assert.match(l, /Marked as looked at/);
  assert.doesNotMatch(l, />Undo</);
  assert.equal(d.tidy.session('p'), null);
});

test('a proposal whose facts changed since says "Changed since" and offers only Dismiss; a direct approve is refused with nothing applied', async (t) => {
  const { app, f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  app.advance(5000);
  await d.service.update(a.id, { content: `${A} edited` }, owner);
  const card = await (await f(`/approvals?tidyproposal=${p.id}`)).text();
  assert.match(card, /These facts changed since the proposal\. Ask the assistant to look again\./);
  assert.doesNotMatch(card, /Changed since:/);
  assert.doesNotMatch(card, /tidy-proposals\/[^"]+\/approve/);
  assert.match(card, />Dismiss</);
  // What the assistant saw (the text before the edit) and what the fact is now.
  assert.match(card, /What the assistant saw:/);
  assert.match(card, /Edited since\./);
  assert.ok(card.indexOf(A) > 0 && card.indexOf(`${A} edited`) > card.indexOf('Now:'));
  const r = await f(`/tidy-proposals/${p.id}/approve`, form({}));
  assert.equal(r.status, 409);
  assert.match(await r.text(), /changed since the proposal/);
  assert.equal(d.store.list({ project: 'p', replaced: 'only' }).length, 0);
  assert.equal(d.tidy.get(p.id)!.status, 'pending');
});

test('move to page: the card shows the lines, approval adds them and keeps the facts; "also retire" moves them to Deleted; a changed Key decisions shows the error', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const pg = await d.pages.create({ title: 'p — notes', project: 'p', body: KEY_PAGE }, 'owner');
  const p1 = d.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  const card = await (await f(`/approvals?tidyproposal=${p1.id}`)).text();
  assert.match(card, /added to <b>p — notes<\/b>, Key decisions/);
  assert.doesNotMatch(card, /\[\[fact:/, 'no raw link markup in the preview');
  assert.match(card, new RegExp(`<a class="wikilink" href="/memories/${a.id}">fact</a>`));
  assert.match(card, /Also retire these facts <small>/);
  assert.doesNotMatch(card, new RegExp(`<span class="meta">[^<]*${a.id}`), 'no raw fact id in a card');
  assert.match(card, /name="retire"/);
  await f(`/tidy-proposals/${p1.id}/approve`, form({}));
  assert.ok(d.pages.get(pg.id)!.body.includes(`[[fact:${a.id}|fact]]`));
  assert.equal(d.store.get(a.id)!.deletedAt, null);
  assert.doesNotMatch(line(await (await f('/approvals')).text())!, />Undo</);
  // With retire.
  const p2 = d.tidy.propose({ ids: [b.id], proposal: { move_to_page: { ids: [b.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  await f(`/tidy-proposals/${p2.id}/approve`, form({ retire: '1' }));
  assert.notEqual(d.store.get(b.id)!.deletedAt, null);
  assert.match(await (await f(`/memories/${b.id}`)).text(), /Moved to p — notes › Key decisions/);
  // Key decisions rewritten after a proposal: refused with the reason.
  const c = await save('database postgres storage engine chosen then abandoned');
  const p3 = d.tidy.propose({ ids: [c.id], proposal: { move_to_page: { ids: [c.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  const v = d.pages.get(pg.id)!;
  await d.pages.saveSection(pg.id, { base: v.version, anchor: 'key-decisions', text: '## Key decisions\n- 2026-11-05 — rewritten' }, 'owner');
  const r = await f(`/tidy-proposals/${p3.id}/approve`, form({}));
  assert.equal(r.status, 409);
  assert.match(await r.text(), /changed since the proposal/);
});

test('answering twice and answering as a visitor are refused', async (t) => {
  const { app, f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id] } }, reason: 'r' }, 'Codex');
  const anon = await fetch(app.baseUrl + `/tidy-proposals/${p.id}/approve`, { method: 'POST', body: new URLSearchParams({}), headers: { Origin: app.baseUrl }, redirect: 'manual' });
  assert.notEqual(anon.status, 303);
  assert.equal(d.tidy.pending().length, 1);
  await f(`/tidy-proposals/${p.id}/approve`, form({}));
  const again = await f(`/tidy-proposals/${p.id}/approve`, form({}));
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already answered/);
});

test('cards: no raw ids, no API jargon, the footer says "stay as history" only where facts are replaced, retire is a plain labelled checkbox apart from the buttons', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const sup = d.tidy.propose({ ids: [a.id, b.id], proposal: { supersede: { keep_id: b.id, replaced_ids: [a.id] } }, reason: 'r' }, 'Codex');
  const supCard = await (await f(`/approvals?tidyproposal=${sup.id}`)).text();
  assert.doesNotMatch(supCard, new RegExp(`${a.id}|${b.id}`));
  assert.doesNotMatch(supCard, /include_replaced/);
  assert.match(supCard, /Facts that are replaced stay as history/);
  d.tidy.reject(sup.id);
  const keep = d.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id, b.id] } }, reason: 'r' }, 'Codex');
  assert.doesNotMatch(await (await f(`/approvals?tidyproposal=${keep.id}`)).text(), /stay as history/);
  d.tidy.reject(keep.id);
  const pg = await d.pages.create({ title: 'p — notes', project: 'p', body: KEY_PAGE }, 'owner');
  const mv = d.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  const mvCard = await (await f(`/approvals?tidyproposal=${mv.id}`)).text();
  assert.doesNotMatch(mvCard, /stay as history/);
  assert.doesNotMatch(mvCard, /key-decisions/);
  assert.match(mvCard, /<label class="choice retire-opt"><input type="checkbox" name="retire" value="1">/);
  assert.doesNotMatch(mvCard, /class="check"/);
  assert.ok(mvCard.indexOf('name="retire"') < mvCard.indexOf('class="actions"'), 'the option sits above the buttons');
  // The new line takes the date style the page already uses.
  assert.match(mvCard, /<div>\d{4}-\d{2}-\d{2} — database postgres/);
});

test('Dismiss on a stale proposal says Dismissed, not Rejected', async (t) => {
  const { app, f, d, save } = await start(t);
  const a = await save(A); const b = await save(B);
  const p = d.tidy.propose({ ids: [a.id, b.id], proposal: { keep: { ids: [a.id, b.id] } }, reason: 'r' }, 'Codex');
  app.advance(5000);
  await d.service.update(a.id, { content: `${A} edited` }, owner);
  await f(`/tidy-proposals/${p.id}/reject`, form({}));
  const l = line(await (await f('/approvals')).text())!;
  assert.match(l, /Dismissed\./);
  assert.doesNotMatch(l, /Rejected/);
});

test('a moved and retired decision: its Key decisions line links as a fact (also retired), History says Moved, and the page is not flagged out of date for it', async (t) => {
  const { f, d, save } = await start(t);
  const a = await save(A);
  const pg = await d.pages.create({ title: 'p — notes', project: 'p', body: KEY_PAGE }, 'owner');
  const p = d.tidy.propose({ ids: [a.id], proposal: { move_to_page: { ids: [a.id], page_id: pg.id } }, reason: 'r' }, 'Codex');
  await f(`/tidy-proposals/${p.id}/approve`, form({ retire: '1' }));
  const page = await (await f(`/pages/${pg.id}`)).text();
  assert.doesNotMatch(page, /fact:[0-9a-f-]{36}/, 'no raw fact id');
  assert.match(page, new RegExp(`<a class="wikilink" href="/memories/${a.id}">fact</a>`));
  assert.equal((page.match(/database postgres chosen for storage engine/g) ?? []).length, 1, 'the text appears once');
  assert.doesNotMatch(page, /A decision it links to was removed/i);
  const fact = await (await f(`/memories/${a.id}`)).text();
  assert.match(fact, /<span class="verb">Moved to p — notes › Key decisions<\/span>/);
  assert.doesNotMatch(fact, /<span class="verb">delete<\/span>/);
});
