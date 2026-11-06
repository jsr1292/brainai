import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';

const FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

test('the renderer frame is the owner\'s, with its own strict policy and no inline script', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const r = await f('/diagram-frame');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), FRAME_CSP);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.text();
  assert.match(body, /<script type="module" src="\/static\/diagram-frame\.js\?v=[0-9a-f]{10}"><\/script>/);
  assert.doesNotMatch(body, /<script>|<script type="module">|style=/);
  const anon = await fetch(a.baseUrl + '/diagram-frame', { redirect: 'manual' });
  assert.equal(anon.status, 302);
});

test('the owner\'s browser reports what each diagram drew; the page marks a current problem until the text is fixed', async (t) => {
  const a = await startTestApp();
  t.after(() => a.close());
  const f = await loggedIn(a);
  const bad = '```mermaid\nsequenceDiagram\n  A B: hi\n```';
  const p = await a.deps.pages.create({ title: 'Flow', area: 'apps', body: `Lead.\n\n${bad}\n\n\`\`\`mermaid\nflowchart TD\n a-->b\n\`\`\`` }, 'owner');
  const post = (body: unknown, size = 0) => f(`/pages/${p.id}/diagram-checks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: size ? 'x'.repeat(size) : JSON.stringify(body) });
  assert.equal((await post({ version: 1, block: 0, error: 'Line 3: a message needs an arrow.' })).status, 204);
  assert.equal((await post({ version: 1, block: 1, error: null })).status, 204);
  assert.equal((await post({ version: 9, block: 0, error: 'x' })).status, 409);
  assert.equal((await post({ version: 1, block: 5, error: 'x' })).status, 400);
  assert.equal((await post({ version: 1, block: 0, error: 42 })).status, 400);
  assert.equal((await post(null, 5000)).status, 413);
  const anon = await fetch(`${a.baseUrl}/pages/${p.id}/diagram-checks`, { method: 'POST', redirect: 'manual', headers: { Origin: a.baseUrl, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 302);
  const page = await (await f(`/pages/${p.id}`)).text();
  assert.match(page, /<article class="art"[^>]* data-page="[^"]+" data-version="1"/);
  assert.match(page, /<div class="diagram" id="diagram-1" data-block="0" data-problem="">/);
  assert.match(page, /<div class="diagram" data-block="1">/);
  await a.deps.pages.save(p.id, { base: 1, body: 'Lead.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```' }, 'Claude Code');
  assert.doesNotMatch(await (await f(`/pages/${p.id}`)).text(), /data-problem/);
});
