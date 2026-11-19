import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession, connectClient, loggedIn, startTestApp } from '../testing/helpers.js';
import { primeSideStatus, setSideStatus } from './sideStatus.js';
import { enablePseudoLocale, runWithLocale, t } from '../i18n/core.js';
import { html, page } from './html.js';
import { backFrom, backLabel } from './back.js';
import { isMachinePath } from './locale.js';
import { MemoryError } from '../memory/service.js';
import { backupProblems, errorText, reasonText } from './errorText.js';
import { untranslatedText } from '../testing/noEnglish.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const SPANISH_WORDS = /\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|abr|ago|sept|dic|lun|mar|mi[eé]|jue|vie|s[aá]b|dom)\b/i;

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const setLanguage = (f: (p: string, i?: RequestInit) => Promise<Response>, language: string) =>
  f('/settings/language', { method: 'POST', body: new URLSearchParams({ language }) });

async function rpc(baseUrl: string, token: string, headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  const json = body.startsWith('{') ? JSON.parse(body) : JSON.parse(/^data: (.*)$/m.exec(body)![1]!);
  return json.result.content.map((c: { text: string }) => c.text).join('\n');
}

test('MCP answers stay English whatever the owner chose and the client asked for', async (tc) => {
  // The first fact is 30 days old, so the last finished week has a review to build (the token needs the real clock, so no startAt).
  const { app, f } = await start(tc);
  await app.deps.service.remember({ kind: 'decision', content: 'wildlog keeps labels on the phone', project: 'wildlog' }, { type: 'owner' });
  app.deps.db!.prepare('UPDATE memories SET created_at = ?').run(new Date(Date.now() - 30 * 86_400_000).toISOString());
  const { accessToken } = await connectClient(app.baseUrl, f);
  await setLanguage(f, 'es');
  const last = await rpc(app.baseUrl, accessToken, ES, 'weekly_review', {});
  assert.match(last, /^The weekly review for .*built (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d:\d\d/, last.slice(0, 300));
  const now = await rpc(app.baseUrl, accessToken, ES, 'weekly_review', { week: 'now' });
  for (const text of [last, now]) assert.doesNotMatch(text, SPANISH_WORDS, text.slice(0, 400));
  // The dashboard, in the same session, is Spanish.
  assert.match(await (await f('/review', { headers: ES })).text(), /<html lang="es">/);
});

test('machine paths are English; /authorize and the dashboard follow the owner', () => {
  for (const p of ['/app/removed/ready', '/app/open', '/api/image-upload', '/mcp', '/token', '/register', '/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/app/ticket', '/app/hello', '/app/bridge-hello', '/app/backup-now', '/api/skills/report', '/static/app.js', '/images/x', '/sw.js']) {
    assert.equal(isMachinePath(p), true, p);
  }
  for (const p of ['/authorize', '/consent/abc', '/settings', '/login', '/app/restart', '/models/progress', '/mcpish', '/tokens', '/']) assert.equal(isMachinePath(p), false, p);
});

test('the OAuth endpoints answer in English under a Spanish owner choice, the consent page in Spanish', async (tc) => {
  const { app, f } = await start(tc);
  await setLanguage(f, 'es');
  const bad = await fetch(app.baseUrl + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...ES }, body: 'grant_type=authorization_code' });
  assert.equal(bad.status >= 400, true);
  assert.doesNotMatch(await bad.text(), /[áéíóúñ]/i);
  const reg = await fetch(app.baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...ES }, body: '{}' });
  assert.doesNotMatch(await reg.text(), /[áéíóúñ]/i);
  const meta = await fetch(app.baseUrl + '/.well-known/oauth-authorization-server', { headers: ES });
  assert.equal(meta.status, 200);
  // The dashboard around them is Spanish.
  assert.match(await (await f('/settings', { headers: ES })).text(), /<html lang="es">/);
});

test('BRAINAI_SYSTEM_LOCALE: in local mode Automatic uses it before Accept-Language; a stored choice and a server ignore it', async (tc) => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-sys-'));
  tc.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: dir });
  tc.after(() => app.close());
  const cookie = await appSession(app);
  const get = async (headers: Record<string, string> = {}) => (await (await fetch(app.baseUrl + '/settings', { headers: { Cookie: cookie, ...headers } })).text()).match(/<html lang="(\w+)">/)![1];
  const EN = { 'Accept-Language': 'en-US,en;q=0.9' };
  try {
    process.env.BRAINAI_SYSTEM_LOCALE = 'es-ES';
    assert.equal(await get(EN), 'es', 'the WebView said en-US on a Spanish Mac');
    process.env.BRAINAI_SYSTEM_LOCALE = 'es_ES';
    assert.equal(await get(EN), 'es', 'POSIX spelling');
    process.env.BRAINAI_SYSTEM_LOCALE = 'fr-FR';
    assert.equal(await get(ES), 'es', 'a language we lack falls back to the header');
    assert.equal(await get(EN), 'en');
    process.env.BRAINAI_SYSTEM_LOCALE = 'en-US';
    assert.equal(await get(ES), 'en');
    process.env.BRAINAI_SYSTEM_LOCALE = 'es-ES';
    app.deps.store.setSwitch('ui_language', 'en');
    assert.equal(await get(), 'en', 'the owner chose English');
  } finally { delete process.env.BRAINAI_SYSTEM_LOCALE; }

  const server = await startTestApp();
  tc.after(() => server.close());
  const f = await loggedIn(server);
  try {
    process.env.BRAINAI_SYSTEM_LOCALE = 'es-ES';
    assert.match(await (await f('/settings', { headers: { 'Accept-Language': 'en-US' } })).text(), /<html lang="en">/);
  } finally { delete process.env.BRAINAI_SYSTEM_LOCALE; }
});

test('ui-language.json is written once at start from the stored switch, with a unique temporary name', async (tc) => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-start-'));
  tc.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: dir });
  tc.after(() => app.close());
  const file = JSON.parse(readFileSync(join(dir, 'ui-language.json'), 'utf8'));
  assert.equal(file.language, 'auto');
  const cookie = await appSession(app);
  for (const language of ['es', 'en']) {
    await fetch(app.baseUrl + '/settings/language', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl }, body: new URLSearchParams({ language }) });
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'ui-language.json'), 'utf8')).language, 'en');
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'no temporary file is left');
  const src = readFileSync(new URL('../i18n/uiLanguage.ts', import.meta.url), 'utf8');
  assert.match(src, /randomBytes/, 'the temporary name is unique');
});

/** The `aria-current` links of a page, as href lists: what is lit must not depend on the language. */
const lit = (body: string): string[] => [...body.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*\baria-current="[^"]*"/g)].map((m) => m[1]!).sort();

test('which tab, side place and back link a page has does not depend on its language', async (tc) => {
  const { app, f } = await start(tc);
  const m = (await app.deps.service.remember({ kind: 'decision', content: 'wildlog keeps labels on the phone', project: 'wildlog' }, { type: 'owner' }) as { memory: { id: string } }).memory;
  const paths = ['/settings', '/facts', `/memories/${m.id}`, `/memories/${m.id}?from=%2Ffacts%3Fkind%3Ddecision`, '/memories/00000000-0000-0000-0000-000000000000', '/memories/new', '/approvals', '/pages'];
  for (const p of paths) {
    await setLanguage(f, 'en');
    const en = await (await f(p)).text();
    await setLanguage(f, 'es');
    const es = await (await f(p)).text();
    assert.deepEqual(lit(es), lit(en), `${p}: lit places differ`);
    assert.equal(/class="crumb back"/.test(es), /class="crumb back"/.test(en), `${p}: crumb differs`);
    assert.equal(/class="top-back"/.test(es), /class="top-back"/.test(en), `${p}: top back differs`);
  }
  await setLanguage(f, 'es');
  const es = await (await f(`/memories/${m.id}?from=%2Ffacts%3Fkind%3Ddecision`)).text();
  assert.match(es, /<p class="crumb back"><a href="\/facts\?kind=decision">‹ Datos<\/a><\/p>/);
});

test('back labels: a key is translated when the page is rendered, a record name is left alone', () => {
  const look = { pageTitle: () => 'Mi página', projectName: (n: string) => n, discussionTitle: () => 'x' };
  const facts = backFrom('/facts', look)!;
  assert.equal(runWithLocale('es', () => backLabel(facts)), 'Datos');
  assert.equal(backLabel(facts), 'Facts');
  const week = backFrom('/review/2026-10-26', look)!;
  assert.equal(backLabel(week), 'Week of 26 Oct');
  assert.equal(runWithLocale('es', () => backLabel(week)), 'Semana del 26 oct');
  const proj = backFrom('/?project=wildlog', look)!;
  assert.equal(runWithLocale('es', () => backLabel(proj)), 'wildlog');
  const pg = backFrom('/pages/11111111-2222-3333-4444-555555555555', look)!;
  assert.equal(runWithLocale('es', () => backLabel(pg)), 'Mi página');
});

test('the palette rows are keys with Spanish text, none left in English', async (tc) => {
  const { f } = await start(tc);
  await setLanguage(f, 'es');
  const b = await (await f('/settings')).text();
  const rows: { label: string; href: string }[] = JSON.parse(/data-goto="([^"]*)"/.exec(b)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.ok(rows.length >= 8);
  for (const r of rows) assert.doesNotMatch(r.label, /\b(Skills|Import|Discussions|Settings|Tidy up|Backups|Save a copy)\b/, r.label);
  assert.ok(rows.some((r) => r.label === 'Habilidades'));
  assert.ok(rows.some((r) => r.label === 'Ajustes › Copias de seguridad'));
});

test('the waiting count reads "1 pendiente" and "2 pendientes" in Spanish (aria-label)', () => {
  const label = (n: number, lang: 'en' | 'es') => {
    primeSideStatus(n);
    const out = runWithLocale(lang, () => page('x', html``, { nav: true, tab: 'projects' }));
    return [...out.matchAll(/class="(?:tab|side)-count" aria-label="([^"]*)"/g)].map((m) => m[1]);
  };
  try {
    assert.deepEqual(label(1, 'es'), ['1 pendiente', '1 pendiente']);
    assert.deepEqual(label(2, 'es'), ['2 pendientes', '2 pendientes']);
    assert.deepEqual(label(1, 'en'), ['1 waiting', '1 waiting']);
  } finally { primeSideStatus(0); setSideStatus(null); }
});

test('the page embeds one JSON data block with every client key, and static/i18n.js defines T before app.js', () => {
  const out = page('x', html``, { nav: true });
  assert.equal([...out.matchAll(/<script type="application\/json" id="i18n">/g)].length, 1);
  assert.ok(out.indexOf('/static/i18n.js') > 0 && out.indexOf('/static/i18n.js') < out.indexOf('/static/app.js'));
  const plain = page('x', html``);
  assert.match(plain, /id="i18n"/, 'the login and small pages carry it too');
  const js = readFileSync(new URL('./static/i18n.js', import.meta.url), 'utf8');
  const doc = { getElementById: () => ({ textContent: '{"lang":"es","t":{"a.b":"Hola"}}' }) };
  const g: Record<string, unknown> = {};
  new Function('document', 'globalThis', js)(doc, g);
  const T = g.T as (k: string, e?: string) => string;
  assert.equal(T('a.b', 'Hello'), 'Hola');
  assert.equal(T('x.y', 'Fallback'), 'Fallback');
  assert.equal(T('x.y'), 'x.y');
  for (const f of ['viewer.js', 'diagrams.js', 'editor-cm.js', 'editor-pics.js', 'graph3d.js', 'desk.js']) {
    const src = readFileSync(new URL(`./static/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /document\.getElementById\('i18n'\)/, `${f} reads T() from static/i18n.js, not the block itself`);
  }
});

test('errorText: a MemoryError with a key shows it in the language, anything else its English message', () => {
  const e = new MemoryError('secret_detected', 'This looks like a secret (an API key). Secrets are never stored in memory.', undefined, { key: 'err.secret', params: { reason: 'an API key' } });
  assert.equal(e.message, 'This looks like a secret (an API key). Secrets are never stored in memory.');
  assert.equal(errorText(e), e.message);
  assert.equal(runWithLocale('es', () => errorText(e)), 'Esto parece un secreto (an API key). Los secretos nunca se guardan en la memoria.');
  assert.equal(runWithLocale('es', () => errorText(new MemoryError('invalid', 'plain'))), 'plain');
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('str'), 'str');
});

// Built at run time so the publish gate's secret scan does not flag the test itself.
const FAKE_SECRET = 'password: ' + 'AKIA' + 'IOSFODNN7EXAMPLE secret_access_key=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

test('a fact form with a secret shows the Spanish error to a Spanish owner and keeps MCP English', async (tc) => {
  const { app, f } = await start(tc);
  await setLanguage(f, 'es');
  const res = await f('/memories', { method: 'POST', body: new URLSearchParams({ kind: 'decision', content: FAKE_SECRET, project: 'x', tags: '' }) });
  const body = await res.text();
  assert.equal(res.status, 400, body.slice(0, 200));
  assert.match(body, /Esto parece un secreto/);
  const { accessToken } = await connectClient(app.baseUrl, f);
  const english = await rpc(app.baseUrl, accessToken, ES, 'remember', { kind: 'decision', content: FAKE_SECRET, project: 'x' }).catch((e: Error) => e.message);
  assert.doesNotMatch(english, /Esto parece/);
});

test('the checker sees what a page leaves in English under the pseudo-locale', () => {
  enablePseudoLocale(true);
  try {
    const out = runWithLocale('xx', () => page(t('shell.nav.projects'), html`<p>${t('shell.nav.inbox')}</p><p>Untranslated words</p>`));
    assert.deepEqual(untranslatedText(out), ['Untranslated words']);
  } finally { enablePseudoLocale(false); }
});

test('no app file outside src/i18n reads a page title to choose a tab (dashboardRoutes and html.ts)', () => {
  for (const f of ['dashboardRoutes.ts', 'html.ts']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /title === '/, `${f} compares a title`);
  }
  assert.equal(existsSync(new URL('./static/i18n.js', import.meta.url)), true);
});

test('a refusal\'s secret or instruction reason and a stored date are worded in the screen language, never spliced in English', () => {
  const secret = new MemoryError('secret_detected', 'This looks like a secret (API key). Secrets are never stored in memory.', undefined, { key: 'err.secret', params: { reason: 'API key' } });
  assert.equal(errorText(secret), 'This looks like a secret (API key). Secrets are never stored in memory.');
  assert.equal(runWithLocale('es', () => errorText(secret)), 'Esto parece un secreto (clave de API). Los secretos nunca se guardan en la memoria.');
  const instr = new MemoryError('invalid', 'x', undefined, { key: 'err.secret', params: { reason: 'runs a downloaded script' } });
  assert.match(runWithLocale('es', () => errorText(instr)), /\(ejecuta un script descargado\)/);
  assert.equal(secret.message.includes('API key'), true, 'the English message (MCP) is unchanged');
  assert.equal(runWithLocale('es', () => reasonText('is close to a fact you deleted on 2 Nov 2026')), 'se parece a un dato que borraste el 2 nov 2026');
  assert.equal(reasonText('is close to a fact you deleted on 2 Nov 2026'), 'is close to a fact you deleted on 2 Nov 2026');
});

test('a backup copy problem words its result (skipped, failed) in the screen language, not inside quotes in English', () => {
  const h = { problems: ['x'], say: [{ key: 'backup.p.copy' as const, params: { where: '/mnt/nas', result: 'skipped', detail: ': not mounted' } }] };
  assert.equal(backupProblems(h)[0], 'The nightly copy to /mnt/nas was skipped: not mounted.');
  assert.equal(runWithLocale('es', () => backupProblems(h)[0]), 'La copia nocturna a /mnt/nas se omitió: not mounted.');
});

test('limits travel as numbers and the screen groups the digits in its language (100,000 / 100.000)', () => {
  const e = new MemoryError('invalid', 'The reply must be 1 to 100,000 characters.', undefined, { key: 'err.disc.len.reply', params: { max: 100000 } });
  assert.equal(errorText(e), 'The reply must be 1 to 100,000 characters.');
  assert.equal(runWithLocale('es', () => errorText(e)), 'La respuesta debe tener de 1 a 100.000 caracteres.');
});

test('catalog text is never put through raw(): the html tag escapes it', () => {
  const dir = new URL('.', import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /raw\(`[^`]*\$\{t(Key|Html)?\(/, `${name} builds raw HTML around t()`);
  }
});
