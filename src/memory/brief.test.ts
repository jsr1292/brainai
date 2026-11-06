import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { FOUNDING_DECISIONS, isStatus, MAX_DECISIONS, projectBrief } from './brief.js';
import type { Kind } from './types.js';

function setup() {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const { store } = makeService({ now: () => new Date(t) });
  const v = new Float32Array(384); v[0] = 1;
  const add = (kind: Kind, content: string, extra: { project?: string | null; tags?: string[] } = {}) => {
    t += 60_000;
    return store.insert({ kind, content, project: extra.project === undefined ? 'wildlog' : extra.project, tags: extra.tags ?? [], embedding: v, by: 'Claude Code' });
  };
  return { store, add, later: (ms: number) => { t += ms; } };
}

test('a status is a summary or any memory tagged status', () => {
  const { add } = setup();
  assert.equal(isStatus(add('summary', 'Session notes')), true);
  assert.equal(isStatus(add('decision', 'v0.2 released, next: 3D cellar', { tags: ['status'] })), true);
  assert.equal(isStatus(add('decision', 'Uses SwiftUI', { tags: ['ui'] })), false);
});

test('a briefing has the statuses newest first and the decisions oldest first, nothing from other projects', () => {
  const { store, add, later } = setup();
  const first = add('decision', 'Uses SwiftUI');
  const oldStatus = add('summary', 'Status: v0.1 released');
  const second = add('decision', 'Sommelier uses Sign in with ChatGPT');
  const tagged = add('decision', 'Status: v0.2 released', { tags: ['status'] });
  add('decision', 'Other project decision', { project: 'trellis' });
  add('profile', 'Lives in Berlin', { project: null });
  later(60_000);
  store.update(oldStatus.id, { content: 'Status: v0.1.1 released', project: 'wildlog', tags: [], embedding: new Float32Array(384), by: 'Grok' });

  const brief = projectBrief(store, 'wildlog')!;
  assert.equal(brief.project, 'wildlog');
  assert.deepEqual(brief.statuses.map((m) => m.id), [oldStatus.id, tagged.id]);
  assert.deepEqual(brief.decisions.map((m) => m.id), [first.id, second.id]);
  assert.equal(brief.omitted, 0);
});

test('deleted memories are left out, and a project with nothing active has no briefing', () => {
  const { store, add } = setup();
  const gone = add('decision', 'Dropped idea', { project: 'castle3d' });
  store.softDelete(gone.id, 'owner');
  assert.equal(projectBrief(store, 'castle3d'), undefined);
  assert.equal(projectBrief(store, 'never-heard-of'), undefined);
});

test('a long project keeps its founding and newest decisions, leaving out the middle, and says how many', () => {
  const { store, add } = setup();
  const all = Array.from({ length: MAX_DECISIONS + 3 }, (_, i) => add('decision', `Decision ${i}`));
  const brief = projectBrief(store, 'wildlog')!;
  assert.equal(brief.decisions.length, MAX_DECISIONS);
  assert.deepEqual(brief.decisions.slice(0, FOUNDING_DECISIONS).map((m) => m.id), all.slice(0, FOUNDING_DECISIONS).map((m) => m.id));
  assert.equal(brief.decisions[FOUNDING_DECISIONS]!.id, all[FOUNDING_DECISIONS + 3]!.id);
  assert.equal(brief.decisions.at(-1)!.id, all.at(-1)!.id);
  assert.equal(brief.omitted, 3);
});
