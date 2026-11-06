import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { isLifeArea } from '../projects/service.js';
import { graphWorld } from '../testing/graphWorld.js';
import { seedGraph } from './seedGraph.js';

test('the seed makes n projects with every state and some threads, the same every time', async (t) => {
  const run = async () => {
    const w = graphWorld({ floor: 0.5 });
    const refresh = mock.method(w.meaning, 'refresh');
    t.after(() => refresh.mock.restore());
    const r = await seedGraph({ registry: w.registry, service: w.service, pages: w.pages, meaning: w.meaning }, 40);
    return { w, r, refreshes: refresh.mock.callCount() };
  };
  const { w, r, refreshes } = await run();
  const all = w.registry.list();
  assert.equal(all.length, 40);
  assert.equal(r.projects, 40);
  assert.equal(all.filter((p) => p.pinnedAt !== null).length, 6);
  for (const state of ['idea', 'open', 'parked', 'done', 'archived']) assert.ok(all.some((p) => p.state === state), state);
  assert.ok(all.some((p) => isLifeArea(p)), 'an unpinned Personal project');
  assert.ok(all.some((p) => p.area === null), 'one with no area');
  assert.ok(all.every((p) => /^p\d{3}-[a-z]+$/.test(p.name)));
  assert.ok(all.every((p) => (p.oneLiner ?? '').length <= 120));
  assert.ok(w.graph.overview().threads.length > 0);
  assert.equal(refreshes, 0, 'no save hook ran while seeding');
  const decisions = (w.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'decision' AND deleted_at IS NULL").get() as { n: number }).n;
  const indexed = (w.db.prepare("SELECT COUNT(*) AS n FROM meaning_indexed WHERE kind = 'm'").get() as { n: number }).n;
  assert.ok(decisions > 0);
  assert.equal(indexed, decisions);
  assert.equal(r.facts, decisions);
  assert.ok(r.pages > 0);
  // The hook is back: a save after the seed is indexed at once.
  const saved = await w.service.remember({ kind: 'decision', content: 'restic copies the nas nightly', project: all[0]!.name }, w.owner) as { memory: { id: string } };
  assert.ok(w.db.prepare("SELECT 1 FROM meaning_indexed WHERE id = ?").get(saved.memory.id));

  const again = await run();
  assert.deepEqual(again.w.registry.list().map((p) => [p.name, p.state, p.area]), all.map((p) => [p.name, p.state, p.area]));
  assert.equal(again.r.facts, r.facts);
});
