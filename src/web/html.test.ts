import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { html, page, raw, SafeHtml } from './html.js';

test('html escapes values but not SafeHtml', () => {
  const x = '<script>alert(1)</script>"\'&';
  assert.equal(html`<p>${x}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;</p>');
  assert.equal(html`<div>${html`<b>${'a<b'}</b>`}</div>`.value, '<div><b>a&lt;b</b></div>');
  assert.equal(html`${['<i>', raw('<i>')]}`.value, '&lt;i&gt;<i>');
});

test('html renders numbers and drops null/undefined', () => {
  assert.equal(html`${1}-${null}-${undefined}`.value, '1--');
  assert.ok(html`x` instanceof SafeHtml);
});

test('page escapes the title, links the stylesheet and has no inline script', () => {
  const out = page('<T>', html`<main>hi</main>`);
  assert.match(out, /^<!doctype html>/i);
  assert.match(out, /<title>&lt;T&gt;<\/title>/);
  assert.match(out, /<link rel="stylesheet" href="\/static\/style.css\?v=[0-9a-f]{10}">/);
  assert.match(out, /<main>hi<\/main>/);
  assert.doesNotMatch(out, /<script(?![^>]*\ssrc="\/static\/)/); // only external /static scripts, none inline
  assert.doesNotMatch(out, /action="\/logout"/);
});

test('the header is brain, four places, search and Settings', () => {
  const out = page('Projects', html``, { nav: true, tab: 'projects' });
  const header = out.slice(out.indexOf('<header'), out.indexOf('</header>'));
  assert.match(header, /<nav class="tabs" aria-label="Main"><a href="\/" aria-current="page">Projects<\/a><a href="\/pages">Pages<\/a><a href="\/review">Week<\/a><a href="\/graph">Graph<\/a><\/nav>/);
  assert.match(header, /placeholder="Search the brain"/);
  assert.match(header, /<form class="find" method="get" action="\/search" role="search"><input name="q" type="search"/);
  assert.match(header, /<a class="settings-link" href="\/settings"/);
  assert.doesNotMatch(header, /More|class="more|\/overview|\/left|\/memories|\/clients|\/activity/);
  // Log out lives in Settings › Your login now.
  assert.doesNotMatch(header, /action="\/logout"/);
  assert.match(page('Graph', html``, { nav: true, tab: 'graph' }), /<a href="\/graph" aria-current="page">Graph<\/a>/);
  assert.match(page('Settings', html``, { nav: true, tab: 'settings' }), /<a class="settings-link" href="\/settings" aria-current="page"/);
});

test('the header never carries a number', () => {
  const header = page('Projects', html``, { nav: true, tab: 'projects' }).split('</header>')[0]!;
  assert.doesNotMatch(header, /class="badge"|aria-label="Settings,|<a class="settings-link"[^>]*>[^<]*\d/);
});

test('a back link shows in the top row and as a crumb', () => {
  const back = { href: '/facts', label: 'Facts' };
  const out = page('x', html``, { nav: true, back });
  assert.match(out, /<a class="top-back" href="\/facts"><span>Facts<\/span><\/a>/);
  assert.match(out, /<main>\n<p class="crumb back"><a href="\/facts">‹ Facts<\/a><\/p>/);
  assert.doesNotMatch(page('x', html``, { nav: true, back, crumb: false }), /<p class="crumb back">/);
});

test('the search box carries Cancel and two pointers', () => {
  // After the input, in this order: Cancel (drawn only on the phone while the box is focused, under html.js) and the
  // two pointers, which float under the box while it is focused and empty.
  const out = page('Projects', html``, { nav: true, tab: 'projects' });
  assert.match(out, /<form class="find" method="get" action="\/search" role="search"><input name="q" type="search"[^>]*><button type="button" class="find-cancel">Cancel<\/button><div class="find-hints"><a href="\/review\/now#latest">Latest changes<\/a><a href="\/facts">All facts<\/a><p>Or type: projects, facts and page sections\.<\/p><\/div><\/form>/);
});

test('every /static/ link carries a fingerprint of the file, so a deploy is never hidden by a cached copy', () => {
  const out = page('t', html``, { nav: true });
  const links = [...out.matchAll(/"\/static\/([^"?]+)(\?v=([0-9a-f]+))?"/g)];
  assert.ok(links.length >= 4);
  for (const [, file, , v] of links) {
    const expected = createHash('sha256').update(readFileSync(new URL(`./static/${file}`, import.meta.url))).digest('hex').slice(0, 10);
    assert.equal(v, expected, file);
  }
});

test('dark mode is the owner\'s deep navy, and the phone bar matches the background', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const v = (name: string) => dark.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1];
  assert.equal(v('bg'), '#0f1320');
  assert.equal(v('surface'), '#161b2b');
  for (const name of ['bg', 'surface', 'raised', 'line', 'line-strong', 'fg', 'ink2', 'muted']) {
    const hex = v(name)!;
    const [r, , b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(b >= r, `--${name} ${hex} is warm`);
  }
  assert.match(page('t', html``), new RegExp(`<meta name="theme-color" content="${v('bg')}" media="\\(prefers-color-scheme: dark\\)">`));
});

test('hovering the current tab keeps its label readable (the hover colour is the current tab\'s background)', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.tabs a:hover \{[^}]*color/, 'a bare .tabs a:hover outranks the current tab and paints --fg on --primary');
  assert.match(css, /\.tabs a:not\(\[aria-current\]\):hover \{ color: var\(--fg\); \}/);
});

test('the Facts filters apply as they change wherever the list is drawn, so Show hides with script on, also in the list pane', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.js form\.frow-filters > \.filter-show \{ display: none; \}/);
  const app = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  // Listened for on the document, not on the forms there at load: the desk's list pane draws its form later.
  assert.match(app, /document\.addEventListener\('change', \(e\) => \{[^}]*form\.frow-filters/);
  assert.match(app, /document\.addEventListener\('input', \(e\) => \{[^}]*form\.frow-filters/);
});

test('the live editor hides the plain text box it replaces (style.css sets textarea display, which beats [hidden])', () => {
  const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
  assert.match(css, /textarea\[data-editor\]\[hidden\] \{ display: none; \}/);
});
