import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../projects/store.js';
import { NoteService } from '../pages/notes.js';
import { makeGrowth, makePages, makeService } from '../testing/helpers.js';
import { buildMcpServer } from '../mcp/server.js';
import { heldMetaLines, heldView } from '../web/factMetaViews.js';
import { metaOf, resolveAiMeta, NO_META } from './factMeta.js';

/*
 * A held save reports what approving it will store (heldOutcome), never the claim on the row: MCP replies, the harvest
 * answer and the Inbox card all say the same thing approval does.
 */
const NOW = new Date('2026-11-18T10:00:00Z');
const owner = { type: 'owner' } as const;
const ai = { type: 'ai', name: 'Claude Code' } as const;
const codex = { type: 'ai', name: 'Codex' } as const;
const HOLD = { hold: 'saves wait' };

function setup() {
  const given = makeService({ now: () => NOW });
  const { service, db } = given;
  const growth = makeGrowth(given);
  const pages = makePages(given, () => NOW);
  const notes = new NoteService(db, pages, () => NOW);
  const connect = async (name = 'Claude Code') => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(service, name, { registry: new ProjectStore(db, () => NOW), growth, pages, notes, access: 'full' } as never).connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    return async (tool: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name: tool, arguments: args });
      return (r.content.find((b: any) => !String(b.text).startsWith('BrainAI operating rules')) ?? r.content[0]).text as string;
    };
  };
  return { service, store: given.store, connect };
}
const dec = (content: string, meta: object = {}) => ({ kind: 'decision' as const, content, project: 'harbor', newProject: true, meta });
const card = (service: any, s: any) => {
  const cur = service.heldTarget(s);
  return heldMetaLines(s, cur, s.action === 'update' && s.content === cur?.content && !s.keys, service.heldOutcome(s)).value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

test('Q1 held profile remember of owner_said without a note says the source is stored as inferred', async () => {
  const { service, connect } = setup();
  const call = await connect();
  const t = await call('remember', { kind: 'profile', content: 'The owner drinks tea every morning', source: 'owner_said' });
  assert.match(t, /inferred/);
  const s = service.pendingSuggestions()[0]!;
  assert.equal(service.heldOutcome(s).source, 'inferred');
  assert.equal((await service.approveSuggestion(s.id))!.source, 'inferred');
});

test('Q2 held profile update with owner_said and no note says inferred', async () => {
  const { service, connect } = setup();
  const m = (await service.remember({ kind: 'profile', content: 'The owner lives in Valencia' } as never, owner) as any).memory;
  const call = await connect();
  const t = await call('update_memory', { id: m.id, content: 'The owner lives in Porto', source: 'owner_said' });
  assert.match(t, /inferred/);
});

test('Q3 harvested owner_said on mixed text reports source_stored_as inferred, card shows inferred', async () => {
  const { service, connect } = setup();
  const call = await connect();
  const t = await call('suggest_memories', { session: 's', items: [{ content: 'Harbor backups go to B2. I suggest restic nightly.', kind: 'decision', project: 'harbor', source: 'owner_said', source_note: 'backups go to B2' }] });
  assert.match(t, /source_stored_as["']?:? ?"?inferred/);
  const s = service.pendingSuggestions()[0]!;
  assert.equal(service.heldOutcome(s).source, 'inferred');
  assert.match(card(service, s), /Source: Inferred by Claude Code/);
  assert.equal((await service.approveSuggestion(s.id))!.source, 'inferred');
});

test('Q4a owner-set owner_said with a held re-statement: no source line', async () => {
  const { service } = setup();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'mine' }) as never, owner) as any).memory;
  const u = await service.update(m.id, { meta: { source: 'owner_said' } }, ai, HOLD) as any;
  assert.doesNotMatch(card(service, u.suggestion), /Source/);
});

test('Q4b owner-set owner_said with a held re-statement plus a note: the owner quote is not shown changing', async () => {
  const { service } = setup();
  const m = (await service.remember(dec('Harbor runs on Hetzner FSN1', { source: 'owner_said', sourceNote: 'mine' }) as never, owner) as any).memory;
  const u = await service.update(m.id, { meta: { source: 'owner_said', sourceNote: 'Claude words' } }, ai, HOLD) as any;
  const c = card(service, u.suggestion);
  assert.doesNotMatch(c, /Claude words/);
  assert.doesNotMatch(c, /Source/);
  assert.equal((await service.approveSuggestion(u.suggestion.id))!.sourceNote, 'mine');
});

test('Q5 note-only claim on Codex owner_said shows the switch to inferred by Claude Code', async () => {
  const { service } = setup();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'B2 it is' }) as never, codex) as any).memory;
  const u = await service.update(m.id, { meta: { sourceNote: 'Claude heard B2' } }, ai, HOLD) as any;
  assert.match(card(service, u.suggestion), /Source: Codex says you said: “B2 it is” → Inferred by Claude Code · “Claude heard B2”/);
});

test('Q6 held rewrite of its own owner_said with nothing given shows the change to Inferred by Claude Code', async () => {
  const { service } = setup();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'B2 it is' }) as never, ai) as any).memory;
  const u = await service.update(m.id, { content: 'Harbor backups go to Wasabi' }, ai, HOLD) as any;
  const c = card(service, u.suggestion);
  assert.match(c, /Source: .* → Inferred by Claude Code/);
});

test('heldOutcome: an add that lands on an existing roadmap is judged against it, a plain add against nothing', async () => {
  const { service } = setup();
  const plain = await service.remember(dec('Harbor backups go to Backblaze B2. I suggest restic.', { source: 'owner_said', sourceNote: 'backups go to B2' }) as never, ai) as any;
  assert.equal(service.heldOutcome(plain.suggestion).source, 'inferred');
  assert.deepEqual(metaOf(service.heldOutcome(service.pendingSuggestions()[0]!)).source, 'inferred');
  assert.notEqual(NO_META, null);
});

const road = (text: string) => `Now: ${text}`;
const heldRoadmapAdd = (store: any, by: string, content: string, extra: object = {}) =>
  store.addSuggestion({ action: 'add', memoryId: null, content, tags: [], keys: null, kind: 'roadmap', project: 'harbor', reason: 'saves wait', suggestedBy: by, ...extra });

test('R1 a Codex held roadmap add on a Claude-inferred roadmap with no source shows no source line', async () => {
  const given = setup();
  const m = (await given.service.remember({ kind: 'roadmap', content: road('Ship the beta'), project: 'harbor', newProject: true, meta: { source: 'inferred' } } as never, ai) as any).memory;
  assert.equal(m.source, 'inferred');
  const s = heldRoadmapAdd(given.store, 'Codex', road('Ship the beta now'));
  assert.doesNotMatch(card(given.service, s), /Source/);
});

test('R2 a held roadmap add with new text on an owner_said roadmap says the source is cleared', async () => {
  const given = setup();
  await given.service.remember({ kind: 'roadmap', content: road('Ship the beta'), project: 'harbor', newProject: true, meta: { source: 'owner_said', sourceNote: 'mine' } } as never, owner);
  const s = heldRoadmapAdd(given.store, 'Codex', road('Ship the beta now'));
  assert.match(card(given.service, s), /Clears the source/);
});

test('R3 a held row whose note no longer validates: the card helper gets no source line, not a throw', async () => {
  const given = setup();
  await given.service.remember({ kind: 'decision', content: 'Harbor uses B2', project: 'harbor', newProject: true } as never, owner);
  const s = given.store.addSuggestion({ action: 'add', memoryId: null, content: 'Harbor note', tags: [], keys: null, kind: 'decision', project: 'harbor', reason: 'x', suggestedBy: 'Codex', source: 'inferred', sourceNote: 'AKIA' + 'IOSFODNN7EXAMPLE sk-live-abcdefghijklmnopqrstuvwxyz0123456789', sourceBy: 'Codex' });
  assert.throws(() => given.service.heldOutcome(s), /./);
  assert.deepEqual(heldView(given.service, s), { currentMeta: undefined, heldOutcome: undefined });
});

test('C1 note-only by Claude on Codex inferred reads as Claude Code own note', () => {
  const current = { validUntil: null, source: 'inferred' as const, sourceNote: 'Codex reasoning', sourceBy: 'Codex' };
  const r = resolveAiMeta(current, { sourceNote: 'Claude invented this' }, 'Claude Code', false);
  assert.equal(r.meta.source, 'inferred');
  assert.equal(r.meta.sourceBy, 'Claude Code');
  assert.equal(r.meta.sourceNote, 'Claude invented this');
  assert.equal(r.changedSource, true);
  // Same setter: the note changes, the setter stays.
  const same = resolveAiMeta({ ...current, sourceBy: 'Claude Code' }, { sourceNote: 'new' }, 'Claude Code', false);
  assert.equal(same.meta.sourceBy, 'Claude Code');
  // The owner's own source keeps its setter.
  const own = resolveAiMeta({ ...current, sourceBy: 'owner' }, { sourceNote: 'x' }, 'Claude Code', false);
  assert.equal(own.meta.sourceBy, 'owner');
  assert.equal(own.meta.sourceNote, 'Codex reasoning');
});
