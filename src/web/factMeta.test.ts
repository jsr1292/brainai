/** A12 on the dashboard: the fact page shows and edits the date and the source, the lists chip a past date, the Inbox lists them as tidy-ups (never counted), disagreements show each side's source. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp, TEST_PASSWORD } from '../testing/helpers.js';
import { inboxCount, inboxModel } from './inboxModel.js';
import type { Memory } from '../memory/types.js';

const owner = { type: 'owner' } as const;
const ai = { type: 'ai', name: 'Claude Code' } as const;
const DAY = 86_400_000;
const cursor = { type: 'ai', name: 'Cursor' } as const;
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-11-18T09:00:00Z') });
  t.after(() => app.close());
  const f = await loggedIn(app);
  const save = async (content: string, meta: object = {}, by: typeof owner | typeof ai | typeof cursor = owner, project = 'wildlog') => {
    const r = await app.deps.service.remember({ kind: 'decision', content, project, newProject: true, allowDuplicate: true, meta } as never, by) as { memory: Memory };
    return r.memory;
  };
  return { app, f, save };
}

test('the fact page shows the date and the source, and a fact without them shows neither line', async (t) => {
  const { f, save } = await start(t);
  const m = await save('The permit expires in December', { validUntil: '2026-12-31', source: 'owner_said', sourceNote: 'said on the phone' });
  const body = await (await f(`/memories/${m.id}`)).text();
  assert.match(body, /<p class="fact-keys fact-valid">Valid until <time datetime="2026-12-31">2026-12-31<\/time><\/p>/);
  assert.match(body, /<p class="fact-keys fact-source">Source: You said this · “said on the phone”<\/p>/);
  const plain = await save('The garden is south facing');
  const other = await (await f(`/memories/${plain.id}`)).text();
  assert.doesNotMatch(other, /fact-valid|fact-source/);
});

test('a past date reads "Past its date since" on the fact page and chips the facts list and search', async (t) => {
  const { f, save } = await start(t);
  const m = await save('Staging runs version 4', { validUntil: '2026-11-01' });
  const body = await (await f(`/memories/${m.id}`)).text();
  assert.match(body, /<p class="fact-keys fact-valid past">Past its date since <time datetime="2026-11-01">2026-11-01<\/time>/);
  assert.match(await (await f('/facts?project=wildlog')).text(), /<span class="chip soon">past its date<\/span>/);
  assert.match(await (await f('/facts')).text(), /past its date/);
  assert.match(await (await f('/search?q=Staging')).text(), /<span class="chip soon">past its date<\/span>/);
  const future = await save('Permit through next year', { validUntil: '2027-01-01' });
  assert.doesNotMatch(await (await f(`/memories/${future.id}`)).text(), /fact-valid past/);
});

test('the owner sets, changes and clears the date and the source from the fact page; the edit is in History', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The licence renews yearly');
  const edit = await (await f(`/memories/${m.id}`)).text();
  assert.match(edit, /<input type="date" name="valid_until" value="">/);
  assert.match(edit, /<select name="source"><option value="">Not recorded<\/option>/);
  assert.match(edit, /<input type="text" name="source_note" value="" maxlength="200">/);
  const fields = (extra: Record<string, string>) => ({ content: m.content, project: 'wildlog', tags: '', base: app.deps.store.get(m.id)!.updatedAt, ...extra });
  let r = await f(`/memories/${m.id}`, form(fields({ valid_until: '2027-02-01', source: 'owner_said', source_note: 'my email' })));
  assert.equal(r.status, 303);
  let now = app.deps.store.get(m.id)!;
  assert.deepEqual([now.validUntil, now.source, now.sourceNote], ['2027-02-01', 'owner_said', 'my email']);
  assert.equal(now.updatedAt, m.updatedAt, 'only labels changed: the text keeps its date');
  const page = await (await f(`/memories/${m.id}`)).text();
  assert.match(page, /<input type="date" name="valid_until" value="2027-02-01">/);
  assert.match(page, /<option value="owner_said" selected>You said this<\/option>/);
  r = await f(`/memories/${m.id}`, form(fields({ valid_until: '', source: 'inferred', source_note: 'my email' })));
  now = app.deps.store.get(m.id)!;
  assert.deepEqual([now.validUntil, now.source, now.sourceNote], [null, 'inferred', 'my email']);
  r = await f(`/memories/${m.id}`, form(fields({ valid_until: '', source: '', source_note: 'left over' })));
  assert.equal(r.status, 303);
  now = app.deps.store.get(m.id)!;
  assert.deepEqual([now.validUntil, now.source, now.sourceNote], [null, null, null], 'taking the source away takes its note with it');
  assert.equal(app.deps.store.history(m.id).length, 3);
  assert.match(await (await f(`/memories/${m.id}`)).text(), /valid until 2027-02-01 · source: You said this/, 'History says what each version carries');
});

test('a bad date from the form comes back as a message with the editor open, nothing saved', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The licence renews yearly');
  const r = await f(`/memories/${m.id}`, form({ content: m.content, project: 'wildlog', tags: '', valid_until: '2026-02-30' }));
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.match(body, /Valid until: pick a real date\./);
  assert.match(body, /<details class="pfold" id="edit" open>/);
  assert.equal(app.deps.store.get(m.id)!.validUntil, null);
});

test('Undo to this brings back the older version\'s date and source', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('Release is 2.1', { validUntil: '2026-12-01', source: 'owner_said' });
  await app.deps.service.update(m.id, { content: 'Release is 2.2', meta: { validUntil: '2027-03-01', source: 'inferred' } }, owner);
  const entry = app.deps.store.history(m.id)[0]!;
  const r = await f(`/history/${entry.id}/undo`, form({}));
  assert.equal(r.status, 303);
  const back = app.deps.store.get(m.id)!;
  assert.deepEqual([back.content, back.validUntil, back.source], ['Release is 2.1', '2026-12-01', 'owner_said']);
});

test('disagreements show each side\'s source, and say so when you said one and an assistant inferred the other', async (t) => {
  const { app, f, save } = await start(t);
  const a = await save('The server listens on port 3000', { source: 'owner_said', sourceNote: 'told Claude' }, owner, 'homelab');
  const b = await save('The server listens on port 3100', { source: 'inferred' }, ai, 'homelab');
  const d = app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai).disagreement;
  for (const path of ['/disagreements', '/?project=homelab']) {
    const body = await (await f(path)).text();
    assert.match(body, /port 3000[\s\S]*You said this · “told Claude”[\s\S]*port 3100[\s\S]*Inferred by Claude Code/, path);
    assert.match(body, /You said this on one side, inferred by Claude Code on the other\./, path);
  }
  // Only the display changed: settling still replaces the other fact.
  const r = await f(`/disagreements/${d.id}/settle`, form({ how: 'b' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.service.replacement(a.id)?.endId, b.id);
});

test('two inferred facts, or facts with no source, get no "you said" line', async (t) => {
  const { app, f, save } = await start(t);
  const a = await save('The server listens on port 3000', { source: 'inferred' }, ai, 'homelab');
  const b = await save('The server listens on port 3100', {}, ai, 'homelab');
  app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai);
  const body = await (await f('/disagreements')).text();
  assert.match(body, /Inferred by Claude Code/);
  assert.doesNotMatch(body, /on one side/);
});

test('an assistant\'s "owner said" is never shown as the owner\'s own word, on the fact page or in a disagreement', async (t) => {
  const { app, f, save } = await start(t);
  const a = await save('The server listens on port 3000', { source: 'owner_said', sourceNote: 'port 3000 it is' }, ai, 'homelab');
  const b = await save('The server listens on port 3100', { source: 'inferred' }, ai, 'homelab');
  const mine = await save('The backup runs at night', { source: 'owner_said' }, owner, 'homelab');
  app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai);
  const body = await (await f('/disagreements')).text();
  assert.match(body, /Claude Code says you said this on one side, inferred by Claude Code on the other\./);
  assert.doesNotMatch(body, /You said this/);
  const page = await (await f(`/memories/${a.id}`)).text();
  assert.match(page, /Source: Claude Code says you said: “port 3000 it is”/);
  assert.doesNotMatch(page, /Source: You said this/);
  assert.match(await (await f(`/memories/${mine.id}`)).text(), /Source: You said this/);
});

test('settling a disagreement picks the side the owner chose whatever the sources say', async (t) => {
  const { app, f, save } = await start(t);
  const a = await save('The server listens on port 3000', { source: 'owner_said' }, owner, 'homelab');
  const b = await save('The server listens on port 3100', { source: 'inferred' }, ai, 'homelab');
  const d = app.deps.service.flagDisagreement(a.id, b.id, 'Two different ports', ai).disagreement;
  // "This one is right" on the owner_said side keeps it and replaces the inferred one, and the reverse is the mirror.
  const r = await f(`/disagreements/${d.id}/settle`, form({ how: 'a' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.service.replacement(b.id)?.endId, a.id);
  assert.ok(!app.deps.service.replacement(a.id));
});

test('past-date facts are tidy-ups in the Inbox: listed, grouped per project, never counted in the badge', async (t) => {
  const { app, f, save } = await start(t);
  await save('Staging runs version 4', { validUntil: '2026-11-01' });
  const a = await save('Anna covers the desk', { validUntil: '2026-11-10' }, owner, 'office');
  await save('Ben covers the phones', { validUntil: '2026-11-12' }, owner, 'office');
  await save('Still fine', { validUntil: '2026-12-31' });
  const model = inboxModel(app.deps);
  const rows = model.items.filter((i) => i.kind === 'tidy');
  assert.deepEqual(rows.map((r) => r.title), ['Past its date: Staging runs version 4', '2 facts are past their date in office']);
  assert.equal(model.total, 0, 'the header counts what needs the owner');
  assert.equal(model.tidyCount, 2);
  assert.equal(inboxCount(app.deps), 0, 'the badge never counts tidy-ups');
  const list = await (await f('/approvals')).text();
  assert.match(list, /Tidy-ups · 2 · when you have time/);
  assert.match(list, /2 facts are past their date in office/);
  const item = await (await f(`/facts/tidy?item=${encodeURIComponent(rows[1]!.id)}`)).text();
  assert.match(item, /Past its date/);
  assert.match(item, /Anna covers the desk/);
  assert.match(item, />Still true \(clear the date\)</);
  assert.match(item, />Set a new date</);
  assert.match(item, />Replace…</);
  assert.ok(item.includes(`/memories/${a.id}`));
  assert.doesNotMatch(item, /Still fine/);
});

test('"Still true" clears the date and "Set a new date" moves it; the row leaves the tidy-ups when the date is ahead', async (t) => {
  const { app, f, save } = await start(t);
  const a = await save('Staging runs version 4', { validUntil: '2026-11-01' });
  const b = await save('The permit is valid', { validUntil: '2026-11-02' });
  assert.equal(inboxModel(app.deps).tidyCount, 1);
  let r = await f(`/memories/${a.id}/valid-until`, form({ valid_until: '', back: 'inbox' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.store.get(a.id)!.validUntil, null);
  assert.equal(inboxModel(app.deps).tidyCount, 1);
  r = await f(`/memories/${b.id}/valid-until`, form({ valid_until: '2027-06-30', back: 'inbox' }));
  assert.equal(r.status, 303);
  assert.equal(app.deps.store.get(b.id)!.validUntil, '2027-06-30');
  assert.equal(inboxModel(app.deps).tidyCount, 0);
  const bad = await f(`/memories/${b.id}/valid-until`, form({ valid_until: 'soon' }));
  assert.equal(bad.status, 400);
  assert.equal((await f(`/memories/nope/valid-until`, form({ valid_until: '' }))).status, 404);
});

test('a fact becomes a tidy-up when the calendar passes its date', async (t) => {
  const { app, save } = await start(t);
  await save('The permit expires', { validUntil: '2026-11-20' });
  assert.equal(inboxModel(app.deps).tidyCount, 0);
  app.advance(3 * DAY);
  assert.equal(inboxModel(app.deps).tidyCount, 1);
});

test('the valid-until route needs the owner', async (t) => {
  const { app, save } = await start(t);
  const m = await save('The permit expires', { validUntil: '2026-11-01' });
  const body = new URLSearchParams({ valid_until: '' });
  // From our own page's origin but with no session: the owner guard turns it away, not the origin check.
  const anon = await fetch(`${app.baseUrl}/memories/${m.id}/valid-until`, { method: 'POST', body, redirect: 'manual', headers: { Origin: app.baseUrl } });
  assert.notEqual(anon.status, 403, 'the origin check let it through; the owner guard is what stops it');
  assert.notEqual(anon.status, 303);
  assert.match(anon.headers.get('location') ?? '', /login/);
  assert.equal(app.deps.store.get(m.id)!.validUntil, '2026-11-01');
  // A signed-in session from another origin is turned away by the origin check.
  const login = await fetch(app.baseUrl + '/login', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'signed in');
  const cross = await fetch(`${app.baseUrl}/memories/${m.id}/valid-until`, { method: 'POST', body, redirect: 'manual', headers: { Origin: 'https://evil.example', Cookie: cookie } });
  assert.equal(cross.status, 403);
  assert.equal(app.deps.store.get(m.id)!.validUntil, '2026-11-01');
});

test('an approval card shows the date and the source a held save carries, and what it clears', async (t) => {
  const { app, f } = await start(t);
  const svc = app.deps.service;
  // A new profile fact held with a date, a source and a note.
  await svc.remember({ kind: 'profile', content: 'Works at Acme until spring', meta: { validUntil: '2027-04-01', source: 'inferred', sourceNote: 'from a chat' } } as never, ai);
  let card = await (await f('/approvals')).text();
  assert.match(card, /<p class="sg-meta">Valid until 2027-04-01<\/p>/);
  assert.match(card, /<p class="sg-meta">Source: Inferred by Claude Code · “from a chat”<\/p>/);
  assert.doesNotMatch(card, /Changes only/);
  const id = svc.pendingSuggestions()[0]!.id;
  const fact = (await svc.approveSuggestion(id))!;
  assert.equal(fact.sourceBy, 'Claude Code');
  // Held update: date and source change, text the same -> current -> proposed, and "Changes only".
  await svc.update(fact.id, { meta: { validUntil: '2027-09-01', source: 'owner_said', sourceNote: 'my words' } }, ai);
  card = await (await f('/approvals')).text();
  assert.match(card, /Valid until: 2027-04-01 → 2027-09-01/);
  assert.match(card, /Source: Inferred by Claude Code → Claude Code says you said: “my words”/);
  assert.match(card, /Changes only the date and the source; the text stays as it is\./);
  // Held update that clears both.
  await svc.update(fact.id, { meta: { validUntil: '', source: null } }, ai);
  card = await (await f('/approvals')).text();
  assert.match(card, /Clears the date \(now 2027-04-01\)\./);
  assert.match(card, /Clears the source \(now “Inferred by Claude Code”\)\./);
  assert.match(card, /Changes only the date and the source/);
  // A held rewrite with a new date shows the text as changed: no "Changes only".
  await svc.update(fact.id, { content: 'Works at Acme until summer', meta: { validUntil: '2027-07-01' } }, ai);
  card = await (await f('/approvals')).text();
  assert.match(card, /Valid until: 2027-04-01 → 2027-07-01/);
  assert.doesNotMatch(card, /Changes only/);
});

test('an owner edit saves only the fields the owner changed: an assistant\'s change to another field is not put back', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The licence renews yearly', { validUntil: '2027-01-01', source: 'inferred', sourceNote: 'rota' }, ai);
  const page = await (await f(`/memories/${m.id}`)).text();
  assert.match(page, /<input type="hidden" name="orig_valid_until" value="2027-01-01"><input type="hidden" name="orig_source" value="inferred"><input type="hidden" name="orig_source_note" value="rota">/);
  // While the form is open, an assistant moves the date.
  await app.deps.service.update(m.id, { meta: { validUntil: '2027-03-01' } }, ai);
  // The owner changes only the source note; the form still carries the old date.
  const fields = { content: m.content, project: 'wildlog', tags: '', base: m.updatedAt, valid_until: '2027-01-01', source: 'keep', source_note: 'from the rota',
    orig_valid_until: '2027-01-01', orig_source: 'inferred', orig_source_note: 'rota' };
  const r = await f(`/memories/${m.id}`, form(fields));
  assert.equal(r.status, 303);
  const now = app.deps.store.get(m.id)!;
  assert.deepEqual([now.validUntil, now.source, now.sourceNote, now.sourceBy], ['2027-03-01', 'inferred', 'from the rota', 'Claude Code'], 'the date change survived; the source stays the assistant\'s');
});

test('an owner change to a field that changed underneath is not saved: the page says it changed', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The licence renews yearly', { validUntil: '2027-01-01' }, ai);
  await app.deps.service.update(m.id, { meta: { validUntil: '2027-03-01', source: 'inferred' } }, ai);
  const r = await f(`/memories/${m.id}`, form({ content: m.content, project: 'wildlog', tags: '', base: m.updatedAt, valid_until: '2027-06-01', source: '', source_note: '',
    orig_valid_until: '2027-01-01', orig_source: '', orig_source_note: '' }));
  assert.equal(r.status, 409);
  const body = await r.text();
  assert.match(body, /The date of this fact changed since you opened it/);
  assert.match(body, /valid until 2027-03-01, source inferred set by Claude Code/);
  assert.match(body, /<input type="hidden" name="orig_valid_until" value="2027-03-01">/, 'a second save is compared with what it is now');
  assert.match(body, /name="valid_until" value="2027-06-01"/, 'the owner\'s draft is kept');
  const now = app.deps.store.get(m.id)!;
  assert.deepEqual([now.validUntil, now.source], ['2027-03-01', 'inferred']);
});


test('the edit form shows an assistant-set source by its own label; saving only the text keeps who set it, and picking "You said this" makes it the owner\'s', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The boat is moored at pier 4', { source: 'owner_said', sourceNote: 'said in chat' }, cursor);
  assert.equal(m.sourceBy, 'Cursor');
  const page = await (await f(`/memories/${m.id}`)).text();
  assert.match(page, /<option value="keep" selected>Cursor says you said this<\/option>/);
  assert.match(page, /<option value="owner_said">You said this<\/option>/);
  const fields = (over: Record<string, string>) => form({ kind: 'decision', content: m.content, project: 'wildlog', tags: '', keys: '', base: m.updatedAt, valid_until: '', source: 'keep', source_note: 'said in chat', orig_valid_until: '', orig_source: 'owner_said', orig_source_note: 'said in chat', ...over });
  // Only the text changed: the source and who set it stay.
  const r1 = await f(`/memories/${m.id}`, { ...fields({ content: 'The boat is moored at pier 5' }), redirect: 'manual' });
  assert.equal(r1.status, 303);
  const after = app.deps.store.get(m.id)!;
  assert.equal(after.content, 'The boat is moored at pier 5');
  assert.equal(after.source, 'owner_said');
  assert.equal(after.sourceBy, 'Cursor');
  // Saved untouched: nothing changes either.
  const same = await f(`/memories/${m.id}`, { ...fields({ content: after.content, base: after.updatedAt }), redirect: 'manual' });
  assert.equal(same.status, 303);
  assert.equal(app.deps.store.get(m.id)!.sourceBy, 'Cursor');
  // The owner explicitly picks "You said this": it becomes the owner's.
  const now = app.deps.store.get(m.id)!;
  const r2 = await f(`/memories/${m.id}`, { ...fields({ content: now.content, base: now.updatedAt, source: 'owner_said' }), redirect: 'manual' });
  assert.equal(r2.status, 303);
  const mine = app.deps.store.get(m.id)!;
  assert.equal(mine.source, 'owner_said');
  assert.equal(mine.sourceBy, 'owner');
  assert.match(await (await f(`/memories/${m.id}`)).text(), /Source: You said this/);
});

test('an owner edit of only the date shows the owner as the last editor on the fact page, like History', async (t) => {
  const { app, f, save } = await start(t);
  const m = await save('The permit renews yearly', { validUntil: '2026-12-01' }, cursor);
  const r = await f(`/memories/${m.id}`, { ...form({ kind: 'decision', content: m.content, project: 'wildlog', tags: '', keys: '', base: m.updatedAt, valid_until: '2027-01-15', source: '', source_note: '', orig_valid_until: '2026-12-01', orig_source: '', orig_source_note: '' }), redirect: 'manual' });
  assert.equal(r.status, 303);
  const hist = app.deps.store.history(m.id);
  assert.equal(hist[0].changedBy, 'owner');
  const body = await (await f(`/memories/${m.id}`)).text();
  assert.match(body, /edited by[^<]*<[^>]*>[^<]*You|edited by You/);
  assert.doesNotMatch(body, /edited by Cursor/);
});

test('the New fact form takes Valid until and Source, set by the owner, and refuses a bad date', async (t) => {
  const { app, f } = await start(t);
  const page = await (await f('/memories/new')).text();
  assert.match(page, /name="valid_until"/);
  assert.match(page, /name="source"/);
  assert.match(page, /name="source_note"/);
  const r = await f('/memories', { ...form({ kind: 'decision', content: 'Dock fees are due in spring', project: '', tags: '', valid_until: '2027-04-01', source: 'owner_said', source_note: 'harbour letter' }), redirect: 'manual' });
  assert.equal(r.status, 303);
  const id = r.headers.get('location')!.split('/').pop()!;
  const saved = app.deps.store.get(id)!;
  assert.equal(saved.validUntil, '2027-04-01');
  assert.equal(saved.source, 'owner_said');
  assert.equal(saved.sourceBy, 'owner');
  assert.equal(saved.sourceNote, 'harbour letter');
  const bad = await f('/memories', form({ kind: 'decision', content: 'Another dock fact', project: '', tags: '', valid_until: 'soon', source: '', source_note: '' }));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Valid until: pick a real date\./);
  // Left empty, nothing is recorded.
  const plain = await f('/memories', { ...form({ kind: 'decision', content: 'A plain dock fact', project: '', tags: '', valid_until: '', source: '', source_note: '' }), redirect: 'manual' });
  const p = app.deps.store.get(plain.headers.get('location')!.split('/').pop()!)!;
  assert.equal(p.validUntil, null);
  assert.equal(p.source, null);
});

test('the sidebar lights Facts on a fact page, also for a fact that has a project', async (t) => {
  const { f, save } = await start(t);
  const m = await save('The mooring chain is new');
  const body = await (await f(`/memories/${m.id}`)).text();
  const side = body.slice(body.indexOf('<nav class="side"'), body.indexOf('</nav>', body.indexOf('<nav class="side"')));
  assert.match(side, /<a class="side-place" href="\/facts" aria-current="page">Facts/);
  assert.doesNotMatch(side, /href="\/" aria-current/);
});

test('an assistant-set owner_said with its note shows the owner\'s words, escaped; owner-set ones are unchanged', async () => {
  const { sourceLine, heldMetaLines } = await import('./factMetaViews.js');
  assert.equal(sourceLine({ source: 'owner_said', sourceBy: 'Claude Code', sourceNote: 'B2 it is <b>' }).value, '<p class="fact-keys fact-source">Source: Claude Code says you said: “B2 it is &lt;b&gt;”</p>');
  assert.equal(sourceLine({ source: 'owner_said', sourceBy: 'owner', sourceNote: 'hi' }).value, '<p class="fact-keys fact-source">Source: You said this · “hi”</p>');
  assert.match(heldMetaLines({ action: 'add', source: 'owner_said', sourceBy: 'Codex', sourceNote: 'go with B2', suggestedBy: 'Codex' }, undefined, false, { validUntil: null, source: 'owner_said', sourceNote: 'go with B2', sourceBy: 'Codex' }).value, /Source: Codex says you said: “go with B2”/);
});
