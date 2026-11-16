import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterReranker, withFallback } from './remoteReranker.js';
import type { Reranker } from './reranker.js';

const KEY = 'sk-or-made-up-key-0001';
const TEXTS = ['the cat sleeps', 'the sea is wide', 'a recipe for soup'];
const local: Reranker = { score: async (_q, texts) => texts.map((_t, i) => 10 - i) };

function setup(o: { fetch: typeof fetch; model?: string; zdr?: boolean; timeoutMs?: number; key?: string | null }) {
  const problems: string[] = [];
  let oks = 0;
  const online = createOpenRouterReranker({
    apiKey: () => (o.key === undefined ? KEY : o.key), model: o.model ?? 'voyageai/rerank-2.5', zdr: o.zdr, fetch: o.fetch, timeoutMs: o.timeoutMs ?? 200,
    onProblem: (p) => problems.push(p), onOk: () => { oks++; },
  });
  return { reranker: withFallback(online, local), problems, oks: () => oks };
}
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a good answer reorders by the service scores', async () => {
  const s = setup({ fetch: json(200, { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }, { index: 2, relevance_score: 0.5 }] }) as never });
  assert.deepEqual(await s.reranker.score('where is the sea', TEXTS), [0.1, 0.9, 0.5]);
  assert.deepEqual(s.problems, []);
  assert.equal(s.oks(), 1);
});

test('HTTP 401, 402 and 500, bad JSON, a hang and a network error each fall back to the local order with a plain problem', async () => {
  const cases: [string, typeof fetch, RegExp][] = [
    ['401', json(401, { error: { message: `bad key ${KEY}` } }) as never, /^the OpenRouter key was refused/],
    ['402', json(402, { error: 'credits' }) as never, /out of credit/],
    ['500', json(500, {}) as never, /OpenRouter/],
    ['bad json', (async () => new Response('<html>not json', { status: 200 })) as never, /OpenRouter/],
    ['hang', ((_u: unknown, init?: RequestInit) => new Promise(() => { void init; })) as never, /did not answer in time/],
    ['network', (async () => { throw new TypeError(`fetch failed for ${KEY}`); }) as never, /could not reach OpenRouter/],
  ];
  for (const [name, f, expect] of cases) {
    const s = setup({ fetch: f });
    const t0 = Date.now();
    assert.deepEqual(await s.reranker.score('my secret question', TEXTS), [10, 9, 8], `${name}: the local order`);
    assert.ok(Date.now() - t0 < 1000, `${name}: within the timeout`);
    assert.equal(s.problems.length, 1, name);
    assert.match(s.problems[0]!, expect, name);
    assert.ok(!s.problems[0]!.includes(KEY) && !s.problems[0]!.includes('secret question') && !s.problems[0]!.includes('cat sleeps'), `${name}: no key and no memory text`);
  }
});

test('no key saved falls back with a plain problem and never calls out', async () => {
  let called = 0;
  const s = setup({ key: null, fetch: (async () => { called++; return new Response('{}'); }) as never });
  assert.deepEqual(await s.reranker.score('q', TEXTS), [10, 9, 8]);
  assert.equal(called, 0);
  assert.match(s.problems[0]!, /no OpenRouter key/);
});

test('the request always says data_collection deny; zero retention adds zdr; the key goes only in the header', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ results: [] })); }) as never;
  await setup({ fetch: f }).reranker.score('q', TEXTS);
  await setup({ fetch: f, model: 'qwen/qwen3-reranker-8b', zdr: true }).reranker.score('q', TEXTS);
  const [a, b] = seen.map((s) => JSON.parse(s.init.body as string));
  assert.equal(a.provider.data_collection, 'deny');
  assert.equal(a.provider.zdr, undefined);
  assert.equal(b.provider.data_collection, 'deny');
  assert.equal(b.provider.zdr, true);
  assert.equal(a.model, 'voyageai/rerank-2.5');
  assert.deepEqual(a.documents, TEXTS);
  assert.equal(seen[0]!.url, 'https://openrouter.ai/api/v1/rerank');
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.ok(!seen[0]!.init.body!.toString().includes(KEY));
});

const hang = (counter: { n: number }) => ((_u: unknown, _i?: RequestInit) => { counter.n++; return new Promise(() => {}); }) as never;

test('a hanging service costs one timeout per recall, however many phrasings, then rests 60 s', async () => {
  const c = { n: 0 };
  const s = setup({ fetch: hang(c), timeoutMs: 150 });
  const t0 = Date.now();
  const first = await s.reranker.scoreMany!(['one', 'two', 'three'], TEXTS);
  const took = Date.now() - t0;
  assert.ok(took < 300, `about one timeout, took ${took} ms`);
  assert.equal(c.n, 1);
  assert.equal(first.online, false);
  assert.deepEqual(first.scores, [[10, 9, 8], [10, 9, 8], [10, 9, 8]]);
  const t1 = Date.now();
  const second = await s.reranker.scoreMany!(['one', 'two'], TEXTS);
  assert.ok(Date.now() - t1 < 50, 'no wait while resting');
  assert.equal(c.n, 1, 'OpenRouter is not called during the rest');
  assert.equal(second.online, false);
  assert.match(s.problems.at(-1)!, /did not answer in time/);
});

test('one source per recall: if a later phrasing fails, every phrasing is scored locally', async () => {
  let n = 0;
  const f = (async () => (++n === 1 ? new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] })) : new Response('{}', { status: 500 }))) as never;
  const s = setup({ fetch: f });
  const r = await s.reranker.scoreMany!(['one', 'two'], TEXTS);
  assert.equal(r.online, false);
  assert.deepEqual(r.scores, [[10, 9, 8], [10, 9, 8]], 'never a mix of online and local scores');
});

test('a good recall is online, one call per phrasing', async () => {
  const f = (async () => new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.7 }] }))) as never;
  const s = setup({ fetch: f });
  const r = await s.reranker.scoreMany!(['one', 'two'], TEXTS);
  assert.equal(r.online, true);
  assert.deepEqual(r.scores, [[0, 0.7, 0], [0, 0.7, 0]]);
});
