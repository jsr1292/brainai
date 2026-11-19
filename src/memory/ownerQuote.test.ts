import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';

const ai = { type: 'ai', name: 'Claude Code' } as const;
const owner = { type: 'owner' } as const;

function make() {
  const db = openDb(':memory:');
  const store = new MemoryStore(db, () => new Date());
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  return { service, store };
}
const dec = (content: string, meta: object) => ({ kind: 'decision' as const, content, project: 'harbor', meta, newProject: true });

test('AI owner_said without a note is stored as inferred', async () => {
  const { service } = make();
  const r = await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said' }), ai);
  assert.equal(r.status, 'saved');
  const m = (r as any).memory;
  assert.equal(m.source, 'inferred');
  assert.equal(m.sourceBy, 'Claude Code');
  const blank = await service.remember(dec('Harbor runs on a Hetzner box', { source: 'owner_said', sourceNote: '   ' }), ai);
  assert.equal((blank as any).memory.source, 'inferred');
});

test('AI owner_said with the owner\'s words keeps owner_said', async () => {
  const { service } = make();
  const r = await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'Good, B2 it is then' }), ai);
  const m = (r as any).memory;
  assert.equal(m.source, 'owner_said');
  assert.equal(m.sourceNote, 'Good, B2 it is then');
});

test('an owner-set owner_said without a note is unchanged', async () => {
  const { service } = make();
  const r = await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said' }), owner);
  assert.equal((r as any).memory.source, 'owner_said');
});

test('update_memory to owner_said without a note stores inferred; with a note keeps it', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', {}), ai) as any).memory;
  const u = await service.update(m.id, { meta: { source: 'owner_said' } }, ai);
  assert.equal((u as any).memory.source, 'inferred');
  const u2 = await service.update(m.id, { meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, ai);
  assert.equal((u2 as any).memory.source, 'owner_said');
  assert.equal((u2 as any).memory.sourceNote, 'B2 it is');
  // An unrelated edit of a note-less owner_said fact set earlier is not downgraded.
  const u3 = await service.update(m.id, { tags: ['backup'] }, ai);
  assert.equal((u3 as any).memory.source, 'owner_said');
});

test('a harvest item marked owner_said without a note is held as inferred', async () => {
  const { service } = make();
  const r = await service.suggestMemories([{ content: 'Harbor backups go to Backblaze B2', kind: 'decision', project: 'harbor', source: 'owner_said' }], 'session', ai, () => 'b1');
  const held = r.results[0] as any;
  assert.equal(held.status, 'held');
  // The row holds the claim; what would be saved is inferred.
  assert.equal(held.suggestion.source, 'owner_said');
  assert.equal(held.storedSource, 'inferred');
  assert.equal((await service.approveSuggestion(held.suggestion.id))!.source, 'inferred');
  const ok = await service.suggestMemories([{ content: 'Harbor runs on Hetzner', kind: 'decision', project: 'harbor', source: 'owner_said', sourceNote: 'on my Hetzner box' }], 'session', ai, () => 'b2');
  assert.equal((ok.results[0] as any).suggestion.source, 'owner_said');
});

test('mixed-looking owner_said content is held with a plain reason; approval stores inferred (the claim cannot stand)', async () => {
  const { service } = make();
  const r = await service.remember(dec('B2 is the target. I suggest restic with 30-day retention.', { source: 'owner_said', sourceNote: 'B2 it is then' }), ai);
  assert.equal(r.status, 'suggested');
  const s = (r as any).suggestion;
  assert.equal(s.reason, "Marked as your words but reads like it includes an assistant's suggestion");
  assert.equal(s.source, 'owner_said');
  const approved = await service.approveSuggestion(s.id);
  // The owner approved the text, but the claim cannot stand: the text carries the assistant's own suggestion.
  assert.equal(approved!.source, 'inferred');
  assert.equal(approved!.sourceNote, null);
  assert.equal(approved!.sourceBy, 'Claude Code');
});

test('the same text as inferred, or from the owner, is not held', async () => {
  const { service } = make();
  const a = await service.remember(dec('I suggest restic with 30-day retention', { source: 'inferred' }), ai);
  assert.equal(a.status, 'saved');
  const b = await service.remember(dec('Backups: we could use borg someday', { source: 'owner_said' }), owner);
  assert.equal(b.status, 'saved');
});

test('update_memory with mixed-looking owner_said content is held', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to B2', {}), ai) as any).memory;
  const u = await service.update(m.id, { content: 'Harbor backups go to B2. Recommendation: restic.', meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, ai);
  assert.equal(u.status, 'suggested');
  assert.match((u as any).suggestion.reason, /assistant's suggestion/);
});

test('reused note: an AI owner_said without a note in this call is inferred (inherited session label)', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'inferred', sourceNote: 'planning session 2026-11-01' }), ai) as any).memory;
  const u = await service.update(m.id, { meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(u.memory.source, 'inferred');
  const blank = await service.update(m.id, { meta: { source: 'owner_said', sourceNote: '  ' } }, ai) as any;
  assert.equal(blank.memory.source, 'inferred');
});

test('reused note: an AI rewrite of the owner\'s fact with source owner_said and no note does not carry the owner\'s quote', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'my words' }), owner) as any).memory;
  const u = await service.update(m.id, { content: 'Harbor backups go to Wasabi in Amsterdam', meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(u.memory.source, 'inferred');
  assert.equal(u.memory.sourceBy, 'Claude Code');
});

test('the same assistant keeps its own owner_said on a keys-only change, but not on new text', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'B2 it is' }), ai) as any).memory;
  const k = await service.update(m.id, { keys: 'backup', meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(k.memory.source, 'owner_said');
  assert.equal(k.memory.sourceNote, 'B2 it is');
  const c = await service.update(m.id, { content: 'Harbor backups go to Wasabi', meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(c.memory.source, 'inferred');
});

test('a held save approved without a note stores inferred', async () => {
  const { service, store } = make();
  const s = store.addSuggestion({ action: 'add', memoryId: null, content: 'Harbor backups go to Backblaze B2', tags: [], keys: '', kind: 'decision', project: 'harbor', reason: 'x', suggestedBy: 'Claude Code', supersedes: [], deletedMatch: null, validUntil: null, source: 'owner_said', sourceNote: null, sourceBy: 'Claude Code' } as any);
  const approved = await service.approveSuggestion(s.id);
  assert.equal(approved!.source, 'inferred');
  const m = (await service.remember(dec('Harbor runs on a Hetzner box', { source: 'inferred', sourceNote: 'session label' }), ai) as any).memory;
  const s2 = store.addSuggestion({ action: 'update', memoryId: m.id, content: 'Harbor runs on a Hetzner box in FSN', tags: [], keys: null, kind: null, project: null, reason: 'x', suggestedBy: 'Claude Code', supersedes: [], deletedMatch: null, validUntil: null, source: 'owner_said', sourceNote: null, sourceBy: 'Claude Code' } as any);
  const a2 = await service.approveSuggestion(s2.id);
  assert.equal(a2!.source, 'inferred');
});

test('stripping the quote: an AI clearing the note of its own owner_said makes it inferred', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'B2 it is' }), ai) as any).memory;
  const u = await service.update(m.id, { meta: { sourceNote: '' } }, ai) as any;
  assert.equal(u.memory.source, 'inferred');
});

test('an assistant cannot change or clear the note of a source the owner set', async () => {
  const { service } = make();
  const m = (await service.remember(dec('Harbor backups go to Backblaze B2', { source: 'owner_said', sourceNote: 'my words' }), owner) as any).memory;
  const a = await service.update(m.id, { meta: { sourceNote: '' } }, ai) as any;
  assert.equal(a.memory.source, 'owner_said');
  assert.equal(a.memory.sourceNote, 'my words');
  assert.equal(a.memory.sourceBy, 'owner');
  const b = await service.update(m.id, { meta: { source: 'owner_said', sourceNote: 'something else' } }, ai) as any;
  assert.equal(b.memory.sourceNote, 'my words');
  assert.equal(b.memory.sourceBy, 'owner');
  const c = await service.update(m.id, { keys: 'x', meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(c.memory.source, 'owner_said');
  assert.equal(c.memory.sourceBy, 'owner');
});

test('suggest_memories: an owner_said item cannot reuse a note either (no note means inferred)', async () => {
  const { service } = make();
  const r = await service.suggestMemories([{ content: 'Harbor runs on Hetzner', kind: 'decision', project: 'harbor', source: 'owner_said', sourceNote: ' ' }], 'session', ai, () => 'b3');
  assert.equal((r.results[0] as any).storedSource, 'inferred');
  assert.equal((await service.approveSuggestion((r.results[0] as any).suggestion.id))!.source, 'inferred');
});

// ---- One invariant for the quote rule (reviewer probes), direct and held+approved ----

const codex = { type: 'ai', name: 'Codex' } as const;
const show = (m: any) => ({ source: m.source, note: m.sourceNote, by: m.sourceBy });
/** The fact after an update: applied directly, or (when it waited) approved. */
async function settle(service: MemoryService, r: any) {
  if (r.status === 'suggested') return show(await service.approveSuggestion(r.suggestion.id));
  assert.equal(r.status, 'updated');
  return show(r.memory);
}
const HOLD = { hold: 'saves wait' };
const OWNER_FACT = { source: 'owner_said', sourceNote: 'B2 please' };
const B2 = 'Harbor backups go to Backblaze B2';
const OWNER_KEPT = { source: 'owner_said', note: 'B2 please', by: 'owner' };

test('probe A: restating owner_said with a keys change on an owner fact never downgrades it (direct and held+approved)', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said' }), owner) as any).memory;
  const direct = await service.update(m.id, { keys: 'backup', meta: { source: 'owner_said' } }, ai) as any;
  assert.deepEqual(show(direct.memory), { source: 'owner_said', note: null, by: 'owner' });
  const m2 = (await service.remember(dec('Harbor runs on Hetzner FSN1', { source: 'owner_said' }), owner) as any).memory;
  const held = await service.update(m2.id, { keys: 'host', meta: { source: 'owner_said' } }, ai, HOLD) as any;
  assert.equal(held.status, 'suggested');
  assert.deepEqual(await settle(service, held), { source: 'owner_said', note: null, by: 'owner' });
});

test('probe B: a profile entry the owner set keeps owner_said when an assistant restates it, with or without a note', async () => {
  const { service } = make();
  const m = (await service.remember({ kind: 'profile', content: 'The owner lives in Valencia', meta: { source: 'owner_said', sourceNote: 'I live in Valencia' } }, owner) as any).memory;
  const u = await service.update(m.id, { keys: 'city', meta: { source: 'owner_said' } }, ai) as any;
  assert.equal(u.status, 'suggested');
  assert.deepEqual(await settle(service, u), { source: 'owner_said', note: 'I live in Valencia', by: 'owner' });
  const m2 = (await service.remember({ kind: 'profile', content: 'The owner prefers tea', meta: { source: 'owner_said' } }, owner) as any).memory;
  const u2 = await service.update(m2.id, { keys: 'drink', meta: { source: 'owner_said', sourceNote: 'made up words' } }, ai) as any;
  assert.deepEqual(await settle(service, u2), { source: 'owner_said', note: null, by: 'owner' });
});

test('probe D: a follow-up profile rewrite with no meta does not keep the earlier call\'s owner_said and quote', async () => {
  const { service } = make();
  const m = (await service.remember({ kind: 'profile', content: 'The owner lives in Valencia' }, owner) as any).memory;
  const u1 = await service.update(m.id, { content: 'The owner lives in Valencia, Spain', meta: { source: 'owner_said', sourceNote: 'Valencia, Spain' } }, ai) as any;
  assert.equal(u1.suggestion.source, 'owner_said');
  const u2 = await service.update(m.id, { content: 'The owner lives in Porto and works remotely' }, ai) as any;
  // The follow-up gave no source: its row holds no claim (the earlier call's claim is not carried to new text).
  assert.equal(u2.suggestion.source, null);
  assert.equal(u2.suggestion.sourceNote, null);
  assert.deepEqual(await settle(service, u2), { source: null, note: null, by: null });
});

test('probe D2: a meta-only follow-up keeps the earlier call\'s fresh quote on its own text', async () => {
  const { service } = make();
  const m = (await service.remember({ kind: 'profile', content: 'The owner lives in Valencia' }, owner) as any).memory;
  await service.update(m.id, { content: 'The owner lives in Valencia, Spain', meta: { source: 'owner_said', sourceNote: 'Valencia, Spain' } }, ai);
  const u2 = await service.update(m.id, { keys: 'city' }, ai) as any;
  assert.deepEqual(await settle(service, u2), { source: 'owner_said', note: 'Valencia, Spain', by: 'Claude Code' });
});

test('probe E: another assistant changing only the note of Codex\'s owner_said makes it inferred by that assistant with its note', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), codex) as any).memory;
  const u = await service.update(m.id, { meta: { sourceNote: 'words Claude invented' } }, ai) as any;
  assert.deepEqual(show(u.memory), { source: 'inferred', note: 'words Claude invented', by: 'Claude Code' });
});

test('another assistant\'s keys-only change leaves Codex\'s owner_said untouched, restating or not', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), codex) as any).memory;
  const a = await service.update(m.id, { keys: 'backup' }, ai) as any;
  assert.deepEqual(show(a.memory), { source: 'owner_said', note: 'B2 it is', by: 'Codex' });
  const held = await service.update(m.id, { keys: 'backup2' }, ai, HOLD) as any;
  assert.deepEqual(await settle(service, held), { source: 'owner_said', note: 'B2 it is', by: 'Codex' });
});

test('probe F: an assistant may still set another source on, or clear the source of, an owner-set fact', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'mine' }), owner) as any).memory;
  const a = await service.update(m.id, { meta: { source: 'inferred' } }, ai) as any;
  assert.equal(a.memory.source, 'inferred');
  const m2 = (await service.remember(dec('Harbor runs on Hetzner FSN1', { source: 'owner_said', sourceNote: 'mine' }), owner) as any).memory;
  const b = await service.update(m2.id, { meta: { source: null } }, ai) as any;
  assert.equal(b.memory.source, null);
  const m3 = (await service.remember(dec('Harbor DNS is at Cloudflare', { source: 'owner_said', sourceNote: 'mine' }), owner) as any).memory;
  const c = await service.update(m3.id, { meta: { source: '' } }, ai) as any;
  assert.equal(c.memory.source, null);
});

test('probe J: changing only the note of the assistant\'s own owner_said still gets the mixed-suggestion check', async () => {
  const { service } = make();
  const r = await service.remember(dec('Harbor: we could use restic nightly for backups', { source: 'owner_said', sourceNote: 'we could use restic nightly' }), ai) as any;
  assert.equal(r.status, 'saved');
  const u = await service.update(r.memory.id, { meta: { sourceNote: 'ok' } }, ai) as any;
  assert.equal(u.status, 'suggested');
  assert.match(u.suggestion.reason, /assistant's suggestion/);
});

test('probe G: an assistant rewriting an owner fact with a fresh quote gets owner_said by the assistant with the new note (direct and held)', async () => {
  const input = { content: 'Harbor backups go to Wasabi in Amsterdam', meta: { source: 'owner_said', sourceNote: 'switch to Wasabi Amsterdam' } };
  const want = { source: 'owner_said', note: 'switch to Wasabi Amsterdam', by: 'Claude Code' };
  for (const opts of [{}, HOLD]) {
    const { service } = make();
    const m = (await service.remember(dec(B2, OWNER_FACT), owner) as any).memory;
    assert.deepEqual(await settle(service, await service.update(m.id, input, ai, opts) as any), want);
  }
});

test('rewriting an owner-set owner_said without a source clears the source (kept behaviour), direct and held', async () => {
  for (const opts of [{}, HOLD]) {
    const { service } = make();
    const m = (await service.remember(dec(B2, OWNER_FACT), owner) as any).memory;
    const r = await service.update(m.id, { content: 'Harbor backups go to Wasabi' }, ai, opts) as any;
    assert.deepEqual(await settle(service, r), { source: null, note: null, by: null });
  }
});

test('the owner sets owner_said while an assistant\'s restating keys change waits: approval keeps the owner\'s', async () => {
  const { service } = make();
  const m = (await service.remember(dec(B2, {}), owner) as any).memory;
  const held = await service.update(m.id, { keys: 'backup', meta: { source: 'owner_said', sourceNote: 'made up' } }, ai, HOLD) as any;
  assert.equal(held.status, 'suggested');
  await service.update(m.id, { meta: { source: 'owner_said', sourceNote: 'B2 please' } }, owner);
  assert.deepEqual(show(await service.approveSuggestion(held.suggestion.id)), OWNER_KEPT);
});

test('the same assistant keeps its own owner_said on a keys-only change (nothing given, or restated)', async () => {
  for (const meta of [undefined, { source: 'owner_said' }]) {
    const { service } = make();
    const m = (await service.remember(dec(B2, { source: 'owner_said', sourceNote: 'B2 it is' }), ai) as any).memory;
    for (const opts of [{}, HOLD]) {
      const r = await service.update(m.id, { keys: `k${opts === HOLD ? 2 : 1}`, ...(meta ? { meta } : {}) }, ai, opts) as any;
      assert.deepEqual(await settle(service, r), { source: 'owner_said', note: 'B2 it is', by: 'Claude Code' });
    }
  }
});

/** Every case run directly and as a held save that is then approved: the facts must come out the same. */
type Case = { name: string; by: typeof ai | typeof codex; setupBy: typeof ai | typeof codex | typeof owner; setup: object; input: any; want: object };
const T: Case[] = [
  { name: 'owner fact, restate owner_said + keys', setupBy: owner, by: ai, setup: OWNER_FACT, input: { keys: 'k', meta: { source: 'owner_said' } }, want: OWNER_KEPT },
  { name: 'owner fact, restate owner_said with other note + keys', setupBy: owner, by: ai, setup: OWNER_FACT, input: { keys: 'k', meta: { source: 'owner_said', sourceNote: 'else' } }, want: OWNER_KEPT },
  { name: 'owner fact, note only', setupBy: owner, by: ai, setup: OWNER_FACT, input: { keys: 'k', meta: { sourceNote: 'else' } }, want: OWNER_KEPT },
  { name: 'owner fact, clear note', setupBy: owner, by: ai, setup: OWNER_FACT, input: { keys: 'k', meta: { sourceNote: '' } }, want: OWNER_KEPT },
  { name: 'owner fact, other source', setupBy: owner, by: ai, setup: OWNER_FACT, input: { meta: { source: 'inferred' } }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'owner fact, clear source', setupBy: owner, by: ai, setup: OWNER_FACT, input: { meta: { source: null } }, want: { source: null, note: null, by: null } },
  { name: 'owner fact, rewrite no meta', setupBy: owner, by: ai, setup: OWNER_FACT, input: { content: 'Harbor backups go to Wasabi' }, want: { source: null, note: null, by: null } },
  { name: 'owner fact, rewrite owner_said no note', setupBy: owner, by: ai, setup: OWNER_FACT, input: { content: 'Harbor backups go to Wasabi', meta: { source: 'owner_said' } }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'owner fact, rewrite + fresh quote', setupBy: owner, by: ai, setup: OWNER_FACT, input: { content: 'Harbor backups go to Wasabi', meta: { source: 'owner_said', sourceNote: 'use Wasabi' } }, want: { source: 'owner_said', note: 'use Wasabi', by: 'Claude Code' } },
  { name: 'owner fact, rewrite + note only', setupBy: owner, by: ai, setup: OWNER_FACT, input: { content: 'Harbor backups go to Wasabi', meta: { sourceNote: 'use Wasabi' } }, want: { source: null, note: null, by: null } },
  { name: 'codex fact, keys only', setupBy: codex, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { keys: 'k' }, want: { source: 'owner_said', note: 'B2 it is', by: 'Codex' } },
  { name: 'codex fact, note only', setupBy: codex, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { meta: { sourceNote: 'mine' } }, want: { source: 'inferred', note: 'mine', by: 'Claude Code' } },
  { name: 'codex fact, rewrite no meta', setupBy: codex, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { content: 'Harbor backups go to Wasabi' }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'codex fact, owner_said + note', setupBy: codex, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { meta: { source: 'owner_said', sourceNote: 'mine' } }, want: { source: 'owner_said', note: 'mine', by: 'Claude Code' } },
  { name: 'own fact, keys only', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { keys: 'k' }, want: { source: 'owner_said', note: 'B2 it is', by: 'Claude Code' } },
  { name: 'own fact, new note', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { meta: { sourceNote: 'B2 yes' } }, want: { source: 'owner_said', note: 'B2 yes', by: 'Claude Code' } },
  { name: 'own fact, clear note', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { meta: { sourceNote: '' } }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'own fact, rewrite no meta', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { content: 'Harbor backups go to Wasabi' }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'own fact, rewrite + restate', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { content: 'Harbor backups go to Wasabi', meta: { source: 'owner_said' } }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'own fact, rewrite + note only', setupBy: ai, by: ai, setup: { source: 'owner_said', sourceNote: 'B2 it is' }, input: { content: 'Harbor backups go to Wasabi', meta: { sourceNote: 'Wasabi' } }, want: { source: 'owner_said', note: 'Wasabi', by: 'Claude Code' } },
  { name: 'inferred fact, to owner_said no note', setupBy: ai, by: ai, setup: { source: 'inferred', sourceNote: 'session' }, input: { meta: { source: 'owner_said' } }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'inferred fact, to owner_said + note', setupBy: ai, by: ai, setup: { source: 'inferred', sourceNote: 'session' }, input: { meta: { source: 'owner_said', sourceNote: 'B2 it is' } }, want: { source: 'owner_said', note: 'B2 it is', by: 'Claude Code' } },
  { name: 'no source, keys only', setupBy: ai, by: ai, setup: {}, input: { keys: 'k' }, want: { source: null, note: null, by: null } },
];
for (const c of T) {
  test(`direct equals held+approved (update): ${c.name}`, async () => {
    const run = async (opts: object) => {
      const { service } = make();
      const m = (await service.remember(dec(B2, c.setup), c.setupBy) as any).memory;
      return settle(service, await service.update(m.id, c.input, c.by, opts) as any);
    };
    const direct = await run({});
    assert.deepEqual(direct, c.want, 'direct');
    assert.deepEqual(await run(HOLD), direct, 'held then approved');
  });
}

const ADDS: { name: string; meta: object | undefined; want: object }[] = [
  { name: 'owner_said no note', meta: { source: 'owner_said' }, want: { source: 'inferred', note: null, by: 'Claude Code' } },
  { name: 'owner_said + note', meta: { source: 'owner_said', sourceNote: 'B2 it is' }, want: { source: 'owner_said', note: 'B2 it is', by: 'Claude Code' } },
  { name: 'inferred + note', meta: { source: 'inferred', sourceNote: 'session' }, want: { source: 'inferred', note: 'session', by: 'Claude Code' } },
  { name: 'no meta', meta: undefined, want: { source: null, note: null, by: null } },
];
for (const c of ADDS) {
  test(`direct equals held+approved (add): ${c.name}`, async () => {
    const run = async (opts: object) => {
      const { service } = make();
      const r = await service.remember({ ...dec(B2, c.meta ?? {}), ...opts }, ai) as any;
      if (r.status === 'suggested') return show(await service.approveSuggestion(r.suggestion.id));
      return show(r.memory);
    };
    const direct = await run({});
    assert.deepEqual(direct, c.want);
    assert.deepEqual(await run(HOLD), direct);
  });
}
