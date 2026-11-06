import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { DB } from '../db.js';
import { ImageStore } from '../images/store.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import * as fx from '../testing/imageFixtures.js';

async function app(t: TestContext) {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const upload = (body: Buffer, query = '', headers: Record<string, string> = {}) =>
    f(`/images${query}`, { method: 'POST', body: new Uint8Array(body), headers: { 'Content-Type': 'application/octet-stream', ...headers } });
  return { a, f, upload };
}

test('the owner uploads a picture and gets its Markdown line; the same bytes again give the same picture', async (t) => {
  const { upload } = await app(t);
  const r = await upload(await fx.jpegWithGps());
  assert.equal(r.status, 201);
  const j = await r.json() as { id: string; markdown: string; width: number; height: number; bytes: number; type: string };
  assert.match(j.markdown, /^!\[Describe the picture\]\(\/images\/[0-9a-f]{24}\.jpg\)$/);
  assert.deepEqual([j.width, j.height, j.type], [64, 48, 'jpeg']);
  const again = await (await upload(await fx.jpegWithGps(), '?alt=Label%20scan')).json() as { id: string; markdown: string };
  assert.equal(again.id, j.id);
  assert.equal(again.markdown, `![Label scan](/images/${j.id}.jpg)`);
  const long = await (await upload(await fx.jpegWithGps(), `?alt=${'x'.repeat(400)}`)).json() as { markdown: string };
  assert.equal(long.markdown, `![${'x'.repeat(300)}](/images/${j.id}.jpg)`);
});

test('refused uploads say why; without a session or from another site nothing is stored', async (t) => {
  const { a, upload } = await app(t);
  const svg = await upload(fx.svg());
  assert.equal(svg.status, 400);
  assert.equal((await svg.json() as { error: string }).error, "SVG pictures can't be added: they can carry script.");
  const big = await upload(Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.equal((await big.json() as { error: string }).error, 'This picture is over 10 MB.');
  const anon = await fetch(`${a.baseUrl}/images`, { method: 'POST', body: new Uint8Array(await fx.jpegWithGps()), redirect: 'manual', headers: { Origin: a.baseUrl } });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location') ?? '', /^\/login/);
  // The Origin check runs before the owner guard, so another site's POST is refused outright.
  const cross = await fetch(`${a.baseUrl}/images`, { method: 'POST', body: new Uint8Array(await fx.jpegWithGps()), redirect: 'manual', headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('a picture is served to the owner only, with a sandbox policy and nosniff', async (t) => {
  const { a, f, upload } = await app(t);
  const j = await (await upload(await fx.polyglotPng())).json() as { id: string };
  const url = `/images/${j.id}.png`;
  const r = await f(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const body = Buffer.from(await r.arrayBuffer());
  assert.ok(body.equals(readFileSync(a.deps.images.path(a.deps.images.get(j.id)!))));
  assert.ok(!body.includes(Buffer.from('<html')));
  const anon = await fetch(a.baseUrl + url, { redirect: 'manual' });
  assert.equal(anon.status, 302);
});

test('any other picture address is not found', async (t) => {
  const { a, f, upload } = await app(t);
  const j = await (await upload(await fx.jpegWithGps())).json() as { id: string };
  for (const path of [`/images/${j.id}.png`, `/images/${j.id.toUpperCase()}.jpg`, '/images/..%2Fmemory.db', `/images/${'0'.repeat(24)}.jpg`, '/images/', `/images/${j.id}.jpg.bak`]) {
    assert.equal((await f(path)).status, 404, path);
  }
  a.deps.images.markRemoved(j.id, 'owner');
  assert.equal((await f(`/images/${j.id}.jpg`)).status, 404, 'deleted for good');
});

test('pictures are served when the data folder sits under a dot-folder or is given as a relative path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-dot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hidden = join(root, '.local', 'brain');
  mkdirSync(hidden, { recursive: true });
  for (const dir of [hidden, relative(process.cwd(), join(root, 'rel'))]) {
    const { a, f } = await app(t);
    const db = (a.deps.store as unknown as { db: DB }).db;
    a.deps.images = new ImageStore(db, dir, a.deps.now);
    const img = a.deps.images.add(await fx.jpegWithGps(), { alt: 'x', by: 'owner' });
    const r = await f(`/images/${img.id}.jpg`);
    assert.equal(r.status, 200, dir);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
  }
});
