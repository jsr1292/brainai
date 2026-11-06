import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from '../testing/helpers.js';
import { formatReport, runRecallTest } from './recallTest.js';

const owner = { type: 'owner' } as const;

async function setup() {
  const ctx = makeService();
  const save = async (content: string, project?: string) =>
    ((await ctx.service.remember({ kind: 'decision', content, project }, owner)) as { memory: { id: string } }).memory.id;
  const solar = await save('The house has SolarEdge solar panels and Pylontech batteries', 'energy');
  const wine = await save('Bramble is a wine cellar app for the club', 'wildlog');
  const tunnel = await save('Apps are exposed through Cloudflare tunnels on example.com');
  const gone = await save('An old idea that was dropped');
  ctx.service.forget(gone, owner);
  return { ...ctx, solar, wine, tunnel, gone };
}

test('each question is scored by where its expected memory first appears', async () => {
  const { service, solar, wine, tunnel } = await setup();
  const r = await runRecallTest(service, [
    { q: 'solar panels batteries', expect: [solar] },
    { q: 'wine cellar', expect: [tunnel, wine] },
    { q: 'quantum chromodynamics', expect: [tunnel] },
  ], 8);
  assert.deepEqual(r.results.map((x) => x.rank), [1, 1, null]);
  assert.equal(r.summary.cases, 3);
  assert.equal(r.summary.first, 2);
  assert.equal(r.summary.top3, 2);
  assert.equal(r.summary.found, 2);
  assert.equal(r.summary.missed, 1);
  assert.ok(Math.abs(r.summary.mrr - 2 / 3) < 1e-9);
});

test('a test run leaves no trace: memories are not marked as recalled', async () => {
  const { service, store, solar } = await setup();
  await runRecallTest(service, [{ q: 'solar panels', expect: [solar] }], 8);
  assert.equal(store.get(solar)!.lastRecalledAt, null);
});

test('questions that expect a deleted or unknown memory are reported, not scored', async () => {
  const { service, solar, gone } = await setup();
  const r = await runRecallTest(service, [
    { q: 'solar', expect: [solar] },
    { q: 'old idea', expect: [gone, 'no-such-id'] },
  ], 8);
  assert.equal(r.summary.cases, 1);
  assert.deepEqual(r.stale, [{ q: 'old idea', ids: [gone, 'no-such-id'] }]);
});

test('the report gives the scores and lists misses and late finds with what came back instead', async () => {
  const { service, solar, tunnel, gone } = await setup();
  const r = await runRecallTest(service, [
    { q: 'solar panels batteries', expect: [solar] },
    { q: 'quantum chromodynamics', expect: [tunnel] },
    { q: 'old idea', expect: [gone] },
  ], 8);
  const text = formatReport(r);
  assert.match(text, /^Recall test: 2 questions, top 8 results each/);
  assert.match(text, /Found first:\s+1 \(50%\)/);
  assert.match(text, /Missed:\s+1/);
  assert.match(text, /Mean reciprocal rank: 0\.50/);
  assert.match(text, /MISSED "quantum chromodynamics"\n\s+expected: Apps are exposed/);
  assert.match(text, /Expected memories no longer exist for 1 question:\n\s+"old idea"/);
  assert.doesNotMatch(text, /solar panels batteries"/);
});

test('the question file is a list of questions with expected memory ids, checked with clear errors', async () => {
  const { parseCases } = await import('./recallTest.js');
  assert.deepEqual(parseCases('[{"q":"solar?","expect":["a","b"]},{"q":"wine","expect":["c"],"project":"wildlog"}]'),
    [{ q: 'solar?', expect: ['a', 'b'] }, { q: 'wine', expect: ['c'], project: 'wildlog' }]);
  assert.throws(() => parseCases('{}'), /must be a JSON list/);
  assert.throws(() => parseCases('[{"q":"x","expect":[]}]'), /Question 1 .*"expect"/);
  assert.throws(() => parseCases('[{"q":"","expect":["a"]}]'), /Question 1 .*"q"/);
  assert.throws(() => parseCases('not json'), /not valid JSON/);
});
