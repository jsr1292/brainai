/**
 * Adversarial: stored and reflected XSS in the server-rendered dashboard. Hostile text is planted in every field an
 * assistant or an imported file can fill (fact text, keys, tags, source notes, page titles and bodies, notes,
 * discussions, skills, connection names, picture alt text), then the dashboard pages that show them are fetched and
 * searched for live markup. Also: Markdown links and images, diagrams, picture files and content-type sniffing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageStore } from '../images/store.js';
import { polyglotGif, polyglotPng } from '../testing/imageFixtures.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { connectWith, OWNER, sessionCookie } from './support.js';

const PAY = '"><img src=x onerror=alert(1)><script>alert(1)</script><svg onload=alert(1)>';
/** Live markup a payload would leave behind if it were not escaped. */
const LIVE = /<script>alert|<img src=x|<svg onload|<iframe src="javascript|<img[^>]+\sonerror="?alert|"><(img|script)/i;

async function plant() {
  const app = await startTestApp();
  try { return await plantIn(app); } catch (e) { await app.close(); throw e; }
}

async function plantIn(app: Awaited<ReturnType<typeof startTestApp>>) {
  const f = await loggedIn(app);
  const { service, pages, registry, skills, discussions, notes } = app.deps;
  registry.create('xss-project', { state: 'open', area: 'apps', oneLiner: PAY }, 'owner');
  const fact = await service.remember({ kind: 'decision', project: 'xss-project', content: `Fact ${PAY}`, keys: `${PAY} keyword`, meta: { source: 'imported', sourceNote: PAY } }, OWNER);
  if (fact.status !== 'saved') throw new Error(`seed: ${fact.status}`);
  await service.remember({ kind: 'profile', content: `Profile ${PAY}` }, OWNER);
  // An assistant's suggestion waits in the Inbox with its hostile text and name.
  await service.remember({ kind: 'profile', content: `Waiting profile ${PAY}` }, { type: 'ai', name: PAY });
  const md = [
    `# Heading ${PAY}`, '', PAY, '',
    '[click](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>) [vb](vbscript:msgbox(1)) [ent](&#106;avascript:alert(1)) [tab](java&#x09;script:alert(1)) [sp]( javascript:alert(1))',
    '', '![x](javascript:alert(1)) ![y](https://evil.example/track.png) ![z](/images/aaaaaaaaaaaaaaaaaaaaaaaa.png"onerror="alert(1))', '',
    '<img src=x onerror=alert(1)> <iframe src="javascript:alert(1)"></iframe> <!-- <script>alert(1)</script> -->', '',
    '[[<script>alert(1)</script>]] [[fact:"><img src=x onerror=alert(1)>|"><svg onload=alert(1)>]]', '',
    '```mermaid\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B[<script>alert(1)</script>]\n```', '',
    '| a | b |\n|---|---|\n| <script>alert(1)</script> | `' + PAY + '` |', '',
  ].join('\n');
  const page = await pages.create({ title: `Title ${PAY}`, project: 'xss-project', body: md }, 'owner');
  notes.add(page.id, { text: PAY });
  discussions.open({ name: 'Codex', model: 'GPT', access: 'full' }, { title: `Disc ${PAY}`, question: PAY, files: [{ name: 'a.txt', content: PAY }] });
  skills.create({ name: 'xss-skill', description: PAY, body: PAY, files: [{ path: 'refs/a.md', text: PAY }] }, 'owner');
  skills.propose({ name: 'xss-proposed', description: PAY, body: PAY }, PAY);
  return { app, f, fact: fact.memory.id, page: page.id };
}

test('stored XSS: hostile text in facts, pages, notes, discussions, skills and project info is escaped on every dashboard page that shows it', async () => {
  const { app, f, fact, page } = await plant();
  try {
    const paths = ['/', '/facts', '/facts?show=replaced', `/memories/${fact}`, '/approvals', '/pages', `/pages/${page}`, `/pages/${page}/edit`, `/pages/${page}/history`, '/pages/new', '/overview', '/week', '/left',
      '/review/now', '/activity', '/discussions', '/skills', '/clients', '/settings', '/graph', '/disagreements', '/facts/tidy', '/projects/xss-project', '/search?q=Fact', '/import', '/map', '/memories/new'];
    const discussionId = app.deps.discussions.visible({ name: 'Codex', model: 'x', access: 'full' }, 'all')[0]!.id;
    const skillId = app.deps.skills.list()[0]!.id;
    paths.push(`/discussions/${discussionId}`, `/skills/${skillId}`, `/skills/${skillId}/edit`, `/skills/${skillId}/history`);
    const seen: string[] = [];
    for (const p of paths) {
      const res = await f(p);
      if (res.status !== 200) continue;
      seen.push(p);
      const body = await res.text();
      const hit = LIVE.exec(body);
      assert.equal(hit, null, `${p} contains live markup from a stored payload: ${hit?.[0]}\n…${body.slice(Math.max(0, (hit?.index ?? 0) - 80), (hit?.index ?? 0) + 160)}`);
    }
    assert.ok(seen.length >= 20, `only ${seen.length} pages answered 200: ${seen.join(' ')}`);
    // The data is really on those pages (the check above is not vacuous): escaped, not gone.
    const factPage = await (await f(`/memories/${fact}`)).text();
    assert.match(factPage, /&lt;img src=x onerror=alert\(1\)&gt;/);
  } finally { await app.close(); }
});

test('Markdown pages: javascript:, data:, vbscript:, entity-encoded and whitespace-split schemes never become a link or image; raw HTML is text; foreign images are not loaded', async () => {
  const { app, f, page } = await plant();
  try {
    const body = await (await f(`/pages/${page}`)).text();
    assert.doesNotMatch(body, /href\s*=\s*["']?\s*(javascript|data|vbscript)/i);
    assert.doesNotMatch(body, /src\s*=\s*["']?\s*(javascript|data|vbscript)/i);
    assert.doesNotMatch(body, /<img[^>]+src="https?:\/\/evil\.example/i, 'a page cannot make the owner\'s browser fetch a remote picture');
    assert.doesNotMatch(body, /<(object|embed)\b/i);
    for (const f of body.matchAll(/<iframe\b[^>]*>/gi)) assert.doesNotMatch(f[0], /javascript:|srcdoc|evil/i, `a frame from page content: ${f[0]}`);
    const scripts = [...body.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    for (const s of scripts) assert.match(s, /src="\/static\//, `an inline or foreign script: ${s}`);
    assert.match(body, /<pre class="diagram-src"><code>[^<]*&lt;img src=x onerror=alert\(1\)&gt;/, 'a diagram is its escaped text until the sandboxed frame draws it');
  } finally { await app.close(); }
});

test('reflected XSS: hostile query strings, paths and form fields come back escaped or not at all', async () => {
  const { app, f } = await plant();
  try {
    const q = encodeURIComponent(PAY);
    const cookie = await sessionCookie(app);
    const paths = [`/search?q=${q}`, `/facts?project=${q}`, `/facts?q=${q}&show=${q}`, `/import?saved=${q}&dup=${q}`, `/login?next=${q}`, `/pages?area=${q}`, `/pages/${q}`, `/memories/${q}`, `/discussions/${q}`, `/skills/${q}`,
      `/projects/${q}`, `/consent/${q}`, `/review/${q}`, `/settings/setup/${q}`, `/no-such-page/${q}`, `/graph/projects/${q}.json`, `/images/${q}`];
    for (const p of paths) {
      const res = await fetch(app.baseUrl + p, { headers: { Cookie: cookie }, redirect: 'manual' });
      const body = await res.text();
      const hit = LIVE.exec(body);
      assert.equal(hit, null, `${p} (${res.status}) reflects live markup: ${hit?.[0]}`);
    }
    const post = await f('/import/paste', { method: 'POST', body: new URLSearchParams({ source: PAY, text: PAY }) });
    assert.equal(LIVE.exec(await post.text()), null, 'the import review page');
    const login = await fetch(app.baseUrl + '/login', { method: 'POST', headers: { Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PAY, code: PAY, next: `/${PAY}` }) });
    assert.equal(LIVE.exec(await login.text()), null, 'the login form after a failed attempt');
  } finally { await app.close(); }
});

test('an app that registers with a hostile name cannot run script on the consent page or in Settings', async () => {
  const { app, f } = await plant();
  try {
    const reg = await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:9999/callback'], client_name: PAY, client_uri: 'javascript:alert(1)', logo_uri: 'javascript:alert(1)', token_endpoint_auth_method: 'none' }) });
    assert.ok([201, 400].includes(reg.status), String(reg.status));
    if (reg.status === 201) {
      const { client_id: clientId } = await reg.json() as { client_id: string };
      const auth = await fetch(app.baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', resource: `${app.baseUrl}/mcp` }), { redirect: 'manual' });
      const consent = await (await f(auth.headers.get('location')!)).text();
      assert.equal(LIVE.exec(consent), null, 'the consent page');
      assert.doesNotMatch(consent, /javascript:/i);
    }
    const c = await connectWith(app, f, { name: PAY.slice(0, 90) }).catch(() => null);
    for (const p of ['/clients', '/settings', '/', '/activity', '/approvals']) assert.equal(LIVE.exec(await (await f(p)).text()), null, p);
    void c;
  } finally { await app.close(); }
});

test('pictures: an SVG or HTML file is refused, a web page hidden after a real picture\'s end is cut off, and a stored picture is served as that image type only, sandboxed, nosniff', async () => {
  const { app, f } = await plant();
  try {
    const up = (body: Buffer | string, alt = 'a') => f(`/images?alt=${alt}`, { method: 'POST', body: body as BodyInit });
    for (const hostile of ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<html><script>alert(1)</script></html>', 'GIF89a<script>alert(1)</script>', '\x89PNG\r\n\x1a\n<script>alert(1)</script>']) {
      const r = await up(hostile);
      assert.equal(r.status, 400, hostile);
    }
    for (const poly of [await polyglotPng(), await polyglotGif()]) {
      const r = await up(poly);
      if (r.status !== 201) continue; // refused outright is fine too
      const { markdown } = await r.json() as { markdown: string };
      const path = /\((\/images\/[^)]+)\)/.exec(markdown)![1]!;
      const served = await f(path);
      assert.equal(served.status, 200);
      assert.match(served.headers.get('content-type')!, /^image\/(png|gif|jpeg|webp)$/);
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.match(served.headers.get('content-security-policy')!, /sandbox/);
      assert.doesNotMatch(Buffer.from(await served.arrayBuffer()).toString('latin1'), /<script|<html/i, 'the page after the picture was cut off');
    }
    // A file name that does not match the stored type, and a traversal in the name, are 404.
    for (const p of ['/images/../../etc/passwd', '/images/..%2f..%2fetc%2fpasswd', '/images/aaaaaaaaaaaaaaaaaaaaaaaa.svg', '/images/aaaaaaaaaaaaaaaaaaaaaaaa.png/../x']) {
      const r = await f(p);
      assert.ok([404, 302].includes(r.status), `${p} -> ${r.status}`);
    }
    void ImageStore;
  } finally { await app.close(); }
});

test('every response carries a CSP that forbids inline script and framing, and nosniff; the dashboard is never cached', async () => {
  const { app, f } = await plant();
  try {
    for (const p of ['/', '/login', '/facts', '/settings']) {
      const r = await f(p);
      const csp = r.headers.get('content-security-policy')!;
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|script-src[^;]*\*/, `${p}: ${csp}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    }
  } finally { await app.close(); }
});
