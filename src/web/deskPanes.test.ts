/*
 * The desktop's two desk-only query modes (desktop design §7): the Projects list partial (?pane=projects) and the side
 * fragment (?pane=side). Only desk.js asks for them; no canonical page carries what they hold.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { NEAR_SHOWN, nearIt, roadmapLine } from './deskSide.js';

const START = new Date('2026-11-04T09:00:00Z');
const owner = { type: 'owner' } as const;

async function app(t: TestContext) {
  const a = await startTestApp({ startAt: START });
  t.after(() => a.close());
  const f = await loggedIn(a);
  // Two open projects (one on the go), an idea, and one discussion.
  for (const [name, content] of [['wildlog', 'wildlog uses SwiftUI'], ['ferngrid', 'ferngrid runs on the mini PC'], ['tidewatch', 'tidewatch reads the tide tables']] as const)
    await a.deps.service.remember({ kind: 'decision', content, project: name }, owner);
  a.deps.registry.pin('ferngrid', 'owner');
  a.deps.registry.create('kiteboard', { state: 'idea', oneLiner: 'Kite sketches', area: null }, 'owner');
  a.deps.discussions.open({ name: 'Claude Code', model: 'Opus 4', access: 'full' }, { title: 'Which database?', question: 'SQLite or Postgres?', ask: ['ChatGPT'] });
  return { a, f };
}
/** The list without what marks the open project: the selection and a fold opened because it holds it. */
const strip = (s: string) => s.replace(/ is-selected/g, '').replace(/ aria-current="true"/g, '').replace(/(<details[^>]*) open>/g, '$1>').trim();

test('GET /?pane=projects is only the list partial, owner-only, not stored', async (t) => {
  const { a, f } = await app(t);
  const r = await f('/?pane=projects');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.text();
  assert.match(body, /^<div class="plist">/);
  assert.doesNotMatch(body, /<html|<nav class="side"|data-desk-open="xl"|phome-date|shelf-more|shelf-names|nib-peek|prow-one/);
  assert.match(body, /<a class="row nolead" href="\/discussions"><span class="txt"><b>All discussions<\/b><span class="n" hidden>1<\/span>/);
  // A ?project beside it is ignored: desk.js marks the selection itself.
  assert.doesNotMatch(await (await f('/?pane=projects&project=wildlog')).text(), /is-selected|aria-current/);
  // signed out: the login redirect, never the partial
  assert.notEqual((await fetch(a.baseUrl + '/?pane=projects', { redirect: 'manual' })).status, 200);
});

test('the list partial carries Not in the brain yet exactly when the home would', async (t) => {
  const { a, f } = await app(t);
  assert.doesNotMatch(await (await f('/?pane=projects')).text(), /id="notyet"/);
  const { device } = a.deps.devices.create('Mac');
  a.deps.devices.storeReport(device.id, [{ name: 'loose-sketches', git: true, branch: 'main', uncommitted: 0, unpushed: 0, lastCommit: null, remotes: [] }] as never);
  const body = await (await f('/?pane=projects')).text();
  assert.match(body, /id="notyet"/);
  assert.match(body, /<form method="post" action="\/folders\/add"><input type="hidden" name="name" value="loose-sketches">/);
  assert.match(await (await f('/')).text(), /id="notyet"/);
});

test('the list partial is the same list /?project=x renders, apart from the selection', async (t) => {
  const { f } = await app(t);
  const pane = await (await f('/?pane=projects')).text();
  for (const name of ['wildlog', 'kiteboard']) {
    const page = await (await f(`/?project=${name}`)).text();
    const list = page.slice(page.indexOf('<div class="plist">'), page.indexOf('<section id="panel"'));
    assert.equal(strip(list), strip(pane), name);
  }
});

test('the plain home keeps its desktop hooks; the list beside a project has none of the home-only ones', async (t) => {
  const { f } = await app(t);
  const home = await (await f('/')).text();
  assert.match(home, /phome-date/);
  // The 1920 px shelves went with the old folds (spec 2026-11-11): each area's "+N quiet" line opens in place instead.
  assert.doesNotMatch(home, /data-desk-open="xl"/);
  const beside = await (await f('/?project=wildlog')).text();
  assert.doesNotMatch(beside, /phome-date|data-desk-open="xl"|shelf-more|nib-peek|prow-one/);
});

// ---- The side fragment (?pane=side): Lately, Next for you (discussions), Near it ----

async function bare(t: TestContext) {
  const a = await startTestApp({ startAt: START });
  t.after(() => a.close());
  return { a, f: await loggedIn(a) };
}
const code = { name: 'Claude Code', model: 'Opus 4', access: 'full' } as const;
const gpt = { name: 'ChatGPT', model: 'GPT-5', access: 'full' } as const;
/** A discussion whose round 2 every asked assistant answered: it waits on the owner. */
function waiting(a: Awaited<ReturnType<typeof startTestApp>>, title: string) {
  const d = a.deps.discussions.open(code, { title, question: 'Q?', ask: ['ChatGPT'] });
  a.deps.discussions.reply(gpt, d.id, { text: 'One.' });
  a.deps.discussions.reply(gpt, d.id, { text: 'Two.' });
  return d;
}

test('/?project=x&pane=side is an aside with the project\'s newest 5 changes, never another project\'s', async (t) => {
  const { a, f } = await bare(t);
  for (let i = 0; i < 7; i++) { await a.deps.service.remember({ kind: 'decision', content: `wildlog choice number ${i} about cellars`, project: 'wildlog' }, owner); a.advance(1000); }
  for (let i = 0; i < 2; i++) { await a.deps.service.remember({ kind: 'decision', content: `ferngrid choice number ${i} about tunnels`, project: 'ferngrid' }, owner); a.advance(1000); }
  const r = await f('/?project=wildlog&pane=side');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.text();
  assert.match(body, /^<aside class="desk-side"><section class="desk-lately"><h3>Lately<\/h3>/);
  assert.equal((body.match(/<li class="entry/g) ?? []).length, 5);
  assert.doesNotMatch(body, /ferngrid/);
  assert.match(body, /wildlog choice number 6/);
  assert.ok(body.indexOf('number 6') < body.indexOf('number 5'), 'newest first');
  assert.match(body, /href="\/memories\/[\w-]+\?from=%2F%3Fproject%3Dwildlog"/);
  assert.doesNotMatch(body, /<html|<nav class="side"/);
});

test('Lately still lists a quiet project after 300+ newer changes elsewhere', async (t) => {
  const { a, f } = await bare(t);
  for (let i = 0; i < 7; i++) await a.deps.service.remember({ kind: 'decision', content: `wildlog choice number ${i} about cellars`, project: 'wildlog' }, owner);
  a.advance(60_000);
  for (let i = 0; i < 320; i++) a.deps.store.insert({ kind: 'decision', content: `ferngrid note ${i}`, project: 'ferngrid', tags: [], embedding: new Float32Array(384), by: 'owner' });
  const body = await (await f('/?project=wildlog&pane=side')).text();
  assert.equal((body.match(/<li class="entry/g) ?? []).length, 5);
  assert.doesNotMatch(body, /ferngrid/);
});

test('an unknown project or discussion gives an empty 404, not a page', async (t) => {
  const { f } = await bare(t);
  for (const path of ['/?project=nope&pane=side', '/discussions/nope?pane=side']) {
    const r = await f(path);
    assert.equal(r.status, 404, path);
    assert.equal(await r.text(), '', path);
  }
});

test('Next for you after a discussion is the next waiting one, then none', async (t) => {
  const { a, f } = await bare(t);
  const one = waiting(a, 'First question');
  const two = waiting(a, 'Second question');
  const order = a.deps.discussions.waitingOnOwner().map((x) => x.id);
  const [first, second] = order[0] === one.id ? [one, two] : [two, one];
  const nextOf = async (id: string) => (await (await f(`/discussions/${id}?pane=side`)).text()).match(/href="\/discussions\/([\w-]+)" data-sheet/)?.[1];
  assert.equal(await nextOf(first.id), second.id);
  assert.equal(await nextOf(second.id), first.id, 'after the last one, the first that is not this one');
  await a.deps.discussions.close('owner', second.id, { decision: 'Done.' });
  assert.equal(await nextOf(first.id), undefined, 'one waiting, and it is this one: no Next for you');
  // approvals are never next after a discussion
  await a.deps.service.remember({ kind: 'profile', content: 'Prefers short answers' }, { type: 'ai', name: 'Grok' });
  assert.doesNotMatch(await (await f(`/discussions/${first.id}?pane=side`)).text(), /approvals/);
});

test('no canonical page carries the desk extras, on the phone or anywhere', async (t) => {
  const { a, f } = await app(t);
  await a.deps.service.remember({ kind: 'profile', content: 'Prefers short answers' }, { type: 'ai', name: 'Grok' });
  const d = waiting(a, 'Which database?');
  for (const path of ['/', '/?project=wildlog', '/approvals', `/discussions/${d.id}`])
    assert.doesNotMatch(await (await f(path)).text(), /desk-side|desk-next|desk-profile|desk-lately|Your profile today|Next for you|>Lately</, path);
});
