/*
 * The stylesheet, read as text: focus rings, contrast worked out from the palette's own variables, wrapping of long
 * unbroken text (URLs, paths, names) and the page's sticky right rail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, palettes as readPalettes, parse, propIn, rgb, type Rgb } from '../testing/css.js';

const css = readFileSync(new URL('./static/style.css', import.meta.url), 'utf8');

const rules = parse(css);
const HOVER = '@media (hover: hover) and (pointer: fine)', MOTION = '@media (prefers-reduced-motion: no-preference)';

/** The value a selector gets for a property, outside any @media unless one is named; later rules win. */
const prop = (selector: string, name: string, media = ''): string | undefined => propIn(rules, selector, name, media);

const palettes = readPalettes(css) as Record<string, Record<string, string>>;

test('the Pages tree is labelled only on the phone home', () => {
  assert.equal(prop('.by-area', 'display'), 'none');
  assert.equal(prop('.by-area', 'display', '@media (max-width: 719px)'), 'block');
  assert.equal(prop('.pages-wrap.on-page .pnav', 'display', '@media (max-width: 719px)'), 'none');
});

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((x) => x / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo, l = (hi + lo) / 2;
  return [0, d ? d / (1 - Math.abs(2 * l - 1)) : 0, l];
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => v * t + b[i] * (1 - t)) as Rgb;
/** `var(--name)` or a hex colour, in one palette. */
function colour(value: string, p: Record<string, string>): Rgb {
  const m = value.match(/^var\(--([\w-]+)\)$/);
  const hex = m ? p[m[1]] : value;
  assert.ok(hex && /^#[0-9a-f]{6}$/.test(hex), `cannot resolve ${value}`);
  return rgb(hex);
}

test('keyboard focus shows on range inputs, radios and checkboxes, and is not clipped in clipped lists', () => {
  // `input:focus { outline: none }` outranks the global :focus-visible ring, so these inputs need their own.
  const ring = rules.find((r) => r.selectors.some((s) => /^input:is\(.*\[type=range\].*\):focus-visible$/.test(s) && s.includes('[type=radio]') && s.includes('[type=checkbox]')));
  assert.ok(ring, 'no :focus-visible ring for range, radio and checkbox inputs');
  assert.match(ring!.decls.outline ?? '', /^2px solid var\(--focus\)$/);
  // .vers clips with overflow: hidden, so its full-width links draw the ring inside (grouped lists: their own test).
  for (const sel of ['.vers a:focus-visible']) {
    assert.match(rules.find((r) => r.selectors.includes(sel))?.decls['outline-offset'] ?? '', /^-2px$/, sel);
  }
});

test('focus and anchor jumps land below the sticky header, and above the phone\'s tab bar', () => {
  const rem = (v: string | undefined) => Number(v?.match(/^([\d.]+)rem$/)?.[1] ?? 0);
  // Header: 57px on a desktop; on the phone one slim row (52px) plus room for a focus ring, and the bar below.
  assert.ok(rem(prop('html', 'scroll-padding-top')) * 16 >= 57 + 8, 'desktop scroll-padding-top');
  assert.equal(prop('html', 'scroll-padding-top', '@media (max-width: 719px)'), 'calc(64px + env(safe-area-inset-top))', 'the installed app pads the row with the status bar, so the jump clears it too');
  assert.equal(prop('html', 'scroll-padding-bottom', '@media (max-width: 719px)'), 'calc(var(--tabbar) + env(safe-area-inset-bottom))');
});

test('links inside running text are underlined, since their colour alone is under 3:1 against the text', () => {
  for (const [name, p] of Object.entries(palettes)) assert.ok(contrast(colour('var(--link)', p), colour('var(--fg)', p)) < 3, `${name}: colour alone would do`);
  const underlined = (start: string) => rules.some((r) => r.decls['text-decoration'] === 'underline' && r.selectors.some((s) => s === start || s.startsWith(`${start}:not(`)));
  assert.ok(underlined('.art a'), 'page body links');
  assert.ok(underlined('p.meta a'), 'meta line links (History, Open the memory)');
  assert.ok(underlined('.week .row p a'), 'weekly digest links');
  // Pills and buttons keep their own look.
  const metaRule = rules.find((r) => r.selectors.some((s) => s.startsWith('p.meta a')))!;
  assert.ok(metaRule.selectors.find((s) => s.startsWith('p.meta a'))!.includes('.project'), 'project pills are not underlined');
});

test('writer names are ink, only their dot is coloured; area rings are hollow', () => {
  assert.equal(prop('.writer', 'color'), 'var(--ink2)'); assert.equal(prop('.writer', 'font-weight'), '500');
  assert.equal(prop('.writer::before', 'background'), 'var(--w)');
  assert.equal(prop('.ring', 'box-shadow'), 'inset 0 0 0 1.75px var(--a)');
  for (const a of ['apps', 'home', 'tools', 'work', 'personal']) assert.equal(prop(`.a-${a}`, '--a'), `var(--a-${a})`);
  assert.ok(!/area-(apps|home|tools|work|personal)\s*\{[^}]*--w-/.test(css), 'areas no longer borrow writer colours');
});

test('blue is only for links in page text; selection and focus are ink', () => {
  assert.equal(prop('a', 'color'), 'var(--fg)');
  assert.ok(rules.every((r) => !Object.values(r.decls).includes('var(--link)') || r.selectors.every((s) => s.startsWith('.art'))), 'var(--link) outside .art');
  assert.equal(prop(':focus-visible', 'outline'), '2px solid var(--focus)'); assert.equal(prop(':focus-visible', 'border-radius'), undefined);
  assert.equal(prop('.pcard.is-selected', 'border-color'), 'var(--fg)');
  assert.equal(prop('input:focus', 'border-color'), 'var(--fg)');
  assert.ok(!rules.some((r) => r.selectors.some((s) => /:focus|is-selected|:target/.test(s)) && Object.values(r.decls).some((v) => v.includes('--accent'))), 'orange means needs you, not focus');
});

test('"not pushed" is a plain chip, a done tick is ink', () => {
  assert.equal(prop('.check.is-done', 'background'), 'var(--fg)');
  assert.equal(prop('.chip.plain', 'background'), 'var(--raised)'); assert.equal(prop('.chip.plain', 'color'), 'var(--muted)');
});

/** A `color-mix(in srgb, X N%, transparent)` tint laid over a background colour. */
function tint(value: string, over: Rgb, p: Record<string, string>): Rgb {
  const m = value.match(/^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, transparent\)$/);
  assert.ok(m, `not a tint: ${value}`);
  return mix(colour(m![1], p), over, Number(m![2]) / 100);
}

test('added and removed lines in the History diff reach 4.5:1 on their tint', () => {
  assert.equal(prop('.dlist', 'background'), 'var(--raised)');
  for (const [name, p] of Object.entries(palettes)) {
    for (const k of ['a', 'd']) {
      const bg = tint(prop(`.dl.${k}`, 'background')!, colour('var(--raised)', p), p);
      for (const part of ['i', 'span']) {
        const c = contrast(colour(prop(`.dl.${k} ${part}`, 'color')!, p), bg);
        assert.ok(c >= 4.5, `${name} .dl.${k} ${part}: ${c.toFixed(2)}`);
      }
    }
  }
});

test('text fields and selects have an edge of at least 3:1 against the page, panel and card behind them', () => {
  for (const sel of ['input', 'select', 'textarea']) {
    const border = prop(sel, 'border') ?? '';
    const m = border.match(/^1px solid (var\(--[\w-]+\))$/);
    assert.ok(m, `${sel} border: ${border}`);
    for (const [name, p] of Object.entries(palettes)) {
      for (const bg of ['bg', 'surface', 'raised']) {
        const c = contrast(colour(m![1], p), rgb(p[bg]));
        assert.ok(c >= 3, `${name} ${sel} edge on --${bg}: ${c.toFixed(2)}`);
      }
    }
  }
});

test('dismissed Growth observations, closed discussions and the note marker keep their text at 4.5:1', () => {
  /** Text and background of a card drawn at some opacity over its parent. */
  const faded = (text: Rgb, cardBg: Rgb, opacity: number, parent: Rgb) => contrast(mix(text, parent, opacity), mix(cardBg, parent, opacity));
  for (const [name, p] of Object.entries(palettes)) {
    // Growth: the cards sit in a panel (--surface).
    const surface = colour('var(--surface)', p);
    const obsBg = prop('.card.obs.dimmed', 'background') ?? prop('.card', 'background')!;
    const obsCard = obsBg === 'transparent' ? surface : colour(obsBg, p);
    const obsOpacity = Number(prop('.card.obs.dimmed', 'opacity') ?? 1);
    for (const text of ['var(--muted)', prop('.card.obs.dimmed .obs-what', 'color') ?? 'var(--fg)']) {
      const c = faded(colour(text, p), obsCard, obsOpacity, surface);
      assert.ok(c >= 4.5, `${name} dimmed observation ${text}: ${c.toFixed(2)}`);
    }
    // Discussions: list rows on the page (--bg), no card fill.
    const bg = colour('var(--bg)', p);
    const doneOpacity = Number(prop('.card.done', 'opacity') ?? 1);
    for (const text of ['var(--muted)', prop('.card.done .card-link', 'color') ?? 'var(--fg)']) {
      const c = faded(colour(text, p), bg, doneOpacity, bg);
      assert.ok(c >= 4.5, `${name} closed discussion ${text}: ${c.toFixed(2)}`);
    }
    // The 12px 'note' marker beside a section heading, on the page or a panel.
    for (const under of ['bg', 'surface']) {
      const c = contrast(colour(prop('.note-mark', 'color')!, p), tint(prop('.note-mark', 'background')!, rgb(p[under]), p));
      assert.ok(c >= 4.5, `${name} note marker on --${under}: ${c.toFixed(2)}`);
    }
  }
});

test('placeholders (the only visible label on the idea box and the header search) reach 4.5:1', () => {
  for (const sel of ['input::placeholder', 'textarea::placeholder']) {
    const opacity = prop(sel, 'opacity');
    assert.ok(opacity !== undefined, `${sel} sets no opacity, so the browser's own faded default applies`);
    for (const [name, p] of Object.entries(palettes)) {
      const surface = colour('var(--surface)', p);
      const c = contrast(mix(colour(prop(sel, 'color')!, p), surface, Number(opacity)), surface);
      assert.ok(c >= 4.5, `${name} ${sel}: ${c.toFixed(2)}`);
    }
  }
});

/** overflow-wrap is not inherited from body here (only p and headings set it), so each container must break long words. */
const wraps = (selector: string, media = '') => prop(selector, 'overflow-wrap', media) === 'anywhere';

test('the Last week row keeps its whole focus ring inside the card', () => {
  assert.equal(prop('.group > li > .fy-week > form > button.row:focus-visible', 'outline-offset'), '-2px');
  assert.equal(prop('.group > li:first-child > .fy-week > form > button.row', 'border-radius'), '13px 13px 0 0');
  assert.equal(prop('.group > li:last-child > .fy-week > form > button.row', 'border-radius'), '0 0 13px 13px');
});
test('Archive sits in the pill row, and Manage lines up with the panel headings', () => {
  assert.equal(prop('.danger', 'margin-top'), undefined);
  assert.equal(prop('form.danger', 'margin-top'), '0.75rem');
  assert.equal(prop('details.fold.manage > summary', 'padding'), '0');
});
test('everything in Manage shares one left edge: Archive on its own line flush left, Edit details a row like New page', () => {
  assert.equal(prop('.panel-actions form:has(> button.danger)', 'flex-basis'), '100%', 'Archive always takes its own line, never a wrapped indent');
  assert.equal(prop('.panel-actions button.danger', 'padding-inline'), '0');
  assert.equal(prop('.manage > a.row', 'padding-inline'), '0', 'New page and Add a fact start where Where it lives starts');
  assert.equal(prop('.manage .pinfo > summary', 'color'), 'var(--fg)');
  assert.equal(prop('.manage .pinfo > summary', 'font-weight'), '400');
  assert.equal(prop('.manage .pinfo > summary', 'min-height'), '52px');
  assert.equal(prop('.manage .pinfo', 'margin'), '0', 'Edit details, New page and Add a fact sit evenly, with no extra gap under Edit details');
});
test('the jump row chips are chip size, so Waiting · Pages · Discussions · Facts fit one line on the iPhone', () => {
  assert.equal(prop('.jump a', 'font-size'), 'var(--t-meta)');
  assert.equal(prop('.jump a', 'min-height'), '28px');
  assert.equal(prop('.jump a', 'padding'), '0 9px');
  assert.equal(prop('.jump a', 'white-space'), 'nowrap');
});
test("a fact's Where it shows links read as links: ink with an underline, not plain grey text", () => {
  assert.equal(prop('.where .rows a', 'color'), 'var(--fg)');
  assert.equal(prop('.where .rows a', 'text-decoration'), 'underline');
  assert.equal(prop('.where h2', 'font-size'), undefined, 'the heading is an h3 like Replaces');
});
test('the Projects home spaces its parts as the approved mockup: even gaps, a light Last week dot, a quiet "N suggestions" row', () => {
  assert.equal(prop('.plist > section', 'margin'), '1.5rem 0 0', 'the same gap above On the go and Also open, none trailing below');
  assert.equal(prop('.plist > .pfolds', 'margin-top'), '0.5rem', 'the folds card follows Also open closely, not after a stray 32px');
  assert.equal(prop('.dot.muted', 'background'), 'var(--line-strong)');
  assert.equal(prop('details.fold.fy-more > summary', 'color'), 'var(--muted)');
  assert.equal(prop('details.fold.fy-more > summary', 'font-weight'), '400');
});
test('the approval card headline is body size in ink, and its quote has no left rule, as the approved sheet', () => {
  assert.equal(prop('.approval-head', 'font-size'), 'var(--t-body)');
  assert.equal(prop('.approval-head', 'color'), 'var(--fg)');
  assert.equal(prop('.approval-head .writer', 'font-weight'), '600');
  assert.equal(prop('.approval-card blockquote', 'border-left'), '0');
});
test('orange is never a border on the graph back link or a decided discussion', () => {
  for (const s of ['.graph-back', '.panel.decided']) for (const r of rules.filter((r) => r.selectors.includes(s)))
    for (const [k, v] of Object.entries(r.decls)) if (/border|outline|box-shadow/.test(k)) assert.doesNotMatch(v, /--accent/, `${s} ${k}`);
});
test('a discussion uses no colour as decoration: a writer is only a dot, and Decide is a plain card', () => {
  for (const s of ['.reply', '.reply.pending', '.panel.decide']) for (const r of rules.filter((r) => r.selectors.includes(s)))
    for (const [k, v] of Object.entries(r.decls)) if (/border|outline|box-shadow/.test(k)) assert.doesNotMatch(v, /--w\b|--w,|--accent/, `${s} ${k}`);
  assert.equal(prop('.reply', 'border-top'), undefined, 'no thick top rule in the writer colour');
});
test('Home is a stone ring in the dark, never amber', () => {
  const [, s] = hsl(palettes.dark['a-home']!);
  assert.ok(s <= 0.2, `dark --a-home saturation ${s}`);
  for (const bg of ['bg', 'surface', 'raised']) assert.ok(contrast(rgb(palettes.dark['a-home']!), rgb(palettes.dark[bg]!)) >= 3);
});
test('page names in the left list wrap to two lines instead of losing their project', () => {
  for (const r of rules.filter((r) => r.selectors.some((s) => s.startsWith('.pnav')))) {
    assert.notEqual(r.decls['text-overflow'], 'ellipsis', r.selectors.join());
    assert.notEqual(r.decls['white-space'], 'nowrap', r.selectors.join());
  }
  assert.equal(prop('.pnav a', '-webkit-line-clamp'), '2');
});
test('reading screens never stretch to the window edge', () => {
  assert.equal(prop('.narrow', 'max-width'), '46rem');
  assert.equal(prop('.wide-narrow', 'max-width'), '58rem');
});
test('section Edit links stay out of the way on touch', () => {
  assert.equal(prop('.sec-edit', 'display', '@media (hover: none)'), 'none');
});
test('the What moved extra line is muted, regular text', () => {
  assert.equal(prop('.review .moved .also a', 'font-weight'), '400');
  assert.equal(prop('.review .moved .also a', 'color'), 'var(--muted)');
});
test('on the phone a suggestion sentence gets the full width, its buttons under it', () => {
  assert.equal(prop('.row.fy-sug', 'grid-template-columns', '@media (max-width: 719px)'), 'minmax(0, 1fr)');
  assert.equal(prop('.fy-sug .acts', 'justify-content', '@media (max-width: 719px)'), 'flex-start');
});
test('the Graph Find field hides the native blue clear button', () => {
  assert.equal(prop('.graph-find input::-webkit-search-cancel-button', 'display'), 'none');
});
test('the contents marks the current section', () => {
  assert.equal(prop('.toc a[aria-current="true"]', 'font-weight'), '600');
  assert.equal(prop('.toc a[aria-current="true"]', 'box-shadow'), 'inset 2px 0 0 var(--fg)');
});

test('a page breaks long URLs and paths in list items and in its On this page list, instead of panning sideways', () => {
  // Tight Markdown lists render <li> with no <p>, so p's rule never reaches their links and inline code.
  assert.ok(wraps('.art li'), '.art li');
  assert.ok(wraps('.toc a'), '.toc a');
});

test('Projects: a URL or path in a card, or in the panel (facts, Then steps, pages, remotes), wraps inside its box', () => {
  for (const sel of ['.pcard-one', '.pcard-line']) {
    assert.ok(wraps(sel), sel);
    assert.equal(prop(sel, 'min-width'), '0', `${sel} min-width`);
  }
  assert.ok(wraps('.ppanel'), '.ppanel (inherited by everything inside it)');
});

test('names without spaces (connections, projects, assistants asked) wrap instead of widening Settings and discussions', () => {
  // A fieldset defaults to min-width: min-content, so it grows to its longest project name.
  assert.equal(prop('.project-choices', 'min-width'), '0');
  for (const sel of ['.project-choices', '.conn-name', '.pill', '.facts dd']) assert.ok(wraps(sel), sel);
  // On a phone the connection row is two columns; a plain 1fr cannot shrink below the name.
  assert.equal(prop('.conn-row', 'grid-template-columns', '@media (max-width: 760px)'), 'minmax(0, 1fr) auto');
});

test("on a phone, 'Not in the brain yet' shows each folder's whole name before Add or Ignore", () => {
  const phone = '@media (max-width: 719px)';
  assert.equal(prop('.notinbrain .nib-name', 'white-space', phone), 'normal');
  assert.ok(wraps('.notinbrain .nib-name', phone));
});

test("inside 'Not in the brain yet' the intro and the Ignored heading start where the rows' words start", () => {
  assert.equal(prop('.notinbrain > .nib-intro', 'margin'), '0 16px 8px');
  assert.equal(prop('.notinbrain > .nib-intro', 'display'), undefined, 'a plain paragraph: the time and its full stop stay in the sentence');
  assert.equal(prop('.notinbrain .nib-ignored', 'margin'), '12px 16px 6px');
});

test("the page's right rail stays in view while scrolling a long page, and scrolls itself when it is taller than the window", () => {
  assert.equal(prop('.paside .sticky', 'position'), 'sticky');
  // The grid uses align-items: start, which would make the aside exactly as tall as its sticky child: no room to stick.
  assert.equal(prop('.pages-wrap', 'align-items'), 'start');
  assert.equal(prop('.paside', 'align-self'), 'stretch');
  assert.match(prop('.paside .sticky', 'max-height') ?? '', /^calc\(100vh - /);
  // Room below it as well as the header above: at the end of a page the rail never rides up under the header.
  const gap = Number(/^calc\(100vh - ([\d.]+)rem\)$/.exec(prop('.paside .sticky', 'max-height') ?? '')?.[1]);
  assert.ok(gap >= Number.parseFloat(prop('.paside .sticky', 'top') ?? '0') + 3, `max-height leaves ${gap}rem`);
  assert.equal(prop('.paside .sticky', 'overflow-y'), 'auto');
  // Below 1100px (max-width 1099px) the rail sits under the page and does not stick or scroll on its own.
  const medium = '@media (max-width: 1099px)';
  assert.equal(prop('.paside .sticky', 'position', medium), 'static');
  assert.equal(prop('.paside .sticky', 'max-height', medium), 'none');
});

test('the Pages list is placed in the left column by the grid, and on a phone the screen reads in markup order: page, rail, list', () => {
  assert.equal(prop('.pnav', 'grid-column'), '1');
  assert.equal(prop('.pnav', 'grid-row'), '1');
  assert.equal(prop('.pmain', 'grid-column'), '2');
  assert.equal(prop('.pmain', 'grid-row'), '1');
  assert.equal(prop('.paside', 'grid-column'), '3');
  assert.equal(prop('.paside', 'grid-row'), '1');
  const medium = '@media (max-width: 1099px)';
  assert.equal(prop('.paside', 'grid-column', medium), '2');
  assert.equal(prop('.paside', 'grid-row', medium), '2');
  const phone = '@media (max-width: 760px)';
  for (const sel of ['.pnav', '.pmain', '.paside']) {
    assert.equal(prop(sel, 'order', phone), undefined, `${sel} keeps its markup order on a phone`);
    assert.equal(prop(sel, 'grid-column', phone), 'auto', sel);
    assert.equal(prop(sel, 'grid-row', phone), 'auto', sel);
  }
});

test('on an iPhone or iPad no text field is under 16px, so focusing one does not zoom the page in', () => {
  // iOS Safari zooms in on a focused field under 16px and stays zoomed. Its own rules sit in this block.
  const ios = '@supports (-webkit-touch-callout: none)';
  /** The font size a selector ends with on iOS: the last rule (plain or in the iOS block) that sets it, in file order. */
  const size = (selector: string) => {
    let v: string | undefined;
    for (const r of rules) {
      if ((r.media !== '' && r.media !== ios) || !r.selectors.includes(selector)) continue;
      if ('font-size' in r.decls) v = r.decls['font-size'];
      else if ('font' in r.decls) v = r.decls.font === 'inherit' ? 'inherit' : r.decls.font.split(/[\s/]/)[0];
    }
    return v;
  };
  for (const sel of ['.find input', '.peditor textarea', '.asknote textarea', '.graph-find input']) {
    const raw = size(sel);
    // A size token resolves through :root.
    const v = raw?.startsWith('var(--t-') ? prop(':root', raw.slice(4, -1)) : raw;
    const px = v?.endsWith('rem') ? Number.parseFloat(v) * 16 : v?.endsWith('px') ? Number.parseFloat(v) : 0;
    assert.ok(px >= 16, `${sel}: ${v}`);
  }
});

test('on a phone the header is drawn in its tab order: the search sits before Settings, not on a row below it', () => {
  // The markup is brand, tabs, search, Settings. CSS order would move the search without moving keyboard focus.
  for (const media of ['', '@media (max-width: 719px)', '@media (min-width: 720px)']) {
    for (const sel of ['.find', '.settings-link', '.tabs', '.brand']) assert.equal(prop(sel, 'order', media), undefined, `${sel} ${media}`);
  }
  // It shares a row with Settings (or the tabs), so it must be able to shrink.
  assert.equal(prop('.find', 'min-width', '@media (max-width: 719px)'), '0');
});

test('graph3d.js adds only classes of its own', () => {
  const js = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8');
  const added = [...js.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)].map((m) => m[1]!);
  // Its own prefix: a class the graph takes is never one another screen styles (the Pages 'Live from the brain' box).
  for (const cls of added) assert.ok(cls.startsWith('graph-'), `graph3d.js uses .${cls}`);
});

test('a graph list row\'s meta line is plain text, so its · separators are not spread out by the flex gap', () => {
  assert.equal(prop('.graph-rows .meta', 'display'), 'block');
});

test('Related on the card reads as one inline line of links, not a stack of pills', () => {
  assert.equal(prop('.graph-related', 'display'), 'block');
  assert.equal(prop('.graph-rel', 'display'), 'inline');
  // The app's button rule (a 44 px pill, semibold) is undone, so the entries run on as one line of text.
  assert.equal(prop('.graph-rel', 'border-radius'), '0');
  assert.equal(prop('.graph-rel', 'min-height'), '0');
  assert.equal(prop('.graph-rel', 'font-weight'), '400');
  assert.equal(prop('.graph-rel', 'color'), 'var(--fg)');
  assert.equal(prop('.graph-rel', 'text-decoration'), 'underline');
  const js = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8');
  const at = js.indexOf("'graph-related'");
  assert.match(js.slice(at, at + 700), /' · '/, 'entries are separated as in the spec: "brainai: backups, nas · outline: backups"');
});

test('every graph element that can be hidden has its own hidden rule', () => {
  for (const sel of ['.graph', '.graph-list', '.graph-card', '.graph-sheet', '.graph-btn', '.graph-hint']) {
    assert.ok(rules.some((r) => r.selectors.includes(`${sel}[hidden]`) && r.decls.display === 'none'), sel);
  }
});

test('on a wide screen the project panel grows with the page instead of scrolling in its own box', () => {
  // The wide rules live in desk.css (desktop design §5); neither stylesheet boxes the panel in.
  const wide = '@media (min-width: 1100px)';
  const desk = parse(readFileSync(new URL('./static/desk.css', import.meta.url), 'utf8'));
  for (const p of ['max-height', 'overflow-y', 'position']) {
    assert.equal(prop('.ppanel', p, wide), undefined, p);
    assert.equal(propIn(desk, '.ppanel', p, wide), undefined, p);
  }
  assert.ok(desk.some((r) => r.media === wide && r.selectors.includes('.phome.has-panel')), 'the wide panel rule is in desk.css');
});

test('the phone drops the panel\'s own back link and Continue button, and gives its page rows hairlines', () => {
  const PHONE = '@media (max-width: 719px)';
  assert.equal(prop('.continue', 'display', PHONE), 'none');
  assert.equal(prop('.ppanel-back', 'display', PHONE), 'none');
  assert.equal(prop('ul.ppages > li + li::before', 'height'), '1px');
  assert.equal(prop('ul.ppages > li + li::before', 'background'), 'var(--line)');
});

test('below 900px the Settings section strip is gone: the phone gets the five-row index instead', () => {
  assert.equal(prop('.settings-nav', 'display', '@media (max-width: 899px)'), 'none');
  assert.equal(prop('.settings-index', 'display', '@media (max-width: 899px)'), 'block');
  assert.equal(prop('.settings-index', 'display'), 'none');
});

test('on a phone an open project still has a main heading for a screen reader: the list hides, its Projects h1 stays', () => {
  const phone = '@media (max-width: 760px)';
  const view = readFileSync(new URL('./projectsViews.ts', import.meta.url), 'utf8');
  assert.match(view, /<div class="plist">\s*<h1>Projects(<|\$\{)/, 'the h1 is the list\'s first child');
  // display: none would take the h1 out of the accessibility tree too.
  assert.notEqual(prop('.phome.has-panel .plist', 'display', phone), 'none');
  assert.equal(prop('.phome.has-panel .plist > :not(h1)', 'display', phone), 'none');
  for (const [k, v] of Object.entries({ position: 'absolute', overflow: 'hidden', 'clip-path': 'inset(50%)' })) assert.equal(prop('.phome.has-panel .plist', k, phone), v, k);
});

test('Settings › Devices: a long device or ignored folder name wraps instead of widening Settings on a phone', () => {
  assert.ok(wraps('.rows.devices .dev-name'));
  assert.equal(prop('.rows.devices .dev-name', 'min-width'), '0');
});

test('the 3D window follows the theme: paper in light, blue-black in dark, with a visible frame', () => {
  assert.equal(prop('.graph', 'background'), 'var(--g-bg)');
  assert.equal(prop(':root', '--g-bg'), '#f6f3ec');
  assert.equal(prop(':root', '--g-bg', '@media (prefers-color-scheme: dark)'), '#02050a');
  assert.match(prop('.graph', 'border') ?? '', /^1px solid var\(--g-line\)$/);
  assert.equal(prop('.graph', 'color-scheme'), undefined, 'no forced dark scheme');
  assert.equal(prop('.graph-canvas', 'touch-action'), 'none');
});

test('style.css gives the sheet a 44-point close button and keeps it to 40% of the height', () => {
  assert.equal(prop('.graph-close', 'min-width'), '44px');
  assert.equal(prop('.graph-close', 'min-height'), '44px');
  assert.equal(prop('.graph-sheet', 'max-height'), '40dvh');
  assert.equal(prop('.graph-card', 'background'), 'var(--surface)');
});

test('the sheet\'s handle and close button stay put while its card scrolls', () => {
  // The sheet itself never scrolls: only its body does, so the handle and the × above it are always there.
  assert.equal(prop('.graph-sheet', 'overflow'), 'hidden');
  assert.equal(prop('.graph-sheet', 'overflow-y'), undefined);
  assert.equal(prop('.graph-sheet', 'display'), 'flex');
  assert.equal(prop('.graph-sheet', 'flex-direction'), 'column');
  assert.equal(prop('.graph-sheet-body', 'overflow-y'), 'auto');
  assert.equal(prop('.graph-sheet-body', 'min-height'), '0');
  assert.equal(prop('.graph-grab', 'flex'), 'none');
  const view = readFileSync(new URL('./graphViews.ts', import.meta.url), 'utf8');
  assert.match(view, /<div class="graph-sheet" hidden><button[^>]*class="graph-grab"[^>]*><\/button><button[^>]*class="graph-close"[^>]*>×<\/button><div class="graph-sheet-body"[^>]*><\/div><\/div>/, 'handle and × sit outside the scrolling body');
});

test('the dark palette is the owner\'s navy, clearly blue with no warm tint', () => {
  const d = palettes.dark;
  assert.equal(d.bg, '#0f1320'); assert.equal(d.surface, '#161b2b'); assert.equal(d.fg, '#e7ebf5');
  for (const k of ['bg', 'surface', 'raised', 'elevated', 'line', 'line-strong', 'field-border', 'fg', 'ink2', 'muted']) {
    const [r, , b] = rgb(d[k]); assert.ok(b - r >= 12, `--${k} ${d[k]} is not clearly blue`);
  }
});

test('text, fields, chips, writer dots and area rings keep their contrast in both palettes', () => {
  for (const [name, p] of Object.entries(palettes)) for (const bg of ['bg', 'surface', 'raised']) {
    for (const t of ['fg', 'ink2', 'muted', 'error', 'attention', 'accent']) assert.ok(contrast(rgb(p[t]), rgb(p[bg])) >= 4.5, `${name} --${t} on --${bg}`);
    assert.ok(contrast(rgb(p['field-border']), rgb(p[bg])) >= 3, `${name} field edge on --${bg}`);
    for (const k of Object.keys(p).filter((k) => /^(w|a)-/.test(k))) assert.ok(contrast(rgb(p[k]), rgb(p[bg])) >= 3, `${name} --${k} on --${bg}`);
  }
  for (const [name, p, pct] of [['light', palettes.light, 0.12], ['dark', palettes.dark, 0.16]] as const)
    for (const k of ['error', 'attention']) assert.ok(contrast(rgb(p[k]), mix(rgb(p[k]), rgb(p.surface), pct)) >= 4.5, `${name} ${k} chip`);
});

test('the light writer and area hues are the approved ones, none of them red or amber', () => {
  assert.deepEqual([palettes.light['w-code'], palettes.light['w-claude'], palettes.light['w-x2']], ['#4e6488', '#a3466e', '#8a5a8f']);
  assert.deepEqual(['apps', 'home', 'tools', 'work', 'personal'].map((a) => palettes.light[`a-${a}`]), ['#3d7a5a', '#7f7462', '#3f6f99', '#6a5a9e', '#9a5a7d']);
});

test('type, radius, spacing and motion tokens exist with the direction\'s values', () => {
  const v = (n: string) => prop(':root', `--${n}`);
  assert.deepEqual(['display', 'title', 'section', 'headline', 'prose', 'body', 'sub', 'meta', 'label'].map((t) => v(`t-${t}`)), ['2.125rem', '1.625rem', '1.25rem', '1.0625rem', '1.0625rem', '1rem', '0.9375rem', '0.8125rem', '0.75rem']);
  assert.deepEqual(['pill', 'card', 'inset'].map((r) => v(`r-${r}`)), ['999px', '14px', '10px']);
  assert.equal(v('s8'), '48px'); assert.equal(v('ease-out'), 'cubic-bezier(.23, 1, .32, 1)');
});

test('no hex or rgb colour outside the palettes', () => {
  // Generic, not a list of old values: catches Graphite (#74747d, #8b8b94, #1f1f23 …) and white chrome text (#fff),
  // which would vanish on the paper Graph window. Only `:root` (light and the dark block) holds colour values.
  // The one allowance: neutral black shadows, `rgb(0 0 0 / …)`, inside box-shadow.
  const colour = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i;
  for (const r of rules) if (!r.selectors.every((s) => s === ':root')) for (const [k, v] of Object.entries(r.decls)) {
    const rest = k === 'box-shadow' ? v.replace(/rgb\(0 0 0 \/ [\d.]+\)/g, '') : v;
    assert.doesNotMatch(rest, colour, `${r.selectors.join(', ')} { ${k}: ${v} }`);
  }
  for (const hex of ['#121214', '#1b1b1e', '#252529', '#2f2f34', '#414148', '#74747d']) assert.ok(!css.toLowerCase().includes(hex), `${hex} in style.css`);
  const js = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8').toLowerCase();
  for (const hex of ['#121214', '#30303a']) assert.ok(!js.includes(hex), `${hex} in graph3d.js`);
});

test('every hover rule is for a real pointer, so nothing stays lit after a tap', () => {
  for (const r of rules) if (r.selectors.some((s) => s.includes(':hover'))) assert.equal(r.media, HOVER, r.selectors.join(', '));
  // The direction removes the .88 fade on buttons; the section-edit reveal (`.art .sec-head:hover .sec-edit { opacity: 1 }`) stays.
  assert.ok(!rules.some((r) => r.decls.opacity === '0.88' || r.decls.opacity === '.88'), 'no .88 fade hovers');
});

test('presses answer at once: buttons, cards, rows and checks have :active states, and transforms respect reduced motion', () => {
  for (const sel of ['button:active', '.button:active', '.pcard:active', '.check:active::before']) assert.match(prop(sel, 'transform', MOTION) ?? '', /^scale\(\.9\d*\)$/, sel);
  for (const r of rules) if (Object.values(r.decls).some((v) => /scale\(|translate/.test(v)) && r.selectors.some((s) => s.includes(':active'))) assert.equal(r.media, MOTION, r.selectors.join());
});

test('the check\'s press scales its circle, never the button', () => {
  // A transform on .check would make it the containing block of its own row-wide ::after, shrinking the 44pt target
  // to 22px mid-press, so a mouse press on the row text would end off the button and the submit would not fire.
  assert.equal(prop('.check:active', 'transform', MOTION), 'none', 'beats the generic button:active scale');
  for (const r of rules) if (r.selectors.some((s) => /\.check(:[a-z-]+)*$/.test(s.trim())) && 'transform' in r.decls) assert.equal(r.decls.transform, 'none', r.selectors.join());
});

test('phone basics: no grey tap flash, no double-tap zoom delay, no text selection on controls, 100dvh not 100vh', () => {
  assert.equal(prop('html', '-webkit-tap-highlight-color'), 'transparent');
  assert.ok(rules.some((r) => r.selectors.includes('summary') && r.decls['touch-action'] === 'manipulation'));
  assert.equal(prop('button', 'user-select'), 'none');
  // Full-height boxes only (the sticky rails' calc(100vh - …) caps stay, their own tests pin them); a rule that writes
  // `height: 100vh; height: 100dvh` parses to its last value, so only a bare 100vh fails.
  for (const r of rules) for (const k of ['height', 'min-height']) assert.notEqual(r.decls[k], '100vh', `${r.selectors.join()} ${k}`);
});

test('pages cross-fade in 160ms with the header held still, and not at all with reduced motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*@view-transition \{ navigation: auto; \}/);
  assert.equal(prop('.top', 'view-transition-name'), 'top');
  assert.equal(prop('::view-transition-old(root)', 'animation-duration', MOTION), '160ms');
  assert.equal(prop('::view-transition-group(top)', 'animation', MOTION), 'none');
});

test('the separator dot belongs to each part and is clipped at a line start; no list rule reaches meta items', () => {
  assert.equal(prop('.meta-line', 'clip-path'), 'inset(0 0 0 1em)');
  assert.equal(prop('.meta-line', 'margin'), '0 0 0 -1em');
  assert.equal(prop('.meta-line > li::before', 'content'), '"·"');
  for (const r of rules) for (const s of r.selectors) if (/\bli(\s*\+\s*li|:first-child|:last-child)/.test(s)) assert.match(s, />\s*li/, `descendant list rule: ${s}`);
});

test('a meta part and a chip cannot widen the page', () => {
  assert.equal(prop('.meta-line > li', 'white-space'), 'nowrap');
  assert.equal(prop('.meta-line > li', 'max-width'), '100%');
  assert.equal(prop('.meta-line > li', 'text-overflow'), 'ellipsis');
  assert.equal(prop('.chip', 'max-width'), '100%'); assert.equal(prop('.chip', 'text-overflow'), 'ellipsis');
});

const fontSizes = () => rules.filter((r) => r.selectors[0] !== ':root').flatMap((r) => [r.decls['font-size'], r.decls.font].filter(Boolean).map((v) => [r.selectors.join(), v!] as const));
test('eight type sizes: every font size in the sheet is a --t token', () => {
  for (const [sel, v] of fontSizes()) assert.match(v, /var\(--t-[a-z]+\)|^inherit$/, `${sel}: ${v}`);
  const px = new Set(['display', 'title', 'section', 'headline', 'prose', 'body', 'sub', 'meta', 'label'].map((t) => parseFloat(prop(':root', `--t-${t}`)!) * 16));
  assert.equal(px.size, 8);
});

test('three radii', () => {
  const ok = /^(var\(--r-(pill|card|inset)\)|50%|0|22px|13px|13px 13px 0 0|0 0 13px 13px|var\(--r-card\) var\(--r-card\) 0 0)$/;
  for (const r of rules) if ('border-radius' in r.decls) assert.match(r.decls['border-radius']!, ok, r.selectors.join());
});

test('every button, tab and chip is a pill; buttons are quiet unless marked primary', () => {
  for (const sel of ['button', '.button', '.chip', '.badge', '.tabs a', '.settings-link']) assert.equal(prop(sel, 'border-radius'), 'var(--r-pill)', sel);
  assert.equal(prop('button', 'background'), 'var(--surface)'); assert.equal(prop('.primary', 'background'), 'var(--primary)');
  assert.equal(prop('.chip', 'height'), '22px');
  assert.equal(prop('.n', 'color'), 'var(--muted)'); assert.equal(prop('.n', 'font-weight'), '500');
  assert.equal(prop('body', 'font-variant-numeric'), 'normal');
});

test('a grouped list draws its hairlines as child pseudo-elements, inset 16px, never box-shadow strips', () => {
  assert.equal(prop('ul.group', 'overflow'), 'hidden'); assert.equal(prop('ul.group', 'border-radius'), 'var(--r-card)');
  assert.equal(prop('ul.group > li + li::before', 'left'), '16px'); assert.equal(prop('ul.group > li + li::before', 'height'), '1px');
  assert.ok(!rules.some((r) => r.selectors.some((s) => /group|\.row/.test(s)) && /inset 0 1px/.test(r.decls['box-shadow'] ?? '')));
});

test('rows are 52px whole links that press to raised; folds rotate their chevron only', () => {
  assert.equal(prop('.row', 'min-height'), '52px'); assert.equal(prop('.row', 'padding'), '12px 16px');
  assert.equal(prop('details.fold > summary', 'list-style'), 'none');
  assert.match(prop('summary .chev', 'transition', MOTION) ?? '', /^transform 160ms/);
});

test('a row\'s text column can shrink and wrap, so a long name never widens the page', () => {
  // A bare 1fr has an automatic minimum of its content width; a 60-character unbroken project name would overflow.
  assert.equal(prop('.row', 'grid-template-columns'), '8px minmax(0, 1fr) auto');
  assert.equal(prop('.row .txt', 'overflow-wrap'), 'anywhere');
});

test('a row that is a button looks and presses like a row, not a pill', () => {
  // The Last-week row is <button class="row">; without this it inherits Task 7's pill, border, fill, centring and scale.
  assert.equal(prop('button.row', 'border'), '0'); assert.equal(prop('button.row', 'background'), 'transparent');
  assert.equal(prop('button.row', 'width'), '100%'); assert.equal(prop('button.row', 'text-align'), 'left');
  assert.equal(prop('button.row', 'border-radius'), '0', 'the group corner rules round it');
  assert.equal(prop('.group > li:first-child > form > button.row', 'border-radius'), '13px 13px 0 0');
  assert.equal(prop('button.row:active', 'transform', MOTION), 'none');
  assert.equal(prop('button.row:active', 'background'), 'var(--raised)');
});

test('every focus ring on a row inside a grouped card is drawn inside it, and the corners follow the card', () => {
  for (const r of rules) for (const s of r.selectors) if (/\.group\b.*:focus-visible/.test(s)) assert.equal(r.decls['outline-offset'], '-2px', s);
  assert.equal(prop('.group > li:first-child > :is(a, .row)', 'border-radius'), '13px 13px 0 0');
  assert.equal(prop('.group > li:only-child > :is(a, .row)', 'border-radius'), '13px');
});

test('a row\'s text runs as one sentence: "<b>ChatGPT</b> suggests…" stays on one line, its sub-lines below', () => {
  // Found in the visual check: a flex column put the bold writer and the rest of the sentence on two lines.
  assert.equal(prop('.row .txt', 'display'), 'block');
  assert.equal(prop('.row .txt > .sub', 'display'), 'block');
});

test('a tick is a 22px circle with the whole 44px row as its target', () => {
  assert.equal(prop('.check', 'width'), '22px');
  assert.equal(prop('.check::before', 'border-radius'), '50%', 'the circle is drawn in ::before, so the press can scale it');
  assert.equal(prop('.checks > li', 'min-height'), '44px'); assert.equal(prop('.checks > li', 'position'), 'relative');
  assert.equal(prop('button.check::after', 'inset'), '0'); assert.equal(prop('.checks > li', 'grid-template-columns'), '22px minmax(0, 1fr) auto');
});

test('only a real check button owns the row', () => {
  // span.check (Done today, whose row holds Undo; the review's done and gone marks) must never get the overlay.
  for (const r of rules) for (const s of r.selectors) if (/::after$/.test(s) && /\.check\b(?!s|-)/.test(s) && 'inset' in r.decls)
    assert.match(s, /\bbutton\.check\b/, `row overlay on a non-button: ${s}`);
  for (const r of rules) for (const s of r.selectors) if (/(^|\s)(button)?\.check$/.test(s.trim())) assert.ok(!('position' in r.decls) && !('transform' in r.decls), `${s} stays static, so the li is the overlay's box`);
});

test('on a phone the open project drops its card frame', () => {
  assert.equal(prop('.ppanel', 'border', '@media (max-width: 760px)'), '0');
  assert.equal(prop('.ppanel', 'background', '@media (max-width: 760px)'), 'transparent');
});

test('arriving at #panel does not ring the whole panel', () => {
  // The panel scrolls on a wide screen, so the browser focuses it on the #panel jump; the ring would frame the panel.
  assert.equal(prop('.ppanel:target:focus-visible', 'outline'), 'none');
});

test('graph buttons and Find use the app\'s sans and pills, 44 points on a phone', () => {
  for (const sel of ['.graph-btn', '.graph-find input']) assert.doesNotMatch(prop(sel, 'font') ?? prop(sel, 'font-family') ?? '', /monospace/, sel);
  assert.equal(prop('.graph-btn', 'border-radius'), 'var(--r-pill)');
  assert.equal(prop('.graph-btn', 'min-height', '@media (max-width: 719px)'), '44px');
});

test('the phone page\'s "On this page" fold is quiet grey, not a bold row', () => {
  // Found in the visual check: the generic fold summary (ink, 16px, 600) outranked the quieter toc-fold rule.
  assert.equal(prop('details.toc-fold > summary', 'color'), 'var(--muted)');
  assert.equal(prop('details.toc-fold > summary', 'font-weight'), '500');
  assert.equal(prop('details.toc-fold > summary', 'font-size'), 'var(--t-sub)');
});

test('the idea box spans the Projects column, as in the mockup', () => {
  // Found in the visual check: a 34rem cap left the field half as wide as the For-you card under it.
  assert.equal(prop('.phome form.idea', 'max-width'), undefined);
});

test('the old feed entries (Settings › Activity, flags) keep their own block recipe, off the grouped-list grid', () => {
  assert.equal(rules.some((r) => r.selectors.some((x) => /\.rows \.row\b/.test(x))), false, 'no rule styles a .row inside .rows');
  assert.equal(prop('.rows .entry', 'border-left'), '3px solid var(--w)');
});

test('in the review, a date chip keeps its red or amber: the quiet chip colour is only for the What moved chips', () => {
  assert.equal(prop('.review .chip', 'color'), undefined, 'a .review .chip colour would come later than .chip.late and win');
  assert.equal(prop('.review .chips .chip', 'color'), 'var(--ink2)');
});

test('a panel discussion is a plain-list row, not a framed card, and only "ready for you" is orange', () => {
  assert.equal(prop('.pdiscs > li', 'border'), undefined);
  assert.equal(prop('.pdiscs > li.open .pdisc-label', 'color'), undefined, 'open is not the same as waiting on you');
  assert.equal(prop('.pdiscs > li.you .pdisc-label', 'color'), 'var(--accent)');
  assert.equal(prop('.pdisc-label', 'color'), 'var(--muted)');
});

test('counts are grey: no amber-filled count pill, since amber means soon (Tidy up, Growth)', () => {
  assert.equal(rules.some((r) => r.selectors.includes('.count')), false, 'the amber .count pill is gone');
  for (const f of ['dashboardViews.ts', 'growthViews.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), /class="count"/, f);
  }
});

test('one fold: no summary draws the native triangle, and every fold shows the one chevron', () => {
  assert.equal(prop('summary', 'list-style'), 'none');
  assert.equal(prop('summary::-webkit-details-marker', 'display'), 'none');
  assert.equal(prop('.chev', 'display'), 'inline-block', 'a chevron in an inline summary still has its size');
  assert.equal(prop('details[open] > summary .chev', 'transform'), 'rotate(45deg)');
  // Summaries drawn as a link ("Ask an AI to update", "Read all") or as a button ("Edit first") read as one; every
  // other summary carries a chevron.
  const views = ['dashboardViews', 'discussionViews', 'factViews', 'graphViews', 'growthViews', 'pageEditViews', 'pageViews', 'projectsViews', 'reviewViews', 'settingsViews', 'searchViews'];
  for (const v of views) {
    const src = readFileSync(new URL(`./${v}.ts`, import.meta.url), 'utf8');
    for (let at = src.indexOf('<summary'); at >= 0; at = src.indexOf('<summary', at + 1)) {
      const summary = src.slice(at, src.indexOf('</summary>', at));
      if (/^<summary class="link"/.test(summary) || summary.includes('class="read-all"') || /^<summary class="button/.test(summary)) continue;
      assert.match(summary, /class="chev"/, `${v}: ${summary.slice(0, 80)}`);
    }
  }
});

test('the rail\'s "N more" related facts fold sits flush with the list above it, at the rail\'s text size', () => {
  assert.equal(prop('.paside .rel-more > summary', 'padding'), '0');
  assert.equal(prop('.paside .rel-more > summary', 'min-height'), '44px');
  assert.equal(prop('.paside .rel-more > summary', 'font-size'), 'var(--t-sub)');
});

test('replaced text, the chain\'s past steps and the Replaced fold\'s grey lines reach 4.5:1 on their backgrounds, in light and dark', () => {
  for (const sel of ['.rlist .old', '.chain li:not(.cur) .txt', '.replaces-box .card p', '.rep .card-link']) {
    const value = prop(sel, 'color');
    assert.ok(value, `${sel} has a colour`);
    for (const [name, p] of Object.entries(palettes)) {
      for (const bg of ['surface', 'raised']) {
        const c = contrast(colour(value, p), colour(`var(--${bg})`, p));
        assert.ok(c >= 4.5, `${name}: ${sel} on --${bg} is ${c.toFixed(2)}:1`);
      }
    }
  }
});

test('the fact that holds NOW reads in ink, in the Replaced fold and in the timeline, while the replaced lines and past steps stay grey', () => {
  // Merged with the "one hand" look: blue is only for links in page text, so the NOW link stands out by ink against grey.
  assert.equal(prop('.rlist .now a', 'color'), 'var(--fg)');
  assert.equal(prop('.rlist .old', 'color'), 'var(--muted)');
  // The timeline: only past steps take the grey of their line; the current fact keeps the global link ink.
  assert.equal(prop('.chain .txt a', 'color'), undefined, 'no rule greys every timeline link');
  assert.equal(prop('.chain li.cur .txt a', 'color'), undefined, 'the current fact is not recoloured');
  assert.equal(prop('.chain li:not(.cur) .txt a', 'color'), 'inherit');
  assert.equal(prop('.chain li:not(.cur) .txt', 'color'), 'var(--muted)');
  for (const [name, p] of Object.entries(palettes)) {
    for (const bg of ['surface', 'raised']) {
      const c = contrast(colour('var(--fg)', p), colour(`var(--${bg})`, p));
      assert.ok(c >= 4.5, `${name}: ink on --${bg} is ${c.toFixed(2)}:1`);
    }
  }
});

test('section 16 meta lines run as one sentence, not a flex row that gaps "You" away from "· 4 Nov"', () => {
  // Found in the visual check: .meta is a wrapping flex row, so "Replaced by", the writer and the day split apart.
  for (const sel of ['.rlist .meta', '.replaces-box .card > .meta', '.chain .meta', '.fact-events .meta']) assert.equal(prop(sel, 'display'), 'block', sel);
});

test('All facts › Show is the direction\'s sub-navigation: 32px pills, the chosen one raised in ink, never black', () => {
  assert.equal(prop('.seg a', 'min-height'), '32px'); assert.equal(prop('.seg a', 'border-radius'), 'var(--r-pill)');
  assert.equal(prop('.seg a', 'color'), 'var(--muted)'); assert.equal(prop('.seg a', 'font-weight'), '500');
  assert.equal(prop('.seg a.on', 'background'), 'var(--raised)'); assert.equal(prop('.seg a.on', 'color'), 'var(--fg)'); assert.equal(prop('.seg a.on', 'font-weight'), '600');
  assert.equal(prop('.seg a', 'min-height', '@media (max-width: 719px)'), '44px', 'a full tap target on a phone');
});

test('Facts quick views light the current pill and the filter stays a compact fold', () => {
  assert.equal(prop('.seg a[aria-current="page"]', 'background'), 'var(--raised)');
  assert.equal(prop('details.fold.filter-fold > summary', 'border-radius'), 'var(--r-pill)');
  assert.equal(prop('details.fold.filter-fold > summary', 'min-height'), '32px');
  assert.equal(prop('details.fold.filter-fold > summary', 'min-height', '@media (max-width: 719px)'), '44px');
});

test('the approval sheet slides up from the bottom of the phone', () => {
  const PHONE = '@media (max-width: 719px)';
  assert.equal(prop('.fy-approval[open] > .approval-card', 'position', PHONE), 'fixed');
  assert.equal(prop('.fy-approval[open] > .approval-card', 'inset', PHONE), 'auto 0 0 0');
  assert.equal(prop('.fy-approval[open] > .approval-card', 'max-height', PHONE), '85dvh');
  assert.equal(prop('.fy-approval[open] > .approval-card', 'border-radius', PHONE), 'var(--r-card) var(--r-card) 0 0');
  assert.equal(prop('.fy-approval[open] > .approval-card', 'background', PHONE), 'var(--elevated)');
  // The scrim is the open row's ::after (a tap on it still toggles the row closed); the row itself stays in the card
  // with its words, dimmed behind the scrim as in the mockup, instead of leaving a blank 52px band.
  assert.equal(prop('.fy-approval[open] > summary::after', 'position', PHONE), 'fixed');
  assert.equal(prop('.fy-approval[open] > summary::after', 'inset', PHONE), '0');
  assert.equal(prop('.fy-approval[open] > summary::after', 'background', PHONE), 'var(--scrim)');
  assert.equal(prop('.fy-approval[open] > summary::after', 'content', PHONE), '""');
  for (const r of rules) if (r.selectors.some((x) => x.startsWith('.fy-approval[open] > summary') && !x.includes('::after'))) {
    assert.ok(!('position' in r.decls), `${r.selectors}: the row stays in the card`);
    assert.ok(!('visibility' in r.decls), `${r.selectors}: the row keeps its words`);
  }
  assert.equal(prop('.fy-approval[open] > .approval-card', 'transition', PHONE), 'transform 320ms cubic-bezier(.32, .72, 0, 1)');
  const start = rules.find((r) => r.media.includes('@starting-style') && r.media.includes('(prefers-reduced-motion: no-preference)') && r.selectors.includes('.fy-approval[open] > .approval-card'));
  assert.ok(start, 'a @starting-style rule inside the motion query');
  assert.equal(start!.decls.transform, 'translateY(100%)');
  assert.equal(prop('.suggestion:has(.edit-first[open]) .proposed', 'display'), 'none');
});

test('Edit first opens its text above the buttons and stays in their row, on the desktop and in the phone sheet', () => {
  const PHONE = '@media (max-width: 719px)';
  assert.equal(prop('.approval-card .edit-text', 'display'), 'none', 'closed, the text is not shown (it still submits)');
  assert.equal(prop('.approval-card form:has(.edit-first[open]) .edit-text', 'display'), 'flex');
  assert.equal(prop('.approval-card form:has(.edit-first[open]) .edit-text', 'grid-row'), '1');
  assert.equal(prop('.approval-card form:has(.edit-first[open]) .edit-text', 'grid-column'), '1 / -1');
  // Desktop: Approve, Edit first, Reject in one row under the text; the open fold never takes a row of its own.
  for (const [sel, col] of [['.approval-card .actions > .primary', '1'], ['.approval-card .edit-first', '2'], ['.approval-card .actions > .ghost', '3']]) {
    assert.equal(prop(sel, 'grid-row'), '2', sel);
    assert.equal(prop(sel, 'grid-column'), col, sel);
  }
  assert.equal(prop('.approval-card .edit-first[open]', 'grid-row'), undefined);
  assert.equal(prop('.approval-card .edit-first[open]', 'grid-row', PHONE), undefined);
  // Phone: Approve full width, then Edit first and Reject sharing one row under it.
  assert.equal(prop('.approval-card .actions > .primary', 'grid-row', PHONE), '2');
  assert.equal(prop('.approval-card .actions > .primary', 'grid-column', PHONE), '1 / -1');
  assert.equal(prop('.approval-card .edit-first', 'grid-row', PHONE), '3');
  assert.equal(prop('.approval-card .actions > .ghost', 'grid-row', PHONE), '3');
  assert.equal(prop('.approval-card .actions > .ghost', 'grid-column', PHONE), '2');
});

test('on the phone, a suggestion\'s and a Went quiet row\'s buttons go under the words, not beside them', () => {
  const PHONE = '@media (max-width: 719px)';
  // .row.nolead (two classes) sets the columns, so a one-class phone rule lost to it and the words were squeezed to ~110px.
  assert.equal(prop('.row.fy-sug', 'grid-template-columns', PHONE), 'minmax(0, 1fr)');
  assert.equal(prop('.row.rv-quiet', 'grid-template-columns', PHONE), '8px minmax(0, 1fr)');
  assert.equal(prop('.row.rv-quiet > :last-child', 'grid-column', PHONE), '2');
  for (const r of rules) if (r.media === PHONE && r.selectors.includes('.fy-sug')) assert.ok(!('grid-template-columns' in r.decls), 'no one-class rule that .row.nolead overrides');
});

// ---- The iPhone bars (Task 15) ----

const PHONE = '@media (max-width: 719px)';

test('the tab bar is pinned to the bottom of the phone, safe-area aware', () => {
  assert.equal(prop('.tabs', 'position', PHONE), 'fixed');
  assert.equal(prop('.tabs', 'bottom', PHONE), '0');
  assert.match(prop('.tabs', 'padding-bottom', PHONE)!, /env\(safe-area-inset-bottom\)/);
  assert.equal(prop('.tabs', 'grid-template-columns', PHONE), 'repeat(4, 1fr)');
  assert.equal(prop('.tabs a', 'height', PHONE), '32px');
  assert.equal(prop('.tabs a', 'color', PHONE) ?? prop('.tabs a', 'color'), 'var(--ink2)');
  assert.equal(prop(':root', '--tabbar', PHONE), '49px');
  assert.equal(prop('main', 'padding-bottom', PHONE), 'calc(var(--tabbar) + env(safe-area-inset-bottom) + 24px)');
});
test('nothing above the tab bar or the sheet traps a fixed box', () => {   // Review Focus 1
  assert.equal(prop('.top', 'backdrop-filter', PHONE), 'none');
  assert.equal(prop('.top', '-webkit-backdrop-filter', PHONE), 'none');
  for (const r of rules) if (r.selectors.some((s) => /^(\.top|main|\.phome|\.plist|ul\.group|\.group|\.foryou)$/.test(s)))
    for (const k of ['transform', 'filter', 'will-change', 'contain']) assert.ok(!(k in r.decls) || r.decls[k] === 'none', `${r.selectors} ${k}`);
});
test('the tab bar hides while typing', () => {   // Review Focus 4
  const hide = rules.find((r) => r.media.includes(PHONE) && r.selectors.some((s) => s.includes(':has(') && s.includes(':focus') && s.endsWith('.tabs')));
  assert.equal(hide?.decls.visibility, 'hidden');
});
test('the phone header is one slim row', () => {
  assert.equal(prop('.top', 'flex-wrap', PHONE), 'nowrap');
  assert.equal(prop('.settings-word', 'display', PHONE), 'none');
  assert.equal(prop('.settings-link .cog', 'display', PHONE), 'block');
  assert.equal(prop('.top-back', 'display', PHONE), 'inline-flex');
  assert.equal(prop('.top:has(.top-back) .brand', 'display', PHONE), 'none');
  assert.equal(prop('.crumb.back', 'display', PHONE), 'none');
});
test('the phone back link is bold ink with a drawn chevron, as the approved mockup: the only way back in the app', () => {
  assert.equal(prop('.top-back', 'color', PHONE), 'var(--fg)');
  assert.equal(prop('.top-back', 'font-size', PHONE), 'var(--t-body)');
  assert.equal(prop('.top-back', 'font-weight', PHONE), '600');
  assert.equal(prop('.top-back::before', 'content'), '""', 'a drawn chevron, not a small text ‹');
  assert.equal(prop('.top-back::before', 'border-left'), '2px solid currentColor');
  assert.equal(prop('.top-back::before', 'border-bottom'), '2px solid currentColor');
});
test('the search box clear button is a muted x, never the browser blue', () => {
  const sel = '.find input::-webkit-search-cancel-button';
  assert.equal(prop(sel, '-webkit-appearance'), 'none', 'the native (blue in light mode) button is replaced');
  assert.match(prop(sel, 'background') ?? '', /var\(--muted\)/);
  assert.doesNotMatch(prop(sel, 'background') ?? '', /url\(/, 'no image: the CSP allows none from data:');
});
test('the back label never squeezes the search box', () => {   // Review Focus 5
  assert.equal(prop('.top-back span', 'max-width', PHONE), '7.5rem');
  assert.equal(prop('.top-back span', 'text-overflow', PHONE), 'ellipsis');
  assert.equal(prop('.find', 'min-width', PHONE), '0');
});
test('Cancel and the two pointers show only while searching', () => {
  assert.equal(prop('.find-hints', 'display'), 'none');
  assert.equal(prop('.find:focus-within:has(input:placeholder-shown) .find-hints', 'display'), 'grid');
  assert.equal(prop('.find-cancel', 'display'), 'none');
  assert.equal(prop('html.js .top:has(.find:focus-within) .find-cancel', 'display', PHONE), 'inline-flex');
  assert.equal(prop('.top:has(.find:focus-within) .settings-link', 'display', PHONE), 'none');
  assert.equal(prop('.top:has(.find:focus-within) :is(.brand, .top-back)', 'display', PHONE), 'none');
});
test('the pointers float under the search box instead of growing the header', () => {
  assert.equal(prop('.find', 'position'), 'relative');
  assert.equal(prop('.find-hints', 'position'), 'absolute');
  assert.equal(prop('.find-hints', 'top'), 'calc(100% + 6px)');
  assert.equal(prop('.find-hints', 'left'), '0');
  assert.equal(prop('.find-hints', 'right'), '0');
  assert.equal(prop('.find-hints', 'z-index'), '1');
  assert.equal(prop('.find-hints', 'background'), 'var(--elevated)');
  assert.equal(prop('.find-hints', 'border'), '1px solid var(--line)');
  assert.equal(prop('.find-hints', 'border-radius'), 'var(--r-card)');
  assert.equal(prop('.find-hints', 'box-shadow'), 'var(--shadow-pop)');
});
test('the bars stay still while screens cross-fade', () => {
  assert.equal(prop('.tabs', 'view-transition-name', PHONE), 'tabbar');
  // ::view-transition-group(tabbar), -old, -new: animation none (inside the existing motion block)
});
test('tab labels keep their contrast over the 96% bar', () => {
  for (const p of Object.values(palettes)) {
    const under = mix(rgb(p.bg!), rgb(p.primary!), 0.96);
    assert.ok(contrast(rgb(p.ink2!), under) >= 9, 'inactive');
    assert.ok(contrast(rgb(p['primary-fg']!), rgb(p.primary!)) >= 7, 'active');
  }
});

test('the approval sheet touches the screen edges, and its form stacks Approve over Edit first and Reject', () => {
  const PHONE = '@media (max-width: 719px)';
  // A margin on a fixed box offsets it from its inset: the sheet floated 12px above the bottom with the tab bar showing.
  assert.equal(prop('.fy-approval[open] > .approval-card', 'margin', PHONE), '0');
  // The Projects home makes its forms inline-flex rows; the card's form is its own grid:
  // Approve, Edit first, Reject pushed right (the mockup's After card), and on the phone Approve full width over the other two.
  assert.equal(prop('.approval-card form', 'display'), 'grid');
  assert.equal(prop('.approval-card .actions', 'display'), 'contents');
  assert.equal(prop('.approval-card .actions > .ghost', 'justify-self'), 'end');
  assert.equal(prop('.approval-card .actions > .primary', 'grid-column', PHONE), '1 / -1');
  for (const r of rules) if (r.selectors.some((x) => x.includes('.edit-first') && x.includes('summary'))) assert.ok(!('margin-bottom' in r.decls), 'Edit first sits on Reject\'s line');
});

test('the Facts quick views stay a quiet pill row on the phone; only the Show control stretches', () => {
  const PHONE = '@media (max-width: 719px)';
  assert.equal(prop('.seg a', 'flex', PHONE), undefined);
  assert.equal(prop('.seg-field .seg a', 'flex', PHONE), '1');
  assert.equal(prop('.seg a', 'white-space'), 'nowrap');
});
test('the Tidy line is its own quiet paragraph with a findable link', () => {
  assert.equal(prop('.tidy-line', 'margin'), '0.75rem 0 1rem');
  assert.equal(prop('.tidy-line a', 'font-weight'), '600');
});
test('the desktop back crumb lines up with a reading column', () => {
  assert.equal(prop('.crumb.back:has(+ .narrow)', 'max-width'), '46rem');
  assert.equal(prop('.crumb.back:has(+ .wide-narrow)', 'max-width'), '58rem');
});
test('the panel\'s All facts and graph rows line up with its headings and Manage', () => {
  assert.equal(prop('.ppanel > a.row', 'padding-inline'), '0');
});

test('the phone Settings index reads label left, status right, on one line (the mockup\'s After)', () => {
  assert.equal(prop('.settings-index .row', 'grid-template-columns'), 'minmax(0, 1fr) auto auto');
  assert.equal(prop('.settings-index .st', 'grid-column'), '2');
  assert.equal(prop('.settings-index .st', 'grid-row'), '1');
});

test('the out-of-date line uses the attention colour and tokens only, never red, and its actions are 44 px on the phone', () => {
  const stale = rules.filter((r) => r.selectors.some((s) => /\.stale|\.checked-line|\.ask-line/.test(s)));
  assert.ok(stale.length > 5, 'the line has its rules');
  for (const r of stale) {
    for (const [k, v] of Object.entries(r.decls)) {
      assert.doesNotMatch(v, /#[0-9a-f]{3,6}\b|rgb\(/i, `${r.selectors.join(', ')} ${k}: no raw colours`);
      assert.doesNotMatch(v, /var\(--error\)/, `${r.selectors.join(', ')} ${k}: never red`);
    }
  }
  assert.match(prop('.stale', 'border') ?? '', /var\(--attention\)/);
  assert.equal(prop('.stale', 'border-radius'), 'var(--r-card)');
  assert.equal(prop('.stale b', 'color'), 'var(--attention)');
  assert.equal(prop('.stale-dot', 'background'), 'var(--attention)');
  assert.equal(prop('.stale > summary', 'min-height'), '44px');
  assert.equal(prop('.checked-line', 'border-radius'), 'var(--r-inset)');
  const phone = '@media (max-width: 760px)';
  const big = rules.find((r) => r.media === phone && r.selectors.includes('.stale-foot form > button'));
  assert.equal(big?.decls['min-height'], '44px');
  assert.equal(big?.decls.width, '100%');
  assert.ok(rules.some((r) => r.media === phone && r.selectors.includes('.ask-line > summary') && r.decls.width === '100%'));
  assert.equal(prop('.checked-line button', 'min-height', phone), '44px', 'Undo is a 44 px target on the phone');
  assert.equal(prop('.stale > summary', 'align-items'), 'baseline', 'a wrapped reason lines up with the label');
});

/**
 * The margin-top an element gets from the rules outside @media that name it by a plain compound selector (a tag and
 * classes, no combinators): the most specific wins, then the later one; `margin` counts as setting the top.
 */
function marginTop(tag: string, classes: string[]): string | undefined {
  let best: { spec: number; v: string } | undefined;
  for (const r of rules) {
    if (r.media !== '') continue;
    const v = r.decls['margin-top'] ?? r.decls['margin']?.split(/\s+/)[0];
    if (v === undefined) continue;
    for (const s of r.selectors) {
      const m = /^([a-z]*)((?:\.[\w-]+)+)$/.exec(s);
      if (!m || (m[1] && m[1] !== tag)) continue;
      const cls = m[2]!.slice(1).split('.');
      if (!cls.every((c) => classes.includes(c))) continue;
      const spec = cls.length * 10 + (m[1] ? 1 : 0);
      if (!best || spec >= best.spec) best = { spec, v };
    }
  }
  return best?.v;
}

test('the Pages tab fold card keeps its gap from the card above it, not the grouped list reset', () => {
  assert.equal(marginTop('ul', ['group']), '0');
  assert.equal(marginTop('ul', ['group', 'nopage-group']), '1rem');
});
