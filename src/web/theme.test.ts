import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { html, page } from './html.js';
import { runWithTheme, themeFromCookie } from './theme.js';
import { parse } from '../testing/css.js';

const ES = { 'Accept-Language': 'es-ES,es;q=0.9' };
const root = (out: string) => out.match(/<html [^>]*>/)![0];
const bars = (out: string) => [...out.matchAll(/<meta name="theme-color"[^>]*>/g)].map((m) => m[0]);

test('the theme cookie: light and dark are read, anything else is Automatic', () => {
  assert.equal(themeFromCookie('theme=dark'), 'dark');
  assert.equal(themeFromCookie('a=b; theme=light; c=d'), 'light');
  for (const junk of [undefined, '', 'theme=', 'theme=auto', 'theme=purple', 'theme=DARK', 'mytheme=dark', 'x=theme=dark']) assert.equal(themeFromCookie(junk), null, String(junk));
});

test('page(): Automatic has no data-theme and both bar colours; a forced theme has its attribute and one bar colour', () => {
  const auto = page('t', html``);
  assert.equal(root(auto), '<html lang="en">');
  assert.deepEqual(bars(auto), ['<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">', '<meta name="theme-color" content="#0f1320" media="(prefers-color-scheme: dark)">']);
  const dark = runWithTheme('dark', () => page('t', html``));
  assert.equal(root(dark), '<html lang="en" data-theme="dark">');
  assert.deepEqual(bars(dark), ['<meta name="theme-color" content="#0f1320">']);
  const light = runWithTheme('light', () => page('t', html``, { nav: true }));
  assert.equal(root(light), '<html lang="en" data-theme="light">');
  assert.deepEqual(bars(light), ['<meta name="theme-color" content="#faf9f6">']);
});

test('every page of the app follows the cookie: dashboard, sign-in and error pages; junk means Automatic', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const get = (path: string, theme?: string) => fetch(app.baseUrl + path, { headers: theme === undefined ? {} : { Cookie: `theme=${theme}` } }).then((r) => r.text());
  for (const [theme, attr] of [['dark', ' data-theme="dark"'], ['light', ' data-theme="light"'], ['purple', ''], [undefined, '']] as const) {
    assert.equal(root(await get('/login', theme)).includes('data-theme'), attr !== '', `login ${theme}`);
    assert.match(root(await get('/no-such-page', theme)), attr ? new RegExp(attr) : /^<html lang="en">$/, `404 ${theme}`);
  }
  const home = await (await f('/', { headers: { Cookie: 'theme=dark' } })).text();
  assert.match(root(home), /data-theme="dark"/);
});

test('POST /settings/theme sets the cookie for a year and goes back to #appearance; Automatic clears it', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const session = await appSession(app);
  const send = (body: Record<string, string>, cookie = session) => fetch(app.baseUrl + '/settings/theme', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl }, body: new URLSearchParams(body) });
  const dark = await send({ theme: 'dark' });
  assert.equal(dark.status, 303);
  assert.equal(dark.headers.get('location'), '/settings#appearance');
  const set = dark.headers.get('set-cookie')!;
  assert.match(set, /^theme=dark; /);
  assert.match(set, /Path=\//); assert.match(set, /SameSite=Lax/); assert.match(set, /Max-Age=31536000/);
  assert.match(((await send({ theme: 'light' })).headers.get('set-cookie')!), /^theme=light; /);
  const auto = (await send({ theme: 'auto' })).headers.get('set-cookie')!;
  assert.match(auto, /^theme=; /); assert.match(auto, /Expires=Thu, 01 Jan 1970/);
  assert.equal((await send({ theme: 'purple' })).status, 400);
  assert.equal((await send({})).status, 400);
  // The same address in the browser, with and without the choice, shows the new look at once.
  const page = await (await fetch(app.baseUrl + '/settings', { headers: { Cookie: `${session}; theme=dark` } })).text();
  assert.match(root(page), /data-theme="dark"/);
});

test('POST /settings/theme needs the owner and the same origin', async (t) => {
  const app = await startTestApp({ localMode: true });
  t.after(() => app.close());
  const session = await appSession(app);
  const anon = await fetch(app.baseUrl + '/settings/theme', { method: 'POST', redirect: 'manual', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ theme: 'dark' }) });
  assert.ok(!anon.headers.get('set-cookie'));
  assert.notEqual(anon.headers.get('location'), '/settings#appearance');
  const cross = await fetch(app.baseUrl + '/settings/theme', { method: 'POST', redirect: 'manual', headers: { Cookie: session, Origin: 'https://evil.example' }, body: new URLSearchParams({ theme: 'dark' }) });
  assert.equal(cross.status, 403);
  assert.ok(!cross.headers.get('set-cookie'));
});

test('Settings › Appearance: three choices in both languages, the current one checked, between Language and Developer coaching', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const en = await (await f('/settings')).text();
  const sec = en.slice(en.indexOf('<section id="appearance"'), en.indexOf('</section>', en.indexOf('<section id="appearance"')));
  assert.match(sec, /<h2>Appearance<\/h2>/);
  assert.match(sec, /Automatic follows your computer&#39;s setting\./);
  assert.match(sec, /action="\/settings\/theme"/);
  assert.deepEqual([...sec.matchAll(/<input type="radio" name="theme" value="(\w+)"( checked)?> (\w+)/g)].map((m) => [m[1], !!m[2], m[3]]), [['auto', true, 'Automatic'], ['light', false, 'Light'], ['dark', false, 'Dark']]);
  assert.ok(en.indexOf('id="language"') < en.indexOf('id="appearance"') && en.indexOf('id="appearance"') < en.indexOf('id="coaching"'));
  assert.match(en, /<a class="row" href="#appearance"><span class="txt">Appearance<\/span><span class="st"><span data-theme-status>Automatic<\/span>/);
  const es = await (await f('/settings', { headers: { ...ES, Cookie: 'theme=dark' } })).text();
  const ses = es.slice(es.indexOf('<section id="appearance"'), es.indexOf('</section>', es.indexOf('<section id="appearance"')));
  assert.match(ses, /<h2>Apariencia<\/h2>/);
  assert.match(ses, /Automático sigue el ajuste de tu ordenador\./);
  assert.deepEqual([...ses.matchAll(/<input type="radio" name="theme" value="(\w+)"( checked)?> (\p{L}+)/gu)].map((m) => [m[1], !!m[2], m[3]]), [['auto', false, 'Automático'], ['light', false, 'Claro'], ['dark', true, 'Oscuro']]);
  assert.match(es, /<span data-theme-status>Oscuro<\/span>/);
});

test('the go-to palette lists Appearance', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const body = await (await f('/')).text();
  assert.match(body, /Settings › Appearance/);
  const es = await (await f('/', { headers: ES })).text();
  assert.match(es, /Ajustes › Apariencia/);
});

test('style.css: the dark tokens are written for Automatic-on-a-dark-system and for forced Dark, with identical bodies; Light wins over a dark system', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  const body = (head: string) => {
    const at = css.indexOf(head);
    assert.ok(at >= 0, head);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', css.indexOf('{', at)) ).replace(/^\s*color-scheme: dark;\n/, '').replace(/\n  \}\s*$/, '').replace(/^\n/, '').split('\n').map((l) => l.trim()).join('\n');
  };
  assert.equal(body(':root:not([data-theme="light"]) {'), body(':root[data-theme="dark"] {'));
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{\n  color-scheme: dark;/);
  const rules = parse(css);
  const chip = (media: string, sel: string) => rules.some((r) => r.media === media && r.selectors.includes(sel) && r.decls.background?.includes('16%'));
  assert.ok(chip('', ':root[data-theme="dark"] .chip.late') && chip('@media (prefers-color-scheme: dark)', ':root:not([data-theme="light"]) .chip.late'));
});

test('theme.js: the choice sets the cookie, data-theme and the bar colour, and listeners hear when dark changes', () => {
  const src = readFileSync(new URL('./static/theme.js', import.meta.url), 'utf8');
  const attrs: Record<string, string> = {};
  const metas: { name?: string; content?: string; media?: string; remove(): void }[] = [{ name: 'theme-color', content: '#faf9f6', remove() { metas.splice(metas.indexOf(this), 1); } }];
  let mediaListener: (() => void) | undefined; let systemDark = false; let cookie = '';
  const document = {
    documentElement: { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; }, classList: { add() {}, remove() {} }, offsetWidth: 0 },
    querySelectorAll: () => [...metas],
    createElement: () => { const m = { remove() { metas.splice(metas.indexOf(m), 1); }, setAttribute(k: string, v: string) { (m as Record<string, unknown>)[k] = v; } } as (typeof metas)[number] & { setAttribute(k: string, v: string): void }; return m; },
    head: { appendChild: (m: (typeof metas)[number]) => { metas.push(m); } },
    set cookie(v: string) { cookie = v; },
    readyState: 'complete', querySelector: () => null,
  };
  const win: Record<string, unknown> = {};
  runInNewContext(src, { document, window: win, setTimeout: () => 0, matchMedia: () => ({ get matches() { return systemDark; }, addEventListener: (_: string, fn: () => void) => { mediaListener = fn; } }) });
  const th = win.brainTheme as { choice(): string; dark(): boolean; onChange(fn: (d: boolean) => void): void; set(c: string): void };
  const heard: boolean[] = [];
  th.onChange((d) => heard.push(d));
  assert.equal(th.choice(), 'auto'); assert.equal(th.dark(), false);
  systemDark = true; mediaListener!();
  assert.deepEqual(heard, [true]); assert.equal(th.dark(), true);
  th.set('light');
  assert.equal(attrs['data-theme'], 'light'); assert.equal(th.dark(), false); assert.deepEqual(heard, [true, false]);
  assert.match(cookie, /^theme=light; Max-Age=31536000; Path=\/; SameSite=Lax$/);
  assert.deepEqual(metas.map((m) => [m.content, m.media]), [['#faf9f6', undefined]]);
  mediaListener!(); assert.deepEqual(heard, [true, false], 'a forced theme ignores the system');
  th.set('dark');
  assert.equal(attrs['data-theme'], 'dark'); assert.deepEqual(heard, [true, false, true]);
  assert.deepEqual(metas.map((m) => m.content), ['#0f1320']);
  th.set('auto');
  assert.equal('data-theme' in attrs, false); assert.match(cookie, /^theme=; Max-Age=0; Path=\//);
  assert.deepEqual(metas.map((m) => [m.content, m.media]), [['#faf9f6', '(prefers-color-scheme: light)'], ['#0f1320', '(prefers-color-scheme: dark)']]);
  assert.deepEqual(heard, [true, false, true], 'system is dark and the choice is Automatic again: still dark, nothing new to say');
});

test('theme.js tells the desktop app (and only the app) by going to /app/theme/<choice>', () => {
  const src = readFileSync(new URL('./static/theme.js', import.meta.url), 'utf8');
  const run = (inApp: boolean) => {
    const attrs: Record<string, string> = {}; const classes = new Set<string>();
    const location = { href: '/settings' };
    const document = {
      documentElement: { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; }, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, offsetWidth: 0 },
      querySelectorAll: () => [], createElement: () => ({ setAttribute() {} }), head: { appendChild() {} }, cookie: '', readyState: 'complete', querySelector: () => null,
    };
    const win: Record<string, unknown> = inApp ? { __brainaiApp: true } : {};
    runInNewContext(src, { document, window: win, location, setTimeout: () => 0, matchMedia: () => ({ matches: false, addEventListener() {} }) });
    const th = win.brainTheme as { set(c: string): void };
    th.set('dark');
    return { href: location.href, classes: [...classes] };
  };
  assert.equal(run(true).href, '/app/theme/dark');
  assert.equal(run(false).href, '/settings', 'a plain browser never navigates');
  assert.deepEqual(run(false).classes, ['theme-switching'], 'colours stop fading while the look flips');
});

test('style.css: radio groups have no boxed border, and transitions stop during a switch', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  const r = parse(css);
  assert.equal(r.find((x) => x.selectors.includes('fieldset.choices'))?.decls.border, '0');
  assert.match(r.find((x) => x.selectors.includes(':root.theme-switching *'))?.decls.transition ?? '', /^none !important$/);
});
