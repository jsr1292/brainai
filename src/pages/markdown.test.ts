import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionItems, diagramBlocks, findLinks, imageIdsIn, linkDefinitions, plainText, renderInline, renderMarkdown, replaceSection, splitSections, type LinkResolver, type PictureLookup } from './markdown.js';

const none: LinkResolver = () => null;
const md = (s: string) => renderMarkdown(s, none).value;

test('splitSections: lead, ## and ### sections with their anchors, a # heading counts as ##', () => {
  const body = 'Intro line.\n\n## What it does\nIt remembers.\n\n### Kinds\nFour kinds.\n\n# Big heading\nText.';
  const s = splitSections(body);
  assert.deepEqual(s.map((x) => [x.anchor, x.heading, x.level]), [
    ['top', '', 1], ['what-it-does', 'What it does', 2], ['kinds', 'Kinds', 3], ['big-heading', 'Big heading', 2],
  ]);
  assert.equal(s[0].text.trim(), 'Intro line.');
  assert.equal(s[1].text.trim(), 'It remembers.');
  assert.deepEqual([s[1].start, s[1].end], [2, 5]);
  assert.equal(splitSections('## Only\nx')[0].anchor, 'only');
  assert.equal(splitSections('   \n\n## Only\nx').length, 1, 'a blank lead is not a section');
});

test('anchors: accents and punctuation become a slug, repeats get -2, an empty heading becomes section, top is reserved', () => {
  const s = splitSections('## Café & Co.\na\n## Notes\nb\n## Notes\nc\n## !!!\nd\n## Top\ne');
  assert.deepEqual(s.map((x) => x.anchor), ['cafe-co', 'notes', 'notes-2', 'section', 'top-2']);
});

test('anchors keep letters and digits of any script, so a section in Cyrillic or CJK keeps its anchor when one is added above', () => {
  assert.deepEqual(splitSections('## Цены\na\n## Адрес\nb').map((x) => x.anchor), ['цены', 'адрес']);
  assert.deepEqual(splitSections('## Новое\nn\n## Цены\na\n## Адрес\nb').map((x) => x.anchor), ['новое', 'цены', 'адрес']);
  assert.deepEqual(splitSections('## 価格 2026\na\n## Ελλάδα\nb\n## 🚀\nc').map((x) => x.anchor), ['価格-2026', 'ελλαδα', 'section']);
  for (const s of splitSections('## Цены_и_даты\na\n## Notes\nb')) assert.doesNotMatch(s.anchor, /_/, 'never an underscore: the notes panel id has one');
});

test('a heading inside a code fence does not split a section', () => {
  const body = '## Run\nStart it:\n```sh\n## not a heading\nnpm start\n```\n~~~\n### nor this\n~~~\nDone.\n## Next\nx';
  const s = splitSections(body);
  assert.deepEqual(s.map((x) => x.anchor), ['run', 'next']);
  assert.match(s[0].text, /## not a heading[\s\S]*### nor this[\s\S]*Done\./);
  const replaced = replaceSection(body, 'next', '## Next\ny')!;
  assert.match(replaced, /```sh\n## not a heading\nnpm start\n```/);
  assert.deepEqual(splitSections(replaced).map((x) => x.anchor), ['run', 'next']);
});

test('replaceSection replaces one section, heading included; empty text removes it; an unknown anchor gives undefined', () => {
  const body = 'Lead.\n\n## A\nOne.\n\n## B\nTwo.\n';
  const r = replaceSection(body, 'a', '## A, renamed\nUno.')!;
  assert.deepEqual(splitSections(r).map((x) => [x.anchor, x.text.trim()]), [['top', 'Lead.'], ['a-renamed', 'Uno.'], ['b', 'Two.']]);
  const gone = replaceSection(body, 'b', '   ')!;
  assert.deepEqual(splitSections(gone).map((x) => x.anchor), ['top', 'a']);
  const lead = replaceSection(body, 'top', 'New lead.')!;
  assert.equal(splitSections(lead)[0].text.trim(), 'New lead.');
  assert.equal(replaceSection(body, 'nope', 'x'), undefined);
});

test('findLinks finds [[Title]] and [[fact:id]] once each, not inside code', () => {
  const body = 'See [[brainai — shared memory]] and [[fact:abc-123]].\nAgain [[brainai — shared memory]].\n`[[In code]]`\n```\n[[In fence]]\n```\n[[wildlog]]';
  assert.deepEqual(findLinks(body), [
    { kind: 'title', target: 'brainai — shared memory' }, { kind: 'fact', target: 'abc-123' }, { kind: 'title', target: 'wildlog' },
  ]);
});

test('findLinks skips [[links]] in code spans of any backtick length, as the page shows them', () => {
  const body = 'A ``[[Double]]`` span, a ``` `[[Triple]]` ``` span and `` a ` [[Inner]] `` too.\nBut [[Real]] and `x` [[After code]].';
  assert.deepEqual(findLinks(body), [{ kind: 'title', target: 'Real' }, { kind: 'title', target: 'After code' }]);
  for (const name of ['Double', 'Triple', 'Inner']) assert.doesNotMatch(md(body), new RegExp(`wikilink[^>]*>${name}`), name);
});

test('raw HTML is shown as text', () => {
  const out = md('<details><summary>x</summary>y</details>\n\nLine<br>break\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nInline <b onclick="x()">b</b>');
  assert.match(out, /&lt;details&gt;/);
  assert.match(out, /&lt;br&gt;/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out, /<script|<img src="x"|<b onclick|<details/);
  assert.doesNotMatch(out, /<[^>]*\son\w+=/, 'no event attribute inside a real tag');
  assert.match(out, /<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/, 'a raw HTML block reads as its own paragraph');
});

test('only safe links keep their href', () => {
  assert.match(md('[a](https://x.example)'), /<a href="https:\/\/x\.example">a<\/a>/);
  assert.match(md('[b](/pages/1)'), /<a href="\/pages\/1">b<\/a>/);
  assert.match(md('[c](#top)'), /<a href="#top">c<\/a>/);
  for (const bad of ['[d](javascript:alert(1))', '[e](JaVaScRiPt:alert(1))', '[f](javascript&#58;alert(1))', '[g](data:text/html,x)', '[h](//evil.example)', '[i](/\\evil.example)', '[j](</\t/evil.example>)', '[k][r]\n\n[r]: javascript:alert(1)']) {
    const out = md(bad);
    assert.doesNotMatch(out, /<a /, bad);
    assert.match(out, /[defghijk]/, bad);
  }
  assert.doesNotMatch(md('<javascript:alert(1)>'), /href=/);
});

test('images only from the brain', () => {
  assert.match(md('![x](/static/icon.svg)'), /<img src="\/static\/icon\.svg" alt="x">/);
  const out = md('![y](https://evil.example/t.png)');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /y/);
  assert.doesNotMatch(md('![z](//evil.example/t.png)'), /<img/);
});

test('output uses only the allowed elements and no style or on* attributes', () => {
  const doc = [
    '## Heading', '#### Small', 'Para with **bold**, *em*, `code`, ~~gone~~ and a [link](https://x.example "t").', '',
    '> quoted', '', '- one', '  - nested', '- two', '', '3. three', '4. four', '', '- [x] done task', '', '```js', 'const a = 1;', '```', '',
    '| A | B |', '|:--|--:|', '| 1 | 2 |', '', '---', '', 'Line one  ', 'line two', '', '![i](/static/icon.svg)',
  ].join('\n');
  const out = md(doc);
  const allowed = new Set('p h2 h3 h4 ul ol li strong em code pre blockquote a table thead tbody tr th td hr br del img'.split(' '));
  const attrs = new Set(['href', 'src', 'alt', 'title', 'class', 'id', 'start', 'tabindex']);
  for (const m of out.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(allowed.has(m[1].toLowerCase()), `tag ${m[1]}`);
    for (const a of m[2].matchAll(/\s([a-zA-Z-]+)(=|\s|$)/g)) assert.ok(attrs.has(a[1].toLowerCase()), `attribute ${a[1]} on ${m[1]}`);
  }
  assert.match(out, /<table tabindex="0">/);
  assert.match(out, /<del>gone<\/del>/);
  assert.match(out, /<h3>Heading<\/h3>/);
  assert.match(out, /<h4>Small<\/h4>/);
});

test('[[links]] use the resolver; unresolved ones show as missing text', () => {
  const resolve: LinkResolver = (t) => (t === 'wildlog' ? { href: '/?project=wildlog#panel', label: 'wildlog' } : t === 'fact:f1' ? { href: '/memories/f1', label: 'Uses SQLite' } : null);
  const out = renderMarkdown('Go to [[wildlog]], see [[fact:f1]], and [[Nowhere <b>]].', resolve).value;
  assert.match(out, /<a class="wikilink" href="\/\?project=wildlog#panel">wildlog<\/a>/);
  assert.match(out, /<a class="wikilink" href="\/memories\/f1">Uses SQLite<\/a>/);
  assert.match(out, /<span class="wikilink missing">Nowhere &lt;b&gt;<\/span>/);
  assert.match(renderInline('**[[wildlog]]**', resolve).value, /<strong><a class="wikilink"/);
});

test('decisionItems reads dated items, marks fact links, and gives null when any item has no date', () => {
  const items = decisionItems('- 2026-10-18 **OAuth only.** Every client accepts it. [[fact:f1]]\n- 2026-10-21 Off-site backups.\n  Continued line.', (t) => (t === 'fact:f1' ? { href: '/memories/f1', label: 'OAuth fact' } : null))!;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.date, i.factLinked]), [['2026-10-18', true], ['2026-10-21', false]]);
  assert.match(items[0].html.value, /<strong>OAuth only\.<\/strong>/);
  assert.match(items[1].html.value, /Continued line/);
  assert.match(items[0].html.value, /<a class="wikilink" href="\/memories\/f1">OAuth fact<\/a>/);
  assert.equal(decisionItems('- 2026-10-18 dated\n- not dated'), null);
  assert.equal(decisionItems('Just a paragraph.'), null);
});

test('plainText strips only Markdown markers: paths, identifiers and symbols in code or words stay as written', () => {
  assert.equal(plainText('Set `MEMORY_MODE=work` and `PUBLIC_URL`; config in `~/.config/brain_env`. Run `ls -la > out.txt` then a->b, 2 * 3', 300),
    'Set MEMORY_MODE=work and PUBLIC_URL; config in ~/.config/brain_env. Run ls -la > out.txt then a->b, 2 * 3');
  assert.equal(plainText('The repo is ~/Projects/wildlog, file brain_env, snake_case_name.', 300), 'The repo is ~/Projects/wildlog, file brain_env, snake_case_name.');
  assert.equal(plainText('> Quoted line\n**Bold**, __strong__, *it*, _em_ and ~~gone~~.\n* item one\n- item two', 300), 'Quoted line Bold, strong, it, em and gone. item one item two');
  assert.equal(plainText('Code `[not a link](x)` and ``a `tick` b``.', 300), 'Code [not a link](x) and a `tick` b.');
});

test('plainText strips Markdown and cuts at a word boundary', () => {
  assert.equal(plainText('## Hi\n**Bold** and [a link](https://x.example), `code`, [[wildlog]].', 200), 'Hi Bold and a link, code, wildlog.');
  const cut = plainText('alpha beta gamma delta epsilon', 16);
  assert.equal(cut, 'alpha beta…');
});

test('a fence closes only on a plain fence at least as long as the opening one', () => {
  const body = '## Example\n````markdown\n## not a section\n```sh\nnpm start\n```\n### nor this\n````\nAfter.\n## Next\nx\n## Tilde\n~~~\n~~~js\n## inside\n~~~\n## Last\ny';
  assert.deepEqual(splitSections(body).map((s) => s.anchor), ['example', 'next', 'tilde', 'last']);
});

test('a heading keeps a trailing # that is part of a word; a closing run after a space is dropped', () => {
  assert.deepEqual(splitSections('## C#\na\n## Use F# and C#\nb\n## Closed ##\nc\n### Also closed ###   \nd').map((s) => s.heading), ['C#', 'Use F# and C#', 'Closed', 'Also closed']);
});

test('reference definitions anywhere on the page serve every section', () => {
  const body = 'See [docs][1] and [the site][site].\n\n## Later\nMore.\n\n[1]: https://docs.example\n[site]: /pages/abc "Site"\n[bad]: javascript:alert(1)';
  const defs = linkDefinitions(body);
  const lead = renderMarkdown(`${splitSections(body)[0]!.text}\n\n${defs}`, none).value;
  assert.match(lead, /<a href="https:\/\/docs\.example">docs<\/a>/);
  assert.match(lead, /<a href="\/pages\/abc" title="Site">the site<\/a>/);
  assert.doesNotMatch(linkDefinitions('```\n[x]: https://in.fence\n```'), /in\.fence/);
  assert.doesNotMatch(renderMarkdown(`[b][bad]\n\n${defs}`, none).value, /href="javascript/);
});

test('decisionItems reads Outline\'s bold-date items', () => {
  const items = decisionItems('* **2026-11-03 — Outline instead of AFFiNE.** Because it has an API.\n* **2026-11-03 (morning) — Stays separate.** *Superseded.*\n- 2026-11-04 Plain dated item.')!;
  assert.deepEqual(items.map((i) => i.date), ['2026-11-03', '2026-11-03', '2026-11-04']);
  assert.match(items[0].html.value, /^<strong>Outline instead of AFFiNE\.<\/strong> Because it has an API\.$/);
  assert.match(items[1].html.value, /^\(morning\) <strong>Stays separate\.<\/strong> <em>Superseded\.<\/em>$/);
  assert.equal(decisionItems('* **Not dated — x.** y'), null);
});

test('decisionItems reads "**Title** (date)" items and ignores a hyphenated build name', () => {
  const items = decisionItems('* **OAuth only** (2026-10-18). Every client accepts it.\n* **Owner-approved profile** (2026-10-18): one bad entry spreads.')!;
  assert.deepEqual(items.map((i) => i.date), ['2026-10-18', '2026-10-18']);
  assert.match(items[0].html.value, /^<strong>OAuth only<\/strong>\. Every client accepts it\.$/);
  assert.equal(decisionItems('* **2026-11-03-rc1 build.** text'), null);
});

test('code blocks and tables can be reached with Tab, so a keyboard can scroll their hidden part sideways', () => {
  // Both are sideways scroll boxes on a page (.art pre, .art table). Safari does not focus a scroll box on its own.
  const out = md(['```', 'a very long line', '```', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'Inline `<pre>` and <table> stay text.'].join('\n'));
  assert.match(out, /<pre tabindex="0"><code>a very long line/);
  assert.match(out, /<table tabindex="0">\n<thead>/);
  assert.equal(out.match(/tabindex/g)?.length, 2, 'only the real code block and table');
  assert.match(out, /<code>&lt;pre&gt;<\/code> and &lt;table&gt; stay text\./);
});

test('plainText stays fast on a full-size page full of unclosed emphasis or code markers', () => {
  for (const unit of [' _a', ' *a', ' **a', ' __a', ' ~~a', ' `a', ' ``a']) {
    const md = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
    const t0 = performance.now();
    plainText(md, 200);
    const ms = performance.now() - t0;
    assert.ok(ms < 150, `${JSON.stringify(unit)} took ${Math.round(ms)} ms`);
  }
});

test('a link to a replaced fact keeps working and gets a replaced marker', () => {
  const resolve: LinkResolver = (t) => (t === 'fact:a' ? { href: '/memories/a', label: 'Old way', replacedHref: '/memories/b' } : null);
  assert.match(renderMarkdown('See [[fact:a]].', resolve).value, /<a class="wikilink" href="\/memories\/a">Old way<\/a> <a class="fact-replaced" href="\/memories\/b">replaced<\/a>/);
});

test('timeline items name the facts they link to', () => {
  const items = decisionItems('- **2026-10-19 — Bottles by region.** [[fact:abc]]\n- 2026-10-12 Offline first.');
  assert.deepEqual(items!.map((i) => i.factIds), [['abc'], []]);
  assert.deepEqual(decisionItems('- 2026-10-19 Two. [[fact:a]] and [[fact:b]], again [[fact:a]]')!.map((i) => i.factIds), [['a', 'b']]);
});

test('imageIdsIn: distinct picture ids in body order, following Markdown (no code blocks, reference images count)', () => {
  const id = '0123456789abcdef01234567', id2 = 'fedcba9876543210fedcba98';
  assert.deepEqual(imageIdsIn(`![a](/images/${id}.png) ![b](/images/${id}.png "t") ![c](/images/ABC.png) ![d](https://x/y.png)`), [id]);
  assert.deepEqual(imageIdsIn('```\n![a](/images/' + id + '.png)\n```\n'), []);
  assert.deepEqual(imageIdsIn(`![a][r]\n\n[r]: /images/${id2}.jpg`), [id2]);
  assert.deepEqual(imageIdsIn(`![a](/images/${id}.jpg?x) ![b](/images/${id}.svg)`), []);
});

// ---- Pictures and diagrams (round 2 section 12) ----

const LIVE = '0123456789abcdef01234567', GONE = 'fedcba9876543210fedcba98';
const picture = (id: string, o: Partial<{ removedAt: string | null; createdBy: string; bytes: number }> = {}) => ({
  id, type: 'jpeg' as const, ext: 'jpg', bytes: o.bytes ?? 412 * 1024, width: 1179, height: 2556, frames: 1, alt: 'x',
  createdAt: '2026-11-03T10:00:00.000Z', createdBy: o.createdBy ?? 'owner', pageId: null, removedAt: o.removedAt ?? null, removedBy: null,
});
const lookup: PictureLookup = (id) => (id === LIVE ? picture(LIVE) : id === GONE ? picture(GONE, { removedAt: '2026-11-04T15:00:00.000Z' }) : undefined);
const noLinks: LinkResolver = () => null;
const pmd = (s: string, p: PictureLookup | undefined = lookup) => renderMarkdown(s, noLinks, p).value;

test('a picture alone in a paragraph is a figure; its title is the caption, with who added it, its pixels and size', () => {
  assert.equal(pmd(`![Cellar list](/images/${LIVE}.jpg "The cellar list after the October redesign.")`),
    `<figure id="pic-${LIVE}"><div class="frame"><a class="pic" href="/images/${LIVE}.jpg"><img src="/images/${LIVE}.jpg" alt="Cellar list" width="1179" height="2556" loading="lazy" decoding="async"></a></div>`
    + `<figcaption><b>The cellar list after the October redesign.</b><span class="pic-meta">Added by you · 1179 × 2556 · 412 KB</span></figcaption></figure>\n`);
  const plain = pmd(`![Cellar list](/images/${LIVE}.jpg)`);
  assert.match(plain, /^<figure id="pic-/);
  assert.doesNotMatch(plain, /figcaption|>Cellar list</);
  assert.match(renderMarkdown(`![a](/images/${LIVE}.jpg "T")`, noLinks, () => picture(LIVE, { createdBy: "Claude Code", bytes: 3.1 * 1048576 })).value, /Added by Claude Code · 1179 × 2556 · 3\.1 MB/);
});

test('a picture inside a sentence stays inline; unknown and deleted pictures say so instead of breaking', () => {
  const inline = pmd(`See ![a](/images/${LIVE}.jpg) here.`);
  assert.match(inline, /^<p>See <a class="pic" href="\/images\/0123456789abcdef01234567\.jpg"><img [^>]*width="1179" height="2556"[^>]*><\/a> here\.<\/p>/);
  assert.doesNotMatch(inline, /<figure/);
  assert.match(pmd(`![a lost one](/images/${'1'.repeat(24)}.jpg)`), /<span class="pic-missing">Missing picture: a lost one<\/span>/);
  assert.match(pmd(`![gone](/images/${GONE}.jpg)`), /<span class="pic-gone">This picture was deleted on 4 Nov 2026<\/span>/);
  assert.match(pmd(`![a](/images/${LIVE}.png)`), /Missing picture: a/, 'the wrong extension');
  assert.match(renderMarkdown(`![a](/images/${LIVE}.jpg)`, noLinks).value, /Missing picture: a/, "no lookup");
});

test('only the brain\'s pictures and /static files become images; anything else is its description as text', () => {
  for (const src of ['/images/../memory.db', '/images/abc.jpg', 'javascript:alert(1)', `/images/${LIVE}.jpg?x`, '//evil.example/x.png', '/static/../memory.db', 'https://evil.example/x.png']) {
    const out = pmd(`![desc](${src})`);
    assert.doesNotMatch(out, /<img/, src);
    assert.match(out, /desc/, src);
  }
  assert.match(pmd('![icon](/static/icons/icon-192.png)'), /<img src="\/static\/icons\/icon-192\.png" alt="icon">/);
  assert.doesNotMatch(pmd('![icon](/static/icons/icon-192.png)'), /figure|class="pic"/);
  const long = pmd(`![${'<script>'.repeat(1250)}](/images/${LIVE}.jpg)`);
  assert.doesNotMatch(long, /<script>/);
});

test('a mermaid block is a diagram box holding its text; other code blocks are unchanged', () => {
  assert.equal(pmd('```mermaid\nflowchart TD\n a-->b\n```'), '<div class="diagram"><pre class="diagram-src"><code>flowchart TD\n a--&gt;b\n</code></pre></div>\n');
  assert.match(pmd('```js\nlet a = 1;\n```'), /^<pre tabindex="0"><code class="language-js">/);
});

test('plainText says (diagram) for a whole mermaid block', () => {
  assert.equal(plainText('Intro\n\n```mermaid\nflowchart TD\n a[Label photo]-->b\n```\n\nAfter', 200), 'Intro (diagram) After');
  assert.equal(plainText('Intro\n\n~~~mermaid\nsequenceDiagram\n A->>B: hi\n', 200), 'Intro (diagram)');
});

test('diagramBlocks lists the mermaid blocks in order with their kind and line count', () => {
  const body = '```mermaid\nflowchart TD\n a-->b\n```\n\n```js\nx\n```\n\n- item\n\n  ```mermaid\n  %% a comment\n  sequenceDiagram\n  A->>B: hi\n  ```\n\n```mermaid\n---\ntitle: T\n---\npie\n "a": 1\n```';
  assert.deepEqual(diagramBlocks(body).map((b) => [b.index, b.kind, b.lines]), [[0, 'flowchart', 2], [1, 'sequenceDiagram', 3], [2, 'pie', 5]]);
});

test('a picture address written with entities is not a picture: drawing and counting always agree', () => {
  const encoded = `![a](/images/&#x30;123456789abcdef01234567.jpg)`;
  assert.doesNotMatch(pmd(encoded), /<img|class="pic"/);
  assert.deepEqual(imageIdsIn(encoded), []);
});
