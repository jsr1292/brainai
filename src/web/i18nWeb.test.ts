import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { assertNoEnglishLeft, untranslatedText } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale, t } from '../i18n/core.js';
import { html, page } from './html.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const EN = { 'Accept-Language': 'en-US,en;q=0.9' };

async function start(t: TestContext) {
  const app = await startTestApp();
  t.after(() => app.close());
  return { app, f: await loggedIn(app) };
}
const post = (f: (p: string, i?: RequestInit) => Promise<Response>, language: string) =>
  f('/settings/language', { method: 'POST', body: new URLSearchParams({ language }) });

test('English output of the page shell is unchanged', () => {
  const out = page('Projects', html``, { nav: true, tab: 'projects' });
  assert.match(out, /<html lang="en">/);
  assert.match(out, /<nav class="tabs" aria-label="Main"><a href="\/" aria-current="page">Projects<\/a><a href="\/pages">Pages<\/a><a href="\/approvals">Inbox<\/a><a href="\/review">Week<\/a><\/nav>/);
  assert.match(out, /placeholder="Search the brain" aria-label="Search" aria-keyshortcuts="Meta\+K Control\+K" title="Search \(Ctrl K or ⌘K\)"/);
  assert.match(out, /<button type="button" class="find-cancel">Cancel<\/button>/);
  assert.match(out, /<a href="\/review\/now#latest">Latest changes<\/a><a href="\/facts">All facts<\/a><p>Or type: projects, facts and page sections\.<\/p>/);
  assert.match(out, /<nav class="side" hidden aria-label="Main">/);
  assert.match(out, /<a class="side-place side-settings" href="\/settings">Settings<\/a>/);
  assert.match(out, /<a class="side-sub" href="\/review\/now">So far<\/a>/);
});

test('the page shell has no English left outside the catalog', () => {
  enablePseudoLocale(true);
  try {
    runWithLocale('xx', () => {
      for (const o of [{ nav: true, tab: 'projects' as const }, { nav: true, tab: 'week' as const, section: 'now' as const }, {}]) {
        const out = page(t('shell.nav.projects'), html`<h1>${t('shell.nav.pages')}</h1>`, o);
        assertNoEnglishLeft(out, `page shell ${JSON.stringify(o)}`);
        if (o.nav) assert.match(out, /⟦Search the brain⟧/);
      }
    });
  } finally { enablePseudoLocale(false); }
});

test('the checker finds text outside ⟦…⟧ and ignores code, scripts, brands, numbers and punctuation', () => {
  const left = untranslatedText('<p>⟦Hello⟧ world</p><code>npm install</code><script>var x = "english";</script><p>BrainAI · 12 — ✓</p><input placeholder="Type here" aria-label="⟦Ok⟧"><p>⟦a⟧ ⟦b⟧</p>');
  assert.deepEqual(left.sort(), ['Type here', '⟦Hello⟧ world']);
});

test('the browser texts ride along as a JSON block and the page reads it in the right language', () => {
  const en = page('x', html``, { nav: true });
  assert.match(en, /<script type="application\/json" id="i18n">\{"lang":"en","t":\{"copy\.done":"Copied"/);
  const es = runWithLocale('es', () => page('x', html``, { nav: true }));
  assert.match(es, /<html lang="es">/);
  assert.match(es, /"copy\.done":"Copiado"/);
});

test('the language follows Accept-Language when the choice is Automatic, on every page including the login', async (t) => {
  const { app, f } = await start(t);
  const asEs = await (await f('/settings', { headers: ES })).text();
  assert.match(asEs, /<html lang="es">/);
  assert.match(asEs, />Proyectos<\/a>/);
  assert.match(asEs, /placeholder="Buscar en tu memoria"/);
  const asEn = await (await f('/settings', { headers: EN })).text();
  assert.match(asEn, /<html lang="en">/);
  assert.match(asEn, />Projects<\/a>/);
  const none = await (await f('/settings')).text();
  assert.match(none, /<html lang="en">/);
  const login = await (await fetch(app.baseUrl + '/login', { headers: ES })).text();
  assert.match(login, /<html lang="es">/);
});

test('the Settings choice overrides the header, and Automatic gives control back to it', async (t) => {
  const { app, f } = await start(t);
  const r = await post(f, 'en');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/settings#language');
  assert.equal(app.deps.store.switchValue('ui_language'), 'en');
  assert.match(await (await f('/settings', { headers: ES })).text(), /<html lang="en">/);
  await post(f, 'es');
  const es = await (await f('/settings', { headers: EN })).text();
  assert.match(es, /<html lang="es">/);
  assert.match(es, /<h2>Idioma<\/h2>/);
  await post(f, 'auto');
  assert.equal(app.deps.store.switchValue('ui_language'), 'auto');
  assert.match(await (await f('/settings', { headers: ES })).text(), /<html lang="es">/);
  assert.match(await (await f('/settings', { headers: EN })).text(), /<html lang="en">/);
});

test('Settings › Language: its own labels are translated, the two language names are always in their own language', async (t) => {
  const { f } = await start(t);
  const panel = async (h: Record<string, string>) => {
    const b = await (await f('/settings', { headers: h })).text();
    return b.slice(b.indexOf('<section id="language"'), b.indexOf('</section>', b.indexOf('<section id="language"')));
  };
  const en = await panel(EN), es = await panel(ES);
  assert.match(en, /<h2>Language<\/h2>/);
  assert.match(en, /> Automatic<span class="sub"> · Follows your browser/);
  assert.match(es, /<h2>Idioma<\/h2>/);
  assert.match(es, /> Automático<span class="sub"> · Sigue el idioma de tu navegador/);
  for (const p of [en, es]) {
    assert.match(p, /value="en"> English<\/label>/);
    assert.match(p, /value="es"> Español<\/label>/);
    assert.match(p, /<input type="radio" name="language" value="auto" checked>/);
  }
  assert.match(es, /<button type="submit" class="secondary">Guardar<\/button>/);
  await post(f, 'es');
  const b = await (await f('/settings', { headers: EN })).text();
  assert.match(b, /<input type="radio" name="language" value="es" checked>/);
  assert.match(b, /<a class="row" href="#language"><span class="txt">Idioma<\/span><span class="st">Español<\/span>/);
  assert.match(b, /<nav class="settings-nav"[^>]*>[\s\S]*<a href="#language">Idioma<\/a>/);
});

test('the language POST: three values only, and nothing is stored without a session', async (t) => {
  const { app, f } = await start(t);
  assert.equal((await post(f, 'fr')).status, 400);
  assert.equal((await post(f, 'xx')).status, 400);
  assert.equal(app.deps.store.switchValue('ui_language'), null);
  const anon = await fetch(app.baseUrl + '/settings/language', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ language: 'es' }) });
  assert.notEqual(anon.status, 303);
  assert.equal(app.deps.store.switchValue('ui_language'), null);
});

test('a foreign Origin is refused and stores nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-origin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: dir });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const send = (origin: string) => fetch(app.baseUrl + '/settings/language', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin }, body: new URLSearchParams({ language: 'es' }) });
  assert.equal((await send('https://evil.example')).status, 403);
  assert.equal(app.deps.store.switchValue('ui_language'), null);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ui-language.json'), 'utf8')).language, 'auto', 'written once at start, unchanged by the refused request');
  assert.equal((await send(app.baseUrl)).status, 303);
  assert.equal(app.deps.store.switchValue('ui_language'), 'es');
});

test('local mode writes the choice where the desktop shell reads it; a server writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startTestApp({ localMode: true, statusDir: dir });
  t.after(() => app.close());
  const cookie = await appSession(app);
  const send = (language: string) => fetch(app.baseUrl + '/settings/language', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl }, body: new URLSearchParams({ language }) });
  await send('es');
  const read = () => JSON.parse(readFileSync(join(dir, 'ui-language.json'), 'utf8'));
  assert.equal(read().language, 'es');
  assert.match(read().updatedAt, /^\d{4}-\d\d-\d\dT/);
  await send('auto');
  assert.equal(read().language, 'auto');

  const sdir = mkdtempSync(join(tmpdir(), 'i18n-server-'));
  t.after(() => rmSync(sdir, { recursive: true, force: true }));
  const server = await startTestApp({ statusDir: sdir });
  t.after(() => server.close());
  const f = await loggedIn(server);
  await post(f, 'es');
  assert.equal(existsSync(join(sdir, 'ui-language.json')), false);
});

test('the palette lists Settings › Language in the page language', async (t) => {
  const { f } = await start(t);
  const goto = async (h: Record<string, string>) => {
    const b = await (await f('/settings', { headers: h })).text();
    return JSON.parse(/data-goto="([^"]*)"/.exec(b)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')).map((x: { label: string }) => x.label);
  };
  assert.ok((await goto(EN)).includes('Settings › Language'));
  assert.ok((await goto(ES)).includes('Ajustes › Idioma'));
});

test('the core error pages (404, CSRF 403, 400, 413) are translated: no English under xx, Spanish under es', async (t) => {
  const { app, f } = await start(t);
  const big = new URLSearchParams({ title: 'x', body: 'a'.repeat(1_100_000) }).toString();
  const cases: { name: string; status: number; run: (h: Record<string, string>) => Promise<Response>; es: RegExp }[] = [
    { name: '404', status: 404, run: (h) => f('/nope', { headers: h }), es: /No encontrado/ },
    { name: 'CSRF 403', status: 403, run: (h) => fetch(app.baseUrl + '/settings/language', { method: 'POST', headers: { Origin: 'https://evil.example', ...h }, body: new URLSearchParams({ language: 'en' }) }), es: /Prohibido[\s\S]*no se envió desde este sitio/ },
    { name: '413', status: 413, run: (h) => f('/pages', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...h }, body: big }), es: /Demasiado largo para guardar[\s\S]*100\.000 caracteres/ },
    { name: '400', status: 400, run: (h) => f('/pages/x/diagram-checks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{bad' }), es: /Solicitud no válida/ },
  ];
  for (const c of cases) {
    const en = await c.run(EN);
    assert.equal(en.status, c.status, c.name);
    const es = await c.run(ES);
    assert.equal(es.status, c.status, c.name);
    assert.match(await es.text(), c.es, c.name);
  }
  assert.match(await (await cases[2]!.run(EN)).text(), /100,000 characters/);
  // 400 (malformed JSON body on a page route) and 500 go through errorHandler: same keys.
  app.deps.store.setSwitch('ui_language', 'xx');
  enablePseudoLocale(true);
  try {
    for (const c of cases) assertNoEnglishLeft(await (await c.run({})).text(), c.name);
  } finally { enablePseudoLocale(false); }
});
