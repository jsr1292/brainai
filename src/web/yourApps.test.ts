/** The welcome's "Your apps" step (guided start): which AI apps the person uses, and what works on this computer. Fake HOME and tools only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { fakeHome } from '../testing/fakeTools.js';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { decodeEntities, withoutClientCatalog } from '../testing/entities.js';
import { enablePseudoLocale } from '../i18n/core.js';
import { readAnswer, saveAnswer, YOUR_APPS_SWITCH } from '../desktop/yourApps.js';

const CLAUDE_CONFIG = 'Library/Application Support/Claude/claude_desktop_config.json';

async function start(t: TestContext, o: { tools?: ('claude' | 'codex' | 'opencode' | 'gemini')[]; platform?: NodeJS.Platform; claudeApp?: boolean; localMode?: boolean; password?: boolean } = {}) {
  const f = fakeHome(o.tools ?? ['claude']);
  t.after(() => f.cleanup());
  if (o.claudeApp) mkdirSync(join(f.apps, 'Claude.app'));
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-apps-'));
  const app = await startTestApp({ localMode: o.localMode ?? true, noPassword: !o.password, statusDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, platform: o.platform, system: {}, claudeConfig: join(f.home, CLAUDE_CONFIG) } });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const get = async (p: string, headers: Record<string, string> = {}) => { const r = await fetch(app.baseUrl + p, { headers: { Cookie: cookie, ...headers } }); return { status: r.status, body: await r.text() }; };
  const post = (p: string, fields: [string, string][] = []) => fetch(app.baseUrl + p, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const answer = (apps: string[], way: 'reach' | 'server' | 'later' | null = null) => saveAnswer(app.deps.store, apps as never, way);
  /** The person's own answer: the ticks, then (when the screen shows a choice) the way. */
  const answerVia = async (apps: string[], way?: string) => {
    await post('/welcome/apps', apps.map((a) => ['app', a] as [string, string]));
    if (way !== undefined) await post('/welcome/apps/way', [['way', way]]);
  };
  return { app, f, get, post, answer, answerVia, cookie, statusDir };
}
const text = (body: string) => decodeEntities(withoutClientCatalog(body)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1');
const tile = (body: string, id: string) => new RegExp(`<input type="checkbox" name="app" value="${id}"( checked)?>`).exec(body);
const ways = (body: string) => [...body.matchAll(/<input type="radio" name="way" value="(\w+)"/g)].map((m) => m[1]);

test('the welcome has five steps and Your apps is step 2', async (t) => {
  const { get } = await start(t);
  const { status, body } = await get('/welcome?step=2');
  assert.equal(status, 200);
  assert.equal((body.match(/<li class="(?:done|current|todo)"/g) ?? []).length, 5);
  assert.match(body, /<li class="current" aria-current="step"><span class="step-mark">2<\/span><span>Your apps<\/span><\/li>/);
  assert.match(body, /Step 2 of 5/);
  assert.match(body, /<h1>Which AI apps do you use\?<\/h1>/);
  assert.equal((body.match(/\bprimary\b/g) ?? []).length, 1, 'one primary button');
});

test('apps found on this computer start ticked', async (t) => {
  const { get } = await start(t, { tools: ['claude'] });
  const body = (await get('/welcome?step=2')).body;
  assert.ok(tile(body, 'claude-code')![1], 'Claude Code found, ticked');
  assert.equal(tile(body, 'codex')![1], undefined, 'Codex not found, not ticked');
  assert.match(text(body), /Found here/);
  for (const id of ['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'opencode', 'chatgpt', 'claude-web', 'grok']) assert.ok(tile(body, id), id);
});

test('the Claude app counts as found only when the app itself is there', async (t) => {
  const a = await start(t, { tools: [] });
  mkdirSync(dirname(join(a.f.home, CLAUDE_CONFIG)), { recursive: true });
  assert.equal(tile((await a.get('/welcome?step=2')).body, 'claude-desktop')![1], undefined, 'only its config folder');
  const b = await start(t, { tools: [], claudeApp: true });
  assert.ok(tile((await b.get('/welcome?step=2')).body, 'claude-desktop')![1]);
});

test('a stored answer decides the ticks, not what is found', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['codex', 'grok']);
  const body = (await get('/welcome?step=2')).body;
  assert.equal(tile(body, 'claude-code')![1], undefined);
  assert.ok(tile(body, 'codex')![1]);
  assert.ok(tile(body, 'grok')![1]);
});

test('internet apps say they need an extra step and name their makers', async (t) => {
  const { get } = await start(t);
  const body = (await get('/welcome?step=2')).body;
  assert.equal((text(body).match(/Needs an extra step/g) ?? []).length, 3);
  assert.match(text(body), /OpenAI's, Anthropic's and xAI's computers/);
  assert.doesNotMatch(text(body), /localhost|MCP|HTTPS|tunnel|OAuth|server-side|their company/i);
});

test('ticking nothing, or Skip, goes straight to Search and stores an empty answer', async (t) => {
  const { post, app, answer } = await start(t);
  const none = await post('/welcome/apps');
  assert.equal(none.status, 303);
  assert.equal(none.headers.get('location'), '/welcome?step=3');
  answer(['codex'], 'reach');
  const skip = await post('/welcome/apps', [['app', 'chatgpt'], ['skip', '1']]);
  assert.equal(skip.headers.get('location'), '/welcome?step=3');
  assert.deepEqual(readAnswer(app.deps.store), { apps: [], way: null, dismissed: false });
});

test('ticking apps stores them (unknown ids dropped) and shows the result', async (t) => {
  const { post, app } = await start(t);
  const r = await post('/welcome/apps', [['app', 'claude-code'], ['app', 'chatgpt'], ['app', 'bogus']]);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/welcome?step=2&see=1');
  assert.deepEqual(readAnswer(app.deps.store), { apps: ['claude-code', 'chatgpt'], way: null, dismissed: false });
});

test('the result shows what works, what is not found and the choice', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['claude-code', 'cursor', 'chatgpt']);
  const body = (await get('/welcome?step=2&see=1')).body;
  const flat = text(body);
  assert.match(body, /Step 2 of 5/);
  assert.match(flat, /Works on this computer, right away/);
  assert.match(flat, /Claude Code/);
  assert.match(flat, /No password needed: nothing leaves this computer\./);
  assert.match(flat, /Not found on this computer yet: Cursor\. Install what is missing, then connect it in Settings › Tools\./);
  assert.match(flat, /One more choice for these/);
  assert.deepEqual(ways(body), ['reach', 'server', 'later']);
  assert.match(flat, /Suggested/);
  assert.match(flat, /Settings › Reach from phone and web/);
  assert.equal((body.match(/\bprimary\b/g) ?? []).length, 1, 'one primary button');
  assert.match(body, /<a href="\/welcome\?step=2">‹ Back<\/a>/);
});

test('only internet apps ticked shows the choice without a green box', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['chatgpt']);
  const body = (await get('/welcome?step=2&see=1')).body;
  assert.doesNotMatch(text(body), /Works on this computer, right away|No password needed/);
  assert.match(text(body), /One more choice for these/);
  assert.deepEqual(ways(body), ['reach', 'server', 'later']);
  assert.match(body, /ChatGPT/);
});

test('when every ticked app works here the title says so and there is no choice', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['claude-code']);
  const body = (await get('/welcome?step=2&see=1')).body;
  assert.match(text(body), /everything works on this computer/i);
  assert.deepEqual(ways(body), []);
  assert.doesNotMatch(text(body), /One more choice/);
  assert.match(body, /<a class="button primary" href="\/welcome\?step=3">Continue<\/a>/);
});

test('with Reach on, internet apps work and no choice is asked', async (t) => {
  const { app, get, answer } = await start(t, { tools: ['claude'], password: true });
  app.deps.reach!.set(new URL('https://brainai-mac.tail1234.ts.net'), 1234);
  answer(['claude-code', 'chatgpt']);
  const body = (await get('/welcome?step=2&see=1')).body;
  const flat = text(body);
  assert.deepEqual(ways(body), []);
  assert.doesNotMatch(flat, /One more choice/);
  assert.match(flat, /ChatGPT: through this computer's internet address, while it is on and awake/);
  assert.match(flat, /Works on this computer, right away/);
});

test('on Windows the choice offers a server or not now, never Tailscale', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'], platform: 'win32' });
  answer(['chatgpt']);
  for (const path of ['/welcome?step=2', '/welcome?step=2&see=1']) {
    const body = (await get(path)).body;
    assert.doesNotMatch(text(body), /Tailscale|reachable/i, path);
  }
  const body = (await get('/welcome?step=2&see=1')).body;
  assert.deepEqual(ways(body), ['server', 'later']);
  assert.match(text(body), /You can change this later in Settings\./);
});

test('the way is saved and setup moves on to Search', async (t) => {
  const { post, app, answer } = await start(t);
  answer(['chatgpt']);
  const r = await post('/welcome/apps/way', [['way', 'server']]);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/welcome?step=3');
  assert.deepEqual(readAnswer(app.deps.store), { apps: ['chatgpt'], way: 'server', dismissed: false });
  assert.equal((await post('/welcome/apps/way', [['way', 'bogus']])).headers.get('location'), '/welcome?step=3');
  assert.equal(readAnswer(app.deps.store)!.way, 'later', 'an unknown way is not now');
});

test('the Your apps step is not served through the public door', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-door-'));
  const app = await startTestApp({ localMode: true, statusDir, appSecret: 'test-app-secret' });
  t.after(() => app.close());
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const call = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; setCookie: string[] }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const { TEST_PASSWORD } = await import('../testing/helpers.js');
  const login = await call('POST', '/login', { Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }).toString());
  assert.equal(login.status, 302);
  const nav = { Cookie: login.setCookie.join('; '), 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' };
  assert.equal((await call('GET', '/welcome?step=2', nav)).status, 404);
  assert.equal((await call('GET', '/welcome?step=2&see=1', nav)).status, 404);
  const form = { ...nav, Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  assert.equal((await call('POST', '/welcome/apps', form, 'app=chatgpt')).status, 404);
  assert.equal((await call('POST', '/welcome/apps/way', form, 'way=server')).status, 404);
  assert.equal(readAnswer(app.deps.store), null);
});

test('the Your apps step is not served on a server', async (t) => {
  const server = await startTestApp({ localMode: false });
  t.after(() => server.close());
  const as = await loggedIn(server);
  assert.equal((await as('/welcome?step=2')).status, 404);
});

test('the Your apps screens have no English left in Spanish (xx) and read in Spanish', async (t) => {
  const { app, get, post, answerVia, statusDir } = await start(t, { tools: ['claude'], password: true });
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try {
    assertNoEnglishLeft((await get('/welcome?step=2')).body, 'pick');
    await answerVia(['claude-code', 'cursor', 'chatgpt', 'claude-web', 'grok']);
    assertNoEnglishLeft((await get('/welcome?step=2&see=1')).body, 'result');
    app.deps.reach!.set(new URL('https://brainai-mac.tail1234.ts.net'), 1234);
    assertNoEnglishLeft((await get('/welcome?step=2&see=1')).body, 'result, reach on');
    app.deps.reach!.set(null, 0);
    await answerVia(['claude-code']);
    assertNoEnglishLeft((await get('/welcome?step=2&see=1')).body, 'result, all here');
    markDone(statusDir);
    for (const way of ['reach', 'server', 'later'] as const) {
      await answerVia(['codex', 'claude-code', 'chatgpt', 'claude-web', 'grok'], way);
      for (const path of ['/welcome?step=4', '/welcome?step=5', '/']) assertNoEnglishLeft((await get(path)).body, `${path} ${way}`, { allow: [] });
    }
  } finally { enablePseudoLocale(false); }
  app.deps.store.setSwitch('ui_language', 'es');
  const es = (await get('/welcome?step=2')).body;
  assert.match(es, /Paso 2 de 5/);
  assert.match(text(es), /¿Qué apps de IA usas\?/);
  assert.doesNotMatch(text(es), /Which AI apps|Needs an extra step/);
  await post('/welcome/apps', [['app', 'claude-code'], ['app', 'cursor'], ['app', 'chatgpt'], ['app', 'grok']]);
  const result = text((await get('/welcome?step=2&see=1')).body);
  assert.match(result, /Así funcionarán tus apps/);
  assert.match(result, /Aún no se han encontrado en este ordenador: Cursor/);
  assert.doesNotMatch(result, /Works on this computer|One more choice|Suggested/);
  assert.equal(YOUR_APPS_SWITCH, 'your_apps');
});

// ---- Connect and Home use the answer ----

const connectOrder = (body: string) => [...body.matchAll(/action="\/settings\/tools\/([\w-]+)\/connect"/g)].map((m) => m[1]);
const posOf = (body: string, needle: string) => { const i = body.indexOf(needle); assert.ok(i >= 0, needle); return i; };
const markDone = (statusDir: string) => writeFileSync(join(statusDir, 'welcome-done'), '');

test('Connect lists the apps you ticked first', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude', 'codex', 'opencode'] });
  answer(['opencode', 'codex']);
  const body = (await get('/welcome?step=4')).body;
  assert.deepEqual(connectOrder(body), ['codex', 'opencode', 'claude-code'], 'ticked first, in the usual order, then the others');
  const flat = text(body);
  assert.ok(flat.indexOf('Also on this computer') > flat.indexOf('OpenCode'));
  assert.ok(flat.indexOf('Also on this computer') < flat.lastIndexOf('Claude Code'));
});

test('a ticked app that is not installed shows how to get it', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['cursor', 'claude-code']);
  const body = (await get('/welcome?step=4')).body;
  assert.match(body, /<li class="tool tool-off">[\s\S]*?Cursor[\s\S]*?Not found on this computer yet: install it, then connect it in Settings › Tools\.[\s\S]*?<\/li>/);
  assert.doesNotMatch(body, /settings\/tools\/cursor\/connect/);
  assert.ok(posOf(body, 'Claude Code') < posOf(body, 'tool-off'));
});

test('with no answer, or Skip, Connect is as before', async (t) => {
  const { get, post } = await start(t, { tools: ['claude', 'codex', 'opencode'] });
  const before = (await get('/welcome?step=4')).body;
  assert.deepEqual(connectOrder(before), ['claude-code', 'codex', 'opencode']);
  assert.doesNotMatch(text(before), /Also on this computer/);
  assert.match(text(before), /ChatGPT's app can't reach a brain/, 'the ChatGPT row stays, as today');
  await post('/welcome/apps', [['skip', '1']]);
  const after = (await get('/welcome?step=4')).body;
  assert.deepEqual(connectOrder(after), ['claude-code', 'codex', 'opencode']);
  assert.match(text(after), /ChatGPT's app can't reach a brain/);
  assert.doesNotMatch(after, /tool-off/);
});

test('the internet row names only the ticked internet apps and the chosen way', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'] });
  answer(['claude-code', 'chatgpt', 'grok'], 'reach');
  const body = (await get('/welcome?step=4')).body;
  const flat = text(body);
  assert.match(flat, /For ChatGPT and Grok: a brain that lives only on this computer is out of reach\. After setup, turn on Reach from phone and web\./);
  assert.doesNotMatch(flat, /Claude on the web/);
  assert.ok(body.includes('href="/settings/reach"'));
  answer(['chatgpt'], 'server');
  assert.match(text((await get('/welcome?step=4')).body), /For ChatGPT: a brain that lives only on this computer is out of reach\. You chose a server: when you're ready, move BrainAI to a server\./);
  answer(['chatgpt'], 'later');
  assert.match(text((await get('/welcome?step=4')).body), /so the memory is not shared yet\. You can change that in Settings › Reach from phone and web\./);
  answer(['claude-code'], null);
  assert.doesNotMatch(text((await get('/welcome?step=4')).body), /out of reach/, 'no internet app ticked: no row');
});

test('on Windows the internet row never talks about Reach', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude'], platform: 'win32' });
  for (const way of ['reach', 'server', 'later'] as const) {
    answer(['chatgpt'], way);
    const body = (await get('/welcome?step=4')).body;
    assert.doesNotMatch(text(body), /Reach|Tailscale/, way);
    assert.match(body, /href="\/settings\/move"/, way);
  }
});

test('Home shows the next-step card until it is dismissed, and answering again brings it back', async (t) => {
  const { get, post, answerVia, statusDir } = await start(t, { tools: ['claude'] });
  markDone(statusDir);
  await answerVia(['chatgpt', 'claude-web'], 'reach');
  const home = async () => (await get('/')).body;
  let body = await home();
  assert.match(text(body), /Next: make this computer reachable for ChatGPT and Claude on the web/);
  assert.match(body, /class="button" href="\/settings\/reach"/);
  assert.match(body, /<form method="post" action="\/welcome\/next\/dismiss"/);
  const r = await post('/welcome/next/dismiss');
  assert.equal(r.status, 303);
  assert.doesNotMatch(text(await home()), /Next: make this computer/);
  await answerVia(['chatgpt'], 'server');
  body = await home();
  assert.match(text(body), /Next: move BrainAI to a server for ChatGPT/);
  assert.match(body, /href="\/settings\/move"/);
});

test('there is no next-step card for Not now, no answer, or an answer without internet apps', async (t) => {
  const { get, answer, statusDir } = await start(t, { tools: ['claude'] });
  markDone(statusDir);
  const none = async () => assert.doesNotMatch(text((await get('/')).body), /Next: (make|move)/);
  await none();
  answer(['chatgpt'], 'later'); await none();
  answer(['chatgpt'], null); await none();
  answer(['claude-code'], 'reach'); await none();
});

test('the next-step card is gone once Reach is on or the brain moved', async (t) => {
  const { app, get, answer, statusDir } = await start(t, { tools: ['claude'], password: true });
  markDone(statusDir);
  answer(['chatgpt'], 'reach');
  assert.match(text((await get('/')).body), /Next: make this computer reachable/);
  app.deps.reach!.set(new URL('https://brainai-mac.tail1234.ts.net'), 1234);
  assert.doesNotMatch(text((await get('/')).body), /Next: make this computer reachable/);
  app.deps.reach!.set(null, 0);
  answer(['chatgpt'], 'server');
  assert.match(text((await get('/')).body), /Next: move BrainAI to a server/);
  writeFileSync(join(statusDir, 'moved.json'), JSON.stringify({ to: 'https://brain.example.com', at: '2026-11-01T00:00:00Z' }));
  assert.doesNotMatch(text((await get('/')).body), /Next: (make|move)/);
});

test('the welcome\'s last screen shows the card above Done, without a link out, and Dismiss lands back on step 5', async (t) => {
  const { get, post, answer, app } = await start(t, { tools: ['claude'] });
  answer(['chatgpt'], 'reach');
  const body = (await get('/welcome?step=5')).body;
  assert.match(text(body), /Next: make this computer reachable for ChatGPT/);
  assert.ok(posOf(body, 'next-card') < posOf(body, 'action="/welcome/done"'));
  assert.doesNotMatch(body, /href="\/settings\/(reach|move)"/, 'no link that leaves the welcome');
  assert.match(body, /<input type="hidden" name="back" value="welcome">/);
  const r = await post('/welcome/next/dismiss', [['back', 'welcome']]);
  assert.equal(r.headers.get('location'), '/welcome?step=5');
  assert.equal(readAnswer(app.deps.store)!.dismissed, true);
  assert.doesNotMatch(text((await get('/welcome?step=5')).body), /Next: make this computer/);
  assert.equal((await post('/welcome/next/dismiss')).headers.get('location'), '/', 'from Home it goes to Home');
  assert.equal((await post('/welcome/next/dismiss', [['back', '/elsewhere']])).headers.get('location'), '/', 'only the exact word');
});

test('Connect puts the internet row right after the ticked apps, before "Also on this computer"', async (t) => {
  const { get, answer } = await start(t, { tools: ['claude', 'codex', 'opencode'] });
  answer(['codex', 'cursor', 'chatgpt'], 'server');
  const body = (await get('/welcome?step=4')).body;
  const at = (needle: string) => posOf(body, needle);
  assert.ok(at('tool-off') < at('For ChatGPT'), 'after the not-found row');
  assert.ok(at('For ChatGPT') < at('Also on this computer'));
  assert.ok(at('Also on this computer') < at('settings/tools/claude-code/connect'));
});

test('a way this computer does not offer is not stored: Windows never keeps reach, and no card follows', async (t) => {
  const win = await start(t, { tools: ['claude'], platform: 'win32' });
  markDone(win.statusDir);
  win.answer(['chatgpt']);
  assert.equal((await win.post('/welcome/apps/way', [['way', 'reach']])).headers.get('location'), '/welcome?step=3');
  assert.equal(readAnswer(win.app.deps.store)!.way, 'later');
  assert.equal((await win.post('/welcome/apps/way', [['way', 'server']])).status, 303);
  assert.equal(readAnswer(win.app.deps.store)!.way, 'server');
  // An answer of reach that is already stored (an older or edited one) gives no card on Windows.
  win.answer(['chatgpt'], 'reach');
  assert.doesNotMatch(text((await win.get('/')).body), /Next: make this computer reachable/);
  const mac = await start(t, { tools: ['claude'] });
  mac.answer(['chatgpt']);
  await mac.post('/welcome/apps/way', [['way', 'reach']]);
  assert.equal(readAnswer(mac.app.deps.store)!.way, 'reach');
  // Nothing to choose (only local apps): no way is kept.
  mac.answer(['claude-code']);
  await mac.post('/welcome/apps/way', [['way', 'server']]);
  assert.equal(readAnswer(mac.app.deps.store)!.way, null);
});

test('"You can change this later" appears only when a choice was shown or Reach makes internet apps work', async (t) => {
  const { app, get, answer } = await start(t, { tools: ['claude'], password: true });
  answer(['claude-code']);
  assert.doesNotMatch(text((await get('/welcome?step=2&see=1')).body), /change this later/);
  answer(['chatgpt']);
  assert.match(text((await get('/welcome?step=2&see=1')).body), /change this later/);
  app.deps.reach!.set(new URL('https://brainai-mac.tail1234.ts.net'), 1234);
  assert.match(text((await get('/welcome?step=2&see=1')).body), /change this later/);
});

test('every Your apps string that takes {apps} reads right for one app and for several, in both languages', async () => {
  const { catalogOf } = await import('../i18n/core.js');
  for (const lang of ['en', 'es'] as const) {
    for (const [key, value] of Object.entries(catalogOf(lang))) {
      if (!key.startsWith('setup.apps.') || typeof value !== 'string' || !value.includes('{apps}')) continue;
      // No verb may agree with the list: the list is only ever introduced by "For"/"Para" or a colon, or ends the sentence.
      assert.doesNotMatch(value, /\{apps\} (reach|llega|puede|can)/i, `${lang} ${key}`);
    }
  }
});

test('the next-step card and its dismiss never show through the public door', async (t) => {
  const statusDir = mkdtempSync(join(tmpdir(), 'brainai-door-'));
  markDone(statusDir);
  const app = await startTestApp({ localMode: true, statusDir, appSecret: 'test-app-secret' });
  t.after(() => app.close());
  saveAnswer(app.deps.store, ['chatgpt'], 'reach');
  const host = 'brainai-mac.tail1234.ts.net';
  const port = await app.deps.door!.open();
  app.deps.reach!.set(new URL(`https://${host}`), port);
  const call = (method: string, path: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; body: string; setCookie: string[] }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, setHost: false, headers: { Host: host, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, setCookie: (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const { TEST_PASSWORD } = await import('../testing/helpers.js');
  const login = await call('POST', '/login', { Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ password: TEST_PASSWORD, code: app.nextTotp() }).toString());
  const cookie = login.setCookie.join('; ');
  // Reach is on here, which already hides the "reach" card: use the server choice so only the door can hide it.
  saveAnswer(app.deps.store, ['chatgpt'], 'server');
  const home = await call('GET', '/', { Cookie: cookie, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' });
  assert.equal(home.status, 200);
  assert.doesNotMatch(text(home.body), /Next: move BrainAI/);
  const dismiss = await call('POST', '/welcome/next/dismiss', { Cookie: cookie, Origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded' }, '');
  assert.equal(dismiss.status, 404);
  assert.equal(readAnswer(app.deps.store)!.dismissed, false);
});
