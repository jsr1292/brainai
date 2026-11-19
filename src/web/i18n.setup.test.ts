/** The setup area (welcome wizard, Settings › Tools, Connect, Reach, the "Set up an app" pages) in Spanish. Fake HOME and tools only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { fakeHome } from '../testing/fakeTools.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { decodeEntities } from '../testing/entities.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { catalogOf } from '../i18n/core.js';
import { html, page, raw } from './html.js';
import { toolEnv } from './desktopRoutes.js';
import { detailText, toolStates, type ToolState } from '../desktop/tools.js';
import { setupApps, SETUP_VERSION } from '../setup/texts.js';
import { setupPage, setupStatusLine } from './setupViews.js';
import { reachPage, reachSwitch, tailscaleBox } from './reachViews.js';
import { describeComputer, firstLine, modelGroups, modelsLine, offsiteCard, searchSection, toolsPage, updateCard, welcomePage, modelsProgress } from './desktopViews.js';
import { updateLine, type UpdateFile } from '../desktop/updateState.js';
import { CATALOGUE } from '../models/catalogue.js';
import type { ModelStatus } from '../models/manager.js';
import type { GrantInfo } from '../auth/provider.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const CLAUDE_CONFIG = 'Library/Application Support/Claude/claude_desktop_config.json';

/** The `aria-current` links of a page: what is lit must not depend on the language. */
const lit = (body: string): string[] => [...body.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*\baria-current="[^"]*"/g)].map((m) => m[1]!).sort();
const backHref = (body: string): string | null => /<p class="crumb back"><a href="([^"]*)"/.exec(body)?.[1] ?? null;

/** Runs `fn` with the pseudo-locale on: every t() string comes back as ⟦…⟧. */
function pseudo<T>(fn: () => T): T {
  enablePseudoLocale(true);
  try { return runWithLocale('xx', fn); } finally { enablePseudoLocale(false); }
}
/** The tools' names are product names. Their sign-in sentences are catalog keys (`tools.signIn.*`) and the screens say them through keys, so they are not fixtures. */
const toolFixtures = (states: ToolState[]): string[] => states.map((s) => s.name);

async function local(t: TestContext, o: { claudeApp?: boolean } = {}) {
  const f = fakeHome();
  t.after(() => f.cleanup());
  const statusDir = mkdtempSync(join(tmpdir(), 'i18n-setup-'));
  const app = await startTestApp({ localMode: true, noPassword: true, statusDir, tools: { home: f.home, path: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, apps: f.apps, system: {}, claudeConfig: join(f.home, CLAUDE_CONFIG) } });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const get = async (p: string, headers: Record<string, string> = {}) => (await fetch(app.baseUrl + p, { headers: { Cookie: cookie, ...headers } })).text();
  const post = (p: string, body: Record<string, string> = {}) => fetch(app.baseUrl + p, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded', ...ES }, body: new URLSearchParams(body) });
  return { app, f, get, post, cookie };
}

test('every setup page has an English and a Spanish text for each app (connect and where)', () => {
  const en = catalogOf('en'), es = catalogOf('es');
  for (const a of setupApps()) {
    for (const kind of ['connect', 'where'] as const) {
      const key = `setup.${kind}.${a.slug}`;
      assert.ok(en[key] !== undefined && es[key] !== undefined, key);
      // The English catalog says what the app's table says (NAME and ADDRESS are named parameters in the catalog).
      assert.equal(en[key], a[kind].replaceAll('NAME', '{name}').replaceAll('ADDRESS', '{address}'), key);
    }
  }
});

test('the welcome and Settings › Tools, rendered for real, have no English left (xx)', async (t) => {
  const { app, get, post } = await local(t);
  assert.equal((await post('/settings/tools/claude-code/connect')).status, 303);
  const env = toolEnv(app.deps)!;
  const allow = toolFixtures(await toolStates(env));
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try {
    for (const p of ['/welcome', '/welcome?restore=1', '/welcome?step=2', '/welcome?step=3', '/welcome?step=4', '/settings/tools', '/app/restart', '/app/update']) {
      assertNoEnglishLeft(await get(p), p, { allow });
    }
  } finally { enablePseudoLocale(false); }
});

test('in Spanish: the welcome and Settings › Tools read in Spanish, with the same lit tab and back link', async (t) => {
  const { app, get, post } = await local(t);
  assert.equal((await post('/settings/tools/claude-code/connect')).status, 303);
  const paths = ['/welcome', '/welcome?step=3', '/welcome?step=4', '/settings/tools'];
  const en: Record<string, string> = {};
  for (const p of paths) en[p] = await get(p, { 'Accept-Language': 'en-US' });
  app.deps.store.setSwitch('ui_language', 'es');
  const es: Record<string, string> = {};
  for (const p of paths) es[p] = await get(p);
  assert.match(es['/welcome']!, /<html lang="es">/);
  assert.match(es['/welcome']!, /Tu memoria está en marcha/);
  assert.match(es['/welcome']!, /Paso 1 de 4/);
  assert.match(es['/welcome']!, /<title>Te damos la bienvenida a BrainAI<\/title>/);
  assert.match(es['/welcome?step=3']!, /Conecta tus asistentes/);
  assert.match(es['/welcome?step=3']!, /Añadida · falta un paso:/);
  assert.match(es['/welcome?step=3']!, /Desconectar/);
  assert.match(es['/welcome?step=4']!, /Pruébalo/);
  assert.match(es['/welcome?step=4']!, /Guarda una nota en BrainAI diciendo que hoy lo he configurado\./);
  assert.match(es['/settings/tools']!, /<title>Herramientas en este Mac<\/title>/);
  assert.match(es['/settings/tools']!, /<h1>Herramientas en este Mac<\/h1>/);
  assert.match(es['/settings/tools']!, /Con cada herramienta de programación/);
  assert.match(es['/settings/tools']!, /‹ Ajustes<\/a>/);
  assert.doesNotMatch(es['/settings/tools']!, /Tools on|Connect adds|Disconnect/);
  for (const p of paths) {
    assert.deepEqual(lit(es[p]!), lit(en[p]!), `${p}: lit places differ`);
    assert.equal(backHref(es[p]!), backHref(en[p]!), `${p}: back link differs`);
  }
  // A result said once after Connect is in the owner's language too.
  const r = await post('/settings/tools/codex/connect');
  assert.match(await get(r.headers.get('location')!), /Añadida\. Falta un paso:/);
});

test('Settings › Search: the refusal pages have no English left (xx) and read in Spanish', async (t) => {
  const { app, cookie } = await local(t);
  // A stand-in for the model manager: the routes only look at it for the refusals below.
  (app.deps as unknown as { models: unknown }).models = { status: () => ({ choice: null, progress: [], searchReady: false }), installedIds: async () => [], choose: async () => {}, remove: () => {} };
  const send = (path: string, body: Record<string, string>, language: string) => fetch(app.baseUrl + path, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, text: await r.text(), language }));
  const cases: [string, Record<string, string>][] = [
    ['/settings/search/key', { key: 'not a key' }],
    ['/settings/search/models', { search: 'e5', rerank: 'online:voyageai/rerank-2.5' }],
    ['/settings/search/remove', { model: 'nope' }],
    ['/settings/search/load', { model: 'e5' }],
  ];
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try {
    for (const [path, body] of cases) {
      const r = await send(path, body, 'xx');
      assert.equal(r.status, 400, path);
      assertNoEnglishLeft(r.text, path);
    }
  } finally { enablePseudoLocale(false); }
  app.deps.store.setSwitch('ui_language', 'es');
  const key = await send('/settings/search/key', { key: 'not a key' }, 'es');
  assert.match(key.text, /<h1>Sin cambios<\/h1>/);
  assert.match(key.text, /Eso no parece una clave de OpenRouter/);
  assert.match(key.text, /Volver a Ajustes › Búsqueda/);
  assert.match(key.text, /‹ Ajustes<\/a>/);
  assert.match((await send('/settings/search/remove', { model: 'nope' }, 'es')).text, /Ese no es un modelo de BrainAI\./);
});

test('the setup page of an app (server mode and local mode) has no English left (xx)', async (t) => {
  const server = await startTestApp();
  t.after(() => server.close());
  const sf = await loggedIn(server);
  const sget = async (p: string) => (await sf(p)).text();
  const { app, get } = await local(t);
  server.deps.store.setSwitch('ui_language', 'xx');
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try {
    for (const a of setupApps()) assertNoEnglishLeft(await sget(`/settings/setup/${a.slug}`), `server ${a.slug}`);
    for (const a of setupApps()) assertNoEnglishLeft(await get(`/settings/setup/${a.slug}`), `local ${a.slug}`);
    assertNoEnglishLeft(await sget('/settings/setup/nothing'), 'unknown app');
  } finally { enablePseudoLocale(false); }
});

test('in Spanish: the setup page says its three steps, the check line and where the text goes', async (t) => {
  const server = await startTestApp();
  t.after(() => server.close());
  const sf = await loggedIn(server);
  const en = await (await sf('/settings/setup/claude-code', { headers: { 'Accept-Language': 'en-US' } })).text();
  server.deps.store.setSwitch('ui_language', 'es');
  const es = await (await sf('/settings/setup/claude-code')).text();
  assert.match(es, /<h1>Configurar Claude Code<\/h1>/);
  assert.match(es, /Tres pasos\./);
  assert.match(es, /<h2>Pegar el texto de configuración<\/h2>/);
  assert.match(es, /En una terminal: claude mcp add --transport http memory /);
  assert.match(es, /Todavía no hay ninguna conexión de Claude Code: haz primero el paso 1\./);
  assert.match(es, /‹ Ajustes<\/a>/);
  assert.match(es, /<em>carga mi perfil<\/em>/);
  assert.deepEqual(lit(es), lit(en));
  assert.equal(backHref(es), backHref(en));
  // The text people paste into assistants follows the language of the page.
  const pre = (h: string) => [...h.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => decodeEntities(m[1]!)).join('\n');
  assert.match(pre(es), /Tengo una memoria compartida, la memoria de BrainAI \(/);
  assert.match(pre(en), /I have a shared memory, the brain \(/);
  assert.match(pre(es), /pasa setup: \d+\./);
});

test('Reach, rendered for real, has no English left (xx) and reads in Spanish', async (t) => {
  const { app, get } = await local(t);
  const en = await get('/settings/reach', { 'Accept-Language': 'en-US' });
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try { assertNoEnglishLeft(await get('/settings/reach'), 'reach'); } finally { enablePseudoLocale(false); }
  app.deps.store.setSwitch('ui_language', 'es');
  const es = await get('/settings/reach');
  assert.match(es, /<h1>Acceso desde el móvil y la web<\/h1>/);
  assert.match(es, /<h2>Pon una contraseña<\/h2>/);
  assert.match(es, /Solo funciona mientras este Mac esté encendido y activo\./);
  assert.match(es, /‹ Ajustes<\/a>/);
  assert.deepEqual(lit(es), lit(en));
  assert.equal(backHref(es), backHref(en));
});

const grant = (o: Partial<GrantInfo>): GrantInfo => ({ id: 'g', clientId: 'c', clientName: 'Claude Code', createdAt: '2026-11-18T10:00:00Z', lastUsedAt: null, revokedAt: null, access: 'full', projects: [], setupVersion: null, setupSeenAt: null, toolNames: null, toolsSeenAt: null, savesWait: false, ...o });

test('the views: every state of the setup page and its check line has no English left (xx)', () => {
  const apps = setupApps();
  const claude = apps.find((a) => a.slug === 'claude')!, chatgpt = apps.find((a) => a.slug === 'chatgpt')!, codex = apps.find((a) => a.slug === 'codex')!, opencode = apps.find((a) => a.slug === 'opencode')!;
  const refused = [{ uri: 'https://elsewhere.example/cb', clientName: 'Odd client', at: '2026-11-18T10:00:00Z' }];
  const status = html``;
  const out = pseudo(() => [
    setupPage(claude, 'TEXT', 'http://x/mcp', status, SETUP_VERSION, { allowed: true, refused: [] }, { needsReach: true, signIn: 'password', local: true }),
    setupPage(codex, 'TEXT', 'http://x/mcp', status, SETUP_VERSION, { allowed: true, refused: [] }, { needsReach: true, signIn: 'password', local: true }),
    setupPage(codex, 'TEXT', 'http://x/mcp', status, SETUP_VERSION, { allowed: false, refused }, { needsReach: false, signIn: 'window', local: true }),
    setupPage(chatgpt, 'TEXT', 'http://x/mcp', status, SETUP_VERSION, { allowed: false, refused }, { needsReach: false, signIn: 'password' }),
    setupPage(chatgpt, 'TEXT', 'http://x/mcp', status, SETUP_VERSION, { allowed: true, refused: [] }, { needsReach: false, signIn: 'password' }),
    html`<p>${setupStatusLine(opencode, [], 1)}</p>`,
    html`<p>${setupStatusLine(codex, [], 1)}</p>`,
    html`<p>${setupStatusLine(codex, [grant({ clientName: 'Codex', setupVersion: null })], 3)}</p>`,
    html`<p>${setupStatusLine(codex, [grant({ clientName: 'Codex', setupVersion: 2, setupSeenAt: '2026-11-17T10:00:00Z' })], 3)}</p>`,
    html`<p>${setupStatusLine(codex, [grant({ clientName: 'Codex', setupVersion: 3, setupSeenAt: '2026-11-17T10:00:00Z' })], 3)}</p>`,
  ].map((b) => page('⟦x⟧', b, { nav: true, tab: null })));
  out.forEach((o, i) => assertNoEnglishLeft(o, `setup page ${i}`, { allow: ['Odd client', 'elsewhere.example', 'https://elsewhere.example/cb'] }));
});

test('the views: Reach in every state has no English left (xx)', () => {
  const cf = { installed: true, signedIn: false, signingIn: null as string | null };
  const out = pseudo(() => [
    reachPage({ said: null, hasPassword: false, hasAuthenticator: false, pending: null, reach: null }),
    reachPage({ said: 'Fixture said', hasPassword: true, hasAuthenticator: false, pending: null, reach: null }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: false, pending: { svg: '<svg></svg>', secret: 'ABCDEFGH' }, reach: null }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: null, via: 'tailscale', cloudflare: { ...cf, installed: false } }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: null, via: 'tailscale', cloudflare: cf }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: null, via: 'tailscale', cloudflare: { ...cf, signingIn: '' } }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: null, via: 'tailscale', cloudflare: { ...cf, signingIn: 'https://dash.cloudflare.com/x' } }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: null, via: 'tailscale', cloudflare: { ...cf, signedIn: true } }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ waiting: true, reason: 'Fixture reason', on: null, via: 'tailscale', cloudflare: cf }) }),
    reachPage({ said: null, hasPassword: true, hasAuthenticator: true, pending: null, reach: reachSwitch({ on: new URL('https://x.ts.net'), via: 'cloudflare', cloudflare: cf }) }),
    html`${tailscaleBox({ installed: true, running: true, host: 'mac.ts.net', timedOut: false })}${tailscaleBox({ installed: false, running: false, host: null, timedOut: false })}${tailscaleBox({ installed: true, running: false, host: null, timedOut: false })}${tailscaleBox({ installed: true, running: true, host: null, timedOut: true })}`,
  ].map((b) => page('⟦x⟧', raw(b.value), { nav: true, tab: null })));
  out.forEach((o, i) => assertNoEnglishLeft(o, `reach ${i}`, { allow: ['Fixture said', 'Fixture reason', 'ABCDEFGH', 'brew install cloudflared', 'brain.example.com'] }));
});

test('the views: the welcome steps, the tool lists, the search models and the update cards have no English left (xx)', () => {
  const tool = (o: Partial<ToolState>): ToolState => ({ id: 'claude-code', name: 'Claude Code', installed: true, state: 'not-connected', signIn: 'Fixture sign in hint', ...o });
  const tools: ToolState[] = [
    tool({}),
    tool({ id: 'codex', name: 'Codex', state: 'connected', signedIn: false, hooks: 'off' }),
    tool({ id: 'opencode', name: 'OpenCode', state: 'connected', signedIn: true, hooks: 'on' }),
    tool({ id: 'cursor', name: 'Cursor', state: 'connected', signedIn: true, hooks: 'none' }),
    tool({ id: 'gemini', name: 'Gemini CLI', state: 'other-brainai', detail: 'https://other.example/mcp' }),
    tool({ id: 'claude-desktop', name: 'Claude app fixture', state: 'connected', signedIn: true }),
    tool({ id: 'codex', name: 'Codex', installed: false }),
  ];
  const hardware = { arch: 'arm64' as const, platform: 'darwin' as NodeJS.Platform, memoryBytes: 16 * 1024 ** 3, freeDiskBytes: 100 * 1024 ** 3 };
  const base = { tools, windows: false, said: null, cursorRules: 'RULES' };
  const status = (o: Partial<ModelStatus>): ModelStatus => ({ choice: { search: 'gemma', rerank: 'mminilm' }, progress: [], searchReady: true, ...o });
  const online = { search: 'gemma' as const, rerank: 'online' as const, online: { model: 'voyageai/rerank-2.5' } };
  const allow: string[] = ['Fixture sign in hint', 'Claude app fixture', 'https://other.example/mcp', 'Voyage rerank 2.5', 'voyageai/rerank-2.5', 'Qwen3 Reranker 8B', 'qwen/qwen3-reranker-8b', 'Fixture note', 'Fixture refusal', 'Fixture reason', 'MIT', 'Apache-2.0'];
    const updates: UpdateFile[] = [
    { current: '1.0.0', version: '1.1.0', notes: '- Fixture note', state: 'available' },
    { current: '1.0.0', version: '1.1.0', notes: '', state: 'blocked', problem: 'Fixture reason' },
    { current: '1.0.0', version: '1.1.0', notes: '', state: 'failed', problem: 'Fixture reason' },
  ];
  const out = pseudo(() => [
    welcomePage({ ...base, step: 1, restore: 'offer' }),
    welcomePage({ ...base, step: 1, restore: 'choose' }),
    welcomePage({ ...base, step: 2 }),
    welcomePage({ ...base, step: 2, models: { hardware, installed: [] } }),
    welcomePage({ ...base, step: 2, models: { hardware: { ...hardware, arch: 'x64', memoryBytes: 4 * 1024 ** 3 }, installed: ['e5', 'mminilm'] } }),
    welcomePage({ ...base, step: 3, said: 'Fixture note', restored: { facts: 3, pages: 1, pictures_missing: 2 } }),
    welcomePage({ ...base, step: 3, restored: { refused: 'Fixture refusal' }, windows: true }),
    welcomePage({ ...base, step: 3, tools: tools.map((x) => ({ ...x, installed: false })) }),
    welcomePage({ ...base, step: 4 }),
    welcomePage({ ...base, step: 4, tools: tools.map((x) => ({ ...x, state: 'not-connected' as const })) }),
    toolsPage({ ...base }),
    toolsPage({ ...base, windows: true, said: 'Fixture note' }),
    firstLine({ memory: { by: 'Claude Code', content: 'Fixture note' }, suggestion: null }),
    firstLine({ memory: null, suggestion: { by: 'Claude Code', content: 'Fixture note' } }),
    firstLine({ memory: null, suggestion: null }),
    html`<p>${describeComputer(hardware)}</p>`,
    modelGroups({ search: 'gemma', rerank: 'online:voyageai/rerank-2.5', installed: ['gemma'], online: { keySaved: true } }),
    modelGroups({ search: 'e5', rerank: 'none', installed: [], online: { keySaved: false } }),
    searchSection({ status: status({}), installed: ['gemma', 'mminilm'], keySaved: false, said: 'Fixture note' }),
    searchSection({ status: status({ choice: { search: 'e5', rerank: null } }), installed: ['e5'], keySaved: true, said: null }),
    searchSection({ status: status({ choice: online, onlineProblem: 'Fixture reason' }), installed: ['gemma', 'mminilm'], keySaved: true, said: null }),
    searchSection({ status: status({ choice: null, searchReady: false }), installed: [], keySaved: false, said: null }),
    modelsLine(status({ checked: { ms: 42 } })),
    modelsLine(status({ rereading: true })),
    modelsLine(status({ progress: [{ model: 'gemma', doneBytes: 50, totalBytes: 100, state: 'downloading' } as never] }), { onlyWhenBusy: true }),
    modelsLine(status({ progress: [{ model: 'gemma', doneBytes: 0, totalBytes: 0, state: 'waiting' } as never], searchReady: false })),
    modelsLine(status({ problem: 'disk full', problemWith: 'search' })),
    modelsLine(status({ problem: 'disk full', problemWith: 'rerank' })),
    modelsLine(status({ problem: 'disk full', problemWith: 'check' })),
    modelsLine(status({ problem: 'disk full', searchReady: false, choice: null })),
    offsiteCard(),
    ...updates.map((u) => updateCard(u, null)),
  ].map((b) => page('⟦x⟧', typeof b === 'string' ? raw(b) : b, { nav: true, tab: null })));
  out.forEach((o, i) => assertNoEnglishLeft(o, `welcome/tools view ${i}`, { allow }));
});

test('model names and sentences are translated by key, in both languages', () => {
  for (const m of CATALOGUE) {
    assert.ok(catalogOf('en')[`setup.model.label.${m.label}`] === m.label, m.label);
    if (m.id !== 'bge-m3-rerank') assert.ok(catalogOf('en')[`setup.model.measured.${m.id}`] === m.measured, m.id);
  }
  const line = (lang: 'en' | 'es') => runWithLocale(lang, () => modelsProgress({ choice: { search: 'gemma', rerank: 'mminilm' }, progress: [], searchReady: true, checked: { ms: 42 } }).text);
  assert.equal(line('en'), 'Search is ready and working: a test search on this Mac took 42 ms.');
  assert.equal(line('es'), 'La búsqueda está lista y funciona: una búsqueda de prueba en este Mac tardó 42 ms.');
});

test('what another BrainAI points at (the "other brain" detail) is worded by key on screens, with the English detail unchanged', () => {
  const s: Pick<ToolState, 'detail' | 'detailSay'> = { detail: 'its brainai server points at other.example:8443', detailSay: { key: 'tools.detail.points', params: { host: 'other.example:8443' } } };
  assert.equal(detailText(s), 'its brainai server points at other.example:8443');
  assert.equal(runWithLocale('es', () => detailText(s)), 'su servidor brainai apunta a other.example:8443');
  assert.equal(runWithLocale('es', () => detailText({ detail: 'a command' })), 'a command', 'a detail without a key shows as stored');
  assert.match(pseudo(() => detailText(s)), /^⟦.*⟧$/);
});
