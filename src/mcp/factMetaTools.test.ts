import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../projects/store.js';
import { NoteService } from '../pages/notes.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import { buildMcpServer } from './server.js';
import { BRIEF_BUDGET } from './budget.js';

const NOW = new Date('2026-11-18T10:00:00Z');

function setup() {
  const given = makeService({ now: () => NOW });
  const { service, db } = given;
  const growth = makeGrowth(given);
  const pages = makePages(given, () => NOW);
  const notes = new NoteService(db, pages, () => NOW);
  const connect = async (name = 'Claude Code') => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, name, { registry: new ProjectStore(db, () => NOW), growth, pages, notes, access: 'full' } as never).connect(st);
    const client = new Client({ name: 't', version: '0' }); await client.connect(ct);
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name: tool, arguments: args });
      return { text: (r.content.find((b: any) => !String(b.text).startsWith('BrainAI operating rules')) ?? r.content[0]).text as string, isError: !!r.isError };
    };
    return { client, call };
  };
  return { service, connect, db };
}
const dataOf = (text: string) => JSON.parse(text.slice(text.indexOf('<memories>\n') + 11, text.lastIndexOf('\n</memories>')));

test('remember and update_memory describe valid_until, source and source_note precisely', async () => {
  const { connect } = setup();
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  for (const name of ['remember', 'update_memory']) {
    const props = (tools.find((t) => t.name === name)!.inputSchema as any).properties;
    assert.match(props.valid_until.description, /YYYY-MM-DD.*real calendar date/);
    assert.match(props.valid_until.description, /past date is accepted/);
    assert.match(props.source.description, /"owner_said" only for what the owner actually said.*"inferred" for your own conclusion/);
    assert.match(props.source_note.description, /at most 200 characters/);
  }
  assert.match((tools.find((t) => t.name === 'update_memory')!.inputSchema as any).properties.valid_until.description, /empty string clears it/);
});

test('remember with a date and source returns them; recall returns them only on facts that have them', async () => {
  const { connect } = setup();
  const { call } = await connect();
  const saved = await call('remember', { kind: 'decision', project: 'casa', new_project: true, content: 'The boiler service contract renews in March', valid_until: '2027-03-15', source: 'owner_said', source_note: 'said in chat' });
  assert.match(saved.text, /^Saved\./);
  assert.doesNotMatch(saved.text, /already past/);
  const row = dataOf(saved.text)[0];
  assert.equal(row.valid_until, '2027-03-15');
  assert.equal(row.source, 'owner_said');
  assert.equal(row.source_note, 'said in chat');
  assert.ok(!('past_date' in row));
  await call('remember', { kind: 'decision', project: 'casa', content: 'The garden shed is painted blue', allow_duplicate: true });
  const rows = dataOf((await call('recall', { query: 'boiler contract or shed', project: 'casa' })).text);
  const boiler = rows.find((r: any) => /boiler/.test(r.content));
  const shed = rows.find((r: any) => /shed/.test(r.content));
  assert.deepEqual([boiler.valid_until, boiler.source, boiler.source_note], ['2027-03-15', 'owner_said', 'said in chat']);
  for (const k of ['valid_until', 'past_date', 'source', 'source_note']) assert.ok(!(k in shed), `${k} is left out of a fact that has none`);
});

test('a past date is accepted, the reply says so, and recall and project_brief mark past_date without hiding or re-ranking', async () => {
  const { connect } = setup();
  const { call } = await connect();
  const r = await call('remember', { kind: 'decision', project: 'casa', new_project: true, content: 'Staging runs version 4 of the app', valid_until: '2026-11-01' });
  assert.match(r.text, /^Saved\. Note: valid_until 2026-11-01 is already past/);
  assert.equal(dataOf(r.text)[0].past_date, true);
  const hit = dataOf((await call('recall', { query: 'staging version 4', project: 'casa' })).text)[0];
  assert.deepEqual([hit.valid_until, hit.past_date], ['2026-11-01', true]);
  const brief = dataOf((await call('project_brief', { project: 'casa' })).text);
  const full = [...brief.statuses, ...brief.decisions].find((m: any) => /Staging/.test(m.content));
  assert.deepEqual([full.valid_until, full.past_date], ['2026-11-01', true]);
  // Today itself is not past.
  const today = await call('remember', { kind: 'decision', project: 'casa', content: 'Permit is valid through today', valid_until: '2026-11-18' });
  assert.doesNotMatch(today.text, /already past/);
});

test('bad values come back as errors and save nothing', async () => {
  const { connect, service } = setup();
  const { call } = await connect();
  const base = { kind: 'decision', project: 'casa', new_project: true, content: 'Some fact worth keeping' };
  for (const [bad, pattern] of [
    [{ valid_until: '2026-02-30' }, /valid_until must be a real date/],
    [{ valid_until: 'next week' }, /valid_until must be a real date/],
    [{ source: 'guessed' }, /source must be one of/],
    [{ source: 'inferred', source_note: 'a\nb' }, /no line breaks/],
    [{ source: 'inferred', source_note: 'x'.repeat(201) }, /limit is 200/],
    [{ source_note: 'a quote' }, /needs a source/],
  ] as const) {
    const r = await call('remember', { ...base, ...bad });
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(r.text, pattern);
  }
  assert.equal(service.listProjects().length, 0, 'nothing was saved');
});

test('update_memory sets, changes and clears: an empty string clears the date and the note, null or "" the source', async () => {
  const { connect } = setup();
  const { call } = await connect();
  const id = dataOf((await call('remember', { kind: 'decision', project: 'casa', new_project: true, content: 'Anna covers the front desk', valid_until: '2026-12-24', source: 'inferred', source_note: 'from the rota' })).text)[0].id;
  const changed = dataOf((await call('update_memory', { id, valid_until: '2027-01-10' })).text)[0];
  assert.deepEqual([changed.valid_until, changed.source, changed.source_note], ['2027-01-10', 'inferred', 'from the rota']);
  const cleared = dataOf((await call('update_memory', { id, valid_until: '', source_note: '' })).text)[0];
  assert.ok(!('valid_until' in cleared) && !('source_note' in cleared));
  assert.equal(cleared.source, 'inferred');
  const none = dataOf((await call('update_memory', { id, source: null })).text)[0];
  assert.ok(!('source' in none));
  const again = dataOf((await call('update_memory', { id, source: 'owner_said', source_note: 'owner words' })).text)[0];
  assert.equal(again.source, 'owner_said');
  const cleared2 = dataOf((await call('update_memory', { id, source: '' })).text)[0];
  assert.ok(!('source' in cleared2));
  const nothing = await call('update_memory', { id });
  assert.equal(nothing.isError, true);
  assert.match(nothing.text, /Give content, keys or both \(or valid_until, source or source_note\)/);
  const past = await call('update_memory', { id, valid_until: '2026-01-01' });
  assert.match(past.text, /already past/);
});

test('in a brief, excerpt rows keep valid_until and past_date and source but not the note, and the brief stays within its budget', async () => {
  const { connect, service } = setup();
  const { call } = await connect();
  await call('remember', { kind: 'decision', project: 'big', new_project: true, content: 'FIRST ' + 'x'.repeat(900), valid_until: '2026-01-01', source: 'inferred', source_note: 'NOTE-IN-FULL-ROW' });
  for (let i = 0; i < 40; i++) {
    await service.remember({ kind: 'decision', project: 'big', content: `DECISION${i} ` + 'y'.repeat(900), allowDuplicate: true, meta: { validUntil: i % 2 === 0 ? '2026-01-01' : '2026-12-31', source: 'owner_said', sourceNote: 'a short quote that is kept in full rows only' } } as never, { type: 'owner' });
  }
  const text = (await call('project_brief', { project: 'big' })).text;
  assert.ok(text.length <= BRIEF_BUDGET, `${text.length}`);
  const d = dataOf(text);
  const cut = d.decisions.filter((m: any) => m.excerpt);
  assert.ok(cut.length > 0, 'some decisions are excerpts');
  for (const m of cut) {
    assert.equal(m.source, 'owner_said');
    assert.ok(!('source_note' in m), 'the note is not in an excerpt row');
    assert.ok(m.valid_until === '2026-12-31' || m.valid_until === '2026-01-01');
    // past_date follows the date on an excerpt row, too.
    assert.equal(m.past_date, m.valid_until === '2026-01-01' ? true : undefined, `${m.valid_until}`);
  }
  const pastExcerpt = cut.filter((m: any) => m.valid_until === '2026-01-01');
  assert.ok(pastExcerpt.length > 0, 'an excerpt row is past its date');
  assert.ok(pastExcerpt.every((m: any) => m.past_date === true && m.source_by === 'owner'));
  const first = d.decisions.find((m: any) => m.content.startsWith('FIRST'));
  if (first) assert.equal(first.past_date, true);
  const fullRow = d.decisions.find((m: any) => !m.excerpt);
  assert.equal(fullRow.source_note, 'a short quote that is kept in full rows only');
});

test('an assistant\'s profile save with a date is held and keeps it', async () => {
  const { connect, service } = setup();
  const { call } = await connect();
  const r = await call('remember', { kind: 'profile', content: 'Works at Acme until spring', valid_until: '2027-04-01', source: 'inferred', source_note: 'from a chat' });
  assert.match(r.text, /approval/);
  const pending = service.pendingSuggestions();
  assert.equal(pending.length, 1);
  assert.deepEqual([pending[0]!.validUntil, pending[0]!.source, pending[0]!.sourceNote, pending[0]!.sourceBy], ['2027-04-01', 'inferred', 'from a chat', 'Claude Code']);
  // Nothing is saved until the owner approves; then the fact has all of it.
  const saved = await service.approveSuggestion(pending[0]!.id);
  assert.deepEqual([saved!.validUntil, saved!.source, saved!.sourceNote, saved!.sourceBy], ['2027-04-01', 'inferred', 'from a chat', 'Claude Code']);
});

test('results carry source_by, and a source an assistant gives is recorded as set by its app', async () => {
  const { connect } = setup();
  const { call } = await connect('Codex');
  const saved = await call('remember', { kind: 'decision', project: 'casa', new_project: true, content: 'The boiler is serviced yearly', source: 'owner_said', source_note: 'yearly, he said' });
  const row = dataOf(saved.text)[0];
  assert.deepEqual([row.source, row.source_by], ['owner_said', 'Codex']);
  const rewritten = dataOf((await call('update_memory', { id: row.id, content: 'The boiler is serviced every two years' })).text)[0];
  // An assistant's own owner_said rewritten without a fresh quote is no longer "you said this": inferred by that assistant.
  assert.deepEqual([rewritten.source, rewritten.source_by], ['inferred', 'Codex']);
});

test('recall without a limit counts the source note toward its size budget', async () => {
  const { connect, service } = setup();
  const { call } = await connect();
  const body = 'gardens '.repeat(62).trim(); // 495 characters: 12 of them fit the 8000 budget, 12 with a 200-character note do not
  for (let i = 0; i < 14; i++) {
    await service.remember({ kind: 'decision', project: 'noted', newProject: true, allowDuplicate: true, content: `Fact ${String.fromCharCode(97 + i)} ${body}`, meta: { source: 'inferred', sourceNote: 'n'.repeat(200) } } as never, { type: 'owner' });
  }
  const rows = dataOf((await call('recall', { query: `Fact ${body}`, project: 'noted' })).text);
  const size = (rows as any[]).reduce((n, r) => n + r.content.length + (r.source_note?.length ?? 0), 0);
  assert.ok(rows.length >= 5 && rows.length < 12, `${rows.length} rows`);
  assert.ok(size - (rows.at(-1).content.length + (rows.at(-1).source_note?.length ?? 0)) <= 8000, 'the pack stopped at the budget, notes included');
});

test('owner_said without the owner\'s words is stored as inferred and the reply says so; with a note it stays', async () => {
  const { connect, service } = setup();
  const { call } = await connect();
  const r = await call('remember', { kind: 'decision', content: 'Harbor backups go to Backblaze B2', project: 'harbor', new_project: true, source: 'owner_said' });
  assert.match(r.text, /Saved with source inferred: owner_said needs the owner's own words in source_note\. If the owner said this, call update_memory with source "owner_said" and source_note set to their words\./);
  const m = dataOf(r.text)[0];
  assert.equal(m.source, 'inferred');
  const u = await call('update_memory', { id: m.id, source: 'owner_said' });
  assert.match(u.text, /Updated with source inferred: owner_said needs the owner's own words/);
  const ok = await call('update_memory', { id: m.id, source: 'owner_said', source_note: 'B2 it is then' });
  assert.doesNotMatch(ok.text, /source inferred/);
  assert.equal(service.get(m.id)!.source, 'owner_said');
  const held = await call('suggest_memories', { session: 's', items: [{ content: 'Harbor runs on Hetzner', kind: 'decision', project: 'harbor', source: 'owner_said' }] });
  assert.match(held.text, /"source_stored_as":"inferred"/);
});

test('the tool texts say owner_said needs the owner\'s own words in source_note', async () => {
  const { connect } = setup();
  const { client } = await connect();
  const props = (((await client.listTools()).tools.find((t) => t.name === 'remember')!.inputSchema) as any).properties;
  assert.match(props.source.description, /owner's own words in source_note/);
  assert.match(props.source_note.description, /verbatim/);
});
