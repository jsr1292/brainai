import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  app.deps.registry.create('leasesv2', { state: 'open' }, 'owner');
  return { app, f: await loggedIn(app) };
}
const form = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body), redirect: 'manual' as const });
const improve = { kind: 'improve', area: 'testing', what: 'Pushed the demo without running <script>alert(1)</script> the suite', practise: 'Run npm test before every push', project: 'leasesv2' };
const strength = { kind: 'strength', area: 'reviewing', what: 'Caught the missing alias case in review', project: 'leasesv2' };

test('/growth needs the owner', async (t) => {
  const { app } = await start(t);
  const res = await fetch(`${app.baseUrl}/growth`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/login\?next=%2Fgrowth$/);
  const { observation } = await app.deps.growth.note(strength, 'Claude Code');
  const post = await fetch(`${app.baseUrl}/growth/${observation.id}/react`, { method: 'POST', body: new URLSearchParams({ reaction: 'agree' }), redirect: 'manual', headers: { origin: app.baseUrl } });
  assert.equal(post.status, 302);
  assert.equal(post.headers.get('location'), `/login?next=${encodeURIComponent(`/growth/${observation.id}/react`)}`);
  assert.equal(app.deps.growth.list()[0]!.observation.reaction, null, 'a reaction without a login changes nothing');
});

test('/growth lists strengths and things to improve with their evidence, escaped', async (t) => {
  const { app, f } = await start(t);
  await app.deps.growth.note(strength, 'Claude Code');
  await app.deps.growth.note(improve, 'Codex');
  await app.deps.growth.note(improve, 'Claude');
  const res = await f('/growth');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>Growth<\/title>/);
  const s = body.indexOf('<h2>Strengths <span class="n">');
  const i = body.indexOf('<h2>To improve <span class="n">');
  assert.ok(s > 0 && i > s, `${s} ${i}`);
  const strengths = body.slice(s, i);
  const toImprove = body.slice(i);
  assert.match(strengths, /Reviewing AI work/);
  assert.match(strengths, /Caught the missing alias case in review/);
  assert.doesNotMatch(strengths, /Practise/);
  assert.match(toImprove, /Testing and checking/);
  assert.match(toImprove, /leasesv2/);
  assert.match(toImprove, /Run npm test before every push/);
  assert.match(toImprove, /noted 2 times/);
  // A day in the owner's time zone, like "3 Nov", not a bare UTC date.
  assert.match(toImprove, /latest <time datetime="[^"]+" title="[^"]+">[^<]+<\/time>/);
  assert.match(toImprove, /Codex/);
  assert.match(toImprove, /<details[^>]*>\s*<summary>Evidence/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert/);
  for (const label of ['Agree', 'Disagree', 'Dismiss']) assert.match(body, new RegExp(`>${label}</button>`));
});

test('the empty Growth list says nothing has been noticed yet', async (t) => {
  const { f } = await start(t);
  assert.match(await (await f('/growth')).text(), /Nothing noticed yet\. Assistants add observations as they work with you\./);
});

test('Growth heads like the other two Week views: a date-style line under the title, then the control with All weeks', async (t) => {
  const { f } = await start(t);
  const body = await (await f('/growth')).text();
  assert.match(body, /<div class="rv-head">\s*<h1>Growth<\/h1>\s*<p class="meta">[^<]+<\/p>\s*<nav class="subnav" aria-label="Week">[\s\S]*?<span class="subnav-extra"><a href="\/review\/all">All weeks<\/a><\/span><\/nav>\s*<\/div>/);
  const line = /<div class="rv-head">\s*<h1>Growth<\/h1>\s*<p class="meta">([^<]+)<\/p>/.exec(body)![1]!;
  assert.ok(line.length <= 40, `one line on the iPhone, as the date line is, so the control sits at the same height: "${line}"`);
});

test('reacting marks the observation and Undo clears it', async (t) => {
  const { app, f } = await start(t);
  const { observation } = await app.deps.growth.note(strength, 'Claude Code');
  const agree = await f(`/growth/${observation.id}/react`, form({ reaction: 'agree' }));
  assert.equal(agree.status, 303);
  assert.equal(agree.headers.get('location'), `/growth#o-${observation.id}`);
  assert.equal(app.deps.growth.list()[0].observation.reaction, 'agree');
  assert.match(await (await f('/growth')).text(), /<button type="submit"[^>]*aria-pressed="true"[^>]*>Agree<\/button>/);

  await f(`/growth/${observation.id}/react`, form({ reaction: 'dismiss' }));
  const dimmed = await (await f('/growth')).text();
  assert.match(dimmed, new RegExp(`<li class="card obs dimmed" id="o-${observation.id}"`));
  assert.match(dimmed, />Undo<\/button>/);

  await f(`/growth/${observation.id}/react`, form({ reaction: 'clear' }));
  assert.equal(app.deps.growth.list()[0].observation.reaction, null);
  assert.doesNotMatch(await (await f('/growth')).text(), /dimmed/);
});

test('an unknown reaction answers 400; an unknown id answers 404', async (t) => {
  const { app, f } = await start(t);
  const { observation } = await app.deps.growth.note(strength, 'Claude Code');
  assert.equal((await f(`/growth/${observation.id}/react`, form({ reaction: 'love' }))).status, 400);
  assert.equal((await f(`/growth/${observation.id}/react`, form({}))).status, 400);
  assert.equal((await f('/growth/nope/react', form({ reaction: 'agree' }))).status, 404);
  assert.equal(app.deps.growth.list()[0].observation.reaction, null);
});

test('the Growth list is marked as part of Week', async (t) => {
  const { f } = await start(t);
  const body = await (await f('/growth')).text();
  assert.match(body, /<a href="\/review"[^>]*>Last week<\/a>/);
  assert.match(body, /aria-current="page">Week<\/a>/);
});

test('the work memory has no Growth in Settings and no Growth list', async (t) => {
  const { f } = await start(t, { mode: 'work' });
  const body = await (await f('/settings')).text();
  assert.doesNotMatch(body, /<section id="growth"/);
  assert.doesNotMatch(body, /href="#growth"/);
  assert.equal((await f('/growth')).status, 404);
});

test('a reaction sent from a review returns to it; without back it returns to Growth', async (t) => {
  const { app, f } = await start(t);
  const { observation } = await app.deps.growth.note(strength, 'Claude Code');
  const fromReview = await f(`/growth/${observation.id}/react`, form({ reaction: 'agree', back: '/review' }));
  assert.equal(fromReview.status, 303);
  assert.equal(fromReview.headers.get('location'), '/review');
  const evil = await f(`/growth/${observation.id}/react`, form({ reaction: 'clear', back: '//evil.example' }));
  assert.equal(evil.headers.get('location'), `/growth#o-${observation.id}`);
});


test('the old Growth address and form path still work', async (t) => {
  const { app, f } = await start(t);
  const old = await f('/settings/growth');
  assert.deepEqual([old.status, old.headers.get('location')], [301, '/growth']);
  const { observation } = await app.deps.growth.note(strength, 'Claude Code');
  const reaction = await f(`/settings/growth/${observation.id}/react`, form({ reaction: 'agree' }));
  assert.deepEqual([reaction.status, reaction.headers.get('location')], [303, `/growth#o-${observation.id}`]);
  assert.equal(app.deps.growth.list()[0]!.observation.reaction, 'agree');
});
