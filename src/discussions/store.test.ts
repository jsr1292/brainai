import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { DiscussionStore } from './store.js';
import { voiceKey } from './types.js';

const setup = () => {
  const db = openDb(':memory:'); let t = Date.parse('2026-10-19T10:00:00Z');
  const store = new DiscussionStore(db, () => new Date(t));
  return { db, store, tick: (ms: number) => { t += ms; } };
};
const base = {
  title: 'Which database?', question: 'SQLite or Postgres?', project: 'brainai',
  openedBy: { name: 'Claude Code', model: 'Opus 4' }, ask: ['Claude', 'Grok'], includeLimited: true,
};

test('create then get round-trips every field, with round 1 and an 8-character id', () => {
  const { store } = setup();
  const d = store.create(base);
  assert.match(d.id, /^[a-z0-9]{8}$/);
  assert.deepEqual(store.get(d.id), {
    ...base, id: d.id, openedAt: '2026-10-19T10:00:00.000Z', round: 1,
    closedAt: null, decision: null, decisionMemoryId: null,
  });
});

test('list puts open discussions first and hides deleted ones; includeLimitedOnly hides include_limited = 0', () => {
  const { store, tick } = setup();
  const a = store.create(base); tick(1000);
  const b = store.create({ ...base, title: 'B', includeLimited: false }); tick(1000);
  const c = store.create({ ...base, title: 'C' }); tick(1000);
  const gone = store.create({ ...base, title: 'gone' });
  store.close(a.id, 'SQLite', null);
  store.softDelete(gone.id);
  assert.deepEqual(store.list({ status: 'all', includeLimitedOnly: false }).map((d) => d.id), [c.id, b.id, a.id]);
  assert.deepEqual(store.list({ status: 'all', includeLimitedOnly: true }).map((d) => d.id), [c.id, a.id]);
  assert.deepEqual(store.list({ status: 'open', includeLimitedOnly: false }).map((d) => d.id), [c.id, b.id]);
  assert.deepEqual(store.list({ status: 'closed', includeLimitedOnly: false }).map((d) => d.id), [a.id]);
  assert.equal(store.get(gone.id), undefined);
  const closed = store.get(a.id)!;
  assert.equal(closed.decision, 'SQLite'); assert.ok(closed.closedAt);
});

test('a second reply from the same voice in the same round violates the unique index', () => {
  const { store } = setup();
  const d = store.create(base);
  const p = { discussionId: d.id, round: 1, kind: 'reply' as const, author: 'Grok', model: 'Grok 4', text: 'hi' };
  store.addPost(p);
  assert.throws(() => store.addPost({ ...p, author: ' grok ', model: 'GROK  4' }));
  store.addPost({ ...p, round: 2 });
  store.addPost({ ...p, kind: 'note' });
  assert.equal(store.posts(d.id).length, 3);
});

test('files, ask, round and include-limited updates', () => {
  const { store } = setup();
  const d = store.create(base);
  store.addFile(d.id, 'a.md', 'héllo', 'Claude');
  assert.deepEqual(store.files(d.id).map((f) => [f.name, f.size, f.addedBy]), [['a.md', 6, 'Claude']]);
  assert.equal(store.fileContent(d.id, 'a.md'), 'héllo');
  assert.equal(store.fileContent(d.id, 'zz'), undefined);
  store.setRound(d.id, 2); store.setAsk(d.id, ['X']); store.setIncludeLimited(d.id, false);
  const g = store.get(d.id)!;
  assert.equal(g.round, 2); assert.deepEqual(g.ask, ['X']); assert.equal(g.includeLimited, false);
});

test('voiceKey treats "GLM-5", " glm-5 " as the same voice and "GLM 5" / "glm  5" as the same voice', () => {
  assert.equal(voiceKey('Grok', 'GLM-5'), voiceKey('grok', ' glm-5 '));
  assert.equal(voiceKey('Grok', 'GLM 5'), voiceKey('Grok', 'glm  5'));
  assert.notEqual(voiceKey('Grok', 'GLM-5'), voiceKey('Grok', 'GLM 5'));
});
