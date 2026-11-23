/** The computed project health label (list, tile, panel; English and Spanish), the Monday card in both layouts, mondayNote and the MCP fields. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { clockTo } from '../testing/reviewFixtures.js';
import { mondayNote } from './mondayCard.js';
import { healthReason } from './projectsViews.js';
import { mcpServerFor } from './mcpFor.js';
import { runWithLocale } from '../i18n/core.js';

process.env.OWNER_TIMEZONE = 'UTC';
const ai = { type: 'ai', name: 'Claude Code' } as const;
const DAY = 86_400_000;
type App = Awaited<ReturnType<typeof startTestApp>>;

/**
 * Monday 23 Nov 2026. quillbox was last touched on 1 Nov (stuck); tidewatch finished a step on 22 Nov and has two
 * unpushed commits in a fresh report (at risk); wildlog waits on a signature due 25 Nov (needs you); calm is new; shelved is
 * parked with a late item (no label at all).
 */
async function world(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-11-01T09:00:00Z') });
  t.after(() => app.close());
  const { service, registry } = app.deps;
  await service.remember({ kind: 'roadmap', project: 'quillbox', newProject: true, content: 'Now: ship it' }, ai);
  await service.remember({ kind: 'roadmap', project: 'tidewatch', newProject: true, content: 'Done: tides page (2026-11-22)\nNow: alerts' }, ai);
  await service.remember({ kind: 'roadmap', project: 'shelved', newProject: true, content: 'Now: x\nWaiting on you: reply (by 2026-11-01)' }, ai);
  registry.setState('shelved', 'parked', 'owner');
  clockTo(app.deps, app.advance, '2026-11-23T09:00:00Z');
  await service.remember({ kind: 'roadmap', project: 'wildlog', newProject: true, content: 'Done: setup (2026-11-20)\nNow: release\nWaiting on you: sign the form (by 2026-11-25)' }, ai);
  await service.remember({ kind: 'roadmap', project: 'calm', newProject: true, content: 'Now: relax' }, ai);
  for (const p of ['quillbox', 'tidewatch', 'wildlog', 'calm']) registry.setInfo(p, { area: 'apps' }, 'owner');
  const { device } = app.deps.devices.create('Mac');
  app.deps.devices.storeReport(device.id, [{ name: 'tidewatch', git: true, branch: 'main', uncommitted: 0, unpushed: 2, lastCommit: '2026-11-22T10:00:00Z', remotes: [] }] as never);
  const f = await loggedIn(app);
  const language = (l: string) => app.deps.store.setSwitch('ui_language', l);
  const state = (name: string) => app.deps.projects.healthFor(name, app.deps.now())?.state ?? null;
  return { app, f, language, state };
}

test('each open project gets its computed state, and the rest get none', async (t) => {
  const { state } = await world(t);
  assert.equal(state('wildlog'), 'needs_you');
  assert.equal(state('tidewatch'), 'at_risk');
  assert.equal(state('quillbox'), 'stuck');
  assert.equal(state('calm'), 'on_track');
  assert.equal(state('shelved'), null, 'parked: no label');
});

test('a folder report older than a week says nothing about work only on the Mac', async (t) => {
  const { app, state } = await world(t);
  assert.equal(state('tidewatch'), 'at_risk');
  app.advance(6 * DAY);
  assert.equal(state('tidewatch'), 'at_risk', 'a 6 day old report is fresh');
  app.advance(2 * DAY);
  assert.equal(state('tidewatch'), 'on_track', 'an 8 day old report is stale: not trusted');
});

test('English: the list rows and tiles carry the label, with the reasons as tooltip and screen-reader text; on track is quiet', async (t) => {
  const { f } = await world(t);
  const body = await (await f('/')).text();
  // needs you: the chip carries the date, so no second due chip; the reasons are the link's description, not part of its name.
  assert.match(body, /<span class="pcard-name">wildlog<\/span><span class="chip hl hl-needs" data-health="needs_you" title="“sign the form” is due 25 Nov\.">Needs you<\/span><\/span><span id="hw-wildlog" hidden>“sign the form” is due 25 Nov\.<\/span>/);
  assert.match(body, /class="pcard ptile" href="[^"]*wildlog[^"]*" aria-describedby="hw-wildlog"/);
  const wildTile = body.slice(body.indexOf('<span class="pcard-name">wildlog'), body.indexOf('</a>', body.indexOf('<span class="pcard-name">wildlog')));
  assert.doesNotMatch(wildTile, /<span class="chip (soon|late)"/);
  assert.doesNotMatch(body, /visually-hidden">: /, 'no hidden text inside a link name');
  assert.match(body, /<span class="pcard-name">tidewatch<\/span><span class="chip hl hl-risk" data-health="at_risk" title="2 commits are only on your Mac\.">At risk</);
  assert.match(body, /<span class="chip hl hl-stuck" data-health="stuck" title="Nothing finished or saved for 22 days, and “ship it” is still to do\.">Stuck</);
  assert.match(body, /<span class="pcard-name">calm<\/span><span class="hl hl-ok" data-health="on_track">On track<\/span>/);
  assert.doesNotMatch(body, /<span class="hl hl-ok"[^>]*title=/, 'on track has no reasons');
  assert.doesNotMatch(body, /shelved[^]{0,300}data-health/, 'a parked project has no label');
  // at risk: the health chip says it, so the "!" mark is not drawn on top.
  assert.doesNotMatch(body, /tidewatch[^]{0,600}class="pwarn"/);
  // The compact rows (the list beside an open project, and the wide list pane) carry it too.
  for (const path of ['/?pane=projects', '/?project=calm']) {
    const rows = await (await f(path)).text();
    assert.match(rows, /<span class="prow-chip"><span class="chip hl hl-needs" data-health="needs_you"/, path);
    assert.match(rows, /<span class="prow-chip"><span class="hl hl-ok" data-health="on_track">On track<\/span>/, path);
  }
});

test('Spanish: the labels and the reasons read in Spanish', async (t) => {
  const { f, language } = await world(t);
  language('es');
  const body = await (await f('/')).text();
  assert.match(body, /data-health="needs_you" title="«sign the form» vence el 25 nov\.">Te necesita</);
  assert.match(body, /data-health="at_risk" title="2 commits están solo en tu Mac\.">En riesgo</);
  assert.match(body, /data-health="stuck" title="Nada terminado ni guardado desde hace 22 días, y «ship it» sigue pendiente\.">Atascado</);
  assert.match(body, /data-health="on_track">Va bien</);
  assert.doesNotMatch(body, />(Needs you|At risk|Stuck|On track)</);
});

test('the project page header shows the label and each reason as its own line', async (t) => {
  const { app, f, language } = await world(t);
  await app.deps.service.update(app.deps.service.roadmapOf('wildlog')!.id, { content: 'Done: setup (2026-11-20)\nNow: release\nWaiting on you: sign the form (by 2026-11-25); pay the fee (by 2026-11-20)' }, ai);
  const body = await (await f('/?project=wildlog')).text();
  const head = body.slice(body.indexOf('<div class="phealth">'), body.indexOf('</ul></div>', body.indexOf('<div class="phealth">')));
  assert.match(head, /^<div class="phealth"><span class="chip hl hl-needs"[^>]*>Needs you/);
  assert.match(head, /<ul class="phealth-why plain-list"><li>“sign the form” is due 25 Nov\.<\/li><li>“pay the fee” is late \(due 20 Nov\)\.<\/li>$/);
  language('es');
  assert.match(await (await f('/?project=wildlog')).text(), /<li>«sign the form» vence el 25 nov\.<\/li><li>«pay the fee» va con retraso \(vencía el 20 nov\)\.<\/li>/);
  assert.doesNotMatch(await (await f('/?project=shelved')).text(), /phealth/);
});

test('the Monday card shows in the narrow and the wide layouts, with the three numbers', async (t) => {
  const { f } = await world(t);
  for (const path of ['/', '/?pane=projects', '/?project=calm']) {
    const body = await (await f(path)).text();
    assert.ok(body.indexOf('<section class="monday-card"') > 0, path);
    assert.ok(body.indexOf('<section class="monday-card"') < body.indexOf('class="idea"'), `${path}: above the idea field`);
    assert.match(body, /<h2 id="monday-h">Your week, 16[^<]*22 Nov<\/h2>/, path);
    assert.match(body, /<dt class="mc-l">step done last week<\/dt><dd class="mc-n">1<\/dd>/, path);
    assert.match(body, /<dt class="mc-l">thing waiting on you<\/dt><dd class="mc-n">1<\/dd>/, path);
    assert.match(body, /<dt class="mc-l">project stuck<\/dt><dd class="mc-n">1<\/dd>/, path);
  }
});

test('the Monday card in Spanish, and zero still shows', async (t) => {
  const { app, f, language } = await world(t);
  language('es');
  const body = await (await f('/')).text();
  assert.match(body, /<h2 id="monday-h">Tu semana, /);
  assert.match(body, /<dt class="mc-l">paso hecho la semana pasada<\/dt>/);
  assert.match(body, /<dt class="mc-l">cosa te espera<\/dt>/);
  assert.match(body, /<dt class="mc-l">proyecto atascado<\/dt>/);
  assert.match(body, /class="secondary">Leer<\/button>/);
  assert.match(body, /class="ghost">Ahora no<\/button>/);
  assert.doesNotMatch(body, /Your week|Read it|Not now/);
  // Tick the waiting item and park the stuck project: both numbers go to 0 and stay on the card.
  language('en');
  app.deps.registry.setState('quillbox', 'parked', 'owner');
  await app.deps.projects.completeWaiting('wildlog', 0, 'sign the form', app.deps.now());
  const zero = await (await f('/')).text();
  assert.match(zero, /<dt class="mc-l">things waiting on you<\/dt><dd class="mc-n">0<\/dd>/);
  assert.match(zero, /<dt class="mc-l">projects stuck<\/dt><dd class="mc-n">0<\/dd>/);
});

test('mondayNote is the card\'s own decision, in one line, in both languages', async (t) => {
  const { app, f } = await world(t);
  assert.deepEqual(mondayNote(app.deps), { monday: '2026-11-16', text: 'Your week: 1 step done, 1 waiting on you, 1 stuck.' });
  assert.equal(runWithLocale('es', () => mondayNote(app.deps))?.text, 'Tu semana: 1 paso hecho, 1 cosa te espera, 1 atascado.');
  await f('/review/2026-11-16/dismiss', { method: 'POST', body: new URLSearchParams() });
  assert.equal(mondayNote(app.deps), null, 'dismissed: no note, no card');
  assert.doesNotMatch(await (await f('/')).text(), /monday-card/);
});

test('MCP: project_brief returns health for an open project only, and whats_left each open project\'s state', async (t) => {
  const { app } = await world(t);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcpServerFor(app.deps, { actorName: 'Claude Code', access: 'full' }).connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  t.after(() => client.close());
  const data = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const r: any = await client.callTool({ name, arguments: args });
    const text: string = r.content.map((b: any) => b.text).find((x: string) => x.includes('<memories>\n'));
    return JSON.parse(text.slice(text.indexOf('<memories>\n') + 11, text.lastIndexOf('\n</memories>')));
  };
  const wild = await data('project_brief', { project: 'wildlog' });
  assert.equal(wild.health.state, 'needs_you');
  assert.deepEqual(wild.health.reasons, ['Waiting on the owner: "sign the form" is due 2026-11-25.']);
  assert.equal((await data('project_brief', { project: 'tidewatch' })).health.state, 'at_risk');
  assert.equal((await data('project_brief', { project: 'calm' })).health.state, 'on_track');
  assert.deepEqual((await data('project_brief', { project: 'calm' })).health.reasons, []);
  assert.equal('health' in await data('project_brief', { project: 'shelved' }), false, 'parked: no health');
  const left = await data('whats_left', {});
  const byName = Object.fromEntries(left.projects.map((p: any) => [p.project, p]));
  assert.equal(byName.wildlog.health, 'needs_you');
  assert.equal(byName.quillbox.health, 'stuck');
  assert.equal(byName.calm.health, 'on_track');
  assert.equal('health' in byName.shelved, false);
});

test('plural notes: zero and many read correctly in both languages', async (t) => {
  const { app, f } = await world(t);
  app.deps.registry.setState('quillbox', 'parked', 'owner');
  await app.deps.projects.completeWaiting('wildlog', 0, 'sign the form', app.deps.now());
  assert.equal(mondayNote(app.deps)?.text, 'Your week: 1 step done, 0 waiting on you, 0 stuck.');
  assert.equal(runWithLocale('es', () => mondayNote(app.deps))?.text, 'Tu semana: 1 paso hecho, 0 cosas te esperan, 0 atascados.');
  assert.ok(await f('/'));
});

test('a due date in a reason is a calendar day, whatever the owner\'s zone', () => {
  const prev = process.env.OWNER_TIMEZONE;
  process.env.OWNER_TIMEZONE = 'Pacific/Auckland';
  try {
    const now = new Date('2026-11-23T09:00:00Z');
    assert.equal(healthReason({ kind: 'needs_you', text: 'sign', due: '2026-11-25', days: 2 }, now), '“sign” is due 25 Nov.');
    assert.equal(runWithLocale('es', () => healthReason({ kind: 'needs_you', text: 'sign', due: '2026-11-20', days: -3 }, now)), '«sign» va con retraso (vencía el 20 nov).');
  } finally {
    if (prev === undefined) delete process.env.OWNER_TIMEZONE; else process.env.OWNER_TIMEZONE = prev;
  }
});

test('MCP: a restricted connection sees the health of the projects it may read, and only those', async (t) => {
  const { app } = await world(t);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcpServerFor(app.deps, { actorName: 'Reader', access: 'projects', projects: ['wildlog'] }).connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return r.content.map((b: any) => b.text).join('\n') as string;
  };
  const left = await call('whats_left', {});
  assert.match(left, /"project":\s*"wildlog"[^]*"health":\s*"needs_you"/);
  assert.doesNotMatch(left, /quillbox|tidewatch|calm/);
  assert.match(await call('project_brief', { project: 'wildlog' }), /"state":\s*"needs_you"/);
  const other = await call('project_brief', { project: 'quillbox' });
  assert.doesNotMatch(other, /"state":\s*"stuck"|Nothing finished/);
});
