import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { createFakeEmbedder } from './fakeEmbedder.js';
import { MemoryService } from './service.js';
import { MemoryStore } from './store.js';
import { suggestionCard } from '../web/dashboardViews.js';

/*
 * A held update that did not change the text (or the tags) when it was made keeps whatever the fact has when the owner
 * approves it: the owner's edit made while it waited is never put back. Text it did change still applies.
 */

const claude = { type: 'ai', name: 'Claude Code' } as const;
const owner = { type: 'owner' } as const;
const HOLD = { hold: 'saves wait' };
const OLD = 'Harbor backups go to Backblaze B2';
const NEW = 'Nightly Harbor backups now go to Backblaze EU';

async function setup() {
  const store = new MemoryStore(openDb(':memory:'), () => new Date());
  const service = new MemoryService(store, createFakeEmbedder(), { duplicateThreshold: 0.9, minRecallSimilarity: 0.2, recallConfidentSimilarity: 0.2 });
  const m = (await service.remember({ kind: 'decision', content: OLD, project: 'harbor', tags: ['infra'], newProject: true }, owner) as any).memory;
  return { service, store, m };
}
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('a held keys-only update approved after the owner edited the text keeps the owner\'s text and adds the keys', async () => {
  const { service, store, m } = await setup();
  const r = await service.update(m.id, { keys: 'backup bucket' }, claude, HOLD) as any;
  assert.equal(r.status, 'suggested');
  await service.update(m.id, { content: NEW }, owner);
  const made = await service.approveSuggestion(r.suggestion.id);
  assert.equal(made!.content, NEW);
  assert.equal(store.get(m.id)!.content, NEW);
  assert.equal(made!.keys, 'backup bucket');
});

test('a held keys-only update approved after the owner edited the tags keeps the owner\'s tags', async () => {
  const { service, m } = await setup();
  const r = await service.update(m.id, { keys: 'backup bucket' }, claude, HOLD) as any;
  await service.update(m.id, { tags: ['infra', 'offsite'] }, owner);
  const made = await service.approveSuggestion(r.suggestion.id);
  assert.deepEqual(made!.tags, ['infra', 'offsite']);
  assert.equal(made!.keys, 'backup bucket');
});

test('a held update that changes the text still applies its text after the owner edited meanwhile, and the card shows it as proposed', async () => {
  const { service, m } = await setup();
  const HELD = 'Harbor backups go to Wasabi Frankfurt';
  const r = await service.update(m.id, { content: HELD }, claude, HOLD) as any;
  await service.update(m.id, { content: NEW }, owner);
  const s = service.pendingSuggestions()[0]!;
  const card = text(suggestionCard(s, NEW, { back: '/approvals' }).value);
  assert.match(card, new RegExp(`proposed[^]*${HELD}|${HELD}`));
  assert.equal(s.content, HELD);
  assert.equal((await service.approveSuggestion(r.suggestion.id))!.content, HELD);
});

test('approving with the owner\'s own edited text keeps that text over both the held and the current text', async () => {
  const { service, m } = await setup();
  const r = await service.update(m.id, { keys: 'backup bucket' }, claude, HOLD) as any;
  await service.update(m.id, { content: NEW }, owner);
  const made = await service.approveSuggestion(r.suggestion.id, 'Harbor backups go to Hetzner');
  assert.equal(made!.content, 'Harbor backups go to Hetzner');
  assert.equal(made!.keys, 'backup bucket');
});

test('the Inbox card of a held keys-only update shows the fact\'s current text, not the old text, as proposed', async () => {
  const { service, m } = await setup();
  await service.update(m.id, { keys: 'backup bucket' }, claude, HOLD);
  await service.update(m.id, { content: NEW }, owner);
  const s = service.pendingSuggestions()[0]!;
  assert.equal(s.content, NEW);
  const html = suggestionCard(s, NEW, { back: '/approvals' }).value;
  assert.ok(!text(html).includes(OLD), 'the old text appears nowhere on the card');
  assert.ok(html.includes(NEW));
});
