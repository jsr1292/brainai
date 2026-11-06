/* diagrams.js, drawing diagrams in a page: its pure helpers run in node; the page part runs only in setUpDiagrams. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const d = await import(new URL('./static/diagrams.js', import.meta.url).href);

test('the colours sent to the frame come from the page\'s own variables, with a full palette for the theme', () => {
  const css: Record<string, string> = { '--surface': '#ffffff', '--raised': '#f4f1ea', '--line': '#e6e2d9', '--line-strong': '#d6d1c5', '--fg': '#1c1b19', '--muted': '#6b675f', '--ink2': '#3a3833' };
  const v = d.themeVars((name: string) => css[name] ?? '', false);
  assert.deepEqual([v.surface, v.raised, v.line, v.lineStrong, v.fg, v.muted, v.ink2, v.dark], ['#ffffff', '#f4f1ea', '#e6e2d9', '#d6d1c5', '#1c1b19', '#6b675f', '#3a3833', false]);
  assert.equal(v.palette.length, 12);
  const dark = d.themeVars((name: string) => css[name] ?? '', true);
  assert.equal(dark.dark, true);
  assert.notDeepEqual(dark.palette, v.palette);
});

test('a diagram fits the width it has, never grows, and is too small to read under 62%', () => {
  assert.ok(Math.abs(d.fitScale(976, 358) - 358 / 976) < 1e-9);
  assert.equal(d.tooSmall(d.fitScale(976, 358)), true);
  assert.equal(d.fitScale(500, 700), 1);
  assert.equal(d.tooSmall(0.62), false);
  assert.equal(d.fitScale(0, 700), 1);
});

test('Mermaid\'s messages become one plain sentence', () => {
  const seq = "Parse error on line 4:\n...equenceDiagram  A B: hi\n----------------------^\nExpecting '()', 'SOLID_OPEN_ARROW', 'DOTTED_OPEN_ARROW', 'SOLID_ARROW'";
  assert.equal(d.reword(seq, 'sequenceDiagram'), "This diagram couldn't be drawn. Line 4: a message needs an arrow such as `->>` between the two names. The rest of the page is fine.");
  assert.equal(d.reword("Parse error on line 3:\nExpecting 'LINK', 'UNICODE_TEXT', got 'NODE_STRING'", 'flowchart'), "This diagram couldn't be drawn. Line 3: a line between two boxes needs an arrow such as `-->`. The rest of the page is fine.");
  assert.equal(d.reword('No diagram type detected matching given configuration for text: flowchat TD', ''), "This diagram couldn't be drawn: the first word must name a kind of diagram, such as `flowchart` or `sequenceDiagram`. The rest of the page is fine.");
  assert.equal(d.reword("Parse error on line 2:\nExpecting 'SQE', 'DOUBLECIRCLEEND', got 'EOF'", 'flowchart'), "This diagram couldn't be drawn. Line 2: a bracket opened here isn't closed. The rest of the page is fine.");
  assert.equal(d.reword('Maximum text size in diagram exceeded', 'flowchart'), "This diagram couldn't be drawn: it is too long to draw (at most 20,000 characters). The rest of the page is fine.");
  assert.equal(d.reword('Edge limit exceeded. 500 edges found', 'flowchart'), "This diagram couldn't be drawn: it has too many lines between boxes (at most 300). The rest of the page is fine.");
  const html = "This diagram turns on HTML labels, which the brain doesn't draw. Remove the `htmlLabels` setting at its top.";
  assert.equal(d.reword(html, 'flowchart'), `This diagram couldn't be drawn: ${html} The rest of the page is fine.`);
  assert.equal(d.reword('Parse error on line 7:\nsomething odd', 'classDiagram'), "This diagram couldn't be drawn. Line 7 has something the diagram drawer doesn't understand. The rest of the page is fine.");
  assert.equal(d.reword('boom', 'pie'), "This diagram couldn't be drawn: it has something the diagram drawer doesn't understand. The rest of the page is fine.");
});

test('the bad line is marked in the diagram\'s text', () => {
  assert.deepEqual(d.markLine('a\nb\nc', 2), [{ text: 'a', bad: false }, { text: 'b', bad: true }, { text: 'c', bad: false }]);
  assert.deepEqual(d.markLine('a', null), [{ text: 'a', bad: false }]);
});

test('a drawing is kept under its Mermaid version, theme and text', () => {
  assert.equal(d.cacheKey('12.3.0', 'dark', 'ab12'), '12.3.0:dark:ab12');
});

test('kept drawings over 20 MB lose the oldest first', () => {
  const MB = 1024 * 1024;
  const e = [{ key: 'new', bytes: 10 * MB, at: 3 }, { key: 'old', bytes: 8 * MB, at: 1 }, { key: 'mid', bytes: 7 * MB, at: 2 }];
  assert.deepEqual(d.evictOrder(e, 20 * MB), ['old']);
  assert.deepEqual(d.evictOrder(e, 9 * MB), ['old', 'mid', 'new']);
  assert.deepEqual(d.evictOrder(e, 30 * MB), []);
});

test('a drawer that could not load is told apart from a diagram with a mistake', () => {
  for (const e of ['timeout', 'unavailable', 'Failed to fetch dynamically imported module: https://x/static/vendor/mermaid-12.3.0/chunks/a.mjs', 'Importing a module script failed.', 'error loading dynamically imported module']) {
    assert.equal(d.drawerFailed(e), true, e);
  }
  for (const e of ['Parse error on line 2:\nExpecting', 'No diagram type detected', '']) assert.equal(d.drawerFailed(e), false, e);
});

test('a drawing is kept under the renderer\'s own version too, so an updated renderer draws again', () => {
  assert.equal(d.rendererVersion('/static/diagram-frame.js?v=0123456789'), '12.3.0+0123456789');
  assert.equal(d.rendererVersion(undefined), '12.3.0');
});
