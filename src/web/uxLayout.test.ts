/*
 * The layout and colour fixes of the 2026-11-23 UX review: the First steps fold, the state dots told apart by shape, one
 * colour for "needs you", disabled buttons that look disabled, links in sentences underlined, the page editor's wrapping
 * title with a heading for screen readers, the sidebar's single lit place, and the landmarks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWithLocale } from '../i18n/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrast, palettes as readPalettes, parse, propIn, rgb, type Rgb } from '../testing/css.js';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { firstStepsView, type Step } from './firstSteps.js';

const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');
const desk = readFileSync(new URL('./static/desk.css', import.meta.url), 'utf8');
const rules = parse(css);
const deskRules = parse(desk);
const palettes = readPalettes(css) as Record<'light' | 'dark', Record<string, string>>;
const prop = (selector: string, name: string, media = ''): string | undefined => propIn(rules, selector, name, media);

const steps: Step[] = [
  { key: 'a', label: 'Add an assistant', done: true },
  { key: 'b', label: 'Sign it in', done: true },
  { key: 'c', label: 'Save your first memory', done: false, href: '/x', link: 'Do it' },
];

test('First steps is one fold: a row with the count, closed on a phone, opened by app.js on a wide screen', () => {
  const view = firstStepsView(steps, true, true).value;
  assert.match(view, /<section class="first-steps" aria-labelledby="first-steps-h"><details class="fs-fold" data-desk-open><summary><h2 id="first-steps-h">First steps<\/h2><span class="fs-count" data-done="2" data-total="3">2 of 3 done<\/span><span class="chev"><\/span><\/summary>/);
  assert.doesNotMatch(view, /<details class="fs-fold"[^>]* open[ >]/, 'the server never renders it open');
  // The steps, done ones included, and the hide form, are inside the fold.
  const fold = view.slice(view.indexOf('<details'), view.indexOf('</details>'));
  assert.match(fold, /fs-item is-done/);
  assert.match(fold, /first-steps-hide/);
});

test('First steps count in Spanish', () => {
  const view = runWithLocale('es', () => firstStepsView(steps, true, true).value);
  assert.match(view, /<h2 id="first-steps-h">Primeros pasos<\/h2><span class="fs-count" data-done="2" data-total="3">2 de 3 hechos<\/span>/);
});

test('the fold is a card row, the week card is its sentence on a phone, and the list gap is the spacing scale', () => {
  assert.equal(prop('.fs-fold > summary', 'min-height'), '52px');
  assert.equal(prop('.fs-fold > summary', 'border-radius'), 'var(--r-card)');
  assert.equal(prop('.mc-stats', 'display', '@media (max-width: 1099px)'), 'none');
  assert.equal(prop('.phome:not(.has-panel) > .plist', 'gap', '@media (max-width: 1099px)'), 'var(--s4)');
});

test('on the wide home the left block (.pleft: First steps, the empty line, the areas) spans the rows the right column uses', () => {
  const wide = '@media (min-width: 1100px)';
  const P = '.phome:not(.has-panel) > .plist';
  assert.equal(propIn(deskRules, `${P} > .pleft`, 'grid-row', wide), '5 / span 4');
  assert.equal(propIn(deskRules, `${P} > .pleft`, 'grid-column', wide), '1');
  assert.equal(propIn(deskRules, `${P} > .pnotes`, 'grid-column', wide), '1 / -1');
  // No rule depends on First steps any more: the wrapper makes the two columns independent.
  assert.doesNotMatch(desk, /:has\(> \.first-steps\)/);
  // An empty brain keeps the same placement: pinning .pleft to one row would push For you far below its heading
  // when First steps and For you both show.
  assert.doesNotMatch(desk, /\.empty\)\s*>\s*\.pleft\s*\{[^}]*grid-row/);
  assert.equal(prop('.pleft', 'display'), 'contents', 'on a phone the wrappers add no box');
});

test('the plain home: For you, then one wrapper holding First steps, the empty line and the areas', async (t) => {
  const app = await startTestApp({ statusDir: mkdtempSync(join(tmpdir(), 'brainai-ux-')) });
  t.after(() => app.close());
  const f = await loggedIn(app);
  app.deps.registry.create('wildlog', { state: 'open', area: 'apps' }, 'owner');
  const home = await (await f('/')).text();
  const left = home.indexOf('<div class="pleft">');
  assert.ok(left > 0 && home.indexOf('class="first-steps"') > left && home.indexOf('class="pareas"') > home.indexOf('class="first-steps"'));
  // The list pane beside an open project keeps its flat markup.
  const beside = await (await f('/?project=wildlog')).text();
  assert.doesNotMatch(beside, /class="pleft"|class="pnotes"/);
});

test('state dots differ in shape as well as hue: filled, a dot in a ring, a hollow ring', () => {
  assert.equal(prop('.pdot.d-on', 'background'), 'var(--added)');
  // The ring is drawn inside the 8px box, so all three dots share one footprint and one gap to their text.
  // A border ring (sharp at 1x and 2x), not a gradient: 1px ring, 1px gap, a 4px dot.
  assert.equal(prop('.pdot.d-wait', 'border'), '1px solid var(--accent)');
  assert.equal(prop('.pdot.d-wait', 'padding'), '1px');
  assert.equal(prop('.pdot.d-wait', 'box-sizing'), 'border-box');
  assert.doesNotMatch(prop('.pdot.d-wait', 'background') ?? '', /gradient/);
  assert.equal(prop('.pdot.d-quiet', 'background'), 'transparent');
  assert.match(prop('.pdot.d-quiet', 'box-shadow') ?? '', /var\(--field-border\)/);
});

test('"needs you" is the accent everywhere: the health chip and the waiting dot, never the amber of "soon"', () => {
  assert.match(prop('.chip.hl-needs', 'color') ?? '', /var\(--accent\)/);
  assert.match(prop('.chip.hl-needs', 'background') ?? '', /var\(--accent\)/);
  assert.doesNotMatch(css, /hl-needs[^}]*--attention/);
  assert.equal(prop('.chip.soon', 'color'), 'var(--attention)');
  assert.equal(prop('.ir-dot.d-disagree', 'background'), 'var(--accent)');
});

test('the Needs you chip is readable: accent text on its 8% tint is at least 4.5:1 in light and dark', () => {
  const mix = (a: Rgb, b: Rgb, p: number): Rgb => a.map((x, i) => Math.round(x * p + b[i]! * (1 - p))) as Rgb;
  const light = palettes.light, dark = palettes.dark;
  assert.match(prop('.chip.hl-needs', 'background') ?? '', /accent\) 8%/);
  assert.ok(contrast(rgb(light['accent']!), mix(rgb(light['accent']!), rgb(light['surface']!), 0.08)) >= 4.5, 'light');
  assert.ok(contrast(rgb(dark['accent']!), mix(rgb(dark['accent']!), rgb(dark['surface']!), 0.16)) >= 4.5, 'dark');
});

test('only the pressed button looks busy: the others are held, not dimmed', () => {
  assert.equal(prop('button:disabled:not([data-held])', 'opacity'), '0.45');
  assert.equal(prop('button[aria-busy="true"]', 'opacity'), '0.45');
  const js = readFileSync(new URL('./static/desk.js', import.meta.url), 'utf8');
  assert.match(js, /if \(b === e\.submitter\) b\.setAttribute\('aria-busy', 'true'\); else b\.dataset\.held = ''/);
  assert.match(js, /delete b\.dataset\.held/);
});

test('a link inside a sentence is underlined, and a task keeps its words whole in a narrow rail', () => {
  assert.equal(prop('p:not(.crumb, .rail-link, .foot-link, .more-link) a:not([class])', 'text-decoration'), 'underline');
  assert.equal(prop('.check-text', 'overflow-wrap'), 'break-word');
  assert.equal(prop('.checks > li > .chip', 'grid-column', '@container (max-width: 20rem)'), '2');
});

test('the page title field wraps and is focused in ink; the next step is not drawn in the narrow list', () => {
  assert.equal(prop('.ptitle-input', 'field-sizing'), 'content');
  assert.equal(prop('.ptitle-input', 'min-height'), '0');
  assert.equal(prop('.ptitle-input:focus', 'border-bottom-color'), 'var(--fg)');
  assert.equal(propIn(deskRules, '.phome.has-panel > .plist .prow-next', 'display', '@media (min-width: 1100px)'), 'none');
});

test('one place is lit at a time in the sidebar: the section you are on, under its place as a heading', () => {
  assert.equal(propIn(deskRules, '.side-sub[aria-current="page"]', 'background', '@media (min-width: 1100px)'), 'var(--primary)');
  assert.equal(propIn(deskRules, '.side-place[aria-current="true"]', 'background', '@media (min-width: 1100px)'), 'none');
});

test('Skills lights only its own section, and a page reads with a labelled rail', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const skills = await (await f('/skills')).text();
  assert.match(skills, /<a class="side-place" href="\/pages" aria-current="true">Pages<\/a>/);
  assert.match(skills, /<a class="side-sub" href="\/skills" aria-current="page">Skills<\/a>/);
  const page = await app.deps.pages.create({ title: 'Wine cellar', area: 'start', body: '## Stack\nSwiftUI.' }, 'owner');
  const view = await (await f(`/pages/${page.id}`)).text();
  assert.doesNotMatch(view, /<aside/, 'the rail is not a complementary landmark inside main');
  assert.match(view, /<section class="paside" aria-label="About this page">/);
  const edit = await (await f(`/pages/${page.id}/edit`)).text();
  assert.match(edit, /<h1 class="visually-hidden">Editing Wine cellar<\/h1>/);
  assert.match(edit, /<textarea name="title" class="ptitle-input" rows="1"/);
});

test('Projects: the idea field is the first control after the heading, and the Tools notes are not flex rows', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const home = await (await f('/')).text();
  assert.match(home, /<h1>Projects[\s\S]*?<\/h1>\s*<form method="post" action="\/projects\/ideas" class="idea">/);
  assert.equal(prop('.meta.note', 'display'), 'block');
  assert.equal(prop('ul.group + .meta.note', 'margin-top'), 'var(--s7)');
});

test('the title: Enter saves (not while composing), a newline becomes a space, and a phone shows Done', async (t) => {
  const js = readFileSync(new URL('./static/editor-cm.js', import.meta.url), 'utf8');
  assert.match(js, /e\.key !== 'Enter' \|\| e\.isComposing \|\| e\.keyCode === 229/);
  assert.match(js, /form\.requestSubmit\(save \?\? undefined\)/);
  assert.match(js, /setSelectionRange\(at, at\)/);
  const app = await startTestApp();
  t.after(() => app.close());
  const f = await loggedIn(app);
  const page = await app.deps.pages.create({ title: 'Wine cellar', area: 'start', body: '## Stack\nSwiftUI.' }, 'owner');
  const edit = await (await f(`/pages/${page.id}/edit`)).text();
  assert.match(edit, /<textarea name="title"[^>]* enterkeyhint="done"/);
  const res = await f(`/pages/${page.id}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ base: '1', title: 'Wine\r\n cellar', project: '', area: 'start', body: '## Stack\nSwiftUI.', intent: 'save' }) });
  assert.equal(res.status, 303);
  assert.equal(app.deps.pages.get(page.id)!.title, 'Wine cellar');
});

test('ticking a first step on the client updates the "N of M done" count, in both languages', async () => {
  const js = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
  assert.match(js, /querySelector\('\.fs-count'\)/);
  assert.match(js, /T\('client\.firstSteps\.progress'/);
  assert.match(firstStepsView(steps, true, true).value, /<span class="fs-count" data-done="2" data-total="3">2 of 3 done<\/span>/);
  const { tIn } = await import('../i18n/index.js');
  assert.equal(tIn('es', 'client.firstSteps.progress', { done: 3, total: 6 }), '3 de 6 hechos');
});

test('a meta line part wraps instead of being cut with an ellipsis; only the one-line card and list rows keep the ellipsis', () => {
  const li = prop('.meta-line > li', 'white-space');
  assert.notEqual(li, 'nowrap', 'a long tag list or title must wrap, not end in "…"');
  assert.equal(prop('.meta-line > li', 'text-overflow'), undefined);
  assert.match(prop('.meta-line > li', 'overflow-wrap') ?? '', /break-word|anywhere/);
  // The single-line places say so themselves.
  assert.equal(prop('.pcard-foot .meta-line > li', 'white-space'), 'nowrap');
  assert.equal(prop('.pcard-foot .meta-line > li', 'text-overflow'), 'ellipsis');
  assert.match(desk, /\.desk-list \.cards\.list \.meta-line > li \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
});
