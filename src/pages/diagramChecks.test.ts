import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePages, makeService } from '../testing/helpers.js';
import { DiagramChecks } from './diagramChecks.js';

const BAD = '```mermaid\nsequenceDiagram\n  A B: hi\n```';
const GOOD = '```mermaid\nsequenceDiagram\n  A->>B: hi\n```';

async function setup() {
  const now = () => new Date('2026-11-05T10:00:00Z');
  const given = makeService({ now });
  const pages = makePages(given, now);
  const checks = new DiagramChecks(given.db, now);
  const p = await pages.create({ title: 'Flow', area: 'apps', body: `Lead.\n\n${BAD}` }, 'owner');
  return { pages, checks, p };
}

test('a reported problem is kept against the stored text, cut to 300 characters, and replaced by the next report', async () => {
  const { checks, p } = await setup();
  checks.record(p, 1, 0, 'x'.repeat(400));
  assert.deepEqual(checks.problems(p).map((c) => [c.block, c.error.length]), [[0, 300]]);
  checks.record(p, 1, 0, 'Line 3: a message needs an arrow.');
  assert.deepEqual(checks.problems(p).map((c) => c.error), ['Line 3: a message needs an arrow.']);
  checks.record(p, 1, 0, null);
  assert.deepEqual(checks.problems(p), [], 'drew fine: no problem');
});

test('a problem stops counting once the diagram text changes, without any new report', async () => {
  const { pages, checks, p } = await setup();
  checks.record(p, 1, 0, 'Line 3: a message needs an arrow.');
  const fixed = await pages.save(p.id, { base: 1, body: `Lead.\n\n${GOOD}` }, 'Claude Code');
  assert.deepEqual(checks.problems(fixed), []);
  const back = await pages.save(p.id, { base: 2, body: `Lead.\n\n${BAD}` }, 'owner');
  assert.equal(checks.problems(back).length, 1, 'the same broken text again: the old report matches again');
});

test('a report for an old version or a block that does not exist is refused', async () => {
  const { checks, p } = await setup();
  assert.throws(() => checks.record(p, 2, 0, 'x'), /version/);
  assert.throws(() => checks.record(p, 1, 3, 'x'), /block/);
});
